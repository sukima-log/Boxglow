/**
 * 画面全体: 上の帯 / キャンバス (+ 引き出し) / 詳細パネル (選んでいるときだけ) / 下の帯
 * URL の引数: ?demo=1 (小さなサンプル) ?demo=daw (公開用の例: Logic DAW の計画) &readonly=1 (閲覧のみ) &embed=1 (記事内の埋め込み: 帯とパネルを隠す)
 *             ?serve=1 (npx boxglow serve が配信する手元の boxglow.json を API で開く)
 *             &theme=dark|light (表示モードの指定)
 *             &lang=en|ja (画面の文言の言語。判定は i18n/index.ts)
 *             ?view=article (= demo + embed + readonly。記事内の iframe 用)
 * 埋め込みで同じドメインの記事の中にいるときは、記事側 (親) の表示モード (html の data-theme) に追従する。
 * URL のハッシュ: #p=<id> (開いているプロジェクト)
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { FlowCanvas } from "./canvas/FlowCanvas";
import { addBlock, computeProgress, disconnect, pendingDecisions, portsOf, removeBlock } from "./model/graph";
import { ROOT_ID } from "./model/types";
import { majorBlocks, parentForNewBlock, useProjectStore, useShownProject } from "./store/useProjectStore";
import { scopePath, wireNetTabs } from "./model/graph";
import { ResizeHandle } from "./panels/parts";
import { t, useLang } from "./i18n";

/**
 * ブラウザに記憶したパネルの幅を読む
 * Input : key = 記憶の名前, fallback = 既定の幅, min/max = 許す範囲
 * Output: 幅 (px)
 */
function loadWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
  } catch {
    return fallback;
  }
}

/** 幅を記憶する (できなくても動く) */
function saveWidth(key: string, w: number): void {
  try { localStorage.setItem(key, String(w)); } catch { /* 記憶できなくても動く */ }
}

/** 右パネルと引き出しの幅の範囲 (px) */
const RIGHT_W = { min: 260, max: 760, def: 320 };
const DRAWER_W = { min: 220, max: 640, def: 280 };
import { applyTheme } from "./lib/theme";
import { HomeDialog } from "./panels/HomeDialog";
import { Inspector } from "./panels/Inspector";
import { Drawer, isFilterEmpty, matchesFilter, type Filter, EMPTY_FILTER } from "./panels/Drawer";
import { RestoreNotice, SaveNotice } from "./panels/SaveNotice";
import { VersionInfo } from "./panels/VersionInfo";
import { TopBar } from "./panels/TopBar";
import { TaskTable } from "./panels/TaskTable";
import { TreePanel } from "./panels/TreePanel";
import { TabBar } from "./panels/TabBar";

export function App() {
  useLang(); // 言語が変わったら描き直す
  const project = useProjectStore((s) => s.project);
  const shown = useShownProject(); // View モードの畳む / 展開を反映した描画用
  const embed = useProjectStore((s) => s.embed);
  // 担当の一覧 (表) を図の代わりに出しているか (出しているなら、最初に出す対象)
  const taskTable = useProjectStore((s) => s.taskTable);
  const readonly = useProjectStore((s) => s.readonly);
  const toast = useProjectStore((s) => s.toast);
  const setToast = useProjectStore((s) => s.setToast);
  const selection = useProjectStore((s) => s.selection);
  const select = useProjectStore((s) => s.select);
  const focusBlock = useProjectStore((s) => s.focusBlock);
  const apply = useProjectStore((s) => s.apply);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const setMode = useProjectStore((s) => s.setMode);
  const openSample = useProjectStore((s) => s.openSample);
  const openExample = useProjectStore((s) => s.openExample);
  const openProject = useProjectStore((s) => s.openProject);
  const openFromServer = useProjectStore((s) => s.openFromServer);
  const openFromVsCode = useProjectStore((s) => s.openFromVsCode);

  const viewScope = useProjectStore((s) => s.viewScope);
  const setViewScope = useProjectStore((s) => s.setViewScope);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // ツリーの開閉は閲覧上の好みなので、共有する計画ファイルではなくブラウザに記憶する。
  // localStorage が禁止された環境でも画面は開けるよう、読み取り失敗は閉じた初期状態にする。
  const [treeOpen, setTreeOpen] = useState(() => {
    try {
      return localStorage.getItem("boxglow:treeOpen") === "true";
    } catch {
      return false;
    }
  });
  /** 入力: なし (現在値は更新関数で受け取る)。出力: void。開閉とその記憶だけを更新する。 */
  const toggleTree = () => setTreeOpen((prev) => {
    try {
      localStorage.setItem("boxglow:treeOpen", String(!prev));
    } catch {
      // 記憶できなくても、この画面での開閉は止めない。
    }
    return !prev;
  });
  // パネルの幅 (境界のつまみで変えられる。ブラウザに記憶)
  const [rightW, setRightW] = useState(() => loadWidth("boxglow:rightW", RIGHT_W.def, RIGHT_W.min, RIGHT_W.max));
  const [drawerW, setDrawerW] = useState(() => loadWidth("boxglow:drawerW", DRAWER_W.def, DRAWER_W.min, DRAWER_W.max));
  const onRightW = useCallback((w: number) => { setRightW(w); saveWidth("boxglow:rightW", w); }, []);
  const onDrawerW = useCallback((w: number) => { setDrawerW(w); saveWidth("boxglow:drawerW", w); }, []);
  const [helpOpen, setHelpOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>({ ...EMPTY_FILTER, statuses: new Set(EMPTY_FILTER.statuses) });

  // 起動: URL の引数とハッシュを読む
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const article = params.get("view") === "article";
    const isEmbed = article || params.get("embed") === "1";
    setMode({ embed: isEmbed, readonly: article || params.get("readonly") === "1" });
    const theme = params.get("theme");
    if (theme === "dark" || theme === "light") applyTheme(theme, false);
    // 同じドメインの記事に埋め込まれているときは、記事側の表示モードに追従する (別ドメインなら読めないので何もしない)
    let observer: MutationObserver | null = null;
    if (isEmbed && window.parent !== window) {
      try {
        const parentHtml = window.parent.document.documentElement;
        const follow = () => {
          const mode = parentHtml.dataset.theme;
          if (mode === "dark" || mode === "light") applyTheme(mode, false);
        };
        follow();
        observer = new MutationObserver(follow);
        observer.observe(parentHtml, { attributes: true, attributeFilter: ["data-theme"] });
      } catch {
        /* 別ドメインからの埋め込み: 親は読めない */
      }
    }
    if (window.acquireVsCodeApi) {
      // VS Code 拡張の webview: 拡張が持つ boxglow.json を開き、表示モードは VS Code のテーマに合わせる
      const follow = () => applyTheme(document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast") ? "dark" : "light", false);
      follow();
      observer = new MutationObserver(follow);
      observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
      openFromVsCode();
    } else if (params.get("demo") === "daw") {
      openExample(); // 大きな計画を試すための 3 階層の例
    } else if (article || params.get("demo") === "1") {
      openSample();
      if (article) {
        // 記事ではボックスと分岐が読める範囲から始める。Top へはいつでも戻れる。
        const state = useProjectStore.getState();
        const blocks = Object.values(state.project?.blocks ?? {});
        const scope = blocks.find((b) => b.kind === "task" && blocks.some((child) => child.parentId === b.id));
        if (scope) state.setViewScope(scope.id);
      }
    } else if (params.get("serve") === "1") {
      void openFromServer(); // npx boxglow serve が配信する手元の boxglow.json
    } else {
      const m = window.location.hash.match(/p=([\w-]+)/);
      if (m) void openProject(m[1]);
    }
    return () => observer?.disconnect();
  }, [setMode, openSample, openExample, openProject, openFromServer, openFromVsCode]);

  // 保存が終わっていない編集 (保存中・未保存) があるときは、タブを閉じる・再読み込みの前にブラウザの確認を出す (サンプルは保存しないので対象外)
  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => { const s = useProjectStore.getState(); if (!s.ephemeral && ["saving", "unsaved"].includes(s.saveState)) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, []);

  // 通知は 3 秒で消す
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast, setToast]);

  // キーボード操作
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return; // 競合の比較などのダイアログを開いている間は、図のショートカットを効かせない
      if (ev.isComposing) return; // 日本語変換中のキー (確定の Enter など) は操作として扱わない
      const target = ev.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      const p = useProjectStore.getState().project;
      if (!p) return;
      const sel = useProjectStore.getState().selection;
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z") {
        ev.preventDefault();
        if (ev.shiftKey) redo();
        else undo();
      } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "y") {
        ev.preventDefault();
        redo();
      } else if (ev.key === "Delete" || ev.key === "Backspace") {
        if (readonly || !useProjectStore.getState().editMode) return;
        if (sel.edgeId) {
          const e = p.edges[sel.edgeId];
          if (e && !e.auto) {
            select({});
            apply((q) => disconnect(q, sel.edgeId!));
          }
        } else if (sel.blockId) {
          const b = p.blocks[sel.blockId];
          const kids = Object.values(p.blocks).filter((x) => x.parentId === sel.blockId).length;
          if (b && (kids === 0 || confirm(t("「{title}」と下の階層のブロックを削除します。よろしいですか?", { title: b.title })))) {
            select({});
            apply((q) => removeBlock(q, sel.blockId!));
          }
        }
      } else if (ev.key.toLowerCase() === "n" && !ev.ctrlKey && !ev.metaKey) {
        if (readonly) return;
        const parentId = parentForNewBlock(p, sel, useProjectStore.getState().viewScope);
        apply((q) => {
          const r = addBlock(q, { parentId, title: t("新しいブロック") });
          const q2 = structuredClone(r.project);
          if (q2.blocks[parentId]) q2.blocks[parentId].collapsed = false;
          setTimeout(() => { select({ blockId: r.blockId }); focusBlock(r.blockId); }, 0);
          return q2;
        });
      } else if (ev.key === "Escape") {
        select({});
        setHelpOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [apply, undo, redo, select, readonly, focusBlock]);

  const matcher = useMemo(() => {
    if (!project || isFilterEmpty(filter)) return null;
    return (blockId: string) => matchesFilter(project, blockId, filter);
  }, [project, filter]);

  const toggleDrawer = useCallback(() => setDrawerOpen((v) => !v), []);
  const openDrawer = useCallback(() => setDrawerOpen(true), []);

  const prog = project ? computeProgress(project, ROOT_ID) : null;
  const fullUrl = useMemo(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("embed");
    url.searchParams.delete("readonly");
    url.searchParams.delete("view");
    url.searchParams.set("demo", url.searchParams.get("demo") === "daw" ? "daw" : "1"); // 記事から「全画面で開く」は同じ例を開く
    return url.toString();
  }, []);

  // 詳細パネルは何かを選んでいるときだけ出す
  // 右の詳細パネルを出すか (線だけを選んでいるときは出さない: 線の向きと状態は図の上部の帯 EdgeBar に出す)
  const hasSelection = !!project && !embed && (selection.blockId !== null || selection.terminal !== null || selection.project || selection.timeline);
  const gridClass = ["app-grid", embed ? "embed" : "", hasSelection ? "" : "no-right"].filter(Boolean).join(" ");
  // キャンバスのタブ: Top (全体) + 大項目ごと (埋め込みでは出さない)
  const majors = useMemo(() => (project ? majorBlocks(project) : []), [project]);
  // 選んだ線 (と境界を越えた先の続き) が通るタブ。タブの帯に印を付け、線を選んだまま行き来できるようにする
  const wireTabs = useMemo(() => (project && selection.edgeId && project.edges[selection.edgeId] ? new Set(wireNetTabs(project, selection.edgeId)) : undefined), [project, selection.edgeId]);
  const showTabs = !!project && majors.length > 0; // 埋め込みでも出す (Top は大項目までしか見せないので、中を見る手段が要る)
  const scopeOk = viewScope && project?.blocks[viewScope] ? viewScope : null;
  // パンくず: 開いているボックスから大項目までの道 (タブは大項目で選ぶ)
  const path = useMemo(() => (project && scopeOk ? scopePath(project, scopeOk) : []), [project, scopeOk]);
  const activeTab = path[0]?.id ?? null;

  return (
    <div className={gridClass} style={{ ["--right-w" as string]: `${rightW}px` }}>
      <div className="app-top">
        {project && !embed && <TopBar project={project} treeOpen={treeOpen} onToggleTree={toggleTree} onToggleDrawer={toggleDrawer} onHelp={() => setHelpOpen(true)} />}
        {project && !embed && <SaveNotice />}
        {/* 退避した編集の取り込みの結果 (編集画面に出す。R44-01) */}
        {project && !embed && <RestoreNotice />}
      </div>

      <main className="app-main relative min-w-0 min-h-0">
        {/* 通常幅ではツリーと図を並べる。狭い幅の重ね表示は CSS に任せ、図の座標や表示範囲は変更しない。 */}
        <div className="canvas-layout">
        {project && treeOpen && !embed && <TreePanel project={project} filter={filter} onClose={toggleTree} />}
        <div className="canvas-wrap">
          {project && (
            <ReactFlowProvider>
              <FlowCanvas project={shown ?? project} matcher={matcher} panelLayoutKey={`${treeOpen}:${drawerOpen}:${drawerW}:${hasSelection}:${rightW}:${embed}`} />
            </ReactFlowProvider>
          )}
          {/* 担当の一覧 (表): 図の上に重ねて出す (図は残すので、戻ったときの倍率と位置は変わらない) */}
          {project && taskTable && !embed && <TaskTable project={project} initial={taskTable} />}
          {project && drawerOpen && !embed && <Drawer project={shown ?? project} filter={filter} onFilter={setFilter} onClose={() => setDrawerOpen(false)} width={drawerW} />}
          {/* 引き出しの右辺のつまみ (引き出しは中が縦に伸びるので、外側 = 図の上に置く。left 8px + 幅) */}
          {project && drawerOpen && !embed && <ResizeHandle side="right" width={drawerW} min={DRAWER_W.min} max={DRAWER_W.max} onWidth={onDrawerW} style={{ left: 8 + drawerW - 5, top: 8, bottom: 8 }} />}
          {/* Top の見出し行: 最終成果物と、判断待ちの最初の問い (図の中のノードや札は倍率で消えるので、固定の大きさで出す。B158) */}
          {project && path.length === 0 && !embed && (() => {
            const outs = portsOf(project, ROOT_ID, "out").map((q) => q.name).filter(Boolean);
            const pend = pendingDecisions(project);
            if (!outs.length && !pend.length) return null;
            return (
              <div className="goal-strip" style={{ left: drawerOpen ? 8 + drawerW + 8 : 8 }}>
                {outs.length > 0 && <span className="goal-strip__item" title={t("最終成果物: {names}", { names: outs.join(", ") })}><span className="goal-strip__label">{t("最終成果物")}</span><span className="goal-strip__text">{outs.join(", ")}</span></span>}
                {pend.length > 0 && (
                  <button type="button" className="goal-strip__item goal-strip__decision" onClick={() => select({ timeline: true })} title={pend.map((x) => `${x.block.key ?? ""} ${x.decision.question}`).join("\n")}>
                    <span className="goal-strip__label">{t("判断待ち {n}", { n: pend.length })}</span><span className="goal-strip__text">{pend[0].decision.question}</span>
                  </button>
                )}
              </div>
            );
          })()}
          {project && (path.length > 0 || (!embed && !isFilterEmpty(filter))) && (
            <div className="scope-path" style={{ left: drawerOpen && !embed ? 8 + drawerW + 8 : 8 }}>
              {path.length > 0 && (
                <>
                  <button className="scope-crumb" onClick={() => setViewScope(null)} title={t("大項目の一覧へ")}>Top</button>
                  {path.map((b, i) => (
                    <span key={b.id} className="contents">
                      <span className="scope-sep">›</span>
                      {i === path.length - 1
                        ? <span className="scope-crumb current" title={b.title}>{b.title}</span>
                        : <button className="scope-crumb" onClick={() => setViewScope(b.id)} title={t("{title} へ戻る", { title: b.title })}>{b.title}</button>}
                    </span>
                  ))}
                </>
              )}
              {!embed && !isFilterEmpty(filter) && (
                <button className="chip" data-on="true" onClick={() => setFilter({ ...EMPTY_FILTER, statuses: new Set(EMPTY_FILTER.statuses) })} title={t("絞り込みを解除")}>Filtered ×</button>
              )}
            </div>
          )}
          {embed && (
            <a className="btn btn-accent absolute top-2 right-2 z-10" href={fullUrl} target="_blank" rel="noopener noreferrer">Open full ↗</a>
          )}
          {embed && path.length === 0 && (
            <span className="absolute top-2 left-2 z-10 font-head text-[14px] px-2 py-1 rounded-lg" style={{ background: "var(--bg-card)", border: "2px solid var(--line)" }}>Boxglow</span>
          )}
        </div>
        </div>
        {showTabs && <TabBar project={project!} majors={majors} scope={activeTab} onSelect={setViewScope} marked={wireTabs} />}
        {!project && !embed && <HomeDialog />}
        {helpOpen && (
          <div className="modal-backdrop" onClick={() => setHelpOpen(false)}>
            <div className="card modal p-5 flex flex-col gap-2" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
              <div className="font-head text-[16px]">Help</div>
              <table className="help-table"><tbody>
                <tr><td>{t("ブロックを置く")}</td><td><span className="kbd">N</span> {t("または「+ Block」(選んだボックスの中に)")}</td></tr>
                <tr><td>Edit / View</td><td>{t("上の切替。Edit のときだけドラッグで移動・結線・階層移動と Del が効く")}</td></tr>
                <tr><td>{t("結線")}</td><td>{t("丸から相手の丸、または相手のボックスへドラッグ (近くで離せばつながる)")}</td></tr>
                <tr><td>{t("階層を移す")}</td><td>{t("ボックスをドラッグして別のボックスの中に落とす")}</td></tr>
                <tr><td>{t("下の階層を畳む / 展開")}</td><td>{t("ブロックをダブルクリック")}</td></tr>
                <tr><td>{t("削除")}</td><td><span className="kbd">Del</span></td></tr>
                <tr><td>{t("元に戻す / やり直す")}</td><td><span className="kbd">Ctrl+Z</span> / <span className="kbd">Ctrl+Y</span></td></tr>
                <tr><td>{t("選択を解除")}</td><td><span className="kbd">Esc</span></td></tr>
              </tbody></table>
              <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                {t("ボックスは「入力から出力を作るタスク」。出力を先に決め、大きなボックスは「分解する」で中にボックスを置く。供給元の無い入力は左端の入力まで自動で点線が伸びる。")}
              </div>
              <button className="btn btn-sm self-end" onClick={() => setHelpOpen(false)}>Close</button>
            </div>
          </div>
        )}
      </main>

      <aside className={`panel right ${hasSelection ? "" : "hidden-panel"}`}>
        {project && hasSelection && <ResizeHandle side="left" width={rightW} min={RIGHT_W.min} max={RIGHT_W.max} onWidth={onRightW} />}
        {project && hasSelection && <Inspector project={project} onOpenDrawer={openDrawer} />}
      </aside>

      <footer className="app-footer flex items-center gap-3 px-3 text-[12px]" style={{ borderTop: "2px solid var(--line)", background: "var(--bg-card)" }}>
        {project && prog && (
          <>
            <span className="font-head">Done {prog.white} / {prog.total} · {prog.percent}%</span>
            <div className="progress-bar" style={{ width: 160 }}><span style={{ width: `${prog.percent}%` }} /></div>
            {embed && <a className="underline" href={fullUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--primary-strong)" }}>{t("Boxglow で開く")}</a>}
          </>
        )}
        {!project && <span style={{ color: "var(--text-muted)" }}>Boxglow</span>}
        <VersionInfo />
        <span className="build-stamp text-[10px]" style={{ color: "var(--text-muted)" }} title={t("ビルド日時 (日本時間)。古い場合は再読み込み (Ctrl+F5) してください")}>build {__BUILD__}</span>
      </footer>

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

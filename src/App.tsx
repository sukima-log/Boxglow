/**
 * 画面全体: 上の帯 / キャンバス (+ 引き出し) / 詳細パネル (選んでいるときだけ) / 下の帯
 * URL の引数: ?demo=1 (小さなサンプル) ?demo=daw (公開用の例: Logic DAW の計画) &readonly=1 (閲覧のみ) &embed=1 (記事内の埋め込み: 帯とパネルを隠す)
 *             &theme=dark|light (表示モードの指定)
 *             ?view=article (= demo + embed + readonly。記事内の iframe 用)
 * 埋め込みで同じドメインの記事の中にいるときは、記事側 (親) の表示モード (html の data-theme) に追従する。
 * URL のハッシュ: #p=<id> (開いているプロジェクト)
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { FlowCanvas } from "./canvas/FlowCanvas";
import { addBlock, computeProgress, disconnect, removeBlock } from "./model/graph";
import { ROOT_ID } from "./model/types";
import { majorBlocks, parentForNewBlock, useProjectStore, useShownProject } from "./store/useProjectStore";
import { ResizeHandle } from "./panels/parts";

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
import { TopBar } from "./panels/TopBar";
import { TabBar } from "./panels/TabBar";

export function App() {
  const project = useProjectStore((s) => s.project);
  const shown = useShownProject(); // View モードの畳む / 展開を反映した描画用
  const embed = useProjectStore((s) => s.embed);
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

  const viewScope = useProjectStore((s) => s.viewScope);
  const setViewScope = useProjectStore((s) => s.setViewScope);
  const [drawerOpen, setDrawerOpen] = useState(false);
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
    if (article || params.get("demo") === "daw") {
      openExample(); // 記事の埋め込みと ?demo=daw は 3 階層の例
    } else if (params.get("demo") === "1") {
      openSample();
    } else {
      const m = window.location.hash.match(/p=([\w-]+)/);
      if (m) void openProject(m[1]);
    }
    return () => observer?.disconnect();
  }, [setMode, openSample, openExample, openProject]);

  // 通知は 3 秒で消す
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast, setToast]);

  // キーボード操作
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
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
          if (b && (kids === 0 || confirm(`「${b.title}」と下の階層のブロックを削除します。よろしいですか?`))) {
            select({});
            apply((q) => removeBlock(q, sel.blockId!));
          }
        }
      } else if (ev.key.toLowerCase() === "n" && !ev.ctrlKey && !ev.metaKey) {
        if (readonly) return;
        const parentId = parentForNewBlock(p, sel, useProjectStore.getState().viewScope);
        apply((q) => {
          const r = addBlock(q, { parentId, title: "新しいブロック" });
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
    url.searchParams.set("demo", "daw"); // 記事から「全画面で開く」は同じ例を開く
    return url.toString();
  }, []);

  // 詳細パネルは何かを選んでいるときだけ出す
  const hasSelection = !!project && !embed && (selection.blockId !== null || selection.edgeId !== null || selection.terminal !== null || selection.project || selection.timeline);
  const gridClass = ["app-grid", embed ? "embed" : "", hasSelection ? "" : "no-right"].filter(Boolean).join(" ");
  // キャンバスのタブ: All (全体) + 大項目ごと (埋め込みでは出さない)
  const majors = useMemo(() => (project ? majorBlocks(project) : []), [project]);
  const showTabs = !!project && majors.length > 0; // 埋め込みでも出す (All は大項目までしか見せないので、中を見る手段が要る)
  const scopeOk = viewScope && project?.blocks[viewScope] ? viewScope : null;

  return (
    <div className={gridClass} style={{ ["--right-w" as string]: `${rightW}px` }}>
      <div className="app-top">
        {project && !embed && <TopBar project={project} onToggleDrawer={toggleDrawer} onHelp={() => setHelpOpen(true)} />}
      </div>

      <main className="app-main relative min-w-0 min-h-0">
        <div className="canvas-wrap">
          {project && (
            <ReactFlowProvider>
              <FlowCanvas project={shown ?? project} matcher={matcher} />
            </ReactFlowProvider>
          )}
          {project && drawerOpen && !embed && <Drawer project={shown ?? project} filter={filter} onFilter={setFilter} onClose={() => setDrawerOpen(false)} width={drawerW} />}
          {/* 引き出しの右辺のつまみ (引き出しは中が縦に伸びるので、外側 = 図の上に置く。left 8px + 幅) */}
          {project && drawerOpen && !embed && <ResizeHandle side="right" width={drawerW} min={DRAWER_W.min} max={DRAWER_W.max} onWidth={onDrawerW} style={{ left: 8 + drawerW - 5, top: 8, bottom: 8 }} />}
          {project && !embed && !isFilterEmpty(filter) && (
            <button className="chip absolute top-2 left-2 z-10" data-on="true" onClick={() => setFilter({ ...EMPTY_FILTER, statuses: new Set(EMPTY_FILTER.statuses) })} title="絞り込みを解除">Filtered ×</button>
          )}
          {embed && (
            <a className="btn btn-accent absolute top-2 right-2 z-10" href={fullUrl} target="_blank" rel="noopener noreferrer">Open full ↗</a>
          )}
          {embed && (
            <span className="absolute top-2 left-2 z-10 font-head text-[14px] px-2 py-1 rounded-lg" style={{ background: "var(--bg-card)", border: "2px solid var(--line)" }}>Boxglow</span>
          )}
        </div>
        {showTabs && <TabBar project={project!} majors={majors} scope={scopeOk} onSelect={setViewScope} />}
        {!project && !embed && <HomeDialog />}
        {helpOpen && (
          <div className="modal-backdrop" onClick={() => setHelpOpen(false)}>
            <div className="card modal p-5 flex flex-col gap-2" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
              <div className="font-head text-[16px]">Help</div>
              <table className="help-table"><tbody>
                <tr><td>ブロックを置く</td><td><span className="kbd">N</span> または「+ Block」(選んだ箱の中に)</td></tr>
                <tr><td>Edit / View</td><td>上の切替。Edit のときだけドラッグで移動・結線・階層移動と Del が効く</td></tr>
                <tr><td>結線</td><td>丸から相手の丸、または相手の箱へドラッグ (近くで離せばつながる)</td></tr>
                <tr><td>階層を移す</td><td>箱をドラッグして別の箱の中に落とす</td></tr>
                <tr><td>下の階層を畳む / 展開</td><td>ブロックをダブルクリック</td></tr>
                <tr><td>削除</td><td><span className="kbd">Del</span></td></tr>
                <tr><td>元に戻す / やり直す</td><td><span className="kbd">Ctrl+Z</span> / <span className="kbd">Ctrl+Y</span></td></tr>
                <tr><td>選択を解除</td><td><span className="kbd">Esc</span></td></tr>
              </tbody></table>
              <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                箱は「入力から出力を作るタスク」。出力を先に決め、大きな箱は「分解する」で中に箱を置く。供給元の無い入力は左端の入力まで自動で点線が伸びる。
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
            {embed && <a className="underline" href={fullUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--primary-strong)" }}>Boxglow で開く</a>}
          </>
        )}
        {!project && <span style={{ color: "var(--text-muted)" }}>Boxglow</span>}
        <span className="ml-auto text-[10px]" style={{ color: "var(--text-muted)" }} title="ビルド日時 (日本時間)。古い場合は再読み込み (Ctrl+F5) してください">build {__BUILD__}</span>
      </footer>

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

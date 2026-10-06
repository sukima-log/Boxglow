/**
 * 上の帯: ☰ (引き出し)、Home、プロジェクト名 (押すと設定)、保存の札、状況の札、表示モード、検索、追加、Auto Layout、Undo / Redo、メニュー、テーマ
 * 狭い幅 (760px 以下) では、追加・Auto Layout・Undo / Redo を ⋯ メニューの中へ移す
 */
import { useEffect, useRef, useState } from "react";
import { TreeIcon } from "./TreeIcon";
import { RestoreDialog, SaveHeldChip, SyncChip } from "./SyncPanel";
import { addBlock, addProjectBlock, normalizeCollapsed, searchBlocks, summarize, toJSON } from "../model/graph";
import { layoutAll } from "../model/autolayout";
import { projectToMarkdown, scopeToMermaid } from "../model/export";
import { ROOT_ID, type Project } from "../model/types";
import { parentForNewBlock, useProjectStore } from "../store/useProjectStore";
import { applyTheme, currentTheme, type Theme } from "../lib/theme";
import { copyText, downloadText, pickTextFile, safeFilename } from "../lib/download";
import { setLang, t, useLang } from "../i18n";

/**
 * 入力: 表示中の Project、ツリーの開閉状態、各パネルの開閉コールバック。
 * 出力: 上部の操作バー。ツリーとオプションは別の入口にし、開閉状態そのものは App が保持する。
 */
export function TopBar({ project, onToggleDrawer, onToggleTree, treeOpen, onHelp }: { project: Project; onToggleTree: () => void; treeOpen: boolean; onToggleDrawer: () => void; onHelp: () => void }) {
  const lang = useLang(); // 言語が変わったら描き直す (メニューの切替項目の表示にも使う)
  const readonly = useProjectStore((s) => s.readonly);
  const ephemeral = useProjectStore((s) => s.ephemeral);
  const saveState = useProjectStore((s) => s.saveState);
  const apply = useProjectStore((s) => s.apply);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const past = useProjectStore((s) => s.past.length);
  const future = useProjectStore((s) => s.future.length);
  const select = useProjectStore((s) => s.select);
  const focusBlock = useProjectStore((s) => s.focusBlock);
  const selection = useProjectStore((s) => s.selection);
  const closeProject = useProjectStore((s) => s.closeProject);
  const importJSON = useProjectStore((s) => s.importJSON);
  const copyToMine = useProjectStore((s) => s.copyToMine);
  const setToast = useProjectStore((s) => s.setToast);
  // VS Code の中: 退避した編集の読み込み (同期の設定が無くても使う。保存の衝突の帯から退避した編集を、開き直した後に取り込む。R49-03)
  const loadEvacuated = useProjectStore((s) => s.loadEvacuated);
  const restoring = useProjectStore((s) => s.restorePending !== null || s.editorBehind !== null);
  // テーマ切り替えボタンの向き: 実際に画面に当たっているテーマ (html の data-theme) に合わせる。
  // URL の ?theme= や VS Code の配色でボタン以外からテーマが変わることがあるので、属性の変化を見張って追従する
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme as Theme || currentTheme());
  useEffect(() => {
    const sync = () => setTheme(document.documentElement.dataset.theme as Theme || currentTheme());
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  const [menu, setMenu] = useState(false);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const hits = query.trim() ? searchBlocks(project, query, 12) : [];
  const jump = (id: string) => {
    select({ blockId: id });
    focusBlock(id);
    setQuery("");
    setSearchOpen(false);
  };
  // "/" で検索欄へ
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      const target = ev.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (ev.key === "/" && !ev.isComposing && !target?.isContentEditable && target?.tagName !== "SELECT") {
        ev.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const close = () => setMenu(false);
    if (menu) window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  };

  /** ブロックを足す (選んでいるボックスの中。何も選んでいなければ最初のプロジェクトの中) */
  // 最上位にプロジェクトのボックスを足す (⋯ メニューの New Project。上の帯のボタンにはしない: 使う頻度が低い)
  const addProject = () => {
    const name = prompt(t("追加するプロジェクトの名前 (リポジトリごとに 1 つなど)"));
    if (name?.trim()) apply((p) => { const r = addProjectBlock(p, name.trim()); setTimeout(() => { select({ blockId: r.blockId }); focusBlock(r.blockId); }, 0); return r.project; });
  };
  /**
   * Auto Layout: 依存関係の順に全体を並べ直す (大項目は畳んだ前提。Ctrl+Z で戻せる)
   * Input / Output: なし (project を更新する)
   */
  const autoLayout = () => apply((p) => layoutAll(normalizeCollapsed(p)));
  const addSibling = () => {
    const parentId = parentForNewBlock(project, selection, useProjectStore.getState().viewScope);
    apply((p) => {
      const r = addBlock(p, { parentId, title: t("新しいブロック") });
      const q = structuredClone(r.project);
      if (q.blocks[parentId]) q.blocks[parentId].collapsed = false;
      setTimeout(() => { select({ blockId: r.blockId }); focusBlock(r.blockId); }, 0);
      return q;
    });
  };

  const exportJSON = () => downloadText(`${safeFilename(project.name)}.boxglow.json`, toJSON(project), "application/json");
  const exportMd = () => downloadText(`${safeFilename(project.name)}.md`, projectToMarkdown(project), "text/markdown");
  const copyMermaid = async () => {
    setToast((await copyText(scopeToMermaid(project, selection.blockId ?? ROOT_ID))) ? t("Mermaid をコピーしました") : t("コピーできませんでした"));
  };
  const doImport = async () => {
    const text = await pickTextFile(".json,application/json");
    if (!text) return;
    try {
      await importJSON(text);
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    }
  };

  const fileName = useProjectStore((s) => s.fileName);
  const editMode = useProjectStore((s) => s.editMode);
  const setEditMode = useProjectStore((s) => s.setEditMode);
  const saveNow = useProjectStore((s) => s.saveNow);
  const source = useProjectStore((s) => s.source);
  const reload = useProjectStore((s) => s.reload);
  const reloading = useProjectStore((s) => s.reloading);
  // 保存状態: 常に見える札にする (ファイルを開いているときは「どこに保存されるか」と「保存済みか」が分かるように)
  const saveLabel = readonly ? "Read only" : ephemeral ? "Sample (not saved)" : saveState === "saving" ? "Saving…" : saveState === "unsaved" ? "Unsaved" : "Saved";
  const saveTitle = readonly ? t("閲覧専用") : ephemeral ? t("サンプルは保存されません。Save で自分のプロジェクトとして保存") : fileName ? t("{file} に自動で保存します (変更後)。Save で今すぐ書きます", { file: fileName }) : t("このブラウザに自動で保存します");
  const sum = summarize(project);
  const busy = sum.working.length; // 作業中の件数 (詰まり・確認待ちは別の札で数える)

  // 帯は 2 つのまとまり: 左 (topbar-identity) = 引き出し・Home・計画名・保存の札、右 (topbar-tools) = 状況・モード・検索・追加・メニュー。
  // 幅が狭いと右のまとまりが次の行へ折り返す (index.css の .topbar。検索やメニューが画面の外に出ないように)
  return (
    <header className="topbar" data-editing={editMode}>
      <div className="topbar-identity">
      {/* 文字を置かない入口にも名前と制御先を与え、読み上げ・ツールチップで用途と現在の開閉を伝える。 */}
      <button className="tree-toggle btn btn-ghost btn-sm" onClick={onToggleTree} aria-pressed={treeOpen} aria-controls="project-tree" aria-label={treeOpen ? t("サイドバーを隠す") : t("サイドバーを表示")} title={treeOpen ? t("サイドバーを隠す") : t("サイドバーを表示")}><TreeIcon name="sidebar" /></button>
      <button className="btn btn-ghost btn-sm" onClick={onToggleDrawer} title={t("絞り込み / メンバー / 部品")}>☰</button>
      {/* VS Code の中では、Home へ戻るボタンを出さない: 開いているのは 1 つのファイルで、戻る先の一覧 (ブラウザ内の計画) は、ファイルとは別のコピーのため */}
      {source !== "vscode" && <button className="btn btn-ghost btn-sm" onClick={closeProject} title={t("Home (プロジェクト一覧へ)")} aria-label="Home">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 11.5 12 4l9 7.5" />
          <path d="M5.5 10.5V20h13v-9.5" />
          <path d="M10 20v-5h4v5" />
        </svg>
      </button>}
      <button className="project-name" onClick={() => select({ project: true })} title={project.name}>{project.name}</button>
      <span className={`save-chip ${saveState === "unsaved" ? "unsaved" : ""}`} title={saveTitle}>
        {!ephemeral && <span className="save-chip__file">{fileName ?? t("ブラウザ内")}</span>}
        {/* 保存先のファイルと同期先のサーバーを区別する。ローカル保存済みでも送信前のことがある。 */}
        <span>{(source === "serve" || source === "vscode") && <span>{t("ファイル")}: </span>}{saveLabel}</span>
      </span>
      {/* 手動の更新: 今すぐ読み直す (自動の更新を待たない)。どの計画でも、いつも同じ場所に出す (変更があるかどうかに関係なく)。
          ファイルにつながっている計画はファイルを、ブラウザ内の計画はこのブラウザの保存先を読み直す */}
      {(
        <button className="btn btn-ghost btn-sm" onClick={() => void reload()} disabled={reloading} title={source === "idb" ? t("最新の内容を読み込む") : t("最新の内容を読み込む (ファイルを今すぐ読み直す)")} aria-label="Reload">
          <svg className={reloading ? "spin" : undefined} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 12a8 8 0 1 1-2.6-5.9" />
            <path d="M20 4v5h-5" />
          </svg>
        </button>
      )}
      {ephemeral && !readonly && <button className="btn btn-sm" onClick={copyToMine} title={t("自分のプロジェクトとして保存")}>Save</button>}
      {!ephemeral && !readonly && <button className="btn btn-sm" onClick={saveNow} disabled={saveState === "saved" || saveState === "saving"} title={saveTitle}>Save</button>}
      {/* 画面からの同期の印 (裏方が状態を流しているときだけ出る) */}
      <SaveHeldChip />
      <SyncChip />
      {/* 退避した編集の取り込みで、競合を選ぶ欄 (選ぶまで反映しない) */}
      <div className="sync-chip-wrap"><RestoreDialog /></div>
      </div>
      <div className="topbar-tools">
      <button className="summary-chip" data-on={selection.timeline} onClick={() => select({ timeline: !selection.timeline })} title={t("今の状況 (作業中・判断待ち・ログ)")}>
        {busy > 0 && <span className="dot" />}
        {busy > 0 && <span><span className="summary-chip__txt">{t("作業中")} </span>{busy}</span>}
        {sum.blocked.length > 0 && <span><span className="summary-chip__txt">{t("詰まり・確認待ち")} </span>{sum.blocked.length}</span>}
        {sum.decisions.length > 0 && <span className="summary-decision"><span className="summary-chip__txt">{t("判断待ち")} </span>{sum.decisions.length}</span>}
        {/* 人が答えて AI がまだ読んでいない回答: 答えた直後に見失わないよう、引き取られるまで帯に出す */}
        {sum.answered.length > 0 && <span><span className="summary-chip__txt">{t("回答済み")} </span>{sum.answered.length}</span>}
        {busy === 0 && sum.blocked.length === 0 && sum.decisions.length === 0 && sum.answered.length === 0 && <span>Activity</span>}
      </button>
        {!readonly && (
          <button className="mode-toggle" data-on={editMode} onClick={() => setEditMode(!editMode)} title={editMode ? t("Edit モード: ドラッグで移動・結線・階層移動ができます。押すと View (閲覧) に") : t("View モード: ドラッグでの編集は効きません。押すと Edit に")}>
            <span className="mode-toggle__knob" />
            <span>{editMode ? "Edit" : "View"}</span>
          </button>
        )}
        <div className="relative topbar-search">
          <input aria-label={t("ブロックを検索")} ref={searchRef} className="input search-box" placeholder={t("Search  ID / 題名")} value={query}
            onChange={(e) => { setQuery(e.target.value); setSearchOpen(true); }}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && hits[0]) jump(hits[0].id); if (e.key === "Escape") { setSearchOpen(false); setQuery(""); (e.target as HTMLInputElement).blur(); } }}
            onBlur={() => setTimeout(() => setSearchOpen(false), 150)} />
          {searchOpen && query.trim() && hits.length > 0 && (
            <div className="card absolute right-0 mt-1 p-1 flex flex-col z-30" style={{ width: "min(320px, calc(100vw - 32px))", maxHeight: 320, overflow: "auto" }}>
              {hits.map((h) => (
                <button key={h.id} className="btn btn-ghost btn-sm justify-start" onMouseDown={(e) => e.preventDefault()} onClick={() => jump(h.id)}>
                  <span className="chip" style={{ fontFamily: "ui-monospace, monospace", marginRight: 6 }}>{h.key}</span>
                  <span className="truncate">{h.title}</span>
                </button>
              ))}
            </div>
          )}
          {searchOpen && query.trim() && hits.length === 0 && (
            <div className="card absolute right-0 mt-1 p-2 text-[12px] z-30" style={{ minWidth: 200, color: "var(--text-muted)" }}>{t("見つかりません")}</div>
          )}
        </div>
        {!readonly && (
          <>
            {/* よく使う編集の操作は帯に出す (通常の幅)。760px 以下では帯から外し、⋯ メニューの中に同じ操作を出す (index.css の .desktop-action / .menu-actions) */}
            <button className="btn btn-primary btn-sm desktop-action" onClick={addSibling} title={t("ブロックを追加 (N)。ボックスを選んでいればその中に、選んでいなければプロジェクトの中に")}>+ Block</button>
            <button className="btn btn-sm desktop-action layout-action" onClick={autoLayout} title={t("Auto Layout: 依存関係で並べ直す (大項目は畳んだ前提)")}>Auto Layout</button>
            <button className="btn btn-ghost btn-sm desktop-action" onClick={undo} disabled={past === 0} title={t("元に戻す (Ctrl+Z)")} aria-label="Undo">↶</button>
            <button className="btn btn-ghost btn-sm desktop-action" onClick={redo} disabled={future === 0} title={t("やり直す (Ctrl+Y)")} aria-label="Redo">↷</button>
          </>
        )}
        <div className="relative">
          <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); setMenu(!menu); }} title="Menu" aria-expanded={menu} onKeyDown={(e) => { if (e.key === "Escape") setMenu(false); }}>⋯</button>
          {menu && (
            <div className="card absolute right-0 mt-1 p-1 flex flex-col z-30" style={{ minWidth: 220, maxHeight: "min(480px, 65dvh)", overflowY: "auto" }}>
              {/* 編集の操作: 帯に出せない狭い幅 (760px 以下) のときだけ、ここに出す (通常の幅では帯のボタンを使う) */}
              {!readonly && <div className="menu-actions">
                <button className="btn btn-primary btn-sm" onClick={addSibling}>+ Block</button>
                <button className="btn btn-sm layout-action" onClick={autoLayout}>Auto Layout</button>
                <button className="btn btn-ghost btn-sm" onClick={undo} disabled={past === 0}>Undo</button>
                <button className="btn btn-ghost btn-sm" onClick={redo} disabled={future === 0}>Redo</button>
              </div>}
              {!readonly && (
                <button className="btn btn-ghost btn-sm justify-start" onClick={addProject} title={t("同じファイルにプロジェクトのボックスを足す")}>New Project</button>
              )}
              {!readonly && <div style={{ borderTop: "1px solid var(--line-soft)", margin: "4px 0" }} />}
              <button className="btn btn-ghost btn-sm justify-start" onClick={exportJSON}>Export JSON</button>
              <button className="btn btn-ghost btn-sm justify-start" onClick={exportMd}>Export Markdown</button>
              <button className="btn btn-ghost btn-sm justify-start" onClick={copyMermaid}>Copy Mermaid</button>
              <button className="btn btn-ghost btn-sm justify-start" onClick={doImport}>Import JSON</button>
              {source === "vscode" && !readonly && <button className="btn btn-ghost btn-sm justify-start" disabled={restoring} onClick={loadEvacuated}>{t("退避した編集を読み込む")}</button>}
              <div style={{ borderTop: "1px solid var(--line-soft)", margin: "4px 0" }} />
              <button className="btn btn-ghost btn-sm justify-start" onClick={onHelp}>Help</button>
              <button className="btn btn-ghost btn-sm justify-start" onClick={closeProject}>Home</button>
              <div style={{ borderTop: "1px solid var(--line-soft)", margin: "4px 0" }} />
              {/* 言語の切替: 今と反対側の言語名を出す (日本語のとき「English」、英語のとき「日本語」) */}
              <button className="btn btn-ghost btn-sm justify-start" onClick={() => setLang(lang === "en" ? "ja" : "en")} title={t("画面の文言の言語を切り替える")}>{lang === "en" ? "日本語" : "English"}</button>
            </div>
          )}
        </div>
        <button className="btn btn-ghost btn-sm" onClick={toggleTheme} title={theme === "dark" ? "Light mode" : "Dark mode"}>{theme === "dark" ? "☀" : "☾"}</button>
      </div>
    </header>
  );
}

/**
 * 上の帯: ☰ (引き出し)、ロゴ、プロジェクト名 (押すと設定)、追加、元に戻す、メニュー、表示モード
 */
import { useEffect, useRef, useState } from "react";
import { addBlock, addProjectBlock, searchBlocks, summarize, toJSON } from "../model/graph";
import { layoutAll } from "../model/autolayout";
import { projectToMarkdown, scopeToMermaid } from "../model/export";
import { ROOT_ID, type Project } from "../model/types";
import { parentForNewBlock, useProjectStore } from "../store/useProjectStore";
import { applyTheme, currentTheme, type Theme } from "../lib/theme";
import { copyText, downloadText, pickTextFile, safeFilename } from "../lib/download";

export function TopBar({ project, onToggleDrawer, onHelp }: { project: Project; onToggleDrawer: () => void; onHelp: () => void }) {
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
  const [theme, setTheme] = useState<Theme>(currentTheme());
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
      const target = ev.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (ev.key === "/") {
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

  /** ブロックを足す (選んでいる箱の中。何も選んでいなければ最初のプロジェクトの中) */
  // 最上位にプロジェクトの箱を足す (+ Project ボタンと ⋯ メニューの New Project)
  const addProject = () => {
    const name = prompt("追加するプロジェクトの名前 (リポジトリごとに 1 つなど)");
    if (name?.trim()) apply((p) => { const r = addProjectBlock(p, name.trim()); setTimeout(() => { select({ blockId: r.blockId }); focusBlock(r.blockId); }, 0); return r.project; });
  };
  const addSibling = () => {
    const parentId = parentForNewBlock(project, selection, useProjectStore.getState().viewScope);
    apply((p) => {
      const r = addBlock(p, { parentId, title: "新しいブロック" });
      const q = structuredClone(r.project);
      if (q.blocks[parentId]) q.blocks[parentId].collapsed = false;
      setTimeout(() => { select({ blockId: r.blockId }); focusBlock(r.blockId); }, 0);
      return q;
    });
  };

  const exportJSON = () => downloadText(`${safeFilename(project.name)}.boxglow.json`, toJSON(project), "application/json");
  const exportMd = () => downloadText(`${safeFilename(project.name)}.md`, projectToMarkdown(project), "text/markdown");
  const copyMermaid = async () => {
    setToast((await copyText(scopeToMermaid(project, selection.blockId ?? ROOT_ID))) ? "Mermaid をコピーしました" : "コピーできませんでした");
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
  // 保存状態: 常に見える札にする (ファイルを開いているときは「どこに保存されるか」と「保存済みか」が分かるように)
  const saveLabel = readonly ? "Read only" : ephemeral ? "Sample (not saved)" : saveState === "saving" ? "Saving…" : saveState === "unsaved" ? "Unsaved" : "Saved";
  const saveTitle = ephemeral ? "サンプルは保存されません。Save で自分のプロジェクトとして保存" : fileName ? `${fileName} に自動で保存します (変更から 1 秒後)。Save で今すぐ書きます` : "このブラウザに自動で保存します";
  const sum = summarize(project);
  const busy = sum.working.length + sum.blocked.length;

  return (
    <header className="flex items-center gap-3 px-3 h-full" style={{ paddingTop: 9, paddingBottom: 7, borderBottom: "2px solid var(--line)", background: "var(--bg-card)" }}>
      <button className="btn btn-ghost btn-sm" onClick={onToggleDrawer} title="階層 / 絞り込み / メンバー / 部品">☰</button>
      <button className="btn btn-ghost btn-sm" onClick={closeProject} title="Home (プロジェクト一覧へ)" aria-label="Home">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 11.5 12 4l9 7.5" />
          <path d="M5.5 10.5V20h13v-9.5" />
          <path d="M10 20v-5h4v5" />
        </svg>
      </button>
      <span className={`save-chip ${saveState === "unsaved" ? "unsaved" : ""}`} title={saveTitle}>
        {fileName && <span className="save-chip__file">{fileName}</span>}
        <span>{saveLabel}</span>
      </span>
      {ephemeral && !readonly && <button className="btn btn-sm" onClick={copyToMine} title="自分のプロジェクトとして保存">Save</button>}
      {!ephemeral && !readonly && <button className="btn btn-sm" onClick={saveNow} disabled={saveState === "saved" || saveState === "saving"} title={saveTitle}>Save</button>}
      <button className="summary-chip" data-on={selection.timeline} onClick={() => select({ timeline: !selection.timeline })} title="今の状況 (作業中・判断待ち・ログ)">
        {busy > 0 && <span className="dot" />}
        {busy > 0 && <span><span className="summary-chip__txt">作業中 </span>{busy}</span>}
        {sum.decisions.length > 0 && <span className="dot decision" />}
        {sum.decisions.length > 0 && <span><span className="summary-chip__txt">判断待ち </span>{sum.decisions.length}</span>}
        {busy === 0 && sum.decisions.length === 0 && <span>Activity</span>}
      </button>
      <div className="ml-auto flex items-center gap-1">
        {!readonly && (
          <button className="mode-toggle" data-on={editMode} onClick={() => setEditMode(!editMode)} title={editMode ? "Edit モード: ドラッグで移動・結線・階層移動ができます。押すと View (閲覧) に" : "View モード: ドラッグでの編集は効きません。押すと Edit に"}>
            <span className="mode-toggle__knob" />
            <span>{editMode ? "Edit" : "View"}</span>
          </button>
        )}
        <div className="relative">
          <input ref={searchRef} className="input search-box" placeholder="Search  ID / 題名" value={query}
            onChange={(e) => { setQuery(e.target.value); setSearchOpen(true); }}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={(e) => { if (e.key === "Enter" && hits[0]) jump(hits[0].id); if (e.key === "Escape") { setSearchOpen(false); setQuery(""); (e.target as HTMLInputElement).blur(); } }}
            onBlur={() => setTimeout(() => setSearchOpen(false), 150)} />
          {searchOpen && query.trim() && hits.length > 0 && (
            <div className="card absolute right-0 mt-1 p-1 flex flex-col z-30" style={{ minWidth: 280, maxHeight: 320, overflow: "auto" }}>
              {hits.map((h) => (
                <button key={h.id} className="btn btn-ghost btn-sm justify-start" onMouseDown={(e) => e.preventDefault()} onClick={() => jump(h.id)}>
                  <span className="chip" style={{ fontFamily: "ui-monospace, monospace", marginRight: 6 }}>{h.key}</span>
                  <span className="truncate">{h.title}</span>
                </button>
              ))}
            </div>
          )}
          {searchOpen && query.trim() && hits.length === 0 && (
            <div className="card absolute right-0 mt-1 p-2 text-[12px] z-30" style={{ minWidth: 200, color: "var(--text-muted)" }}>見つかりません</div>
          )}
        </div>
        {!readonly && (
          <>
            <button className="btn btn-primary btn-sm" onClick={addSibling} title="ブロックを追加 (N)。箱を選んでいればその中に、選んでいなければプロジェクトの中に">+ Block</button>
            <button className="btn btn-sm" onClick={addProject} title="最上位にプロジェクトの箱を足す (リポジトリごとに 1 つなど)">+ Project</button>
            <button className="btn btn-ghost btn-sm hidden md:inline-flex" onClick={undo} disabled={past === 0} title="元に戻す (Ctrl+Z)">↶</button>
            <button className="btn btn-ghost btn-sm hidden md:inline-flex" onClick={redo} disabled={future === 0} title="やり直す (Ctrl+Y)">↷</button>
          </>
        )}
        <div className="relative">
          <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); setMenu(!menu); }} title="Menu">⋯</button>
          {menu && (
            <div className="card absolute right-0 mt-1 p-1 flex flex-col z-30" style={{ minWidth: 220 }}>
              {!readonly && <button className="btn btn-ghost btn-sm justify-start" onClick={() => apply((p) => layoutAll(p))} title="依存関係で並べ直す">Auto Layout</button>}
              {!readonly && (
                <button className="btn btn-ghost btn-sm justify-start" onClick={addProject} title="同じファイルにプロジェクトの箱を足す">New Project</button>
              )}
              {!readonly && <div style={{ borderTop: "1px solid var(--line-soft)", margin: "4px 0" }} />}
              <button className="btn btn-ghost btn-sm justify-start" onClick={exportJSON}>Export JSON</button>
              <button className="btn btn-ghost btn-sm justify-start" onClick={exportMd}>Export Markdown</button>
              <button className="btn btn-ghost btn-sm justify-start" onClick={copyMermaid}>Copy Mermaid</button>
              <button className="btn btn-ghost btn-sm justify-start" onClick={doImport}>Import JSON</button>
              <div style={{ borderTop: "1px solid var(--line-soft)", margin: "4px 0" }} />
              <button className="btn btn-ghost btn-sm justify-start" onClick={onHelp}>Help</button>
              <button className="btn btn-ghost btn-sm justify-start" onClick={closeProject}>Home</button>
            </div>
          )}
        </div>
        <button className="btn btn-ghost btn-sm" onClick={toggleTheme} title={theme === "dark" ? "Light mode" : "Dark mode"}>{theme === "dark" ? "☀" : "☾"}</button>
      </div>
    </header>
  );
}

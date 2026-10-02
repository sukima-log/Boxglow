/**
 * プロジェクトを開いていないときの画面: 一覧、新規作成、JSON 読み込み、サンプル
 */
import { useEffect, useState } from "react";
import { useProjectStore } from "../store/useProjectStore";
import { pickTextFile } from "../lib/download";
import { canOpenLocalFile, lastLocalFile, pickLocalFile } from "../lib/localfile";

export function HomeDialog() {
  const projects = useProjectStore((s) => s.projects);
  const refreshList = useProjectStore((s) => s.refreshList);
  const newProject = useProjectStore((s) => s.newProject);
  const openProject = useProjectStore((s) => s.openProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const importJSON = useProjectStore((s) => s.importJSON);
  const openSample = useProjectStore((s) => s.openSample);
  const setToast = useProjectStore((s) => s.setToast);
  const openLocalFile = useProjectStore((s) => s.openLocalFile);
  const [name, setName] = useState("");
  const [last, setLast] = useState<FileSystemFileHandle | null>(null);

  useEffect(() => {
    void refreshList();
    void lastLocalFile().then(setLast);
  }, [refreshList]);

  const openFile = async () => {
    const h = await pickLocalFile();
    if (h) await openLocalFile(h);
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

  return (
    <div className="modal-backdrop">
      <div className="card modal p-6 flex flex-col gap-5">
        <div>
          <h1 className="text-[26px] flex items-center gap-2">
            <span className="tree-glyph white" style={{ width: 28, height: 28, fontSize: 16, lineHeight: "24px", boxShadow: "0 0 12px 3px var(--box-white-glow)" }}>✓</span>
            Boxglow
          </h1>
          <p className="mt-1" style={{ color: "var(--text-muted)" }}>AI エージェントとチームの作業を、箱と線で一目で。</p>
        </div>

        <div className="flex gap-2 flex-wrap">
          <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="New project name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && newProject(name.trim())} />
          <button className="btn btn-primary" disabled={!name.trim()} onClick={() => newProject(name.trim())}>Create</button>
          <button className="btn" onClick={doImport}>Import JSON</button>
          <button className="btn btn-accent" onClick={openSample}>Open Sample</button>
        </div>

        {canOpenLocalFile() ? (
          <div className="flex flex-col gap-2 p-3 rounded-lg" style={{ border: "2px solid var(--primary)", background: "var(--primary-soft)" }}>
            <div className="font-head text-[15px]">Open a repo file (boxglow.json)</div>
            <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>
              Claude Code / Codex が <b>npx boxglow</b> で更新するファイルをそのまま開きます。変更は 1〜2 秒で画面に反映され、画面での編集はファイルに書き戻されます。
            </div>
            <div className="flex gap-2 flex-wrap">
              <button className="btn btn-primary" onClick={openFile}>Open boxglow.json</button>
              {last && <button className="btn" onClick={() => openLocalFile(last)} title="前回開いたファイル">Reopen {last.name}</button>}
            </div>
          </div>
        ) : (
          <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            リポジトリ内の boxglow.json を直接開いて AI エージェントと共有するには、Chrome または Edge で開いてください。
          </div>
        )}

        <div>
          <div className="label mb-1">Projects</div>
          {projects.length === 0 ? (
            <div className="text-[13px]" style={{ color: "var(--text-muted)" }}>まだありません。上から作るか、サンプルを開いてみてください。</div>
          ) : (
            <div className="flex flex-col gap-1">
              {projects.map((m) => (
                <div key={m.id} className="flex items-center gap-2 tree-row" onClick={() => openProject(m.id)}>
                  <span className="truncate font-head text-[15px]">{m.name}</span>
                  <span className="text-[11px] ml-auto flex-none" style={{ color: "var(--text-muted)" }}>{new Date(m.updatedAt).toLocaleString("ja-JP")}</span>
                  <button className="btn btn-ghost btn-sm btn-danger flex-none" title="削除" onClick={(e) => { e.stopPropagation(); if (confirm(`「${m.name}」を削除します。よろしいですか?`)) void deleteProject(m.id); }}>×</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>
          すきま研究所日誌 (<a className="underline" href="https://www.sukimalog.com/" style={{ color: "var(--primary-strong)" }}>sukimalog.com</a>) のアプリ。
          紹介記事に使い方の説明があります。
        </div>
      </div>
    </div>
  );
}

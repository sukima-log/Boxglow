/**
 * 普段は記入済みの範囲だけを畳んで表示し、編集欄は利用者が開いたときだけ出す。
 */
import { SCOPE_FIELDS, scopeEntries } from "../model/workflow";
import { updateBlock } from "../model/graph";
import type { Project, WorkScope } from "../model/types";
import { useProjectStore } from "../store/useProjectStore";
import { DebouncedText } from "./parts";
import { t, useLang } from "../i18n";

/** Input: 計画、対象、明示的な編集状態 / Output: 記入済みの範囲か、利用者が開いた編集欄。 */
export function WorkScopePanel({ project, blockId, editing, onClose }: { project: Project; blockId: string; editing: boolean; onClose: () => void }) {
  useLang();
  const apply = useProjectStore(s => s.apply);
  const readonly = useProjectStore(s => s.readonly);
  const b = project.blocks[blockId];
  const entries = scopeEntries(b.scope);
  const focus = project.focusBlockId === blockId;
  if (!editing && !entries.length && !focus) return null;
  // 各欄の変更は最新のストアからマージする。別の欄の変更を古い props で消さない。
  const change = (key: keyof WorkScope, value: string) => apply(p => {
    const scope = { ...p.blocks[blockId].scope };
    if (value.trim()) scope[key] = value.trim(); else delete scope[key];
    return updateBlock(p, blockId, { scope: Object.keys(scope).length ? scope : undefined });
  });
  return <section className="work-scope text-[12px]">
    {focus && <span className="meta-chip">{t("今回の対象")}</span>}
    {editing ? <div className="flex flex-col gap-2">
      {SCOPE_FIELDS.map(([key, label]) => <label key={key}>{t(label)}
        <DebouncedText multiline className="input" aria-label={t(label)} value={b.scope?.[key] ?? ""} disabled={readonly} onCommit={v => change(key, v)} />
      </label>)}
      <button className="btn btn-sm" onClick={onClose}>{t("閉じる")}</button>
    </div> : entries.length > 0 && <details>
      <summary>{t("今回の範囲")}</summary>
      <dl className="flex flex-col gap-2 mt-2">{entries.map(x => <div key={x.key}><dt className="font-bold">{x.label}</dt><dd className="whitespace-pre-wrap break-words">{x.text}</dd></div>)}</dl>
    </details>}
  </section>;
}

/** Input: 計画 / Output: プロジェクト設定の中で必要時に開く確認方法。人の操作は常に許可する。 */
export function WorkflowSettings({ project }: { project: Project }) {
  useLang();
  const apply = useProjectStore(s => s.apply);
  const readonly = useProjectStore(s => s.readonly);
  return <details className="text-[12px] workflow-settings">
    <summary>{t("AI の作業確認")}</summary>
    <div className="flex flex-col gap-2 mt-2">
      {([["startWithoutInputs", "入力待ちで開始"], ["doneWithoutArtifacts", "成果物なしで完了"]] as const).map(([key, label]) =>
        <label key={key}>{t(label)}<select className="input" aria-label={t(label)} disabled={readonly} value={project.workflowPolicy?.[key] ?? "warn"}
          onChange={e => { const value = e.target.value as "warn" | "reject"; apply(p => ({ ...p, workflowPolicy: { ...p.workflowPolicy, [key]: value } })); }}>
          <option value="warn">{t("警告 (既定)")}</option><option value="reject">{t("拒否")}</option>
        </select></label>)}
      <p>{t("人の操作は拒否しません。入力待ちの開始は、理由を記録すれば許可します。")}</p>
    </div>
  </details>;
}

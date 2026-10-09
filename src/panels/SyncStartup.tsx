/** 同期開始の入口。送り先・保存先を先に示し、実際の処理は許可リスト付きホストへ渡す。 */
import { useState } from "react";
import { t } from "../i18n";
import type { HostAction, SyncStatus } from "../sync/status";
/** 入力: 公開状態・ホスト操作・未保存の有無。出力: 開始、一覧、保存先選択の画面。 */
export function SyncStartup({ status, act, unsaved }: {
  status: SyncStatus;
  act: (a: HostAction) => Promise<unknown>;
  unsaved: boolean;
}) {
  const [id, setId] = useState("");
  const [destination, setDestination] = useState<"current" | "new">(status.file?.binding ? "current" : "new");
  const [name, setName] = useState("remote.boxglow.json");
  const op = status.startup;
  if (!op)
    return <>
      <button className="btn btn-primary btn-sm" disabled={unsaved} onClick={() => void act({ kind: "beginSync" })}>{t("同期を始める")}</button>
      {/* Boxglow の同期サーバーは招待制の試験中: 押す前に分かるよう 1 行だけ添える (自分のサーバーでは出さない) */}
      {status.isDefaultServer && <p className="muted">{t("Boxglow の同期サーバーは招待制の試験中です")}</p>}
    </>;
  const filename = status.file?.path.split(/[\\/]/).pop();
  const busy = op.stage === "working";
  return <section className="sync-startup" aria-label={t("同期を始める")}>
  <p>{t("送り先")}: <span className="break-all">{status.isDefaultServer ? t("Boxglow の同期サーバー") : status.server}</span></p>
  {op.stage !== "list" && op.stage !== "opened" && <p>{t("今開いているファイル")}: <span className="break-all">{filename}</span></p>}
  {op.error && <p role="alert">{op.error}</p>}
  {/* 招待されていないときは、やり直しではなく順番待ちを案内する */}
  {status.notInvited?.waitlist && <a className="btn btn-sm" href={status.notInvited.waitlist} target="_blank" rel="noreferrer">{t("順番待ちに登録する")}</a>}
  {op.stage === "choose" && <div className="sync-panel__choices">
   <button className="btn btn-primary btn-sm" disabled={unsaved} onClick={() => void act({ kind: "continueStart", operationId: op.operationId, intent: "new" })}>{t("この計画を新しくサーバーに置く")}</button>
   <button className="btn btn-sm" disabled={unsaved} onClick={() => void act({ kind: "continueStart", operationId: op.operationId, intent: "existing" })}>{t("サーバーの計画を開く")}</button>
  </div>}
  {op.stage === "signin" && <p>{t("サインイン後、選んだ手順を続けます。")}</p>}
  {busy && <p role="status">{t("処理しています…")}</p>}
  {op.stage === "opened" && op.opened && <>
   <p>{t("計画を保存しました。")}</p><p className="break-all">{op.opened.path.split(/[\\/]/).pop()}</p>
   {op.opened.url && <a className="btn btn-primary btn-sm" href={op.opened.url} target="_blank" rel="noreferrer">{t("保存した計画を開く")}</a>}
  </>}
  {op.stage === "list" && <>
   {status.destinationPicker && <fieldset>
    <legend>{t("保存先")}</legend>
    <label><input name="sync-destination" type="radio" checked={destination === "current"} onChange={() => setDestination("current")}/>{t("今開いているファイル")}: {filename}</label>
    <label><input name="sync-destination" type="radio" checked={destination === "new"} onChange={() => setDestination("new")}/>{t("新しいファイル")}</label>
    {destination === "new" && (status.destinationPicker === "sibling"
          ? <label>{t("同じフォルダ内のファイル名")}<input className="input" aria-label={t("保存ファイル名")} value={name} onChange={e => setName(e.target.value)} maxLength={128}/></label>
          : <p>{t("計画を選んだ後、保存ダイアログを開きます。")}</p>)}
   </fieldset>}
   <p>{destination === "current" ? t("開く計画を選んでください。手元と内容が違う場合は、比較してから進みます。") : t("開く計画を選んでください。")}</p>
   {op.unsupported && <p>{t("このサーバーは計画一覧に対応していません。計画IDを指定してください。")}</p>}
   {op.projects?.map(p => <div key={p.id} className="sync-panel__row"><button className="sync-project-row btn" disabled={unsaved} onClick={() => void act({ kind: "openProject", operationId: op.operationId, projectId: p.id, destination, name })}>
    <strong>{p.name || p.id}</strong><span>{p.updatedAt ? new Date(p.updatedAt).toLocaleString() : t("更新日時不明")} · {Math.ceil(p.bytes / 1024)} KB</span>
   </button><button className="btn btn-ghost btn-sm" aria-label={t("サーバーから削除…")+" "+p.name} title={t("サーバーから削除…")} onClick={()=>void act({kind:"previewDelete",projectId:p.id})}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></svg></button></div>)}
   {!op.unsupported && op.projects?.length === 0 && !op.error && <p>{t("このアカウントの計画はありません。")}</p>}
   <div className="sync-panel__row">
    <button className="btn btn-ghost btn-sm" onClick={() => void act({ kind: "listProjects", operationId: op.operationId })}>{t("再読み込み")}</button>
    {op.nextCursor && <button className="btn btn-sm" onClick={() => void act({ kind: "listProjects", operationId: op.operationId, cursor: op.nextCursor! })}>{t("次のページ")}</button>}
   </div>
   <details><summary>{t("計画IDを指定")}</summary><p>{t("別の送り先は --server または VS Code の boxglow.sync.server で指定できます。")}</p>
    <input className="input" aria-label={t("計画ID")} value={id} onChange={e => setId(e.target.value)} maxLength={256}/>
    <button className="btn btn-sm" disabled={!id.trim() || unsaved} onClick={() => void act({ kind: "openProject", operationId: op.operationId, projectId: id.trim(), destination, name })}>{t("開く")}</button>
   </details>
  </>}
  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act({ kind: "cancelBegin" })}>{t("中止")}</button>
 </section>;
}

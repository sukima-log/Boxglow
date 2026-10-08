/** 削除・復元は対象と影響を確認してから実行する。手元のファイルを削除する入口ではない。 */
import { useEffect, useRef, useState } from "react";
import { t, getLang } from "../i18n";
import type { HostAction, SyncStatus } from "../sync/status";
export function SyncLifecycle({status,act}:{status:SyncStatus;act:(a:HostAction)=>Promise<unknown>}) {
 const state=status.lifecycle, preview=state?.preview;
 const previous=useRef<string|null>(null),[replaced,setReplaced]=useState(false);
 useEffect(()=>{
  if(!state){previous.current=null;setReplaced(false);}
  else if(preview){setReplaced(previous.current!==null && previous.current!==state.choiceId);previous.current=state.choiceId;}
 },[state?.choiceId,!!preview]);
 const current=preview?.id===status.file?.binding?.remoteId;
 return <section className="sync-lifecycle" aria-label={t("サーバーの計画を管理")}>
  <div className="sync-panel__row">
   <button className="btn btn-sm" disabled={state?.busy} onClick={()=>void act({kind:"beginSync"})}>{t("サーバーの計画を開く")}</button>
   <button className="btn btn-sm" disabled={state?.busy} onClick={()=>void act({kind:"listTrash"})}>{t("削除済みの計画")}</button>
   {status.file?.binding && <button className="btn btn-ghost btn-sm" disabled={state?.busy} onClick={()=>void act({kind:"previewDelete",projectId:status.file!.binding!.remoteId})}>{t("サーバーから削除…")}</button>}
  </div>
  {state && <div className="sync-lifecycle__body">
   {state.busy && <p role="status">{t("処理しています…")}</p>}
   {state.error && <p role="alert">{state.error}</p>}
   {state.message && <p role="status">{state.message}</p>}
   {preview && <div className="sync-lifecycle__confirm">
    {replaced && <p role="alert">{t("確認する対象が切り替わりました。名前と同期先をもう一度確認してください。")}</p>}
    <strong>{preview.kind === "delete" ? t("この計画をサーバーから削除しますか？") : t("この計画を復元しますか？")}</strong>
    <p>{preview.name}</p><p className="break-all">{t("送り先")}: {status.server}<br/>{t("利用者")}: {preview.account}<br/>ID: {preview.id}</p>
    {preview.kind === "delete" ? <>
     <p>{current ? t("このファイルの同期先です。削除すると、このファイルの同期が止まります。") : t("このファイルの同期先とは別の計画です。")}</p>
     <p>{t("削除から30日間は復元できます。手元のファイルと未送信の編集は残ります。")}</p>
    </> : <p>{t("新しいIDに戻します。元のIDの端末は止まったままです。復元後に結び直して、未送信の編集と比較できます。")}</p>}
    {status.file && <p className="break-all">{t("今開いているファイル")}: {status.file.path}</p>}
    {preview.expiresAt && <p>{t("復元期限")}: {new Date(preview.expiresAt).toLocaleString(getLang() === "ja" ? "ja-JP" : "en-US")}</p>}
    <button className={preview.kind === "delete" ? "btn btn-danger btn-sm" : "btn btn-primary btn-sm"} disabled={state.busy} onClick={()=>void act({kind:"confirmLifecycle",choiceId:state.choiceId})}>{preview.kind === "delete" ? t("削除を確定") : t("復元を確定")}</button>
   </div>}
   {state.projects?.map(p=><div className="sync-project-row" key={p.id}>
    <strong>{p.name}</strong><small>{t("復元期限")}: {new Date(p.expiresAt).toLocaleString(getLang() === "ja" ? "ja-JP" : "en-US")}</small>
    <button className="btn btn-sm" disabled={!p.restorable || state.busy} onClick={()=>void act({kind:"previewRestore",projectId:p.id})}>{p.restoredId ? t("復元済み") : p.restorable ? t("復元…") : t("期限終了")}</button>
   </div>)}
   {state.projects?.length === 0 && <p>{t("削除済みの計画はありません。")}</p>}
   {state.nextCursor && <button className="btn btn-sm" disabled={state.busy} onClick={()=>void act({kind:"listTrash",cursor:state.nextCursor!})}>{t("次のページ")}</button>}
   <button className="btn btn-ghost btn-sm" disabled={state.busy} onClick={()=>void act({kind:"cancelLifecycle"})}>{t("閉じる")}</button>
  </div>}
 </section>;
}

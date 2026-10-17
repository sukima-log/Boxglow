/** 削除・復元は対象と影響を確認してから実行する。手元のファイルを削除する入口ではない。 */
import { useEffect, useRef, useState } from "react";
import { t, getLang } from "../i18n";
import type { HostAction, SyncStatus } from "../sync/status";
export function SyncLifecycle({status,act}:{status:SyncStatus;act:(a:HostAction)=>Promise<unknown>}) {
 const state=status.lifecycle, preview=state?.preview;
 const previous=useRef<string|null>(null),[replaced,setReplaced]=useState(false);
 /** 共有リンクの期限 (日。0 = 無期限) と、URL をコピーしたか */
 const [expires,setExpires]=useState(30),[copied,setCopied]=useState(false);
 useEffect(()=>{setCopied(false);},[state?.newShare?.id]);
 useEffect(()=>{
  if(!state){previous.current=null;setReplaced(false);}
  else if(preview){setReplaced(previous.current!==null && previous.current!==state.choiceId);previous.current=state.choiceId;}
 },[state?.choiceId,!!preview]);
 const current=preview?.id===status.file?.binding?.remoteId;
 return <section className="sync-lifecycle" aria-label={t("サーバーの計画を管理")}>
  <div className="sync-panel__row">
   <button className="btn btn-sm" disabled={state?.busy} onClick={()=>void act({kind:"beginSync"})}>{t("サーバーの計画を開く")}</button>
   <button className="btn btn-sm" disabled={state?.busy} onClick={()=>void act({kind:"listTrash"})}>{t("削除済みの計画")}</button>
   {status.file?.binding && <button className="btn btn-sm" disabled={state?.busy} onClick={()=>void act({kind:"listVersions",projectId:status.file!.binding!.remoteId})}>{t("履歴")}</button>}
   {status.file?.binding && <button className="btn btn-sm" disabled={state?.busy} onClick={()=>void act({kind:"listShares",projectId:status.file!.binding!.remoteId})}>{t("共有リンク")}</button>}
   {status.file?.binding && <button className="btn btn-ghost btn-sm" disabled={state?.busy} onClick={()=>void act({kind:"previewDelete",projectId:status.file!.binding!.remoteId})}>{t("サーバーから削除…")}</button>}
  </div>
  {state && <div className="sync-lifecycle__body">
   {state.busy && <p role="status">{t("処理しています…")}</p>}
   {state.error && <p role="alert">{state.error}</p>}
   {state.message && <p role="status">{state.message}</p>}
   {preview && <div className="sync-lifecycle__confirm">
    {replaced && <p role="alert">{t("確認する対象が切り替わりました。名前と同期先をもう一度確認してください。")}</p>}
    <strong>{preview.kind === "delete" ? t("この計画をサーバーから削除しますか？") : preview.kind === "revert" ? t("この版の内容に戻しますか？") : t("この計画を復元しますか？")}</strong>
    <p>{preview.name}</p><p className="break-all">{t("送り先")}: {status.server}<br/>{t("利用者")}: {preview.account}<br/>ID: {preview.id}</p>
    {preview.kind === "delete" ? <>
     <p>{current ? t("このファイルの同期先です。削除すると、このファイルの同期が止まります。") : t("このファイルの同期先とは別の計画です。")}</p>
     <p>{t("削除から30日間は復元できます。手元のファイルと未送信の編集は残ります。")}</p>
    </> : preview.kind === "revert" ? <>
     <p>{t("版")}: {preview.revision}</p>
     <p>{t("手元のファイルをこの版の内容で置き換えます (今の内容は控えに残ります)。サーバーの履歴は消えず、次の同期で新しい版として送られます。")}</p>
    </> : <p>{t("新しいIDに戻します。元のIDの端末は止まったままです。復元後に結び直して、未送信の編集と比較できます。")}</p>}
    {status.file && <p className="break-all">{t("今開いているファイル")}: {status.file.path}</p>}
    {preview.expiresAt && <p>{t("復元期限")}: {new Date(preview.expiresAt).toLocaleString(getLang() === "ja" ? "ja-JP" : "en-US")}</p>}
    <button className={preview.kind === "delete" ? "btn btn-danger btn-sm" : "btn btn-primary btn-sm"} disabled={state.busy} onClick={()=>void act({kind:"confirmLifecycle",choiceId:state.choiceId})}>{preview.kind === "delete" ? t("削除を確定") : preview.kind === "revert" ? t("この版に戻す") : t("復元を確定")}</button>
   </div>}
   {state.projects?.map(p=><div className="sync-project-row" key={p.id}>
    <strong>{p.name}</strong><small>{t("復元期限")}: {new Date(p.expiresAt).toLocaleString(getLang() === "ja" ? "ja-JP" : "en-US")}</small>
    <button className="btn btn-sm" disabled={!p.restorable || state.busy} onClick={()=>void act({kind:"previewRestore",projectId:p.id})}>{p.restoredId ? t("復元済み") : p.restorable ? t("復元…") : t("期限終了")}</button>
   </div>)}
   {state.projects?.length === 0 && <p>{t("削除済みの計画はありません。")}</p>}
   {/* 履歴: 新しい順。いちばん上は今の版 (戻す対象にしない) */}
   {state.versions?.map((v,i)=><div className="sync-project-row sync-version-row" key={v.revision}>
    <strong>{v.at ? new Date(v.at).toLocaleString(getLang() === "ja" ? "ja-JP" : "en-US") : "-"}</strong><small>{v.revision}</small>
    {i === 0 ? <small>{t("今の版")}</small> : <button className="btn btn-sm" disabled={state.busy} onClick={()=>void act({kind:"previewRevert",projectId:state.versionsOf!,revision:v.revision})}>{t("この版に戻す…")}</button>}
   </div>)}
   {state.versions?.length === 0 && <p>{t("履歴はまだありません。")}</p>}
   {/* 共有リンク (閲覧専用): 作る → URL は作った直後だけ表示 (保存しているのはハッシュ)。一覧は作成日と期限、失効 */}
   {state.shares && state.sharesOf && <div className="sync-shares">
    <p className="muted">{t("リンクを知っている人は、この計画の最新の内容を閲覧専用で見られます (サインイン不要)。")}</p>
    <div className="sync-panel__row">
     <button className="btn btn-primary btn-sm" disabled={state.busy} onClick={()=>void act({kind:"createShare",projectId:state.sharesOf!,expiresInDays:expires || undefined})}>{t("リンクを作る")}</button>
     <label className="sync-shares__expires">{t("期限")}
      <select value={expires} onChange={(e)=>setExpires(Number(e.target.value))} disabled={state.busy}>
       <option value={7}>{t("{n} 日",{n:"7"})}</option><option value={30}>{t("{n} 日",{n:"30"})}</option><option value={90}>{t("{n} 日",{n:"90"})}</option><option value={0}>{t("無期限")}</option>
      </select>
     </label>
    </div>
    {state.newShare && <div className="sync-shares__new">
     <strong>{t("リンクを作りました。この URL は今だけ表示されます (控えてください)。")}</strong>
     <div className="sync-panel__row">
      <input className="input sync-shares__url" readOnly value={state.newShare.url} onFocus={(e)=>e.currentTarget.select()} aria-label={t("共有リンクの URL")}/>
      <button className="btn btn-sm" onClick={()=>{void navigator.clipboard?.writeText(state.newShare!.url).then(()=>setCopied(true),()=>setCopied(false));}}>{copied ? t("コピーしました") : t("コピー")}</button>
     </div>
    </div>}
    {state.shares.map(s=><div className="sync-project-row sync-share-row" key={s.id} data-off={s.revoked || s.expired ? "true" : "false"}>
     <strong>{new Date(s.createdAt).toLocaleString(getLang() === "ja" ? "ja-JP" : "en-US")}</strong>
     <small>{s.revoked ? t("失効") : s.expired ? t("期限切れ") : s.expiresAt ? t("期限") + ": " + new Date(s.expiresAt).toLocaleDateString(getLang() === "ja" ? "ja-JP" : "en-US") : t("無期限")}</small>
     {!s.revoked && !s.expired && <button className="btn btn-ghost btn-sm" disabled={state.busy} onClick={()=>void act({kind:"revokeShare",projectId:state.sharesOf!,shareId:s.id})}>{t("失効")}</button>}
    </div>)}
    {state.shares.length === 0 && <p>{t("共有リンクはまだありません。")}</p>}
   </div>}
   {state.nextCursor && <button className="btn btn-sm" disabled={state.busy} onClick={()=>void act({kind:"listTrash",cursor:state.nextCursor!})}>{t("次のページ")}</button>}
   <button className="btn btn-ghost btn-sm" disabled={state.busy} onClick={()=>void act({kind:"cancelLifecycle"})}>{t("閉じる")}</button>
  </div>}
 </section>;
}

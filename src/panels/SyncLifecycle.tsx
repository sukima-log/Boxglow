/** 削除・復元は対象と影響を確認してから実行する。手元のファイルを削除する入口ではない。 */
import { useEffect, useRef, useState } from "react";
import React from "react";
import { t, getLang } from "../i18n";
import type { HostAction, SyncStatus } from "../sync/status";
import { SyncStartup } from "./SyncStartup";
type RowId="versions"|"shares"|"trash"|"open";
export function SyncLifecycle({status,act,unsaved=false}:{status:SyncStatus;act:(a:HostAction)=>Promise<unknown>;unsaved?:boolean}) {
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
 /** 行の一覧: 押すとその下に内容が開く (成功でも失敗でも、押した行の直下)。開いている行は印を付ける */
 const remoteId=status.file?.binding?.remoteId;
 // 「サーバーの計画を開く」は同期の開始の流れ (status.startup)。結び付いた計画では、この行の下に出す
 const startupHere=!!status.startup && !!remoteId;
 const [pressed,setPressed]=useState<RowId|null>(null);
 // その行の内容が「あった → 無くなった」ときだけ、押した行の記憶を消す
 // (押した直後は内容がまだ届いていないので、「無い」だけで消すと記憶が消えて末尾に出てしまう)
 const had=useRef({state:false,startup:false});
 useEffect(()=>{
  if(had.current.state && !state && pressed && pressed!=="open") setPressed(null);
  if(had.current.startup && !startupHere && pressed==="open") setPressed(null);
  had.current={state:!!state,startup:startupHere};
 },[!!state,startupHere,pressed]);
 const opened:RowId|null=pressed ?? (startupHere ? "open" : state?.versions ? "versions" : state?.shares ? "shares" : state?.projects ? "trash" : null);
 const Row=({id,icon,label,hint,onClick}:{id:RowId;icon:React.ReactNode;label:string;hint:string;onClick:()=>void})=>
  <button className="sync-action" data-open={opened===id ? "true" : "false"} aria-expanded={opened===id} disabled={state?.busy} onClick={()=>{
   if(opened===id) { setPressed(null); void act(id==="open" ? {kind:"cancelBegin"} : {kind:"cancelLifecycle"}); }
   else {
    // 別の行を開くときは、開いていたほうを閉じる (開始の流れと一覧を同時に出さない)
    if(id!=="open" && startupHere) void act({kind:"cancelBegin"});
    if(id==="open" && state) void act({kind:"cancelLifecycle"});
    setPressed(id); onClick();
   }
  }}>
   <span className="sync-action__icon" aria-hidden="true">{icon}</span>
   <span className="sync-action__text"><span className="sync-action__label">{label}</span><span className="sync-action__hint">{hint}</span></span>
   <span className="sync-action__chev" aria-hidden="true">{opened===id ? "▾" : "▸"}</span>
  </button>;
 const rows:{id:"versions"|"shares"|"trash"|"open";icon:React.ReactNode;label:string;hint:string;onClick:()=>void}[]=[
  ...(remoteId ? [
   {id:"versions" as const,icon:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 2"/></svg>,label:t("履歴"),hint:t("前の版に戻す"),onClick:()=>void act({kind:"listVersions",projectId:remoteId})},
   {id:"shares" as const,icon:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>,label:t("共有リンク"),hint:t("閲覧専用のリンクを作る"),onClick:()=>void act({kind:"listShares",projectId:remoteId})},
  ] : []),
  ...(status.features?.trash === false ? [] : [{id:"trash" as const,icon:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg>,label:t("ゴミ箱"),hint:t("削除した計画を戻す"),onClick:()=>void act({kind:"listTrash"})}]),
  ...(remoteId ? [{id:"open" as const,icon:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>,label:t("サーバーの計画を開く"),hint:t("別の計画を受け取る"),onClick:()=>void act({kind:"beginSync"})}] : []),
 ];
 /** 「サーバーの計画を開く」の中身: 同期の開始の流れを、この行の下に出す */
 // (結び付いた計画から開くのは「別の計画を受け取る」なので、選ぶ段階を飛ばして一覧へ進む受け取りの形にする)
 const startupEl=startupHere ? <div className="sync-lifecycle__body"><SyncStartup key={status.startup!.operationId} status={status} act={act} unsaved={unsaved} receive/></div> : null;
 /** 本文 (一覧・確認・結果)。開いている行の直下に挟む。どの行にも属さない内容 (その他からの削除の確認など) は末尾に */
 const bodyEl=state ? <div className="sync-lifecycle__body">
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
     {!s.revoked && !s.expired && <button className="btn btn-sm" disabled={state.busy} onClick={()=>void act({kind:"revokeShare",projectId:state.sharesOf!,shareId:s.id})}>{t("失効")}</button>}
    </div>)}
    {state.shares.length === 0 && <p>{t("共有リンクはまだありません。")}</p>}
   </div>}
   {state.nextCursor && <button className="btn btn-sm" disabled={state.busy} onClick={()=>void act({kind:"listTrash",cursor:state.nextCursor!})}>{t("次のページ")}</button>}
   {/* 行の直下に開いているときは、行をもう一度押せば閉じるので「閉じる」は出さない。行に属さない内容 (その他からの削除の確認など) だけに出す */}
   {opened===null && <button className="btn btn-ghost btn-sm" disabled={state.busy} onClick={()=>void act({kind:"cancelLifecycle"})}>{t("閉じる")}</button>}
  </div> : null;
 return <section className="sync-lifecycle" aria-label={t("この計画の操作")}>
  <div className="sync-actions">
   {rows.map(r=><React.Fragment key={r.id}>
    <Row id={r.id} icon={r.icon} label={r.label} hint={r.hint} onClick={r.onClick}/>
    {opened===r.id && (r.id==="open" ? startupEl : bodyEl)}
   </React.Fragment>)}
   {opened===null && bodyEl}
  </div>
 </section>;
}

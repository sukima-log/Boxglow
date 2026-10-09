/** 受け持ちは小さな錠アイコンで示し、詳細と操作は右パネルに集める。 */
import { useState, useSyncExternalStore } from "react";
import { activeClaim, claimsEnabled, covers, releaseClaim, type ClaimPolicy } from "../model/claims";
import type { Project } from "../model/types";
import { useProjectStore } from "../store/useProjectStore";
import { ACTIVITY_LABEL } from "../model/report";
import { t, useLang } from "../i18n";

let clock=Date.now(), timer:ReturnType<typeof setInterval>|undefined;
const listeners=new Set<()=>void>();
const subscribe=(fn:()=>void)=>{listeners.add(fn);if(!timer){clock=Date.now();timer=setInterval(()=>{clock=Date.now();listeners.forEach(f=>f());},15000);}return()=>{listeners.delete(fn);if(!listeners.size){clearInterval(timer);timer=undefined;}};};
const snapshot=()=>clock;
export const useClaimClock=()=>useSyncExternalStore(subscribe,snapshot,snapshot);
export function visibleClaim(p:Project,id:string,now:number) {
  if(!claimsEnabled(p)) return undefined;
  const matches=Object.entries(p.claims??{}).filter(([root,c])=>!c.releasedAt&&covers(p,root,c,id));
  return matches.find(([,c])=>activeClaim(c,now))??matches[0];
}
export function ClaimMark({project,blockId,compact=false}:{project:Project;blockId:string;compact?:boolean}) {
  useLang();const now=useClaimClock(), found=visibleClaim(project,blockId,now);
  if(!found)return null;
  const [root,c]=found, active=activeClaim(c,now), activity=project.blocks[blockId]?.activity;
  // 錠のツールチップ (Tree・箱の上で、誰が持っているかを確かめる場所)。同じ AI のサブエージェントは実行 ID で見分けるので、名前に添える
  const holder=c.instanceId?`${c.actor} (${c.instanceId})`:c.actor;
  const title=[active?t("受け持ち中: {actor}",{actor:holder}):t("受け持ち期限切れ: {actor}",{actor:holder}),
    t("範囲: {scope}",{scope:c.scope==="subtree"?t("配下を含む"):t("このボックス")}),project.blocks[root]?.title,
    t("期限: {date}",{date:new Date(c.expiresAt).toLocaleString()}),activity?`${activity.actor}: ${t(ACTIVITY_LABEL[activity.state])} ${activity.note}`:""].filter(Boolean).join("\n");
  return <span className={compact?"claim-mark":"meta-chip claim-mark"} data-expired={!active} role="img" aria-label={title} title={title}>
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="2"/><path d={active?"M5 7V5a3 3 0 016 0v2":"M5 7V5a3 3 0 016 0"}/><path d="M8 9v3"/></svg>
    {!compact&&<span>{active?[activity?t(ACTIVITY_LABEL[activity.state]):"",c.actor].filter(Boolean).join(" · "):t("期限切れ")}</span>}
  </span>;
}
export function ClaimSettings({project}:{project:Project}) {
  useLang();const readonly=useProjectStore(s=>s.readonly),apply=useProjectStore(s=>s.apply);
  const policy=project.claimPolicy??{mode:"off",leaseMinutes:30};
  const change=(next:ClaimPolicy)=>apply(p=>{
    let q:Project={...p,claimPolicy:next};
    if(next.mode==="off")for(const [id,c] of Object.entries(p.claims??{}))if(!c.releasedAt)q=releaseClaim(q,id,t("受け持ち制御を無効化"),Date.now());
    return {...q,log:[...q.log,{id:crypto.randomUUID(),at:new Date().toISOString(),actor:"human",kind:"note",claimEvent:"policy",message:t("受け持ち設定: {mode}",{mode:next.mode})}]};
  },{history:false});
  return <details className="text-[12px] claim-settings"><summary>{t("AI の受け持ち")}</summary>
    <div className="flex flex-col gap-2 mt-2">
      <label>{t("受け持ち制御")}<select className="input" aria-label={t("受け持ち制御")} value={policy.mode} disabled={readonly} onChange={e=>change({...policy,mode:e.target.value as ClaimPolicy["mode"]})}>
        <option value="off">{t("無効 (既定)")}</option><option value="reject">{t("有効・範囲外を拒否 (推奨)")}</option><option value="warn">{t("有効・警告のみ")}</option>
      </select></label>
      <label>{t("受け持ち期限 (分)")}<input className="input" type="number" min="1" max="1440" aria-label={t("受け持ち期限 (分)")} value={policy.leaseMinutes} disabled={readonly} onChange={e=>{const n=Number(e.target.value);if(Number.isInteger(n)&&n>=1&&n<=1440)change({...policy,leaseMinutes:n});}}/></label>
      <p>{t("受け持ちは同じ共有ファイル内の協調制御です。同期先の別端末や旧版の書き込みを排他しません。")}</p>
      <p>{t("CLI・MCPの保存に適用します。人の画面操作は継続できます。期限や解除はUndoでは戻しません。")}</p>
    </div>
  </details>;
}
export function ClaimDetails({project,blockId}:{project:Project;blockId:string}) {
  useLang();const now=useClaimClock(),[reason,setReason]=useState("");const apply=useProjectStore(s=>s.apply),readonly=useProjectStore(s=>s.readonly),toast=useProjectStore(s=>s.setToast);
  const found=visibleClaim(project,blockId,now);if(!found)return null;
  const [id,c]=found;
  return <details className="text-[12px] claim-details"><summary>{t("受け持ちの詳細")}: {c.actor}</summary>
    <div className="flex flex-col gap-2 mt-2"><ClaimMark project={project} blockId={blockId}/>
      <div>{t("実行ID")}: <code className="break-all">{c.instanceId}</code></div>
      <div>{t("範囲: {scope}",{scope:c.scope==="subtree"?t("配下を含む"):t("このボックス")})} ({project.blocks[id]?.title??id})</div>
      <div>{t("期限: {date}",{date:new Date(c.expiresAt).toLocaleString()})}</div>
      {!readonly&&<><input className="input" aria-label={t("解除する理由")} placeholder={t("解除する理由")} value={reason} onChange={e=>setReason(e.target.value)}/>
        <button className="btn btn-primary btn-sm self-start" disabled={!reason.trim()} onClick={()=>{apply(p=>{if(p.claims?.[id]?.generation!==c.generation||p.claims[id].claimId!==c.claimId){toast(t("受け持ちが変わりました。確認し直してください。"));return p;}const q=releaseClaim(p,id,reason,Date.now());return {...q,log:[...q.log,{id:crypto.randomUUID(),at:new Date().toISOString(),actor:"human",kind:"note",claimEvent:"release",blockId:id,message:t("受け持ちを解除: {reason}",{reason})}]};},{history:false});setReason("");}}>{t("理由を記録して解除")}</button></>}
    </div>
  </details>;
}

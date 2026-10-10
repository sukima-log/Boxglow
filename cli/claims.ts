/** CLIの保存ロック内で受け持ちを照合・更新する。権限の認証ではなく協調制御。 */
import { randomUUID } from "node:crypto";
import { t } from "../src/i18n/core";
import { fromJSON, toJSON, findBlock, isHumanActor } from "../src/model/graph";
import type { Project } from "../src/model/types";
import { rejectForeignClaim, activeClaim, covers, acquireClaim, checkClaimWrite, claimFootprint, claimsEnabled, claimToken, releaseClaim, renewClaims, requireClaim, validateClaims, type ClaimIdentity } from "../src/model/claims";

/** rootは受け持ちの操作だけで明示的に参照する。一般の検索対象は増やさない。 */
export const findClaimBlock=(p:Project,ref:string)=>ref==="root"?{block:p.blocks.root,candidates:[]}:findBlock(p,ref);

export interface ClaimCommand {
  command: string;
  target?: string;
  scope?: string;
  reason?: string;
  human: boolean;
  identity: ClaimIdentity;
}
export function claimCommand(command: string, target: string | undefined, options: Record<string,string|string[]|true>, actor: string): ClaimCommand {
  const str=(v: unknown) => typeof v === "string" ? v : Array.isArray(v) ? String(v.at(-1)) : undefined;
  const tokens=options["claim-token"];
  return {command,target,scope:str(options.scope),reason:str(options.reason),human:isHumanActor(str(options.actor)??""),
    identity:{actor,instanceId:str(options.instance)??process.env.BOXGLOW_INSTANCE_ID,tokens:typeof tokens==="string"?[tokens]:Array.isArray(tokens)?tokens:[]}};
}
export function prepareClaimSave(current: string|null, proposed: string, request: ClaimCommand, emit: (s:string)=>void, now=Date.now()): string {
  if (!current) return proposed;
  const before=fromJSON(current);
  let after=fromJSON(proposed);
  const {command,target,identity:who,human}=request;
  const id=target ? findClaimBlock(before,target).block?.id : undefined;
  const changingPolicy=command==="claim-policy";
  if (changingPolicy || command==="claim-release") {
    if (!human) throw new Error(t("受け持ちの設定と強制解除は人が行います。AIは人に依頼してください。"));
    if (changingPolicy) {
      validateClaims(after);
      // 無効化して再度有効にしても、古い受領証は復活しない。
      after={...after,claims:before.claims};
      if (after.claimPolicy?.mode==="off") for (const [root,c] of Object.entries(before.claims??{})) if(!c.releasedAt) after=releaseClaim(after,root,t("受け持ち制御を無効化"),now);
    } else {
      if(!id) throw new Error(t("受け持ちがありません。"));
      if(before.claims?.[id]?.releasedAt) { emit(t("すでに解除されています。")); return current; }
      after=releaseClaim(before,id,request.reason??"",now);
    }
    after={...after,log:[...after.log,{id:randomUUID(),at:new Date(now).toISOString(),actor:who.actor,kind:"note",claimEvent:changingPolicy?"policy":"release",...(id?{blockId:id}:{}),message:changingPolicy?t("受け持ち設定: {mode}",{mode:after.claimPolicy!.mode}):t("受け持ちを解除: {reason}",{reason:request.reason??""})}]};
    return toJSON(after)+"\n";
  }
  // 通常の操作は制御データを上書きしない。import/initによる回避も防ぐ。Git統合は別経路。
  if (JSON.stringify(before.claims)!==JSON.stringify(after.claims) || JSON.stringify(before.claimPolicy)!==JSON.stringify(after.claimPolicy)) throw new Error(t("受け持ちの設定と記録は専用の操作で変更してください。"));
  if(command==="claim-renew" && !claimsEnabled(before)) throw new Error(t("この計画では受け持ち制御が無効です。人が設定で有効にしてください。"));
  if (!claimsEnabled(before) || human) return proposed;
  let checked=before;
  const proof={...who,tokens:[...who.tokens]};
  // start と claim は受け持ちを取得 (または継承して延長) する。claim は取得だけで、状態は変えない
  if (command==="start" || command==="claim") {
    if (!id || (request.scope && !["block","subtree"].includes(request.scope))) throw new Error(t("受け持ちの範囲は block または subtree です。"));
    const inherited=Object.entries(before.claims??{}).find(([root,c])=>root!==id && activeClaim(c,now) && covers(before,root,c,id));
    if(inherited) { rejectForeignClaim(before,inherited[0],inherited[1],who,now); requireClaim(inherited[0],inherited[1],who,now); checked=renewClaims(before,[inherited[0]],who,now); }
    else checked=acquireClaim(before,id,request.scope==="subtree"?"subtree":"block",who,now,randomUUID());
    proof.tokens=proof.tokens.filter(token=>{try{return JSON.parse(token)[0]!==id;}catch{return true;}});
    if(!inherited) proof.tokens.push(claimToken(id,checked.claims![id]));
  }
  const ids=claimFootprint(before,after);
  // no-opでも完了・解除・延長は必ず世代と期限を照合する。
  if(id && ["start","claim","done","leave","checkpoint","claim-renew","set","port","artifact","ask","answer","ack","reopen","decision","blocked","review","scope","split","split-ok","box-ok","remove","move","layout","tidy"].includes(command)) ids.add(id);
  const result=checkClaimWrite(checked,ids,proof,now);
  if(command==="claim-renew" && !result.used.size) throw new Error(t("受け持ちがありません。"));
  for(const warning of result.warnings) emit(t("受け持ちの警告: {message}",{message:warning}));
  after={...after,claims:checked.claims};
  const roots=[...result.used].filter(root=>command==="checkpoint" || command==="claim-renew" || now-Date.parse(checked.claims![root].renewedAt)>=Math.min(300000,checked.claimPolicy!.leaseMinutes*30000));
  if(roots.length) after=renewClaims(after,roots,proof,now);
  if(id && (command==="done" || command==="leave") && checked.claims?.[id]?.instanceId===who.instanceId && checked.claims![id].actor===who.actor) {
    requireClaim(id,checked.claims![id],proof,now);
    after=releaseClaim(after,id,command,now);
  }
  // 削除された根の受け持ちも解放。世代の記録は残す。
  for(const root of result.used) if(!after.blocks[root] && !after.claims?.[root].releasedAt) after=releaseClaim(after,root,t("ボックスの削除"),now);
  return toJSON(after)+"\n";
}

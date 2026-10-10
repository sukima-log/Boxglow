/**
 * 同一共有ファイル内の期限付き受け持ち。actorは表示、instanceIdは実行単位、tokenは世代の照合。
 * 時計とIDは取得側から渡す。サーバーleaseではなく、別端末のコピー間の排他は保証しない。
 */
import type { Project } from "./types";
import { t } from "../i18n/core";

export interface Claim {
  actor: string;
  instanceId: string;
  claimId: string;
  scope: "block" | "subtree";
  generation: number;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
  releasedAt?: string;
  releaseReason?: string;
}
export interface ClaimPolicy { mode: "off" | "warn" | "reject"; leaseMinutes: number }
export interface ClaimIdentity { actor: string; instanceId?: string; tokens: string[] }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const claimsEnabled = (p: Project) => !!p.claimPolicy && p.claimPolicy.mode !== "off";
export const activeClaim = (c: Claim, now: number) => !c.releasedAt && now < Date.parse(c.expiresAt);
export const claimToken = (id: string, c: Claim) => JSON.stringify([id, c.generation, c.claimId]);
const owns = (c: Claim, who: ClaimIdentity) => !!who.instanceId && c.instanceId === who.instanceId && c.actor === who.actor;

/** 読み込みの境界で壊れた制御データを無視しない。旧計画は追加項目なしで通す。 */
export function validateClaims(p: Pick<Project, "claims" | "claimPolicy">): void {
  const policy = p.claimPolicy;
  if (policy !== undefined && (!policy || typeof policy !== "object" || Array.isArray(policy) || (!["off","warn","reject"].includes(policy.mode) || !Number.isInteger(policy.leaseMinutes) || policy.leaseMinutes < 1 || policy.leaseMinutes > 1440))) throw new Error(t("受け持ちの設定が正しくありません。期限は1〜1440分です。"));
  if (p.claims === undefined) return;
  if (!p.claims || typeof p.claims !== "object" || Array.isArray(p.claims)) throw new Error(t("受け持ちの記録が正しくありません。"));
  for (const [id,c] of Object.entries(p.claims)) {
    if (["__proto__","constructor","prototype"].includes(id) || !c || ![c.actor,c.instanceId,c.claimId].every(x=>typeof x === "string" && x.trim().length>0) || !["block","subtree"].includes(c.scope) || !Number.isSafeInteger(c.generation) || c.generation < 1 ||
      ![c.acquiredAt,c.renewedAt,c.expiresAt].every(x => typeof x === "string" && Number.isFinite(Date.parse(x))) ||
      Date.parse(c.acquiredAt) > Date.parse(c.renewedAt) || Date.parse(c.renewedAt) >= Date.parse(c.expiresAt) || (c.releasedAt !== undefined && (typeof c.releasedAt !== "string" || !Number.isFinite(Date.parse(c.releasedAt)))) || (c.releaseReason !== undefined && typeof c.releaseReason !== "string")) throw new Error(t("受け持ちの記録が正しくありません。"));
  }
}

/** 入力: ボックスと範囲の根。出力: 同じ根または子孫か。循環する外部入力でも停止する。 */
export function within(p: Project, id: string, root: string): boolean {
  const seen = new Set<string>();
  for (let at: string | null = id; at && !seen.has(at); at = p.blocks[at]?.parentId ?? null) {
    if (at === root) return true;
    seen.add(at);
  }
  return false;
}
export const covers = (p: Project, root: string, c: Claim, id: string) => root === id || (c.scope === "subtree" && within(p,id,root));

/** 古い世代・期限切れ・時計の逆行はwarnでも許可しない。遅れて終わる作業を再取得に化けさせない。 */
export function requireClaim(id: string, c: Claim | undefined, who: ClaimIdentity, now: number): Claim {
  if (!c || !owns(c,who) || !who.tokens.includes(claimToken(id,c)) || !activeClaim(c,now)) throw new Error(t("受け持ちが期限切れ・解除済みか、実行IDまたは世代が違います。取り直してから作業してください。"));
  if (now < Date.parse(c.renewedAt)) throw new Error(t("時計が受け持ちの更新時刻より前です。時計を確認してください。"));
  return c;
}

/** 入力: 有効な他者の取得。出力: 持ち主・範囲・期限と次の行動を含む説明。 */
export function foreignClaimMessage(p:Project,id:string,c:Claim,who:ClaimIdentity):string {
  const message=t("他の実行が受け持っています: {block} ({actor})。実行ID: {instance}、範囲: {scope}、期限: {expires}。人に解除を頼むか、別のボックスへ進んでください。",{
    block:p.blocks[id]?.key??id,actor:c.actor,instance:c.instanceId,scope:c.scope,expires:c.expiresAt,
  });
  return message+(c.actor===who.actor?t("同じ名前の別の実行です。自分の再起動前の実行とは限りません。他者の実行IDや受領証は使わないでください。"):"");
}
/** 入力: 対象と実行者。副作用: 他者が有効な取得を持つ場合だけ例外で止める。 */
export function rejectForeignClaim(p:Project,id:string,c:Claim,who:ClaimIdentity,now:number):void {
  if(activeClaim(c,now)&&!owns(c,who)) throw new Error(foreignClaimMessage(p,id,c,who));
}

/** 入力: 現在の計画と取得要求。出力: claimsだけを変えた計画。同じファイルのCASロック内で呼ぶ。 */
export function acquireClaim(p: Project, id: string, scope: Claim["scope"], who: ClaimIdentity, now: number, newId: string): Project {
  if (!claimsEnabled(p)) throw new Error(t("この計画では受け持ち制御が無効です。人が設定で有効にしてください。"));
  if (!p.blocks[id] || !who.instanceId) throw new Error(t("受け持ちには対象と固定した実行IDが必要です。--instance または BOXGLOW_INSTANCE_ID を指定してください。"));
  const old = p.claims?.[id];
  if (old && activeClaim(old,now)) { rejectForeignClaim(p,id,old,who,now); requireClaim(id,old,who,now); }
  for (const [other,c] of Object.entries(p.claims ?? {})) {
    if (other === id || !activeClaim(c,now)) continue;
    // 自分の重複取得も追加で拒否。子の作業は親の既存受領証を使う。
    if (owns(c,who) && (covers(p,other,c,id) || (scope === "subtree" && within(p,other,id)))) throw new Error(t("受け持ちが重なります。既存の範囲を使うか、解放してから取得してください。"));
    if ((covers(p,other,c,id) || (scope === "subtree" && within(p,other,id))) && !owns(c,who)) throw new Error(foreignClaimMessage(p,other,c,who));
  }
  const continuing = old && activeClaim(old,now) && old.scope === scope;
  const c: Claim = { actor:who.actor, instanceId:who.instanceId, claimId:continuing ? old.claimId : newId, scope,
    generation:continuing ? old.generation : nextGeneration(old?.generation),
    acquiredAt:continuing ? old.acquiredAt : new Date(now).toISOString(), renewedAt:new Date(now).toISOString(),
    expiresAt:new Date(now+p.claimPolicy!.leaseMinutes*60000).toISOString() };
  return {...p,claims:{...p.claims,[id]:c}};
}

/** 整数の精度を超えて世代の照合が崩れる場合は、記録せず止める。 */
function nextGeneration(previous=0): number {
  if(!Number.isSafeInteger(previous+1)) throw new Error(t("受け持ちの世代が上限に達しました。記録は変更していません。"));
  return previous+1;
}

/** 人の明示解除は理由を残し世代を進める。解放済みの記録を消さず、次回取得へ世代を渡す。 */
export function releaseClaim(p: Project, id: string, reason: string, now: number): Project {
  const c = p.claims?.[id];
  if (!c) throw new Error(t("受け持ちがありません。"));
  if(c.releasedAt) return p;
  if (!reason.trim()) throw new Error(t("解除する理由を入力してください。"));
  return {...p,claims:{...p.claims,[id]:{...c,generation:nextGeneration(c.generation),releasedAt:new Date(now).toISOString(),releaseReason:reason.trim()}}};
}

/**
 * 入力: 保存前後。出力: 更新に必要なボックスID。
 * 新規ボックスは既存の親の範囲、配線は両端、移動は本体と移動元/先、削除は全子孫を含む。
 * ログ・接続中エージェント・採番は操作の付随記録なので個別に受け持たない。
 */
export function claimFootprint(before: Project, after: Project): Set<string> {
  return claimFootprintDetail(before, after).ids;
}

/**
 * claimFootprint の詳細版: 位置・畳みだけが変わった (自動の配置で押された) ボックスの id も分けて返す
 * Input : before / after / Output: { ids = 受け持ちの照合の対象, layoutOnly = 押されただけで、他の実行が受け持っているため対象に入ったもの }
 */
export function claimFootprintDetail(before: Project, after: Project): { ids: Set<string>; layoutOnly: Set<string> } {
  const ids = new Set<string>();
  const layoutOnly = new Set<string>();
  const owner = (id: string | null | undefined) => {
    const seen = new Set<string>();
    while (id && !before.blocks[id] && !seen.has(id)) { seen.add(id); id = after.blocks[id]?.parentId; }
    if (id) ids.add(id);
  };
  // 位置と畳みだけの変更 (重なりの解消や整列で押された兄弟。split で親が大きくなると起きる) は、
  // 誰かが受け持っているボックスなら従来どおり侵害に数え、誰も受け持っていないボックスなら数えない
  // (受け持ち制御が reject の計画で、誰のものでもない隣のボックスが押されただけで保存できない、を避ける)
  const content = (x: Project["blocks"][string] | undefined) => x && (({ position: _p, collapsed: _c, ...rest }) => rest)(x);
  const held = (id: string) => Object.entries(before.claims ?? {}).some(([root, c]) => !c.releasedAt && covers(before, root, c, id));
  for (const id of new Set([...Object.keys(before.blocks),...Object.keys(after.blocks)])) {
    const a=before.blocks[id], b=after.blocks[id];
    if (same(a,b)) continue;
    if (same(content(a),content(b))) { if (!held(id)) continue; layoutOnly.add(id); }
    owner(id);
    if (!a || !b || a.parentId !== b.parentId) { owner(a?.parentId); owner(b?.parentId); }
  }
  const portOwners=(p:Project,id:string,seen=new Set<string>()):Set<string>=>{
    const port=p.ports[id]; if(!port)return new Set();
    if(!port.promotedFrom || seen.has(id))return new Set([port.blockId]);
    const next=new Set(seen).add(id);
    const children=Object.values(p.edges).filter(e=>e.auto&&e.from.portId===id&&e.from.side==="inner");
    if(children.length)return new Set(children.flatMap(e=>[...portOwners(p,e.to.portId,next)]));
    return p.ports[port.promotedFrom] ? portOwners(p,port.promotedFrom,next):new Set([port.blockId]);
  };
  const portOwner=(p:Project,id:string)=>{for(const block of portOwners(p,id))owner(block);};
  for (const id of new Set([...Object.keys(before.ports),...Object.keys(after.ports)])) {
    const a=before.ports[id],b=after.ports[id];
    if (!same(a,b)) { if(a)portOwner(before,id); if(b)portOwner(after,id); }
  }
  for (const id of new Set([...Object.keys(before.edges),...Object.keys(after.edges)])) {
    const a=before.edges[id],b=after.edges[id];
    if (same(a,b)) continue;
    for (const [p,e] of [[before,a],[after,b]] as const) if (e) {
      // 既存の共有入力から子への自動枝を足すだけなら、その子が変更範囲。共有元全員の取得は要求しない。
      if(!(e.auto&&e.kind==="down"&&p.ports[e.from.portId]?.promotedFrom))portOwner(p,e.from.portId);
      portOwner(p,e.to.portId);
    }
  }
  for (const id of new Set([...Object.keys(before.handoffs??{}),...Object.keys(after.handoffs??{})])) if (!same(before.handoffs?.[id],after.handoffs?.[id])) owner(id);
  const excluded=new Set(["blocks","ports","edges","handoffs","claims","claimPolicy","log","agents","nextKey","updatedAt","version"]);
  for (const k of new Set([...Object.keys(before),...Object.keys(after)])) if (!excluded.has(k) && !same((before as unknown as Record<string,unknown>)[k],(after as unknown as Record<string,unknown>)[k])) ids.add("root");
  return { ids, layoutOnly };
}

/** 入力: 検査対象の範囲と取得済みの受け持ち。出力: 使用した根と警告。拒否時は例外で保存を止める。 */
export function checkClaimWrite(p: Project, ids: Set<string>, who: ClaimIdentity, now: number): { used: Set<string>; warnings: string[] } {
  const used=new Set<string>(),warnings:string[]=[];
  if (!claimsEnabled(p)) return {used,warnings};
  for (const token of who.tokens) {
    let value:unknown; try { value=JSON.parse(token); } catch { /* 下で拒否 */ }
    if(!Array.isArray(value) || value.length!==3 || typeof value[0]!=="string" || !Number.isSafeInteger(value[1]) || typeof value[2]!=="string") throw new Error(t("受け持ちの確認情報が正しくありません。"));
  }
  for (const id of ids) {
    const relevant=Object.entries(p.claims??{}).filter(([root,c]) => covers(p,root,c,id));
    const own=relevant.filter(([,c]) => owns(c,who));
    // 自分の古い受領証がある場合は、他者への移譲をwarnで通さない。
    for (const token of who.tokens) {
      let parts: unknown; try { parts=JSON.parse(token); } catch { throw new Error(t("受け持ちの確認情報が正しくありません。")); }
      if (Array.isArray(parts) && typeof parts[0]==="string") {
        const c=p.claims?.[parts[0]];
        if (c && covers(p,parts[0],c,id) && (token!==claimToken(parts[0],c) || !owns(c,who))) throw new Error(t("受け持ちが期限切れ・解除済みか、実行IDまたは世代が違います。取り直してから作業してください。"));
      }
    }
    const holder=own.find(([root,c]) => who.tokens.includes(claimToken(root,c)) && activeClaim(c,now));
    if (holder) { requireClaim(holder[0],holder[1],who,now);used.add(holder[0]); }
    else if (own.length) requireClaim(own[0][0],own[0][1],who,now);
    const foreign=relevant.find(([,c])=>activeClaim(c,now)&&!owns(c,who));
    if (!holder || foreign) {
      const message=foreign ? foreignClaimMessage(p,foreign[0],foreign[1],who) : t("受け持ちの範囲外です: {block}。必要な範囲を取得してください。",{block:p.blocks[id]?.key??id});
      if (p.claimPolicy!.mode==="reject") throw new Error(message);
      warnings.push(message);
    }
  }
  return {used,warnings};
}

/** 延長は同じ世代とID。期限切れは再取得が必要なのでここで復活させない。 */
export function renewClaims(p: Project, roots: Iterable<string>, who: ClaimIdentity, now: number): Project {
  const claims={...p.claims};
  for (const id of roots) {
    const c=requireClaim(id,claims[id],who,now);
    claims[id]={...c,renewedAt:new Date(now).toISOString(),expiresAt:new Date(now+(p.claimPolicy?.leaseMinutes??30)*60000).toISOString()};
  }
  return {...p,claims};
}

/** 読むだけの一覧。更新や延長はせず、自分・他者・期限切れ・解除済みを分ける。 */
export function claimSummary(p: Project, who: Pick<ClaimIdentity,"actor"|"instanceId">, now=Date.now()) {
  type Entry=Claim & {blockId:string;key?:string;title:string};
  const groups:{mine:Entry[];others:Entry[];expired:Entry[];released:Entry[]}={mine:[],others:[],expired:[],released:[]};
  for (const [id,c] of Object.entries(p.claims??{})) {
    const item={blockId:id,key:p.blocks[id]?.key,title:p.blocks[id]?.title??id,...c};
    if(c.releasedAt) groups.released.push(item);
    else if(!activeClaim(c,now))groups.expired.push(item);
    else if(owns(c,{...who,tokens:[]}))groups.mine.push(item);
    else groups.others.push(item);
  }
  return {enabled:claimsEnabled(p),policy:p.claimPolicy??{mode:"off",leaseMinutes:30},...groups,
    limitation:t("受け持ちは同じ共有ファイル内の協調制御です。同期先の別端末や旧版の書き込みを排他しません。")};
}

/** 入力: Undo先と現在。出力: 制御記録と専用の印が付いたログだけは現在のままの計画。本文では判定しない。 */
export function preserveClaimHistory(snapshot:Project,current:Project):Project {
  const log=[...snapshot.log], ids=new Set(log.map(e=>e.id));
  for(const entry of current.log) {
    const control=entry.claimEvent === "policy" || entry.claimEvent === "release";
    if(control&&!ids.has(entry.id)){log.push(entry);ids.add(entry.id);}
  }
  log.sort((a,b)=>a.at.localeCompare(b.at));
  return {...snapshot,claims:current.claims,claimPolicy:current.claimPolicy,log};
}
/** 入力: 外部更新の前後。出力: claims以外が同じか。通常の編集通知を抑制しないため設定やログは除外しない。 */
export function onlyClaimsChanged(before:Project|null,after:Project):boolean {
  if(!before)return false;
  const keys=new Set([...Object.keys(before),...Object.keys(after)]);
  return [...keys].every(key=>key==="claims" || same((before as unknown as Record<string,unknown>)[key],(after as unknown as Record<string,unknown>)[key]));
}

/** 受け持ちの一覧の 1 行 */
export type ClaimRow = { rootId: string; key: string; title: string; actor: string; instanceId: string; subtree: boolean; active: boolean; minutesLeft: number; note: string };

/**
 * 受け持ちの一覧を作る (Activity の Claims タブ)
 * Input : project = 計画, now = 今の時刻 (ミリ秒。受け持ちの共通の時計)
 * Output: 解除されていない受け持ちの行の配列。受け持ちを使わない計画では空。
 *         並びは「有効なもの (期限の近い順)」→「期限切れ」。期限切れも残すのは、止まった AI の受け持ちに人が気づけるようにするため
 */
export function claimListOf(project: Project, now: number): ClaimRow[] {
  if (!claimsEnabled(project)) return [];
  const rows: ClaimRow[] = [];
  for (const [rootId, c] of Object.entries(project.claims ?? {})) {
    if (c.releasedAt) continue; // 解除済みは出さない (記録はログにある)
    const b = project.blocks[rootId];
    if (!b) continue; // 消えたボックスの受け持ちは出さない
    const active = activeClaim(c, now);
    rows.push({
      rootId
    , key: b.key ?? ""
    , title: b.title
    , actor: c.actor
    , instanceId: c.instanceId ?? ""
    , subtree: c.scope === "subtree"
    , active
      // 残り時間は切り上げ (残り 30 秒を「0 分」と出さない)
    , minutesLeft: Math.max(0, Math.ceil((Date.parse(c.expiresAt) - now) / 60000))
      // 何をしているか: そのボックスの活動のメモ (受け持ちと同じ AI のものだけ)
    , note: b.activity && b.activity.actor === c.actor ? b.activity.note ?? "" : ""
    });
  }
  return rows.sort((x, y) => Number(y.active) - Number(x.active) || x.minutesLeft - y.minutesLeft);
}

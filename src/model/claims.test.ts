import { describe, it, expect } from "vitest";
import { createProject, addBlock, addPort, toJSON, fromJSON } from "./graph";
import { preserveClaimHistory, acquireClaim, claimToken, checkClaimWrite, claimFootprint, releaseClaim, renewClaims, validateClaims, claimSummary, claimListOf, type ClaimIdentity } from "./claims";
import { mergeProjects } from "./merge";
const now=Date.parse("2026-10-08T01:00:00Z");
function fixture() {
  let p=createProject("claims");
  for(const [id,parentId] of [["a","root"],["b","root"],["child","a"]]){const r=addBlock(p,{parentId,title:id,outputName:"out"});p=r.project;p.blocks[id]={...p.blocks[r.blockId],id};delete p.blocks[r.blockId];for(const port of Object.values(p.ports))if(port.blockId===r.blockId)port.blockId=id;}
  p.claimPolicy={mode:"reject",leaseMinutes:30};return p;
}
const who=(instanceId="one"):ClaimIdentity=>({actor:"codex",instanceId,tokens:[]});
function held(scope:"block"|"subtree"="block") {const identity=who();const p=acquireClaim(fixture(),"a",scope,identity,now,"first");identity.tokens=[claimToken("a",p.claims!.a)];return {p,identity};}
describe("受け持ちの世代と範囲",()=>{
  it("同名の別実行は取得できず別ボックスなら取得できる",()=>{const {p}=held();expect(()=>acquireClaim(p,"a","block",who("two"),now,"second")).toThrow();expect(acquireClaim(p,"b","block",who("two"),now,"second").claims!.b.instanceId).toBe("two");});
  it("subtreeは子と重複し、blockは子を含まない",()=>{const {p,identity}=held("subtree");expect(()=>acquireClaim(p,"child","block",who("two"),now,"second")).toThrow();expect(checkClaimWrite(p,new Set(["child"]),identity,now).used.has("a")).toBe(true);const b=held();expect(()=>checkClaimWrite(b.p,new Set(["child"]),b.identity,now)).toThrow();});
  it("子が受け持たれている親のsubtree取得も拒否",()=>{const p=acquireClaim(fixture(),"child","block",who(),now,"first");expect(()=>acquireClaim(p,"a","subtree",who("two"),now,"second")).toThrow();});
  it("期限境界で無効になり再取得は世代を進める",()=>{const {p,identity}=held();const expired=now+30*60000;expect(()=>renewClaims(p,["a"],identity,expired)).toThrow();const q=acquireClaim(p,"a","block",who("two"),expired,"second");expect(q.claims!.a.generation).toBe(2);expect(()=>checkClaimWrite(q,new Set(["a"]),identity,expired)).toThrow();});
  it("理由付き解除と再取得で古い処理を復活させない",()=>{const {p,identity}=held();expect(()=>releaseClaim(p,"a"," ",now)).toThrow();const released=releaseClaim(p,"a","stopped",now+1);expect(released.claims!.a.generation).toBe(2);expect(()=>checkClaimWrite(released,new Set(["a"]),identity,now+2)).toThrow();const q=acquireClaim(released,"a","block",who(),now+2,"next");expect(q.claims!.a.generation).toBe(3);expect(()=>checkClaimWrite(q,new Set(["a"]),identity,now+3)).toThrow();});
  it("延長は世代と受領証を維持し時計逆行を拒否",()=>{const {p,identity}=held();const q=renewClaims(p,["a"],identity,now+300000);expect(claimToken("a",q.claims!.a)).toBe(identity.tokens[0]);expect(Date.parse(q.claims!.a.expiresAt)).toBe(now+35*60000);expect(()=>renewClaims(q,["a"],identity,now)).toThrow();});
  it("警告モードでも期限切れと古い受領証は拒否",()=>{const {p,identity}=held();p.claimPolicy!.mode="warn";expect(checkClaimWrite(p,new Set(["b"]),identity,now).warnings).toHaveLength(1);expect(()=>checkClaimWrite(p,new Set(["a"]),identity,now+31*60000)).toThrow();expect(()=>checkClaimWrite(releaseClaim(p,"a","stop",now),new Set(["a"]),identity,now)).toThrow();});
  it("配線の両端と移動元・先、削除される子孫を検査",()=>{const {p}=held();const a=Object.values(p.ports).find(x=>x.blockId==="a")!,b=Object.values(p.ports).find(x=>x.blockId==="b")!;let q=structuredClone(p);q.edges.e={id:"e",from:{portId:a.id,side:"outer"},to:{portId:b.id,side:"outer"},auto:false,kind:"sibling"};expect([...claimFootprint(p,q)].sort()).toEqual(["a","b"]);q=structuredClone(p);q.blocks.child.parentId="b";expect([...claimFootprint(p,q)].sort()).toEqual(["a","b","child"]);q=structuredClone(p);delete q.blocks.a;delete q.blocks.child;expect(claimFootprint(p,q)).toEqual(new Set(["a","child","root"]));});
  it("一覧は読むだけで自分・他者・期限切れを分ける",()=>{const {p,identity}=held();const q=acquireClaim(p,"b","block",who("two"),now-31*60000,"expired");const before=toJSON(q);const summary=claimSummary(q,identity,now);expect(summary.mine).toHaveLength(1);expect(summary.expired).toHaveLength(1);expect(toJSON(q)).toBe(before);expect(claimSummary(q,who("two"),now).others).toHaveLength(1);});
  it("旧計画には項目を足さず壊れた制御は読み込みで拒否",()=>{const p=createProject("legacy");expect(fromJSON(toJSON(p)).claims).toBeUndefined();expect(fromJSON(toJSON(p)).claimPolicy).toBeUndefined();for(const claimPolicy of [null,{mode:"oops",leaseMinutes:30},{mode:"reject",leaseMinutes:0}])expect(()=>fromJSON(JSON.stringify({...p,claimPolicy}))).toThrow();const h=held().p;expect(()=>validateClaims({...h,claims:{a:{...h.claims!.a,actor:42 as unknown as string}}})).toThrow();});
  it("マージは担当名と世代を混ぜず受け持ち全体で競合",()=>{const {p}=held();const ours=structuredClone(p),theirs=structuredClone(p);ours.claims!.a.generation=2;theirs.claims!.a.actor="claude-code";const r=mergeProjects(p,ours,theirs);expect(r.conflicts.some(c=>c.path==="claims.a")).toBe(true);expect(r.project.claims!.a).toEqual(ours.claims!.a);});
});

it("世代が安全な整数を超えると記録を壊さず拒否",()=>{const {p}=held();p.claims!.a.generation=Number.MAX_SAFE_INTEGER;expect(()=>releaseClaim(p,"a","stop",now)).toThrow();expect(()=>acquireClaim(p,"a","block",who("two"),now+31*60000,"next")).toThrow();expect(p.claims!.a.generation).toBe(Number.MAX_SAFE_INTEGER);});

it("C2 H-2: 共有の自動入力の枝追加は子だけ、共有入力自体の変更は両方の子を検査",()=>{
 let before=fixture();before=addPort(before,{blockId:"a",direction:"in",name:"shared"}).project;
 const after=addPort(before,{blockId:"b",direction:"in",name:"shared"}).project;
 expect(claimFootprint(before,after)).toEqual(new Set(["b"]));
 const changed=structuredClone(after),shared=Object.values(changed.ports).find(p=>p.blockId==="root"&&p.promotedFrom&&p.name==="shared")!;
 shared.description="changed";expect(claimFootprint(after,changed)).toEqual(new Set(["a","b"]));
});
it("C2 L-1: 受け持ちログだけUndo先へ持ち越し、重複させない",()=>{
 const p=fixture(),nowText=new Date(now).toISOString();
 const q={...p,log:[...p.log,{id:"policy",at:nowText,actor:"human",kind:"note" as const,claimEvent:"policy" as const,message:"control"},{id:"release-old",at:nowText,actor:"human",kind:"note" as const,message:"Claim released: stop"},{id:"ordinary",at:nowText,actor:"human",kind:"note" as const,message:"normal"}]};
 const kept=preserveClaimHistory(p,q);expect(kept.log.some(e=>e.id==="policy")).toBe(true);expect(kept.log.some(e=>e.id==="release-old")).toBe(false);expect(kept.log.some(e=>e.id==="ordinary")).toBe(false);expect(preserveClaimHistory(kept,q).log).toEqual(kept.log);
});

// Activity の Claims タブに出す一覧 (claimListOf) の確認
describe("受け持ちの一覧 (画面の Claims タブ)",()=>{
  it("受け持ちを使わない計画では空",()=>{
    // 受け持ちがあっても、制御が無効なら一覧に出さない (タブ自体を出さないため)
    const {p}=held();
    expect(claimListOf({...p,claimPolicy:{mode:"off",leaseMinutes:30}},now)).toEqual([]);
  });
  it("有効なものを期限の近い順に並べ、期限切れは後ろに残し、解除済みは出さない",()=>{
    // a: 0 分前に取得 (残り 30 分)、b: 20 分前に取得 (残り 10 分)、child: 40 分前に取得 (期限切れ)
    let p=acquireClaim(fixture(),"a","block",who("one"),now,"c1");
    p=acquireClaim(p,"b","block",who("two"),now-20*60000,"c2");
    p=acquireClaim(p,"child","block",who("three"),now-40*60000,"c3");
    const rows=claimListOf(p,now);
    expect(rows.map(r=>[r.rootId,r.active,r.minutesLeft,r.instanceId])).toEqual([["b",true,10,"two"],["a",true,30,"one"],["child",false,0,"three"]]);
    // 解除すると一覧から消える
    expect(claimListOf(releaseClaim(p,"b","done",now),now).map(r=>r.rootId)).toEqual(["a","child"]);
  });
  it("残り時間は切り上げ、配下を含む受け持ちはそう示す",()=>{
    // 残り 29 分 30 秒 → 30 分 (「0 分」や 1 分少ない表示にしない)
    const p=acquireClaim(fixture(),"a","subtree",who(),now-30000,"c1");
    const [row]=claimListOf(p,now);
    expect(row.minutesLeft).toBe(30);
    expect(row.subtree).toBe(true);
  });
});

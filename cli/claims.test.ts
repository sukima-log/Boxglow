import { beforeAll,afterAll,it,expect,vi } from "vitest";
import { build } from "esbuild";
import { mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync } from "node:fs";
import { join,resolve } from "node:path";
import { spawn,spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createProject,addBlock,defaultTaskParent,toJSON,resolveAllOverlaps,normalizeCollapsed } from "../src/model/graph";
import { blockSize } from "../src/model/size";
import { prepareClaimSave, type ClaimCommand } from "./claims";
vi.setConfig({testTimeout:30000});
let dir:string,entry:string,serial=0;
beforeAll(async()=>{const cache=resolve("node_modules/.cache");mkdirSync(cache,{recursive:true});dir=mkdtempSync(join(cache,"claims-"));entry=join(dir,"cli.mjs");await build({entryPoints:["cli/main.ts"],bundle:true,loader:{".md":"text"},platform:"node",format:"esm",external:["@modelcontextprotocol/sdk","zod"],outfile:entry});});
afterAll(()=>{if(dir)rmSync(dir,{recursive:true,force:true});});
function fixture(enabled=true){let p=createProject("test");p.lang="en";for(const title of ["alpha","beta"])p=addBlock(p,{parentId:defaultTaskParent(p),title,outputName:"result"}).project;p=resolveAllOverlaps(normalizeCollapsed(p),(q,id)=>blockSize(q,id));if(enabled)p.claimPolicy={mode:"reject",leaseMinutes:30};const file=join(dir,`plan-${serial++}.json`);writeFileSync(file,toJSON(p));
 const args=(more:string[])=>[entry,...more,"--file",file];
 const cli=(...more:string[])=>spawnSync(process.execPath,args(more),{encoding:"utf8"});
 const parallel=(...more:string[])=>new Promise<{code:number|null;stdout:string;stderr:string}>(res=>{const child=spawn(process.execPath,args(more));let stdout="",stderr="";child.stdout.on("data",d=>stdout+=d);child.stderr.on("data",d=>stderr+=d);child.on("exit",code=>res({code,stdout,stderr}));});
 const read=()=>JSON.parse(readFileSync(file,"utf8"));return {p,file,cli,parallel,read};}
const actor=["--actor","codex","--instance","one"];
const receipt=(stdout:string)=>JSON.parse(stdout.split("\n").find(l=>l.startsWith("CLAIM "))!.slice(6));
it("同じファイルで同じボックスを同時取得できるのは1実行だけ",async()=>{const f=fixture();const r=await Promise.all([f.parallel("start","alpha",...actor),f.parallel("start","alpha","--actor","codex","--instance","two")]);expect(r.map(x=>x.code).sort()).toEqual([0,1]);expect(Object.values(f.read().claims)).toHaveLength(1);});
it("別のボックスは同時に取得できる",async()=>{const f=fixture();const r=await Promise.all([f.parallel("start","alpha",...actor),f.parallel("start","beta","--actor","codex","--instance","two")]);expect(r.map(x=>x.code),JSON.stringify(r)).toEqual([0,0]);expect(Object.values(f.read().claims)).toHaveLength(2);});
it("未取得・範囲外を拒否、checkpointで延長、doneで解放",()=>{const f=fixture();const before=readFileSync(f.file,"utf8");expect(f.cli("set","alpha","--note","no",...actor).status).toBe(1);expect(readFileSync(f.file,"utf8")).toBe(before);const start=f.cli("start","alpha",...actor);expect(start.status,start.stderr).toBe(0);const r=receipt(start.stdout),proof=[...actor,"--claim-token",r.token];expect(f.cli("set","beta","--note","outside",...proof).status).toBe(1);expect(f.cli("checkpoint","alpha","--note","found",...proof).status).toBe(0);expect(f.read().claims[r.blockId].generation).toBe(1);expect(f.cli("done","alpha",...proof).status).toBe(0);expect(f.read().claims[r.blockId].releasedAt).toBeTruthy();expect(f.cli("set","alpha","--note","late",...proof).status).toBe(1);});
it("人の解除は理由必須・記録され、旧処理はwarnでも拒否",()=>{const f=fixture();const r=receipt(f.cli("start","alpha",...actor).stdout);const before=readFileSync(f.file,"utf8");expect(f.cli("claim-release","alpha","--actor","human").status).toBe(1);expect(f.cli("claim-release","alpha","--reason","stop",...actor).status).toBe(1);expect(readFileSync(f.file,"utf8")).toBe(before);expect(f.cli("claim-release","alpha","--reason","stop","--actor","human").status).toBe(0);expect(f.read().log.at(-1).message).toContain("stop");expect(f.cli("claim-policy","--mode","warn","--actor","human").status).toBe(0);expect(f.cli("done","alpha",...actor,"--claim-token",r.token).status).toBe(1);});
it("古い計画の操作は維持、設定は明示の人だけ、無効化でも古い世代は戻らない",()=>{const f=fixture(false);expect(f.cli("start","alpha","--actor","codex").status).toBe(0);expect(f.read().claimPolicy).toBeUndefined();expect(f.cli("claim-policy","--mode","reject",...actor).status).toBe(1);expect(f.cli("claim-policy","--mode","reject","--actor","human").status).toBe(0);const r=receipt(f.cli("start","alpha",...actor).stdout);expect(f.cli("claim-policy","--mode","off","--actor","human").status).toBe(0);expect(f.cli("claim-policy","--mode","reject","--actor","human").status).toBe(0);expect(f.cli("set","alpha","--note","old",...actor,"--claim-token",r.token).status).toBe(1);});
it("保存直前の期限切れと時計逆行を拒否し期限内の異常終了は奪わない",()=>{const f=fixture();const r=receipt(f.cli("start","alpha",...actor).stdout);const current=readFileSync(f.file,"utf8"),p=f.read();p.blocks[r.blockId].description="late";const req:ClaimCommand={command:"set",target:"alpha",human:false,identity:{actor:"codex",instanceId:"one",tokens:[r.token]}};expect(()=>prepareClaimSave(current,toJSON(p),req,()=>{},Date.parse(p.claims[r.blockId].expiresAt))).toThrow();expect(()=>prepareClaimSave(current,toJSON(p),req,()=>{},Date.parse(p.claims[r.blockId].renewedAt)-1)).toThrow();expect(f.cli("start","alpha","--actor","codex","--instance","replacement").status).toBe(1);expect(readFileSync(f.file,"utf8")).toBe(current);});
it("MCP実行は固有IDと受領証を保持し別接続・偽装を拒否",async()=>{const f=fixture();const transports:StdioClientTransport[]=[],clients:Client[]=[];try{for(let i=0;i<2;i++){const transport=new StdioClientTransport({command:process.execPath,args:[entry,"mcp","--file",f.file,"--actor","codex"],stderr:"pipe"});const client=new Client({name:`claims-${i}`,version:"1"});await client.connect(transport);transports.push(transport);clients.push(client);}const start=await clients[0].callTool({name:"boxglow_start",arguments:{block:"alpha"}});expect(start.isError,JSON.stringify(start)).not.toBe(true);const other=await clients[1].callTool({name:"boxglow_start",arguments:{block:"alpha"}});expect(other.isError).toBe(true);expect((await clients[0].callTool({name:"boxglow_set",arguments:{block:"alpha",note:"own"}})).isError).not.toBe(true);expect((await clients[0].callTool({name:"boxglow_run",arguments:{args:["set","beta","--note","x","--actor","human"]}})).isError).toBe(true);expect((await clients[0].callTool({name:"boxglow_claim_renew",arguments:{block:"alpha"}})).isError).not.toBe(true);expect((await clients[0].callTool({name:"boxglow_done",arguments:{block:"alpha"}})).isError).not.toBe(true);}finally{for(const client of clients)await client.close();for(const transport of transports)await transport.close();}});

it("親のsubtree受領証で子に着手し、子の完了後も親を保持する",()=>{const f=fixture();const parent=defaultTaskParent(f.p);const start=f.cli("start",parent,"--scope","subtree",...actor);expect(start.status,start.stderr).toBe(0);const r=receipt(start.stdout);const proof=[...actor,"--claim-token",r.token];const child=f.cli("start","alpha",...proof);expect(child.status,child.stderr).toBe(0);expect(receipt(child.stdout).blockId).toBe(parent);expect(Object.keys(f.read().claims)).toHaveLength(1);expect(f.cli("done","alpha",...proof).status).toBe(0);expect(f.read().claims[parent].releasedAt).toBeUndefined();expect(f.cli("leave",parent,...proof).status).toBe(0);expect(f.read().claims[parent].releasedAt).toBeTruthy();});
it("同じ値の保存でも世代を照合し、他実行の受領証は利用できない",()=>{const f=fixture();const r=receipt(f.cli("start","alpha",...actor).stdout);expect(f.cli("claim-policy","--mode","warn","--actor","human").status).toBe(0);expect(f.cli("set","alpha","--title","alpha","--actor","codex","--instance","two","--claim-token",r.token).status).toBe(1);expect(f.cli("claim-release","alpha","--reason","stop","--actor","human").status).toBe(0);const before=readFileSync(f.file,"utf8");expect(f.cli("set","alpha","--title","alpha",...actor,"--claim-token",r.token).status).toBe(1);expect(readFileSync(f.file,"utf8")).toBe(before);});
it("全体の初期化で受け持ち制御を消せない",()=>{const f=fixture();const r=receipt(f.cli("start","alpha",...actor).stdout);const before=readFileSync(f.file,"utf8");expect(f.cli("init","--force",...actor,"--claim-token",r.token).status).toBe(1);expect(readFileSync(f.file,"utf8")).toBe(before);});

it("書き出しの上書きで制御を迂回せず別ファイルへの出力は保つ",()=>{const f=fixture();const before=readFileSync(f.file,"utf8");expect(f.cli("export","--out",f.file,...actor).status).toBe(1);expect(readFileSync(f.file,"utf8")).toBe(before);const copy=join(dir,"export-copy.json");expect(f.cli("export","--format","json","--out",copy,...actor).status).toBe(0);expect(JSON.parse(readFileSync(copy,"utf8")).claimPolicy.mode).toBe("reject");});

it("MCPを強制終了しても期限内は取得できず、期限後の再取得で古い完了を拒否",async()=>{
  const f=fixture();
  const transport=new StdioClientTransport({command:process.execPath,args:[entry,"mcp","--file",f.file,"--actor","codex"],stderr:"pipe"});
  const client=new Client({name:"claim-crash",version:"1"});
  try {
    await client.connect(transport);
    const started=await client.callTool({name:"boxglow_start",arguments:{block:"alpha"}});expect(started.isError).not.toBe(true);
    const p=f.read(),id=Object.keys(p.claims)[0],old=p.claims[id],oldToken=JSON.stringify([id,old.generation,old.claimId]);
    const pid=transport.pid;expect(pid).toBeTypeOf("number");
    // この試験で生成した子プロセスだけを停止する。開発サーバーには触れない。
    process.kill(pid!,"SIGKILL");await new Promise(r=>setTimeout(r,80));
    expect(f.cli("start","alpha",...actor).status).toBe(1);
    const expired=f.read(),past=new Date(Date.now()-3600000).toISOString();
    expired.claims[id]={...old,acquiredAt:past,renewedAt:past,expiresAt:new Date(Date.now()-1).toISOString()};writeFileSync(f.file,toJSON(expired));
    const next=f.cli("start","alpha",...actor);expect(next.status,next.stderr).toBe(0);expect(f.read().claims[id].generation).toBe(old.generation+1);
    const before=readFileSync(f.file,"utf8");
    expect(f.cli("done","alpha","--actor",old.actor,"--instance",old.instanceId,"--claim-token",oldToken).status).toBe(1);
    expect(readFileSync(f.file,"utf8")).toBe(before);
  }finally{await client.close();await transport.close();}
});

it("C2 H-1: Git形式の統合はclaim有効でも保存済みの変更を取り込む",()=>{
 const f=fixture();const started=f.cli("start","alpha",...actor);const hold=receipt(started.stdout);
 const base=f.read(),ours=structuredClone(base),theirs=structuredClone(base);
 theirs.blocks[hold.blockId].title="remote title";theirs.claims[hold.blockId].renewedAt=new Date(Date.parse(theirs.claims[hold.blockId].renewedAt)+1000).toISOString();
 const files=["base","ours","theirs"].map(name=>join(dir,`${serial++}-${name}.json`));
 [base,ours,theirs].forEach((p,i)=>writeFileSync(files[i],toJSON(p)));
 const merged=f.cli("merge",...files);expect(merged.status,merged.stderr).toBe(0);
 const saved=JSON.parse(readFileSync(files[1],"utf8"));expect(saved.blocks[hold.blockId].title).toBe("remote title");expect(saved.claims[hold.blockId]).toEqual(theirs.claims[hold.blockId]);
 ours.claims[hold.blockId]={...ours.claims[hold.blockId],generation:2,claimId:"ours-next"};theirs.claims[hold.blockId]={...theirs.claims[hold.blockId],actor:"claude-code",claimId:"theirs-next"};
 [base,ours,theirs].forEach((p,i)=>writeFileSync(files[i],toJSON(p)));
 const conflict=f.cli("merge",...files,"--strict");expect(conflict.status).toBe(1);
 const selected=JSON.parse(readFileSync(files[1],"utf8"));expect(selected.claims[hold.blockId]).toEqual(ours.claims[hold.blockId]);expect(selected.log.at(-1).message).toContain("claims.");
});
it("C2 H-2: ボックスの取得で入力を追加、subtreeで入力付きの子を追加できる",()=>{
 const f=fixture();const betaBox=Object.values(f.p.blocks).find(b=>b.title==="beta")!;betaBox.position.y=10000;writeFileSync(f.file,toJSON(f.p));
 let hold=receipt(f.cli("start","alpha",...actor).stdout);
 let proof=[...actor,"--claim-token",hold.token];const added=f.cli("port","alpha","--in","new-input",...proof);expect(added.status,added.stderr).toBe(0);
 expect(Object.values(f.read().ports).filter((p:any)=>p.name==="new-input")).toHaveLength(3);
 const beta=f.cli("port","beta","--in","foreign",...proof);expect(beta.status).toBe(1);
 hold=receipt(f.cli("start","alpha","--scope","subtree",...proof).stdout);proof=[...actor,"--claim-token",hold.token];
 const child=f.cli("add","child","--parent","alpha","--in","child-input",...proof);expect(child.status,child.stderr).toBe(0);
 expect(Object.values(f.read().ports).some((p:any)=>p.blockId==="root"&&p.name==="child-input")).toBe(true);
});
it("C2 H-2: rootを取得してfocusとgroupを更新、通常のボックスは範囲外",()=>{
 const f=fixture();f.p.contextGuard=true;writeFileSync(f.file,toJSON(f.p));const ctx=f.cli("context","root",...actor);expect(ctx.status,ctx.stderr).toBe(0);
 const started=f.cli("start","root",...actor,"--context-token",JSON.parse(ctx.stdout).contextToken);expect(started.status,started.stderr).toBe(0);const hold=receipt(started.stdout);expect(hold.blockId).toBe("root");
 const proof=[...actor,"--claim-token",hold.token];
 for(const args of [["focus","alpha"],["group","材料"]]){const token=JSON.parse(f.cli("context","root",...actor).stdout).contextToken;const result=f.cli(...args,...proof,"--context-token",token);expect(result.status,result.stderr).toBe(0);}
 const betaContext=JSON.parse(f.cli("context","beta",...actor).stdout).contextToken;
 const outside=f.cli("set","beta","--note","outside",...proof,"--context-token",betaContext);expect(outside.status).toBe(1);expect(outside.stderr).toContain("Outside your claim");
 expect(f.cli("claim-renew","root",...proof).status).toBe(0);const token=JSON.parse(f.cli("context","root",...actor).stdout).contextToken;expect(f.cli("leave","root",...proof,"--context-token",token).status).toBe(0);expect(f.read().claims.root.releasedAt).toBeTruthy();
});
it("C2 M-1/M-2: 有効な他者の取得を期限切れと案内せず、同名の別実行を示す",()=>{
 const f=fixture();const parent=defaultTaskParent(f.p),started=f.cli("start",parent,"--scope","subtree",...actor);expect(started.status,started.stderr).toBe(0);
 for(const target of [parent,"alpha"]){const result=f.cli("start",target,"--actor","codex","--instance","restarted");expect(result.status).toBe(1);expect(result.stderr).toContain("different instance of the same actor");expect(result.stderr).toContain("scope: subtree");expect(result.stderr).toContain("expires:");expect(result.stderr).toContain("Ask a person");expect(result.stderr).not.toContain("Acquire it again before working");}
});
it("C2 M-4: 無効な計画のJSONは従来形式、有効でもstatusはProjectのみ",()=>{
 const f=fixture(false);
 for(const args of [["status","--json"],["resume","--json"],["context","alpha"]])expect(JSON.parse(f.cli(...args).stdout).claimSummary).toBeUndefined();
 expect(f.cli("claim-policy","--mode","reject","--actor","human").status).toBe(0);
 expect(JSON.parse(f.cli("status","--json").stdout).claimSummary).toBeUndefined();
 expect(JSON.parse(f.cli("resume","--json").stdout).claimSummary.enabled).toBe(true);
 expect(JSON.parse(f.cli("context","alpha").stdout).claimSummary.enabled).toBe(true);
});
it("C2 L-4: 再解除は世代・理由・ログ・ファイルを変えない",()=>{
 const f=fixture();f.cli("start","alpha",...actor);expect(f.cli("claim-release","alpha","--reason","stop","--actor","human").status).toBe(0);
 const before=readFileSync(f.file,"utf8");const again=f.cli("claim-release","alpha","--reason","again","--actor","human");expect(again.status).toBe(0);expect(again.stdout).toContain("already been released");expect(readFileSync(f.file,"utf8")).toBe(before);
});

it("C3: 全体取得だけに日英の停止案内を出し、通常取得では出さない",()=>{
 for(const lang of ["ja","en"]){
  const f=fixture();const notice=lang==="ja"?"全体を受け持ちました (他の実行は止まります)。":"You claimed the whole plan (other instances will be blocked).";
  const block=f.cli("start","root",...actor,"--lang",lang);expect(block.status,block.stderr).toBe(0);expect(block.stdout).not.toContain(notice);
  const all=f.cli("start","root","--scope","subtree",...actor,"--claim-token",receipt(block.stdout).token,"--lang",lang);
  expect(all.status,all.stderr).toBe(0);expect(all.stdout).toContain(notice);
  const other=f.cli("start","alpha","--actor","codex","--instance","two","--lang",lang);
  expect(other.status).toBe(1);expect(other.stderr).toContain(lang==="ja"?"自分の再起動前の実行とは限りません":"not necessarily your own instance");expect(other.stdout).not.toContain(notice);
 }
});

// 旧寸法で配置された隣接タスクを模す。新寸法で重なるが、内容だけの保存では動かさない。
it("overview: 旧配置の内容更新は他者の受け持ち・位置へ波及しない", () => {
  const f = fixture();
  const boxes = Object.values(f.p.blocks).filter(b => ["alpha", "beta"].includes(b.title));
  boxes[0].position = { x: 120, y: 96 };
  boxes[1].position = { x: 120, y: 288 };
  writeFileSync(f.file, toJSON(f.p));
  const positions = Object.fromEntries(Object.values(f.p.blocks).map(b => [b.id, b.position]));
  const owned = f.cli("start", "alpha", ...actor);
  expect(owned.status, owned.stderr).toBe(0);
  const foreign = f.cli("start", "beta", "--actor", "claude-code", "--instance", "other");
  expect(foreign.status, foreign.stderr).toBe(0);
  const claim = receipt(owned.stdout);
  const saved = f.cli("set", "alpha", "--title", "alpha2", ...actor, "--claim-token", claim.token);
  expect(saved.status, saved.stderr).toBe(0);
  expect(Object.fromEntries(Object.values(f.read().blocks).map((b: any) => [b.id, b.position]))).toEqual(positions);
});

it("overview: 受け持ち無効の旧配置も CLI の 1 回の保存で移動しない", () => {
  const f = fixture(false);
  const boxes = Object.values(f.p.blocks).filter(b => ["alpha", "beta"].includes(b.title));
  boxes[0].position = { x: 120, y: 96 };
  boxes[1].position = { x: 120, y: 288 };
  writeFileSync(f.file, toJSON(f.p));
  const saved = f.cli("set", "alpha", "--note", "updated", "--actor", "codex");
  expect(saved.status, saved.stderr).toBe(0);
  expect(Object.fromEntries(Object.values(f.read().blocks).map((b: any) => [b.id, b.position])))
    .toEqual(Object.fromEntries(Object.values(f.p.blocks).map(b => [b.id, b.position])));
});

it("overview: 拡大の押し出しも受け持ち判定に含み、範囲外なら保存全体を拒否する", () => {
  const f = fixture();
  const alpha = Object.values(f.p.blocks).find(b => b.title === "alpha")!;
  const beta = Object.values(f.p.blocks).find(b => b.title === "beta")!;
  alpha.position = { x: 120, y: 96 };
  beta.position = { x: 120, y: 96 + blockSize(f.p, alpha.id).height + 96 };
  writeFileSync(f.file, toJSON(f.p));
  const own = f.cli("start", "alpha", ...actor);
  expect(own.status, own.stderr).toBe(0);
  const other = f.cli("start", "beta", "--actor", "claude-code", "--instance", "other");
  expect(other.status, other.stderr).toBe(0);
  const before = readFileSync(f.file, "utf8");
  const changed = f.cli("set", "alpha", "--title", "long title ".repeat(16), ...actor, "--claim-token", receipt(own.stdout).token);
  expect(changed.status).toBe(1);
  expect(changed.stderr).toContain("Another instance holds this claim:");
  expect(changed.stderr).toContain("(claude-code)");
  expect(readFileSync(f.file, "utf8")).toBe(before);
});

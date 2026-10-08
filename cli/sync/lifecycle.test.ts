/** 段階E: 確認前は通信を読むだけ、確定先固定、資格情報変更・二重クリックを検査。 */
import {beforeEach,afterEach,expect,it,vi} from "vitest";
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {listTrash,previewLifecycle,commitLifecycle,runLifecycle} from "./lifecycle";
import {SyncHost,parseHostAction} from "./host";
import {createProject,toJSON} from "../../src/model/graph";
let root:string,file:string;const env={...process.env};const server="http://localhost:9188";
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"lifecycle-"));file=join(root,"plan.json");writeFileSync(file,toJSON(createProject("手元")));process.env.BOXGLOW_CONFIG_DIR=join(root,"config");process.env.BOXGLOW_TOKEN="a";});
afterEach(()=>{process.env= {...env};rmSync(root,{recursive:true,force:true});});
function fake() {
 let deleted=false;const writes:RequestInit[]=[];
 const fetcher=vi.fn<typeof fetch>(async(input,init)=>{
  const url=String(input);const headers={"x-boxglow-account":"a","x-boxglow-epoch":"e1",etag:'"e1.1"'};
  let value:unknown={name:"サーバー計画"};
  if(init?.method === "DELETE") {writes.push(init);deleted=true;value={kind:"deleted",expiresAt:"2026-11-07T00:00:00.000Z"};}
  if(init?.method === "POST") {writes.push(init);value={kind:"restored",projectId:JSON.parse(String(init.body)).targetId};}
  if(url.includes("/v1/trash")) value={projects:deleted ? [{id:"p",name:"サーバー計画",revision:"e1.1",deletedAt:"2026-10-08T00:00:00Z",expiresAt:"2026-11-07T00:00:00Z",restoredId:null,restorable:true}] : [],nextCursor:null};
  return new Response(JSON.stringify(value),{headers});
 });return {fetch:fetcher,writes};
}
it("CLIの確認表示は書かず、人の明示と同じ控えでのみ確定・再送する",async()=>{
 const f=fake(),o={server,fetch:f.fetch,command:"delete",id:"p"};const lines:string[]=[];
 expect(await runLifecycle(o,l=>lines.push(l))).toBe(0);expect(f.writes).toHaveLength(0);
 const confirm=lines.find(l=>l.startsWith("CONFIRM "))!.slice(8);
 expect(await runLifecycle({...o,confirm,actor:"codex"},()=>{})).toBe(1);expect(f.writes).toHaveLength(0);
 expect(await runLifecycle({...o,confirm,actor:"human"},()=>{})).toBe(0);
 expect(await runLifecycle({...o,confirm,actor:"human"},()=>{})).toBe(0);
 expect(f.writes[0].headers).toEqual(f.writes[1].headers);
 expect(await runLifecycle({...o,id:"other",confirm,actor:"human"},()=>{})).toBe(1);expect(f.writes).toHaveLength(2);
});
it("認証の切り替え・送り先の切り替え後は確定しない",async()=>{
 const f=fake(),o={server,fetch:f.fetch};const p=await previewLifecycle(o,"delete","p");process.env.BOXGLOW_TOKEN="b";
 await expect(commitLifecycle(o,p)).rejects.toThrow();process.env.BOXGLOW_TOKEN="a";
 await expect(commitLifecycle({...o,server:"http://localhost:9189"},p)).rejects.toThrow();expect(f.writes).toHaveLength(0);
});
it("HTTP拒否と旧一覧は通信を増やさずエラーになる",async()=>{
 const f=fake();await expect(listTrash({server:"http://unsafe.invalid",fetch:f.fetch})).rejects.toThrow();expect(f.fetch).not.toHaveBeenCalled();
 await expect(listTrash({server,fetch:async()=>new Response("[]")})).rejects.toThrow();
});
it("ホストの取消・古い選択・二重クリック・手元ファイル不変",async()=>{
 const f=fake(),host=new SyncHost({server,fetch:f.fetch});host.openFile(file);const before=readFileSync(file,"utf8");
 let state=await host.act(file,{kind:"previewDelete",projectId:"p"});expect(state.lifecycle?.preview?.name).toBe("サーバー計画");expect(f.writes).toHaveLength(0);
 const old=state.lifecycle!.choiceId;await host.act(file,{kind:"cancelLifecycle"});await host.act(file,{kind:"confirmLifecycle",choiceId:old});expect(f.writes).toHaveLength(0);
 state=await host.act(file,{kind:"previewDelete",projectId:"p"});const action={kind:"confirmLifecycle" as const,choiceId:state.lifecycle!.choiceId};await Promise.all([host.act(file,action),host.act(file,action)]);expect(f.writes).toHaveLength(1);
 state=await host.act(file,{kind:"listTrash"});expect(state.lifecycle?.projects).toHaveLength(1);state=await host.act(file,{kind:"previewRestore",projectId:"p"});expect(state.lifecycle?.preview?.targetId).toBeTruthy();
 await host.act(file,{kind:"confirmLifecycle",choiceId:state.lifecycle!.choiceId});expect(f.writes).toHaveLength(2);expect(readFileSync(file,"utf8")).toBe(before);await host.stop();
});
it("許可リストは不正な選択・過大IDを拒否",()=>{
 expect(parseHostAction(JSON.stringify({kind:"confirmLifecycle",choiceId:0}))).toBeNull();expect(parseHostAction(JSON.stringify({kind:"previewDelete",projectId:"x".repeat(257)}))).toBeNull();
 expect(parseHostAction(JSON.stringify({kind:"previewDelete",projectId:"p",server:"https://evil.invalid"}))).toEqual({kind:"previewDelete",projectId:"p"});
});

it("旧サーバーの永久削除APIへフォールバックしない",async()=>{
 const requests:string[]=[];const fetcher:typeof fetch=async(input,init)=>{
  requests.push(`${init?.method ?? "GET"} ${String(input)}`);
  if(String(input).endsWith("/trash")) return new Response("{}",{status:404});
  return new Response(JSON.stringify({name:"old"}),{headers:{etag:'"e1.1"',"x-boxglow-account":"a","x-boxglow-epoch":"e1"}});
 };
 const o={server,fetch:fetcher},p=await previewLifecycle(o,"delete","p");await expect(commitLifecycle(o,p)).rejects.toThrow(/404/);
 expect(requests).toEqual([`GET ${server}/v1/projects/p`,`DELETE ${server}/v1/projects/p/trash`]);
});

it("J3: AI端末のプレビューには確定用の印とコマンドを表示しない",async()=>{
 const f=fake();process.env.CLAUDECODE="1";const lines:string[]=[];
 expect(await runLifecycle({server,fetch:f.fetch,command:"delete",id:"p"},l=>lines.push(l))).toBe(0);
 expect(lines.join("\n")).toContain("サーバー計画");expect(lines.join("\n")).not.toMatch(/CONFIRM|--confirm|--actor human/);expect(f.writes).toHaveLength(0);
});
it("J5: 保存上限の案内は30日保管中も保存量に含むと伝える",async()=>{
 const f=fake(),p=await previewLifecycle({server,fetch:f.fetch},"delete","p");
 await expect(commitLifecycle({server,fetch:async()=>new Response("{}",{status:507})},p)).rejects.toThrow(/30/);
});

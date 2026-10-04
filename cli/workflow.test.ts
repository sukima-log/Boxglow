import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { addBlock, addPort, createProject, defaultTaskParent, toJSON } from "../src/model/graph";

let dir: string, entry: string, serial=0;
beforeAll(async () => {
  const cache=resolve("node_modules/.cache");mkdirSync(cache,{recursive:true});
  dir=mkdtempSync(join(cache,"workflow-"));entry=join(dir,"cli.mjs");
  await build({entryPoints:["cli/main.ts"],bundle:true,loader:{".md":"text"},platform:"node",format:"esm",external:["@modelcontextprotocol/sdk","zod"],outfile:entry});
});
afterAll(()=>{if(dir)rmSync(dir,{recursive:true,force:true});});

/** Input: guard の有効指定 / Output: 各テスト専用の計画と CLI 呼出し (実計画は触らない)。 */
function fixture(guard=false) {
  const base=createProject("確認");base.lang="ja";base.contextGuard=guard;
  const r=addBlock(base,{parentId:defaultTaskParent(base),title:"対象",outputName:"コード"});
  const p=addPort(r.project,{blockId:r.blockId,direction:"in",name:"仕様書"}).project;
  const file=join(dir,"plan-"+serial+++".json");writeFileSync(file,toJSON(p));
  const cli=(...args:string[])=>spawnSync(process.execPath,[entry,...args,"--file",file,"--actor","codex"],{encoding:"utf8"});
  const token=()=>JSON.parse(cli("context","対象").stdout).contextToken as string;
  const read=()=>JSON.parse(readFileSync(file,"utf8"));
  return {file,id:r.blockId,cli,token,read};
}

describe("CLIの既定動作と選択できる拒否",()=>{
  it("既定の start と done は警告を出して成功し、理由は活動とログに残す",()=>{
    const {cli,read,id}=fixture();
    const start=cli("start","対象");expect(start.status).toBe(0);expect(start.stdout).toContain("仕様書");
    const reason=cli("start","対象","--reason","モックを先に作る");expect(reason.status).toBe(0);expect(reason.stdout).not.toContain("必須の入力待ち:");
    expect(read().blocks[id].activity.note).toContain("モックを先に作る");
    expect(read().log.at(-1).message).toContain("モックを先に作る");
    const done=cli("done","対象");expect(done.status).toBe(0);expect(done.stdout).toContain("成果物が付いていません");
    expect(read().blocks[id].status).toBe("white");
  });
  it("reject では未準備・成果物なしを保存前に拒否し、既存成果物は認める",()=>{
    const {cli,file,read,id}=fixture();expect(cli("policy","--start","reject","--done","reject").status).toBe(0);
    const before=readFileSync(file,"utf8");
    expect(cli("start","対象").status).toBe(1);expect(cli("done","対象").status).toBe(1);
    expect(cli("set","対象","--status","white").status).toBe(1);
    expect(readFileSync(file,"utf8")).toBe(before);
    expect(cli("start","対象","--reason","先行調査").status).toBe(0);
    expect(cli("artifact","対象","https://example.com/code").status).toBe(0);
    expect(cli("done","対象").status).toBe(0);expect(read().blocks[id].status).toBe("white");
  });
  it("人の操作は reject の計画でも開始・完了できる",()=>{
    const {cli,file,id,read}=fixture(true);
    expect(cli("policy","--start","reject","--done","reject","--context-token",JSON.parse(cli("context","対象").stdout).contextToken).status).toBe(0);
    const human=(cmd:string)=>spawnSync(process.execPath,[entry,cmd,"対象","--file",file,"--actor","human"],{encoding:"utf8"});
    expect(human("start").status).toBe(0);expect(human("done").status).toBe(0);expect(read().blocks[id].status).toBe("white");
  });
  it("不正設定と空の理由・空の成果物は保存しない",()=>{
    const {cli,file}=fixture();const before=readFileSync(file,"utf8");
    expect(cli("policy","--start","oops").status).toBe(1);
    expect(cli("start","対象","--reason"," ").status).toBe(1);
    expect(cli("done","対象","--artifact","名前= ").status).toBe(1);
    expect(readFileSync(file,"utf8")).toBe(before);
  });
});

describe("CLIの範囲と再開",()=>{
  it("guard付きで4項目とfocusを設定し、古いトークンは保存前に拒否する",()=>{
    const {cli,read,id,token,file}=fixture(true);const old=token();
    const scope=cli("scope","対象","--goal","実装","--non-goals","公開","--acceptance","検査成功","--consult","形式変更","--context-token",old);
    expect(scope.status).toBe(0);expect(scope.stdout).toContain("新しい確認トークン:");
    expect(read().blocks[id].scope).toEqual({goal:"実装",nonGoals:"公開",acceptance:"検査成功",consult:"形式変更"});
    const before=readFileSync(file,"utf8");expect(cli("focus","対象","--context-token",old).status).toBe(1);expect(readFileSync(file,"utf8")).toBe(before);
    expect(cli("focus","対象","--context-token",token()).status).toBe(0);
    const context=JSON.parse(cli("context","対象").stdout).context;
    expect(context.workScope.target.goal).toBe("実装");expect(context.focus.blockId).toBe(id);
    expect(cli("scope","対象").status).toBe(0);
    expect(cli("scope","対象","--non-goals","none","--context-token",token()).status).toBe(0);expect(read().blocks[id].scope.nonGoals).toBeUndefined();
    expect(cli("focus","none","--context-token",token()).status).toBe(0);expect(read().focusBlockId).toBeUndefined();
  });
  it("policyの変更にもguardが必要で、表示だけは保存しない",()=>{
    const {cli,token,file}=fixture(true);const before=readFileSync(file,"utf8");
    expect(cli("policy","--start","reject").status).toBe(1);
    for(const args of [["policy"],["focus"],["scope","対象"]])expect(cli(...args).status).toBe(0);
    expect(readFileSync(file,"utf8")).toBe(before);
    expect(cli("policy","--start","reject","--context-token",token()).stdout).toContain("新しい確認トークン:");
  });
  it("説明の古さを知らせて本文は保ち、完了メモは指定した場合だけ再開一覧に出る",()=>{
    const {cli,token,read,id}=fixture(true);
    expect(cli("set","対象","--note","未コミット。レビュー待ち","--context-token",token()).status).toBe(0);
    expect(cli("checkpoint","対象","--note","古い引き継ぎ本文","--context-token",token()).status).toBe(0);
    const done=cli("done","対象","--context-token",token());expect(done.status).toBe(0);expect(done.stdout).toContain("以前の状況");
    expect(read().blocks[id].description).toBe("未コミット。レビュー待ち");
    expect(cli("resume").stdout).not.toContain("古い引き継ぎ本文");
    expect(cli("resume","--include-completed").stdout).toContain("古い引き継ぎ本文");
    expect(JSON.parse(cli("resume","--json").stdout).completedHandoffCount).toBe(1);
    expect(cli("show","対象").stdout).toContain("状態の変更より前");
  });
  it("日本語と英語のヘルプと一覧に新しい操作がある",()=>{
    const {cli}=fixture();
    expect(cli("help","--lang","ja").stdout).toContain("今回達成すること");
    expect(cli("help","--lang","en").stdout).toContain("acceptance");
    expect(cli("status","--brief","--lang","en").stdout).toContain("Waiting for inputs");
    expect(cli("start","対象","--lang","en").stdout).not.toContain("必須");
  });
});

it("MCPでも範囲・設定・理由・完了履歴を同じ規則で扱う",async()=>{
  const {file,id,read}=fixture(true);
  const client=new Client({name:"workflow-test",version:"1"});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[entry,"mcp","--file",file,"--actor","codex"],stderr:"pipe"}));
  const call=(name:string,args:Record<string,unknown>={})=>client.callTool({name,arguments:args});
  const token=async()=>JSON.parse(((await call("boxglow_context",{block:"対象"})).content as {text:string}[])[0].text).contextToken;
  try {
    expect((await call("boxglow_scope",{block:"対象",goal:"検査",nonGoals:"公開",acceptance:"成功",consult:"仕様変更",contextToken:await token()})).isError).not.toBe(true);
    expect((await call("boxglow_focus",{block:"対象",contextToken:await token()})).isError).not.toBe(true);
    expect((await call("boxglow_policy",{start:"reject",done:"reject",contextToken:await token()})).isError).not.toBe(true);
    expect((await call("boxglow_start",{block:"対象",contextToken:await token()})).isError).toBe(true);
    expect((await call("boxglow_start",{block:"対象",reason:"先行調査",contextToken:await token()})).isError).not.toBe(true);
    expect(read().blocks[id].activity.note).toContain("先行調査");
    expect((await call("boxglow_done",{block:"対象",contextToken:await token()})).isError).toBe(true);
    await call("boxglow_checkpoint",{block:"対象",note:"完了前の記録",contextToken:await token()});
    expect((await call("boxglow_done",{block:"対象",artifact:["コード=https://example.com/code"],contextToken:await token()})).isError).not.toBe(true);
    const data=(r:Awaited<ReturnType<typeof call>>)=>JSON.parse((r.content as {text:string}[])[0].text);
    expect(data(await call("boxglow_resume")).handoffs).toHaveLength(0);
    expect(data(await call("boxglow_resume",{includeCompleted:true})).handoffs).toHaveLength(1);
    await call("boxglow_scope",{block:"対象",goal:"",contextToken:await token()});
    expect(read().blocks[id].scope.goal).toBeUndefined();
  } finally {await client.close();}
},15000);

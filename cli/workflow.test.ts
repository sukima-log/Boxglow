import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// この試験は 1 件ごとに CLI を何度も起動する。CI の遅い機械では既定の 5 秒を超えることがあるので、制限時間を延ばす
vi.setConfig({ testTimeout: 30_000 });
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
    expect(cli("status","--brief","--lang","en").stdout).toContain("Needs detail");
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

// 担当の一覧 (boxglow list): メンバーの名前で指定して Markdown の表で出す。存在しない名前はメンバーの一覧を添えて止める
describe("担当の一覧 (list)",()=>{
  it("--assignee の名前で担当を表にし、--json で同じ行を出し、知らない名前はメンバーを添えて失敗する",()=>{
    const {cli,read,file}=fixture();
    // メンバーを足して、対象のボックスの担当にする (CLI にメンバーの命令は無いので、ファイルを直接整える)
    const p=read();p.members=[{id:"m1",name:"さとう",color:"#0d8080"}];
    const target=Object.values(p.blocks as Record<string,{title:string;assigneeIds:string[];dueDate?:string}>).find(b=>b.title==="対象")!;
    target.assigneeIds=["m1"];target.dueDate="2026-10-20";
    writeFileSync(file,JSON.stringify(p,null,2));
    const table=cli("list","--assignee","さとう");
    expect(table.status,table.stderr).toBe(0);
    expect(table.stdout).toContain("| ID | 題名 | 場所 | 状態 |");
    expect(table.stdout).toMatch(/\| 対象 \|.*\| New \| 0% \| 2026-10-20 \|.*要具体化: /);
    const json=JSON.parse(cli("list","--assignee","さとう","--json").stdout);
    expect(json).toHaveLength(1);
    expect(json[0]).toMatchObject({title:"対象",dueDate:"2026-10-20",missingInputs:["仕様書"]});
    // 全員: 担当の列が足され、担当のいないボックスは「未担当」と出る
    const all=cli("list","--everyone");
    expect(all.status,all.stderr).toBe(0);
    expect(all.stdout).toContain("| ID | 題名 | 場所 | 担当 | 状態 |");
    expect(all.stdout).toMatch(/\| 対象 \|.*\| さとう \|/);
    const unknown=cli("list","--assignee","すずき");
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("さとう");
  });
});

// 分岐 (branch) と合流 (port --any-of): 選択肢ごとの道を作り、答えると選ばなかった道の先は見送り (次の候補と担当の一覧から外れる)
describe("分岐 (branch)",()=>{
  it("branch で選択肢ごとの道を作り、答える前は分岐待ち、答えると選ばなかった道は見送りになる",()=>{
    const {cli,read}=fixture();
    // 分岐を足し、2 つの道の先にボックスを作ってつなぐ (CLI は --actor codex で動く)
    const made=cli("branch","方式を決める","--options","REST|GraphQL","--question","API の方式は?");
    expect(made.status,made.stderr).toBe(0);
    expect(made.stdout).toContain("REST, GraphQL");
    for(const [title,from] of [["REST 実装","方式を決める.REST"],["GraphQL 実装","方式を決める.GraphQL"]]){
      expect(cli("add",title,"--out","API").status).toBe(0);
      const c=cli("connect",from,title);expect(c.status,c.stderr).toBe(0);
    }
    // 合流先: 2 つの API を受けて、合流にする (つなぐと入力の名前は供給元に合わせて、どちらも「API」になる)
    expect(cli("add","結合テスト","--out","結果").status).toBe(0);
    expect(cli("port","結合テスト","--in","API (REST)","--in","API (GraphQL)").status).toBe(0);
    expect(cli("connect","REST 実装.API","結合テスト.API (REST)").status).toBe(0);
    expect(cli("connect","GraphQL 実装.API","結合テスト.API (GraphQL)").status).toBe(0);
    const merged=cli("port","結合テスト","--any-of","API");
    expect(merged.status,merged.stderr).toBe(0);
    // 答える前: 道の先は分岐待ちとして「入力待ち」の候補に並び、着手すると警告される
    const before=cli("resume");
    expect(before.stdout).toMatch(/GraphQL 実装 — .*分岐「方式を決める」の判断/);
    const started=cli("start","GraphQL 実装");expect(started.stdout+started.stderr).toContain("分岐「方式を決める」の判断");
    expect(cli("leave","GraphQL 実装").status).toBe(0);
    // 人が REST と答える → 分岐は完了、GraphQL の道は見送り (次の候補と担当の一覧から外れる)、結合テストは見送りにならない
    expect(cli("answer","方式を決める","REST","--by","human").status).toBe(0);
    const p=read();
    const branch=Object.values(p.blocks as Record<string,{title:string;status:string}>).find(b=>b.title==="方式を決める")!;
    expect(branch.status).toBe("white");
    const after=cli("resume").stdout;
    expect(after).not.toContain("GraphQL 実装");
    expect(after).toContain("REST 実装");
    const table=cli("list","--everyone").stdout;
    expect(table).not.toContain("GraphQL 実装");
    expect(table).toContain("結合テスト");
    // 見送りのボックスに着手すると、見送りだと警告される
    const skipped=cli("start","GraphQL 実装");expect(skipped.stdout+skipped.stderr).toContain("見送り");
  });
  it("--option を繰り返すと、「|」を含む選択肢も 1 つの道になる",()=>{
    const {cli,read}=fixture();
    const made=cli("branch","比較","--option","A|B 案","--option","C 案");
    expect(made.status,made.stderr).toBe(0);
    const p=read();
    const outs=Object.values(p.ports as Record<string,{direction:string;branchOption?:string}>).filter(q=>q.branchOption!==undefined).map(q=>q.branchOption);
    expect(outs).toEqual(["A|B 案","C 案"]);
  });
  it("branch --box で今あるボックスを分岐に変えられる (今の出力は 1 つ目の選択肢の道、線は残る)",()=>{
    const {cli,read}=fixture();
    expect(cli("add","公開先","--out","決めた公開先").status).toBe(0);
    expect(cli("add","置く","--out","URL").status).toBe(0);
    expect(cli("connect","公開先.決めた公開先","置く").status).toBe(0);
    const made=cli("branch","--box","公開先","--options","静的ホスティング|自前のサーバー","--question","公開先は?");
    expect(made.status,made.stderr).toBe(0);
    const p=read();
    const box=Object.values(p.blocks as Record<string,{id:string;title:string;branch?:{decisionId:string}}>).find(b=>b.title==="公開先")!;
    expect(box.branch).toBeTruthy();
    const outs=Object.values(p.ports as Record<string,{id:string;blockId:string;direction:string;name:string;branchOption?:string}>).filter(q=>q.blockId===box.id&&q.direction==="out");
    expect(outs.map(q=>q.branchOption)).toEqual(["静的ホスティング","自前のサーバー"]);
    // 元の線 (置くへの線) は 1 つ目の道に残る
    expect(Object.values(p.edges as Record<string,{from:{portId:string}}>).some(e=>e.from.portId===outs[0].id)).toBe(true);
    // 同じボックスを、もう一度は変えられない
    const again=cli("branch","--box","公開先","--options","A|B");
    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain("すでに分岐");
  });
  it("join で合流の部品を足し、道の出力をつなげる",()=>{
    const {cli,read}=fixture();
    expect(cli("branch","方式","--options","A|B").status).toBe(0);
    const made=cli("join","--title","方式の合流");
    expect(made.status,made.stderr).toBe(0);
    expect(cli("connect","方式.A","方式の合流").status).toBe(0);
    expect(cli("connect","方式.B","方式の合流").status).toBe(0);
    const p=read();
    const join=Object.values(p.blocks as Record<string,{id:string;title:string;merge?:boolean}>).find(b=>b.title==="方式の合流")!;
    expect(join.merge).toBe(true);
    expect(Object.values(p.ports as Record<string,{blockId:string;direction:string}>).filter(q=>q.blockId===join.id&&q.direction==="in")).toHaveLength(2);
  });
  it("選択肢が 1 つしか無い branch は止める",()=>{
    const {cli}=fixture();
    const r=cli("branch","方式","--options","REST");
    expect(r.status).not.toBe(0);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync, statSync, utimesSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { commitFile, FileBusy, FileConflict, lockFile, revisionOf, pidSpace, removeLock, inspectLock, lockTokenOf } from "./file-store";
import { startServe, MAX_BODY } from "./serve";
import { createProject, addBlock, defaultTaskParent, toJSON, fromJSON, editDecisionAnswer, ackDecisions, removeBlock } from "../src/model/graph";
import { validateProjectText } from "../src/model/validate-file";
import { saveDocument } from "../vscode/src/save";
import { contextReceipt, requireContext } from "./context";
import { buildSampleProject } from "../src/model/sample";
import { mergeProjects } from "../src/model/merge";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "boxglow-reliability-")); dirs.push(dir); return dir; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function fixture() {
  const base = createProject("Reliability");
  const actual = addBlock(base, { parentId: defaultTaskParent(base), title: "Task" });
  return actual;
}

describe("cooperative file writes", () => {
  it("rejects a stale snapshot and a held lock without replacing the winning edit", () => {
    const file = join(temp(), "plan.json"); commitFile(file, "base", null);
    const rev = revisionOf("base"); commitFile(file, "CLI change", rev);
    expect(() => commitFile(file, "stale GUI", rev)).toThrow(FileConflict);
    expect(readFileSync(file, "utf8")).toBe("CLI change");
    const unlock = lockFile(file);
    expect(() => commitFile(file, "other CLI", revisionOf("CLI change"))).toThrow(FileBusy);
    unlock(); expect(existsSync(file + ".boxglow-lock")).toBe(false);
  });
});

describe("local HTTP API", () => {
  it("checks revisions, origins, body size and project structure before any disk write", async () => {
    const dir = temp(), file = join(dir, "plan.json"), dist = join(dir, "dist"); mkdirSync(dist); writeFileSync(join(dist, "index.html"), "test");
    const p = fixture().project; const original = toJSON(p); writeFileSync(file, original);
    const server = startServe({ file, dist, port: 0, open: false, log: () => {} });
    try {
      await once(server, "listening"); const port = (server.address() as { port: number }).port;
      const url = `http://127.0.0.1:${port}/api/project`;
      const first = await fetch(url); const etag = first.headers.get("etag")!; await first.text();
      const put = (body: string, headers: Record<string,string> = {}) => fetch(url, { method: "PUT", headers: { "content-type": "application/json", "if-match": etag, ...headers }, body });
      expect((await put("{}", { origin: "https://untrusted.example" })).status).toBe(403);
      const badHost = await new Promise<number>((resolve,reject) => { const req = httpRequest(url,{headers:{host:"untrusted.example"}},res => {res.resume();resolve(res.statusCode!);});req.on("error",reject);req.end(); });
      expect(badHost).toBe(403);
      expect((await put(original, { "content-type": "text/plain" })).status).toBe(415);
      expect((await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: original })).status).toBe(428);
      for (const body of ["{}", "{", JSON.stringify({ ...p, blocks: { ...p.blocks, root: { ...p.blocks.root, parentId: "root" } } }), JSON.stringify({ ...p, ports: { broken: { id: "broken", blockId: "absent", direction: "in", name: "bad", description: "", required: true, artifacts: [] } } })]) expect((await put(body)).status).toBe(400);
      expect((await put(" ".repeat(MAX_BODY + 1))).status).toBe(413);
      expect(readFileSync(file, "utf8")).toBe(original);
      const edited = toJSON({ ...p, name: "GUI winner" });
      const ok = await put(edited); expect(ok.status).toBe(200); expect(ok.headers.get("etag")).not.toBe(etag);
      expect((await put(original)).status).toBe(412); expect(readFileSync(file, "utf8")).toBe(edited);
      commitFile(file, toJSON({ ...p, name: "CLI winner" }), revisionOf(edited));
      const stale = await fetch(url, { method: "PUT", headers: { "content-type": "application/json", "if-match": ok.headers.get("etag")! }, body: original });
      expect(stale.status).toBe(412); expect(readFileSync(file,"utf8")).toContain("CLI winner");
    } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
  });
});

describe("VS Code save acknowledgement", () => {
  it("only resolves after disk confirmation and releases locks on each failure", async () => {
    const file = join(temp(), "plan.json"); const original = toJSON(fixture().project); writeFileSync(file, original);
    const edited = toJSON({ ...fromJSON(original), name: "Edited" }); let text = original, version = 1, allowEdit = false, allowSave = false;
    const doc = { path: file, text: () => text, version: () => version, replace: async (value: string) => { if (!allowEdit) return false; text = value; version++; return true; }, save: async () => { if (!allowSave) return false; writeFileSync(file, text); return true; } };
    const request = { text: edited, baseText: original, version: 1 };
    await expect(saveDocument(doc, request, original)).rejects.toThrow("編集を適用できません"); expect(text).toBe(original);
    allowEdit = true;
    await expect(saveDocument(doc, request, original)).rejects.toThrow("保存できません"); expect(readFileSync(file,"utf8")).toBe(original); expect(text).toBe(edited);
    expect(existsSync(file + ".boxglow-lock")).toBe(false);
    allowSave = true;
    expect(await saveDocument(doc, request, original)).toBe(2); expect(readFileSync(file,"utf8")).toBe(edited);
  });
  it("refuses stale disk/doc edits and holds the shared lock during an asynchronous save", async () => {
    const file = join(temp(), "plan.json"), original = toJSON(fixture().project); writeFileSync(file, original);
    const text = toJSON({ ...fromJSON(original), name: "New" });
    const doc = { path: file, text: () => original, version: () => 2, replace: async () => false, save: async () => false };
    await expect(saveDocument(doc, { text, baseText: "stale", version: 1 }, original)).rejects.toThrow(FileConflict);
    writeFileSync(file, text); await expect(saveDocument(doc, { text, baseText: original, version: 2 }, original)).rejects.toThrow(FileConflict);
    writeFileSync(file, original); let documentText = original;
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const saving = saveDocument({ ...doc, text: () => documentText, replace: async t => { documentText = t; return true; }, save: async () => { await gate; writeFileSync(file, documentText); return true; } }, { text, baseText: original, version: 2 }, original);
    await Promise.resolve(); expect(() => commitFile(file, original, revisionOf(original))).toThrow(FileBusy);
    release(); await saving;
  });
});

describe("durable agent context", () => {
  it("retains acknowledged decisions and checkpoints; revised human answers invalidate receipt and acknowledgement", () => {
    let { project: p, blockId } = fixture(); p.contextGuard = true;
    p.blocks[blockId].decisions = [{ id: "d", question: "Storage?", options: ["Local","Cloud"], answer: "Local", askedBy: "codex", askedAt: "now", ackedBy: "codex", ackedAt: "now" }];
    p.handoffs = { [blockId]: { note: "Next: verify local persistence", actor: "codex", at: "now" } };
    const receipt = contextReceipt(p, blockId);
    expect(JSON.stringify(receipt)).toContain("Local"); expect(JSON.stringify(receipt)).toContain("Next: verify");
    expect(() => requireContext(p, blockId)).toThrow("boxglow context"); requireContext(fromJSON(toJSON(p)), blockId, receipt.contextToken);
    expect(contextReceipt(ackDecisions(p,blockId,"codex"),blockId).contextToken).toBe(receipt.contextToken);
    p = editDecisionAnswer(p, blockId, "d", "Cloud", "human");
    expect(p.blocks[blockId].decisions[0].ackedAt).toBeUndefined();
    expect(() => requireContext(p, blockId, receipt.contextToken)).toThrow();
    const merged = mergeProjects(p,p,{...p,handoffs:{[blockId]:{note:"New next step",actor:"human",at:"later"}}}).project;
    expect(fromJSON(toJSON(merged)).handoffs?.[blockId].note).toBe("New next step");
  });
  it("uses separate CLI processes to resume and rejects a stale human decision receipt", () => {
    const { project: p, blockId } = fixture(); p.contextGuard = true; p.lang = "en";
    const file = join(temp(),"plan.json"); writeFileSync(file,toJSON(p));
    const cli = (...args: string[]) => spawnSync(process.execPath,["bin/boxglow.js",...args,"--file",file,"--actor","codex"],{encoding:"utf8"});
    expect(cli("start",blockId).status).toBe(1);
    const first = JSON.parse(cli("context",blockId).stdout);
    expect(cli("start",blockId,"--context-token",first.contextToken).status).toBe(0);
    expect(cli("checkpoint",blockId,"--note","Verified input. Next: implement retry. Open question: timeout.","--context-token",first.contextToken).status).toBe(0);
    const resumed = JSON.parse(cli("context",blockId).stdout); expect(JSON.stringify(resumed)).toContain("Next: implement retry");
    expect(cli("start",blockId,"--context-token",first.contextToken).status).toBe(1);
    const human = fromJSON(readFileSync(file,"utf8")); human.blocks[blockId].description = "Human: do not publish"; writeFileSync(file,toJSON(human));
    expect(cli("done",blockId,"--context-token",resumed.contextToken).status).toBe(1);
    expect(fromJSON(readFileSync(file,"utf8")).blocks[blockId].status).not.toBe("white");
    const latest = JSON.parse(cli("context",blockId).stdout); expect(JSON.stringify(latest)).toContain("do not publish");
    expect(cli("start",blockId,"--context-token",latest.contextToken).status).toBe(0);
  });
  it("installs context instructions and enables guard for existing plans", () => {
    const dir = temp(), file = join(dir,"boxglow.json"); writeFileSync(file,toJSON(fixture().project));
    const setup = spawnSync(process.execPath,["bin/boxglow.js","setup-agent","--agent","codex","--file",file],{encoding:"utf8"});
    expect(setup.status,setup.stderr).toBe(0); expect(JSON.parse(readFileSync(file,"utf8")).contextGuard).toBe(true);
    expect(readFileSync(join(dir,"AGENTS.md"),"utf8")).toContain("--context-token");
    expect(readFileSync(join(dir,".agents/skills/boxglow/SKILL.md"),"utf8")).toContain("checkpoint");
  });
  it("asking a new question cannot clear an unread human answer", () => {
    const {project:p,blockId}=fixture(); p.contextGuard=true;
    p.blocks[blockId].decisions=[{id:"human-answer",question:"Where?",options:[],answer:"Local",askedBy:"codex",askedAt:"now",answeredBy:"human"}];
    const file=join(temp(),"plan.json"); writeFileSync(file,toJSON(p));
    const asked=spawnSync(process.execPath,["bin/boxglow.js","ask",blockId,"Next question?","--file",file,"--actor","codex"],{encoding:"utf8"});
    expect(asked.status,asked.stderr).toBe(0);
    expect(fromJSON(readFileSync(file,"utf8")).blocks[blockId].decisions[0].ackedAt).toBeUndefined();
  });
  it("includes ancestor input providers and never emits unresolved connection references", () => {
    const p=buildSampleProject(); const task=Object.values(p.blocks).find(b=>b.title==="実装する")!;
    const receipt=contextReceipt(p,task.id);
    const ports=new Set(receipt.context.blocks.flatMap(b=>b.ports.map(port=>port.id)));
    for(const e of receipt.context.connections) {expect(ports.has(e.from.portId)).toBe(true);expect(ports.has(e.to.portId)).toBe(true);}
    expect(receipt.context.blocks.some(b=>b.title==="設計する")).toBe(true);
    const provider=receipt.context.blocks.find(b=>b.title==="設計する")!;
    p.blocks[provider.id].description+=" A changed input constraint";
    expect(contextReceipt(p,task.id).contextToken).not.toBe(receipt.contextToken);
  });
  it("rejects malformed consumed fields before normalization", () => {
    const p = fixture().project;
    expect(validateProjectText(toJSON(p)).name).toBe(p.name);
    expect(() => validateProjectText(JSON.stringify({ ...p, members: [{id:"x",name:null,color:"red"}] }))).toThrow();
  });
});

describe("ロックの回収と待ち合わせ", () => {
  /**
   * ロックのディレクトリを、指定した持ち主の情報で直接作る (他のプロセスが取ったロックの再現)
   * 既定では、このテストと同じマシン・OS・プロセス番号の空間で取ったロックにする (owner = null なら、持ち主の記録が無い空のロック)
   */
  const plantLock = (file: string, owner: { pid: number; host?: string; at?: string } | null) => {
    mkdirSync(file + ".boxglow-lock");
    if (owner) writeFileSync(join(file + ".boxglow-lock", "owner.json"), JSON.stringify({ pid: owner.pid, host: owner.host ?? hostname(), at: owner.at ?? new Date(Date.now() - 60_000).toISOString(), token: "planted", platform: process.platform, space: pidSpace(), start: null }));
  };
  /** すでに終了したプロセスの pid (同じホストで「持ち主がいない」ロックの再現) */
  const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;

  it("ロックの中に持ち主 (pid・ホスト名・取得時刻) を書き、解放で消す", () => {
    const file = join(temp(), "plan.json"); commitFile(file, "base", null);
    const unlock = lockFile(file);
    const owner = JSON.parse(readFileSync(join(file + ".boxglow-lock", "owner.json"), "utf8"));
    expect(owner.pid).toBe(process.pid); expect(owner.host).toBe(hostname()); expect(Date.parse(owner.at)).not.toBeNaN();
    unlock(); expect(existsSync(file + ".boxglow-lock")).toBe(false);
    // 2 回目の解放・ロックが先に消えていた場合でも例外にならない
    expect(() => unlock()).not.toThrow();
  });
  // 終了を確かめられるのは、プロセス番号の空間の印が取れる Linux だけ (Windows・macOS では人の解除に回す)
  it.runIf(process.platform === "linux")("持ち主のプロセスがいないロックは回収して書き込める", () => {
    const file = join(temp(), "plan.json"); commitFile(file, "base", null);
    plantLock(file, { pid: deadPid() });
    commitFile(file, "after crash", revisionOf("base"));
    expect(readFileSync(file, "utf8")).toBe("after crash"); expect(existsSync(file + ".boxglow-lock")).toBe(false);
  });
  it("生きている持ち主のロックと、持ち主の記録が無いロックは、時間が経っても奪わない", () => {
    const file = join(temp(), "plan.json"); commitFile(file, "base", null);
    // 持ち主が生きている (自分の親) 間は、31 秒経っただけでは奪わない (保存に時間がかかっているだけかもしれない)
    plantLock(file, { pid: process.ppid, at: new Date(Date.now() - 31_000).toISOString() });
    expect(() => commitFile(file, "one", revisionOf("base"), { waitMs: 100 })).toThrow(FileBusy);
    expect(readFileSync(file, "utf8")).toBe("base");
    rmSync(file + ".boxglow-lock", { recursive: true });
    // 5 分を過ぎても生きている書き手のロックは奪わない
    plantLock(file, { pid: process.ppid, at: new Date(Date.now() - 6 * 60_000).toISOString() });
    expect(() => commitFile(file, "one", revisionOf("base"), { waitMs: 0 })).toThrow(FileBusy);
    rmSync(file + ".boxglow-lock", { recursive: true });
    // 持ち主の記録が無い空のロック (旧版の残骸か、旧版が取得している途中かを見分けられない) は、古くても奪わない
    plantLock(file, null); const old = new Date(Date.now() - 60_000); utimesSync(file + ".boxglow-lock", old, old);
    expect(() => commitFile(file, "two", revisionOf("base"), { waitMs: 0 })).toThrow(FileBusy);
    expect(readFileSync(file, "utf8")).toBe("base");
    // 人が解除すれば書ける (照合用の印は、表示のときの世代の印)
    expect(removeLock(file, lockTokenOf(inspectLock(file)!))).toBe("removed");
    commitFile(file, "two", revisionOf("base"));
    expect(readFileSync(file, "utf8")).toBe("two");
  });
  it("CLI を 16 個同時に走らせても、全部が成功し、全部の変更が残り、ロックの残骸が無い", async () => {
    // 取得 (改名で置く) と解放 (改名してから消す) が重なっても、2 つの書き手が同時にロックの中へ入らないこと。
    // 入ってしまうと、片方の変更が黙って消える (成功の数より、残ったボックスの数が少なくなる)
    const { project: p } = fixture(); p.lang = "ja";
    const dir = temp(); const file = join(dir, "plan.json"); writeFileSync(file, toJSON(p));
    const before = Object.keys(fromJSON(readFileSync(file, "utf8")).blocks).length;
    const runs = Array.from({ length: 16 }, (_, i) => {
      const child = spawn(process.execPath, ["bin/boxglow.js", "add", `並行 ${i}`, "--file", file, "--actor", "codex"], { stdio: "ignore" });
      return once(child, "exit").then(([code]) => code as number);
    });
    const codes = await Promise.all(runs);
    expect(codes.filter((c) => c === 0).length).toBe(16);
    const after = fromJSON(readFileSync(file, "utf8"));
    expect(Object.values(after.blocks).filter((b) => b.title.startsWith("並行 ")).length).toBe(16);
    expect(Object.keys(after.blocks).length).toBe(before + 16);
    expect(readdirSync(dir).filter((n) => n.includes("boxglow-lock") || n.includes("boxglow-tmp"))).toEqual([]);
  }, 60_000);
  it("CLI: 解けないロックは持ち主を示して止まり、unlock は表示だけ・解除は人だけ・印が合うときだけ", () => {
    const { project: p } = fixture(); p.lang = "ja";
    const file = join(temp(), "plan.json"); writeFileSync(file, toJSON(p));
    const cli = (actor: string, ...args: string[]) => spawnSync(process.execPath, ["bin/boxglow.js", ...args, "--file", file, "--actor", actor], { encoding: "utf8" });
    expect(cli("codex", "unlock").stdout).toContain("ロックはありません");
    // 別のマシンの書き手が残したロック (こちらからは生死を確かめられない)
    plantLock(file, { pid: 1, host: "another-host" });
    const busy = cli("codex", "add", "新しいボックス");
    expect(busy.status).toBe(1);
    expect(busy.stderr).toContain("another-host"); expect(busy.stderr).toContain("boxglow unlock");
    // 表示は AI でもできる。解除の手順と照合用の印が出る
    const shown = cli("codex", "unlock");
    expect(shown.status).toBe(0); expect(shown.stdout).toContain("--lock-token planted");
    // AI は解除できない。人でも、印が無い・違うときは解除できない
    expect(cli("codex", "unlock", "--remove", "--lock-token", "planted").status).toBe(1);
    expect(cli("human", "unlock", "--remove").status).toBe(1);
    expect(cli("human", "unlock", "--remove", "--lock-token", "other").status).toBe(1);
    expect(existsSync(file + ".boxglow-lock")).toBe(true);
    // 人が、表示された印を付けて解除する。その後は書ける
    expect(cli("human", "unlock", "--remove", "--lock-token", "planted").status).toBe(0);
    expect(existsSync(file + ".boxglow-lock")).toBe(false);
    expect(cli("codex", "add", "新しいボックス").status).toBe(0);
  }, 30_000);
  it("生きている他のプロセスのロックは待ち、時間切れなら FileBusy。解放されれば待った後に書ける", async () => {
    const file = join(temp(), "plan.json"); commitFile(file, "base", null);
    // 0.4 秒だけロックを持つ別のプロセス
    const holder = spawn(process.execPath, ["-e", `
      const fs = require("node:fs"), os = require("node:os");
      const lock = process.argv[1] + ".boxglow-lock";
      fs.mkdirSync(lock);
      fs.writeFileSync(lock + "/owner.json", JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString(), token: "other" }));
      process.stdout.write("locked");
      setTimeout(() => fs.rmSync(lock, { recursive: true }), 400);
    `, file], { stdio: ["ignore", "pipe", "inherit"] });
    await once(holder.stdout!, "data");
    // 待つ時間が短ければ FileBusy (書き込まない)
    expect(() => commitFile(file, "too early", revisionOf("base"), { waitMs: 50 })).toThrow(FileBusy);
    expect(readFileSync(file, "utf8")).toBe("base");
    // 既定の待ち時間 (3 秒) なら、解放を待ってから書ける
    commitFile(file, "after wait", revisionOf("base"));
    expect(readFileSync(file, "utf8")).toBe("after wait");
    await once(holder, "exit");
  });
  it.skipIf(process.platform === "win32")("新しいファイルの権限は既定 (umask に従う)、既存のファイルの権限は保つ", () => {
    const file = join(temp(), "plan.json"); commitFile(file, "base", null);
    expect(statSync(file).mode & 0o777).toBe(0o666 & ~process.umask());
    chmodSync(file, 0o640); commitFile(file, "next", revisionOf("base"));
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });
});

describe("CLI の同時実行", () => {
  /** CLI を別プロセスで実行し、終了を待つ (同時に走らせるため非同期) */
  const run = (file: string, ...args: string[]) => new Promise<{ status: number | null; stderr: string }>((done) => {
    const child = spawn(process.execPath, ["bin/boxglow.js", ...args, "--file", file, "--actor", "codex"], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr!.on("data", (d) => { stderr += d; });
    child.on("exit", (status) => done({ status, stderr }));
  });
  it("add を 6 本同時に実行して全部成功し、6 個のボックスが残る", async () => {
    const file = join(temp(), "plan.json"); writeFileSync(file, toJSON(createProject("Concurrent")));
    const before = Object.keys(fromJSON(readFileSync(file, "utf8")).blocks).length;
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => run(file, "add", `Task ${n}`, "--out", `Output ${n}`)));
    for (const r of results) expect(r.status, r.stderr).toBe(0);
    const p = fromJSON(readFileSync(file, "utf8"));
    expect(Object.keys(p.blocks).length).toBe(before + 6);
    for (const n of [1, 2, 3, 4, 5, 6]) expect(Object.values(p.blocks).filter((b) => b.title === `Task ${n}`)).toHaveLength(1);
    // B 番号も重ならない
    const keys = Object.values(p.blocks).map((b) => b.key).filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);
    expect(existsSync(file + ".boxglow-lock")).toBe(false);
  }, 30000);
});

describe("確認トークン (guard)", () => {
  /** guard を有効にした計画を一時ファイルに作り、CLI を actor 付きで実行する関数を返す */
  const guarded = () => {
    const { project: p, blockId } = fixture(); p.contextGuard = true; p.lang = "en";
    const file = join(temp(), "plan.json"); writeFileSync(file, toJSON(p));
    const cli = (actor: string, ...args: string[]) => spawnSync(process.execPath, ["bin/boxglow.js", ...args, "--file", file, "--actor", actor], { encoding: "utf8" });
    const token = () => JSON.parse(cli("codex", "context", blockId).stdout).contextToken as string;
    /** 出力の最後の行から新しい確認トークンを取り出す (無ければ undefined) */
    const issued = (stdout: string) => stdout.trim().split("\n").pop()!.match(/^New context token: ([0-9a-f]{64})$/)?.[1];
    return { file, blockId, cli, token, issued };
  };
  it("人の操作にはトークンを要求しない。AI はトークン無しで拒否され、context のトークンで通る", () => {
    const { blockId, cli, token } = guarded();
    expect(cli("human", "start", blockId).status).toBe(0);
    expect(cli("human:hash", "set", blockId, "--note", "Human instruction").status).toBe(0);
    expect(cli("codex", "start", blockId).status).toBe(1);
    expect(cli("codex", "start", blockId, "--context-token", token()).status).toBe(0);
  });
  it("自分の操作でトークンが変わったら、出力の最後に新しいトークンを添える (続けて操作できる)", () => {
    const { file, blockId, cli, token, issued } = guarded();
    const first = token();
    // ask: 最新のトークンを付ければ、質問を足した後のトークンが出る
    const asked = cli("codex", "ask", blockId, "Which storage?", "--options", "Local|Cloud", "--context-token", first);
    expect(asked.status, asked.stderr).toBe(0);
    const afterAsk = issued(asked.stdout)!; expect(afterAsk).toBeDefined(); expect(afterAsk).not.toBe(first);
    // checkpoint → artifact → done と、読み直さずに続けられる
    const checkpoint = cli("codex", "checkpoint", blockId, "--note", "Next: implement", "--context-token", afterAsk);
    expect(checkpoint.status, checkpoint.stderr).toBe(0);
    const afterCheckpoint = issued(checkpoint.stdout)!; expect(afterCheckpoint).toBe(token());
    const done = cli("codex", "done", blockId, "--artifact", "Result=https://example.invalid/pr/1", "--context-token", afterCheckpoint);
    expect(done.status, done.stderr).toBe(0);
    expect(issued(done.stdout)).toBe(token());
    expect(fromJSON(readFileSync(file, "utf8")).blocks[blockId].status).toBe("white");
    // コンテキストが変わらない操作 (start) では、新しいトークンは出さない
    const start = cli("codex", "start", blockId, "--context-token", token());
    expect(start.status).toBe(0); expect(issued(start.stdout)).toBeUndefined();
  });
  it("トークン無し・古いトークンの ask では新しいトークンを出さない (人の変更を読まずに手に入れられない)", () => {
    const { blockId, cli, token, issued } = guarded();
    const stale = token();
    expect(cli("human", "set", blockId, "--note", "Human changed the instruction").status).toBe(0);
    for (const extra of [[], ["--context-token", stale]]) {
      const asked = cli("codex", "ask", blockId, "Question?", ...extra);
      expect(asked.status, asked.stderr).toBe(0); expect(issued(asked.stdout)).toBeUndefined();
    }
    expect(cli("codex", "done", blockId, "--context-token", stale).status).toBe(1);
  });
  it("人が回答した後・他の AI が引き継ぎを書いた後は、古いトークンを拒否する", () => {
    const { blockId, cli, token, issued } = guarded();
    const asked = cli("codex", "ask", blockId, "Which storage?", "--options", "Local|Cloud", "--context-token", token());
    const mine = issued(asked.stdout)!;
    expect(cli("human", "answer", blockId, "Local").status).toBe(0);
    expect(cli("codex", "done", blockId, "--context-token", mine).status).toBe(1);
    const reread = token();
    expect(cli("claude-code", "checkpoint", blockId, "--note", "Other AI handoff", "--context-token", reread).status).toBe(0);
    expect(cli("codex", "done", blockId, "--context-token", reread).status).toBe(1);
    expect(cli("codex", "done", blockId, "--context-token", token()).status).toBe(0);
  });
  it("成果物の確認の記録 (checkedAt / state) ではトークンが変わらない", () => {
    const { project: p, blockId } = fixture();
    const port = Object.values(p.ports).find((x) => x.blockId === blockId && x.direction === "out")!;
    port.artifacts = [{ id: "a", title: "Code", url: "", kind: "git", note: "", repo: "", path: "src/a.ts", commit: "c", blob: "b", state: "ok", checkedAt: "2026-10-01T00:00:00Z" }];
    const before = contextReceipt(p, blockId);
    port.artifacts[0].checkedAt = "2026-10-04T00:00:00Z"; port.artifacts[0].state = "missing";
    const after = contextReceipt(p, blockId);
    expect(after.contextToken).toBe(before.contextToken);
    // 出力の context には確認の記録もそのまま載る。成果物の中身 (パス) が変わればトークンは変わる
    expect(JSON.stringify(after.context)).toContain("missing");
    port.artifacts[0].path = "src/b.ts";
    expect(contextReceipt(p, blockId).contextToken).not.toBe(before.contextToken);
  });
  it("check を実行してもトークンは変わらない", () => {
    const { blockId, cli, token } = guarded();
    expect(cli("codex", "done", blockId, "--artifact", "Result=https://example.invalid/pr/1", "--context-token", token()).status).toBe(0);
    const before = token();
    expect(cli("codex", "check").status).toBe(0);
    expect(token()).toBe(before);
  });
  it("guard off: 人はトークン無しでできる。AI は最新のトークンが要る", () => {
    const { file, blockId, cli, token } = guarded();
    expect(cli("codex", "guard", "off").status).toBe(1);
    expect(cli("codex", "guard", "off", "--context-token", "0".repeat(64)).status).toBe(1);
    expect(fromJSON(readFileSync(file, "utf8")).contextGuard).toBe(true);
    expect(cli("human", "guard", "off").status).toBe(0);
    expect(fromJSON(readFileSync(file, "utf8")).contextGuard).toBe(false);
    expect(cli("codex", "guard", "on").status).toBe(0);
    expect(cli("codex", "guard", "off", "--context-token", token()).status).toBe(0);
    // guard の対象外のままボックスを消せる
    expect(cli("codex", "guard", "on").status).toBe(0);
    expect(cli("codex", "remove", blockId).status).toBe(0);
  });
  it("requireContext は人の actor を通し、AI と actor の指定なしは拒否する", () => {
    const { project: p, blockId } = fixture(); p.contextGuard = true;
    expect(() => requireContext(p, blockId, undefined, "human")).not.toThrow();
    expect(() => requireContext(p, blockId, undefined, "human:hash")).not.toThrow();
    expect(() => requireContext(p, blockId, undefined, "codex")).toThrow();
    expect(() => requireContext(p, blockId)).toThrow();
  });
});

describe("古い計画・CRLF の計画", () => {
  it("lang / contextGuard / handoffs が無い古い計画を、そのまま読み書きできる (項目を勝手に足さない)", () => {
    const { project: p, blockId } = fixture();
    const legacy = JSON.parse(toJSON(p)); delete legacy.lang; delete legacy.contextGuard; delete legacy.handoffs;
    const file = join(temp(), "plan.json"); writeFileSync(file, JSON.stringify(legacy, null, 2));
    const cli = (...args: string[]) => spawnSync(process.execPath, ["bin/boxglow.js", ...args, "--file", file, "--actor", "codex"], { encoding: "utf8" });
    // guard が無いので、AI もトークン無しで操作できる
    for (const args of [["status", "--brief"], ["resume"], ["start", blockId], ["done", blockId, "--artifact", "R=https://example.invalid/1"], ["validate"]]) { const r = cli(...args); expect(r.status, r.stderr).toBe(0); }
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.blocks[blockId].status).toBe("white");
    for (const k of ["lang", "contextGuard", "handoffs"]) expect(k in saved).toBe(false);
  });
  it("CRLF の計画ファイルを CLI で読み書きできる", () => {
    const { project: p, blockId } = fixture();
    const file = join(temp(), "plan.json"); writeFileSync(file, (toJSON(p) + "\n").replace(/\n/g, "\r\n"));
    const cli = (...args: string[]) => spawnSync(process.execPath, ["bin/boxglow.js", ...args, "--file", file, "--actor", "codex"], { encoding: "utf8" });
    expect(cli("status", "--brief").status).toBe(0);
    const started = cli("start", blockId, "--note", "CRLF"); expect(started.status, started.stderr).toBe(0);
    expect(fromJSON(readFileSync(file, "utf8")).blocks[blockId].activity?.note).toBe("CRLF");
  });
  it("ボックスを消すと、そのボックスの引き継ぎメモも消える", () => {
    const { project: p, blockId } = fixture();
    p.handoffs = { [blockId]: { note: "Next", actor: "codex", at: "now" } };
    expect(removeBlock(p, blockId).handoffs).toBeUndefined();
  });
});

describe("VS Code の保存 (CRLF のドキュメント)", () => {
  it("CRLF のドキュメントでも保存が成功し、続けて保存できる (改行の違いを競合にしない)", async () => {
    const crlf = (text: string) => text.replace(/\r?\n/g, "\r\n");
    const original = toJSON(fixture().project) + "\n";
    const file = join(temp(), "plan.json"); writeFileSync(file, crlf(original));
    // VS Code と同じく、挿入した文字列の改行をドキュメントの改行 (CRLF) に合わせる模擬のドキュメント
    let text = crlf(original), version = 1;
    const doc = { path: file, text: () => text, version: () => version, replace: async (value: string) => { text = crlf(value); version++; return true; }, save: async () => { writeFileSync(file, text); return true; } };
    // 画面は LF の文字列を送る (元にした中身は、拡張から届いた CRLF のもの・画面が LF にそろえたもののどちらでもよい)
    const first = toJSON({ ...fromJSON(original), name: "First" }) + "\n";
    expect(first).not.toContain("\r");
    expect(await saveDocument(doc, { text: first, baseText: crlf(original), version: 1 }, crlf(original))).toBe(2);
    expect(readFileSync(file, "utf8")).toBe(crlf(first)); // ファイルは CRLF のまま
    // 2 回目: 画面が元にした中身は前回送った LF の文字列、拡張の基準は保存後のドキュメント (CRLF)
    const second = toJSON({ ...fromJSON(original), name: "Second" }) + "\n";
    expect(await saveDocument(doc, { text: second, baseText: first, version: 2 }, text)).toBe(3);
    expect(fromJSON(readFileSync(file, "utf8")).name).toBe("Second");
    // 中身が本当に違うときは、今までどおり競合にする
    writeFileSync(file, crlf(original));
    await expect(saveDocument(doc, { text: first, baseText: second, version: 3 }, text)).rejects.toThrow(FileConflict);
    expect(existsSync(file + ".boxglow-lock")).toBe(false);
  });
});

import { commitFile, revisionOf } from "../file-store";
import { bindingsOf } from "./state-store";
import { setLang } from "../../src/i18n/core";
/** CLIとMCPの実際の入口で共通要求を渡す。通信先はループバックの試験サーバーだけ。 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { build } from "esbuild";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  addBlock,
  createProject,
  defaultTaskParent,
  fromJSON,
  toJSON,
  updateBlock,
} from "../../src/model/graph";
import {
  blockResolutionKey,
  type ConflictResolution,
} from "../../src/model/conflict-groups";
import { resolutionOptions, runSyncCommand, runWatchCommand, humanSyncCommand, retargetSyncArgs } from "./command";
import { HumanSyncRequired, syncOnce } from "./client";
import { TestSyncServer } from "./test-server";

let root: string, entry: string, server: TestSyncServer, caseDir: string;
beforeAll(async () => {
  mkdirSync(resolve("node_modules/.cache"), { recursive: true });
  root = mkdtempSync(resolve("node_modules/.cache/resolution-"));
  entry = join(root, "cli.mjs");
  await build({
    entryPoints: ["cli/main.ts"],
    bundle: true,
    loader: { ".md": "text" },
    platform: "node",
    format: "esm",
    external: ["@modelcontextprotocol/sdk", "zod"],
    outfile: entry,
  });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(async () => {
  caseDir = mkdtempSync(join(root, "case-"));
  server = new TestSyncServer();
  await server.start();
});
afterEach(async () => {
  await server.stop();
  delete process.env.BOXGLOW_CONFIG_DIR;
});

/** 入力: なし。出力: 2つのブロックと設定が競合したファイル・共通要求。基準は実同期で作る。 */
async function fixture() {
  const initial = createProject("Plan");
  const a = addBlock(initial, {
    parentId: defaultTaskParent(initial),
    title: "A",
  });
  const b = addBlock(a.project, {
    parentId: defaultTaskParent(a.project),
    title: "B",
  });
  const p = fromJSON(toJSON(b.project)),
    file = join(caseDir, "local.json"),
    remoteFile = join(caseDir, "remote.json");
  const config = join(caseDir, "config");
  process.env.BOXGLOW_CONFIG_DIR = config;
  writeFileSync(file, toJSON(p));
  await syncOnce({ file, server: server.url, remoteId: "plan" });
  const remote = updateBlock(
    updateBlock(p, a.blockId, { title: "Remote A" }),
    b.blockId,
    { title: "Remote B" },
  );
  remote.name = "Remote plan";
  process.env.BOXGLOW_CONFIG_DIR = join(caseDir, "other-config");
  await syncOnce({ file: remoteFile, server: server.url, remoteId: "plan" });
  writeFileSync(remoteFile, toJSON(remote));
  await syncOnce({ file: remoteFile, server: server.url });
  const local = updateBlock(
    updateBlock(p, a.blockId, { title: "Local A" }),
    b.blockId,
    { title: "Local B" },
  );
  local.name = "Local plan";
  writeFileSync(file, toJSON(local));
  process.env.BOXGLOW_CONFIG_DIR = config;
  const result = await syncOnce({ file, server: server.url });
  if (result.status !== "halted" || result.halt.reason !== "conflicts")
    throw new Error("Expected conflict");
  const request: ConflictResolution = {
    version: 1,
    token: result.halt.token,
    groups: {
      [blockResolutionKey(a.blockId)]: "local",
      [blockResolutionKey(b.blockId)]: "remote",
      settings: "remote",
    },
  };
  return { file, config, request, a: a.blockId, b: b.blockId };
}
/** 入力: CLI引数と環境。出力: 終了コードと本文。サーバーが同じイベントループなので非同期で子を待つ。 */
function cli(
  args: string[],
  config: string,
  environment: Record<string, string | undefined> = {},
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], {
      env: {
        ...process.env,
        BOXGLOW_CONFIG_DIR: config,
        BOXGLOW_TOKEN: "",
        BOXGLOW_SERVER: server.url,
        CODEX_HOME: "", CODEX_SANDBOX: "", CODEX_THREAD_ID: "", CODEX_SESSION_ID: "", CLAUDECODE: "", CLAUDE_CODE: "",
        ...environment,
      },
    });
    let output = "";
    child.stdout.on("data", (b) => {
      output += b;
    });
    child.stderr.on("data", (b) => {
      output += b;
    });
    child.on("close", (code) => resolve({ code, output }));
  });
}

it.each([false, true])(
  "CLI: --block / --settings と --choices-fileを実行し、部分選択は拒否する (JSON=%s)",
  async (json) => {
    const f = await fixture();
    const before = readFileSync(f.file, "utf8");
    const args = [
      "sync", "--actor", "human",
      "--file",
      f.file,
      "--server",
      server.url,
      "--resolve",
      f.request.token,
    ];
    const partial = await cli([...args, "--block", f.a + "=local"], f.config);
    expect(partial.code).toBe(2);
    expect(readFileSync(f.file, "utf8")).toBe(before);
    let flags = [
      "--block",
      f.a + "=local",
      "--block",
      f.b + "=remote",
      "--settings",
      "remote",
    ];
    if (json) {
      const choices = join(caseDir, "choices.json");
      writeFileSync(choices, JSON.stringify(f.request));
      flags = ["--choices-file", choices];
    }
    const result = await cli([...args, ...flags], f.config);
    expect(result.code, result.output).toBe(0);
    const p = fromJSON(readFileSync(f.file, "utf8"));
    expect(p.blocks[f.a].title).toBe("Local A");
    expect(p.blocks[f.b].title).toBe("Remote B");
    expect(p.name).toBe("Remote plan");
  },
);

it("MCP: 人を名乗る環境でも解決・対象変更を拒否し、固定対象の比較は返す", async () => {
  const f = await fixture();
  const client = new Client({ name: "test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "mcp", "--file", f.file],
    env: {
      ...(process.env as Record<string, string>),
      BOXGLOW_ACTOR: "human",
      BOXGLOW_CONFIG_DIR: f.config,
      BOXGLOW_TOKEN: "",
      BOXGLOW_SERVER: server.url,
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "boxglow_sync",
      arguments: { server: server.url, resolution: f.request },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("--actor human");
    expect(JSON.stringify(result)).toContain("ask");
    for (const arguments_ of [{ file: f.file }, { server: server.url }, { actor: "human" }, { recover: "token", applied: true }]) {
      expect((await client.callTool({ name: "boxglow_sync", arguments: arguments_ })).isError).toBe(true);
    }
    expect((await client.callTool({ name: "boxglow_run", arguments: { args: ["sync", "--actor", "human", "--resolve", f.request.token, "--prefer", "remote"] } })).isError).toBe(true);
    const review = await client.callTool({ name: "boxglow_sync", arguments: {} });
    expect(review.isError).not.toBe(true);
    expect(JSON.stringify(review)).toContain("Remote A");
    expect(JSON.stringify(review)).not.toMatch(/--actor human|boxglow sync --resolve|--prefer/);
    const p = fromJSON(readFileSync(f.file, "utf8"));
    expect(p.blocks[f.a].title).toBe("Local A");
    expect(p.blocks[f.b].title).toBe("Local B");
    expect(p.name).toBe("Local plan");
  } finally {
    await client.close();
  }
});

it("フラグの混在、同じ内部IDの重複、誤った側を通信前に拒否する", () => {
  for (const flags of [
    { resolve: "t", prefer: "local", block: ["x=local"] },
    { resolve: "t", block: ["x=local", "x=remote"] },
    { block: ["x=local"] },
    { resolve: "t", settings: "other" },
  ]) {
    expect(() => resolutionOptions({ file: "x", ...flags })).toThrow();
  }
});

it.each(["ja", "en"] as const)("CLI指定ミスを%sの案内として返す", async lang => {
  setLang(lang);
  const bad = join(caseDir, "bad.json");
  writeFileSync(bad, "{");
  try {
    for (const options of [{ resolve: "token" }, { choicesFile: bad }, { choicesFile: join(caseDir, "missing.json") }]) {
      const lines: string[] = [];
      const code = await runSyncCommand({ actor: "human", file: join(caseDir, "plan.json"), server: server.url, ...options }, line => lines.push(line));
      expect(code).toBe(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toMatch(/ENOENT|SyntaxError|Unexpected/);
      expect(lines[0]).toMatch(lang === "ja" ? /指定|ファイル/ : /choices|Choices/);
    }
  } finally { setLang("ja"); }
});

it("CLI: AIの全判断フラグはguardによらず拒否し、通常の比較は返す", async () => {
  const f = await fixture();
  const before = readFileSync(f.file, "utf8"), puts = server.puts;
  process.env.BOXGLOW_ACTOR = "human"; // 環境だけでは人の明示操作にならない。
  try {
    for (const args of [
      ["--resolve", f.request.token, "--prefer", "remote"], ["--block", f.a + "=remote"],
      ["--settings", "local"], ["--choices-file", "missing.json"], ["--prefer", "local"],
      ["--link", "x", "--prefer", "local"], ["--relink", "x"], ["--recover", "x", "--applied"],
      ["--adopt", "x"], ["--restore", "x"], ["--account", "test"],
    ]) {
      const result = await cli(["sync", "--file", f.file, "--actor", "codex", ...args], f.config);
      expect(result.code).toBe(2); expect(result.output).not.toContain("--actor human"); expect(result.output).toContain("ask");
    }
    const review = await cli(["sync", "--file", f.file, "--actor", "codex"], f.config);
    expect(review.code).toBe(2); expect(review.output).toContain("Remote A");
    expect(review.output).not.toMatch(/--actor human|boxglow sync --resolve|--prefer/);
    expect(readFileSync(f.file, "utf8")).toBe(before); expect(server.puts).toBe(puts);
  } finally { delete process.env.BOXGLOW_ACTOR; }
});

it("初回はAI CLIとMCPが拒否、人の明示CLIで結び付けた後はMCPが通常同期できる", async () => {
  const file = join(caseDir, "plan.json"), config = join(caseDir, "config");
  const p = createProject("New plan"); writeFileSync(file, toJSON(p));
  process.env.BOXGLOW_CONFIG_DIR = config;
  const result = await cli(["sync", "--file", file, "--server", server.url, "--actor", "codex"], config);
  expect(result.code).toBe(2); expect(server.puts).toBe(0); expect(bindingsOf(file).bindings).toHaveLength(0);
  const client = new Client({ name: "test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, "mcp", "--file", file, "--actor", "human"],
    env: { ...(process.env as Record<string,string>), BOXGLOW_CONFIG_DIR: config, BOXGLOW_SERVER: server.url, BOXGLOW_TOKEN: "", BOXGLOW_ACTOR: "human" }, stderr: "pipe" });
  try {
    await client.connect(transport);
    const denied = await client.callTool({ name: "boxglow_sync", arguments: {} });
    expect(JSON.stringify(denied)).not.toContain("--actor human"); expect(JSON.stringify(denied)).toContain("ask"); expect(server.puts).toBe(0);
    expect(bindingsOf(file).bindings).toHaveLength(0);
    const human = await cli(["sync", "--file", file, "--server", server.url, "--actor", "human"], config);
    expect(human.code, human.output).toBe(0);
    writeFileSync(file, toJSON({ ...p, name: "Edited by AI" }));
    const synced = await client.callTool({ name: "boxglow_sync", arguments: {} });
    expect(synced.isError).not.toBe(true); expect(server.puts).toBe(2);
  } finally { await client.close(); }
});

it("低層同期もAIの初回・判断要求を通信前に拒否する", async () => {
  const file = join(caseDir, "plan.json"); writeFileSync(file, toJSON(createProject("P")));
  process.env.BOXGLOW_CONFIG_DIR = join(caseDir, "config");
  let calls = 0;
  const fetch = (async () => { calls++; throw Error("must not fetch"); }) as typeof globalThis.fetch;
  await expect(syncOnce({ file, server: server.url, humanActions: false, fetch })).rejects.toBeInstanceOf(HumanSyncRequired);
  await syncOnce({ file, server: server.url });
  for (const choice of [{ resolution: { token: "x", prefer: "local" as const } }, { firstLink: { token: "x", prefer: "remote" as const } },
    { relink: { token: "x" } }, { recover: { token: "x", applied: true } }, { approvedDeletion: "x" }, { restoreDeletion: "x" }, { confirmAccount: "x" }]) {
    await expect(syncOnce({ file, server: server.url, humanActions: false, fetch, ...choice })).rejects.toBeInstanceOf(HumanSyncRequired);
  }
  expect(calls).toBe(0);
});

it("git merge driverと既存ファイル保存は孤立した担当を拒否せず、読み込み・統合で除く", async () => {
  const p = createProject("P");
  const a = addBlock(p, { parentId: defaultTaskParent(p), title: "A" });
  const base = fromJSON(toJSON(a.project)); base.members = [{ id: "m", name: "M", color: "red" }];
  const local = structuredClone(base); local.members = [];
  const remote = structuredClone(base); remote.blocks[a.blockId].assigneeIds = ["m"];
  const files = ["base.json", "ours.json", "theirs.json"].map(name => join(caseDir, name));
  [base, local, remote].forEach((v, i) => writeFileSync(files[i], toJSON(v)));
  const merged = await cli(["merge", ...files], join(caseDir, "config"));
  expect(merged.code, merged.output).toBe(0);
  expect(JSON.parse(readFileSync(files[1], "utf8")).blocks[a.blockId].assigneeIds).toEqual([]);
  const old = structuredClone(local); old.blocks[a.blockId].assigneeIds = ["missing"];
  const text = toJSON(old); writeFileSync(files[1], text);
  const loaded = fromJSON(text); expect(loaded.blocks[a.blockId].assigneeIds).toEqual([]);
  expect(() => commitFile(files[1], toJSON(loaded), revisionOf(text))).not.toThrow();
});

it.each(["ja", "en"] as const)("識別のない人の拒否には元の引数を保持した再実行コマンドを出す (%s)", async lang => {
  const file = join(caseDir, "plan with spaces.json"), config = join(caseDir, "config");
  writeFileSync(file, toJSON(createProject("P")));
  const args = ["--file", file, "--server", server.url, "--project", "plan-id", "--watch", "--lang", lang];
  const result = await cli(["sync", ...args], config, { BOXGLOW_ACTOR: "" });
  expect(result.code).toBe(2); expect(server.puts).toBe(0);
  expect(result.output).toContain(humanSyncCommand({ file, rawArgs: args }));
  expect(result.output).toMatch(lang === "ja" ? /人による確認/ : /requires your confirmation/i);
  const quoted = humanSyncCommand({ file, rawArgs: [...args, "--account", "O'Reilly $value `literal` \"quoted\""] });
  if (process.platform !== "win32") {
    // 表示文字列をコマンドとして実行せず、シェルの引数展開だけを検査する。
    const parsed = spawnSync("sh", ["-c", "set -- " + quoted + "; printf '%s\\0' \"$@\""], { encoding: "utf8" });
    expect(parsed.status).toBe(0);
    expect(parsed.stdout.split("\0").slice(0,-1)).toEqual(["boxglow", "sync", ...args, "--account", "O'Reilly $value `literal` \"quoted\"", "--actor", "human"]);
  }
});

it.each(["ja", "en"] as const)("AI識別を環境から拾い、拒否の回り道を出さない (%s)", async lang => {
  const file = join(caseDir, "plan.json"), config = join(caseDir, "config");
  writeFileSync(file, toJSON(createProject("P")));
  for (const environment of [{ BOXGLOW_ACTOR: "codex" }, { BOXGLOW_ACTOR: "", CODEX_SANDBOX: "seatbelt" }, { BOXGLOW_ACTOR: "", CLAUDECODE: "1" }]) {
    const result = await cli(["sync", "--file", file, "--server", server.url, "--watch", "--lang", lang], config, environment);
    expect(result.code).toBe(2); expect(result.output).toContain("ask"); expect(result.output).not.toMatch(/--actor human|--resolve|--prefer|--relink|--recover|--adopt|--restore|--account|boxglow sync --server/);
    expect(result.output).toMatch(lang === "ja" ? /人の判断/ : /human decision/i);
  }
  expect(server.puts).toBe(0);
});

it("別サーバーへの結び付けを、人専用操作の拒否より先に示す", async () => {
  const file = join(caseDir, "plan.json"), config = join(caseDir, "config");
  writeFileSync(file, toJSON(createProject("P"))); process.env.BOXGLOW_CONFIG_DIR = config;
  await syncOnce({ file, server: server.url });
  const result = await syncOnce({ file, server: "http://127.0.0.1:1", humanActions: false, fetch: (() => { throw Error("No network expected"); }) as typeof fetch });
  expect(result).toMatchObject({ status: "halted", halt: { reason: "bound-elsewhere", server: server.url } });
  const output = await cli(["sync", "--file", file, "--actor", "codex", "--lang", "ja"], config, { BOXGLOW_SERVER: "http://127.0.0.1:1" });
  expect(output.code).toBe(2); expect(output.output).toContain("別のサーバー"); expect(output.output).toContain(server.url);
  expect(output.output).not.toContain("--actor human");
});

it("AIの常時同期で競合を再通知しても、人用コマンドを案内しない", async () => {
  const f = await fixture(), lines: string[] = [];
  await runWatchCommand({ actor: "codex", file: f.file }, line => lines.push(line), new Promise(resolve => setTimeout(resolve, 1300)));
  const text = lines.join("\n");
  expect(text).toContain("Remote A"); expect(text).toContain("ask");
  expect(text).not.toMatch(/--actor human|--resolve|--prefer|上のコマンド/);
});

it.each(["ja", "en"] as const)("人の記録者名・設定フォルダだけではAI扱いにせず、人の名前付き明示操作も通る (%s)", async lang => {
  const file = join(caseDir, "plan.json"), config = join(caseDir, "config");
  writeFileSync(file, toJSON(createProject("P")));
  for (const environment of [{ BOXGLOW_ACTOR: "hash" }, { BOXGLOW_ACTOR: "", CODEX_HOME: "/test/user-settings" }]) {
    const result = await cli(["sync", "--file", file, "--server", server.url, "--lang", lang], config, environment);
    expect(result.code).toBe(2); expect(result.output).toContain("--actor human"); expect(server.puts).toBe(0);
  }
  const inherited = await cli(["sync", "--file", file, "--server", server.url, "--lang", lang], config, { CLAUDECODE: "1" });
  expect(inherited.output).toContain("boxglow sync --help"); expect(inherited.output).not.toContain("--actor human");
  const help = await cli(["sync", "--help", "--lang", lang, "--file", join(caseDir,"does-not-exist.json")], config, { CLAUDECODE: "1" });
  expect(help.code).toBe(0); expect(help.output).toContain("--actor human:");
  expect(help.output).toContain(lang === "ja" ? "人の操作" : "Human operations");
  const human = await cli(["sync", "--file", file, "--server", server.url, "--actor", "human:hash", "--lang", lang], config, { CLAUDECODE: "1" });
  expect(human.code, human.output).toBe(0); expect(server.puts).toBe(1);
});

it("watch中の打ち直しは対象と言語を保ち、単発コマンドになる", () => {
  const args = ["--file", "original.json", "--lang", "en", "--watch", "--server", "http://127.0.0.1:1234"];
  const changed = retargetSyncArgs(args, "other plan.json");
  expect(changed).toEqual(["--lang", "en", "--server", "http://127.0.0.1:1234", "--file", "other plan.json"]);
  expect(humanSyncCommand({ file: "other plan.json", rawArgs: changed })).not.toContain("--watch");
  expect(retargetSyncArgs(["--watch=true", "--file=old.json"], "new.json")).toEqual(["--file", "new.json"]);
});

it.each(["human", "human:hash", "codex-sub", "claude-code-research"])("継承したactor %sでAIに人用コマンドを出さない", async actor => {
  const file = join(caseDir, "identity.json"), config = join(caseDir, "config");
  writeFileSync(file, toJSON(createProject("P")));
  for (const mark of [{ CLAUDECODE: "1" }, { CODEX_SESSION_ID: "test-session" }]) {
    const r = await cli(["sync", "--file", file, "--server", server.url], config, { BOXGLOW_ACTOR: actor, ...mark });
    expect(r.code).toBe(2); expect(r.output).not.toContain("--actor human"); expect(r.output).toContain("sync --help");
  }
  expect(server.puts).toBe(0);
});

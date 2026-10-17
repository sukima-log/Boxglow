/**
 * boxglow agent-token (cli/sync/agent-token.ts) の試験: 一覧・作る (値と貼る設定が出る)・失効
 * 試験サーバー (cli/sync/test-server.ts) に対して通信する。資格情報は保存済みのもの
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, toJSON } from "../../src/model/graph";
import { saveCredentials } from "./credentials";
import { TestSyncServer } from "./test-server";
import { runAgentToken } from "./agent-token";

let server: TestSyncServer;
let root: string;
beforeEach(async () => {
  server = new TestSyncServer(); await server.start();
  root = mkdtempSync(join(tmpdir(), "boxglow-agent-token-"));
  process.env.BOXGLOW_CONFIG_DIR = join(root, "config");
  delete process.env.BOXGLOW_TOKEN;
  saveCredentials({ server: server.url, account: "acc-cli", login: "acc-cli", token: "acc-cli", createdAt: new Date().toISOString() });
});
afterEach(async () => { await server.stop(); delete process.env.BOXGLOW_CONFIG_DIR; rmSync(root, { recursive: true, force: true }); });

/** サーバーに計画を 1 つ置いて、その ID を返す (PUT + If-None-Match: * で作る) */
async function putPlan(): Promise<string> {
  const id = "plan-cli-1";
  const res = await fetch(`${server.url}/v1/projects/${id}`, { method: "PUT", headers: { authorization: "Bearer acc-cli", "content-type": "application/json", "if-none-match": "*", "x-boxglow-op": "op-cli-1", "x-boxglow-epoch": server.epoch }, body: toJSON(createProject("cli")) });
  if (!res.ok) throw new Error(`put failed: ${res.status}`);
  return id;
}

it("connect: トークンを作って設定ファイルに書く (値は出さない)", async () => {
  const lines: string[] = [];
  const out = (l: string) => lines.push(l);
  const projectId = await putPlan();
  const dir = join(root, "plan"); mkdirSync(dir, { recursive: true });
  expect(await runAgentToken({ server: server.url, out, command: "connect", target: "nope", write: true, projectId, dir })).toBe(1);
  expect(await runAgentToken({ server: server.url, out, command: "connect", target: "claude-code", write: true, projectId, dir })).toBe(0);
  expect(lines.join("\n")).not.toContain("bga_");
  expect(lines.join("\n")).toContain(join(dir, ".mcp.json"));
  expect(lines.join("\n")).toContain("共有やコミットをしないでください"); // .gitignore が無いフォルダ
  expect(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")).mcpServers.boxglow.headers.Authorization).toMatch(/^Bearer bga_/);
  expect([...server.agentTokens.values()][0]).toMatchObject({ name: "claude-code", write: true });
});

it("一覧 → 作る (値は 1 度だけ出る。Claude Code / Codex の設定が付く) → 一覧に回数と権限 → 失効", async () => {
  const lines: string[] = [];
  const out = (l: string) => lines.push(l);
  expect(await runAgentToken({ server: server.url, out, command: "list" })).toBe(0);
  expect(lines.at(-1)).toContain("トークンはまだありません");
  // 結び付けが無いと作れない
  expect(await runAgentToken({ server: server.url, out, command: "create", name: "x" })).toBe(1);
  expect(lines.at(-1)).toContain("サーバーに置かれていません");
  const projectId = await putPlan();
  lines.length = 0;
  expect(await runAgentToken({ server: server.url, out, command: "create", name: "claude-code", write: true, projectId })).toBe(0);
  const token = lines[1];
  expect(token).toMatch(/^bga_acc[0-9a-f]{32}\./);
  expect(lines.join("\n")).toContain(`claude mcp add --transport http boxglow ${server.url}/mcp --header "Authorization: Bearer ${token}"`);
  expect(lines.join("\n")).toContain(`url = "${server.url}/mcp"`);
  lines.length = 0;
  expect(await runAgentToken({ server: server.url, out, command: "list" })).toBe(0);
  expect(lines[0]).toContain("claude-code");
  expect(lines[0]).toContain("読み書き");
  expect(lines[0]).not.toContain("bga_");
  const id = lines[0].split(/\s+/)[0];
  lines.length = 0;
  expect(await runAgentToken({ server: server.url, out, command: "revoke", id })).toBe(0);
  expect(lines[0]).toContain(id);
  lines.length = 0;
  await runAgentToken({ server: server.url, out, command: "list" });
  expect(lines[0]).toContain("失効");
});

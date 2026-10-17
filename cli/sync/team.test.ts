/**
 * boxglow team (cli/sync/team.ts) の試験: 一覧・作る・招待・参加・表示・離脱 (試験サーバーに対して)
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCredentials } from "./credentials";
import { TestSyncServer } from "./test-server";
import { runTeam } from "./team";

let server: TestSyncServer;
let root: string;
beforeEach(async () => {
  server = new TestSyncServer(); await server.start();
  root = mkdtempSync(join(tmpdir(), "boxglow-team-"));
  process.env.BOXGLOW_CONFIG_DIR = join(root, "config");
  delete process.env.BOXGLOW_TOKEN;
});
afterEach(async () => { await server.stop(); delete process.env.BOXGLOW_CONFIG_DIR; rmSync(root, { recursive: true, force: true }); });

const signedIn = (account: string) => saveCredentials({ server: server.url, account, login: account, token: account, createdAt: new Date().toISOString() });

it("list → create → invite → (別の人が) join → show → leave", async () => {
  const lines: string[] = [];
  const out = (l: string) => lines.push(l);
  signedIn("acc-a");
  expect(await runTeam({ server: server.url, out, command: "list", args: [] })).toBe(0);
  expect(lines.at(-1)).toContain("まだワークスペースはありません");
  expect(await runTeam({ server: server.url, out, command: "create", args: ["開発"] })).toBe(0);
  expect(lines.at(-1)).toMatch(/作りました: 開発 \(acc/);
  lines.length = 0;
  await runTeam({ server: server.url, out, command: "list", args: [] });
  const teamId = lines[0].split(/\s+/)[0];
  expect(lines[0]).toContain("管理");
  lines.length = 0;
  expect(await runTeam({ server: server.url, out, command: "invite", args: [teamId], role: "viewer" })).toBe(0);
  const url = lines.at(-1)!;
  expect(url).toMatch(/^https:\/\/boxglow\.app\/#join=bgi_/);
  // 別の人が参加 (URL のまま渡せる)
  signedIn("acc-b");
  lines.length = 0;
  expect(await runTeam({ server: server.url, out, command: "join", args: [url] })).toBe(0);
  expect(lines.at(-1)).toContain("「開発」に参加しました");
  lines.length = 0;
  expect(await runTeam({ server: server.url, out, command: "show", args: [teamId] })).toBe(0);
  expect(lines.join("\n")).toContain("acc-b");
  expect(lines.join("\n")).toContain("閲覧");
  // viewer は招待を作れない
  lines.length = 0;
  expect(await runTeam({ server: server.url, out, command: "invite", args: [teamId] })).toBe(1);
  expect(lines.at(-1)).toContain("管理者の権限");
  lines.length = 0;
  expect(await runTeam({ server: server.url, out, command: "leave", args: [teamId] })).toBe(0);
  expect(lines.at(-1)).toContain("抜けました");
});

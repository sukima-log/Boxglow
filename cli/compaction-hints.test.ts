import { afterAll, beforeAll, describe, expect, it } from "vitest";
/**
 * done のときの区切りの案内の試験: このセッションが文脈の圧縮を経ていれば、次の箱は新しい文脈で始めるよう案内する。
 * 圧縮を何度もまたいだ箱には、同じくらいの大きさの箱を先に分けるよう案内する。人の操作と、圧縮を経ていないセッションには出さない
 */
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { addBlock, createProject, defaultTaskParent, toJSON } from "../src/model/graph";
import { recordCompaction } from "./compactions";

let dir: string, entry: string;
beforeAll(async () => {
  const cache = resolve("node_modules/.cache"); mkdirSync(cache, { recursive: true });
  dir = mkdtempSync(join(cache, "compaction-hints-")); entry = join(dir, "cli.mjs");
  await build({ entryPoints: ["cli/entry.ts"], bundle: true, loader: { ".md": "text" }, platform: "node", format: "esm", external: ["@modelcontextprotocol/sdk", "zod"], outfile: entry });
});
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

/**
 * 検査用の計画と設定フォルダ。compactions = このセッション (s1) で数えておく圧縮の回数 (箱「対象」を作業中として)
 * Input : compactions / Output: { done = 箱「対象」を完了にする CLI の呼び出し (記録者とセッションを指定) }
 */
function fixture(compactions: number) {
  let p = createProject("確認"); p.lang = "ja";
  const r = addBlock(p, { parentId: defaultTaskParent(p), title: "対象", outputName: "コード" }); p = r.project;
  const base = mkdtempSync(join(dir, "case-"));
  const file = join(base, "boxglow.json"); writeFileSync(file, toJSON(p));
  const config = join(base, "config");
  for (let i = 0; i < compactions; i++) recordCompaction("s1", [r.blockId], join(config, "compactions.json"));
  const done = (actor: string, session: string) => spawnSync(process.execPath, [entry, "done", "対象", "--artifact", "コード=https://example.com/code", "--checked", "試験", "--file", file, "--actor", actor], {
    encoding: "utf8", env: { ...process.env, BOXGLOW_CONFIG_DIR: config, BOXGLOW_SESSION_ID: session, CLAUDE_CODE_SESSION_ID: "", CODEX_THREAD_ID: "", CODEX_SESSION_ID: "" },
  });
  return { done };
}

describe("done のときの区切りの案内", () => {
  it("圧縮を経たセッションでは、次の箱を新しい文脈で始めるよう案内し、3 回またいだ箱には分けるよう案内する", () => {
    const r = fixture(3).done("codex", "s1");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("このセッションは文脈の圧縮を 3 回経ています");
    expect(r.stdout).toContain("boxglow prompt <箱>");
    expect(r.stdout).toContain("この箱は圧縮を 3 回またぎました");
  });
  it("圧縮が 1 回なら区切りの案内だけを出す", () => {
    const r = fixture(1).done("codex", "s1");
    expect(r.stdout).toContain("文脈の圧縮を 1 回経ています");
    expect(r.stdout).not.toContain("この箱は圧縮を");
  });
  it("圧縮を経ていないセッション・人の操作には出さない", () => {
    expect(fixture(3).done("codex", "s2").stdout).not.toContain("文脈の圧縮");
    expect(fixture(0).done("codex", "s1").stdout).not.toContain("文脈の圧縮");
    expect(fixture(3).done("human", "s1").stdout).not.toContain("文脈の圧縮");
  });
});

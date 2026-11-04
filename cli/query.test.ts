import { afterAll, beforeAll, describe, expect, it } from "vitest";
/**
 * 計画をまとめて読む CLI の検査: show の複数指定・範囲・--brief、tree、コマンドごとのヘルプ
 * (AI が計画のファイルを直接読んだり、全部のヘルプを何度も読んだりせずに済むようにした機能。2026-11-04)
 */
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { addBlock, createProject, defaultTaskParent, toJSON } from "../src/model/graph";

let dir: string, entry: string;
beforeAll(async () => {
  const cache = resolve("node_modules/.cache"); mkdirSync(cache, { recursive: true });
  dir = mkdtempSync(join(cache, "query-")); entry = join(dir, "cli.mjs");
  await build({ entryPoints: ["cli/entry.ts"], bundle: true, loader: { ".md": "text" }, platform: "node", format: "esm", external: ["@modelcontextprotocol/sdk", "zod"], outfile: entry });
});
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

/**
 * 検査用の計画: 親「設計」の下に「画面」「API」、「API」の下に「認証」。ほかに「試験」
 * Input : なし / Output: { cli = CLI の呼び出し (標準出力・終了コード), key = 題名から短い ID を引く }
 */
function fixture() {
  let p = createProject("確認"); p.lang = "ja";
  const top = defaultTaskParent(p);
  const a = addBlock(p, { parentId: top, title: "設計", outputName: "設計書" }); p = a.project;
  const a1 = addBlock(p, { parentId: a.blockId, title: "画面", outputName: "画面案" }); p = a1.project;
  const a2 = addBlock(p, { parentId: a.blockId, title: "API", outputName: "API 仕様" }); p = a2.project;
  const a2a = addBlock(p, { parentId: a2.blockId, title: "認証", outputName: "認証の方式" }); p = a2a.project;
  const b = addBlock(p, { parentId: top, title: "試験", outputName: "試験結果" }); p = b.project;
  const file = join(dir, `plan-${Math.random().toString(36).slice(2)}.json`); writeFileSync(file, toJSON(p));
  const cli = (...args: string[]) => spawnSync(process.execPath, [entry, ...args, "--file", file, "--actor", "codex"], { encoding: "utf8" });
  const key = (title: string) => Object.values(p.blocks).find((x) => x.title === title)!.key!;
  return { cli, key };
}

describe("show の複数指定と --brief", () => {
  it("--brief は 1 箱 1 行で、親の ID と子の数を添える", () => {
    const { cli, key } = fixture();
    const r = cli("show", key("API"), key("試験"), "--brief");
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(new RegExp(`^- \\[ \\] ${key("API")} API .*\\(親 ${key("設計")} / 子 1\\) -> API 仕様`));
    expect(lines[1]).toContain(`${key("試験")} 試験`);
  });
  it("範囲 (B2..B4 の形) は番号の順にまとめて出し、同じ箱は 1 回だけ", () => {
    const { cli, key } = fixture();
    const from = key("設計"), to = key("認証");
    const r = cli("show", `${from}..${to}`, key("画面"), "--brief");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split("\n").map((l) => l.split(" ")[3])).toEqual([from, key("画面"), key("API"), to]);
  });
  it("--brief の直後に書いた箱も取りこぼさない", () => {
    const { cli, key } = fixture();
    const r = cli("show", "--brief", key("画面"), key("試験"));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(2);
  });
  it("--brief なしで複数を指定すると、詳細を続けて出す", () => {
    const { cli, key } = fixture();
    const r = cli("show", key("画面"), key("試験"));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`# ${key("画面")} 画面`);
    expect(r.stdout).toContain(`# ${key("試験")} 試験`);
  });
  it("当たる箱の無い範囲は止める", () => {
    const { cli } = fixture();
    const r = cli("show", "B900..B910", "--brief");
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("範囲 B900..B910 に当たる箱がありません");
  });
});

describe("tree", () => {
  it("既定は直下の子だけで、さらに下の箱の数と出し方を添える", () => {
    const { cli, key } = fixture();
    const r = cli("tree", key("設計"));
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toMatch(new RegExp(`^- \\[ \\] ${key("設計")} 設計`));
    expect(lines.slice(1, 3).map((l) => l.trim().split(" ")[3]).sort()).toEqual([key("API"), key("画面")].sort());
    expect(lines.some((l) => l.includes(key("認証")))).toBe(false);
    expect(lines.at(-1)).toContain("さらに下に 1 箱あります");
  });
  it("--depth 2 で孫まで、字下げして出す", () => {
    const { cli, key } = fixture();
    const r = cli("tree", key("設計"), "--depth", "2");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`\\n    - \\[ \\] ${key("認証")} 認証`));
    expect(r.stdout).not.toContain("さらに下に");
  });
  it("箱を省くと計画全体 (プロジェクトの箱から)", () => {
    const { cli } = fixture();
    const r = cli("tree", "--depth", "1");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split("\n")[0]).toBe("# 確認");
  });
  it("--depth が 1 未満なら止める", () => {
    const { cli, key } = fixture();
    expect(cli("tree", key("設計"), "--depth", "0").status).not.toBe(0);
  });
});

describe("コマンドごとのヘルプ", () => {
  it("<command> --help と help <command> は、そのコマンドの分と共通の説明だけを出す", () => {
    const { cli } = fixture();
    const full = cli("help").stdout;
    for (const r of [cli("context", "--help"), cli("help", "context")]) {
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("context <block> [--brief]");
      expect(r.stdout).toContain("--context-token");
      expect(r.stdout).not.toContain("split-file");
      expect(r.stdout.length).toBeLessThan(full.length / 5);
    }
  });
  it("知らないコマンドのヘルプは全部を出す", () => {
    const { cli } = fixture();
    expect(cli("help", "nothing").stdout).toBe(cli("help").stdout);
  });
});

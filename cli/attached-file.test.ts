import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { resolveAttachedFile } from "./attached-file";
import { startServe } from "./serve";
import { createProject, toJSON } from "../src/model/graph";
import { localTarget } from "../src/lib/localLink";

// 成果物・資料・Notes のリンクに書かれた手元のファイルを開く (利用者の要望 2026-10-31)
const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "boxglow-attached-")); dirs.push(dir); return dir; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** リポジトリ (repo/.git) の中の plans/ に計画を置き、docs/ と plans/notes/ にファイルを置く。リポジトリの外にも 1 つ置く */
function repo() {
  const top = temp();
  const root = join(top, "repo");
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "docs"));
  mkdirSync(join(root, "plans", "notes"), { recursive: true });
  writeFileSync(join(root, "docs", "spec.md"), "# 仕様");
  writeFileSync(join(root, "plans", "notes", "memo.md"), "メモ");
  writeFileSync(join(root, "docs", "page.html"), "<script>alert(1)</script>");
  writeFileSync(join(top, "secret.txt"), "外");
  const file = join(root, "plans", "boxglow.json");
  writeFileSync(file, toJSON(createProject("t")));
  return { top, root, file };
}

describe("手元のファイルの場所を探す (resolveAttachedFile)", () => {
  it("計画のフォルダからの相対パスと、リポジトリの一番上からの相対パスの両方で見つかる", () => {
    const { root, file } = repo();
    expect(resolveAttachedFile(file, "notes/memo.md")).toBe(join(root, "plans", "notes", "memo.md"));
    expect(resolveAttachedFile(file, "docs/spec.md")).toBe(join(root, "docs", "spec.md"));
    expect(resolveAttachedFile(file, "./docs/spec.md#L3")).toBe(join(root, "docs", "spec.md"));
    expect(resolveAttachedFile(file, "docs/無い.md")).toBeNull();
    expect(resolveAttachedFile(file, "docs")).toBeNull(); // フォルダは開かない
  });
  it("リンクの行き先が手元のファイルかを見分ける (URL・ページ内リンクは対象外)", () => {
    expect(localTarget("docs/spec.md")).toBe("docs/spec.md");
    expect(localTarget("file:///home/a/b.md")).toBe("/home/a/b.md");
    expect(localTarget("C:\\work\\a.md")).toBe("C:\\work\\a.md");
    expect(localTarget("https://example.com/a")).toBeUndefined();
    expect(localTarget("mailto:a@example.com")).toBeUndefined();
    expect(localTarget("#見出し")).toBeUndefined();
    expect(localTarget("")).toBeUndefined();
  });
});

describe("serve の /api/file", () => {
  it("計画のフォルダとリポジトリの中のファイルだけを返し、HTML などは文字として sandbox 付きで返す", async () => {
    const { top, root, file } = repo();
    symlinkSync(join(top, "secret.txt"), join(root, "docs", "link.txt")); // リポジトリの外を指すリンク
    const dist = join(top, "dist"); mkdirSync(dist); writeFileSync(join(dist, "index.html"), "app");
    const server = startServe({ file, dist, port: 0, open: false, log: () => {} });
    try {
      await once(server, "listening");
      const port = (server.address() as { port: number }).port;
      const get = (path: string) => fetch(`http://127.0.0.1:${port}/api/file?path=${encodeURIComponent(path)}`);
      const md = await get("docs/spec.md");
      expect(md.status).toBe(200);
      expect(await md.text()).toBe("# 仕様");
      expect(md.headers.get("content-type")).toContain("text/plain");
      const html = await get("docs/page.html");
      expect(html.headers.get("content-type")).toContain("text/plain");
      expect(html.headers.get("content-security-policy")).toContain("sandbox");
      expect((await get("../secret.txt")).status).toBe(403);
      expect((await get(join(top, "secret.txt"))).status).toBe(403);
      expect((await get("docs/link.txt")).status).toBe(403);
      expect((await get("docs/無い.md")).status).toBe(404);
    } finally {
      server.close();
    }
  });
});

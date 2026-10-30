import { describe, expect, it } from "vitest";
import { splitLinks } from "./localLink";

describe("文中の URL とパスを見つける (splitLinks)", () => {
  const kinds = (s: string) => splitLinks(s).filter((p) => p.kind !== "text").map((p) => `${p.kind}:${p.text}`);
  it("日本語の文の途中のパスと URL を切り出す", () => {
    expect(kinds("詳しくは docs/design.md を参照。手順は https://example.com/a?b=1 にある")).toEqual(["path:docs/design.md", "url:https://example.com/a?b=1"]);
    expect(kinds("Doc/spec.mdを読む、./src/app.ts と ../x/y.json")).toEqual(["path:Doc/spec.md", "path:./src/app.ts", "path:../x/y.json"]);
    expect(kinds("(https://example.com/x)。")).toEqual(["url:https://example.com/x"]);
  });
  it("パスらしくないもの (/ が無い・拡張子が無い・分数や日付) は切り出さない", () => {
    expect(kinds("vitest 53 件成功; e2e 34/34")).toEqual([]);
    expect(kinds("README.md と 2026/10/31 と a/b")).toEqual([]);
    expect(kinds("OpenAPI 3.1 / PNG 1920x1080")).toEqual([]);
  });
  it("つなげると元の文に戻る", () => {
    const s = "前 docs/a.md 中 https://x.example/y 後";
    expect(splitLinks(s).map((p) => p.text).join("")).toBe(s);
  });
});

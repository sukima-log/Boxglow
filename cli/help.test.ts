import { describe, expect, it } from "vitest";
import { commandHelp } from "./help";

// 実際のヘルプと同じ形の短い見本 (書式の行は 2 字下げ、続きの行は深い字下げ、最後に共通の説明)
const HELP = `
boxglow CLI

使い方 (npx boxglow <command> ...):
  claim <block> [--scope subtree]                受け持つ
  claims                                         受け持ちの一覧
  claim-renew <block>                            受け持ちを延ばす
  context <block> [--brief]                      ボックスのコンテキスト
                                                 --brief = 短い形
  sync [--file <path>]                           同期する
  sync --unbind                                  同期をやめる

  lang [ja|en]                                   言語
共通: --lang <ja|en>
      --file <path>
<block> は短い ID (B12)
`;

describe("commandHelp (コマンドごとのヘルプ)", () => {
  it("そのコマンドの書式の行と続きの行に、共通の説明と案内を添える", () => {
    const out = commandHelp(HELP, "context", "全部: boxglow help")!;
    expect(out.split("\n")).toEqual([
      "  context <block> [--brief]                      ボックスのコンテキスト",
      "                                                 --brief = 短い形",
      "",
      "共通: --lang <ja|en>",
      "      --file <path>",
      "<block> は短い ID (B12)",
      "",
      "全部: boxglow help",
    ]);
  });
  it("名前の一部が同じ別のコマンド (claims / claim-renew) は含めない", () => {
    const out = commandHelp(HELP, "claim", "")!;
    expect(out).toContain("claim <block> [--scope subtree]");
    expect(out).not.toContain("claims");
    expect(out).not.toContain("claim-renew");
  });
  it("同じコマンドの書式の行が複数あれば全部出す", () => {
    const out = commandHelp(HELP, "sync", "")!;
    expect(out).toContain("sync [--file <path>]");
    expect(out).toContain("sync --unbind");
    expect(out).not.toContain("lang [ja|en]");
  });
  it("無いコマンドは null (呼び出し側が全部のヘルプを出す)", () => {
    expect(commandHelp(HELP, "nothing", "")).toBeNull();
    expect(commandHelp(HELP, "con.ext", "")).toBeNull();
  });
});

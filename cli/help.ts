/**
 * CLI のヘルプを、1 つのコマンドの分だけに絞る (help <コマンド> / <コマンド> --help)
 * 全部のヘルプは約 24KB ある。AI が書式を確かめるたびに全部を読むと、その後のやり取りのたびに文脈として読み直される
 * (2026-11-04 の計測: Codex が --help を 6 回呼び、どれも全部のヘルプ (合わせて 150KB) を受け取っていた)
 */

/**
 * ヘルプの全文から、1 つのコマンドの節を取り出す
 * Input : help = ヘルプの全文 (cli/main.ts の HELP_JA / HELP_EN。書式の行は 2 字下げでコマンド名から始まり、続きの行はそれより深く字下げされている),
 *         cmd = コマンド名 (例: "context"。"claim" は "claims" や "claim-renew" には当たらない),
 *         more = 最後に添える案内 (全部の一覧の出し方)
 * Output: そのコマンドの書式の行 (同じコマンドの行が複数あれば全部) と続きの行 + 共通の指定の説明 (「共通:」/「Common:」から最後まで) + 案内。
 *         そのコマンドの行が無ければ null (呼び出し側は全部のヘルプを出す)
 */
export function commandHelp(help: string, cmd: string, more: string): string | null {
  const lines = help.split("\n");
  // コマンド名に正規表現の記号が入っていても、文字どおりに比べる
  const head = new RegExp(`^  ${cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`);
  const picked: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!head.test(lines[i])) continue;
    picked.push(lines[i]);
    // 続きの行 (3 字以上の字下げ) は、次のコマンドの行か空行まで
    for (let j = i + 1; j < lines.length && /^ {3,}\S/.test(lines[j]); j++) picked.push(lines[j]);
  }
  if (picked.length === 0) return null;
  // 共通の指定 (--lang / --context-token / --file / --actor) と <block> の書き方は、どのコマンドにも要るので添える
  const common = lines.findIndex((l) => /^(共通|Common):/.test(l));
  const tail = common >= 0 ? lines.slice(common).join("\n").trimEnd() : "";
  // 1 行目の字下げは残す (続きの行と桁がそろう)
  return [picked.join("\n"), tail, more].filter(Boolean).join("\n\n");
}

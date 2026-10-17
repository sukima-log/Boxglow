/**
 * Codex の設定ファイル (~/.codex/config.toml) に、ホスト型 MCP の [mcp_servers.boxglow] を足す / 置き換える
 *   - 置き換える範囲は、行ごとの読み取りで決める (コメント・文字列・引用符付きのキーを見分ける。ほかの行はそのまま残す)
 *   - 書き戻す前に、TOML パーサー (smol-toml) で元と結果の両方を読み、Boxglow 以外の値が前後で同じであること・結果に Boxglow の表が
 *     期待どおりに 1 つあることを確かめる。確かめられなければ書き戻さず例外 (呼び出し側は「設定ファイルを書けませんでした (理由)」と手で置く手順を出す)
 *   - ブラウザ版では使わない (serve / VS Code / CLI の agent-config.ts から呼ぶ)。Codex レビュー 29 〜 29d
 */
import { parse as parseToml } from "smol-toml";
import { codexConfig, mcpUrlOf } from "./agent";

type Multi = '"""' | "'''" | null;

/**
 * TOML の 1 行を文字ごとに読み、コメントと文字列を見分ける
 *   - 文字列 (基本 "..."、リテラル '...'、複数行の 3 つ引用符) の中身は code に含めない (引用符は残す)。# はコメントの始まり (文字列の中は除く)
 *   - 基本文字列のエスケープ (\" など) を解釈して、閉じる位置を間違えない
 * Input : raw = 1 行, multi = 行の始めに複数行の文字列の中にいればその区切り
 * Output: { kept = コメントだけを除いた本文 (見出し・キーの判定に使う), multi = 行の終わりの状態, inString = 行の始めが文字列の中だったか }
 */
function readTomlLine(raw: string, multi: Multi): { kept: string; multi: Multi; inString: boolean } {
  const inString = multi !== null;
  let kept = "";
  let i = 0;
  while (i < raw.length) {
    if (multi !== null) {
      // 複数行の文字列の中: 閉じる区切りを探す (基本文字列はエスケープを飛ばす)
      let j = i;
      while (j < raw.length && !raw.startsWith(multi, j)) { if (multi === '"""' && raw[j] === "\\") j++; j++; }
      if (j >= raw.length) { kept += raw.slice(i); return { kept, multi, inString }; }   // この行では閉じない
      kept += raw.slice(i, j + 3); i = j + 3; multi = null;
      continue;
    }
    const ch = raw[i];
    if (ch === "#") break;                                    // コメント: 行の残りは本文ではない
    if (raw.startsWith('"""', i) || raw.startsWith("'''", i)) { multi = raw.slice(i, i + 3) as Multi; kept += multi; i += 3; continue; }
    if (ch === '"' || ch === "'") {
      // 1 行の文字列: 中身も kept に残す (引用符付きのキーを元の文字で読むため)
      let j = i + 1;
      while (j < raw.length && raw[j] !== ch) { if (ch === '"' && raw[j] === "\\") j++; j++; }
      const endAt = Math.min(j + 1, raw.length);
      kept += raw.slice(i, endAt); i = endAt; continue;
    }
    kept += ch; i++;
  }
  return { kept, multi, inString };
}

/**
 * キーの列 (a.b."c d".'e') を読む (見出しの中と、代入の左辺で使う)
 *   引用符付きのキーは中身をそのまま名前にする。基本文字列のキーにエスケープ (\) があれば例外 (解釈しない)
 * Input : text, at = 読み始める位置。Output: { keys, end = 読み終えた位置 }。キーが無ければ keys は空
 */
function readKeys(text: string, at: number): { keys: string[]; end: number } {
  const keys: string[] = [];
  let i = at;
  const skipWs = () => { while (i < text.length && (text[i] === " " || text[i] === "\t")) i++; };
  for (;;) {
    skipWs();
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) { if (ch === '"' && text[j] === "\\") throw new Error("config.toml has an escaped quoted key; replace the Boxglow entry by hand"); j++; }
      if (j >= text.length) return { keys, end: i };          // 閉じていない: キーではない
      keys.push(text.slice(i + 1, j)); i = j + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
      if (!m) return { keys, end: i };
      keys.push(m[0]); i += m[0].length;
    }
    skipWs();
    if (text[i] !== ".") return { keys, end: i };
    i++;
  }
}

/**
 * 表の見出し行 ([a.b] / [[a.b]]) を読む
 * Input : kept = コメントを除いた 1 行。Output: 表のキーの列 (["a", "b"]。引用符の中のドットは区切りではないので、文字列に平坦化しない)。見出しでなければ null。
 *         [ で始まるのに見出しとして読めない行は例外 (配列の続きの行など、この読み取りでは扱えない形)
 */
function parseHeader(kept: string): string[] | null {
  const s = kept.trimStart();
  if (!s.startsWith("[")) return null;
  const array = s.startsWith("[[");
  const { keys, end } = readKeys(s, array ? 2 : 1);
  const close = array ? "]]" : "]";
  if (keys.length > 0 && s.startsWith(close, end) && s.slice(end + close.length).trim() === "") return keys;
  throw new Error("config.toml has a line starting with [ that is not a table header; replace the Boxglow entry by hand");
}

/**
 * 代入の左辺 (キーの列 = ...) を読む。Input: kept = コメントを除いた 1 行。Output: キーの列。代入の行でなければ null
 */
function parseAssignmentKeys(kept: string): string[] | null {
  const { keys, end } = readKeys(kept, 0);
  if (keys.length === 0) return null;
  return kept.slice(end).trimStart().startsWith("=") ? keys : null;
}

/**
 * config.toml を行ごとに読み、各行が「どの表の見出しか」を出す
 *   次の形は、置き換えると二重定義や取り違えになるので例外にする (呼び出し側は書き戻さず、手で置く手順を出す):
 *     ルートに mcp_servers (引用符付きでも) のキーがある / [mcp_servers] の表の中に boxglow のキーがある / 見出しやキーにエスケープがある /
 *     [ で始まるのに見出しとして読めない行がある
 * Input : text = ファイルの中身。Output: { lines, headers } (headers[i] = i 行目の表のキーの列、見出しでなければ null)
 */
function scanCodexConfig(text: string): { lines: string[]; headers: (string[] | null)[] } {
  const lines = text.split("\n");
  const headers: (string[] | null)[] = [];
  let multi: Multi = null;           // 複数行の文字列の中にいるか (その区切り)
  let table: string[] | null = null;   // 今いる表 (null = ルート)
  for (const raw of lines) {
    const r = readTomlLine(raw, multi);
    multi = r.multi;
    if (r.inString) { headers.push(null); continue; }        // 行の始めが文字列の中: 見出しにならない
    const h = parseHeader(r.kept);
    if (h !== null) { headers.push(h); table = h; continue; }
    headers.push(null);
    const keys = parseAssignmentKeys(r.kept);
    if (!keys) continue;
    if (table === null && keys[0] === "mcp_servers") throw new Error("config.toml defines mcp_servers as a value at the top level; replace the Boxglow entry by hand");
    if (table !== null && table.length === 1 && table[0] === "mcp_servers" && keys[0] === "boxglow") throw new Error("config.toml defines boxglow inline under [mcp_servers]; replace it by hand");
  }
  return { lines, headers };
}

/** 値を、キーの順に依らない文字列にする (前後の比較用)。Input: 任意の値。Output: 文字列 */
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  // (パーサーが作る表は prototype の無いオブジェクトのことがあるので、Date 以外のオブジェクトはすべて記録として扱う)
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return "{" + Object.keys(value as Record<string, unknown>).sort().map((k) => JSON.stringify(k) + ":" + stable((value as Record<string, unknown>)[k])).join(",") + "}";
  }
  return JSON.stringify(value instanceof Date ? value.toISOString() : value);
}

/** 読んだ設定から Boxglow の表を除いたもの (前後の比較用)。Input: parse の結果。Output: 複製 (mcp_servers.boxglow 抜き) */
function withoutBoxglow(doc: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...doc };
  const servers = copy.mcp_servers;
  if (servers && typeof servers === "object" && !Array.isArray(servers)) {
    const rest = { ...(servers as Record<string, unknown>) }; delete rest.boxglow;
    if (Object.keys(rest).length) copy.mcp_servers = rest; else delete copy.mcp_servers;
  }
  return copy;
}

/**
 * 既存の ~/.codex/config.toml に [mcp_servers.boxglow] を足す / 置き換える (その表の行だけを差し替え、ほかは残す)
 *   - 見出しにコメントや引用符が付いていても同じ表と見なす。boxglow の子の表 ([mcp_servers.boxglow.http_headers] など) も、まとめて置き換える
 *   - 書き戻す前に TOML として読み、Boxglow 以外の値が前後で同じ・結果の Boxglow の表が期待どおり、を確かめる。読めない・違えば例外
 * Input : existing = 今のファイルの中身 (無ければ null), server, token。Output: 書き戻す中身
 */
export function mergeCodexConfig(existing: string | null, server: string, token: string): string {
  const block = codexConfig(server, token);
  const text = existing ?? "";
  let before: Record<string, unknown>;
  try { before = parseToml(text) as Record<string, unknown>; } catch (e) { throw new Error("config.toml could not be parsed (" + (e instanceof Error ? e.message : String(e)) + "); replace the Boxglow entry by hand"); }
  const { lines, headers } = scanCodexConfig(text);
  // Boxglow の表 = ["mcp_servers", "boxglow"] ちょうど。子の表 = その 2 つを先頭に持つ 3 つ以上 ("boxglow.archive" のような 1 つのキーは別の表)
  const isBoxglow = (h: string[] | null) => h !== null && h.length === 2 && h[0] === "mcp_servers" && h[1] === "boxglow";
  const isBoxglowChild = (h: string[] | null) => h !== null && h.length > 2 && h[0] === "mcp_servers" && h[1] === "boxglow";
  const starts = headers.flatMap((h, i) => isBoxglow(h) ? [i] : []);
  if (starts.length > 1) throw new Error("config.toml has [mcp_servers.boxglow] more than once; the file was not changed");
  const start = starts[0] ?? -1;
  let merged: string;
  if (start < 0) merged = text.trim() ? text.replace(/\s*$/, "\n\n") + block : block;
  else {
    // 次の表 ([...]) の手前までが boxglow の表。boxglow の子の表 (mcp_servers.boxglow.*) はその中身ごと含める
    let end = start + 1;
    while (end < lines.length && (headers[end] === null || isBoxglowChild(headers[end]))) end++;
    merged = [...lines.slice(0, start), ...block.trimEnd().split("\n"), ...lines.slice(end)].join("\n").replace(/\n*$/, "\n");
  }
  // 書き戻す前に確かめる: 結果が TOML として読める・Boxglow 以外の値が前後で同じ・Boxglow の表が期待どおり
  let after: Record<string, unknown>;
  try { after = parseToml(merged) as Record<string, unknown>; } catch { throw new Error("config.toml could not be merged safely (the result is not valid TOML); the file was not changed"); }
  if (stable(withoutBoxglow(before)) !== stable(withoutBoxglow(after))) throw new Error("config.toml could not be merged safely (other settings would change); the file was not changed");
  const expected = { url: mcpUrlOf(server), http_headers: { Authorization: `Bearer ${token}` } };
  const got = (after.mcp_servers as Record<string, unknown> | undefined)?.boxglow;
  if (stable(got) !== stable(expected)) throw new Error("config.toml could not be merged safely (the Boxglow entry is not as expected); the file was not changed");
  return merged;
}

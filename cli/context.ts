/**
 * AI の引き継ぎ (guard) の確認トークン
 * `boxglow context <block>` で返すコンテキスト (指示・回答・入出力条件・引き継ぎ) の中身からトークンを作り、
 * guard が有効な計画では、作業を記録するコマンドがそのトークンを要求する。
 * 読んだ後に人が回答や指示を変えるとトークンが変わるので、古い内容のまま作業を進めるのを止められる
 * (トークンは「どの版を取得したか」の照合であって、AI が内容を理解したことの証明ではない)
 */
import { createHash } from "node:crypto";
import { agentContext, briefContext } from "../src/model/context";
import { isHumanActor } from "../src/model/graph";
import type { Artifact, Project } from "../src/model/types";
// 文言を今の言語 (日本語 / 英語) で出す
import { t } from "../src/i18n/core";

/**
 * オブジェクトのキーを並べ直して、同じ中身なら必ず同じ JSON になるようにする (ハッシュを安定させるため)
 * Input : value = 任意の値 (配列・オブジェクトは中まで辿る)
 * Output: キーを名前順に並べた同じ中身の値
 */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  }
  return value;
}

/**
 * 成果物から、内容に関係なく変わる値を外す (確認トークンの計算用)
 * checkedAt / state は `check` を実行するたびに書き換わる「確認の記録」で、指示や成果物の内容ではない。
 * これをトークンに含めると、check のたびに全員のトークンが無効になる
 * Input : artifacts = 成果物の配列 (無ければ undefined)
 * Output: checkedAt と state を除いた成果物の配列 (元の配列は書き換えない)
 */
function artifactsForToken(artifacts: Artifact[] | undefined): unknown {
  return (artifacts ?? []).map(({ checkedAt: _checkedAt, state: _state, ...rest }) => rest);
}

/**
 * ボックスのコンテキストと、その確認トークンを作る (CLI の context / MCP の boxglow_context の出力)
 * Input : p = 計画, id = ボックスの内部 id
 * Output: { contextToken = コンテキストの SHA-256 (16 進), context = agentContext の結果 }
 *         トークンは、context から成果物の確認の記録 (checkedAt / state) を除いたものから作る (出力の context にはそのまま載せる)
 */
export function contextReceipt(p: Project, id: string) {
  const context = agentContext(p, id);
  const forToken = {
    ...context
  , blocks: context.blocks.map(({ freshness: _freshness, ...b }) => ({
      ...b
    , artifacts: artifactsForToken(b.artifacts)
    , ports: b.ports.map((port) => ({ ...port, artifacts: artifactsForToken(port.artifacts) }))
    }))
    // 束ねた出力の中身 (中の出力の説明・資料の参照・束ね先) も、変わったら読み直しを求める
  , bundledOutputs: context.bundledOutputs.map((o) => ({ ...o, artifacts: artifactsForToken(o.artifacts) }))
  };
  const token = createHash("sha256").update(JSON.stringify(stable(forToken))).digest("hex");
  return { contextToken: token, context };
}

/**
 * ボックスの短いコンテキストと、確認トークンを作る (CLI の context --brief / MCP の boxglow_context の brief)
 * 確認トークンは、全部のコンテキスト (contextReceipt) と同じ値。短い表示で省いた部分が変わっても、トークンは変わる
 * (短い表示は「見せ方」を変えるだけで、「何が変わったら読み直しを求めるか」は変えない)
 * Input : p = 計画, id = ボックスの内部 id
 * Output: { contextToken, context = briefContext の結果 }
 */
export function briefReceipt(p: Project, id: string) {
  return { contextToken: contextReceipt(p, id).contextToken, context: briefContext(p, id) };
}

/**
 * guard が有効な計画で、渡されたトークンが今のコンテキストと一致するか確かめる
 * Input : p = 計画, id = ボックスの内部 id, token = --context-token の値 (無ければ undefined),
 *         actor = 操作する人 / AI の名前 (省略時は AI として扱う)
 * Output: なし。guard が無効 (contextGuard が無い古い計画を含む) なら何もしない。
 *         actor が人 ("human" / "human:名前") のときも何もしない (guard は AI が古い指示のまま進めるのを防ぐ仕組みで、人の操作を止める理由が無い)。
 *         有効でトークンが無い・古いときは例外を投げる (呼び出し側は何も書き込まずに終わる)
 */
export function requireContext(p: Project, id: string, token?: string, actor?: string): void {
  if (!p.contextGuard || (actor !== undefined && isHumanActor(actor))) return;
  if (token !== contextReceipt(p, id).contextToken) {
    throw new Error(t("先に boxglow context {block} を読み、--context-token <contextToken> を付けてやり直してください。指示・回答・引き継ぎが未読か、読んだ後に変更されています", { block: p.blocks[id]?.key ?? id }));
  }
}

/**
 * 渡されたトークンが、計画の中のどれかのボックスの今のコンテキストと一致するか確かめる (AI が guard を無効にするとき用)
 * Input : p = 計画, token = --context-token の値 (無ければ undefined)
 * Output: 一致するボックスがあれば true (最新のコンテキストを 1 つは読んでいる)。トークンが無い・どれとも一致しないなら false
 */
export function isCurrentToken(p: Project, token?: string): boolean {
  return !!token && Object.keys(p.blocks).some((id) => contextReceipt(p, id).contextToken === token);
}

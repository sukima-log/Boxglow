/**
 * 着手・完了、作業範囲、記録の鮮度を CLI / MCP / 画面で共用する。
 * 判定と表示だけを行い、本文や計画はここでは書き換えない。
 */
import type { Block, Project, WorkScope } from "./types";
import { isHumanActor, portsOf, waitingFor } from "./graph";
import { isSkipped } from "./branch";
import { nextSteps, reasonText, unpreparedReasons } from "./readiness";
import { t } from "../i18n/core";

/** Input: なし / Output: 作業範囲の項目と表示名 (翻訳は表示時)。 */
export const SCOPE_FIELDS = [
  ["goal", "今回達成すること"],
  ["nonGoals", "今回は扱わないこと"],
  ["acceptance", "完了と判断する条件"],
  ["consult", "範囲を広げる前に相談する条件"],
] as const;

/** Input: 任意の範囲 / Output: 本文のある項目だけ (空欄を画面に増やさない)。 */
export function scopeEntries(scope?: WorkScope) {
  return SCOPE_FIELDS.filter(([key]) => scope?.[key]?.trim()).map(([key, label]) => ({ key, label: t(label), text: scope![key]! }));
}

/** Input: 計画、ボックス id / Output: 今回の対象またはその子孫なら true。循環でも停止する。 */
export function inFocus(p: Project, id: string): boolean {
  if (!p.focusBlockId || !p.blocks[p.focusBlockId]) return false;
  const seen = new Set<string>();
  let at: string | null = id;
  while (at && !seen.has(at)) {
    if (at === p.focusBlockId) return true;
    seen.add(at);
    at = p.blocks[at]?.parentId ?? null;
  }
  return false;
}

/**
 * 次の候補を、今回の対象を先に、準備の状態 (着手できる / 要具体化 / 入力待ち) で分けた一覧にする
 * Input : 計画、未着手の候補
 * Output: 組の一覧 (空の組は出さない)。各組の state = ready | unprepared | waiting、ready は state === "ready" (古い利用側のため)。
 *   要具体化と入力待ちの両方があるボックスは「要具体化」の組に入れ、待ちの名前も項目に残す (両方の不足が読める)
 */
export function candidateGroups(p: Project, blocks: Block[]) {
  const focused = !!p.focusBlockId && !!p.blocks[p.focusBlockId];
  // 待ちの理由: 必須の入力と、まだ答えていない分岐 (分岐待ちは「入力待ち」の組に入る)。要具体化の理由は別に持つ
  const candidates = blocks.map(b => {
    const reasons = unpreparedReasons(p, b.id);
    const missingInputs = waitingFor(p, b.id);
    const state: "ready" | "unprepared" | "waiting" = reasons.length ? "unprepared" : missingInputs.length ? "waiting" : "ready";
    return { blockId: b.id, key: b.key, title: b.title, inFocus: inFocus(p, b.id), missingInputs, unprepared: reasons.map(r => reasonText(p, r)), state };
  });
  const label = { ready: "着手できる", unprepared: "要具体化", waiting: "入力待ち" } as const;
  return (focused ? [true, false] : [false]).flatMap(scope =>
    (["ready", "unprepared", "waiting"] as const).map(state => ({
      inFocus: scope, ready: state === "ready", state,
      title: (focused ? (scope ? t("今回の範囲") : t("その他の候補")) + " · " : "") + t(label[state]),
      items: candidates.filter(c => c.inFocus === scope && c.state === state),
    }))).filter(g => g.items.length);
}

/**
 * 着手の前の確認 (CLI の start と MCP で共用)
 * Input : 計画、ボックス、操作者、入力待ちで開始する理由
 * Output: { warning, error }。warning は出して開始する。error があれば開始しない
 *   2 つを別々に判定する:
 *   - 入力待ち (必須の入力・分岐の答え): 理由 (--reason) があれば開始できる。startWithoutInputs = reject なら AI は理由が要る
 *   - 要具体化 (自身が作る出力が無い、予定成果物・完了条件が未定): 理由では通れない。startUnprepared = reject なら AI は開始できない
 *   人 (human) はどちらも拒否しない
 */
export function checkStart(p: Project, id: string, actor: string, reason = "") {
  // 見送りのボックス (選ばなかった分岐の道) は、やらない仕事。理由が無ければ警告する (拒否はしない。判断をやり直す前の下調べなどがあるため)
  if (isSkipped(p, id) && !reason.trim()) return { warning: t("選ばなかった分岐の道 (見送り) のボックスです。進める理由があれば --reason で記録してください"), error: "" };
  const warnings: string[] = [];
  const errors: string[] = [];
  const human = isHumanActor(actor);
  // 1. 必須の入力と、まだ答えていない分岐 (分岐待ちのボックスに着手すると、選ばれない道の仕事になるかもしれない)
  const names = waitingFor(p, id);
  if (names.length && !reason.trim()) {
    const warning = t("必須の入力待ち: {names}", { names: names.join(", ") });
    if (p.workflowPolicy?.startWithoutInputs === "reject" && !human) errors.push(warning + " " + t("開始する理由を --reason で記録してください。"));
    else warnings.push(warning);
  }
  // 2. 要具体化: 理由 (--reason) では通れない (入力待ちの例外とは別の規則)
  const reasons = unpreparedReasons(p, id, { forStart: true });
  if (reasons.length) {
    const text = [t("要具体化:"), ...reasons.map((r) => "- " + reasonText(p, r)), t("次:"), ...nextSteps(p, id, reasons).map((x) => "  " + x)].join("\n");
    if (p.workflowPolicy?.startUnprepared === "reject" && !human) errors.push(text);
    else warnings.push(text);
  }
  return { warning: warnings.join("\n"), error: errors.join("\n") };
}

/** Input: 計画、ボックス、新規成果物の数、操作者 / Output: 成果物なしの警告・拒否理由。参考資料は成果物に数えない。 */
export function checkDone(p: Project, id: string, added: number, actor: string) {
  const outputs = portsOf(p, id, "out");
  const hasOutput = outputs.some(x => x.artifacts.length > 0);
  // 付け先が無い新規成果物は実際には保存されないため、完了の根拠に数えない。
  if ((added > 0 && outputs.length > 0) || hasOutput) return { warning: "", error: "" };
  const warning = t("注意: 成果物が付いていません。--artifact \"<名前>=<パスまたは URL>\" で、人が後から開ける具体的な物を付けてください");
  return { warning, error: p.workflowPolicy?.doneWithoutArtifacts === "reject" && !isHumanActor(actor) ? warning : "" };
}

/** Input: ボックス、記録日時 / Output: 状態変更より古いか。不明は断定せず unknown を返す。 */
export function noteFreshness(b: Block, at?: string): "older" | "current" | "unknown" {
  if (!at || !b.statusChangedAt) return "unknown";
  const written = Date.parse(at), changed = Date.parse(b.statusChangedAt);
  if (!Number.isFinite(written) || !Number.isFinite(changed)) return "unknown";
  return written < changed ? "older" : "current";
}

/**
 * 記録の日時と鮮度を短い文にする
 * Input : b = ボックス, at = 記録日時 (無ければ undefined),
 *         show = いつ文を出すか: "always" = 常に (日時が無ければ「記録日時不明」), "known" = 日時が分かるときだけ,
 *                "older" = 状態の変更より前の記録だと分かったときだけ
 *         (日時を記録する前から在る計画では、ほとんどの説明に日時が無い。そのたびに「不明」と出すと、読む量が増えるだけなので、
 *          人が読む一覧や画面では "known" / "older" を使う)
 * Output: 絶対日時と鮮度の文 (経過時間だけにしない)。出さない場合は空文字
 */
export function freshnessText(b: Block, at?: string, show: "always" | "known" | "older" = "always"): string {
  const freshness = noteFreshness(b, at);
  if ((show === "known" && !at) || (show === "older" && freshness !== "older")) return "";
  const when = at ? t("記録: {at}", { at }) : t("記録日時不明");
  return when + (freshness === "older" ? " · " + t("このメモは状態の変更より前のものです")
    : freshness === "unknown" ? " · " + t("現在の状態と照合してください") : "");
}

/** Input: ボックス / Output: Done なのに古い状況説明が残る可能性の案内。本文は変更しない。 */
export function descriptionReminder(b: Block): string {
  if (b.status !== "white" || !b.description.trim()) return "";
  // 文意は断定しない。「レビュー待ちではない」等も検出し得るため、削除ではなく見直しを促す。
  // 「作業中」「In Progress」「未完了」は、機能や状態の名前として説明に普通に出てくるので対象にしない
  // (実際の開発計画では、これらの語で出た案内 6 件がすべて誤検出だった)。途中の状況を表す言い回しだけを拾う
  if (/未コミット|レビュー待ち|公開待ち|操作待ち|未実施|uncommitted|awaiting review|pending review|not yet (?:committed|published)/i.test(b.description)) {
    return t("Done になっています。説明に以前の状況が残っていないか確認してください (本文は変更していません)。");
  }
  return "";
}

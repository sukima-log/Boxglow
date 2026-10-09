/**
 * 担当の一覧 (表): あるメンバーが担当するボックスを、表の行として取り出す
 * 画面の「表で見る」と CLI の `boxglow list` が同じ行を使う (表示の違いだけを各側で持つ)
 */
import { ancestorsOf, effectiveProgress, kindOf, missingRequiredInputs } from "./graph";
import { ROOT_ID, type BlockStatus, type Project } from "./types";

/** 誰の担当を出すか: メンバーの id / 未担当 */
export type AssigneeTarget = { memberId: string } | { unassigned: true };

/** 表の 1 行 */
export interface AssignmentRow {
  /** ボックスの id (画面で、そのボックスへ移るときに使う) */
  id: string;
  /** 人が読める短い ID (B12)。無い古い計画では空 */
  key: string;
  title: string;
  /** 場所: 大項目 › 中項目 (プロジェクトのボックスと最上位は含めない)。大項目そのものなら空 */
  where: string;
  status: BlockStatus;
  /** 進捗 (0〜100。手入力が無ければ下の階層から計算した値) */
  progress: number;
  /** 期日 (YYYY-MM-DD) と、今日を過ぎているか (完了済みは過ぎていても false) */
  dueDate?: string;
  overdue: boolean;
  /** 見積もり (時間) */
  estimateHours?: number;
  /** まだ届いていない必須の入力の名前 (空なら、そろっている) */
  missingInputs: string[];
  /** 未回答の判断 (人への質問) の数 */
  pendingDecisions: number;
}

/**
 * 担当のボックスを、表の行として取り出す
 * Input : p = 計画, target = 誰の担当か (メンバーの id、または未担当),
 *         opts.includeDone = true なら完了済み (Done) も含める (既定は含めない),
 *         opts.today = 今日 (YYYY-MM-DD。期日を過ぎたかの判定。省略時は実行環境の今日)
 * Output: 行の配列。並びは「期日の近い順 (期日の無いものは後ろ)」→「B 番号の順」。
 *         プロジェクトのボックスと最上位は含めない (タスクではないため)
 */
export function assignmentRows(p: Project, target: AssigneeTarget, opts: { includeDone?: boolean; today?: string } = {}): AssignmentRow[] {
  const today = opts.today ?? localToday();
  const rows: AssignmentRow[] = [];
  for (const b of Object.values(p.blocks)) {
    // タスクだけ (最上位とプロジェクトのボックスは、担当を付けても一覧には出さない)
    if (b.id === ROOT_ID || kindOf(b) === "project") continue;
    // 担当の判定: メンバーの担当か、担当がいないか
    const mine = "memberId" in target ? b.assigneeIds.includes(target.memberId) : b.assigneeIds.length === 0;
    if (!mine) continue;
    if (b.status === "white" && !opts.includeDone) continue;
    // 場所: 先祖の題名を外側から並べる (最上位とプロジェクトのボックスは除く)
    const where = ancestorsOf(p, b.id).filter((a) => a.id !== ROOT_ID && kindOf(a) !== "project").reverse().map((a) => a.title).join(" › ");
    rows.push({
      id: b.id
    , key: b.key ?? ""
    , title: b.title
    , where
    , status: b.status
    , progress: effectiveProgress(p, b.id)
    , ...(b.dueDate ? { dueDate: b.dueDate } : {})
      // 期日を過ぎたか: 完了済みは対象外 (終わった仕事を赤く出さない)
    , overdue: !!b.dueDate && b.status !== "white" && b.dueDate < today
    , ...(typeof b.estimateHours === "number" ? { estimateHours: b.estimateHours } : {})
      // 入力の待ち: 完了済みは、もう材料を待たないので空にする
    , missingInputs: b.status === "white" ? [] : missingRequiredInputs(p, b.id).map((q) => q.name)
    , pendingDecisions: b.decisions.filter((d) => d.answer === undefined).length
    });
  }
  return rows.sort(compareRows);
}

/**
 * 既定の並び: 期日の近い順 (期日の無いものは後ろ) → B 番号の数の順 (B2 が B10 より先)
 * Input : 2 つの行 / Output: 並べ替えの比較の値
 */
export function compareRows(x: AssignmentRow, y: AssignmentRow): number {
  if (x.dueDate !== y.dueDate) {
    if (!x.dueDate) return 1;
    if (!y.dueDate) return -1;
    return x.dueDate < y.dueDate ? -1 : 1;
  }
  return keyNumber(x.key) - keyNumber(y.key);
}

/** B 番号の数の部分 (並べ替え用。無ければ最後に回す) */
const keyNumber = (key: string): number => {
  const m = /^B(\d+)$/.exec(key);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
};

/** 実行環境の今日 (YYYY-MM-DD、その土地の日付) */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

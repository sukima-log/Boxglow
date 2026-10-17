/**
 * 計画の要約 (横断の一覧用。B81-5)。計画の JSON 文字列から、箱の数・済んだ数・進行中・NOW の数・判断待ちの数を数える
 *   モデル (src/model) に依存しない最小の読み方にしてある (サーバー側にも同じ形の関数を置く。中身が暗号化されていても、要約は版を受けたときに計算できる)
 * Input : text = 計画の JSON 文字列。Output: 要約。読めなければ null
 */
export interface PlanSummary { total: number; done: number; inProgress: number; now: number; pending: number }

export function summarizePlanText(text: string): PlanSummary | null {
  try {
    const p = JSON.parse(text) as { blocks?: unknown; now?: unknown };
    const blocks = p.blocks && typeof p.blocks === "object" ? (Array.isArray(p.blocks) ? p.blocks : Object.values(p.blocks)) : [];
    let total = 0, done = 0, inProgress = 0, pending = 0;
    for (const v of blocks as Record<string, unknown>[]) {
      if (!v || typeof v !== "object" || v.kind === "project") continue;
      total++;
      if (v.status === "white") done++; else if (v.status === "gray") inProgress++;
      if (Array.isArray(v.decisions)) for (const d of v.decisions as Record<string, unknown>[]) if (d && typeof d === "object" && d.answer === undefined) pending++;
    }
    return { total, done, inProgress, now: Array.isArray(p.now) ? p.now.length : 0, pending };
  } catch { return null; }
}

/** 要約の応答を検証する (信頼しない入力)。形が合わなければ undefined */
export function parseSummary(v: unknown): PlanSummary | undefined {
  if (!v || typeof v !== "object") return undefined;
  const s = v as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
  return { total: n(s.total), done: n(s.done), inProgress: n(s.inProgress), now: n(s.now), pending: n(s.pending) };
}

/**
 * 文脈の圧縮の回数を数える (セッションごと・作業中の箱ごと)
 *   長い作業で圧縮が重なると、1 回の呼び出しで運ぶ文脈が大きくなり、細部が要約に置き換わって調べ直しが増える。
 *   回数を数えて、圧縮の後の差し込み (hook session-start) と、done のときの区切りの案内に使う。
 *   - 数えるのは hook session-start (Claude Code / Codex とも、圧縮の後に source = "compact" で呼ばれる)
 *   - 置き場所は手元の設定フォルダ (configDir()/compactions.json)。計画のファイルは書き換えない (圧縮のたびに計画に差分を出さない)
 *   - セッションの識別子はハッシュの先頭 8 文字 (sessionMark) だけを残す。値そのものは書かない (hooks.log と同じ)
 *   - 30 日より古いセッションと、新しい順で 300 件を超えた分は捨てる
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { configDir } from "./sync/state-store";

/** 1 つの箱がこの回数以上の圧縮をまたいだら、1 つのセッションに収まっていない (分けるよう案内する) */
export const BIG_BOX_COMPACTIONS = 3;

/** セッションの識別子の印 (SHA-256 の先頭 8 文字)。Input: 識別子。Output: 印 (無ければ "") */
export const sessionMark = (id: string | undefined): string => id ? createHash("sha256").update(id).digest("hex").slice(0, 8) : "";

/** 圧縮の回数。session = このセッションの回数、boxes = 箱の id ごとの、作業中にまたいだ回数 */
export interface CompactionCounts { session: number; boxes: Record<string, number> }

/** ファイルの中身。sessions のキーはセッションの印 */
interface Store { version: 1; sessions: Record<string, { at: string; count: number; boxes: Record<string, number> }> }

/** 数えたもののファイル。Input: なし。Output: パス */
export const compactionPath = (): string => join(configDir(), "compactions.json");

/**
 * ファイルを読む。無い・壊れているときは空 (数え直しになるだけで、作業は止めない)
 * Input : path。Output: Store
 */
function readStore(path: string): Store {
  try {
    if (!existsSync(path)) return { version: 1, sessions: {} };
    const v = JSON.parse(readFileSync(path, "utf8")) as Partial<Store>;
    return v && v.version === 1 && v.sessions && typeof v.sessions === "object" ? { version: 1, sessions: v.sessions } : { version: 1, sessions: {} };
  } catch { return { version: 1, sessions: {} }; }
}

/**
 * 古いものを捨てて書く (一時ファイルに書いてから置き換える。途中で止まっても壊れたファイルを残さない)
 * Input : path, store, now = 今の時刻。Output: なし (書けなくても何もしない)
 */
function writeStore(path: string, store: Store, now: Date): void {
  try {
    const limit = now.getTime() - 30 * 24 * 3600 * 1000;
    const kept = Object.entries(store.sessions)
      .filter(([, s]) => (Date.parse(s.at) || 0) >= limit)
      .sort((a, b) => b[1].at.localeCompare(a[1].at))
      .slice(0, 300);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, sessions: Object.fromEntries(kept) }) + "\n");
    renameSync(tmp, path);
  } catch { /* 数えられなくても、フックと done は続ける */ }
}

/**
 * 圧縮を 1 回数える (このセッションと、このセッションで作業中の箱)
 * Input : sessionId = セッションの識別子, boxIds = このセッションで作業中の箱の id, path = 置き場所 (試験用), now = 今の時刻 (試験用)
 * Output: 数えた後の回数
 */
export function recordCompaction(sessionId: string, boxIds: string[], path = compactionPath(), now = new Date()): CompactionCounts {
  const store = readStore(path);
  const mark = sessionMark(sessionId);
  const cur = store.sessions[mark] ?? { at: now.toISOString(), count: 0, boxes: {} };
  const boxes = { ...cur.boxes };
  for (const id of boxIds) boxes[id] = (boxes[id] ?? 0) + 1;
  store.sessions[mark] = { at: now.toISOString(), count: cur.count + 1, boxes };
  writeStore(path, store, now);
  return { session: cur.count + 1, boxes };
}

/**
 * このセッションの圧縮の回数を読む (書かない)
 * Input : sessionId = セッションの識別子 (無ければ 0 回), path = 置き場所 (試験用)
 * Output: 回数 (数えていなければ 0 回)
 */
export function compactionsOf(sessionId: string | undefined, path = compactionPath()): CompactionCounts {
  if (!sessionId) return { session: 0, boxes: {} };
  const s = readStore(path).sessions[sessionMark(sessionId)];
  return s ? { session: s.count, boxes: { ...s.boxes } } : { session: 0, boxes: {} };
}

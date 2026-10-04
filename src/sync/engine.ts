/**
 * 同期の判断 (通信もファイルも含まない、純粋な関数)
 * 「手元 L・基準 B・サーバー R・残っている操作」から、次に行うことを 1 つ決める。実際の読み書きと通信は、呼び出し側 (CLI の同期の処理) が行う。
 * 方式: サーバーは版つきの置き場で、統合は手元で行う。流れは「受け取って統合する → 送る」。
 *
 * 守る条件:
 *   1. 基準 B は「サーバーが受理した」または「サーバーから受け取って手元に書けた」と確かめた中身だけ。
 *   2. まだ送っていない変更は、必ず手元 L に残る (同期が L を古い中身に戻さない)。
 *   3. 確かめられないとき (受け取りを手元に書けたか分からない、サーバーの履歴の世代が変わった、操作の記録が古すぎる) は、
 *      推測で進めずに止まり (halt)、人に確かめる。
 * この関数は状態を書き換えない。状態の進め方は、下の「状態を進める関数」(recordPending / pushAccepted など) が新しい状態を返す。
 */
import { fromJSON, toJSON, KNOWN_PROJECT_KEYS } from "../model/graph";
import { mergeProjects, type MergeConflict } from "../model/merge";
import { projectProblem, validateProjectText } from "../model/validate-file";
import type { Project } from "../model/types";

/** サーバーが発行する版。「履歴の世代」と番号の組だが、クライアントは中身を解釈しない 1 つの文字列として扱う */
export type Revision = string;

/** 中身とそのハッシュ (ハッシュは、送受信した文字列そのものの SHA-256。呼び出し側が計算して渡す) */
export interface Content {
  hash: string;
  text: string;
}

/** 基準: 手元とサーバーの両方が持っていると確かめた中身 (のハッシュ) と、そのときのサーバーの版 */
export interface Base {
  hash: string;
  revision: Revision;
}

/** 残っている「送り」の操作: 送る前に記録し、受理を確かめるまで残す */
export interface PendingPush {
  kind: "push";
  /** 操作 ID (同じ操作の送り直しを、サーバーが同じものと見分ける) */
  opId: string;
  /** 送ると決めて固定した中身 S のハッシュ */
  hash: string;
  /** 前提にするサーバーの版 (計画を新しく作るときは null) */
  expected: Revision | null;
  /** 記録した日時 (ISO 8601) */
  at: string;
}

/** 残っている「受け取り」の操作: 手元に書く前に記録し、基準を進めるまで残す */
export interface PendingPull {
  kind: "pull";
  /** 手元に書く中身 (サーバーの中身 R、または統合した結果 M) のハッシュ */
  hash: string;
  /** 書くときに前提にした手元の中身のハッシュ (手元にファイルが無かったなら null) */
  expectedLocal: string | null;
  /** 取り込んだサーバーの中身。書けたら、これが新しい基準になる (M ではなく R) */
  remote: Base;
  /** 記録した日時 (ISO 8601) */
  at: string;
}

export type Pending = PendingPush | PendingPull;

/** 止まった理由 (人に確かめる内容) */
export type Halt =
  /** 統合で、人の選択が要る競合があった。選択は、この組 (基準・手元・サーバー) に対してだけ有効 */
  | { reason: "conflicts"; base: Base; localHash: string; remoteRevision: Revision; conflicts: MergeConflict[] }
  /** 統合の結果が、計画として正しくない (競合が 0 件でも起こる。互いのボックスを相手の中へ移した、など) */
  | { reason: "invalid-merge"; problem: string }
  /** 手元 / サーバーの中身が、計画として読めない */
  | { reason: "invalid-local"; problem: string }
  | { reason: "invalid-remote"; problem: string }
  /** 受け取りを手元に書けたのか分からない (書く直前に記録してから、基準を進めるまでの間に落ちた) */
  | { reason: "recover-pull"; pending: PendingPull; localHash: string | null }
  /** 基準に在った「保護する項目」が手元で消えている。誰が書いたかにかかわらず、送る前に一度確かめる */
  | { reason: "protected-deletion"; keys: string[]; approval: string }
  /** サーバーの履歴の世代が変わった (バックアップからの復旧など)。古い基準や操作を、そのまま使えない */
  | { reason: "history-changed"; expected: string; actual: string }
  /** 残っている送りの操作が古すぎる、または日時が信頼できない (サーバーの記録が消えているかもしれない) */
  | { reason: "stale-operation"; pending: PendingPush }
  /** 初めて結び付けるときに、手元とサーバーの両方に違う中身がある。どちらを採るかを人が選ぶ */
  | { reason: "first-link"; localHash: string; remoteRevision: Revision }
  /** サーバー側で計画が消されている (勝手に作り直さない) */
  | { reason: "remote-deleted" }
  /** 基準はあるのに、手元のファイルが無い / 基準の中身の写しが無い (自動では判断しない) */
  | { reason: "local-missing" }
  | { reason: "base-missing" };

/** 同期の状態 (結び付けごとに 1 つ。state.json の中身のうち、判断に使う部分) */
export interface SyncState {
  /** 世代の番号 (書き換えるたびに増える。「読んだ世代のままなら置き換える」に使う) */
  generation: number;
  /** サーバーの履歴の世代 (初めて結び付けるまでは null) */
  epoch: string | null;
  base: Base | null;
  pending: Pending | null;
}

/** サーバーの今の状態 */
export type Remote =
  | { kind: "present"; epoch: string; revision: Revision; content: Content }
  /** その ID の計画は、まだ作られていない */
  | { kind: "absent"; epoch: string }
  /** その ID の計画は、消されている */
  | { kind: "deleted"; epoch: string };

/** 判断の入力 */
export interface SyncInput {
  state: SyncState;
  /** 手元のファイルの中身 (ファイルが無ければ null) */
  local: Content | null;
  remote: Remote;
  /** 基準の中身の写し (objects に置いたもの。基準が無い・写しが見つからなければ null) */
  baseText: string | null;
  /** 今の時刻 */
  now: Date;
  /** 文字列のハッシュを計算する関数 (統合した結果のハッシュに使う) */
  hashOf: (text: string) => string;
  /** 結び付けの印 (承認の印を、この結び付けに限るために使う。同じ計画を複製した別の結び付けでは、前の承認が通らない) */
  bindingId: string;
  /** 人が承認した「保護する項目の削除」の印 (protected-deletion の approval と同じ値なら、その削除を通す) */
  approvedDeletion?: string;
}

/** 次に行うこと */
export type Decision =
  /** 何もしない (手元とサーバーは、基準と同じ) */
  | { kind: "noop" }
  /**
   * 基準だけを進める (手元とサーバーが同じ中身だと確かめられた。書き込みも送信も無い)。
   * keep = 状態を進める前に、写しとして置いておく中身 (新しい基準が指す中身を含む)。pull の keep も同じ。
   * 呼び出し側は、判断に使った中身をそのまま置く (サーバーから取り直さない。取り直すと、その間に進んだ別の版を置いてしまう)
   */
  | { kind: "set-base"; epoch: string; base: Base; keep: Content[] }
  /** 受け取り: write を手元に書く (前提 = expectedLocal)。書く前に pending を記録し、書けたら pullWritten で基準を進める */
  | { kind: "pull"; epoch: string; write: Content; pending: PendingPull; keep: Content[] }
  /** 送り: content を、前提の版 expected で送る。送る前に pending (操作 ID は呼び出し側が決める) を記録する */
  | { kind: "push"; epoch: string; content: Content; expected: Revision | null }
  /** 残っている送りの操作を、同じ操作 ID・同じ中身・同じ前提で送り直す */
  | { kind: "resend"; pending: PendingPush }
  /** 残っている受け取りの操作は、手元に書けていた。基準を進める (pullWritten) */
  | { kind: "finish-pull"; pending: PendingPull }
  /** 止まって、人に確かめる */
  | { kind: "halt"; halt: Halt };

/** 残っている送りの操作を、自動で再開してよい期間 (ms)。サーバーが操作の結果を残す期間 (30 日) より短くする */
export const PENDING_MAX_AGE_MS = 21 * 24 * 60 * 60 * 1000;
/** 操作の日時が「今」より先でも許す幅 (ms)。時計の小さなずれのため */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * 古い版が保存のときに落とすことが分かっている、計画の直下の任意の設定。
 * 基準に在って手元で消えていたら、送る前に確かめる (この版が知らない直下の項目も、同じ扱い)。writer (書き手の印) は対象にしない
 */
export const PROTECTED_KEYS: ReadonlySet<string> = new Set(["workflowPolicy", "focusBlockId", "contextGuard"]);

/**
 * 基準に在って手元で消えている「保護する項目」を調べる
 * Input : base = 基準の計画 (JSON を解釈した値), local = 手元の計画 (同)
 * Output: 消えている項目の名前 (並べ替え済み)。無ければ空の配列
 */
export function protectedDeletions(base: Record<string, unknown>, local: Record<string, unknown>): string[] {
  return Object.keys(base)
    .filter((key) => key !== "writer" && (PROTECTED_KEYS.has(key) || !KNOWN_PROJECT_KEYS.has(key)))
    .filter((key) => base[key] !== undefined && local[key] === undefined)
    .sort();
}

/**
 * 計画の文字列を読む (読めなければ、その理由を返す)
 * Input : text = 計画の JSON
 * Output: { project, raw } (raw = JSON をそのまま解釈した値。知らない項目を調べるのに使う) または { problem }
 */
function read(text: string): { project: Project; raw: Record<string, unknown> } | { problem: string } {
  try {
    // 生の文字列を、補正の前に検査する。fromJSON は壊れた参照を捨てたり、不正な値を補ったりするので、
    // 補正した後のものを検査すると、「検査に通ったもの」と「実際に送る / 書く文字列」が食い違う
    validateProjectText(text);
    const project = fromJSON(text);
    return { project, raw: JSON.parse(text) as Record<string, unknown> };
  } catch (e) {
    return { problem: e instanceof Error ? e.message : String(e) };
  }
}

const halt = (h: Halt): Decision => ({ kind: "halt", halt: h });

/**
 * 次に行うことを決める
 * Input : input = 状態・手元・サーバー・基準の中身の写し・今の時刻など (SyncInput)
 * Output: 次に行うこと 1 つ (Decision)。呼び出し側は、それを実行してから状態を進め、もう一度この関数を呼ぶ (noop か halt になるまで)
 */
export function decide(input: SyncInput): Decision {
  const { state, local, remote, baseText, now } = input;

  // ---- 1. 残っている操作があれば、先にそれを片付ける ----
  if (state.pending?.kind === "push") {
    // サーバーの履歴の世代が、操作を記録したときと違っていたら、送り直さない (操作は残したまま、人に確かめる)。
    // 特に「新しく作る」操作は前提の版を持たないので、世代を見ないと、復旧後の別の履歴の上に作ってしまう
    if (state.epoch !== null && remote.epoch !== state.epoch) return halt({ reason: "history-changed", expected: state.epoch, actual: remote.epoch });
    // 日時が読めない・未来・古すぎる操作は、自動では送り直さない
    // (サーバーの記録が消えていると、受理済みの操作を「断られた」と読み違えるおそれがある)
    const at = Date.parse(state.pending.at);
    const age = now.getTime() - at;
    if (!Number.isFinite(at) || age < -CLOCK_SKEW_MS || age > PENDING_MAX_AGE_MS) return halt({ reason: "stale-operation", pending: state.pending });
    return { kind: "resend", pending: state.pending };
  }
  if (state.pending?.kind === "pull") {
    // 手元の中身が、書く予定だった中身と同じなら、書けていた。基準を進められる
    if (local && local.hash === state.pending.hash) return { kind: "finish-pull", pending: state.pending };
    // それ以外は、書けたのか分からない (書けた後に別の変更が入ったのか、書く前だったのか。前提の中身と同じでも、戻しただけかもしれない)
    return halt({ reason: "recover-pull", pending: state.pending, localHash: local?.hash ?? null });
  }

  // ---- 2. サーバーの履歴の世代が変わっていたら、古い基準を使わない ----
  if (state.epoch !== null && remote.epoch !== state.epoch) return halt({ reason: "history-changed", expected: state.epoch, actual: remote.epoch });

  // ---- 3. 初めて結び付けるとき (基準が無い) ----
  if (!state.base) {
    if (remote.kind === "deleted") return halt({ reason: "remote-deleted" });
    if (remote.kind === "absent") {
      if (!local) return { kind: "noop" };
      const l = read(local.text);
      if ("problem" in l) return halt({ reason: "invalid-local", problem: l.problem });
      return { kind: "push", epoch: remote.epoch, content: local, expected: null };
    }
    const r = read(remote.content.text);
    if ("problem" in r) return halt({ reason: "invalid-remote", problem: r.problem });
    const remoteBase: Base = { hash: remote.content.hash, revision: remote.revision };
    if (!local) {
      return { kind: "pull", epoch: remote.epoch, write: remote.content, keep: [remote.content], pending: { kind: "pull", hash: remote.content.hash, expectedLocal: null, remote: remoteBase, at: now.toISOString() } };
    }
    if (local.hash === remote.content.hash) return { kind: "set-base", epoch: remote.epoch, base: remoteBase, keep: [remote.content] };
    // 両方に違う中身がある。共通の祖先が分からないので、自動では統合しない
    return halt({ reason: "first-link", localHash: local.hash, remoteRevision: remote.revision });
  }

  // ---- 4. 基準があるとき ----
  const base = state.base;
  if (remote.kind !== "present") return halt({ reason: "remote-deleted" });
  if (!local) return halt({ reason: "local-missing" });
  const localChanged = local.hash !== base.hash;
  const remoteChanged = remote.revision !== base.revision;
  if (!localChanged && !remoteChanged) return { kind: "noop" };
  const remoteBase: Base = { hash: remote.content.hash, revision: remote.revision };
  // 基準の中身: 写しのハッシュが基準と合うものだけを使う (「何か読めた」では足りない)。
  // 写しが無い・壊れているときは、サーバーの中身が基準と同じなら、それを基準の中身として使える
  const baseContent = baseText !== null && input.hashOf(baseText) === base.hash ? baseText
    : remote.content.hash === base.hash ? remote.content.text : null;

  // ---- 4a. 受け取り (サーバーが進んでいる) ----
  if (remoteChanged) {
    // 新しく受け取った中身は、手元と同じ文字列でも、検査してから使う
    const r = read(remote.content.text);
    if ("problem" in r) return halt({ reason: "invalid-remote", problem: r.problem });
    // 手元とサーバーが同じ中身なら、書き込みは要らない (版だけが進んでいる)
    if (local.hash === remote.content.hash) return { kind: "set-base", epoch: remote.epoch, base: remoteBase, keep: [remote.content] };
    const pendingFor = (write: Content): PendingPull => ({ kind: "pull", hash: write.hash, expectedLocal: local.hash, remote: remoteBase, at: now.toISOString() });
    // 手元は基準のまま: サーバーの中身を、受け取った文字列のまま書く
    if (!localChanged) return { kind: "pull", epoch: remote.epoch, write: remote.content, keep: [remote.content], pending: pendingFor(remote.content) };
    // 両方が変わった: 基準から 3 方向で統合する
    if (baseContent === null) return halt({ reason: "base-missing" });
    const b = read(baseContent);
    if ("problem" in b) return halt({ reason: "base-missing" });
    const l = read(local.text);
    if ("problem" in l) return halt({ reason: "invalid-local", problem: l.problem });
    const merged = mergeProjects(b.project, l.project, r.project);
    const conflicts = merged.conflicts.filter((c) => !c.automatic);
    if (conflicts.length > 0) return halt({ reason: "conflicts", base, localHash: local.hash, remoteRevision: remote.revision, conflicts });
    // 競合が 0 件でも、合わせた結果が壊れていることがある。壊れていたら書かない
    const problem = projectProblem(merged.project);
    if (problem) return halt({ reason: "invalid-merge", problem });
    const text = toJSON(merged.project) + "\n";
    const write: Content = { hash: input.hashOf(text), text };
    // 統合した結果が手元と同じなら (サーバーの変更を手元がすでに含んでいる)、書かずに基準だけ進める。
    // 新しい基準が指すのはサーバーの中身 R なので、R の写しを置いてから進める (手元の写しだけでは、次の判断で基準の中身が見つからない)
    if (write.hash === local.hash) return { kind: "set-base", epoch: remote.epoch, base: remoteBase, keep: [remote.content] };
    return { kind: "pull", epoch: remote.epoch, write, keep: [write, remote.content], pending: pendingFor(write) };
  }

  // ---- 4b. 送り (手元だけが変わっている。基準 = サーバーの最新) ----
  const l = read(local.text);
  if ("problem" in l) return halt({ reason: "invalid-local", problem: l.problem });
  // 基準に在った「保護する項目」が消えていたら、送る前に一度確かめる (古い版が落としただけかもしれない)。
  // 基準の中身が無い・読めないときは、消えたかどうかを調べられない。「消えていない」とはみなさずに止まる
  if (baseContent === null) return halt({ reason: "base-missing" });
  let baseRaw: Record<string, unknown>;
  try { baseRaw = JSON.parse(baseContent) as Record<string, unknown>; } catch { return halt({ reason: "base-missing" }); }
  const keys = protectedDeletions(baseRaw, l.raw);
  if (keys.length > 0) {
    // 承認の印は、結び付け・基準 (履歴の世代・版・中身)・手元の中身・消えた項目の一覧に結び付ける。
    // 別の編集が入った、基準が進んだ、別の結び付けに持ち込んだ、のどれでも、確かめ直しになる
    const approval = input.hashOf(JSON.stringify([input.bindingId, state.epoch, base.revision, base.hash, local.hash, keys]));
    if (input.approvedDeletion !== approval) return halt({ reason: "protected-deletion", keys, approval });
  }
  return { kind: "push", epoch: remote.epoch, content: local, expected: base.revision };
}

// ---- 状態を進める関数 (どれも新しい状態を返し、世代を 1 つ進める) ----
// 呼ぶ順序を間違えたとき (別の操作の応答を当てる、やりかけの操作があるのに次を記録する、古い選択を当てる) は、例外にして状態を進めない

/** 呼び出しの順序の誤り (状態は変えていない) */
export class SyncStateError extends Error {}

/** 2 つの操作が同じものか (記録した内容がすべて同じ) */
const samePending = (a: Pending | null, b: Pending): boolean => a !== null && JSON.stringify(a) === JSON.stringify(b);

/**
 * 操作を記録する (送る前・手元に書く前に呼ぶ)
 * Input : state = やりかけの操作が無い状態, epoch = 判断したときのサーバーの履歴の世代, pending = これから行う操作
 * Output: 操作を記録した状態。やりかけの操作が残っているのに呼んだら SyncStateError (前の操作を上書きしない)
 */
export function recordPending(state: SyncState, epoch: string, pending: Pending): SyncState {
  if (state.pending !== null) throw new SyncStateError("another operation is still pending");
  return { ...state, generation: state.generation + 1, epoch, pending };
}

/**
 * 送りが受理された (前に受理されていた場合も含む)
 * Input : state = 送りの操作が残っている状態, opId = 応答が返ってきた操作の ID, revision = 受理された版
 * Output: 基準を「送った中身 S とその版」に進め、操作を消した状態。送信の間に手元が変わっていても、基準は S (変わった分は次の回で送る)。
 *         残っている操作と opId が違えば SyncStateError (別の操作の応答で、基準を進めない)
 */
export function pushAccepted(state: SyncState, opId: string, revision: Revision): SyncState {
  if (state.pending?.kind !== "push" || state.pending.opId !== opId) throw new SyncStateError("the response does not belong to the pending push");
  return { ...state, generation: state.generation + 1, base: { hash: state.pending.hash, revision }, pending: null };
}

/**
 * 送りが、受理されないことが確定した (前提の版が違う)。操作を消す (基準は変えない。次の判断で受け取りからやり直す)。
 * 「サーバーの履歴の世代が違う」「通信できなかった」ときには呼ばない (操作を残したままにする)
 */
export function pushRejected(state: SyncState, opId: string): SyncState {
  if (state.pending?.kind !== "push" || state.pending.opId !== opId) throw new SyncStateError("the response does not belong to the pending push");
  return { ...state, generation: state.generation + 1, pending: null };
}

/**
 * 受け取りを手元に書けた (書き込みの成功を確かめた、または手元の中身が書く予定の中身と同じだと確かめた)
 * Input : state = 受け取りの操作が残っている状態, pending = 実行した操作 (判断が返したもの)
 * Output: 基準を「取り込んだサーバーの中身 R」に進め、操作を消した状態 (統合した M を書いた場合も、基準は R。M と R の差は、まだ送っていない変更)
 */
export function pullWritten(state: SyncState, pending: PendingPull): SyncState {
  if (!samePending(state.pending, pending)) throw new SyncStateError("the pull does not match the pending operation");
  return { ...state, generation: state.generation + 1, base: pending.remote, pending: null };
}

/**
 * 受け取りが「行われなかった」と確定した (手元の前提が違って、書き込みの手順が断った)。操作を消して、次の判断でやり直す。
 * 書けたかどうか分からない失敗 (途中のエラーなど) には呼ばない (操作を残したままにして、人に確かめる)
 */
export function pullNotWritten(state: SyncState, pending: PendingPull): SyncState {
  if (!samePending(state.pending, pending)) throw new SyncStateError("the pull does not match the pending operation");
  return { ...state, generation: state.generation + 1, pending: null };
}

/** 基準だけを進める (set-base の実行)。やりかけの操作があるときは呼べない */
export function baseSet(state: SyncState, epoch: string, base: Base): SyncState {
  if (state.pending !== null) throw new SyncStateError("an operation is still pending");
  return { ...state, generation: state.generation + 1, epoch, base };
}

/**
 * 止まっている「受け取りの再開」の印: やりかけの操作・状態の世代・今の手元の中身に結び付ける
 * (表示のあとで、状態や手元が変わっていたら、前の印では進めない)
 * Input : state = 受け取りの操作が残っている状態, localHash = 今の手元の中身のハッシュ (ファイルが無ければ null), hashOf
 * Output: 印 (短い文字列)
 */
export function recoveryToken(state: SyncState, localHash: string | null, hashOf: (text: string) => string): string {
  return hashOf(JSON.stringify([state.generation, state.pending, localHash])).slice(0, 16);
}

/**
 * 止まっていた「受け取りの再開」を、人の選択で進める
 * Input : state = 受け取りの操作が残っている状態,
 *         choice = { token = 表示したときの印, applied = true なら「反映済みとして続ける」/ false なら「反映されていないものとして続ける」 },
 *         localHash = 今の手元の中身のハッシュ, hashOf
 * Output: applied なら基準を R に進めた状態、そうでなければ基準を変えずに操作を消した状態。
 *         印が今の状態と合わなければ SyncStateError (表示のあとで変わっている。表示し直してから選んでもらう)
 */
export function pullRecovered(state: SyncState, choice: { token: string; applied: boolean }, localHash: string | null, hashOf: (text: string) => string): SyncState {
  if (state.pending?.kind !== "pull") throw new SyncStateError("no pending pull");
  if (choice.token !== recoveryToken(state, localHash, hashOf)) throw new SyncStateError("the recovery choice was made for a different state");
  return choice.applied ? pullWritten(state, state.pending) : pullNotWritten(state, state.pending);
}

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
import { groupConflicts, resolveGroupChoices, type ConflictReview, type ResolutionInput } from "../model/conflict-groups";
import { projectProblem, validateProjectText } from "../model/validate-file";
import type { Project } from "../model/types";
import { t } from "../i18n/core";

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
  /**
   * サーバーが、この送信を断った記録 (大きすぎる・計画として不正など。待っても、送り直しても直らない)。
   * これが付いた操作は、同じ中身を送り直さない。サーバーに操作の結果を確定させて (受理済み / 今後も受理しない) から片付ける
   */
  rejected?: { status: number; at: string };
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
  | { reason: "conflicts"; base: Base; localHash: string; remoteRevision: Revision; conflicts: MergeConflict[]; token: string; review?: ConflictReview; resolutionError?: string }
  /** 統合の結果が、計画として正しくない (競合が 0 件でも起こる。互いのボックスを相手の中へ移した、など) */
  | { reason: "invalid-merge"; problem: string }
  /** 手元 / サーバーの中身が、計画として読めない */
  | { reason: "invalid-local"; problem: string }
  | { reason: "invalid-remote"; problem: string }
  /** 受け取りを手元に書けたのか分からない (書く直前に記録してから、基準を進めるまでの間に落ちた) */
  | { reason: "recover-pull"; pending: PendingPull; localHash: string | null }
  /** 基準に在った「保護する項目」が手元で消えている。誰が書いたかにかかわらず、送る前に一度確かめる */
  | { reason: "protected-deletion"; keys: string[]; approval: string }
  /** サーバーの履歴の世代が変わった (バックアップからの復旧など)。古い基準や操作を、そのまま使えない。続けるには、人が見比べて選ぶ (結び直し) */
  | { reason: "history-changed"; expected: string; actual: string }
  /** 結び直しの途中で、選んだときから手元かサーバーが変わった (または、選んだ送信が断られた)。選んだ内容は使わない。人が、今の内容で選び直す */
  | { reason: "relink-stale" }
  /** 残っている送りの操作が古すぎる、または日時が信頼できない (サーバーの記録が消えているかもしれない) */
  | { reason: "stale-operation"; pending: PendingPush }
  /** 初めて結び付けるときに、手元とサーバーの両方に違う中身がある。どちらを採るかを人が選ぶ */
  | { reason: "first-link"; localHash: string; remoteRevision: Revision; token: string }
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
  /**
   * 結び直しの途中だけ持つ記録 (人が選んだ内容と、その対象)。基準が決まったら消す。
   * これがある状態は、「初めての結び付け」と同じ形 (基準なし) でも、初めての結び付けとしては扱わない (記録と今の内容を照合してから進む)
   */
  relink?: RelinkRecord;
}

/** 結び直しで、人が選んだ内容: remote = サーバーの計画を採る / local = 手元の計画を採る / same = 中身が同じ (どちらも無い場合を含む) */
export type RelinkChoice = "remote" | "local" | "same";

/** 結び直しの対象: 選んだときのサーバーの状態と、手元の中身。再開のときに、すべて今の状態と照合する */
export interface RelinkTarget {
  choice: RelinkChoice;
  /** サーバーの状態 (世代・計画の有無・版・中身のハッシュ)。計画が無ければ版とハッシュは null */
  remote: { kind: "present" | "absent"; epoch: string; revision: Revision | null; hash: string | null };
  /** 手元の中身のハッシュ (ファイルが無ければ null) */
  localHash: string | null;
}

/** 状態に持つ、結び直しの記録 */
export interface RelinkRecord extends RelinkTarget {
  /** 控えのフォルダの名前 (状態のフォルダの relinks/ の下) */
  backup: string;
  /** 選んだ日時 (ISO 8601) */
  at: string;
  /** この選択で行った送信が、受理されないと確定した (同じ選択を、もう一度は使わない) */
  spent?: boolean;
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
  /** 「消えた項目を基準から戻す」という人の選択 (protected-deletion の approval と同じ値なら、その項目だけを手元に戻す) */
  restoreDeletion?: string;
  /** 競合への人の選択: 表示した比較の印と、全グループ/全項目への選択。旧preferも現在のグループへ展開する */
  resolution?: ResolutionInput;
  /** 初めて結び付けるときに、手元とサーバーの中身が違った場合の人の選択: 印 (first-link の token) と、どちらを採るか */
  firstLink?: { token: string; prefer: "local" | "remote" };
  /** 結び直しへの人の選択: 印 (relinkPreview の token) と、どちらを採るか (選べるものが 1 つだけのときは、prefer は要らない) */
  relink?: { token: string; prefer?: "local" | "remote" };
}

/** 次に行うこと */
/** 人の選択のうち、この判断が使ったもの (渡された選択が使われなかったことに、呼び出し側が気づけるようにする) */
export type UsedChoice = "firstLink" | "resolution" | "restore" | "adopt" | "relink";

export type Decision =
  /** 何もしない (手元とサーバーは、基準と同じ) */
  | { kind: "noop" }
  /**
   * 基準だけを進める (手元とサーバーが同じ中身だと確かめられた。書き込みも送信も無い)。
   * keep = 状態を進める前に、写しとして置いておく中身 (新しい基準が指す中身を含む)。pull の keep も同じ。
   * 呼び出し側は、判断に使った中身をそのまま置く (サーバーから取り直さない。取り直すと、その間に進んだ別の版を置いてしまう)
   */
  | { kind: "set-base"; epoch: string; base: Base; keep: Content[]; usedChoice?: UsedChoice }
  /**
   * 受け取り: write を手元に書く (前提 = expectedLocal)。書く前に pending を記録し、書けたら pullWritten で基準を進める。
   * backup = true のときは、置き換える前に、今の手元の中身を別のファイルへ退避する (初めて結び付けるときに、サーバーの側を採った場合)
   */
  | { kind: "pull"; epoch: string; write: Content; pending: PendingPull; keep: Content[]; backup?: boolean; usedChoice?: UsedChoice }
  /**
   * 手元のファイルだけを書き換える (消えた項目を基準から戻す)。基準も、操作の記録も変えない。
   * 手元の中身が expectedLocal のままなら置き換える。違っていたら何もしない (次の判断で、確かめ直しになる)
   */
  | { kind: "edit-local"; write: Content; expectedLocal: string; usedChoice?: UsedChoice }
  /** 送り: content を、前提の版 expected で送る。送る前に pending (操作 ID は呼び出し側が決める) を記録する */
  | { kind: "push"; epoch: string; content: Content; expected: Revision | null; usedChoice?: UsedChoice }
  /** 残っている送りの操作を、同じ操作 ID・同じ中身・同じ前提で送り直す */
  | { kind: "resend"; pending: PendingPush }
  /** 残っている受け取りの操作は、手元に書けていた。基準を進める (pullWritten) */
  | { kind: "finish-pull"; pending: PendingPull }
  /**
   * 結び直しを始める (人の選択が、今の状態と合っていた)。呼び出し側は、控えを取ってから、状態を
   * 「基準なし・操作なし・結び直しの記録つき」に 1 回で置き換える (relinkStarted)。その次の判断で、記録に従って進む
   */
  | { kind: "relink"; target: RelinkTarget; usedChoice: "relink" }
  /** 結び直しが、何もせずに終わった (手元にもサーバーにも計画が無い)。記録を消す (relinkFinished) */
  | { kind: "relink-done" }
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

  // ---- 0. サーバーの履歴の世代が変わった後 (結び直し) ----
  // 世代が違うと分かったら、残っている操作 (送り・受け取り) にも進まない: 古い世代の操作を、新しい履歴の上で片付けない。
  // 受け取りの途中だった場合も同じ (書けたか分からない受け取りを「反映済み」としても、その基準は古い世代のもの)。
  // 結び直しの途中 (記録があり、基準も操作も無い) も、ここで扱う: 「初めての結び付け」の経路へは、記録を確かめずに流さない
  const stale = state.epoch !== null && remote.epoch !== state.epoch;
  const resuming = state.relink !== undefined && state.pending === null && state.base === null;
  if (stale || resuming) {
    // 消されている計画は、結び直しでも作り直さない
    if (remote.kind === "deleted") return halt({ reason: "remote-deleted" });
    // 途中からの再開: 記録が、今のサーバー・手元と全部同じなら、選んだとおりに進む (もう一度は聞かない)
    if (resuming && !stale && relinkStillValid(state.relink!, local, remote)) return relinkAct(state.relink!, local, remote, now);
    // 人の選択: 印が、今の状態・手元・サーバーと合っていれば、結び直しを始める
    const preview = relinkPreview(input);
    if (preview && input.relink?.token === preview.token) {
      // どちらを採るかの指定があれば、それが選べるものに入っていること (選べないものを指定されたら、別のものに読み替えずに止まる。R32-01)。
      // 指定が無いときだけ、選べるものが 1 つならそれを採る (中身が同じ場合の same は、指定なしでだけ選べる)
      const choice: RelinkChoice | undefined = input.relink.prefer ?? (preview.options.length === 1 ? preview.options[0] : undefined);
      if (choice && preview.options.includes(choice)) {
        // 採る側の中身が、計画として読めること (読めないものを、新しい基準にしない)
        if (choice !== "remote" && local) { const l = read(local.text); if ("problem" in l) return halt({ reason: "invalid-local", problem: l.problem }); }
        if (choice !== "local" && remote.kind === "present") { const r = read(remote.content.text); if ("problem" in r) return halt({ reason: "invalid-remote", problem: r.problem }); }
        return { kind: "relink", usedChoice: "relink", target: { choice, remote: relinkRemoteMark(remote), localHash: local?.hash ?? null } };
      }
    }
    return halt(stale ? { reason: "history-changed", expected: state.epoch!, actual: remote.epoch } : { reason: "relink-stale" });
  }

  // ---- 1. 残っている操作があれば、先にそれを片付ける ----
  if (state.pending?.kind === "push") {
    // サーバーの履歴の世代が、操作を記録したときと違っていたら、送り直さない (操作は残したまま、人に確かめる)。
    // 特に「新しく作る」操作は前提の版を持たないので、世代を見ないと、復旧後の別の履歴の上に作ってしまう
    if (state.epoch !== null && remote.epoch !== state.epoch) return halt({ reason: "history-changed", expected: state.epoch, actual: remote.epoch });
    // サーバーで計画が消されていたら、送り直しても受理されない。操作と送る予定の写しは残したまま、止まる (勝手に作り直さない・捨てない)
    if (remote.kind === "deleted") return halt({ reason: "remote-deleted" });
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
    // 両方に違う中身がある。共通の祖先が分からないので、自動では統合しない。どちらを採るかを人が選ぶ。
    // 選択の印は、結び付け・手元の中身・サーバーの版に結び付ける (表示のあとでどちらかが変わったら、選び直し)
    // (bindingId には、サーバーの場所・ファイル・サーバー側の計画の ID が入っている。版は計画ごとの番号で、別の計画でも同じ値になりうるので、
    //  サーバーの履歴の世代と中身のハッシュも入れる。ある計画を見て得た選択を、見ていない別の計画には使えない)
    const token = input.hashOf(JSON.stringify(["first-link", input.bindingId, local.hash, remote.epoch, remote.revision, remote.content.hash])).slice(0, 16);
    if (input.firstLink?.token === token) {
      if (input.firstLink.prefer === "remote") {
        // サーバーの側を採る: 手元を置き換える (置き換える前に、手元の中身を退避する)
        return { kind: "pull", epoch: remote.epoch, write: remote.content, keep: [remote.content], backup: true, usedChoice: "firstLink"
        , pending: { kind: "pull", hash: remote.content.hash, expectedLocal: local.hash, remote: remoteBase, at: now.toISOString() } };
      }
      // 手元の側を採る: サーバーの今の版を前提に、手元の中身で置き換える (サーバーの前の中身は、サーバーの履歴に残る)
      const l = read(local.text);
      if ("problem" in l) return halt({ reason: "invalid-local", problem: l.problem });
      return { kind: "push", epoch: remote.epoch, content: local, expected: remote.revision, usedChoice: "firstLink" };
    }
    return halt({ reason: "first-link", localHash: local.hash, remoteRevision: remote.revision, token });
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
    let merged = mergeProjects(b.project, l.project, r.project, {}, now.toISOString());
    let resolved = false;
    const conflicts = merged.conflicts.filter((c) => !c.automatic);
    if (conflicts.length > 0) {
      // 選択の印は、この組 (結び付け・基準・手元・サーバー・競合の一覧) に結び付ける。
      // 選んでいる間に手元かサーバーが変わったら、印が合わなくなり、もう一度止まって表示し直す (見ていない値を、前の選択で上書きしない)
      const groups = groupConflicts(b.project, l.project, r.project, conflicts);
      const token = input.hashOf(JSON.stringify(["conflicts-v1", input.bindingId, state.epoch, base.revision, base.hash, local.hash, remote.revision, remote.content.hash, groups.map(g => [g.id, g.blocks.map(b => b.id), g.settings, g.structural, g.fields.map(f => f.id)])])).slice(0, 32);
      const review: ConflictReview = { version: 1, token, groups };
      const waiting = { reason: "conflicts" as const, base, localHash: local.hash, remoteRevision: remote.revision, conflicts, token, review };
      if (!input.resolution) return halt(waiting);
      // 全競合の選択を先に検証する。部分選択では、独立した変更も含めて何も書かずに止まる。
      const selected = resolveGroupChoices(review, input.resolution);
      if ("error" in selected) return halt({ ...waiting, resolutionError: selected.error });
      merged = mergeProjects(b.project, l.project, r.project, selected.choices, now.toISOString());
      // 選択の組み合わせの誤りは、ファイル修正ではなく同じ比較で選び直してもらう。
      const selectionProblem = projectProblem(merged.project);
      if (selectionProblem) return halt({ ...waiting, resolutionError: t("この組み合わせでは参照がつながりません。同じ比較で選び直してください。") + " " + selectionProblem });
      resolved = true;
    }
    // 競合が 0 件でも、合わせた結果が壊れていることがある。壊れていたら書かない
    const problem = projectProblem(merged.project);
    if (problem) return halt({ reason: "invalid-merge", problem });
    const text = toJSON(merged.project) + "\n";
    const write: Content = { hash: input.hashOf(text), text };
    // 統合した結果が手元と同じなら (サーバーの変更を手元がすでに含んでいる)、書かずに基準だけ進める。
    // 新しい基準が指すのはサーバーの中身 R なので、R の写しを置いてから進める (手元の写しだけでは、次の判断で基準の中身が見つからない)
    // (競合を手元の側で決めた結果が、手元と同じになることもある。その場合も、選択は使われている)
    const used = resolved ? { usedChoice: "resolution" as const } : {};
    if (write.hash === local.hash) return { kind: "set-base", epoch: remote.epoch, base: remoteBase, keep: [remote.content], ...used };
    return { kind: "pull", epoch: remote.epoch, write, keep: [write, remote.content], pending: pendingFor(write), ...used };
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
    if (input.restoreDeletion === approval) {
      // 消えた項目だけを、基準から手元に戻す (ほかの編集はそのまま)。戻した結果が計画として正しいことを確かめてから書く
      const restored: Record<string, unknown> = { ...l.raw };
      for (const key of keys) restored[key] = baseRaw[key];
      const text = JSON.stringify(restored, null, 2) + "\n";
      const check = read(text);
      if ("problem" in check) return halt({ reason: "invalid-local", problem: check.problem });
      return { kind: "edit-local", write: { hash: input.hashOf(text), text }, expectedLocal: local.hash, usedChoice: "restore" };
    }
    if (input.approvedDeletion !== approval) return halt({ reason: "protected-deletion", keys, approval });
    return { kind: "push", epoch: remote.epoch, content: local, expected: base.revision, usedChoice: "adopt" };
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
 * 送りを、サーバーが断った (待っても直らない)。操作は残したまま、断られた印を付ける
 * Input : state = 送りの操作が残っている状態, opId = 断られた操作の ID, status = 応答の状態コード, at = 日時 (ISO 8601)
 * Output: 印を付けた状態 (基準も操作も、そのまま)。残っている操作と opId が違えば SyncStateError
 */
export function pushRefused(state: SyncState, opId: string, status: number, at: string): SyncState {
  if (state.pending?.kind !== "push" || state.pending.opId !== opId) throw new SyncStateError("the response does not belong to the pending push");
  return { ...state, generation: state.generation + 1, pending: { ...state.pending, rejected: { status, at } } };
}

/**
 * 送りが受理された (前に受理されていた場合も含む)
 * Input : state = 送りの操作が残っている状態, opId = 応答が返ってきた操作の ID, revision = 受理された版
 * Output: 基準を「送った中身 S とその版」に進め、操作を消した状態。送信の間に手元が変わっていても、基準は S (変わった分は次の回で送る)。
 *         残っている操作と opId が違えば SyncStateError (別の操作の応答で、基準を進めない)
 */
export function pushAccepted(state: SyncState, opId: string, revision: Revision): SyncState {
  if (state.pending?.kind !== "push" || state.pending.opId !== opId) throw new SyncStateError("the response does not belong to the pending push");
  return withoutRelink({ ...state, generation: state.generation + 1, base: { hash: state.pending.hash, revision }, pending: null });
}

/**
 * 送りが、受理されないことが確定した (前提の版が違う。または、断られた操作を、サーバーが「今後も受理しない」と確定した)。操作を消す (基準は変えない。次の判断で受け取りからやり直す)。
 * 「サーバーの履歴の世代が違う」「通信できなかった」ときには呼ばない (操作を残したままにする)
 */
export function pushRejected(state: SyncState, opId: string): SyncState {
  if (state.pending?.kind !== "push" || state.pending.opId !== opId) throw new SyncStateError("the response does not belong to the pending push");
  // 結び直しの途中の送信が断られたら、その選択は使い切ったことにする (同じ選択で、別の版へ送り直さない。人が、今の内容で選び直す)
  return { ...state, generation: state.generation + 1, pending: null, ...(state.relink ? { relink: { ...state.relink, spent: true } } : {}) };
}

/**
 * 受け取りを手元に書けた (書き込みの成功を確かめた、または手元の中身が書く予定の中身と同じだと確かめた)
 * Input : state = 受け取りの操作が残っている状態, pending = 実行した操作 (判断が返したもの)
 * Output: 基準を「取り込んだサーバーの中身 R」に進め、操作を消した状態 (統合した M を書いた場合も、基準は R。M と R の差は、まだ送っていない変更)
 */
export function pullWritten(state: SyncState, pending: PendingPull): SyncState {
  if (!samePending(state.pending, pending)) throw new SyncStateError("the pull does not match the pending operation");
  return withoutRelink({ ...state, generation: state.generation + 1, base: pending.remote, pending: null });
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
  return withoutRelink({ ...state, generation: state.generation + 1, epoch, base });
}

/** 結び直しの記録を外した状態 (基準が決まったときに使う) */
function withoutRelink(state: SyncState): SyncState {
  const { relink: _done, ...rest } = state;
  return rest;
}

// ---- 結び直し (サーバーの履歴の世代が変わった後に、人が見比べて選ぶ) ----

/** サーバーの今の状態から、結び直しの対象として記録する部分を取り出す (消されている計画は対象にしない) */
function relinkRemoteMark(remote: Exclude<Remote, { kind: "deleted" }>): RelinkTarget["remote"] {
  return remote.kind === "present"
    ? { kind: "present", epoch: remote.epoch, revision: remote.revision, hash: remote.content.hash }
    : { kind: "absent", epoch: remote.epoch, revision: null, hash: null };
}

/** 結び直しの記録が、今のサーバー・手元と全部同じか (世代・計画の有無・版・中身・手元の中身。使い切った選択は、合わない扱い) */
function relinkStillValid(record: RelinkRecord, local: Content | null, remote: Exclude<Remote, { kind: "deleted" }>): boolean {
  return !record.spent && JSON.stringify(record.remote) === JSON.stringify(relinkRemoteMark(remote)) && record.localHash === (local?.hash ?? null);
}

/**
 * 結び直しの記録に従って、次に行うことを決める (記録が今の状態と合っていると確かめた後に呼ぶ)
 * Input : record = 結び直しの記録, local = 手元の中身, remote = サーバーの今の状態, now = 今の時刻
 * Output: same → 基準を作る (どちらにも無ければ、記録を消すだけ) / remote → 受け取り (手元を控えてから置き換える) / local → 送り (サーバーの今の版を前提に。無ければ新しく作る)
 */
function relinkAct(record: RelinkRecord, local: Content | null, remote: Exclude<Remote, { kind: "deleted" }>, now: Date): Decision {
  if (remote.kind === "present") {
    const remoteBase: Base = { hash: remote.content.hash, revision: remote.revision };
    if (record.choice === "same") return { kind: "set-base", epoch: remote.epoch, base: remoteBase, keep: [remote.content] };
    if (record.choice === "remote") {
      return { kind: "pull", epoch: remote.epoch, write: remote.content, keep: [remote.content], backup: local !== null
      , pending: { kind: "pull", hash: remote.content.hash, expectedLocal: local?.hash ?? null, remote: remoteBase, at: now.toISOString() } };
    }
  }
  if (record.choice === "local" && local) return { kind: "push", epoch: remote.epoch, content: local, expected: remote.kind === "present" ? remote.revision : null };
  // 手元にもサーバーにも計画が無い (same)。結び付けだけが残る
  if (record.choice === "same" && remote.kind === "absent" && !local) return { kind: "relink-done" };
  // 記録と状態の組み合わせが成り立たない (照合を通っていれば、ここには来ない)。進めずに、選び直してもらう
  return halt({ reason: "relink-stale" });
}

/** 結び直しの見比べ (止まったときに表示する。何も書き換えない) */
export interface RelinkPreview {
  /** 選ぶための印 (状態・手元・サーバーのどれかが変わると、別の値になる) */
  token: string;
  /** サーバーの計画と手元の計画の関係: same = 中身が同じ / differs = 両方にあって違う / remote-only = サーバーにだけある / local-only = 手元にだけある / none = どちらにも無い */
  relation: "same" | "differs" | "remote-only" | "local-only" | "none";
  /** 選べるもの (1 つだけなら、どちらを採るかの指定は要らない) */
  options: RelinkChoice[];
  /** 前回そろえた後に、手元を変えていたか (基準の写しが無くて分からなければ null) */
  localChanged: boolean | null;
  /** 残っている古い操作 (送り直さない・片付けない。控えに写すだけ) */
  pending: "push" | "pull" | null;
  /** 手元の計画を採った場合に、サーバーの計画に起きる変化 (両方にあって違うときだけ) */
  differences: string[];
  /** サーバーの今の版 (計画が無ければ null) と、前回そろえた版 (基準が無ければ null) */
  remoteRevision: Revision | null; baseRevision: Revision | null;
}

/**
 * 結び直しの見比べを作る
 * Input : input = 判断の入力 (世代が変わって止まっている状態、または、結び直しの途中の状態)
 * Output: 見比べ。サーバーで計画が消されているときは null (結び直しの対象にしない)
 *         印には、結び付け・状態の世代・古い世代・結び直しの記録・残っている操作・サーバーの状態 (世代・有無・版・中身)・手元の中身を入れる
 */
export function relinkPreview(input: SyncInput): RelinkPreview | null {
  const { state, local, remote, baseText } = input;
  if (remote.kind === "deleted") return null;
  const mark = relinkRemoteMark(remote);
  const token = input.hashOf(JSON.stringify(["relink", input.bindingId, state.generation, state.epoch, state.relink ?? null, state.pending, mark, local?.hash ?? null])).slice(0, 16);
  const relation: RelinkPreview["relation"] = remote.kind === "present"
    ? (local ? (local.hash === remote.content.hash ? "same" : "differs") : "remote-only")
    : (local ? "local-only" : "none");
  const options: RelinkChoice[] = relation === "differs" ? ["remote", "local"] : relation === "remote-only" ? ["remote"] : relation === "local-only" ? ["local"] : ["same"];
  return {
    token, relation, options
  , localChanged: state.base === null ? null : baseText === null ? null : (local?.hash ?? null) !== state.base.hash
  , pending: state.pending?.kind ?? null
  , differences: relation === "differs" && remote.kind === "present" && local ? describeChanges(remote.content.text, local.text) : []
  , remoteRevision: mark.revision, baseRevision: state.base?.revision ?? null
  };
}

/**
 * 結び直しを始めた状態にする (控えを取った後に呼ぶ)
 * Input : state = 止まっている状態, target = 人が選んだ内容と対象 (判断が返したもの), backup = 控えのフォルダの名前, at = 日時
 * Output: 基準なし・操作なし・世代なしで、結び直しの記録を持つ状態 (古い基準・古い操作は、控えにだけ残る)
 */
export function relinkStarted(state: SyncState, target: RelinkTarget, backup: string, at: string): SyncState {
  return { generation: state.generation + 1, epoch: null, base: null, pending: null, relink: { ...target, backup, at } };
}

/** 結び直しが、何もせずに終わった (手元にもサーバーにも計画が無い)。記録を消す */
export function relinkFinished(state: SyncState): SyncState {
  if (state.pending !== null || state.base !== null) throw new SyncStateError("the relink is not at its end");
  return withoutRelink({ ...state, generation: state.generation + 1 });
}

/**
 * 止まっている「受け取りの再開」の印: やりかけの操作・状態の世代・今の手元の中身・サーバーの今の位置に結び付ける
 * (表示のあとで、状態・手元・サーバーのどれかが変わっていたら、前の印では進めない)
 * Input : state = 受け取りの操作が残っている状態, localHash = 今の手元の中身のハッシュ (ファイルが無ければ null),
 *         remote = サーバーの今の位置 (履歴の世代と最新の版),
 *         bindingId = 結び付けの印 (中身・日時・世代がまったく同じでも、別の結び付けで得た印は使えないようにする), hashOf
 * Output: 印 (短い文字列)
 */
export function recoveryToken(state: SyncState, localHash: string | null, remote: RemoteMark, bindingId: string, hashOf: (text: string) => string): string {
  return hashOf(JSON.stringify(["recover", bindingId, state.generation, state.pending, localHash, remote.epoch, remote.revision])).slice(0, 16);
}

/** 復旧の印に入れる、サーバーの今の位置 (履歴の世代と、最新の版。計画が無ければ版は null) */
export interface RemoteMark { epoch: string; revision: Revision | null }
/** サーバーの今の状態から、復旧の印に入れる位置を取り出す */
export const remoteMark = (remote: Remote): RemoteMark => ({ epoch: remote.epoch, revision: remote.kind === "present" ? remote.revision : null });

/**
 * 止まっていた「受け取りの再開」を、人の選択で進める
 * Input : state = 受け取りの操作が残っている状態,
 *         choice = { token = 表示したときの印, applied = true なら「反映済みとして続ける」/ false なら「反映されていないものとして続ける」 },
 *         localHash = 今の手元の中身のハッシュ, hashOf
 * Output: applied なら基準を R に進めた状態、そうでなければ基準を変えずに操作を消した状態。
 *         印が今の状態と合わなければ SyncStateError (表示のあとで変わっている。表示し直してから選んでもらう)
 */
export function pullRecovered(state: SyncState, choice: { token: string; applied: boolean }, localHash: string | null, remote: RemoteMark, bindingId: string, hashOf: (text: string) => string): SyncState {
  if (state.pending?.kind !== "pull") throw new SyncStateError("no pending pull");
  // サーバーの履歴の世代が変わっているときは、人の選択があっても操作を消さない (世代の違う基準へ進めない)
  if (state.epoch !== null && remote.epoch !== state.epoch) throw new SyncStateError("the server history changed");
  if (choice.token !== recoveryToken(state, localHash, remote, bindingId, hashOf)) throw new SyncStateError("the recovery choice was made for a different state");
  return choice.applied ? pullWritten(state, state.pending) : pullNotWritten(state, state.pending);
}

// ---- 復旧のときの見比べ (「どちらを選んだら、どうなるか」を見せる) ----

/**
 * 2 つの計画の違いを、人が読める短い一覧にする
 * Input : fromText = 変わる前の計画の文字列, toText = 変わった後の計画の文字列, limit = 一覧の上限
 * Output: 違いの一覧 (ボックスの追加・削除・変わった項目、直下の設定の変化)。読めない中身なら、その旨の 1 行
 */
export function describeChanges(fromText: string, toText: string, limit = 12): string[] {
  let from: Record<string, unknown>, to: Record<string, unknown>;
  try { from = JSON.parse(fromText) as Record<string, unknown>; to = JSON.parse(toText) as Record<string, unknown>; } catch { return [t("(中身を読めないため、違いを表示できません)")]; }
  const lines: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const blocksOf = (d: Record<string, unknown>) => (d.blocks ?? {}) as Record<string, Record<string, unknown>>;
  const fromBlocks = blocksOf(from), toBlocks = blocksOf(to);
  const title = (b: Record<string, unknown> | undefined) => String(b?.title ?? "");
  for (const id of Object.keys(toBlocks)) {
    if (!fromBlocks[id]) { lines.push(t("ボックス「{title}」が加わる", { title: title(toBlocks[id]) })); continue; }
    // 記録の日時は、変化として数えない (説明や状態と一緒に変わる付随の情報)
    const fields = [...new Set([...Object.keys(fromBlocks[id]), ...Object.keys(toBlocks[id])])]
      .filter((k) => k !== "descriptionUpdatedAt" && k !== "statusChangedAt" && !same(fromBlocks[id][k], toBlocks[id][k]));
    if (fields.length > 0) lines.push(t("ボックス「{title}」の {fields} が変わる", { title: title(toBlocks[id]), fields: fields.join(", ") }));
  }
  for (const id of Object.keys(fromBlocks)) if (!toBlocks[id]) lines.push(t("ボックス「{title}」が消える", { title: title(fromBlocks[id]) }));
  // 入出力と線は数だけ、直下の設定は名前を出す (ログと「最後に見た時刻」は、変化として数えない)
  for (const kind of ["ports", "edges"] as const) {
    const a = (from[kind] ?? {}) as Record<string, unknown>, b = (to[kind] ?? {}) as Record<string, unknown>;
    const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((id) => !same(a[id], b[id])).length;
    if (changed > 0) lines.push(kind === "ports" ? t("入出力が {count} 件変わる", { count: changed }) : t("線が {count} 件変わる", { count: changed }));
  }
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (["blocks", "ports", "edges", "log", "agents", "nextKey", "writer"].includes(key)) continue;
    if (!same(from[key], to[key])) lines.push(to[key] === undefined ? t("設定 {key} が消える", { key }) : from[key] === undefined ? t("設定 {key} が加わる", { key }) : t("設定 {key} が変わる", { key }));
  }
  if (lines.length > limit) return [...lines.slice(0, limit), t("ほか {count} 件", { count: lines.length - limit })];
  return lines;
}

/** 復旧の続け方 1 つ分の「選んだ後の結果」 */
export interface RecoveryOutcome {
  /**
   * どこまで進むか: "push" = 手元の変更をサーバーへ送るところまで進む, "none" = 送るものは無く、そろう,
   * それ以外 = その理由で、送る前にもう一度止まる (手元への書き込みは、止まる前に行われることがある)
   */
  next: "push" | "none" | Halt["reason"] | "binding-mismatch";
  /** 手元のファイルに入る変更 (手元が変わらないなら空) */
  localChanges: string[];
  /** サーバーへ送ることになる変更 (next が "push" のときだけ。一覧が空でも、記録だけの変更を送ることがある) */
  remoteChanges: string[];
}

/**
 * 止まっている「受け取りの再開」について、2 つの続け方それぞれの結果を計算する (何も書かない・送らない)
 * 実際の同期と同じ判断 (decide) を、メモリの中だけで、送る直前・止まる・そろう、のどれかになるまで繰り返す
 * (1 手先だけを見ると、受け取りの次に「消えた設定の確認」などで止まる場合に、送らないものを「送る」と表示してしまう)
 * Input : input = 判断の入力 (state には受け取りの操作が残っている),
 *         objects = ハッシュから中身の写しを引く関数 (基準の中身を探すのに使う)
 * Output: { applied = 「反映済みとして続ける」を選んだ場合, notApplied = 「反映されていないものとして続ける」を選んだ場合 }
 */
export function previewRecovery(input: SyncInput, objects: (hash: string) => string | null): { applied: RecoveryOutcome; notApplied: RecoveryOutcome } {
  const pending = input.state.pending;
  if (pending?.kind !== "pull") throw new SyncStateError("no pending pull");
  const remoteText = input.remote.kind === "present" ? input.remote.content.text : "{}";
  const outcome = (applied: boolean): RecoveryOutcome => {
    let state = applied ? pullWritten(input.state, pending) : pullNotWritten(input.state, pending);
    let local = input.local;
    // この計算の中で「置いた」ことにする写し (実際には置かない)
    const kept = new Map<string, string>();
    const lookup = (hash: string) => kept.get(hash) ?? objects(hash);
    const changes = () => describeChanges(input.local?.text ?? "{}", local?.text ?? "{}");
    for (let step = 0; step < 8; step++) {
      const decision = decide({ ...input, state, local, baseText: state.base ? lookup(state.base.hash) : null });
      if (decision.kind === "halt") return { next: decision.halt.reason, localChanges: changes(), remoteChanges: [] };
      if (decision.kind === "noop") return { next: "none", localChanges: changes(), remoteChanges: [] };
      if (decision.kind === "push") return { next: "push", localChanges: changes(), remoteChanges: describeChanges(remoteText, decision.content.text) };
      if (decision.kind === "set-base") { for (const c of decision.keep) kept.set(c.hash, c.text); state = baseSet(state, decision.epoch, decision.base); continue; }
      if (decision.kind === "pull") {
        for (const c of decision.keep) kept.set(c.hash, c.text);
        local = decision.write;
        state = pullWritten(recordPending(state, decision.epoch, decision.pending), decision.pending);
        continue;
      }
      if (decision.kind === "edit-local") { local = decision.write; continue; }
      // resend / finish-pull は、操作を片付けた直後の状態からは出ない
      break;
    }
    return { next: "none", localChanges: changes(), remoteChanges: [] };
  };
  return { applied: outcome(true), notApplied: outcome(false) };
}

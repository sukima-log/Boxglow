/**
 * 同期の実行 (手元のファイル・状態の置き場・サーバーとの通信をつなぐ)
 * 判断は src/sync/engine.ts の decide に任せ、ここは「読む → 判断 → 記録 → 実行 → 状態を進める」を、noop か halt になるまで繰り返す。
 * 守る手順:
 *   - 送る前・手元に書く前に、必ず操作を state.json に記録する (途中で落ちても、再開で確かめられる)。
 *   - 中身の写し (objects) は、state.json がそのハッシュを指す前に置く。
 *   - 手元への書き込みは、今の保存の手順 (commitFile: ロック + 版の照合 + 原子的な置換) を通す。計画のファイルのロックを、通信の間は持たない。
 *   - 状態用のロックを、1 回の同期の間持つ (同じ結び付けを扱う同期の処理は 1 つだけ)。
 */
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { commitFile, FileBusy, FileConflict, revisionOf } from "../file-store";
import { basename } from "node:path";
import {
  baseSet, decide, previewRecovery, pullNotWritten, pullRecovered, pullWritten, pushAccepted, pushRefused, pushRejected, recordPending, recoveryToken as engineRecoveryToken, remoteMark, SyncStateError
, type Content, type Halt, type PendingPush, type RecoveryOutcome, type Remote, type RemoteMark, type SyncState
} from "../../src/sync/engine";
import { bindingDir, bindingsOf, hashOf, lockFileSync, normalizeServer, realFile, StateStore, type Binding, type StoredState } from "./state-store";
import { APP_VERSION, SAVE_PROTOCOL } from "../../src/model/version";

/** 同期の結果 */
export type SyncResult =
  /** 手元とサーバーがそろった (pulled = 受け取って手元に書いた回数, pushed = 送って受理された回数) */
  | { status: "synced"; pulled: number; pushed: number; edited: number; revision: string | null
      /** 「そろった」と確かめたときの、手元の中身のハッシュ (ファイルが無ければ null)。この後でファイルが変わっていたら、その変更はまだ送られていない */
    ; localHash: string | null }
  /**
   * 人に確かめる必要があって止まった。
   * recovery = 受け取りの再開で止まったときの、選ぶための印と、2 つの続け方それぞれの「選んだ後の結果」
   */
  | { status: "halted"; halt: Halt | ClientHalt
    ; recovery?: { token: string; applied: RecoveryOutcome; notApplied: RecoveryOutcome }
      /** 止まる前に、この実行で行ったこと (受け取って手元に書いた回数、送って受理された回数、手元だけを書き換えた回数) */
    ; pulled: number; pushed: number; edited: number
      /** 表示するコマンドに付ける、同期の対象 (サーバー・サーバー側の計画の ID・ファイル) */
    ; target: { server: string; remoteId: string; file: string }
      /** 止まると判断したときの、手元の中身のハッシュ (まだ読んでいなければ undefined) */
    ; localHash?: string | null }
  /** 他の処理が動いていて、今回は進められなかった (待てば直る)。what = "sync" (他の同期の処理) / "file" (計画のファイルが書き込み中) */
  | { status: "busy"; what: "sync" | "file" };

/** 実行の側 (結び付けの確認) で止まる理由 */
export type ClientHalt =
  /** 同じパスに、結び付けたときとは別の計画 (ID が違う) が置かれている */
  | { reason: "binding-mismatch"; expected: string; actual: string }
  /** 指定したサーバー側の計画の ID が、この結び付けの ID と違う (指定と違う計画へ、黙って書かない) */
  | { reason: "binding-target"; bound: string; requested: string }
  /** この計画のファイルは、すでに別のサーバーに結び付いている (1 つのファイルの結び付けは 1 つだけ) */
  | { reason: "bound-elsewhere"; server: string }
  /** 状態を読めない結び付けのフォルダがあり、このファイルがすでに結び付いているかを確かめられない (新しい結び付けを作らない) */
  | { reason: "unreadable-bindings"; dirs: string[] }
  /** 渡された人の選択 (初回の選択・競合の解決) が、今の状態には当てはまらなかった (選択なしの同期として進めない) */
  | { reason: "choice-not-applied"; choice: "firstLink" | "resolution" }
  /** この結び付けは、別の利用者のもの (サーバーが答えた利用者が、結び付けたときと違う)。基準もやりかけの操作も使わず、何も送らない・書かない */
  | { reason: "account-mismatch"; bound: string; actual: string }
  /** この結び付けには、利用者の記録がまだ無い (記録するようになる前に作った状態)。今の利用者のものだと、人が確かめるまで同期しない */
  | { reason: "account-unconfirmed"; account: string };

/** サーバーとの通信の失敗 (やりかけの操作は残したまま。後でやり直せる) */
export class SyncNetworkError extends Error {}
/** サーバーが利用者を確かめられなかった (トークンが無い・無効・権限が無い)。待っても直らないので、通信の失敗とは分ける */
export class SyncAuthError extends SyncNetworkError {
  constructor(readonly status: number) { super(`not authorized (${status})`); }
}
/**
 * サーバーが、この計画の要求を断った (待っても、送り直しても直らない: 大きすぎる・クライアントが古い・計画として不正・操作の食い違い)。
 * 通信の失敗とは分ける (通信の失敗として扱うと、同じ要求を送り続け、常時の同期ではほかの計画まで止めてしまう)
 */
export class SyncRejectedError extends Error {
  constructor(readonly status: number, readonly detail: string) { super(`the server rejected the request (${status}): ${detail}`); }
}
/** 待っても直らない、計画ごとの拒否の状態コード */
const TERMINAL_STATUS = new Set([400, 413, 422, 426, 428]);
/** 応答の状態コードが「利用者を確かめられない」なら、その旨の例外を投げる */
function rejectUnauthorized(res: Response): void {
  if (res.status === 401 || res.status === 403) throw new SyncAuthError(res.status);
}

/** 同期の指定 */
export interface SyncOptions {
  /** 計画のファイル */
  file: string;
  /** サーバーの場所 (URL) */
  server: string;
  /** サーバー側の計画の ID。初めて結び付けるときに省くと、新しい ID を作る。結び付いた後は、記録した ID を使う */
  remoteId?: string;
  /** アクセストークン (開発用のサーバーでは省ける) */
  token?: string;
  /** 人が承認した「保護する項目の削除」の印 */
  approvedDeletion?: string;
  /** 「消えた項目を基準から戻す」という人の選択の印 */
  restoreDeletion?: string;
  /** 競合への人の選択 (表示した競合の組の印と、どちらを採るか) */
  resolution?: { token: string; prefer: "local" | "remote" };
  /** 初めて結び付けるときに、手元とサーバーの中身が違った場合の人の選択 */
  firstLink?: { token: string; prefer: "local" | "remote" };
  /** 止まっている「受け取りの再開」への人の選択: 印 (recoveryToken の値) と、反映済みとして続けるか */
  recover?: { token: string; applied: boolean };
  /** 利用者の記録が無い結び付けを「この利用者のもの」と人が確かめた、その利用者の ID (account-unconfirmed で表示した値) */
  confirmAccount?: string;
  /** 今の時刻 (試験で差し替える) */
  now?: () => Date;
  /** 通信の関数 (試験で差し替える) */
  fetch?: typeof fetch;
  /**
   * 処理の境目ごとに呼ばれる (試験で、途中に割り込む・止める・落とすために使う。待つこともできる)。
   * 境目: "local:read" = 手元を読んだ直後 (サーバーを取得する前), 判断の種類 (pull / push / noop など) = 判断した直後,
   *       "pull:recorded" = 受け取りの操作を記録した直後 (手元に書く前), "pull:written" = 手元に書いた直後 (基準を進める前),
   *       "push:sent" = サーバーが応答した直後 (状態を進める前)
   */
  onStep?: (kind: string) => void | Promise<void>;
}

/** 止まっている「受け取りの再開」の印: やりかけの操作と、今の手元の中身に結び付ける (表示のあとで手元が変わったら、選び直しになる) */
export function recoveryToken(state: SyncState, localHash: string | null, remote: RemoteMark, bindingId: string): string {
  return engineRecoveryToken(state, localHash, remote, bindingId, hashOf);
}

/**
 * 印に使う「結び付けの印」: 結び付けのフォルダ (サーバーの場所とファイルで決まる)、サーバー側の計画の ID、利用者の ID。
 * 利用者も含める: まだ状態が無い「初回の選択」でも、ある利用者の計画を見て得た選択を、別の利用者の計画には使えない
 */
export const bindingIdOf = (dir: string, remoteId: string, account: string): string => `${basename(dir)}:${remoteId}:${account}`;

/** 応答から、サーバーが確かめた利用者の ID を読む。無ければ通信の失敗として扱う (利用者が分からないまま、基準や操作を使わない) */
function accountOf(res: Response): string {
  const account = res.headers.get("x-boxglow-account");
  if (!account) throw new SyncNetworkError(`unexpected response ${res.status} (no account)`);
  return account;
}

/**
 * サーバーの今の状態を取得する
 * Input : server・remoteId・token・fetch
 * Output: { remote = Remote (在る / まだ無い / 消されている), account = サーバーが確かめた利用者の ID }。通信できなければ SyncNetworkError
 */
async function fetchRemote(o: { server: string; remoteId: string; token?: string; fetch: typeof fetch }): Promise<{ remote: Remote; account: string }> {
  let res: Response;
  try {
    res = await o.fetch(`${o.server}/v1/projects/${encodeURIComponent(o.remoteId)}`, { headers: headers(o.token) });
  } catch (e) { throw new SyncNetworkError(String(e)); }
  rejectUnauthorized(res);
  const epoch = res.headers.get("x-boxglow-epoch");
  if (!epoch) throw new SyncNetworkError(`unexpected response ${res.status} (no epoch)`);
  const account = accountOf(res);
  if (res.status === 404) return { remote: { kind: "absent", epoch }, account };
  if (res.status === 410) return { remote: { kind: "deleted", epoch }, account };
  if (res.status !== 200) throw new SyncNetworkError(`unexpected response ${res.status}`);
  const revision = unquote(res.headers.get("etag"));
  if (!revision) throw new SyncNetworkError("no ETag");
  let text: string;
  try { text = await res.text(); } catch (e) { throw new SyncNetworkError(`could not read the response body: ${String(e)}`); }
  return { remote: { kind: "present", epoch, revision, content: { hash: hashOf(text), text } }, account };
}

/**
 * 送りの操作を、サーバーが受理したかを問い合わせる (断られた送信の後始末に使う。中身は送らない)
 * Input : server・remoteId・token・fetch, opId = 操作 ID
 * Output: { epoch = サーバーの履歴の世代, account = 利用者の ID, revision = 受理されていれば、その版。受理されていなければ null }。
 *         通信できない・想定外の応答は SyncNetworkError (操作は残したまま)
 */
async function fetchOperation(o: { server: string; remoteId: string; token?: string; fetch: typeof fetch }, opId: string): Promise<{ epoch: string; account: string; revision: string | null }> {
  let res: Response;
  try {
    res = await o.fetch(`${o.server}/v1/projects/${encodeURIComponent(o.remoteId)}/ops/${encodeURIComponent(opId)}`, { headers: headers(o.token) });
  } catch (e) { throw new SyncNetworkError(String(e)); }
  rejectUnauthorized(res);
  const epoch = res.headers.get("x-boxglow-epoch");
  if (res.status !== 200 || !epoch) throw new SyncNetworkError(`unexpected response ${res.status}`);
  const account = accountOf(res);
  let body: unknown;
  try { body = await res.json(); } catch (e) { throw new SyncNetworkError(`could not read the response body: ${String(e)}`); }
  const revision = (body as { revision?: unknown } | null)?.revision;
  // 「受理していない」は、明示の null だけ。項目が無い・形が違う応答を「受理していない」と読まない (受理済みの操作を捨てないため)
  if (revision !== null && (typeof revision !== "string" || revision === "")) throw new SyncNetworkError("unexpected response body (operation)");
  return { epoch, account, revision };
}

/**
 * 全部の計画の最新の版を、1 回の要求で取得する (常時の同期が、どの計画が進んだかを確かめるのに使う)
 * Input : server・token・fetch
 * Output: { epoch = サーバーの履歴の世代, account = サーバーが確かめた利用者の ID, heads = 計画の ID → { revision (まだ無ければ null), deleted } }。
 *         通信できなければ SyncNetworkError
 */
export async function fetchHeads(o: { server: string; token?: string; fetch?: typeof fetch }): Promise<{ epoch: string; account: string; heads: Map<string, { revision: string | null; deleted: boolean }> }> {
  let res: Response;
  try { res = await (o.fetch ?? fetch)(`${normalizeServer(o.server)}/v1/projects`, { headers: headers(o.token) }); } catch (e) { throw new SyncNetworkError(String(e)); }
  rejectUnauthorized(res);
  const epoch = res.headers.get("x-boxglow-epoch");
  if (res.status !== 200 || !epoch) throw new SyncNetworkError(`unexpected response ${res.status}`);
  const account = accountOf(res);
  // 本文の受信の失敗 (ヘッダの後で接続が切れた) や、形の合わない本文も、通信の失敗として扱う (呼び出し側が、間隔を置いてやり直せるように)
  let list: unknown;
  try { list = await res.json(); } catch (e) { throw new SyncNetworkError(`could not read the response body: ${String(e)}`); }
  if (!Array.isArray(list)) throw new SyncNetworkError("unexpected response body (not a list)");
  const heads = new Map<string, { revision: string | null; deleted: boolean }>();
  for (const item of list as unknown[]) {
    const p = item as { id?: unknown; revision?: unknown; deleted?: unknown };
    if (typeof p?.id !== "string" || (p.revision !== null && typeof p.revision !== "string") || typeof p.deleted !== "boolean" || heads.has(p.id)) throw new SyncNetworkError("unexpected response body (bad list item)");
    heads.set(p.id, { revision: p.revision as string | null, deleted: p.deleted });
  }
  return { epoch, account, heads };
}

/** 要求に付ける共通のヘッダ (トークン、クライアントの版と保存の取り決めの版) */
function headers(token?: string): Record<string, string> {
  return { ...(token ? { authorization: `Bearer ${token}` } : {}), "x-boxglow-version": APP_VERSION, "x-boxglow-protocol": String(SAVE_PROTOCOL) };
}
/** ETag の値から、前後の二重引用符を取る */
const unquote = (etag: string | null): string | null => etag ? etag.replace(/^W\//, "").replace(/^"|"$/g, "") : null;

/**
 * やりかけの送りの操作を送る (初めて送るときも、送り直すときも同じ要求)
 * Output: { accepted: 版 } / { rejected: true } (前提の版が違う。受理されないことが確定) / { history: 世代 } (サーバーの履歴の世代が違う)
 *         / { deleted: true } (サーバーで計画が消されている)。
 *         通信できない・想定外の応答は SyncNetworkError、サーバーが断った (待っても直らない) は SyncRejectedError (どちらも、操作は残したまま)
 */
async function sendPush(o: { server: string; remoteId: string; token?: string; fetch: typeof fetch; epoch: string | null }, pending: PendingPush, text: string):
  Promise<{ accepted: string } | { rejected: true } | { history: string } | { deleted: true }> {
  let res: Response;
  try {
    res = await o.fetch(`${o.server}/v1/projects/${encodeURIComponent(o.remoteId)}`, {
      method: "PUT"
    , headers: {
        ...headers(o.token)
      , "content-type": "application/json"
      , "x-boxglow-op": pending.opId
      , ...(o.epoch ? { "x-boxglow-epoch": o.epoch } : {})
      , ...(pending.expected === null ? { "if-none-match": "*" } : { "if-match": `"${pending.expected}"` })
      }
    , body: text
    });
  } catch (e) { throw new SyncNetworkError(String(e)); }
  rejectUnauthorized(res);
  if (res.status === 200 || res.status === 201) {
    const revision = unquote(res.headers.get("etag"));
    if (!revision) throw new SyncNetworkError("no ETag");
    return { accepted: revision };
  }
  if (res.status === 412) return { rejected: true };
  if (res.status === 409) return { history: res.headers.get("x-boxglow-epoch") ?? "" };
  // 取得と送信の間に、サーバーで計画が消された
  if (res.status === 410) return { deleted: true };
  let detail = "";
  try { detail = (await res.text()).slice(0, 200); } catch { /* 本文が読めなくても、状態コードで分類する */ }
  if (TERMINAL_STATUS.has(res.status)) throw new SyncRejectedError(res.status, detail);
  throw new SyncNetworkError(`unexpected response ${res.status}: ${detail}`);
}

/**
 * 1 回の同期 (手元とサーバーがそろうか、止まるまで)
 * Input : options = SyncOptions
 * Output: SyncResult。通信の失敗は SyncNetworkError (やりかけの操作は残る。もう一度実行すれば続きから)
 */
export async function syncOnce(options: SyncOptions): Promise<SyncResult> {
  const now = options.now ?? (() => new Date());
  const doFetch = options.fetch ?? fetch;
  const server = normalizeServer(options.server);
  const file = realFile(options.file);
  let pulled = 0, pushed = 0, edited = 0;
  // 表示するコマンドに付ける対象 (結び付けが決まったら、その ID に置き換える)
  const target = { server, remoteId: options.remoteId ?? "", file };
  // 最後に読んだ手元の中身のハッシュ (結果に入れる。常時の同期が、「確かめた後で変わった編集」に気づくために使う)
  let lastLocal: string | null | undefined;
  const halted = (halt: Halt | ClientHalt, extra: { recovery?: { token: string; applied: RecoveryOutcome; notApplied: RecoveryOutcome } } = {}): SyncResult =>
    ({ status: "halted", halt, pulled, pushed, edited, target, localHash: lastLocal, ...extra });
  // 同じファイルを扱う同期は、サーバーが違っても 1 つだけ (下の「別のサーバーに結び付いていないか」の確認と、結び付けの作成の間に割り込ませない)
  const unlockFile = lockFileSync(file);
  if (!unlockFile) return { status: "busy", what: "sync" };
  let unlock: (() => void) | null = null;
  try {
    // 1 つのファイルの結び付けは 1 つだけ: 別のサーバーに結び付いているファイルを、新しいサーバーへ結び付けない
    // (2 つのサーバーへ同時に結び付けると、片方から受け取った変更をもう片方へ送ることになる。その扱いは決めていない)
    const known = bindingsOf(file);
    const elsewhere = known.bindings.find((b) => b.server !== server);
    if (elsewhere) return halted({ reason: "bound-elsewhere", server: elsewhere.server });
    const store = new StateStore(bindingDir(file, server));
    unlock = store.lock();
    if (!unlock) return { status: "busy", what: "sync" };
    let stored = store.read();
    // 新しい結び付けを作ることになる場合: 状態を読めないフォルダがあると、このファイルがすでに結び付いているかを確かめられない。
    // 確かめられないまま、別の結び付けを作らない (読めるものだけを見て「未接続」とみなさない)
    if (!stored && known.unreadable.length > 0) return halted({ reason: "unreadable-bindings", dirs: known.unreadable });
    // 指定したサーバー側の計画の ID が、結び付け済みの ID と違うなら、通信も書き込みもせずに止まる
    if (stored && options.remoteId !== undefined && options.remoteId !== stored.binding.remoteId) {
      return halted({ reason: "binding-target", bound: stored.binding.remoteId, requested: options.remoteId });
    }
    // 状態を書く (世代の照合つき)。書いた後の状態を覚え直す
    const save = (next: SyncState, binding: Binding) => {
      const value: StoredState = { ...next, version: 1, binding };
      store.write(value, stored?.generation ?? null);
      stored = value;
    };
    for (let round = 0; round < 12; round++) {
      // ---- 読む: 手元のファイル ----
      const localText = existsSync(file) ? readFileSync(file, "utf8") : null;
      const local: Content | null = localText === null ? null : { hash: hashOf(localText), text: localText };
      const planId = localText === null ? null : planIdOf(localText);
      lastLocal = local?.hash ?? null;
      await options.onStep?.("local:read");
      // 結び付け: 初めてなら作る (サーバー側の ID は手元で決める)。同じパスに別の計画が置かれていたら、同期しない
      let binding: Binding = stored?.binding ?? { file, server, remoteId: options.remoteId ?? randomUUID(), planId: planId ?? "" };
      // (初めての結び付けで選択待ちのあいだは、まだ状態が無いので、ここには来ない。
      //  初めての受け取りを記録した後は、書く予定の計画の ID が固定されている。受け取りを書けたか分からない場面では、手元が別の ID でも、
      //  ここでは止めずに「受け取りの再開」の確認に任せる)
      // 基準がまだ無い (初めての結び付けが成立していない) 間は、計画の ID を固定しない: 受け取りを書かずに終わった後は、
      // 結び付ける前の状態に戻ったのと同じで、手元にどの計画があっても、改めて初回の選択から始められる
      if (stored && stored.base !== null && planId !== null && binding.planId !== "" && planId !== binding.planId && stored.pending?.kind !== "pull") {
        return halted({ reason: "binding-mismatch", expected: binding.planId, actual: planId });
      }
      target.remoteId = binding.remoteId;
      const state: SyncState = stored ?? { generation: 0, epoch: null, base: null, pending: null };
      const remoteOptions = { server, remoteId: binding.remoteId, token: options.token, fetch: doFetch };
      // ---- 読む: サーバー (やりかけの送りがあるときも取得する。履歴の世代が変わっていないかを、送り直しの前に確かめるため) ----
      const { remote, account } = await fetchRemote(remoteOptions);
      // ---- 利用者を確かめる (基準・やりかけの操作・人の選択を使う前に) ----
      // 利用者ごとに別の計画が、同じ ID・同じ版番号を持てる。確かめずに進むと、別の利用者の計画を、前の利用者の基準で「未変更」と読み違える
      if (options.confirmAccount !== undefined && options.confirmAccount !== account) return halted({ reason: "account-mismatch", bound: options.confirmAccount, actual: account });
      if (stored) {
        if (stored.binding.account === undefined) {
          // 利用者の記録が無い状態: 人が「この利用者のもの」と確かめたときだけ、記録して進む (黙って、今の利用者のものと決めない)
          if (options.confirmAccount !== account) return halted({ reason: "account-unconfirmed", account });
          save({ ...state, generation: state.generation + 1 }, { ...stored.binding, account });
          continue;
        }
        if (stored.binding.account !== account) return halted({ reason: "account-mismatch", bound: stored.binding.account, actual: account });
      } else binding = { ...binding, account };
      const bindingId = bindingIdOf(store.dir, binding.remoteId, account);
      // ---- 止まっている「受け取りの再開」に、人の選択が渡されたら進める ----
      // サーバーを取得してから照合する: 印は、表示したときの状態・手元・サーバーの位置に結び付いている。どれかが変わっていたら進めない
      if (state.pending?.kind === "pull" && options.recover && round === 0) {
        try {
          const next = pullRecovered(state, options.recover, local?.hash ?? null, remoteMark(remote), bindingId, hashOf);
          save(next, options.recover.applied ? written(binding) : notWritten(binding));
          continue;
        } catch (e) {
          // 印が合わない・履歴の世代が変わっている。操作を残したまま、今の状態でもう一度止まって表示し直す
          if (!(e instanceof SyncStateError)) throw e;
        }
      }
      const input = {
        // (印は、サーバーの場所・ファイル・サーバー側の計画の ID に結び付ける。ある計画を見て得た選択を、別の計画には使えない)
        state, local, remote, bindingId: bindingId
      , baseText: state.base ? store.getObject(state.base.hash) : null
      , now: now(), hashOf
      , approvedDeletion: options.approvedDeletion, restoreDeletion: options.restoreDeletion
      , resolution: options.resolution, firstLink: options.firstLink
      };
      const decision = decide(input);
      await options.onStep?.(decision.kind);
      // 人の選択 (初回の選択・競合の解決) が渡されたのに、最初の判断がそれを使わなかった場合は、何もせずに止まる。
      // 選択なしの同期として進めると、選んだつもりの内容と違うことが起きる (例: 対象の指定が抜けて、新しい計画を作ってしまう)
      if (round === 0 && decision.kind !== "halt") {
        const used = "usedChoice" in decision ? decision.usedChoice : undefined;
        if (options.firstLink && used !== "firstLink") return halted({ reason: "choice-not-applied", choice: "firstLink" });
        if (options.resolution && used !== "resolution") return halted({ reason: "choice-not-applied", choice: "resolution" });
      }
      switch (decision.kind) {
        case "noop":
          return { status: "synced", pulled, pushed, edited, revision: state.base?.revision ?? null, localHash: local?.hash ?? null };
        case "halt":
          // 受け取りの再開で止まったときは、選ぶための印と、2 つの続け方それぞれの結果を添える (人に、過去の出来事を当てさせない)
          if (decision.halt.reason === "recover-pull" && remote.kind === "present") {
            const preview = previewRecovery(input, (hash) => store.getObject(hash));
            // 実行の側の確認 (計画の ID の食い違い) も、見比べに反映する。
            // 「反映済み」を選ぶと、初めての受け取りなら仮の ID が確定し、基準ができる。そのとき手元が別の計画なら、送る前に止まる。
            // 「反映されていない」を選んだ場合は、基準がもともと在るときだけ、結び付けの ID と手元を比べる
            const mismatch = (id: string, baseExists: boolean): boolean => baseExists && planId !== null && id !== "" && planId !== id;
            // (ID の確認は、次の書き込みより前に止める。その続け方では、手元のファイルもサーバーも変わらない)
            const stop = (_outcome: RecoveryOutcome): RecoveryOutcome => ({ next: "binding-mismatch", localChanges: [], remoteChanges: [] });
            const applied = mismatch(binding.pendingPlanId ?? binding.planId, true) ? stop(preview.applied) : preview.applied;
            const notApplied = mismatch(binding.planId, state.base !== null) ? stop(preview.notApplied) : preview.notApplied;
            return halted(decision.halt, { recovery: { token: recoveryToken(state, local?.hash ?? null, remoteMark(remote), bindingId), applied, notApplied } });
          }
          return halted(decision.halt);
        case "edit-local":
          // 手元だけを書き換える (消えた項目を戻す)。前提が違えば何もせず、次の判断で確かめ直す
          try {
            commitFile(file, decision.write.text, `"${decision.expectedLocal}"`);
            edited++;
          } catch (e) {
            if (e instanceof FileBusy) return { status: "busy", what: "file" };
            if (!(e instanceof FileConflict)) throw e;
          }
          break;
        case "set-base":
          // 新しい基準が指す中身 (判断に使った、取得済みのサーバーの中身) を先に置く
          for (const c of decision.keep) store.putObject(c.text);
          // 初めての結び付けなら、この時点の手元の計画の ID を、結び付けに固定する
          save(baseSet(state, decision.epoch, decision.base), state.base === null ? { ...binding, planId: planId ?? "" } : binding);
          break;
        case "finish-pull":
          save(pullWritten(state, decision.pending), written(binding));
          break;
        case "pull": {
          // 写しを先に置く (書く中身と、新しい基準になるサーバーの中身) → 操作を記録 → 手元に書く → 基準を進める
          for (const c of decision.keep) store.putObject(c.text);
          // 初めての結び付けでサーバーの側を採るときは、置き換える前に、今の手元の中身を退避する。
          // 退避は、操作を記録する前に行う (退避に失敗したら、何も記録せずにエラーで終わる。「書けたか分からない操作」を残さない)
          if (decision.backup && local !== null) copyFileSync(file, `${file}.before-sync-${local.hash.slice(0, 8)}.json`);
          // 初めての結び付けなら、これから手元に書く中身 (検査済み) の計画の ID を、仮の ID として操作と一緒に記録する。
          // 書けたと確かめたとき (この後すぐ、または次の実行で「書けていた」と分かったとき) に、結び付けの ID として確定する。
          // 書かなかったと分かったときは捨てる (結び付けの ID は、受け取りの前のまま)
          const pullBinding: Binding = state.base === null ? { ...binding, pendingPlanId: planIdOf(decision.write.text) ?? "" } : binding;
          save(recordPending(state, decision.epoch, decision.pending), pullBinding);
          await options.onStep?.("pull:recorded");
          try {
            commitFile(file, decision.write.text, local === null ? null : revisionOf(local.text));
          } catch (e) {
            // 「行われなかった」と確定できる失敗 (手元が先に変わった / 他が書き込み中): 操作を片付けて、やり直すか、今回は譲る
            if (e instanceof FileConflict) { save(pullNotWritten(stored!, decision.pending), notWritten(pullBinding)); break; }
            if (e instanceof FileBusy) { save(pullNotWritten(stored!, decision.pending), notWritten(pullBinding)); return { status: "busy", what: "file" }; }
            throw e; // それ以外は、書けたかどうか分からない。操作を残したまま (次の実行で、人に確かめる)
          }
          await options.onStep?.("pull:written");
          save(pullWritten(stored!, decision.pending), written(pullBinding));
          pulled++;
          break;
        }
        case "push":
        case "resend": {
          let pending: PendingPush;
          if (decision.kind === "push") {
            store.putObject(decision.content.text);
            pending = { kind: "push", opId: randomUUID(), hash: decision.content.hash, expected: decision.expected, at: now().toISOString() };
            save(recordPending(state, decision.epoch, pending), state.base === null ? { ...binding, planId: planId ?? "" } : binding);
          } else pending = decision.pending;
          // サーバーに断られた操作は、同じ中身を送り直さない (手元を直しても、残った操作の中身は変わらないので、同じ理由で断られ続ける)。
          // 中身を送らずに「この操作を受理したか」を問い合わせて、片付ける:
          //   受理していた (前の送信は届いていて、応答だけ失われた。その後で断られるようになった) → 受理として基準を進める
          //   受理していない → 操作を消す。次の判断で、今の手元の中身から、新しい操作として送り直す
          // どちらの場合も、手元の編集は落とさない (手元のファイルが正。送る予定だった写しも、状態の置き場に残る)
          if (pending.rejected) {
            const op = await fetchOperation(remoteOptions, pending.opId);
            // (取得と問い合わせの間に、利用者や履歴の世代が変わっていたら、答えを使わない)
            if (op.account !== account) return halted({ reason: "account-mismatch", bound: account, actual: op.account });
            if (op.epoch !== stored!.epoch) return halted({ reason: "history-changed", expected: stored!.epoch ?? "", actual: op.epoch });
            if (op.revision !== null) { save(pushAccepted(stored!, pending.opId, op.revision), stored!.binding); pushed++; }
            else save(pushRejected(stored!, pending.opId), stored!.binding);
            break;
          }
          const text = store.getObject(pending.hash);
          if (text === null) throw new Error("the content of a pending push is missing from the sync state folder");
          let result: Awaited<ReturnType<typeof sendPush>>;
          try {
            result = await sendPush({ ...remoteOptions, epoch: stored!.epoch }, pending, text);
          } catch (e) {
            // 断られた (待っても直らない): 操作は残したまま、断られた印を付ける。次の実行は、送り直さずに、受理の有無の問い合わせから始める
            if (e instanceof SyncRejectedError) save(pushRefused(stored!, pending.opId, e.status, now().toISOString()), stored!.binding);
            throw e;
          }
          await options.onStep?.("push:sent");
          if ("history" in result) return halted({ reason: "history-changed", expected: stored!.epoch ?? "", actual: result.history });
          // サーバーで計画が消されていた: 操作と送る予定の写しは残したまま止まる (送り直さない・作り直さない)
          if ("deleted" in result) return halted({ reason: "remote-deleted" });
          if ("accepted" in result) { save(pushAccepted(stored!, pending.opId, result.accepted), stored!.binding); pushed++; }
          else save(pushRejected(stored!, pending.opId), stored!.binding);
          break;
        }
      }
    }
    // 他の端末や手元の書き手と競り負け続けた。今回は譲る (次の実行で続きから)
    return { status: "busy", what: "sync" };
  } finally {
    unlock?.();
    unlockFile();
  }
}

/** 受け取りを書けたと確かめたときの結び付け: 仮の ID があれば、結び付けの ID として確定する */
function written(binding: Binding): Binding {
  const { pendingPlanId, ...rest } = binding;
  return pendingPlanId === undefined ? rest : { ...rest, planId: pendingPlanId };
}
/** 受け取りを書かなかったと分かったときの結び付け: 仮の ID を捨てる (結び付けの ID は、受け取りの前のまま) */
function notWritten(binding: Binding): Binding {
  const { pendingPlanId: _dropped, ...rest } = binding;
  return rest;
}

/** 計画の文字列から、計画の ID を取り出す (読めなければ null) */
function planIdOf(text: string): string | null {
  try { const id = (JSON.parse(text) as { id?: unknown }).id; return typeof id === "string" ? id : null; } catch { return null; }
}

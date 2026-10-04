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
  baseSet, decide, previewRecovery, pullNotWritten, pullRecovered, pullWritten, pushAccepted, pushRejected, recordPending, recoveryToken as engineRecoveryToken, remoteMark, SyncStateError
, type Content, type Halt, type PendingPush, type RecoveryOutcome, type Remote, type RemoteMark, type SyncState
} from "../../src/sync/engine";
import { bindingDir, bindingsOf, hashOf, normalizeServer, realFile, StateStore, type Binding, type StoredState } from "./state-store";
import { APP_VERSION, SAVE_PROTOCOL } from "../../src/model/version";

/** 同期の結果 */
export type SyncResult =
  /** 手元とサーバーがそろった (pulled = 受け取って手元に書いた回数, pushed = 送って受理された回数) */
  | { status: "synced"; pulled: number; pushed: number; revision: string | null }
  /**
   * 人に確かめる必要があって止まった。
   * recovery = 受け取りの再開で止まったときの、選ぶための印と、2 つの続け方それぞれの「選んだ後の結果」
   */
  | { status: "halted"; halt: Halt | ClientHalt
    ; recovery?: { token: string; applied: RecoveryOutcome; notApplied: RecoveryOutcome }
      /** 止まる前に、この実行で行ったこと (受け取って手元に書いた回数、送って受理された回数) */
    ; pulled: number; pushed: number }
  /** 他の処理が動いていて、今回は進められなかった (待てば直る)。what = "sync" (他の同期の処理) / "file" (計画のファイルが書き込み中) */
  | { status: "busy"; what: "sync" | "file" };

/** 実行の側 (結び付けの確認) で止まる理由 */
export type ClientHalt =
  /** 同じパスに、結び付けたときとは別の計画 (ID が違う) が置かれている */
  | { reason: "binding-mismatch"; expected: string; actual: string }
  /** 指定したサーバー側の計画の ID が、この結び付けの ID と違う (指定と違う計画へ、黙って書かない) */
  | { reason: "binding-target"; bound: string; requested: string }
  /** この計画のファイルは、すでに別のサーバーに結び付いている (1 つのファイルの結び付けは 1 つだけ) */
  | { reason: "bound-elsewhere"; server: string };

/** サーバーとの通信の失敗 (やりかけの操作は残したまま。後でやり直せる) */
export class SyncNetworkError extends Error {}

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
  /** 今の時刻 (試験で差し替える) */
  now?: () => Date;
  /** 通信の関数 (試験で差し替える) */
  fetch?: typeof fetch;
  /** 1 手ごとに呼ばれる (試験で、途中に割り込むために使う) */
  onStep?: (kind: string) => void;
}

/** 止まっている「受け取りの再開」の印: やりかけの操作と、今の手元の中身に結び付ける (表示のあとで手元が変わったら、選び直しになる) */
export function recoveryToken(state: SyncState, localHash: string | null, remote: RemoteMark): string {
  return engineRecoveryToken(state, localHash, remote, hashOf);
}

/**
 * サーバーの今の状態を取得する
 * Input : server・remoteId・token・fetch
 * Output: Remote (在る / まだ無い / 消されている)。通信できなければ SyncNetworkError
 */
async function fetchRemote(o: { server: string; remoteId: string; token?: string; fetch: typeof fetch }): Promise<Remote> {
  let res: Response;
  try {
    res = await o.fetch(`${o.server}/v1/projects/${encodeURIComponent(o.remoteId)}`, { headers: headers(o.token) });
  } catch (e) { throw new SyncNetworkError(String(e)); }
  const epoch = res.headers.get("x-boxglow-epoch");
  if (!epoch) throw new SyncNetworkError(`unexpected response ${res.status} (no epoch)`);
  if (res.status === 404) return { kind: "absent", epoch };
  if (res.status === 410) return { kind: "deleted", epoch };
  if (res.status !== 200) throw new SyncNetworkError(`unexpected response ${res.status}`);
  const revision = unquote(res.headers.get("etag"));
  if (!revision) throw new SyncNetworkError("no ETag");
  const text = await res.text();
  return { kind: "present", epoch, revision, content: { hash: hashOf(text), text } };
}

/**
 * 全部の計画の最新の版を、1 回の要求で取得する (常時の同期が、どの計画が進んだかを確かめるのに使う)
 * Input : server・token・fetch
 * Output: { epoch = サーバーの履歴の世代, heads = 計画の ID → { revision (まだ無ければ null), deleted } }。通信できなければ SyncNetworkError
 */
export async function fetchHeads(o: { server: string; token?: string; fetch?: typeof fetch }): Promise<{ epoch: string; heads: Map<string, { revision: string | null; deleted: boolean }> }> {
  let res: Response;
  try { res = await (o.fetch ?? fetch)(`${normalizeServer(o.server)}/v1/projects`, { headers: headers(o.token) }); } catch (e) { throw new SyncNetworkError(String(e)); }
  const epoch = res.headers.get("x-boxglow-epoch");
  if (res.status !== 200 || !epoch) throw new SyncNetworkError(`unexpected response ${res.status}`);
  const list = await res.json() as { id: string; revision: string | null; deleted: boolean }[];
  return { epoch, heads: new Map(list.map((p) => [p.id, { revision: p.revision, deleted: !!p.deleted }])) };
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
 *         通信できない・想定外の応答は SyncNetworkError (操作は残したまま)
 */
async function sendPush(o: { server: string; remoteId: string; token?: string; fetch: typeof fetch; epoch: string | null }, pending: PendingPush, text: string):
  Promise<{ accepted: string } | { rejected: true } | { history: string }> {
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
  if (res.status === 200 || res.status === 201) {
    const revision = unquote(res.headers.get("etag"));
    if (!revision) throw new SyncNetworkError("no ETag");
    return { accepted: revision };
  }
  if (res.status === 412) return { rejected: true };
  if (res.status === 409) return { history: res.headers.get("x-boxglow-epoch") ?? "" };
  throw new SyncNetworkError(`unexpected response ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
  // 1 つのファイルの結び付けは 1 つだけ: 別のサーバーに結び付いているファイルを、新しいサーバーへ結び付けない
  // (2 つのサーバーへ同時に結び付けると、片方から受け取った変更をもう片方へ送ることになる。その扱いは決めていない)
  const elsewhere = bindingsOf(file).bindings.find((b) => b.server !== server);
  if (elsewhere) return { status: "halted", halt: { reason: "bound-elsewhere", server: elsewhere.server }, pulled: 0, pushed: 0 };
  const store = new StateStore(bindingDir(file, server));
  const unlock = store.lock();
  if (!unlock) return { status: "busy", what: "sync" };
  try {
    let stored = store.read();
    let pulled = 0, pushed = 0;
    // 指定したサーバー側の計画の ID が、結び付け済みの ID と違うなら、通信も書き込みもせずに止まる
    if (stored && options.remoteId !== undefined && options.remoteId !== stored.binding.remoteId) {
      return { status: "halted", halt: { reason: "binding-target", bound: stored.binding.remoteId, requested: options.remoteId }, pulled, pushed };
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
      // 結び付け: 初めてなら作る (サーバー側の ID は手元で決める)。同じパスに別の計画が置かれていたら、同期しない
      const binding: Binding = stored?.binding ?? { file, server, remoteId: options.remoteId ?? randomUUID(), planId: planId ?? "" };
      // (初めての結び付けで選択待ちのあいだは、まだ状態が無いので、ここには来ない。
      //  初めての受け取りを記録した後は、書く予定の計画の ID が固定されている。受け取りを書けたか分からない場面では、手元が別の ID でも、
      //  ここでは止めずに「受け取りの再開」の確認に任せる)
      if (stored && planId !== null && binding.planId !== "" && planId !== binding.planId && stored.pending?.kind !== "pull") {
        return { status: "halted", halt: { reason: "binding-mismatch", expected: binding.planId, actual: planId }, pulled, pushed };
      }
      const state: SyncState = stored ?? { generation: 0, epoch: null, base: null, pending: null };
      const remoteOptions = { server, remoteId: binding.remoteId, token: options.token, fetch: doFetch };
      // ---- 読む: サーバー (やりかけの送りがあるときも取得する。履歴の世代が変わっていないかを、送り直しの前に確かめるため) ----
      const remote: Remote = await fetchRemote(remoteOptions);
      // ---- 止まっている「受け取りの再開」に、人の選択が渡されたら進める ----
      // サーバーを取得してから照合する: 印は、表示したときの状態・手元・サーバーの位置に結び付いている。どれかが変わっていたら進めない
      if (state.pending?.kind === "pull" && options.recover && round === 0) {
        try {
          save(pullRecovered(state, options.recover, local?.hash ?? null, remoteMark(remote), hashOf), binding);
          continue;
        } catch (e) {
          // 印が合わない・履歴の世代が変わっている。操作を残したまま、今の状態でもう一度止まって表示し直す
          if (!(e instanceof SyncStateError)) throw e;
        }
      }
      const input = {
        state, local, remote, bindingId: basename(store.dir)
      , baseText: state.base ? store.getObject(state.base.hash) : null
      , now: now(), hashOf
      , approvedDeletion: options.approvedDeletion, restoreDeletion: options.restoreDeletion
      , resolution: options.resolution, firstLink: options.firstLink
      };
      const decision = decide(input);
      options.onStep?.(decision.kind);
      switch (decision.kind) {
        case "noop":
          return { status: "synced", pulled, pushed, revision: state.base?.revision ?? null };
        case "halt":
          // 受け取りの再開で止まったときは、選ぶための印と、2 つの続け方それぞれの結果を添える (人に、過去の出来事を当てさせない)
          if (decision.halt.reason === "recover-pull" && remote.kind === "present") {
            return { status: "halted", halt: decision.halt, pulled, pushed
            , recovery: { token: recoveryToken(state, local?.hash ?? null, remoteMark(remote)), ...previewRecovery(input, (hash) => store.getObject(hash)) } };
          }
          return { status: "halted", halt: decision.halt, pulled, pushed };
        case "edit-local":
          // 手元だけを書き換える (消えた項目を戻す)。前提が違えば何もせず、次の判断で確かめ直す
          try {
            commitFile(file, decision.write.text, `"${decision.expectedLocal}"`);
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
          save(pullWritten(state, decision.pending), binding);
          break;
        case "pull": {
          // 写しを先に置く (書く中身と、新しい基準になるサーバーの中身) → 操作を記録 → 手元に書く → 基準を進める
          for (const c of decision.keep) store.putObject(c.text);
          // 初めての結び付けなら、これから手元に書く中身 (検査済み) の計画の ID を、操作の記録と一緒に結び付けへ固定する。
          // 書いた直後に落ちて、次の実行が「書けていた」として続ける場合にも、ID が空のまま残らない
          // (空のままだと、同じパスに別の計画が置かれても気づけず、既存の同期先へ別の計画を送ってしまう)
          const pullBinding: Binding = state.base === null ? { ...binding, planId: planIdOf(decision.write.text) ?? "" } : binding;
          save(recordPending(state, decision.epoch, decision.pending), pullBinding);
          try {
            // 初めての結び付けでサーバーの側を採るときは、置き換える前に、今の手元の中身を退避する
            if (decision.backup && local !== null) copyFileSync(file, `${file}.before-sync-${local.hash.slice(0, 8)}.json`);
            commitFile(file, decision.write.text, local === null ? null : revisionOf(local.text));
          } catch (e) {
            // 「行われなかった」と確定できる失敗 (手元が先に変わった / 他が書き込み中): 操作を片付けて、やり直すか、今回は譲る
            if (e instanceof FileConflict) { save(pullNotWritten(stored!, decision.pending), binding); break; }
            if (e instanceof FileBusy) { save(pullNotWritten(stored!, decision.pending), binding); return { status: "busy", what: "file" }; }
            throw e; // それ以外は、書けたかどうか分からない。操作を残したまま (次の実行で、人に確かめる)
          }
          options.onStep?.("pull:written"); // (試験用: 手元に書いた直後・基準を進める前)
          save(pullWritten(stored!, decision.pending), pullBinding);
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
          const text = store.getObject(pending.hash);
          if (text === null) throw new Error("the content of a pending push is missing from the sync state folder");
          const result = await sendPush({ ...remoteOptions, epoch: stored!.epoch }, pending, text);
          options.onStep?.("push:sent"); // (試験用: サーバーが応答した直後・状態を進める前)
          if ("history" in result) return { status: "halted", halt: { reason: "history-changed", expected: stored!.epoch ?? "", actual: result.history }, pulled, pushed };
          if ("accepted" in result) { save(pushAccepted(stored!, pending.opId, result.accepted), stored!.binding); pushed++; }
          else save(pushRejected(stored!, pending.opId), stored!.binding);
          break;
        }
      }
    }
    // 他の端末や手元の書き手と競り負け続けた。今回は譲る (次の実行で続きから)
    return { status: "busy", what: "sync" };
  } finally {
    unlock();
  }
}

/** 計画の文字列から、計画の ID を取り出す (読めなければ null) */
function planIdOf(text: string): string | null {
  try { const id = (JSON.parse(text) as { id?: unknown }).id; return typeof id === "string" ? id : null; } catch { return null; }
}

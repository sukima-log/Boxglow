/**
 * 計画ファイル (boxglow.json) を安全に書くための共通の手順: ロック + リビジョン照合 (CAS) + 原子的な置換
 * CLI・ローカルサーバ (serve)・VS Code 拡張 (Node 側) がすべてこの手順を通ることで、
 * 同時に書いたときに片方の変更が黙って消えるのを防ぐ (古い内容からの保存は拒否する)。
 * ロックは「同じ方式を使う Boxglow 同士」の協調ロック (<ファイル>.boxglow-lock というディレクトリ。中の owner.json に持ち主を書く)。
 * 旧版や他のエディタの直接の書き込みは参加しない。
 * 取れないときは短い間隔で数秒待ち、異常終了で残った古いロックは自動で回収する (持ち主のプロセスがいない、または取得から時間が経ちすぎている)
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
// 文言を今の言語 (日本語 / 英語) で出す
import { t } from "../src/i18n/core";

/**
 * ファイルの中身からリビジョン (版の印) を作る。HTTP の ETag としてもそのまま使う
 * Input : text = ファイルの中身 (文字列)
 * Output: 二重引用符で囲んだ SHA-256 の 16 進文字列 (例: "\"ab12...\"")
 */
export const revisionOf = (text: string): string => `"${createHash("sha256").update(text).digest("hex")}"`;

/** 読んだ後に他の誰かがファイルを書き換えていた (保存は行っていない)。読み直してからやり直してもらう */
export class FileConflict extends Error {
  constructor() { super(t("計画が他の変更で更新されています。最新の内容を読み直してからやり直してください (今回の変更は書き込んでいません)")); }
}

/** 他の Boxglow が書き込み中 (ロックを持っている)。終わってからやり直してもらう */
export class FileBusy extends Error {
  constructor() { super(t("他の Boxglow が計画ファイルに書き込み中です (ロック中)。終わってからやり直してください")); }
}

/**
 * ロックと置換の対象にする「実体のパス」を決める (シンボリックリンク経由でも同じロックを見るため)
 * Input : file = ファイルのパス (相対でもよい)
 * Output: ファイルがあれば実体の絶対パス、無ければ絶対パスにしただけのもの
 */
const canonical = (file: string) => existsSync(file) ? realpathSync(file) : resolve(file);

/** ロックを古いとみなすまでの時間 (ms)。VS Code 拡張が保存の await をまたいで持つ時間 (通常は 1 秒未満) より十分長くする */
export const LOCK_STALE_MS = 30_000;
/** 生きている持ち主のロックでも回収する時間 (固まったプロセスへの備え。通常の保存はミリ秒で終わる) */
const LOCK_HARD_STALE_MS = 5 * 60 * 1000;
/** ロックが空くのを待つ時間の上限 (ms)。これを過ぎたら FileBusy */
export const LOCK_WAIT_MS = 3_000;
/** ロックを取り直す間隔 (ms) */
const LOCK_RETRY_MS = 25;
/** Windows で置換 (rename) が一時的に断られたとき (ウイルス対策や他のプロセスが開いている間) にやり直す回数 */
const RENAME_RETRIES = 8;

/** ロックの持ち主の情報 (ロックのディレクトリの中の owner.json に書く) */
interface LockOwner {
  /** 取得したプロセスの番号 */
  pid: number;
  /** 取得したマシンの名前 (別のマシンの pid は生死を確かめられないので、同じホストかどうかを見る) */
  host: string;
  /** 取得した時刻 (ISO 8601) */
  at: string;
  /** 取得ごとの印 (解放のときに「自分が取ったロックのままか」を確かめる) */
  token: string;
}

/** このプロセスが今持っているロック (ロックのパスの集合)。同じプロセスの中では待っても空かないので、すぐ FileBusy にする */
const heldLocks = new Set<string>();

/**
 * 指定した時間だけ止まる (同期。CLI の 1 コマンドは同期で動くので、待つ間もイベントループに戻らない)
 * Input : ms = 止まる時間 (ms)
 * Output: なし
 */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * プロセスが生きているか確かめる (シグナル 0 は何も送らず、存在だけを確かめる)
 * Input : pid = プロセスの番号
 * Output: 生きていれば true。権限が無くて確かめられないとき (EPERM) も、存在はするので true
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * ロックの持ち主の情報を読む
 * Input : lock = ロックのディレクトリのパス
 * Output: 持ち主の情報。読めない (旧版の空のロック、作った直後でまだ書かれていない、壊れている) なら null
 */
function readOwner(lock: string): LockOwner | null {
  try {
    const o = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as Partial<LockOwner>;
    return typeof o.pid === "number" && typeof o.host === "string" && typeof o.at === "string" && typeof o.token === "string" ? (o as LockOwner) : null;
  } catch {
    return null;
  }
}

/**
 * 残っているロックが古い (回収してよい) か判定する
 * Input : lock = ロックのディレクトリのパス, owner = 読めた持ち主の情報 (読めなければ null), staleMs = 古いとみなすまでの時間
 * Output: 回収してよければ true。
 *         同じホストなら、持ち主のプロセスがもういない場合 (生きている持ち主からは、5 分を過ぎるまで奪わない)。
 *         別のホストや持ち主の生死が分からない場合は、取得から staleMs を過ぎている場合
 *         (持ち主が読めないロックは、ディレクトリの更新時刻から staleMs を過ぎていれば古いとみなす)
 */
function isStale(lock: string, owner: LockOwner | null, staleMs: number): boolean {
  if (!owner) {
    try { return Date.now() - statSync(lock).mtimeMs > staleMs; } catch { return false; } // 消えていたら、次の取得の試行に任せる
  }
  const age = Date.now() - Date.parse(owner.at);
  if (Number.isNaN(age)) return true; // 時刻が読めない記録は古い扱いにする
  if (owner.host === hostname() && owner.pid !== process.pid) {
    // 同じホスト: 持ち主のプロセスがもういなければすぐ回収する。生きている間は、時間が過ぎただけでは奪わない
    // (保存に時間がかかっているだけの持ち主から奪うと、2 つの書き込みが重なる)。固まったプロセスへの備えとして、十分長い時間 (LOCK_HARD_STALE_MS) で回収する
    if (!isAlive(owner.pid)) return true;
    return age > LOCK_HARD_STALE_MS;
  }
  // 別のホスト (共有フォルダ) や自分と同じ pid (同じプロセスの別の処理) は生死を確かめられないので、時間切れで判定する
  return age > staleMs;
}

/**
 * 古いロックを回収する (改名は原子的なので、同時に回収しようとしても 1 つだけが成功する)
 * Input : lock = ロックのディレクトリのパス, judged = 古いと判定したときに読んだ持ち主の情報 (読めなかったなら null)
 * Output: なし (回収できなくても例外にしない。呼び出し側がもう一度取得を試す)
 */
function reclaim(lock: string, judged: LockOwner | null): void {
  const aside = `${lock}.${randomUUID()}.stale`;
  try {
    renameSync(lock, aside);
  } catch {
    return; // 他の誰かが先に回収した・解放された
  }
  // 判定してから改名するまでの間に、他の誰かが回収して取り直していたら、それは生きているロックなので元に戻す
  const moved = readOwner(aside);
  if ((moved?.token ?? null) !== (judged?.token ?? null)) {
    try { renameSync(aside, lock); return; } catch { /* 戻せない (もう次のロックがある) ときは、下で片付けるだけにする */ }
  }
  try { rmSync(aside, { recursive: true, force: true }); } catch { /* 片付けられなくても、ロックそのものはもう無い */ }
}

/**
 * ファイルの書き込みロックを取る (ディレクトリの作成は原子的なので、先に作れた 1 つだけが進める)
 * Input : file = ロックしたいファイルのパス,
 *         opts = { waitMs = 空くのを待つ時間の上限 (既定 LOCK_WAIT_MS), staleMs = 古いロックとみなすまでの時間 (既定 LOCK_STALE_MS) }
 * Output: ロックを外す関数 (失敗しても例外を投げない)。
 *         他がロック中なら短い間隔で取り直し、waitMs 待ってもだめなら FileBusy を投げる。
 *         このプロセス自身が持っているロックは、待っても空かない (同期で待つ間は解放の処理が動かない) ので、すぐ FileBusy を投げる
 */
export function lockFile(file: string, opts: { waitMs?: number; staleMs?: number } = {}): () => void {
  const lock = `${canonical(file)}.boxglow-lock`;
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (heldLocks.has(lock)) throw new FileBusy();
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      // すでにあれば他の書き手が作業中。それ以外 (権限など) はそのまま伝える
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    // 異常終了などで残った古いロックは回収して、すぐ取り直す
    const owner = readOwner(lock);
    if (isStale(lock, owner, staleMs)) { reclaim(lock, owner); continue; }
    if (Date.now() >= deadline) throw new FileBusy();
    sleepSync(LOCK_RETRY_MS);
  }
  // 持ち主の情報を書く (書けなくてもロックは有効。そのときは更新時刻で古さを判定される)
  const token = randomUUID();
  try {
    const owner: LockOwner = { pid: process.pid, host: hostname(), at: new Date().toISOString(), token };
    writeFileSync(join(lock, "owner.json"), JSON.stringify(owner), "utf8");
  } catch { /* 上のとおり */ }
  heldLocks.add(lock);
  return () => {
    heldLocks.delete(lock);
    // 解放の失敗で、成功した書き込みを失敗に見せない (例外にしない)。残ったロックは、次の書き手が古いロックとして回収する
    try {
      // 時間切れで他に回収されて、別の持ち主のロックになっていたら消さない
      const now = readOwner(lock);
      if (now && now.token !== token) return;
      rmSync(lock, { recursive: true, force: true });
    } catch { /* 上のとおり */ }
  };
}

/**
 * 一時ファイルを書き先に改名する (Windows では、書き先を他のプロセスが開いている間 EPERM / EBUSY / EACCES になることがあるので、少し待ってやり直す)
 * Input : from = 一時ファイルのパス, to = 書き先のパス
 * Output: なし。やり直しても改名できなければ、最後のエラーを投げる
 */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= RENAME_RETRIES || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw e;
      sleepSync(20 * (attempt + 1));
    }
  }
}

/**
 * ファイルを書く: ロック → 今の中身が「読んだときの版」と同じか照合 → 同じフォルダの一時ファイルに書いて改名で置換
 * (改名は原子的なので、途中で落ちても半端な中身のファイルは残らない)
 * Input : file = 書き先, text = 新しい中身, expected = 読んだときのリビジョン (ファイルが無い前提なら null),
 *         opts = ロックの待ち時間など (lockFile と同じ。省略時は既定)
 * Output: 書いた後のリビジョン。版が違えば FileConflict、数秒待ってもロックが空かなければ FileBusy を投げる (どちらも書き込まない)
 */
export function commitFile(file: string, text: string, expected: string | null, opts: { waitMs?: number; staleMs?: number } = {}): string {
  const target = canonical(file);
  const unlock = lockFile(file, opts);
  let temp: string | undefined;
  try {
    // ロックの中で読み直して照合する (照合と置換の間に他の書き手が入らない)
    const current = existsSync(target) ? readFileSync(target, "utf8") : null;
    if ((current === null ? null : revisionOf(current)) !== expected) throw new FileConflict();
    // 同じフォルダに一時ファイルを作る (別のファイルシステムだと改名が原子的にならないため)。
    // 権限は元のファイルに合わせる。新しく作るファイルは既定 (0666 から umask を引いたもの。ふつうのファイルと同じ) にする
    temp = join(dirname(target), `.${randomUUID()}.boxglow-tmp`);
    const mode = current === null ? null : statSync(target).mode & 0o777;
    const fd = openSync(temp, "wx", mode ?? 0o666);
    try {
      // 作成時の権限は umask で削られるので、元のファイルがあるときは同じ権限に付け直す (Windows など付け直せない環境ではそのまま)
      if (mode !== null) { try { fchmodSync(fd, mode); } catch { /* 上のとおり */ } }
      writeFileSync(fd, text, "utf8");
      fsyncSync(fd); // ディスクに届いてから置換する
    } finally {
      closeSync(fd);
    }
    renameWithRetry(temp, target);
    temp = undefined; // 置換できたので、後片付けの対象から外す
    return revisionOf(text);
  } finally {
    // 失敗したときは一時ファイルを残さない。ロックは必ず外す
    try { if (temp && existsSync(temp)) unlinkSync(temp); } catch { /* 一時ファイルが残っても、計画ファイルは壊れない */ }
    unlock();
  }
}

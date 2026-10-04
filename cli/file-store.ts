/**
 * 計画ファイル (boxglow.json) を安全に書くための共通の手順: ロック + リビジョン照合 (CAS) + 原子的な置換
 * CLI・ローカルサーバ (serve)・VS Code 拡張 (Node 側) がすべてこの手順を通ることで、
 * 同時に書いたときに片方の変更が黙って消えるのを防ぐ (古い内容からの保存は拒否する)。
 * ロックは「同じ方式を使う Boxglow 同士」の協調ロック (<ファイル>.boxglow-lock というディレクトリ。中の owner.json に持ち主を書く)。
 * 旧版や他のエディタの直接の書き込みは参加しない。
 *
 * ロックを自動で回収するのは「持ち主が終了した」と確かめられたときだけ (Linux だけ):
 *   - 持ち主の記録に、マシン名・OS・プロセス番号の空間 (起動ごとの ID + PID 名前空間)・プロセスの開始時点が入っている
 *   - それが自分と同じ空間で、その番号のプロセスがいない、または同じ番号の別のプロセスに替わっている
 * 生きている持ち主、別のマシン、OS が違う (Windows と WSL はマシン名が同じでも番号の空間が別)、
 * 番号の空間を確かめられない OS (Windows・macOS)、記録が無い・読めない・不正・旧版の記録のロックは、時間が経っても奪わない
 * (FileBusy で止め、boxglow unlock で人が解除する)。
 * ロックのディレクトリを動かす操作 (解放・回収・人の解除) は、中に「動かす権利」(reclaim というディレクトリ) を排他的に置いてから行う (claimLock)。
 * 持ち主の記録は、ロックのディレクトリを置く前に中へ書いておく (改名で置く)。「記録の無い空のロック」という状態を作らないため
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

/**
 * 他の Boxglow が書き込み中 (ロックを持っている)。終わってからやり直してもらう。
 * status があれば、持ち主と判定の理由を文に添える (待っても解けないときに、次に何をすればよいか分かるように)
 */
export class FileBusy extends Error {
  /** ロックの状態 (持ち主・判定)。このプロセス自身が持っているロックのときは無い */
  status?: LockStatus;
  constructor(status?: LockStatus) {
    const base = t("他の Boxglow が計画ファイルに書き込み中です (ロック中)。終わってからやり直してください");
    super(status ? `${base}\n${describeLock(status)}` : base);
    this.status = status;
  }
}

/**
 * ロックと置換の対象にする「実体のパス」を決める (シンボリックリンク経由でも同じロックを見るため)
 * Input : file = ファイルのパス (相対でもよい)
 * Output: ファイルがあれば実体の絶対パス、無ければ絶対パスにしただけのもの
 */
const canonical = (file: string) => existsSync(file) ? realpathSync(file) : resolve(file);

/** ロックが空くのを待つ時間の上限 (ms)。これを過ぎたら FileBusy */
export const LOCK_WAIT_MS = 3_000;
/** ロックを取り直す間隔 (ms) */
const LOCK_RETRY_MS = 25;
/** Windows で置換 (rename) が一時的に断られたとき (ウイルス対策や他のプロセスが開いている間) にやり直す回数 */
const RENAME_RETRIES = 8;
/** 取得からこれ以上経っているロックには、解除の案内 (boxglow unlock) を添える (ms)。案内を出す目安で、ロックを無効にする期限ではない */
const LOCK_HINT_MS = 60_000;
/** 解放に失敗したロックの後片付けを、次の取得のときにやり直す回数の上限 */
const RELEASE_RETRIES = 3;

/** ロックの持ち主の情報 (ロックのディレクトリの中の owner.json に書く) */
export interface LockOwner {
  /** 取得したプロセスの番号 */
  pid: number;
  /** 取得したマシンの名前 */
  host: string;
  /** 取得した時刻 (ISO 8601) */
  at: string;
  /** 取得ごとの印 (解放のときに「自分が取ったロックのままか」を確かめる) */
  token: string;
  /** 取得した OS (process.platform)。0.4.0 以前の記録には無い (無い記録は、持ち主の生死を確かめられないものとして扱う) */
  platform?: string;
  /** プロセス番号の空間の印 (Linux だけ。起動ごとの ID + PID 名前空間)。確かめられない環境では null */
  space?: string | null;
  /** プロセスの開始時点の印 (Linux だけ。/proc/<pid>/stat の starttime の値そのまま)。番号の再利用を見分ける。取れなければ null */
  start?: string | null;
}

/** ロックの判定: live = 持ち主が動いている, dead = 持ち主の終了を確かめた (回収してよい), unknown = 確かめられない (自動では回収しない) */
export type LockVerdict = "live" | "dead" | "unknown";

/** ロックの状態 (boxglow unlock の表示と、FileBusy の文に使う) */
export interface LockStatus {
  /** ロックのディレクトリのパス */
  lock: string;
  /** 対象の計画ファイルのパス */
  file: string;
  /** 持ち主の情報 (読めなければ null) */
  owner: LockOwner | null;
  /** 判定 */
  verdict: LockVerdict;
  /** 判定の理由 (今の言語の文) */
  reason: string;
  /** 取得からの経過時間 (ms)。取得時刻が読めなければ null */
  ageMs: number | null;
  /** 回収・解除の権利 (reclaim) が置かれているか。回収中か、途中で止まった記録が残っている */
  reclaim: boolean;
  /** いちばん番号の大きい権利を置いた書き手 (読めなければ owner = null) とその判定。権利が無ければ null */
  reclaimer: { owner: LockOwner | null; verdict: LockVerdict; reason: string } | null;
  /** このロックの世代の印 (表示したときと解除するときで、同じロックのままかを確かめる)。持ち主の token。記録が無い・読めないロックは、ディレクトリの番号と作成時刻から作る */
  generation: string;
}

/** このプロセスが今持っているロック (ロックのパスの集合)。同じプロセスの中では待っても空かないので、すぐ FileBusy にする */
const heldLocks = new Set<string>();
/**
 * このプロセスが取り、処理が終わったあとの解放 (削除) に失敗したロック: ロックのパス → { token = 取得のときの印, tries = やり直した回数 }
 * 「自分が取って、もう使い終わった」と分かっているものだけを記録する (一覧に無いから放棄されたはず、という推測では消さない)
 */
const failedReleases = new Map<string, { token: string; tries: number }>();

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
    // 終了したと断定できるのは ESRCH のときだけ。権限・OS の一時的な失敗は回収の根拠にしない。
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * /proc/<pid>/stat を読んで、プロセス番号と開始時点を取り出す (Linux)
 * Input : who = "self" またはプロセス番号
 * Output: { pid = stat に書かれた番号, start = 開始時点 (システム起動からの値。文字列のまま) }。読めない・解釈できないときは null
 *         コマンド名は括弧で囲まれ、空白や括弧を含みうるので、最後の ")" より後ろだけを空白で分ける
 */
function procStat(who: number | "self"): { pid: number; start: string } | null {
  try {
    const text = readFileSync(`/proc/${who}/stat`, "utf8");
    const open = text.indexOf("("), close = text.lastIndexOf(")");
    if (open < 0 || close < open) return null;
    const pid = Number(text.slice(0, open).trim());
    // ")" の後ろは 3 番目の項目 (state) から始まる。starttime は 22 番目なので、後ろの 20 個目 (添字 19)
    const start = text.slice(close + 1).trim().split(/\s+/)[19];
    return Number.isSafeInteger(pid) && /^\d+$/.test(start ?? "") ? { pid, start } : null;
  } catch {
    return null;
  }
}

/** pidSpace の結果の控え (プロセスの間は変わらない)。undefined = まだ調べていない */
let cachedSpace: string | null | undefined;
/**
 * このプロセスの「プロセス番号の空間」の印を作る (Linux だけ)
 * Input : なし
 * Output: 起動ごとの ID (boot_id) と PID 名前空間の印をつないだ文字列。
 *         Linux 以外、/proc が読めない、/proc が別の PID 名前空間を映している (自分の番号と合わない) ときは null (= 確かめられない)
 *         同じ値の 2 つのプロセスは、同じ番号で同じプロセスを指す。マシン名が同じでも、Windows と WSL・別のコンテナ・再起動の前後では値が変わる
 */
export function pidSpace(): string | null {
  if (cachedSpace !== undefined) return cachedSpace;
  cachedSpace = null;
  if (process.platform !== "linux") return cachedSpace;
  try {
    // /proc が自分の PID 名前空間のものか (別の空間の /proc を見ていると、番号をそのまま比べられない)
    if (procStat("self")?.pid !== process.pid) return cachedSpace;
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const ns = readlinkSync("/proc/self/ns/pid");
    if (boot && ns) cachedSpace = `${boot}/${ns}`;
  } catch { /* 読めない環境では null のまま (確かめられない扱い) */ }
  return cachedSpace;
}

/**
 * このプロセスを持ち主とする記録を作る
 * Input : token = 取得ごとの印
 * Output: owner.json に書く持ち主の情報
 */
function selfOwner(token: string): LockOwner {
  return {
    pid: process.pid
  , host: hostname()
  , at: new Date().toISOString()
  , token
  , platform: process.platform
  , space: pidSpace()
  , start: process.platform === "linux" ? procStat("self")?.start ?? null : null
  };
}

/**
 * 持ち主の記録 (owner.json / reclaim の中身) を検証する
 * Input : value = JSON を解釈した値 (何が入っているか分からない)
 * Output: 形式が正しければ持ち主の情報、1 つでも不正な項目があれば null
 *         (壊れた記録を「終了の証拠」にしないため、型と形式が合うものだけを通す。開始時点は数字だけの文字列)
 */
function validOwner(value: unknown): LockOwner | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const optional = (v: unknown, ok: (x: unknown) => boolean) => v === undefined || v === null || ok(v);
  const text = (x: unknown) => typeof x === "string" && x.length > 0;
  if (!Number.isSafeInteger(o.pid) || (o.pid as number) <= 0) return null;
  if (!text(o.host) || !text(o.at) || !text(o.token)) return null;
  if (o.platform !== undefined && !text(o.platform)) return null;
  if (!optional(o.space, text)) return null;
  if (!optional(o.start, (x) => typeof x === "string" && /^\d+$/.test(x))) return null;
  return o as unknown as LockOwner;
}

/**
 * 持ち主の記録のファイルを読む
 * Input : path = owner.json または reclaim のパス
 * Output: 持ち主の情報。無い・壊れている・形式が不正なら null
 */
function readRecord(path: string): LockOwner | null {
  try { return validOwner(JSON.parse(readFileSync(path, "utf8"))); } catch { return null; }
}

/**
 * ロックの持ち主の情報を読む
 * Input : lock = ロックのディレクトリのパス
 * Output: 持ち主の情報。読めない (記録が無い・壊れている・形式が不正) なら null
 */
const readOwner = (lock: string): LockOwner | null => readRecord(join(lock, "owner.json"));

/**
 * ロックの世代の印を作る (同じ場所に置かれた別のロックと区別するため)
 * Input : lock = ロックのディレクトリのパス
 * Output: 持ち主の token。持ち主の記録が無い・読めないロックは "none-<ディレクトリの番号>-<作成時刻>"。ロックが無ければ null
 */
function generationOf(lock: string): string | null {
  const owner = readOwner(lock);
  if (owner) return owner.token;
  try { const st = statSync(lock); return `none-${st.ino}-${Math.floor(st.birthtimeMs)}`; } catch { return null; }
}

/**
 * 残っているロックの持ち主が、動いているか・終了したか・確かめられないかを判定する
 * Input : owner = 読めた持ち主の情報 (読めなければ null)
 * Output: { verdict = 判定, reason = 理由の文 }。dead (回収してよい) にするのは、同じプロセス番号の空間 (Linux) で終了を確かめられたときだけ
 */
function judge(owner: LockOwner | null): { verdict: LockVerdict; reason: string } {
  const unknown = (reason: string) => ({ verdict: "unknown" as const, reason });
  if (!owner) return unknown(t("持ち主の記録が無い、または読めません"));
  // 0.4.0 以前の記録には OS の情報が無い。今の OS で書かれたものと推測して回収しない
  if (typeof owner.platform !== "string") return unknown(t("旧版の Boxglow が取ったロックで、持ち主の環境を確かめられません"));
  if (owner.host !== hostname()) return unknown(t("別のマシンの書き手のロックです (こちらからは生死を確かめられません)"));
  // マシン名が同じでも OS が違えば、プロセス番号の空間が別 (Windows と WSL など)。こちらの番号で調べても、持ち主のことは分からない
  if (owner.platform !== process.platform) return unknown(t("マシン名は同じですが OS が違います (Windows と WSL など)。こちらからは持ち主の生死を確かめられません"));
  const alive = isAlive(owner.pid);
  if (process.platform === "linux") {
    // 同じ番号の空間だと確かめられたときだけ、番号でプロセスを調べる (コンテナ・再起動の前後では空間が変わる)
    const mine = pidSpace();
    if (!mine || !owner.space || owner.space !== mine) return unknown(t("プロセス番号の空間が違うか、確かめられません (別のコンテナ・再起動の前後など)"));
    if (!alive) return { verdict: "dead", reason: t("持ち主のプロセスは終了しています") };
    // 番号が再利用されていないか: 開始時点が記録と違えば、元の持ち主はもういない。読めないときは「終了」にしない
    const now = procStat(owner.pid)?.start;
    if (typeof owner.start === "string" && typeof now === "string" && now !== owner.start) return { verdict: "dead", reason: t("持ち主のプロセスは終了しています (同じ番号で別のプロセスが動いています)") };
    return { verdict: "live", reason: t("持ち主のプロセスは動いています") };
  }
  // Windows・macOS: 番号の空間の印が取れないので、マシン名と OS が同じことまでしか確かめられない。
  // 番号のプロセスがこちらにいなくても、同じ名前の別のマシンで動いているかもしれない (時間を置いても、それは見分けられない)。
  // 終了とは判定せず、人の解除 (boxglow unlock) に回す
  if (alive) return { verdict: "live", reason: t("持ち主のプロセスは動いています") };
  return unknown(t("持ち主のプロセスはこのマシンに見つかりませんが、この OS では同じマシンのロックかを確かめられません"));
}

/**
 * ロックの状態を調べる (読むだけ)
 * Input : file = 計画ファイルのパス
 * Output: ロックの状態。ロックが無ければ null
 */
export function inspectLock(file: string): LockStatus | null {
  const target = canonical(file);
  const lock = `${target}.boxglow-lock`;
  const generation = generationOf(lock);
  if (generation === null) return null;
  const owner = readOwner(lock);
  const age = owner ? Date.now() - Date.parse(owner.at) : NaN;
  // いちばん番号の大きい権利のファイルを置いた書き手が、今の回収・解除の担当
  const top = listClaims(lock)?.at(-1);
  const reclaim = !!top;
  const claimer = top ? readClaim(lock, top.name) : null;
  return {
    lock, file: target, owner, ...judge(owner)
  , ageMs: Number.isNaN(age) ? null : age
  , reclaim
  , reclaimer: reclaim ? { owner: claimer, ...judge(claimer) } : null
  , generation
  };
}

/**
 * ロックの状態を、人と AI が読める文にする (FileBusy の文と boxglow unlock の表示に使う)
 * Input : s = ロックの状態
 * Output: 複数行の文字列 (持ち主・判定・回収者・必要なら解除の案内)。読めない値は「不明」と書く
 */
export function describeLock(s: LockStatus): string {
  const unknown = t("不明");
  const o = s.owner;
  const age = s.ageMs === null ? unknown : t("{n} 秒前", { n: Math.max(0, Math.round(s.ageMs / 1000)) });
  const lines = [
    t("対象: {file}", { file: s.file })
  , t("ロックの持ち主: pid {pid} / マシン {host} / OS {platform} / 取得 {at} ({age})", { pid: o?.pid ?? unknown, host: o?.host ?? unknown, platform: o?.platform ?? unknown, at: o?.at ?? unknown, age })
  , t("判定: {reason}", { reason: s.reason })
  ];
  if (s.reclaimer) {
    // 残骸とは決めつけない (今まさに回収・解除している書き手がいるかもしれない)
    const c = s.reclaimer.owner;
    lines.push(t("回収中、または回収の記録が残っています: pid {pid} / マシン {host} / OS {platform} ({reason})", { pid: c?.pid ?? unknown, host: c?.host ?? unknown, platform: c?.platform ?? unknown, reason: s.reclaimer.reason }));
  }
  // 待てば解ける見込みが薄いとき (持ち主が動いていない・確かめられない・長く持ったまま) だけ、解除の手順を案内する
  if (s.verdict !== "live" || s.reclaim || s.ageMs === null || s.ageMs >= LOCK_HINT_MS) {
    lines.push(t("待っても解けないときは boxglow unlock で状態を確かめ、人に解除を頼んでください (AI は自分でロックを消さない)"));
  }
  return lines.join("\n");
}

/** ロックの「照合用の印」: 表示したときと解除するときで、同じロックのままかを確かめる (LockStatus.generation) */
export const lockTokenOf = (s: LockStatus): string => s.generation;

/** 動かす権利の名前: 最初の 1 つは "reclaim"、引き継ぐたびに "reclaim.2"、"reclaim.3" … と番号を上げる */
const CLAIM_NAME = /^reclaim(?:\.(\d+))?$/;

/**
 * ロックの中にある「動かす権利」を、番号の小さい順に並べる
 * Input : lock = ロックのディレクトリのパス
 * Output: [{ name = 名前, n = 番号 ("reclaim" は 1) }]。ロックのディレクトリが無ければ null
 */
function listClaims(lock: string): { name: string; n: number }[] | null {
  let names: string[];
  try { names = readdirSync(lock); } catch { return null; }
  return names.flatMap((name) => { const m = CLAIM_NAME.exec(name); return m ? [{ name, n: m[1] ? Number(m[1]) : 1 }] : []; }).sort((a, b) => a.n - b.n);
}

/**
 * 動かす権利を置いた書き手の記録を読む (権利はディレクトリで、中の owner.json に置いた書き手を書く)
 * Input : lock = ロックのディレクトリのパス, name = 権利の名前
 * Output: 置いた書き手の情報。読めない (ディレクトリでない・壊れている) なら null
 */
const readClaim = (lock: string, name: string): LockOwner | null => readRecord(join(lock, name, "owner.json"));

/**
 * 動かす権利を、すでにあれば失敗する形で置く。
 * 権利は「置いた書き手の記録を入れたディレクトリ」で、作ってから改名で名前を付ける (ロックの取得と同じ方式)。
 * 名前が見えた瞬間から記録が読めるので、「置かれたが、まだ誰のものか分からない」権利は存在しない
 * (記録の無い権利が見える方式だと、作成の途中の権利が、動いている書き手の確定した権利を隠してしまう)
 * Input : lock = ロックのディレクトリのパス, name = 権利の名前, claimToken = 自分の権利の印
 * Output: "ok" = 置けた, "exists" = 同じ名前が先にある, "gone" = ロックのディレクトリが無い (置く直前に動かされた)
 */
function placeClaim(lock: string, name: string, claimToken: string): "ok" | "exists" | "gone" {
  const claim = join(lock, name);
  const temp = join(lock, `.${randomUUID()}.claim`);
  const cleanup = () => { try { rmSync(temp, { recursive: true, force: true }); } catch { /* 残っても、権利としては扱われない (名前が違う) */ } };
  try {
    mkdirSync(temp);
    writeFileSync(join(temp, "owner.json"), JSON.stringify(selfOwner(claimToken)), "utf8");
  } catch (e) {
    cleanup();
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    throw e;
  }
  try {
    // 置き先に同じ名前の権利 (中身のあるディレクトリ) があれば、改名は失敗する
    renameSync(temp, claim);
    return "ok";
  } catch (e) {
    cleanup();
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "gone"; // 作ったディレクトリごと、ロックが動かされた
    if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR" || code === "EPERM" || code === "EACCES" || code === "EBUSY") return "exists";
    throw e;
  }
}

/**
 * ロックのディレクトリを動かす権利を排他的に取る。
 * ロックを動かす操作 (自分の解放・終了した持ち主の回収・人の解除) は、すべてこれを取ってから行う。
 *
 * 権利はロックのディレクトリの中に置く。中に置くので、取れた権利はその世代のロックだけに効く。
 *   - 権利が 1 つも無いとき: "reclaim" を置けた 1 人が権利を持つ
 *   - 権利が残っているとき: 通常の操作 (解放・回収) は取れない。人の解除 (takeOver) だけが引き継げる。
 *     引き継げるのは、残っている権利の**すべて**について、置いた書き手が「動いている」と確かめられないときだけ
 *     (いちばん大きい番号だけを見ると、その下にある、動いている書き手の権利を見落とす)。
 *     引き継ぐときは、次の番号の権利 ("reclaim.<n+1>") を置く。置けるのは 1 人だけ (同じ名前は 2 つ置けない)。
 *     既にある権利は、改名も削除もしない (他の処理が取ったばかりの権利を、古い読み取りを根拠に動かしてしまわないため)
 *   - 置いたあとで、ほかの権利をもう一度すべて確かめる。自分より大きい番号がある、または動いている書き手の権利があれば、自分の権利を消して譲る
 *   - 最後にロックの世代を確かめ直す。違えば、確かめる前に他の書き手が回収して取り直している (そのロックには触らない)
 * 限界: 置いた書き手が動いているかを確かめられない権利 (別の OS・別のマシン・Windows / macOS) を引き継ぐときは、
 *       その書き手が本当に止まっていることを人が確かめている前提 (boxglow unlock の案内のとおり、他の復旧操作も含めて止めてから行う)
 * Input : lock = ロックのディレクトリのパス, expected = 動かしてよい世代の印 (generationOf の値),
 *         takeOver = 残っている権利を引き継ぐか (人の解除のときだけ true)
 * Output: { state: "ok", unclaim } = 取れた (unclaim で権利を返す。ロックを動かしたあとは呼ばなくてよい),
 *         "gone" = ロックがもう無い, "busy" = 他の書き手が権利を持っている、または取り合いになって取れなかった, "changed" = 別の世代のロックに替わっていた
 */
function claimLock(lock: string, expected: string, takeOver = false): { state: "ok"; unclaim: () => void } | { state: "gone" | "busy" | "changed" } {
  const claimToken = randomUUID();
  let mine: { name: string; n: number } | undefined;
  /**
   * 自分の置いた権利だけを消す (記録の印が自分のものか確かめる)。
   * 別の名前へ改名してから消す (その場で中身から消すと、一瞬「空のディレクトリ」になり、他の書き手の権利がその上に置けてしまう)
   */
  const unclaim = () => {
    if (!mine) return;
    const name = mine.name;
    mine = undefined;
    try {
      if (readClaim(lock, name)?.token !== claimToken) return;
      const aside = join(lock, `.${randomUUID()}.unclaimed`);
      renameSync(join(lock, name), aside);
      rmSync(aside, { recursive: true, force: true });
    } catch { /* 消せなくても、他の持ち主のロックには触らない */ }
  };
  /** 自分以外の権利の中に、置いた書き手が動いていると確かめられたものがあるか */
  const anyLive = (claims: { name: string; n: number }[]) => claims.some((c) => c.name !== mine?.name && judge(readClaim(lock, c.name)).verdict === "live");
  // 取り合いで置けなかったときは、状況を読み直して数回だけやり直す
  for (let attempt = 0; attempt < 5; attempt++) {
    const claims = listClaims(lock);
    if (claims === null) return { state: "gone" };
    const top = claims.at(-1);
    if (top && (!takeOver || anyLive(claims))) return { state: "busy" };
    const want = top ? { name: `reclaim.${top.n + 1}`, n: top.n + 1 } : { name: "reclaim", n: 1 };
    const placed = placeClaim(lock, want.name, claimToken);
    if (placed === "gone") { if (existsSync(lock)) continue; return { state: "gone" }; }
    if (placed === "exists") { if (!takeOver) return { state: "busy" }; continue; }
    mine = want;
    // 置いたあとで、ほかの権利をすべて確かめ直す (読んでから置くまでの間に、他の書き手が権利を置いたかもしれない)
    const after = listClaims(lock);
    if (after === null) return { state: "gone" };
    if (after.some((c) => c.n > want.n) || anyLive(after)) { unclaim(); return { state: "busy" }; }
    if (generationOf(lock) !== expected) { unclaim(); return { state: "changed" }; }
    return { state: "ok", unclaim };
  }
  return { state: "busy" };
}

/**
 * 権利 (reclaim) を取ったロックを片付ける: 別の名前へ改名してから消す
 * (その場で中身から消すと、一瞬「空のディレクトリ」になり、他の書き手の改名がその上に成功してしまう。改名なら、ロックの場所には「ある」か「無い」かしかない)
 * Input : lock = ロックのディレクトリのパス, tag = 退避先の名前に入れる語 (released / stale / unlock)
 * Output: なし。改名できなければ例外 (呼び出し側が権利を返す)。退避先を消せなくても例外にしない (名前が違うので、ロックとしては扱われない)
 */
function moveAway(lock: string, tag: string): void {
  const aside = join(dirname(lock), `.${randomUUID()}.${tag}.boxglow-lock`);
  // Windows では、他の書き手が持ち主の記録を読んでいる間、改名が一時的に断られることがあるので、少し待ってやり直す
  renameWithRetry(lock, aside);
  try { rmSync(aside, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); } catch { /* 上のとおり */ }
}

/** テスト専用: 操作の順序を固定した回帰テストから、権利の取得と片付けを直接呼ぶための出口 (製品のコードからは使わない) */
export const _internal = { claimLock: (lock: string, expected: string, takeOver = false) => claimLock(lock, expected, takeOver), moveAway: (lock: string, tag: string) => moveAway(lock, tag) };

/**
 * 残ったロックを人の判断で解除する (boxglow unlock --remove)。持ち主が動いていると確かめられたロックは消さない
 * Input : file = 計画ファイルのパス, expected = 表示したときの照合用の印 (lockTokenOf の値)
 * Output: "removed" = 消した, "none" = ロックが無い, "live" = 持ち主が動いているので消さない,
 *         "changed" = 表示のあとで別のロックに替わっていたので消さない, "busy" = 他の書き手が回収・解除の途中なので消さない
 */
export function removeLock(file: string, expected: string): "removed" | "none" | "live" | "changed" | "busy" {
  const s = inspectLock(file);
  if (!s) return "none";
  if (s.generation !== expected) return "changed";
  if (s.verdict === "live") return "live";
  // 通常の回収・解放と同じ権利を取ってから動かす (取ったあとで世代を確かめ直すので、表示のあとに取り直されたロックは動かさない)
  const claimed = claimLock(s.lock, expected, true);
  if (claimed.state === "gone") return "none";
  if (claimed.state !== "ok") return claimed.state;
  try {
    moveAway(s.lock, "unlock");
    return "removed";
  } catch (e) {
    claimed.unclaim();
    throw e;
  }
}

/**
 * 終了を確かめた持ち主のロックを回収する。回収の権利を排他的に取り、世代を確かめ直してから改名する。
 * Input : lock = ロックのディレクトリのパス, judged = 終了と判定したときに読んだ持ち主の情報
 * Output: 回収できれば true。失敗時は false (呼び出し側の待ち時間上限を適用する)。
 *         回収の途中で異常終了すると権利のファイル (reclaim) が残る。その後は自動では回収しない (boxglow unlock で、置いた書き手を確かめて人が解除する)
 */
function reclaim(lock: string, judged: LockOwner): boolean {
  let claimed: ReturnType<typeof claimLock>;
  try { claimed = claimLock(lock, judged.token); } catch { return false; }
  if (claimed.state !== "ok") return false;
  try {
    moveAway(lock, "stale");
    return true;
  } catch {
    claimed.unclaim();
    return false;
  }
}

/**
 * このプロセスが前に解放し損ねたロックを片付ける (取得の前に呼ぶ)
 * Input : lock = ロックのディレクトリのパス
 * Output: なし。ディスク上の持ち主の印が、解放し損ねたときの印と同じ場合だけ消す (別の持ち主に替わっていたら触らない)。回数の上限まで
 */
function retryFailedRelease(lock: string): void {
  const failed = failedReleases.get(lock);
  if (!failed) return;
  const now = existsSync(lock) ? readOwner(lock) : null;
  if (!now || now.token !== failed.token) { failedReleases.delete(lock); return; } // もう無い、または別の持ち主のロック
  if (failed.tries >= RELEASE_RETRIES) return; // これ以上は自動でやり直さない (FileBusy の案内から人が解除する)
  failed.tries++;
  try {
    releaseOwn(lock, failed.token);
    failedReleases.delete(lock);
  } catch { /* 次の取得のときにもう一度試す */ }
}

/** tryAcquire が「先客がいる」として扱った最後の改名エラー (上限まで置けず、ロックも無いときに伝える) */
let lastAcquireError: unknown;

/**
 * 持ち主の記録を入れたディレクトリを作ってから、改名でロックの場所へ置く
 * (置けた瞬間から持ち主が読める。「記録の無い空のロック」という、古い残骸か取得の途中かを見分けられない状態を作らない)
 * Input : lock = ロックのディレクトリのパス, token = 取得ごとの印
 * Output: 置けたら true。先に他の書き手のロックがあって置けなければ false。
 *         持ち主の記録を書けない・それ以外の理由で置けないときは例外 (書き込みに進ませない)
 */
function tryAcquire(lock: string, token: string): boolean {
  const temp = join(dirname(lock), `.${randomUUID()}.new.boxglow-lock`);
  const cleanup = () => { try { rmSync(temp, { recursive: true, force: true }); } catch { /* 残っても、ロックとしては扱われない (名前が違う) */ } };
  try {
    mkdirSync(temp);
    writeFileSync(join(temp, "owner.json"), JSON.stringify(selfOwner(token)), "utf8");
  } catch (e) {
    cleanup();
    throw e;
  }
  try {
    // 置き先に中身のあるディレクトリ (他の書き手のロック) があれば、改名は失敗する (POSIX は ENOTEMPTY / EEXIST、Windows は EPERM など)
    renameSync(temp, lock);
    return true;
  } catch (e) {
    cleanup();
    // 先客がいて置けなかった。失敗の直後に先客が解放していることもあるので、ロックが今あるかどうかでは判断しない
    // (呼び出し側が待ち時間の上限まで取り直す。上限まで置けなければ、最後のエラーを伝える)
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM" || code === "EACCES" || code === "EBUSY") { lastAcquireError = e; return false; }
    throw e;
  }
}

/** 解放のとき、他の書き手が回収・解除の確認をしている間 (reclaim がある間) 待つ時間の上限 (ms) */
const RELEASE_WAIT_MS = 500;

/**
 * 自分のロックを外す: 動かす権利 (reclaim) を取り、自分の世代のままかを確かめてから、改名して消す
 * Input : lock = ロックのディレクトリのパス, token = 自分が取得したときの印
 * Output: なし。もう無い・別の持ち主のロックに替わっていた (人が解除したあとで、他の書き手が取り直した) ときは何もしない。
 *         他の書き手が回収・解除の途中で権利を取れない、改名できないときは例外 (呼び出し側が控えて、次の取得のときにやり直す)
 */
function releaseOwn(lock: string, token: string): void {
  const deadline = Date.now() + RELEASE_WAIT_MS;
  for (;;) {
    const claimed = claimLock(lock, token);
    if (claimed.state === "gone" || claimed.state === "changed") return;
    if (claimed.state === "ok") {
      try { moveAway(lock, "released"); return; } catch (e) { claimed.unclaim(); throw e; }
    }
    // busy: 他の書き手が確かめている最中 (世代が違うと分かれば、すぐ権利を返してくる)
    if (Date.now() >= deadline) throw new Error("lock release is blocked by a recovery marker");
    sleepSync(LOCK_RETRY_MS);
  }
}

/**
 * ファイルの書き込みロックを取る (持ち主の記録を入れたディレクトリを改名で置く。先に置けた 1 つだけが進める)
 * Input : file = ロックしたいファイルのパス,
 *         opts = { waitMs = 空くのを待つ時間の上限 (既定 LOCK_WAIT_MS) }
 * Output: ロックを外す関数 (失敗しても例外を投げない。2 回呼んでも何もしない)。
 *         他がロック中なら短い間隔で取り直し、waitMs 待ってもだめなら FileBusy (持ち主と判定の説明つき) を投げる。
 *         このプロセス自身が持っているロックは、待っても空かない (同期で待つ間は解放の処理が動かない) ので、すぐ FileBusy を投げる
 */
export function lockFile(file: string, opts: { waitMs?: number } = {}): () => void {
  const target = canonical(file);
  const lock = `${target}.boxglow-lock`;
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS;
  const deadline = Date.now() + waitMs;
  const token = randomUUID();
  for (;;) {
    if (heldLocks.has(lock)) throw new FileBusy();
    // 前に自分が解放し損ねたロックが残っていれば、先に片付ける
    retryFailedRelease(lock);
    // 空のディレクトリ (旧版の残骸か、旧版が取得している途中か分からない) の上には置かない。あれば下で「確かめられない」ロックとして待つ
    if (!existsSync(lock) && tryAcquire(lock, token)) break;
    // 持ち主の終了を確かめられたロックだけ回収して、すぐ取り直す
    const owner = readOwner(lock);
    if (owner && judge(owner).verdict === "dead" && reclaim(lock, owner)) continue;
    if (Date.now() >= deadline) {
      const status = inspectLock(target);
      if (status) throw new FileBusy(status);
      // ちょうど解放されたところなら、もう一度だけ取りにいく。ロックが無いのに置けないなら、置けない理由 (権限など) をそのまま伝える
      lastAcquireError = undefined;
      if (tryAcquire(lock, token)) break;
      if (!existsSync(lock) && lastAcquireError) throw lastAcquireError;
      throw new FileBusy(inspectLock(target) ?? undefined);
    }
    sleepSync(LOCK_RETRY_MS);
  }
  heldLocks.add(lock);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    heldLocks.delete(lock);
    // 解放の失敗で、成功した書き込みを失敗に見せない (例外にしない)。
    // 消せなかったロックは「自分が取って使い終わったもの」として控えておき、次の取得のときに片付け直す
    try {
      releaseOwn(lock, token);
    } catch {
      failedReleases.set(lock, { token, tries: 0 });
    }
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
export function commitFile(file: string, text: string, expected: string | null, opts: { waitMs?: number } = {}): string {
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

/**
 * 保存ロックの回帰テスト: 「持ち主の終了を確かめられたときだけ回収する」が崩れていないこと
 * - 生きている持ち主・別のマシン・別の OS (Windows と WSL)・別のプロセス番号の空間・旧版の記録からは、時間が経っても奪わない
 * - 番号が再利用された (同じ番号で別のプロセスが動いている) ロックは回収できる
 * - 回収に失敗しても待ち時間の上限を守る、解放の二重呼び出しが後のロックを壊さない、持ち主を記録できなければ書かない
 * - 待たされたときの文に持ち主と判定が入り、人の解除 (removeLock) は動いている持ち主・替わったロックを消さない
 * - ロックを動かす操作 (解放・回収・人の解除) が重なる順序を固定して、新しい持ち主のロックを動かさない・消さないこと
 * node:fs の一部を差し替えて、改名や持ち主の記録の失敗と、操作の途中への割り込みを再現する
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { _internal, commitFile, describeLock, FileBusy, inspectLock, lockFile, lockTokenOf, pidSpace, removeLock, revisionOf } from "./file-store";

/**
 * 失敗と割り込みの注入:
 *   renameFailures = ロックのディレクトリの改名を失敗させる残り回数, ownerWrite = 持ち主の記録の書き込みを失敗させるか,
 *   beforeClaim = 動かす権利 (reclaim / reclaim.<n>) を置く直前に 1 回だけ実行する処理, beforeMove = ロックのディレクトリを改名する直前に 1 回だけ実行する処理
 */
const fault = vi.hoisted(() => ({ renameFailures: 0, ownerWrite: false, beforeClaim: null as null | (() => void), beforeMove: null as null | (() => void) }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      // 回収のときの改名 (<計画>.boxglow-lock → 退避先) だけを失敗させる
      if (String(args[0]).endsWith("plan.json.boxglow-lock")) {
        // 割り込みは 1 回だけ (割り込みの中の操作にはかからないように、先に外す)
        const hook = fault.beforeMove; fault.beforeMove = null; hook?.();
        if (fault.renameFailures-- > 0) throw Object.assign(new Error("recovery denied"), { code: "EACCES" });
      }
      // 動かす権利 (reclaim / reclaim.<n>) を改名で置く直前
      if (/[\\/]reclaim(\.\d+)?$/.test(String(args[1]))) { const hook = fault.beforeClaim; fault.beforeClaim = null; hook?.(); }
      return fs.renameSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (fault.ownerWrite && /\.new\.boxglow-lock[\\/]owner\.json$/.test(String(args[0])))
        throw Object.assign(new Error("owner write denied"), { code: "EACCES" });
      return fs.writeFileSync(...args);
    }
  };
});

const dirs: string[] = [];
/** 中身が "base" の計画ファイルを一時フォルダに作り、そのパスを返す */
const file = () => { const dir = mkdtempSync(join(tmpdir(), "boxglow-lock-review-")); dirs.push(dir); const p = join(dir, "plan.json"); writeFileSync(p, "base"); return p; };
/** /proc から、プロセスの開始時点を読む (Linux 以外・読めないときは null) */
const startOf = (pid: number): string | null => {
  try { const s = readFileSync(`/proc/${pid}/stat`, "utf8"); return s.slice(s.lastIndexOf(")") + 1).trim().split(/\s+/)[19] ?? null; } catch { return null; }
};
/**
 * 他のプロセスが取ったロックを直接作る
 * Input : p = 計画ファイルのパス, fields = 持ち主の記録の上書き (undefined を渡した項目は記録から外す)
 * 既定は「このテストと同じマシン・OS・番号の空間で、10 分前に、生きているプロセス (テストの親) が取ったロック」
 */
const owner = (p: string, fields: Record<string, unknown>) => {
  mkdirSync(p + ".boxglow-lock");
  writeFileSync(join(p + ".boxglow-lock", "owner.json"), JSON.stringify({ pid: process.ppid, host: hostname(), at: new Date(Date.now() - 600_000).toISOString(), token: "holder", platform: process.platform, space: pidSpace(), start: startOf(process.ppid), ...fields }));
};
/**
 * 動かす権利 (記録入りのディレクトリ) を、ロックの中に直接置く (他の書き手が置いた権利の再現)
 * Input : p = 計画ファイルのパス, name = 権利の名前 (reclaim / reclaim.<n>), fields = 置いた書き手の記録の上書き
 * 既定は「同じマシン・OS・番号の空間の、生きているプロセス (テストの親) が置いた権利」
 */
const plantClaim = (p: string, name: string, fields: Record<string, unknown> = {}) => {
  const dir = join(p + ".boxglow-lock", name); mkdirSync(dir);
  writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: process.ppid, host: hostname(), at: new Date().toISOString(), token: "claimer-" + name, platform: process.platform, space: pidSpace(), start: startOf(process.ppid), ...fields }));
};
/** すでに終了したプロセスの番号 */
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;
/** ロックの持ち主の印を読む (奪われていないことの確認用) */
const tokenOf = (p: string) => JSON.parse(readFileSync(join(p + ".boxglow-lock", "owner.json"), "utf8")).token;
afterEach(() => { fault.renameFailures = 0; fault.ownerWrite = false; fault.beforeClaim = null; fault.beforeMove = null; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("確かめられない持ち主からは奪わない", () => {
  it.each([
    ["5 分以上持ったままの、生きている書き手", {}],
    ["取得時刻が壊れている、生きている書き手", { at: "invalid" }],
    ["別のマシンの書き手 (番号のプロセスがこちらにいなくても)", { host: "another-host", pid: 2 ** 22 + 12345 }],
    // マシン名が同じでも、Windows と WSL はプロセス番号の空間が別。こちらで番号が見つからなくても、持ち主は生きているかもしれない
    ["マシン名は同じで OS が違う書き手 (Windows と WSL)", { platform: process.platform === "win32" ? "linux" : "win32", space: null, start: null, pid: 2 ** 22 + 12345 }],
    ["OS の記録が無い旧版 (0.4.0) の書き手", { platform: undefined, space: undefined, start: undefined, pid: 2 ** 22 + 12345 }],
  ])("%s", (_name, fields) => {
    const p = file(); owner(p, fields);
    expect(() => commitFile(p, "loser", revisionOf("base"), { waitMs: 0 })).toThrow(FileBusy);
    expect(readFileSync(p, "utf8")).toBe("base");
    expect(tokenOf(p)).toBe("holder");
  });

  // 番号の空間の印は Linux でだけ取れる
  it.runIf(process.platform === "linux")("マシン名・OS が同じでも、プロセス番号の空間 (起動ごとの ID / PID 名前空間) が違えば奪わない", () => {
    const p = file(); owner(p, { space: "other-boot/pid:[1]", pid: 2 ** 22 + 12345 });
    expect(() => commitFile(p, "loser", revisionOf("base"), { waitMs: 0 })).toThrow(FileBusy);
    expect(tokenOf(p)).toBe("holder");
  });
  it.runIf(process.platform === "linux")("番号の空間の記録が無い (読めなかった) 持ち主からは、番号のプロセスがいなくても奪わない", () => {
    const p = file(); owner(p, { space: null, pid: deadPid() });
    expect(() => commitFile(p, "loser", revisionOf("base"), { waitMs: 0 })).toThrow(FileBusy);
    expect(tokenOf(p)).toBe("holder");
  });
});

describe("壊れた記録・確かめられない OS は、終了の証拠にしない", () => {
  // 開始時点は「数字だけの文字列」同士のときだけ比べる。型や形式が違う記録を「番号の再利用」と読み違えて、生きている持ち主から奪わない
  it.each([
    ["開始時点が数値", { start: 12345 }],
    ["開始時点がオブジェクト", { start: { value: "1" } }],
    ["開始時点が空文字", { start: "" }],
    ["開始時点が数字でない文字列", { start: "yesterday" }],
    ["番号の空間が数値", { space: 1 }],
    ["OS が数値", { platform: 1 }],
    ["印 (token) が空", { token: "" }],
  ])("%s の記録は不正として扱い、生きている持ち主から奪わない", (_name, fields) => {
    const p = file(); owner(p, fields);
    expect(inspectLock(p)?.verdict).toBe("unknown");
    expect(inspectLock(p)?.owner).toBeNull();
    expect(() => commitFile(p, "loser", revisionOf("base"), { waitMs: 0 })).toThrow(FileBusy);
    expect(readFileSync(p, "utf8")).toBe("base");
    expect(existsSync(join(p + ".boxglow-lock", "owner.json"))).toBe(true);
  });

  // Windows・macOS では番号の空間の印が取れない。番号のプロセスがこちらにいなくても、同じ名前の別のマシンで動いているかもしれない
  it.each(["win32", "darwin"])("%s: マシン名と OS が同じで番号のプロセスがいなくても、時間が経っても終了とは判定しない", (platform) => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...original, value: platform });
    try {
      const p = file(); owner(p, { platform, space: null, start: null, pid: deadPid(), at: new Date(Date.now() - 3_600_000).toISOString() });
      expect(inspectLock(p)?.verdict).toBe("unknown");
      expect(() => lockFile(p, { waitMs: 0 })).toThrow(FileBusy);
      expect(tokenOf(p)).toBe("holder");
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });
});

describe("終了を確かめられた持ち主のロックは回収する", () => {
  it.runIf(process.platform === "linux")("同じ空間で、番号のプロセスがいない", () => {
    const p = file(); owner(p, { pid: deadPid(), start: "1" });
    commitFile(p, "after crash", revisionOf("base"));
    expect(readFileSync(p, "utf8")).toBe("after crash");
    expect(existsSync(p + ".boxglow-lock")).toBe(false);
  });
  it.runIf(process.platform === "linux")("同じ空間・同じ番号でも、開始時点が違えば別のプロセス (番号の再利用) なので回収する。同じなら奪わない", () => {
    const p = file();
    // 開始時点が記録と同じ = 元の持ち主が動いている
    owner(p, {});
    expect(() => commitFile(p, "loser", revisionOf("base"), { waitMs: 0 })).toThrow(FileBusy);
    rmSync(p + ".boxglow-lock", { recursive: true });
    // 開始時点が違う = 元の持ち主は終了し、同じ番号を別のプロセスが使っている
    owner(p, { start: "1" });
    commitFile(p, "after reuse", revisionOf("base"));
    expect(readFileSync(p, "utf8")).toBe("after reuse");
  });
  it.runIf(process.platform === "linux")("開始時点の記録が無い持ち主は、番号が生きている間は奪わない (再利用かどうかを確かめられない)", () => {
    const p = file(); owner(p, { start: null });
    expect(() => commitFile(p, "loser", revisionOf("base"), { waitMs: 0 })).toThrow(FileBusy);
    expect(tokenOf(p)).toBe("holder");
  });
});

describe("回収・解放・取得の失敗", () => {
  it("回収に失敗しても、成功するまで回り続けず、待ち時間の上限で FileBusy にする", () => {
    const p = file(); owner(p, { pid: deadPid(), start: "1" }); fault.renameFailures = 1000;
    expect(() => commitFile(p, "loser", revisionOf("base"), { waitMs: 0 })).toThrow(FileBusy);
    expect(readFileSync(p, "utf8")).toBe("base");
  });
  it("回収の途中で止まった印 (reclaim) が残っているロックは、自動では回収しない (人が解除する)", () => {
    const p = file(); owner(p, { pid: deadPid(), start: "1" });
    writeFileSync(join(p + ".boxglow-lock", "reclaim"), "{}");
    expect(() => commitFile(p, "loser", revisionOf("base"), { waitMs: 0 })).toThrow(FileBusy);
    expect(inspectLock(p)?.reclaim).toBe(true);
    expect(removeLock(p, "holder")).toBe("removed");
    commitFile(p, "after unlock", revisionOf("base"));
    expect(readFileSync(p, "utf8")).toBe("after unlock");
  });
  it("解放を 2 回呼んでも、同じプロセスが後から取ったロックの管理を壊さない", () => {
    const p = file(); const first = lockFile(p); first(); const second = lockFile(p);
    first();
    try { expect(() => lockFile(p, { waitMs: 0 })).toThrow(FileBusy); }
    finally { second(); }
    expect(existsSync(p + ".boxglow-lock")).toBe(false);
  });
  it("持ち主を記録できなければ、ロックを置かず、書き込みにも進まない", () => {
    const p = file(); fault.ownerWrite = true;
    expect(() => commitFile(p, "unsafe", revisionOf("base"))).toThrow("owner write denied");
    expect(readFileSync(p, "utf8")).toBe("base");
    expect(existsSync(p + ".boxglow-lock")).toBe(false);
  });
  it("取得したロックには、置いた瞬間から持ち主 (OS・番号の空間を含む) が書かれている。取得用の一時フォルダは残さない", () => {
    const p = file(); const unlock = lockFile(p);
    const o = JSON.parse(readFileSync(join(p + ".boxglow-lock", "owner.json"), "utf8"));
    expect(o.pid).toBe(process.pid); expect(o.platform).toBe(process.platform); expect(o.space).toBe(pidSpace());
    if (process.platform === "linux") expect(o.start).toBe(startOf(process.pid));
    unlock();
    expect(existsSync(p + ".boxglow-lock")).toBe(false);
    // 2 人目が取れなかったときも、一時フォルダを残さない
    owner(p, {});
    expect(() => lockFile(p, { waitMs: 0 })).toThrow(FileBusy);
    // 外部コマンドに頼らずに確かめる (Windows でも動くように)
    expect(readdirSync(join(p, "..")).filter((n) => n.includes(".new.boxglow-lock"))).toEqual([]);
  });
});

describe("待たされたときの説明と、人による解除", () => {
  it("FileBusy の文に、対象・持ち主・判定・解除の案内が入る", () => {
    const p = file(); owner(p, { host: "another-host" });
    let message = "";
    try { commitFile(p, "loser", revisionOf("base"), { waitMs: 0 }); } catch (e) { message = (e as Error).message; }
    expect(message).toContain("plan.json");
    expect(message).toContain("another-host");
    expect(message).toContain("別のマシン");
    expect(message).toContain("boxglow unlock");
  });
  it("取得時刻が読めないロックは、経過時間を計算せず「不明」と書く", () => {
    const p = file(); owner(p, { at: "invalid" });
    const s = inspectLock(p)!;
    expect(s.ageMs).toBeNull();
    expect(describeLock(s)).toContain("不明");
  });
  it("動いている持ち主のロックは解除しない。確かめられないロックは、表示した印が合うときだけ解除する", () => {
    const p = file();
    // 動いている持ち主
    owner(p, {});
    if (process.platform === "linux") {
      expect(inspectLock(p)?.verdict).toBe("live");
      expect(removeLock(p, "holder")).toBe("live");
      expect(tokenOf(p)).toBe("holder");
    }
    rmSync(p + ".boxglow-lock", { recursive: true });
    // 別のマシンの持ち主 (確かめられない): 印が違えば消さない、合えば消す
    owner(p, { host: "another-host" });
    const s = inspectLock(p)!;
    expect(s.verdict).toBe("unknown");
    expect(removeLock(p, "stale-token")).toBe("changed");
    expect(tokenOf(p)).toBe("holder");
    expect(removeLock(p, lockTokenOf(s))).toBe("removed");
    expect(existsSync(p + ".boxglow-lock")).toBe(false);
    expect(removeLock(p, "holder")).toBe("none");
  });
});

describe("ロックを動かす操作が重なっても、新しい持ち主のロックを動かさない", () => {
  // 人の解除が「確かめる」と「動かす」の間で、通常の書き手が回収して取り直した場合。
  // 人の解除は、動かす権利を取ったあとで世代の違いに気づき、新しい持ち主のロックに触らずに「替わった」と返す
  it.runIf(process.platform === "linux")("人の解除: 確かめたあとで他の書き手が回収して取り直していたら、そのロックを動かさず changed を返す", () => {
    const p = file(); owner(p, { pid: deadPid(), start: "1" });
    let releaseB: (() => void) | undefined;
    fault.beforeClaim = () => { releaseB = lockFile(p); }; // B が、終了した A のロックを回収して自分のロックを取る
    expect(removeLock(p, "holder")).toBe("changed");
    // B のロックは元の場所にそのまま残り、解除の印 (reclaim) も残っていない
    const now = JSON.parse(readFileSync(join(p + ".boxglow-lock", "owner.json"), "utf8"));
    expect(now.pid).toBe(process.pid); expect(now.token).not.toBe("holder");
    expect(existsSync(join(p + ".boxglow-lock", "reclaim"))).toBe(false);
    // B が持っている間、他の書き手は取れない (2 つの書き手が同時に進まない)
    expect(inspectLock(p)?.verdict).toBe("live");
    releaseB!();
    expect(existsSync(p + ".boxglow-lock")).toBe(false);
  });
  // 人の解除が動かす権利を取ったあとは、通常の書き手は同じロックを回収できない (権利が取れないので待つ)。解除が終わってから取れる
  it.runIf(process.platform === "linux")("人の解除が権利を取っている間、通常の書き手は回収に進めない。解除のあとで取れる", () => {
    const p = file(); owner(p, { pid: deadPid(), start: "1" });
    let blocked = false;
    fault.beforeMove = () => { try { lockFile(p, { waitMs: 0 })(); } catch (e) { blocked = e instanceof FileBusy; } };
    expect(removeLock(p, "holder")).toBe("removed");
    expect(blocked).toBe(true);
    commitFile(p, "after unlock", revisionOf("base"));
    expect(readFileSync(p, "utf8")).toBe("after unlock");
  });
  it("回収・解除の途中の書き手が動いていると確かめられたら、人の解除は引き継がず busy を返す。置いた書き手が分かる", () => {
    const p = file(); owner(p, { host: "another-host" });
    // 動いている書き手 (テストの親) が置いた権利
    plantClaim(p, "reclaim");
    const s = inspectLock(p)!;
    expect(s.reclaimer?.owner?.pid).toBe(process.ppid);
    expect(describeLock(s)).toContain(`pid ${process.ppid}`);
    if (process.platform === "linux") {
      expect(s.reclaimer?.verdict).toBe("live");
      expect(removeLock(p, lockTokenOf(s))).toBe("busy");
      expect(tokenOf(p)).toBe("holder");
    }
  });
  it("持ち主の記録が無いロックの印は世代ごとに違う (別の壊れたロックに替わっていたら解除しない)", () => {
    const p = file(); mkdirSync(p + ".boxglow-lock");
    const first = lockTokenOf(inspectLock(p)!);
    rmSync(p + ".boxglow-lock", { recursive: true });
    // 作成時刻が変わるように少し置いてから、別の空のロックを置く
    const until = Date.now() + 20; while (Date.now() < until) { /* 待つ */ }
    mkdirSync(p + ".boxglow-lock"); writeFileSync(join(p + ".boxglow-lock", "note"), "another generation");
    const second = lockTokenOf(inspectLock(p)!);
    expect(second).not.toBe(first);
    expect(removeLock(p, first)).toBe("changed");
    expect(existsSync(p + ".boxglow-lock")).toBe(true);
    expect(removeLock(p, second)).toBe("removed");
  });
  it("解放: 人が解除したあとで他の書き手が取り直したロックには触らない", () => {
    const p = file(); const releaseA = lockFile(p);
    // 人の解除と、別の書き手 C の取得を再現する
    rmSync(p + ".boxglow-lock", { recursive: true }); owner(p, { host: "another-host" });
    releaseA();
    expect(tokenOf(p)).toBe("holder");
    expect(existsSync(join(p + ".boxglow-lock", "reclaim"))).toBe(false);
  });
  it("解放: 他の書き手が回収・解除の確認中で動かせなかったロックは、同じプロセスの次の取得のときに片付け直す", () => {
    const p = file(); const release = lockFile(p);
    const claim = join(p + ".boxglow-lock", "reclaim");
    writeFileSync(claim, "{}"); // 他の書き手が確認中
    release();
    expect(existsSync(p + ".boxglow-lock")).toBe(true); // 動かせなかった (例外にはしない)
    rmSync(claim); // 確認が終わった
    const again = lockFile(p, { waitMs: 0 }); // 自分が解放し損ねたロックを片付けてから取り直す
    again();
    expect(existsSync(p + ".boxglow-lock")).toBe(false);
  });

  /** 終了した書き手が置いたままの権利 (回収の途中で異常終了した記録) を置く */
  const deadClaim = (p: string) => plantClaim(p, "reclaim", { pid: deadPid(), start: "1" });

  // 2 つの解除が同じ「残った権利」を引き継ごうとする順序:
  //   U1 が古い権利を読む (動いていない) → U2 が引き継いで権利を得る (動かす直前で止まっている) → U1 が続行する
  // U1 は、U2 が取ったばかりの権利を動かしたり消したりできず、権利を得られない (両方が動かす権利を持たない)
  it.runIf(process.platform === "linux")("残った権利の引き継ぎが重なっても、権利を得るのは 1 人だけ (後から続行した側は busy)", () => {
    const p = file(); owner(p, { pid: deadPid(), start: "1" }); deadClaim(p);
    const lock = p + ".boxglow-lock";
    let second: ReturnType<typeof _internal.claimLock> | undefined;
    fault.beforeClaim = () => { second = _internal.claimLock(lock, "holder", true); }; // U2 が先に引き継ぐ
    expect(removeLock(p, "holder")).toBe("busy"); // U1
    expect(second?.state).toBe("ok");
    // U2 の権利のファイルはそのまま残っている (U1 に動かされていない)。ロックも元の場所にある
    expect(readdirSync(lock).filter((n) => n.startsWith("reclaim")).sort()).toEqual(["reclaim", "reclaim.2"]);
    expect(tokenOf(p)).toBe("holder");
    // U2 が解除を終える → 通常の書き手 B が取る → B が持っている間、ほかの書き手は取れない
    _internal.moveAway(lock, "unlock");
    const releaseB = lockFile(p);
    expect(removeLock(p, "holder")).toBe("changed"); // 古い印での解除は、B のロックを動かさない
    expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).pid).toBe(process.pid);
    releaseB();
    expect(existsSync(lock)).toBe(false);
  });
  // 片方の解除が完了し、通常の書き手が新しいロックを取ったあとで、もう片方が続行しても、そのロックを動かさない
  it.runIf(process.platform === "linux")("片方の解除のあとで通常の書き手が取ったロックを、遅れて続行した解除は動かさない", () => {
    const p = file(); owner(p, { pid: deadPid(), start: "1" }); deadClaim(p);
    const lock = p + ".boxglow-lock";
    let releaseB: (() => void) | undefined;
    fault.beforeClaim = () => {
      expect(removeLock(p, "holder")).toBe("removed"); // U2 が解除を終える
      releaseB = lockFile(p);                          // 通常の書き手 B が取る
    };
    expect(removeLock(p, "holder")).toBe("changed");   // U1 が続行する
    const now = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
    expect(now.pid).toBe(process.pid); expect(now.token).not.toBe("holder");
    expect(readdirSync(lock).filter((n) => n.startsWith("reclaim"))).toEqual([]);
    releaseB!();
    expect(existsSync(lock)).toBe(false);
  });
  // 権利は、置いた書き手の記録ごと一度に置く。「置かれたが、まだ誰のものか分からない」権利が見える瞬間は無い
  it("権利は、見えた瞬間から置いた書き手の記録が読める (空の権利を公開しない)。取れなかったときに作りかけを残さない", () => {
    const p = file(); owner(p, { host: "another-host" });
    const lock = p + ".boxglow-lock";
    let seen: unknown;
    // 置いた直後 (世代を確かめる前) に相当する時点で、もう 1 人が見る: 改名で置く直前には、まだ権利は見えない
    fault.beforeClaim = () => { seen = readdirSync(lock).filter((n) => n.startsWith("reclaim")); };
    const claimed = _internal.claimLock(lock, "holder");
    expect(seen).toEqual([]);
    expect(claimed.state).toBe("ok");
    expect(JSON.parse(readFileSync(join(lock, "reclaim", "owner.json"), "utf8")).pid).toBe(process.pid);
    // 2 人目は取れず、作りかけのディレクトリも残さない
    expect(_internal.claimLock(lock, "holder").state).toBe("busy");
    expect(readdirSync(lock).sort()).toEqual(["owner.json", "reclaim"]);
    if (claimed.state === "ok") claimed.unclaim();
    expect(readdirSync(lock)).toEqual(["owner.json"]);
  });
  // いちばん大きい番号の権利が「動いていない / 読めない」でも、その下に、動いている書き手の確定した権利があれば引き継がない。
  // (番号が最大の権利だけを見ると、作成の途中や壊れた権利が、動いている書き手の権利を隠してしまう)
  it.runIf(process.platform === "linux").each([
    ["終了した書き手の権利", (p: string) => plantClaim(p, "reclaim.2", { pid: deadPid(), start: "1" })],
    ["記録の無い空のディレクトリ", (p: string) => mkdirSync(join(p + ".boxglow-lock", "reclaim.2"))],
    ["旧方式の空のファイル", (p: string) => writeFileSync(join(p + ".boxglow-lock", "reclaim.2"), "")],
  ])("上位が %s でも、下位に動いている書き手の権利があれば、人の解除は引き継がない", (_name, plantTop) => {
    const p = file(); owner(p, { pid: deadPid(), start: "1" });
    const lock = p + ".boxglow-lock";
    plantClaim(p, "reclaim"); // 動いている書き手 U1 が、すでに権利を得ている
    plantTop(p);
    expect(_internal.claimLock(lock, "holder", true).state).toBe("busy");
    expect(removeLock(p, "holder")).toBe("busy");
    // U1 の権利も、ロックも、そのまま
    expect(JSON.parse(readFileSync(join(lock, "reclaim", "owner.json"), "utf8")).token).toBe("claimer-reclaim");
    expect(tokenOf(p)).toBe("holder");
    expect(readdirSync(lock).filter((n) => /^reclaim\.[3-9]/.test(n))).toEqual([]);
  });
  // 3 つの処理が重なる順序: U1 が権利を得る → U2 が番号を上げて置こうとしている途中 → U3 が来る。
  // U1 が動いている限り、U2 も U3 も権利を得ない。U1 が解除を終えて B が取ったロックを、U2・U3 は動かさない
  it.runIf(process.platform === "linux")("3 つの解除が重なっても、権利を得るのは 1 人だけで、あとから取られたロックは動かされない", () => {
    const p = file(); owner(p, { pid: deadPid(), start: "1" });
    const lock = p + ".boxglow-lock";
    const results: string[] = [];
    let first: ReturnType<typeof _internal.claimLock> | undefined;
    // U1 が "reclaim" を置く直前に、U2 が先に置いて権利を得る。その U2 が置く直前に… と入れ子にはできないので、
    // U1 が置く直前に U2 を走らせ (U2 が権利を得る)、続けて U3 を走らせる (U2 が動いているので取れない)
    fault.beforeClaim = () => {
      first = _internal.claimLock(lock, "holder", true); results.push("U2:" + first.state);
      results.push("U3:" + _internal.claimLock(lock, "holder", true).state);
    };
    results.push("U1:" + _internal.claimLock(lock, "holder", true).state);
    expect(results.sort()).toEqual(["U1:busy", "U2:ok", "U3:busy"]);
    expect(readdirSync(lock).filter((n) => n.startsWith("reclaim"))).toEqual(["reclaim"]);
    // 権利を得た 1 人が解除を終える → B が取る → 残りの 2 人が続行しても、B のロックは動かない
    _internal.moveAway(lock, "unlock");
    const releaseB = lockFile(p);
    expect(_internal.claimLock(lock, "holder", true).state).toBe("changed");
    expect(removeLock(p, "holder")).toBe("changed");
    expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).pid).toBe(process.pid);
    expect(readdirSync(lock)).toEqual(["owner.json"]);
    releaseB();
    expect(existsSync(lock)).toBe(false);
  });
});

/**
 * 同期の判断 (engine.ts) の試験。
 * 偽のサーバー (版つきの置き場。同じ操作の送り直しには前の結果を返す) と、2 台の端末 (手元の中身・状態・中身の写し) を用意し、
 * 判断 → 実行 → 状態を進める、を 1 手ずつ動かす。実行の途中で「落ちた」ことにして、再開したときの動きを確かめる。
 * 設計書 (docs/private/SYNC_DESIGN.md) の 3 章の表と、Codex のレビュー 7〜9 の反例を試験にしている
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { addBlock, createProject, defaultTaskParent, fromJSON, moveBlockToParent, toJSON, updateBlock } from "../model/graph";
import type { Project } from "../model/types";
import {
  baseSet, decide, PENDING_MAX_AGE_MS, protectedDeletions, pullRecovered, pullWritten, pullNotWritten, pushAccepted, pushRejected, recordPending, recoveryToken, SyncStateError
, describeChanges, previewRecovery, remoteMark
, type Content, type Decision, type Pending, type PendingPull, type PendingPush, type Remote, type SyncInput, type SyncState
} from "./engine";
import { setActivity, moveBlock } from "../model/graph";

const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex");
const content = (text: string): Content => ({ hash: hashOf(text), text });
const textOf = (p: Project): string => toJSON(p) + "\n";
const NOW = new Date("2026-10-04T12:00:00.000Z");

/** ボックス A・B を持つ計画 (id も返す) */
function plan() {
  let p = createProject("同期の試験");
  const pj = defaultTaskParent(p);
  const a = addBlock(p, { parentId: pj, title: "A" }); p = a.project;
  const b = addBlock(p, { parentId: pj, title: "B" }); p = b.project;
  return { p: fromJSON(toJSON(p)), a: a.blockId, b: b.blockId };
}

/**
 * 偽のサーバー: 計画 1 つ分の「版つきの置き場」
 * 置き換えは「同じ操作の結果があればそれを返す → 無ければ前提の版を確かめる → 合えば確定」を 1 つの処理で行う (設計書 7 章の Store の約束)
 */
class FakeServer {
  epoch = "e1";
  seq = 0;
  head: { revision: string; content: Content } | null = null;
  deleted = false;
  ops = new Map<string, { hash: string; expected: string | null; revision: string }>();
  remote(): Remote {
    if (this.deleted) return { kind: "deleted", epoch: this.epoch };
    return this.head ? { kind: "present", epoch: this.epoch, revision: this.head.revision, content: this.head.content } : { kind: "absent", epoch: this.epoch };
  }
  /**
   * Input : opId = 操作 ID, c = 中身, expected = 前提の版 (作成は null), epoch = クライアントが操作を記録したときの履歴の世代
   * Output: { accepted: 版 } / { rejected: true } (前提の版が違う) / { history: 今の世代 } (履歴の世代が違う。最初に確かめる)
   */
  put(opId: string, c: Content, expected: string | null, epoch: string = this.epoch): { accepted: string } | { rejected: true } | { history: string } {
    if (epoch !== this.epoch) return { history: this.epoch };
    if (this.deleted) return { rejected: true };
    const done = this.ops.get(opId);
    if (done) {
      if (done.hash !== c.hash || done.expected !== expected) throw new Error("same op id, different request");
      return { accepted: done.revision };
    }
    if ((this.head?.revision ?? null) !== expected) return { rejected: true };
    const revision = `${this.epoch}.${++this.seq}`;
    this.head = { revision, content: c };
    this.ops.set(opId, { hash: c.hash, expected, revision });
    return { accepted: revision };
  }
}

/** 端末 1 台: 手元の中身、同期の状態、中身の写し (objects) */
class Device {
  local: Content | null = null;
  state: SyncState = { generation: 0, epoch: null, base: null, pending: null };
  objects = new Map<string, string>();
  ops = 0;
  constructor(readonly name: string, readonly server: FakeServer) {}
  decide(extra: Partial<SyncInput> = {}): Decision {
    return decide({
      state: this.state, local: this.local, remote: this.server.remote(), bindingId: this.name
    , baseText: this.state.base ? this.objects.get(this.state.base.hash) ?? null : null
    , now: NOW, hashOf, ...extra
    });
  }
  keep(c: Content) { this.objects.set(c.hash, c.text); }
  /**
   * 判断を 1 つ実行する
   * Input : crash = どこで落ちるか ("after-record" = 操作を記録した直後, "after-effect" = 送信 / 手元への書き込みの直後・状態を進める前)
   * Output: 実行した判断
   */
  step(crash?: "after-record" | "after-effect", extra: Partial<SyncInput> = {}): Decision {
    const d = this.decide(extra);
    // 写しは、判断が返した中身をそのまま置く (サーバーから取り直さない)
    if (d.kind === "set-base") { for (const c of d.keep) this.keep(c); this.state = baseSet(this.state, d.epoch, d.base); }
    if (d.kind === "push") {
      const pending: Pending = { kind: "push", opId: `${this.name}-${++this.ops}`, hash: d.content.hash, expected: d.expected, at: NOW.toISOString() };
      this.keep(d.content);
      this.state = recordPending(this.state, d.epoch, pending);
      if (crash === "after-record") return d;
      this.send(crash === "after-effect");
    }
    if (d.kind === "resend") this.send(false);
    if (d.kind === "pull") {
      for (const c of d.keep) this.keep(c);
      this.state = recordPending(this.state, d.epoch, d.pending);
      if (crash === "after-record") return d;
      { const hook = this.beforeWrite; this.beforeWrite = null; hook?.(); }                                   // (試験用: 手元に書く直前の割り込み)
      // 手元に書く: 前提の中身のままなら置き換える。違っていたら「行われなかった」と確定するので、操作を片付けて次の判断でやり直す
      if ((this.local?.hash ?? null) !== d.pending.expectedLocal) { this.state = pullNotWritten(this.state, d.pending); return d; }
      this.local = d.write;
      if (crash === "after-effect") return d;
      this.state = pullWritten(this.state, d.pending);
    }
    if (d.kind === "finish-pull") this.state = pullWritten(this.state, d.pending);
    // 手元だけを書き換える (前提の中身のままなら)
    if (d.kind === "edit-local" && this.local?.hash === d.expectedLocal) this.local = d.write;
    return d;
  }
  /** 残っている送りの操作を送る (crash = true なら、サーバーが処理した直後・状態を進める前に落ちる) */
  send(crash: boolean) {
    const pending = this.state.pending;
    if (pending?.kind !== "push") throw new Error("no pending push");
    const result = this.server.put(pending.opId, { hash: pending.hash, text: this.objects.get(pending.hash)! }, pending.expected, this.state.epoch ?? undefined);
    if (crash) return;
    // 履歴の世代が違うと言われたら、操作を残したままにする (断られたのとは違う)
    if ("history" in result) return;
    this.state = "accepted" in result ? pushAccepted(this.state, pending.opId, result.accepted) : pushRejected(this.state, pending.opId);
  }
  /** 手元に書く直前に 1 回だけ実行する処理 (試験で、割り込みを再現する) */
  beforeWrite: (() => void) | null = null;
  /** noop か halt になるまで進める (回りすぎたら失敗) */
  sync(extra: Partial<SyncInput> = {}): Decision {
    for (let i = 0; i < 20; i++) { const d = this.step(undefined, extra); if (d.kind === "noop" || d.kind === "halt") return d; }
    throw new Error("sync did not settle");
  }
  /** 手元を編集する */
  edit(change: (p: Project) => Project) { this.local = content(textOf(change(fromJSON(this.local!.text)))); }
  get project(): Project { return fromJSON(this.local!.text); }
}

/** 同じ計画を持つ 2 台 (A が最初に送り、B が受け取った状態) */
function twoDevices() {
  const { p, a, b } = plan();
  const server = new FakeServer();
  const A = new Device("A", server), B = new Device("B", server);
  A.local = content(textOf(p));
  expect(A.sync().kind).toBe("noop");
  expect(B.sync().kind).toBe("noop");
  expect(B.local!.hash).toBe(A.local!.hash);
  return { server, A, B, a, b };
}

describe("1 回の同期 (設計書 3 章の表)", () => {
  it("初めて結び付ける: 手元だけにあれば作って送り、サーバーだけにあれば受け取る。受け取った中身は文字列のまま同じ", () => {
    const { server, A, B } = twoDevices();
    expect(server.head!.revision).toBe("e1.1");
    expect(A.state.base).toEqual({ hash: A.local!.hash, revision: "e1.1" });
    expect(B.state.base).toEqual(A.state.base);
    expect(B.local!.text).toBe(A.local!.text);
  });
  it("何も変わっていなければ何もしない。手元だけ変われば送り、サーバーだけ変われば受け取る", () => {
    const { server, A, B, a } = twoDevices();
    expect(A.decide().kind).toBe("noop");
    A.edit((p) => updateBlock(p, a, { title: "A 改" }));
    expect(A.decide().kind).toBe("push");
    A.sync();
    expect(server.head!.revision).toBe("e1.2");
    expect(B.decide().kind).toBe("pull");
    B.sync();
    expect(B.project.blocks[a].title).toBe("A 改");
    expect(B.state.base).toEqual(A.state.base);
  });
  it("両方が別のボックスを変えたら、手元で統合して書き、統合した結果を送る。基準はいったんサーバーの中身になる", () => {
    const { A, B, a, b } = twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "A 改" })); A.sync();
    B.edit((p) => updateBlock(p, b, { title: "B 改" }));
    const pulled = B.step();
    expect(pulled.kind).toBe("pull");
    // 統合した M を書いた直後: 基準は R (A の送った中身)。M と R の差 (B 改) は、まだ送っていない変更
    expect(B.state.base!.hash).toBe(A.local!.hash);
    expect(B.decide().kind).toBe("push");
    B.sync(); A.sync();
    for (const d of [A, B]) { expect(d.project.blocks[a].title).toBe("A 改"); expect(d.project.blocks[b].title).toBe("B 改"); }
    expect(A.local!.hash).toBe(B.local!.hash);
  });
  it("両方が同じ項目を別の値にしたら、何も書かず何も送らずに止まる (競合の組に、基準・手元・サーバーを控える)", () => {
    const { server, A, B, a } = twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "A の案" })); A.sync();
    B.edit((p) => updateBlock(p, a, { title: "B の案" }));
    const before = { local: B.local!.hash, state: B.state, head: server.head!.revision };
    const d = B.sync();
    expect(d.kind === "halt" && d.halt.reason).toBe("conflicts");
    if (d.kind === "halt" && d.halt.reason === "conflicts") {
      expect(d.halt.conflicts.map((c) => c.path)).toEqual([`blocks.${a}.title`]);
      expect(d.halt.localHash).toBe(before.local);
      expect(d.halt.remoteRevision).toBe(before.head);
    }
    expect(B.local!.hash).toBe(before.local); expect(B.state).toEqual(before.state); expect(server.head!.revision).toBe(before.head);
  });
  it("統合の結果が壊れた計画になるとき (互いのボックスを相手の中へ移した) は、競合が 0 件でも書かずに止まる", () => {
    const { A, B, a, b } = twoDevices();
    A.edit((p) => moveBlockToParent(p, a, b, { x: 40, y: 80 })); A.sync();
    B.edit((p) => moveBlockToParent(p, b, a, { x: 40, y: 80 }));
    const before = B.local!.hash;
    const d = B.sync();
    expect(d.kind === "halt" && ["invalid-merge", "conflicts"].includes(d.halt.reason)).toBe(true);
    expect(B.local!.hash).toBe(before);
  });
  it("送信の間に手元が変わっても、基準は送った中身 S になり、変わった分は次の回で送る", () => {
    const { server, A, B, a, b } = twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "1 回目" }));
    const sent = A.local!.hash;
    A.step("after-record");                                   // S を固定して記録したところ
    A.edit((p) => updateBlock(p, b, { title: "送信中の編集" })); // 送信中に AI が書いた
    A.send(false);
    expect(A.state.base!.hash).toBe(sent);                    // 基準は S (今の手元ではない)
    expect(A.decide().kind).toBe("push");
    A.sync(); B.sync();
    expect(B.project.blocks[a].title).toBe("1 回目"); expect(B.project.blocks[b].title).toBe("送信中の編集");
    expect(server.head!.revision).toBe("e1.3");
  });
});

describe("途中で落ちたときの再開", () => {
  // レビュー 7 の F01: 受理の直後に落ちる → 別の端末が取り消す → 再開。古い変更で取り消しを上書きしない
  it("送りが受理された直後に落ちても、再開で同じ操作を送り直して受理を確かめ、別の端末の取り消しを上書きしない", () => {
    const { server, A, B, a } = twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "新" }));
    A.step("after-effect");                                   // サーバーは受理したが、A は基準を進める前に落ちた
    expect(A.state.pending?.kind).toBe("push");
    B.sync();
    B.edit((p) => updateBlock(p, a, { title: "A" })); B.sync(); // B が受け取ってから、意図して元に戻す
    expect(server.head!.revision).toBe("e1.3");
    expect(A.decide().kind).toBe("resend");
    A.sync();
    expect(A.project.blocks[a].title).toBe("A");              // B の取り消しを受け取った (「新」を送り直していない)
    expect(server.head!.revision).toBe("e1.3");
    expect(A.local!.hash).toBe(B.local!.hash);
  });
  it("送りを記録した直後 (送る前) に落ちた場合は、送り直しで今回が初めての受理になる。別の端末が先に進めていたら断られて、受け取りからやり直す", () => {
    const { A, B, a, b } = twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "A 改" }));
    A.step("after-record");
    A.sync(); B.sync();
    expect(B.project.blocks[a].title).toBe("A 改");
    // 断られる場合
    A.edit((p) => updateBlock(p, a, { title: "A 再" }));
    A.step("after-record");
    B.edit((p) => updateBlock(p, b, { title: "B 改" })); B.sync();
    A.sync(); B.sync();
    for (const d of [A, B]) { expect(d.project.blocks[a].title).toBe("A 再"); expect(d.project.blocks[b].title).toBe("B 改"); }
  });
  it("受け取りを手元に書いた直後に落ち、手元がそのままなら、再開で基準を進めるだけ。再開を繰り返しても同じ結果", () => {
    const { A, B, a } = twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "A 改" })); A.sync();
    B.step("after-effect");
    expect(B.state.pending?.kind).toBe("pull");
    expect(B.decide().kind).toBe("finish-pull");
    B.sync();
    const settled = B.state;
    expect(B.sync().kind).toBe("noop");
    expect(B.state).toEqual(settled);
    expect(B.state.base).toEqual(A.state.base);
  });
  // レビュー 8 の R01: 受け取りを書いた直後に落ちる → AI が別の項目を変える → サーバーで取り消される → 再開
  it("受け取りを書いた後に手元が変わっていたら、書けたかどうかを推測せずに止まる。「反映済み」を選べば、取り消しも AI の編集も残る", () => {
    const { server, A, B, a, b } = twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "新" })); A.sync();
    B.step("after-effect");                                              // B は「新」を手元に書いたが、基準を進める前に落ちた
    B.edit((p) => updateBlock(p, b, { description: "AI の追記" }));        // その後、AI が別の項目を変えた
    A.edit((p) => updateBlock(p, a, { title: "A" })); A.sync();            // サーバーでは題名が取り消された
    const d = B.sync();
    expect(d.kind === "halt" && d.halt.reason).toBe("recover-pull");
    const head = server.head!.revision;
    expect(B.project.blocks[a].title).toBe("新");                         // 止まっている間、何も書かない・送らない
    // 人が「反映済みとして続ける」を選ぶ (印は、表示したときの状態と手元の中身に結び付いている)
    B.state = pullRecovered(B.state, { token: recoveryToken(B.state, B.local!.hash, remoteMark(B.server.remote()), "B", hashOf), applied: true }, B.local!.hash, remoteMark(B.server.remote()), "B", hashOf);
    B.sync(); A.sync();
    for (const dev of [A, B]) { expect(dev.project.blocks[a].title).toBe("A"); expect(dev.project.blocks[b].description).toBe("AI の追記"); }
    expect(server.head!.revision).not.toBe(head);
  });
  it("受け取りの後で手元を前の中身に戻していても、ハッシュの一致だけで「書けていない」と決めずに止まる", () => {
    const { A, B, a } = twoDevices();
    const original = B.local!;
    A.edit((p) => updateBlock(p, a, { title: "新" })); A.sync();
    B.step("after-effect");
    B.local = original;                                                   // 書いた後で、人が元の中身に戻した
    const d = B.sync();
    expect(d.kind === "halt" && d.halt.reason).toBe("recover-pull");
    expect(pullNotWritten(B.state, B.state.pending as PendingPull).pending).toBeNull();
  });
  it("残っている送りの操作が 21 日より古い・日時が読めない・未来の日時のときは、自動で送り直さずに止まる", () => {
    const { A, a } = twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "A 改" }));
    A.step("after-record");
    expect(A.decide({ now: new Date(NOW.getTime() + PENDING_MAX_AGE_MS - 1000) }).kind).toBe("resend");
    for (const now of [new Date(NOW.getTime() + PENDING_MAX_AGE_MS + 1000), new Date(NOW.getTime() - 60 * 60 * 1000)]) {
      const d = A.decide({ now });
      expect(d.kind === "halt" && d.halt.reason).toBe("stale-operation");
    }
    A.state = { ...A.state, pending: { ...A.state.pending!, at: "いつか" } as Pending };
    const d = A.decide();
    expect(d.kind === "halt" && d.halt.reason).toBe("stale-operation");
  });
});

describe("偽のサーバーの約束 (同じ操作の送り直し)", () => {
  it("受理済みの操作の送り直しには、今の版との照合より先に前の結果を返す。同じ操作 ID で違う要求は断る", () => {
    const server = new FakeServer();
    const first = content("one\n"), second = content("two\n");
    expect(server.put("op1", first, null)).toEqual({ accepted: "e1.1" });
    expect(server.put("op2", second, "e1.1")).toEqual({ accepted: "e1.2" });
    expect(server.put("op1", first, null)).toEqual({ accepted: "e1.1" });   // 版は進んでいるが、前の結果
    expect(server.put("op3", first, "e1.1")).toEqual({ rejected: true });  // 別の操作は、前提の版が違えば断る
    expect(() => server.put("op1", second, null)).toThrow();
  });
});

describe("確かめてから進む場面", () => {
  it("初めて結び付けるときに、手元とサーバーの中身が違えば、自動では統合せずに止まる。同じなら基準にする", () => {
    const { p, a } = plan();
    const server = new FakeServer();
    const A = new Device("A", server), B = new Device("B", server), C = new Device("C", server);
    A.local = content(textOf(p)); A.sync();
    B.local = content(textOf(updateBlock(p, a, { title: "別の中身" })));
    const d = B.sync();
    expect(d.kind === "halt" && d.halt.reason).toBe("first-link");
    C.local = content(textOf(p));
    expect(C.step().kind).toBe("set-base");
    expect(C.sync().kind).toBe("noop");
  });
  it("サーバーの履歴の世代が変わっていたら (バックアップからの復旧)、古い基準のまま送らずに止まる", () => {
    const { server, A, a } = twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "A 改" }));
    server.epoch = "e2";
    const d = A.sync();
    expect(d.kind === "halt" && d.halt.reason).toBe("history-changed");
    expect(A.state.pending).toBeNull();
  });
  it("サーバーで消された計画は、勝手に作り直さない", () => {
    const { server, A, a } = twoDevices();
    server.deleted = true;
    A.edit((p) => updateBlock(p, a, { title: "A 改" }));
    const d = A.sync();
    expect(d.kind === "halt" && d.halt.reason).toBe("remote-deleted");
    const fresh = new Device("N", server); fresh.local = A.local;
    const first = fresh.sync();
    expect(first.kind === "halt" && first.halt.reason).toBe("remote-deleted");
  });
  it("手元やサーバーの中身が計画として読めないときは、送らず・書かずに止まる", () => {
    const { server, A, B } = twoDevices();
    A.local = content("{ 壊れた JSON");
    const d = A.sync();
    expect(d.kind === "halt" && d.halt.reason).toBe("invalid-local");
    server.head = { revision: "e1.9", content: content("[]") };
    const e = B.sync();
    expect(e.kind === "halt" && e.halt.reason).toBe("invalid-remote");
  });
});

describe("保護する項目の削除を確かめる", () => {
  /** 計画の文字列の直下に項目を足す / 消す */
  const withTop = (c: Content, change: (d: Record<string, unknown>) => void): Content => { const d = JSON.parse(c.text); change(d); return content(JSON.stringify(d, null, 2) + "\n"); };

  it("保護する項目の一覧: 古い版が落とす設定と、この版が知らない直下の項目。writer と、知っている必須の項目は対象にしない", () => {
    const base = { name: "x", workflowPolicy: { startWithoutInputs: "reject" }, focusBlockId: "b1", contextGuard: true, futureSetting: 1, writer: { app: "9.9.9" }, lang: "ja" };
    expect(protectedDeletions(base, { name: "x" })).toEqual(["contextGuard", "focusBlockId", "futureSetting", "workflowPolicy"]);
    expect(protectedDeletions(base, { ...base })).toEqual([]);
    // 値が変わっただけ・足されただけは、削除ではない
    expect(protectedDeletions(base, { ...base, focusBlockId: "b2", another: 1 })).toEqual([]);
  });
  it("基準に在った設定が手元で消えていたら、送る前に止まる。承認すれば送れる。承認の後で別の編集が入ったら、確かめ直す", () => {
    const { server, A, B, a } = twoDevices();
    A.local = withTop(A.local!, (d) => { d.focusBlockId = a; d.futureSetting = { mode: "strict" }; });
    A.sync(); B.sync();
    expect(JSON.parse(B.local!.text).futureSetting).toEqual({ mode: "strict" });
    // 古い版の書き手が、設定を落として保存した (のかもしれないし、人が意図して消したのかもしれない)
    B.local = withTop(B.local!, (d) => { delete d.focusBlockId; delete d.futureSetting; });
    const head = server.head!.revision;
    const d = B.sync();
    expect(d.kind === "halt" && d.halt.reason).toBe("protected-deletion");
    if (d.kind !== "halt" || d.halt.reason !== "protected-deletion") return;
    expect(d.halt.keys).toEqual(["focusBlockId", "futureSetting"]);
    expect(server.head!.revision).toBe(head);
    // 承認の後で別の編集が入ると、前の承認では通らない
    const approval = d.halt.approval;
    const edited = new Device("B2", server); edited.local = B.local; edited.state = B.state; edited.objects = B.objects;
    edited.edit((p) => updateBlock(p, a, { title: "承認の後の編集" }));
    const again = edited.sync({ approvedDeletion: approval });
    expect(again.kind === "halt" && again.halt.reason).toBe("protected-deletion");
    // そのままの中身なら、承認で送れる。送った後は基準が進むので、同じ削除を繰り返し確かめない
    expect(B.sync({ approvedDeletion: approval }).kind).toBe("noop");
    expect(server.head!.revision).not.toBe(head);
    expect(B.sync().kind).toBe("noop");
    A.sync();
    expect(JSON.parse(A.local!.text).futureSetting).toBeUndefined();
  });
  // レビュー 9 の S03: 過去の正しいファイルを取り出しただけで、今の基準に在る設定が消えた状態になる
  it("過去の版のファイルを取り出して置いた場合 (書き手の印が正しくても) も、消えた設定を自動では送らない", () => {
    const { A, a } = twoDevices();
    const old = A.local!;                                                 // 設定を足す前の、正しいファイル
    A.local = withTop(A.local!, (d) => { d.workflowPolicy = { doneWithoutArtifacts: "reject" }; });
    A.sync();
    A.local = withTop(old, (d) => { d.writer = { app: "0.6.0", protocol: 2, bodyHash: "matches" }; }); // Git で過去の版を取り出した
    A.edit((p) => updateBlock(p, a, { title: "過去の版に手を入れた" }));
    const d = A.sync();
    expect(d.kind === "halt" && d.halt.reason).toBe("protected-deletion");
    if (d.kind === "halt" && d.halt.reason === "protected-deletion") expect(d.halt.keys).toEqual(["workflowPolicy"]);
  });
});

// ---- Codex のレビュー 10 の反例 (T01〜T06、T08) と、足りなかった場面 ----
describe("基準の中身が無い・壊れているとき", () => {
  /** B に保護する設定を足して両方に配り、B の手元からその設定を消した状態を作る */
  const droppedSetting = () => {
    const { server, A, B } = twoDevices();
    const d = JSON.parse(A.local!.text); d.futureSetting = 1; A.local = content(JSON.stringify(d, null, 2) + "\n");
    A.sync(); B.sync();
    const e = JSON.parse(B.local!.text); delete e.futureSetting; B.local = content(JSON.stringify(e, null, 2) + "\n");
    return { server, A, B };
  };
  it("基準の写しが無くても、サーバーの中身が基準と同じなら、それを使って削除を確かめる (確認を飛ばして送らない)", () => {
    const { B } = droppedSetting();
    B.objects.clear();
    const d = B.sync();
    expect(d.kind === "halt" && d.halt.reason).toBe("protected-deletion");
  });
  it("写しが壊れている (ハッシュが合わない) ときは、その写しを使わない", () => {
    const { B } = droppedSetting();
    B.objects.set(B.state.base!.hash, "{ 壊れた写し");
    const d = B.sync();
    expect(d.kind === "halt" && d.halt.reason).toBe("protected-deletion");
  });
  it("写しも無く、サーバーも先へ進んでいて基準の中身が手に入らないときは、送らずに止まる", () => {
    const { A, B, a } = twoDevices();
    B.edit((p) => updateBlock(p, a, { title: "B 改" }));
    B.objects.clear();
    A.edit((p) => updateBlock(p, a, { description: "A の説明" })); A.sync();
    const d = B.sync();
    expect(d.kind === "halt" && d.halt.reason).toBe("base-missing");
  });
});

describe("生の文字列を検査してから使う", () => {
  /** 存在しない入出力を指す線を足した、不正な計画の文字列 */
  const broken = (text: string): Content => {
    const d = JSON.parse(text);
    d.edges["bad-edge"] = { id: "bad-edge", from: { portId: "no-such-port", side: "outer" }, to: { portId: "no-such-port-2", side: "outer" }, kind: "sibling", auto: false };
    return content(JSON.stringify(d, null, 2) + "\n");
  };
  it("手元が不正なら送らない。サーバーが不正なら書かない。両方が同じ不正な文字列でも、基準にしない", () => {
    const { server, A, B } = twoDevices();
    A.local = broken(A.local!.text);
    const l = A.sync();
    expect(l.kind === "halt" && l.halt.reason).toBe("invalid-local");
    const bad = broken(B.local!.text);
    server.head = { revision: "e1.7", content: bad };
    const r = B.sync();
    expect(r.kind === "halt" && r.halt.reason).toBe("invalid-remote");
    B.local = bad;
    const same = B.sync();
    expect(same.kind === "halt" && same.halt.reason).toBe("invalid-remote");
  });
});

describe("統合した結果が手元と同じ場合 (書かずに基準だけ進める)", () => {
  it("新しい基準 (サーバーの中身) の写しを置いてから進めるので、その後の「消えた設定の確認」が働く", () => {
    const { A, B, a } = twoDevices();
    const d = JSON.parse(A.local!.text); d.futureSetting = 1; A.local = content(JSON.stringify(d, null, 2) + "\n");
    A.sync(); B.sync();
    // サーバー: 説明を変更。手元: 同じ説明の変更をすでに含み、さらに題名を変え、設定を消している
    A.edit((p) => updateBlock(p, a, { description: "説明" })); A.sync();
    const withChange = JSON.parse(A.local!.text);
    withChange.blocks[a].title = "B が変えた題名"; delete withChange.futureSetting;
    B.local = content(JSON.stringify(withChange, null, 2) + "\n");
    const first = B.step();
    expect(first.kind).toBe("set-base");
    expect(B.objects.has(B.state.base!.hash)).toBe(true);     // 新しい基準の写しがある
    const next = B.sync();
    expect(next.kind === "halt" && next.halt.reason).toBe("protected-deletion");
  });
  it("版だけが進んで中身が同じときは、書き込みも送信もせずに基準だけ進め、繰り返さない", () => {
    const { server, A, a } = twoDevices();
    server.head = { revision: "e1.5", content: server.head!.content };
    expect(A.step().kind).toBe("set-base");
    expect(A.sync().kind).toBe("noop");
    // 手元は変わっているが、サーバーの中身は基準と同じ (版だけ違う): 受け取りは「手元のまま」、その後に送る
    A.edit((p) => updateBlock(p, a, { title: "A 改" }));
    server.head = { revision: "e1.6", content: server.head!.content };
    expect(A.step().kind).toBe("set-base");
    expect(A.step().kind).toBe("push");
    expect(A.sync().kind).toBe("noop");
  });
});

describe("状態を進める関数は、操作が合わないと進めない", () => {
  const idle: SyncState = { generation: 3, epoch: "e1", base: { hash: "b", revision: "e1.1" }, pending: null };
  const push = (opId: string): PendingPush => ({ kind: "push", opId, hash: "s-" + opId, expected: "e1.1", at: NOW.toISOString() });
  const pull: PendingPull = { kind: "pull", hash: "m", expectedLocal: "l", remote: { hash: "r", revision: "e1.2" }, at: NOW.toISOString() };
  it("やりかけの操作があるのに次を記録できない。基準だけを進めることもできない", () => {
    const busy = recordPending(idle, "e1", push("Q"));
    expect(() => recordPending(busy, "e1", push("P"))).toThrow(SyncStateError);
    expect(() => baseSet(busy, "e1", { hash: "x", revision: "e1.9" })).toThrow(SyncStateError);
  });
  it("別の操作の応答では、基準を進めない・操作を消さない", () => {
    const busy = recordPending(idle, "e1", push("P"));
    expect(() => pushAccepted(busy, "Q", "e1.2")).toThrow(SyncStateError);
    expect(() => pushRejected(busy, "Q")).toThrow(SyncStateError);
    expect(pushAccepted(busy, "P", "e1.2").base).toEqual({ hash: "s-P", revision: "e1.2" });
    const pulling = recordPending(idle, "e1", pull);
    expect(() => pullWritten(pulling, { ...pull, hash: "other" })).toThrow(SyncStateError);
    expect(() => pushAccepted(pulling, "P", "e1.2")).toThrow(SyncStateError);
  });
  it("復旧の選択は、表示したときの状態・手元の中身のときだけ有効 (状態や手元が変わっていたら進めない)", () => {
    const pulling = recordPending(idle, "e1", pull);
    const at = { epoch: "e1", revision: "e1.2" };
    const token = recoveryToken(pulling, "local-1", at, "bind-A", hashOf);
    const recover = (state: SyncState, local: string, remote = at, binding = "bind-A", t = token) => pullRecovered(state, { token: t, applied: true }, local, remote, binding, hashOf);
    expect(() => recover(pulling, "local-2")).toThrow(SyncStateError);
    expect(() => recover({ ...pulling, generation: pulling.generation + 2 }, "local-1")).toThrow(SyncStateError);
    // 表示のあとでサーバーが進んだ・履歴の世代が変わった場合も、前の印では進めない (操作は残る)
    expect(() => recover(pulling, "local-1", { epoch: "e1", revision: "e1.3" })).toThrow(SyncStateError);
    const other = { epoch: "e2", revision: "e2.1" };
    expect(() => recover(pulling, "local-1", other, "bind-A", recoveryToken(pulling, "local-1", other, "bind-A", hashOf))).toThrow(SyncStateError);
    // 中身・日時・世代がまったく同じでも、別の結び付けで得た印は使えない
    expect(() => recover(pulling, "local-1", at, "bind-B")).toThrow(SyncStateError);
    expect(recover(pulling, "local-1").base).toEqual(pull.remote);
    expect(pullRecovered(pulling, { token, applied: false }, "local-1", at, "bind-A", hashOf).base).toEqual(idle.base);
  });
});

describe("承認の印の範囲", () => {
  it("別の結び付け・別の履歴の世代・別の基準では、前の承認が通らない", () => {
    const { A, B } = twoDevices();
    const d = JSON.parse(A.local!.text); d.futureSetting = 1; A.local = content(JSON.stringify(d, null, 2) + "\n");
    A.sync(); B.sync();
    const e = JSON.parse(B.local!.text); delete e.futureSetting; B.local = content(JSON.stringify(e, null, 2) + "\n");
    const halted = B.decide();
    if (halted.kind !== "halt" || halted.halt.reason !== "protected-deletion") throw new Error("expected a halt");
    const approval = halted.halt.approval;
    const input = { state: B.state, local: B.local, remote: B.server.remote(), baseText: B.objects.get(B.state.base!.hash)!, now: NOW, hashOf, approvedDeletion: approval };
    expect(decide({ ...input, bindingId: "B" }).kind).toBe("push");
    // 状態の世代が進んだだけ (基準・手元・消えた項目が同じ) なら、同じ判断への承認として有効
    expect(decide({ ...input, bindingId: "B", state: { ...B.state, generation: B.state.generation + 2 } }).kind).toBe("push");
    // 別の結び付け (同じ計画を複製して、別に結び付けた)
    expect(decide({ ...input, bindingId: "copy" }).kind).toBe("halt");
    // 別の履歴の世代
    expect(decide({ ...input, bindingId: "B", state: { ...B.state, epoch: "e2" }, remote: { ...(B.server.remote() as Extract<Remote, { kind: "present" }>), epoch: "e2" } }).kind).toBe("halt");
  });
});

describe("やりかけの送りと、サーバーの履歴の世代", () => {
  it("新しく作る操作を記録した後で世代が変わったら (復旧で計画が無くなった)、送り直さずに止まる。操作は残る", () => {
    const { p } = plan();
    const server = new FakeServer();
    const A = new Device("A", server);
    A.local = content(textOf(p));
    A.step("after-record");                                   // 作成の操作 (前提の版なし) を記録したところ
    server.epoch = "e2";                                      // サーバーが復旧して、履歴の世代が変わった
    const d = A.sync();
    expect(d.kind === "halt" && d.halt.reason).toBe("history-changed");
    expect(A.state.pending?.kind).toBe("push");
    expect(server.head).toBeNull();                           // 新しい世代の上に、勝手に作っていない
  });
  it("取得と送信の間に世代が変わった場合も、サーバーが断り、操作は残る (断られた扱いにしない)", () => {
    const { server, A, a } = twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "A 改" }));
    A.step("after-record");
    const before = A.state;
    server.epoch = "e2";
    A.send(false);
    expect(A.state).toEqual(before);
  });
});

describe("受け取りの途中の割り込み", () => {
  it("手元に書く直前に別の編集が入ったら、書かずに操作を片付け、次の判断で統合する (どちらの変更も残る)", () => {
    const { A, B, a, b } = twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "A 改" })); A.sync();
    B.beforeWrite = () => B.edit((p) => updateBlock(p, b, { title: "AI が書いた" }));
    expect(B.step().kind).toBe("pull");
    expect(B.state.pending).toBeNull();                       // 行われなかったと確定したので、操作は残さない
    expect(B.project.blocks[b].title).toBe("AI が書いた");
    B.sync(); A.sync();
    for (const d of [A, B]) { expect(d.project.blocks[a].title).toBe("A 改"); expect(d.project.blocks[b].title).toBe("AI が書いた"); }
  });
  it("受け取りを記録した直後 (書く前) に落ち、人が「反映されていない」を選べば、基準を変えずにやり直して受け取る", () => {
    const { A, B, a, b } = twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "A 改" })); A.sync();
    B.step("after-record");
    B.edit((p) => updateBlock(p, b, { description: "無関係な編集" }));
    const d = B.sync();
    expect(d.kind === "halt" && d.halt.reason).toBe("recover-pull");
    B.state = pullRecovered(B.state, { token: recoveryToken(B.state, B.local!.hash, remoteMark(B.server.remote()), "B", hashOf), applied: false }, B.local!.hash, remoteMark(B.server.remote()), "B", hashOf);
    B.sync();
    expect(B.project.blocks[a].title).toBe("A 改");
    expect(B.project.blocks[b].description).toBe("無関係な編集");
  });
  it("サーバーの中身を取得した後で別の端末が更新しても、置く写しは判断に使った中身。次の送りは断られ、新しい中身を受け取る", () => {
    const { A, B, a, b } = twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "1" })); A.sync();
    B.edit((p) => updateBlock(p, b, { title: "B 改" }));
    B.beforeWrite = () => { A.edit((p) => updateBlock(p, a, { title: "2" })); A.sync(); }; // B が R1 を取得した後に、A が R2 を送った
    B.step();
    expect(B.objects.has(B.state.base!.hash)).toBe(true);     // 基準 (R1) の写しがある
    B.sync(); A.sync();
    for (const d of [A, B]) { expect(d.project.blocks[a].title).toBe("2"); expect(d.project.blocks[b].title).toBe("B 改"); }
  });
});

describe("基準があるのに手元が無い", () => {
  it("手元のファイルが無くなっていたら、削除として送らず、作り直しもせずに止まる", () => {
    const { server, A } = twoDevices();
    const head = server.head!.revision;
    A.local = null;
    const d = A.sync();
    expect(d.kind === "halt" && d.halt.reason).toBe("local-missing");
    expect(server.head!.revision).toBe(head);
  });
});

// 入れ子の実体 (同じ人の記録、同じ人が続ける活動、位置) の部分更新で、この版が知らない項目を落とさない
describe("入れ子の知らない項目を、通常の操作で落とさない", () => {
  it("活動の記録・移動のあとも、同じ人の記録・活動・位置にある知らない項目が残る", () => {
    const { p, a } = plan();
    const raw = JSON.parse(toJSON(setActivity(p, a, "codex", "working", "開始")));
    raw.agents.codex.futureAgent = "keep";
    raw.blocks[a].activity.futureActivity = "keep";
    raw.blocks[a].position.futurePosition = "keep";
    let q = fromJSON(JSON.stringify(raw));
    q = setActivity(q, a, "codex", "blocked", "詰まった");
    q = moveBlock(q, a, { x: 400, y: 300 });
    const out = JSON.parse(toJSON(q));
    expect(out.agents.codex.futureAgent).toBe("keep");
    expect(out.blocks[a].activity.futureActivity).toBe("keep");
    expect(out.blocks[a].activity.state).toBe("blocked");
    expect(out.blocks[a].position.futurePosition).toBe("keep");
    // 別の人の活動に替わるときは、前の人の記録の項目を持ち込まない
    expect(JSON.parse(toJSON(setActivity(q, a, "claude-code", "working", "交代"))).blocks[a].activity.futureActivity).toBeUndefined();
  });
});

describe("人の選択で進める場面", () => {
  it("競合: 表示した項目だけを選んだ側に決める。競合していない変更は両方残る。選んでいる間に手元が変わったら、前の印では進まない", () => {
    const { A, B, a, b } = twoDevices();
    A.edit((p) => updateBlock(updateBlock(p, a, { title: "A の案" }), b, { description: "A だけの変更" })); A.sync();
    B.edit((p) => updateBlock(p, a, { title: "B の案" }));
    const d = B.sync();
    if (d.kind !== "halt" || d.halt.reason !== "conflicts") throw new Error("expected conflicts");
    const token = d.halt.token;
    // 選んでいる間に、AI が手元の別の項目を変えた → 前の印では進まず、もう一度止まる (新しい印になる)
    const C = new Device("B", B.server); C.local = B.local; C.state = B.state; C.objects = B.objects;
    C.edit((p) => updateBlock(p, b, { title: "選んでいる間の編集" }));
    const again = C.sync({ resolution: { token, prefer: "local" } });
    expect(again.kind === "halt" && again.halt.reason === "conflicts" && again.halt.token !== token).toBe(true);
    // そのままなら、手元の値に決められる
    expect(B.sync({ resolution: { token, prefer: "local" } }).kind).toBe("noop");
    A.sync();
    for (const dev of [A, B]) { expect(dev.project.blocks[a].title).toBe("B の案"); expect(dev.project.blocks[b].description).toBe("A だけの変更"); }
  });
  it("競合: サーバーの値に決めることもできる (手元の、競合していない変更は残る)", () => {
    const { A, B, a, b } = twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "A の案" })); A.sync();
    B.edit((p) => updateBlock(updateBlock(p, a, { title: "B の案" }), b, { title: "B だけの変更" }));
    const d = B.sync();
    if (d.kind !== "halt" || d.halt.reason !== "conflicts") throw new Error("expected conflicts");
    B.sync({ resolution: { token: d.halt.token, prefer: "remote" } }); A.sync();
    for (const dev of [A, B]) { expect(dev.project.blocks[a].title).toBe("A の案"); expect(dev.project.blocks[b].title).toBe("B だけの変更"); }
  });
  it("消えた設定を戻す: 消えた項目だけが基準から戻り、同時に入っていた別の編集は残る。その後は確かめずに送れる", () => {
    const { A, B, a } = twoDevices();
    const d0 = JSON.parse(A.local!.text); d0.futureSetting = { mode: "strict" }; A.local = content(JSON.stringify(d0, null, 2) + "\n");
    A.sync(); B.sync();
    const d1 = JSON.parse(B.local!.text); delete d1.futureSetting; d1.blocks[a].title = "AI の編集"; B.local = content(JSON.stringify(d1, null, 2) + "\n");
    const halted = B.sync();
    if (halted.kind !== "halt" || halted.halt.reason !== "protected-deletion") throw new Error("expected a halt");
    expect(B.sync({ restoreDeletion: halted.halt.approval }).kind).toBe("noop");
    expect(JSON.parse(B.local!.text).futureSetting).toEqual({ mode: "strict" });
    A.sync();
    expect(A.project.blocks[a].title).toBe("AI の編集");
    expect(JSON.parse(A.local!.text).futureSetting).toEqual({ mode: "strict" });
  });
  it("初めての結び付けで中身が違うとき: 選んだ側を採る。サーバーを採るなら手元の退避を求め、手元を採るならサーバーの今の版を前提に送る", () => {
    const { p, a } = plan();
    const server = new FakeServer();
    const A = new Device("A", server); A.local = content(textOf(p)); A.sync();
    const fresh = () => { const d = new Device("N", server); d.local = content(textOf(updateBlock(p, a, { title: "手元の中身" }))); return d; };
    // サーバーの側を採る
    const R = fresh();
    const halted = R.sync();
    if (halted.kind !== "halt" || halted.halt.reason !== "first-link") throw new Error("expected first-link");
    const pull = R.decide({ firstLink: { token: halted.halt.token, prefer: "remote" } });
    expect(pull.kind === "pull" && pull.backup).toBe(true);
    expect(R.sync({ firstLink: { token: halted.halt.token, prefer: "remote" } }).kind).toBe("noop");
    expect(R.project.blocks[a].title).toBe("A");
    // 手元の側を採る
    const L = fresh();
    const h2 = L.sync();
    if (h2.kind !== "halt" || h2.halt.reason !== "first-link") throw new Error("expected first-link");
    expect(L.sync({ firstLink: { token: h2.halt.token, prefer: "local" } }).kind).toBe("noop");
    A.sync();
    expect(A.project.blocks[a].title).toBe("手元の中身");
    // 古い印 (選んだ後でサーバーが進んだ) では進まない
    const late = fresh(); late.edit((q) => updateBlock(q, a, { title: "さらに別" }));
    const h3 = late.sync();
    if (h3.kind !== "halt" || h3.halt.reason !== "first-link") throw new Error("expected first-link");
    A.edit((q) => updateBlock(q, a, { description: "その間の更新" })); A.sync();
    const stale = late.sync({ firstLink: { token: h3.halt.token, prefer: "local" } });
    expect(stale.kind === "halt" && stale.halt.reason).toBe("first-link");
  });
  it("初めての結び付けで、手元にもサーバーにも計画が無ければ、何もしない", () => {
    const d = new Device("N", new FakeServer());
    expect(d.sync().kind).toBe("noop");
    expect(d.state.base).toBeNull();
  });
});

describe("復旧のときの見比べ", () => {
  it("2 つの計画の違いを、ボックスの追加・削除・変わった項目として読める形にする (記録の日時は数えない)", () => {
    const { p, a, b } = plan();
    const changed = updateBlock(p, a, { title: "A 改", description: "説明" });
    const lines = describeChanges(textOf(p), textOf(changed));
    expect(lines).toEqual(["ボックス「A 改」の title, description が変わる"]);
    const d = JSON.parse(textOf(p)); delete d.blocks[b]; d.futureSetting = 1;
    const removed = describeChanges(textOf(p), JSON.stringify(d));
    expect(removed).toContain("ボックス「B」が消える");
    expect(removed).toContain("設定 futureSetting が加わる");
    expect(describeChanges(textOf(p), textOf(p))).toEqual([]);
  });
  it("受け取りの再開: どちらを選んだら、手元とサーバーがどうなるかを示す。何も書かない・送らない", () => {
    const { server, A, B, a, b } = twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "新" })); A.sync();
    B.step("after-effect");                                              // B は「新」を書いた直後に落ちた
    B.edit((p) => updateBlock(p, b, { description: "AI の追記" }));
    A.edit((p) => updateBlock(p, a, { title: "A" })); A.sync();            // サーバーでは取り消された
    const before = { local: B.local!.hash, state: B.state, head: server.head!.revision };
    const input = { state: B.state, local: B.local, remote: server.remote(), bindingId: "B", baseText: null, now: NOW, hashOf };
    const preview = previewRecovery(input, (hash) => B.objects.get(hash) ?? null);
    // 反映済みとして続ける: サーバーの取り消しが手元に入り、そのあと AI の追記を送る
    expect(preview.applied.next).toBe("push");
    expect(preview.applied.localChanges).toEqual(["ボックス「A」の title が変わる"]);
    expect(preview.applied.remoteChanges).toEqual(["ボックス「B」の description が変わる"]);
    // 反映されていないものとして続ける: 手元は変わらず、手元の「新」と AI の追記を送る (サーバーの取り消しを上書きする)
    expect(preview.notApplied.next).toBe("push");
    expect(preview.notApplied.localChanges).toEqual([]);
    expect(preview.notApplied.remoteChanges.sort()).toEqual(["ボックス「B」の description が変わる", "ボックス「新」の title が変わる"]);
    expect({ local: B.local!.hash, state: B.state, head: server.head!.revision }).toEqual(before);
  });
});

describe("時刻の境界", () => {
  it("残っている送りの操作は、ちょうど 21 日までは送り直し、それを 1 ミリ秒でも過ぎたら止まる。5 分以内の未来の日時は許す", () => {
    const { A, a } = twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "A 改" }));
    A.step("after-record");
    const at = (ms: number) => A.decide({ now: new Date(NOW.getTime() + ms) }).kind;
    expect(at(PENDING_MAX_AGE_MS)).toBe("resend");
    expect(at(PENDING_MAX_AGE_MS + 1)).toBe("halt");
    expect(at(-5 * 60 * 1000)).toBe("resend");
    expect(at(-5 * 60 * 1000 - 1)).toBe("halt");
  });
});

// ---- Codex のレビュー 12 の反例 ----
describe("復旧の見比べは、実際の同期と同じところまで進める", () => {
  it("受け取りの次に「消えた設定の確認」で止まる場合は、「送る」と表示せず、その理由で止まると示す。実際の動きと一致する", () => {
    const { server, A, B, a, b } = twoDevices();
    const d0 = JSON.parse(A.local!.text); d0.futureSetting = 1; A.local = content(JSON.stringify(d0, null, 2) + "\n");
    A.sync(); B.sync();
    A.edit((p) => updateBlock(p, a, { title: "R1" })); A.sync();
    B.step("after-effect");                                              // B は R1 を書いた直後に落ちた
    const d1 = JSON.parse(B.local!.text); delete d1.futureSetting; d1.blocks[b].title = "別の編集"; B.local = content(JSON.stringify(d1, null, 2) + "\n");
    A.edit((p) => updateBlock(p, a, { description: "R2" })); A.sync();     // サーバーはさらに進んだ
    const input = { state: B.state, local: B.local, remote: server.remote(), bindingId: "B", baseText: null, now: NOW, hashOf };
    const preview = previewRecovery(input, (hash) => B.objects.get(hash) ?? null);
    expect(preview.applied.next).toBe("protected-deletion");
    expect(preview.applied.remoteChanges).toEqual([]);
    expect(preview.applied.localChanges).toEqual(["ボックス「R1」の description が変わる"]);
    // 実際に「反映済み」を選んで進めても、同じところで止まり、何も送らない
    const head = server.head!.revision;
    B.state = pullRecovered(B.state, { token: recoveryToken(B.state, B.local!.hash, remoteMark(server.remote()), "B", hashOf), applied: true }, B.local!.hash, remoteMark(server.remote()), "B", hashOf);
    const actual = B.sync();
    expect(actual.kind === "halt" && actual.halt.reason).toBe("protected-deletion");
    expect(server.head!.revision).toBe(head);
    expect(B.project.blocks[a].description).toBe("R2");
  });
  it("送るかどうかは、違いの一覧の件数ではなく判断で決める (記録だけが違う場合も「送る」と示す)", () => {
    const { server, A, B, a } = twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "新" })); A.sync();
    B.step("after-effect");
    // 手元の違いは、一覧に出さない項目 (ログ) だけ
    const d = JSON.parse(B.local!.text); d.log.push({ id: "x1", at: NOW.toISOString(), actor: "human", kind: "note", message: "記録だけ" }); B.local = content(JSON.stringify(d, null, 2) + "\n");
    const preview = previewRecovery({ state: B.state, local: B.local, remote: server.remote(), bindingId: "B", baseText: null, now: NOW, hashOf }, (hash) => B.objects.get(hash) ?? null);
    expect(preview.applied).toEqual({ next: "push", localChanges: [], remoteChanges: [] });
  });
});

describe("初回の選択の印", () => {
  it("同じ手元・同じ版の番号でも、別の計画 (結び付けの印が違う)・別の中身・別の世代には使えない", () => {
    const { p, a } = plan();
    const local = content(textOf(updateBlock(p, a, { title: "手元" })));
    const seen = content(textOf(updateBlock(p, a, { title: "見た計画" }))), unseen = content(textOf(updateBlock(p, a, { title: "見ていない計画" })));
    const ask = (bindingId: string, remote: Content, epoch = "e1", firstLink?: { token: string; prefer: "local" | "remote" }) =>
      decide({ state: { generation: 0, epoch: null, base: null, pending: null }, local, remote: { kind: "present", epoch, revision: "e1.1", content: remote }, bindingId, baseText: null, now: NOW, hashOf, firstLink });
    const halted = ask("dir:seen", seen);
    if (halted.kind !== "halt" || halted.halt.reason !== "first-link") throw new Error("expected first-link");
    const choice = { token: halted.halt.token, prefer: "local" as const };
    expect(ask("dir:seen", seen, "e1", choice).kind).toBe("push");
    for (const other of [ask("dir:unseen", unseen, "e1", choice), ask("dir:seen", unseen, "e1", choice), ask("dir:seen", seen, "e2", choice)]) {
      expect(other.kind === "halt" && other.halt.reason).toBe("first-link");
    }
  });
});

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
  baseSet, decide, PENDING_MAX_AGE_MS, protectedDeletions, pullRecovered, pullWritten, pullNotWritten, pushAccepted, pushRejected, recordPending
, type Content, type Decision, type Pending, type Remote, type SyncState
} from "./engine";

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
  /** Output: { accepted: 版 } または { rejected: true } (前提の版が違う) */
  put(opId: string, c: Content, expected: string | null): { accepted: string } | { rejected: true } {
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
  decide(extra: { approvedDeletion?: string; now?: Date } = {}): Decision {
    return decide({
      state: this.state, local: this.local, remote: this.server.remote()
    , baseText: this.state.base ? this.objects.get(this.state.base.hash) ?? null : null
    , now: extra.now ?? NOW, hashOf, approvedDeletion: extra.approvedDeletion
    });
  }
  keep(c: Content) { this.objects.set(c.hash, c.text); }
  /**
   * 判断を 1 つ実行する
   * Input : crash = どこで落ちるか ("after-record" = 操作を記録した直後, "after-effect" = 送信 / 手元への書き込みの直後・状態を進める前)
   * Output: 実行した判断
   */
  step(crash?: "after-record" | "after-effect", extra: { approvedDeletion?: string; now?: Date } = {}): Decision {
    const d = this.decide(extra);
    if (d.kind === "set-base") { if (this.local) this.keep(this.local); this.state = baseSet(this.state, d.epoch, d.base); }
    if (d.kind === "push") {
      const pending: Pending = { kind: "push", opId: `${this.name}-${++this.ops}`, hash: d.content.hash, expected: d.expected, at: NOW.toISOString() };
      this.keep(d.content);
      this.state = recordPending(this.state, d.epoch, pending);
      if (crash === "after-record") return d;
      this.send(crash === "after-effect");
    }
    if (d.kind === "resend") this.send(false);
    if (d.kind === "pull") {
      this.keep(d.write); this.keep(this.server.remote().kind === "present" ? (this.server.remote() as { content: Content }).content : d.write);
      this.state = recordPending(this.state, d.epoch, d.pending);
      if (crash === "after-record") return d;
      this.local = d.write; // 手元に書く
      if (crash === "after-effect") return d;
      this.state = pullWritten(this.state);
    }
    if (d.kind === "finish-pull") this.state = pullWritten(this.state);
    return d;
  }
  /** 残っている送りの操作を送る (crash = true なら、サーバーが処理した直後・状態を進める前に落ちる) */
  send(crash: boolean) {
    const pending = this.state.pending;
    if (pending?.kind !== "push") throw new Error("no pending push");
    const result = this.server.put(pending.opId, { hash: pending.hash, text: this.objects.get(pending.hash)! }, pending.expected);
    if (crash) return;
    this.state = "accepted" in result ? pushAccepted(this.state, result.accepted) : pushRejected(this.state);
  }
  /** noop か halt になるまで進める (回りすぎたら失敗) */
  sync(extra: { approvedDeletion?: string } = {}): Decision {
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
    B.state = pullRecovered(B.state, true);                               // 人が「反映済みとして続ける」を選ぶ
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
    expect(pullNotWritten(B.state).pending).toBeNull();
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

/**
 * 着手の準備 (readiness): 担当の導出・要具体化・入力待ちを別々に判定することの確認
 * (Codex との設計で決めた確認事項 1〜13 をそのままテストにする)
 */
import { describe, expect, it } from "vitest";
import { addBlock, addPort, connect, connectToBlock, createArtifact, createProject, defaultTaskParent, portsOf, updateBlock, updatePort, fromJSON, toJSON } from "./graph";
import { addBranch } from "./branch";
import { isUnprepared, nextSteps, outputOwners, readiness, reasonText, unpreparedReasons, unpreparedState } from "./readiness";
import { checkStart } from "./workflow";
import { validateProjectText } from "./validate-file";
import { setLang } from "../i18n/core";
import type { Project } from "./types";

/** 1 つの葉のボックス (出力「コード」) を持つ計画 */
function leaf(): { p: Project; id: string } {
  setLang("ja");
  const base = createProject("確認");
  const r = addBlock(base, { parentId: defaultTaskParent(base), title: "実装", outputName: "コード" });
  return { p: r.project, id: r.blockId };
}
/** 出力に予定成果物と完了条件を付ける (具体化済みにする) */
function prepare(p: Project, id: string): Project {
  let q = p;
  for (const o of portsOf(q, id, "out")) q = updatePort(q, o.id, { expect: { kind: "file", hint: "src/x.ts" } });
  return updateBlock(q, id, { scope: { ...q.blocks[id].scope, acceptance: "テストが通る" } });
}
/** 親 (出力「アプリ」) と子 (出力「コード」) を作り、子の出力を親の出力につなぐ */
function parentWithChild(): { p: Project; parent: string; child: string } {
  const { p, id: parent } = leaf();
  let q = updatePort(p, portsOf(p, parent, "out")[0].id, { name: "アプリ" });
  const r = addBlock(q, { parentId: parent, title: "部品を作る", outputName: "コード" });
  q = r.project;
  const c = connect(q, { portId: portsOf(q, r.blockId, "out")[0].id, side: "outer" }, { portId: portsOf(q, parent, "out")[0].id, side: "inner" });
  expect(c.error).toBeUndefined();
  return { p: c.project, parent, child: r.blockId };
}

describe("担当の導出", () => {
  it("子を持たないボックスの出力は、印が無くても自身の担当 (確認 7)", () => {
    const { p, id } = leaf();
    expect(outputOwners(p, id).map((o) => o.owner.kind)).toEqual(["self"]);
  });
  it("子の出力がつながった親の出力は子の担当。印の無い未接続の出力は未定 (確認 3)", () => {
    const { p, parent, child } = parentWithChild();
    expect(outputOwners(p, parent)[0].owner).toEqual({ kind: "child", blockIds: [child] });
    const q = addPort(p, { blockId: parent, direction: "out", name: "手順書" }).project;
    const owners = outputOwners(q, parent);
    expect(owners.find((o) => o.port.name === "手順書")!.owner.kind).toBe("undecided");
    // 未定は「親が作る」と確定しない: 要具体化の理由に出る
    expect(unpreparedReasons(q, parent).map((r) => r.kind)).toContain("undecided");
  });
  it("--self の印が付いた親の出力は自身の担当 (統合など)", () => {
    const { p, parent } = parentWithChild();
    let q = addPort(p, { blockId: parent, direction: "out", name: "統合結果" }).project;
    const port = portsOf(q, parent, "out").find((o) => o.name === "統合結果")!;
    q = updatePort(q, port.id, { owner: "self" });
    expect(outputOwners(q, parent).find((o) => o.port.name === "統合結果")!.owner.kind).toBe("self");
  });
  it("--self と子の結線が重なったら重複として案内し、黙って優先しない (確認 11)", () => {
    const { p, parent } = parentWithChild();
    const q = updatePort(p, portsOf(p, parent, "out")[0].id, { owner: "self" });
    expect(outputOwners(q, parent)[0].owner.kind).toBe("conflict");
    expect(readiness(q, parent).state).toBe("unprepared");
    expect(reasonText(q, unpreparedReasons(q, parent)[0])).toContain("重複");
  });
  it("成果物があっても担当は変わらない: 再作業を禁止しない (確認 2)", () => {
    const { p, id } = leaf();
    const out = portsOf(p, id, "out")[0];
    let q = updatePort(p, out.id, { artifacts: [createArtifact("前回のコード", "src/x.ts")] });
    q = prepare(q, id);
    expect(outputOwners(q, id)[0].owner.kind).toBe("self");
    expect(readiness(q, id).state).toBe("ready");
  });
  it("子の追加・結線で担当の導出が変わる (確認 4、キャッシュは計画ごと)", () => {
    const { p, id } = leaf();
    expect(outputOwners(p, id)[0].owner.kind).toBe("self");
    const r = addBlock(p, { parentId: id, title: "子", outputName: "コード" });
    // 子を足しただけ (結線はまだ): 親の出力は未定
    expect(outputOwners(r.project, id)[0].owner.kind).toBe("undecided");
    const c = connect(r.project, { portId: portsOf(r.project, r.blockId, "out")[0].id, side: "outer" }, { portId: portsOf(r.project, id, "out")[0].id, side: "inner" });
    expect(outputOwners(c.project, id)[0].owner.kind).toBe("child");
    // 要具体化の集まりも計画ごとに計算し直される (子に任せきりになった親は、画面では要具体化ではない)
    expect(unpreparedState(p).self.has(id)).toBe(true);
    expect(unpreparedState(r.project).self.has(id)).toBe(true); // 未定の出力がある間は要具体化
    expect(unpreparedState(c.project).self.has(id)).toBe(false);
    expect(unpreparedState(c.project).self.has(r.blockId)).toBe(true);
  });
});

describe("要具体化の判定", () => {
  it("出力 0 個 / through だけ / 自身の出力あり を区別する (確認 9)", () => {
    const { p, id } = leaf();
    // 出力 0 個: 出力を消す代わりに、出力の無いボックスを足す
    const r = addBlock(p, { parentId: defaultTaskParent(p), title: "出力なし" });
    // addBlock は既定の出力を 1 つ作るので、出力の無いボックスにするために消す (画面では最後の出力は消せないが、古い計画や手で直した JSON にはあり得る)
    const none: Project = structuredClone(r.project);
    for (const o of portsOf(none, r.blockId, "out")) delete none.ports[o.id];
    expect(unpreparedReasons(none, r.blockId).map((x) => x.kind)).toEqual(["no-outputs"]);
    expect(readiness(none, r.blockId).state).toBe("unprepared");
    // through だけ: 親の入力を親の出力へ通す
    const { p: pc, parent } = parentWithChild();
    let q = addPort(pc, { blockId: parent, direction: "in", name: "仕様" }).project;
    q = addPort(q, { blockId: parent, direction: "out", name: "仕様 (転記)" }).project;
    const inp = portsOf(q, parent, "in").find((x) => x.name === "仕様")!;
    const outp = portsOf(q, parent, "out").find((x) => x.name === "仕様 (転記)")!;
    const c = connect(q, { portId: inp.id, side: "inner" }, { portId: outp.id, side: "inner" });
    expect(c.error).toBeUndefined();
    const owners = outputOwners(c.project, parent);
    expect(owners.find((o) => o.port.name === "仕様 (転記)")!.owner.kind).toBe("through");
    // 子と through だけ → 自身の出力が無い (start の検査では理由に出る。画面・一覧では出ない)
    const reasons = unpreparedReasons(c.project, parent, { forStart: true });
    expect(reasons.map((x) => x.kind)).toEqual(["no-own-output"]);
    expect(unpreparedReasons(c.project, parent)).toEqual([]);
    expect(reasonText(c.project, reasons[0])).toContain("作る出力はありません");
    // 自身の出力あり
    expect(unpreparedReasons(p, id).map((x) => x.kind)).toEqual(["missing-expect", "missing-acceptance"]);
    expect(readiness(prepare(p, id), id).state).toBe("ready");
  });
  it("葉でも自身の出力の存在検査を省略しない: 葉の出力が through だけなら自身の出力は無い", () => {
    const { p, id } = leaf();
    let q = addPort(p, { blockId: id, direction: "in", name: "仕様" }).project;
    const inp = portsOf(q, id, "in")[0], outp = portsOf(q, id, "out")[0];
    const c = connect(q, { portId: inp.id, side: "inner" }, { portId: outp.id, side: "inner" });
    expect(c.error).toBeUndefined();
    const reasons = unpreparedReasons(c.project, id, { forStart: true });
    expect(reasons.map((x) => x.kind)).toEqual(["no-own-output"]);
    // 子が無いので、子への移動は案内しない
    expect(nextSteps(c.project, id, reasons).join("\n")).not.toContain("start");
  });
  it("調査タスクは note の予定成果物で具体化済みになる (架空のファイルは要らない)", () => {
    const { p, id } = leaf();
    let q = updatePort(p, portsOf(p, id, "out")[0].id, { name: "調査メモ", expect: { kind: "note", hint: "対象箇所と根拠" } });
    q = updateBlock(q, id, { scope: { acceptance: "実装対象を絞れる、または絞れない理由が分かる" } });
    expect(readiness(q, id).state).toBe("ready");
  });
  it("親自身が統合結果を作る計画は、成果物の生成前に具体化済みになる (確認 1)", () => {
    const { p, parent } = parentWithChild();
    let q = addPort(p, { blockId: parent, direction: "out", name: "統合結果" }).project;
    const port = portsOf(q, parent, "out").find((o) => o.name === "統合結果")!;
    q = updatePort(q, port.id, { owner: "self", expect: { kind: "url", hint: "リリース候補の PR" } });
    q = updateBlock(q, parent, { scope: { acceptance: "結合テストが通る" } });
    expect(readiness(q, parent).own.map((o) => o.name)).toEqual(["統合結果"]);
    expect(unpreparedReasons(q, parent)).toEqual([]);
    expect(readiness(q, parent).state).toBe("ready");
  });
  it("expect の hint が空白だけなら未定として扱う", () => {
    const { p, id } = leaf();
    let q = updatePort(p, portsOf(p, id, "out")[0].id, { expect: { kind: "file", hint: "  " } });
    q = updateBlock(q, id, { scope: { acceptance: "通る" } });
    expect(unpreparedReasons(q, id).map((x) => x.kind)).toEqual(["missing-expect"]);
  });
  it("分岐・合流・プロジェクトのボックス・完了済みは要具体化に数えない", () => {
    const { p } = leaf();
    const parentId = defaultTaskParent(p);
    const r = addBranch(p, { parentId, title: "方式を決める", question: "どれ?", options: ["A", "B"], actor: "human" });
    expect(unpreparedReasons(r.project, r.blockId)).toEqual([]);
    expect(readiness(r.project, r.blockId).state).toBe("ready");
    expect(unpreparedReasons(r.project, parentId)).toEqual([]);
    expect(readiness(r.project, parentId).state).toBe("none");
    const { p: p2, id } = leaf();
    const done = updateBlock(p2, id, { status: "white" });
    expect(isUnprepared(done, id)).toBe(false);
  });
  it("親には配下の要具体化の件数が付く", () => {
    const { p, parent, child } = parentWithChild();
    const st = unpreparedState(p);
    expect(st.self.has(child)).toBe(true);
    expect(st.below.get(parent)).toBe(1);
    expect(st.self.has(parent)).toBe(false); // 子に任せきりの親は要具体化ではない
    expect(st.below.get(defaultTaskParent(p))).toBe(1);
  });
});

describe("start の検査 (checkStart)", () => {
  it("未設定の計画 (warn): 要具体化でも警告だけで開始できる (確認 5)", () => {
    const { p, id } = leaf();
    const r = checkStart(p, id, "codex");
    expect(r.error).toBe("");
    expect(r.warning).toContain("要具体化");
    expect(r.warning).toContain("expect");
  });
  it("reject の計画: AI は --reason でも通れない。人は通る (確認 9)", () => {
    const { p, id } = leaf();
    p.workflowPolicy = { startUnprepared: "reject" };
    expect(checkStart(p, id, "codex").error).toContain("要具体化");
    expect(checkStart(p, id, "codex", "先に試したい").error).toContain("要具体化");
    expect(checkStart(p, id, "human").error).toBe("");
    expect(checkStart(p, id, "human:担当").error).toBe("");
    // 具体化すれば通る
    expect(checkStart(prepare(p, id), id, "codex")).toEqual({ warning: "", error: "" });
  });
  it("自身の出力が無い親: warn では開始でき子を案内、reject では開始しない", () => {
    const { p, parent, child } = parentWithChild();
    const warn = checkStart(p, parent, "codex");
    expect(warn.error).toBe("");
    expect(warn.warning).toContain(p.blocks[child].key ?? child);
    expect(warn.warning).toContain("claim");
    p.workflowPolicy = { startUnprepared: "reject" };
    expect(checkStart(p, parent, "codex").error).toContain("claim");
  });
  it("要具体化と入力待ちは別々に出る", () => {
    const { p, id } = leaf();
    const q = addPort(p, { blockId: id, direction: "in", name: "仕様書" }).project;
    const r = checkStart(q, id, "codex");
    expect(r.warning).toContain("仕様書");
    expect(r.warning).toContain("要具体化");
    // 入力待ちの --reason は入力待ちだけを消し、要具体化は残る
    const r2 = checkStart(q, id, "codex", "モックで進める");
    expect(r2.warning).not.toContain("入力待ち");
    expect(r2.warning).toContain("要具体化");
  });
  it("分岐待ちのボックスは、要具体化より分岐待ちが先に出る", () => {
    const { p } = leaf();
    const parentId = defaultTaskParent(p);
    const r = addBranch(p, { parentId, title: "方式を決める", question: "どれ?", options: ["A", "B"], actor: "human" });
    let q = r.project;
    const a = addBlock(q, { parentId, title: "A で作る", outputName: "成果" });
    q = a.project;
    const pathA = portsOf(q, r.blockId, "out").find((o) => o.branchOption === "A")!;
    const c = connectToBlock(q, { portId: pathA.id, side: "outer" }, a.blockId);
    expect(c.error).toBeUndefined();
    expect(readiness(c.project, a.blockId).state).toBe("branch-waiting");
    // 分岐待ちの警告 (既存) と要具体化の警告の両方が出る
    const w = checkStart(c.project, a.blockId, "codex");
    expect(w.warning).toContain("分岐");
    expect(w.warning).toContain("要具体化");
  });
});

describe("旧版との往復 (確認 8)", () => {
  it("expect / owner / startUnprepared は検証を通り、JSON の往復で消えない", () => {
    const { p, id } = leaf();
    let q = prepare(p, id);
    q = updatePort(q, portsOf(q, id, "out")[0].id, { owner: "self" });
    q.workflowPolicy = { startUnprepared: "reject" };
    const text = toJSON(q);
    const back = validateProjectText(text);
    const out = portsOf(back, id, "out")[0];
    expect(out.expect).toEqual({ kind: "file", hint: "src/x.ts" });
    expect(out.owner).toBe("self");
    expect(back.workflowPolicy?.startUnprepared).toBe("reject");
    // 知らない項目として扱われても残る (passthrough): 別の名前の項目で確かめる
    const withUnknown = JSON.parse(text);
    withUnknown.ports[out.id].futureField = { a: 1 };
    const back2 = fromJSON(toJSON(validateProjectText(JSON.stringify(withUnknown))));
    expect((back2.ports[out.id] as unknown as { futureField?: unknown }).futureField).toEqual({ a: 1 });
  });
});

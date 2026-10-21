/**
 * 結線ルール・自動引き上げ・進捗の単体テスト
 */
import { describe, expect, it } from "vitest";
import {
  newId
, addBlock
, addPort
, ancestorsOf
, answerDecision
, askDecision
, canSuggestWhite
, childrenOf
, computeProgress
, connect
, createArtifact
, createProject
, defaultTaskParent
, disconnect
, effectiveProgress
, extractTemplate
, findBlock
, finishBlock
, fromJSON
, incomingEdges
, instantiateTemplate
, isEdgeReady
, isInputReady
, parseTemplate
, pendingDecisions
, portsOf
, projectBlocks
, removeBlock
, setActivity
, setProgress
, splitBlock
, summarize
, toJSON
, updateBlock
, updatePort
, validateConnection
, daysToDue
, effectiveDescription
, isOverdue
, searchBlocks
, setSchedule
, sourceOfInput
, connectToBlock
, consumersOf
, moveBlock
, moveBlockToParent
, resolveOverlap
, addInputGroup
, exportInputGroup
, importInputGroup
, inputGroupsOf
, removeInputGroup
, resolveAllOverlaps
, rootInputsOf
, setInputGroup
, setCategory
, missingRequiredInputs
, outgoingEdges
, issueKeyOf
, candidatesOf
, reopenDecision
, wireNet
, removePort
, updateDecision
, normalizePortNames
, portNet
, disconnectWire

, sentBackTo
, sendBackTargets
, sendBack
, targetCandidates
, sourceCandidates
, canConnectAcross
, connectAcross
, inputsFedBy
, canRemovePort
, removeDecision

} from "./graph";
import { ROOT_ID, type Project } from "./types";

/** テスト用: プロジェクトのボックスの中に 2 つのブロック A, B を持つプロジェクト (pj = ボックスの id) */
function twoBlocks(): { p: Project; a: string; b: string; pj: string } {
  let p = createProject("test");
  const pj = defaultTaskParent(p);
  const ra = addBlock(p, { parentId: pj, title: "A" });
  p = ra.project;
  const rb = addBlock(p, { parentId: pj, title: "B" });
  p = rb.project;
  return { p, a: ra.blockId, b: rb.blockId, pj };
}

describe("ブロックとポートの生成", () => {
  it("ブロックを追加すると出力ポートが 1 つ付き、状態は black", () => {
    const { p, a } = twoBlocks();
    expect(p.blocks[a].status).toBe("black");
    expect(portsOf(p, a, "out")).toHaveLength(1);
    expect(portsOf(p, a, "in")).toHaveLength(0);
  });

  it("子を追加しても親の状態は New のまま (計画の組み立てで In Progress にしない)", () => {
    const { p, a } = twoBlocks();
    const r = addBlock(p, { parentId: a, title: "A-1" });
    expect(r.project.blocks[a].status).toBe("black");
  });
});

describe("結線ルール", () => {
  it("同じ階層の出力 -> 入力はつながる (sibling)", () => {
    const { p, a, b } = twoBlocks();
    const r = addPort(p, { blockId: b, direction: "in", name: "x" });
    const outA = portsOf(r.project, a, "out")[0];
    const check = validateConnection(r.project, { portId: outA.id, side: "outer" }, { portId: r.portId, side: "outer" });
    expect(check.ok).toBe(true);
    expect(check.kind).toBe("sibling");
  });

  it("入力 -> 入力 (同じ階層の outer どうし) はつながらない", () => {
    const { p, a, b } = twoBlocks();
    const r1 = addPort(p, { blockId: a, direction: "in", name: "x" });
    const r2 = addPort(r1.project, { blockId: b, direction: "in", name: "y" });
    const check = validateConnection(r2.project, { portId: r1.portId, side: "outer" }, { portId: r2.portId, side: "outer" });
    expect(check.ok).toBe(false);
  });

  it("子の出力 -> 親の出力 (inner) はつながる (up)。別の階層へはつながらない", () => {
    const { p, a, b } = twoBlocks();
    const r = addBlock(p, { parentId: a, title: "A-1" });
    const outA1 = portsOf(r.project, r.blockId, "out")[0];
    const outA = portsOf(r.project, a, "out")[0];
    const outB = portsOf(r.project, b, "out")[0];
    expect(validateConnection(r.project, { portId: outA1.id, side: "outer" }, { portId: outA.id, side: "inner" }).kind).toBe("up");
    // A-1 の出力を B の出力 (inner) へ: 階層が違うので不可
    expect(validateConnection(r.project, { portId: outA1.id, side: "outer" }, { portId: outB.id, side: "inner" }).ok).toBe(false);
  });

  it("親の出力 (inner) は複数の入力源を持てる (出力ポートを増やす)", () => {
    const { p, a, b, pj } = twoBlocks();
    const pjOut = portsOf(p, pj, "out")[0];
    const r2 = addPort(p, { blockId: pj, direction: "out", name: "第 2 成果物" });
    const outA = portsOf(r2.project, a, "out")[0];
    const outB = portsOf(r2.project, b, "out")[0];
    const c1 = connect(r2.project, { portId: outA.id, side: "outer" }, { portId: pjOut.id, side: "inner" });
    const c2 = connect(c1.project, { portId: outB.id, side: "outer" }, { portId: r2.portId, side: "inner" });
    expect(c1.error).toBeUndefined();
    expect(c2.error).toBeUndefined();
    // ボックスの中の 2 本 + ボックスの出力から最終成果物への 1 本 + 第 2 成果物の最上位への写し 1 本
    expect(Object.keys(c2.project.edges)).toHaveLength(4);
  });

  it("入力には線が 1 本まで (後からつないだ線で置き換わる)", () => {
    const { p, a, b, pj } = twoBlocks();
    const rc = addBlock(p, { parentId: pj, title: "C" });
    const rp = addPort(rc.project, { blockId: rc.blockId, direction: "in", name: "x" });
    const outA = portsOf(rp.project, a, "out")[0];
    const outB = portsOf(rp.project, b, "out")[0];
    const c1 = connect(rp.project, { portId: outA.id, side: "outer" }, { portId: rp.portId, side: "outer" });
    const c2 = connect(c1.project, { portId: outB.id, side: "outer" }, { portId: rp.portId, side: "outer" });
    const incoming = incomingEdges(c2.project, { portId: rp.portId, side: "outer" });
    expect(incoming).toHaveLength(1);
    expect(incoming[0].from.portId).toBe(outB.id);
  });

  it("循環 (A -> B -> A) は禁止", () => {
    const { p, a, b } = twoBlocks();
    const ra = addPort(p, { blockId: a, direction: "in", name: "ia" });
    const rb = addPort(ra.project, { blockId: b, direction: "in", name: "ib" });
    const outA = portsOf(rb.project, a, "out")[0];
    const outB = portsOf(rb.project, b, "out")[0];
    const c1 = connect(rb.project, { portId: outA.id, side: "outer" }, { portId: rb.portId, side: "outer" });
    expect(c1.error).toBeUndefined();
    const c2 = connect(c1.project, { portId: outB.id, side: "outer" }, { portId: ra.portId, side: "outer" });
    expect(c2.error).toMatch(/循環/);
  });
});

describe("浮いている入力の自動引き上げ", () => {
  it("未接続の入力は、プロジェクトのボックスを経由して最上位の入力ノードに自動ポートと自動線で伸びる", () => {
    const { p, a, pj } = twoBlocks();
    const r = addPort(p, { blockId: a, direction: "in", name: "仕様書" });
    const pjIns = portsOf(r.project, pj, "in");
    const rootIns = portsOf(r.project, ROOT_ID, "in");
    expect(pjIns).toHaveLength(1);
    expect(pjIns[0].promotedFrom).toBe(r.portId);
    expect(rootIns).toHaveLength(1);
    expect(rootIns[0].promotedFrom).toBe(pjIns[0].id);
    expect(rootIns[0].name).toBe("仕様書");
    const edge = incomingEdges(r.project, { portId: r.portId, side: "outer" })[0];
    expect(edge.auto).toBe(true);
    expect(edge.from).toEqual({ portId: pjIns[0].id, side: "inner" });
  });

  it("2 階層下の未接続の入力は、親を経由して最上位まで伸びる", () => {
    const { p, a } = twoBlocks();
    const r1 = addBlock(p, { parentId: a, title: "A-1" });
    const r2 = addPort(r1.project, { blockId: r1.blockId, direction: "in", name: "素材" });
    const q = r2.project;
    const aIns = portsOf(q, a, "in");
    const pjIns = portsOf(q, defaultTaskParent(q), "in");
    const rootIns = portsOf(q, ROOT_ID, "in");
    expect(aIns).toHaveLength(1);
    expect(aIns[0].promotedFrom).toBe(r2.portId);
    expect(pjIns).toHaveLength(1);
    expect(pjIns[0].promotedFrom).toBe(aIns[0].id);
    expect(rootIns).toHaveLength(1);
    expect(rootIns[0].promotedFrom).toBe(pjIns[0].id);
  });

  it("手動でつなぐと自動線と自動ポートは消える", () => {
    const { p, a, b } = twoBlocks();
    const r = addPort(p, { blockId: b, direction: "in", name: "x" });
    expect(portsOf(r.project, ROOT_ID, "in")).toHaveLength(1);
    const outA = portsOf(r.project, a, "out")[0];
    const c = connect(r.project, { portId: outA.id, side: "outer" }, { portId: r.portId, side: "outer" });
    expect(c.error).toBeUndefined();
    expect(portsOf(c.project, ROOT_ID, "in")).toHaveLength(0);
    expect(Object.values(c.project.edges).filter((e) => e.auto)).toHaveLength(0);
  });

  it("手動の線を外すと、また自動で最上位まで伸びる", () => {
    const { p, a, b } = twoBlocks();
    const r = addPort(p, { blockId: b, direction: "in", name: "x" });
    const outA = portsOf(r.project, a, "out")[0];
    const c = connect(r.project, { portId: outA.id, side: "outer" }, { portId: r.portId, side: "outer" });
    const d = disconnect(c.project, c.edgeId!);
    expect(portsOf(d, ROOT_ID, "in")).toHaveLength(1);
  });

  it("途中の階層で変換ブロックにつなぎ直すと、その先の自動ポートだけ残り元の線は置き換わる", () => {
    // A の中に A-1 (入力 raw) と A-2 (変換) を置き、A-1.raw を A-2 の出力につなぐ
    const { p, a } = twoBlocks();
    const r1 = addBlock(p, { parentId: a, title: "A-1" });
    const r2 = addPort(r1.project, { blockId: r1.blockId, direction: "in", name: "raw" });
    const r3 = addBlock(r2.project, { parentId: a, title: "A-2 変換" });
    const outA2 = portsOf(r3.project, r3.blockId, "out")[0];
    const c = connect(r3.project, { portId: outA2.id, side: "outer" }, { portId: r2.portId, side: "outer" });
    expect(c.error).toBeUndefined();
    // A-1.raw は A-2 からの手動線に置き換わり、A と最上位の自動ポート raw は消える
    expect(portsOf(c.project, a, "in").filter((x) => x.promotedFrom)).toHaveLength(0);
    expect(portsOf(c.project, ROOT_ID, "in")).toHaveLength(0);
  });

  it("同じ名前の未接続の入力が複数あっても、最上位の自動ポートは 1 つにまとまる", () => {
    const { p, a, b } = twoBlocks();
    const r1 = addPort(p, { blockId: a, direction: "in", name: "仕様書" });
    const r2 = addPort(r1.project, { blockId: b, direction: "in", name: "仕様書" });
    const rootIns = portsOf(r2.project, ROOT_ID, "in");
    expect(rootIns).toHaveLength(1);
    // ボックス -> A, ボックス -> B, 最上位 -> ボックス の 3 本
    expect(Object.values(r2.project.edges).filter((e) => e.auto)).toHaveLength(3);
    // 片方を手動でつなぐと、自動ポートはもう片方のために残る
    const outA = portsOf(r2.project, a, "out")[0];
    const c = connect(r2.project, { portId: outA.id, side: "outer" }, { portId: r2.portId, side: "outer" });
    expect(portsOf(c.project, ROOT_ID, "in")).toHaveLength(1);
    expect(Object.values(c.project.edges).filter((e) => e.auto)).toHaveLength(2);
  });

  it("ブロックを消すと、その入力のために作られた自動ポートも消える", () => {
    const { p, a } = twoBlocks();
    const r = addPort(p, { blockId: a, direction: "in", name: "x" });
    const q = removeBlock(r.project, a);
    expect(portsOf(q, ROOT_ID, "in")).toHaveLength(0);
    expect(q.blocks[a]).toBeUndefined();
  });
});

describe("進捗と完了の提案", () => {
  it("子孫の white の割合が進捗になる", () => {
    const { p, a } = twoBlocks();
    const r1 = addBlock(p, { parentId: a, title: "A-1" });
    const r2 = addBlock(r1.project, { parentId: a, title: "A-2" });
    const q = updateBlock(r2.project, r1.blockId, { status: "white" });
    const prog = computeProgress(q, a);
    expect(prog.total).toBe(2);
    expect(prog.white).toBe(1);
    expect(prog.ratio).toBe(0.5);
  });

  it("子が全部 white で出力に成果物が付いたら完了を提案する", () => {
    const { p, a } = twoBlocks();
    const r1 = addBlock(p, { parentId: a, title: "A-1" });
    let q = updateBlock(r1.project, r1.blockId, { status: "white" });
    expect(canSuggestWhite(q, a)).toBe(false);
    const outA = portsOf(q, a, "out")[0];
    q = updatePort(q, outA.id, { artifacts: [createArtifact("設計書", "https://example.com/doc")] });
    expect(canSuggestWhite(q, a)).toBe(true);
  });
});

describe("JSON の読み書き", () => {
  it("書き出して読み戻すと同じ内容になる", () => {
    const { p, a } = twoBlocks();
    const r = addPort(p, { blockId: a, direction: "in", name: "x" });
    const text = toJSON(r.project);
    const q = fromJSON(text);
    expect(Object.keys(q.blocks).sort()).toEqual(Object.keys(r.project.blocks).sort());
    expect(Object.keys(q.ports).sort()).toEqual(Object.keys(r.project.ports).sort());
    expect(Object.keys(q.edges).sort()).toEqual(Object.keys(r.project.edges).sort());
  });

  it("版が違う・形式が違う JSON は日本語のエラーになる", () => {
    expect(() => fromJSON("{")).toThrow(/JSON/);
    expect(() => fromJSON('{"schemaVersion": 99}')).toThrow(/版/);
    expect(() => fromJSON('{"schemaVersion": 1}')).toThrow(/足りません/);
  });
});

describe("AI の活動・判断・分解 (schemaVersion 2)", () => {
  it("start で作業中になり black は gray に上がる。done で white になり成果物が付く", () => {
    const { p, a } = twoBlocks();
    let q = setActivity(p, a, "claude-code", "working", "実装中");
    expect(q.blocks[a].activity?.state).toBe("working");
    expect(q.blocks[a].status).toBe("gray");
    expect(q.log.at(-1)?.kind).toBe("started");
    const r = finishBlock(q, a, "claude-code", { artifacts: [{ title: "PR #1", url: "https://example.com/pr/1" }] });
    q = r.project;
    expect(r.error).toBeUndefined();
    expect(q.blocks[a].status).toBe("white");
    expect(q.blocks[a].activity).toBeNull();
    expect(portsOf(q, a, "out")[0].artifacts[0].title).toBe("PR #1");
    expect(summarize(q).white).toBe(1);
  });

  it("ask で判断待ちになり answer で消える", () => {
    const { p, a } = twoBlocks();
    const r = askDecision(p, a, "codex", "どちらにしますか?", ["A", "B"]);
    expect(r.project.blocks[a].activity?.state).toBe("needs_decision");
    expect(pendingDecisions(r.project)).toHaveLength(1);
    const q = answerDecision(r.project, a, r.decisionId!, "A", "human:hash");
    expect(q.blocks[a].activity).toBeNull();
    expect(pendingDecisions(q)).toHaveLength(0);
    expect(q.blocks[a].decisions[0].answer).toBe("A");
  });

  it("split で子ブロックを足し、名前で結線できる (親の入出力は parent.<名前>)", () => {
    const { p, a } = twoBlocks();
    const withIn = addPort(p, { blockId: a, direction: "in", name: "仕様" }).project;
    const r = splitBlock(withIn, a, {
      blocks: [
        { title: "設計", inputs: ["仕様"], outputs: ["設計書"] }
      , { title: "実装", inputs: ["設計書"], outputs: ["コード"] }
      ]
    , connections: [
        { from: "parent.仕様", to: "設計.仕様" }
      , { from: "設計.設計書", to: "実装.設計書" }
      , { from: "実装.コード", to: "parent.出力" }
      ]
    }, "codex");
    expect(r.errors).toEqual([]);
    expect(childrenOf(r.project, a)).toHaveLength(2);
    // 分解でできた 3 本 + プロジェクトのボックスから最終成果物への 1 本
    expect(Object.values(r.project.edges).filter((e) => !e.auto)).toHaveLength(4);
    expect(r.project.blocks[a].status).toBe("black"); // 分解しても New のまま
  });

  it("findBlock は id・完全一致・一意な部分一致で探す", () => {
    const { p, a } = twoBlocks();
    expect(findBlock(p, a).block?.id).toBe(a);
    expect(findBlock(p, "A").block?.id).toBe(a);
    expect(findBlock(p, "Z").block).toBeNull();
  });

  it("版 1 の JSON を読むと活動・判断・ログの項目が補われる", () => {
    const { p } = twoBlocks();
    const v1 = JSON.parse(toJSON(p));
    v1.schemaVersion = 1;
    delete v1.log;
    delete v1.agents;
    for (const b of Object.values(v1.blocks) as { activity?: unknown; decisions?: unknown }[]) { delete b.activity; delete b.decisions; }
    const q = fromJSON(JSON.stringify(v1));
    expect(q.schemaVersion).toBe(5);
    expect(q.log).toEqual([]);
    expect(Object.values(q.blocks).every((b) => b.activity === null && Array.isArray(b.decisions))).toBe(true);
  });
});

describe("自動整列", () => {
  it("依存関係の順に左から右へ、同じ層は重ならずに縦に並ぶ", async () => {
    const { layoutAll } = await import("./autolayout");
    const { blockSize } = await import("./size");
    const { p, a, b } = twoBlocks();
    const rc = addBlock(p, { parentId: ROOT_ID, title: "C" });
    const rp = addPort(rc.project, { blockId: rc.blockId, direction: "in", name: "x" });
    const outA = portsOf(rp.project, a, "out")[0];
    const c = connect(rp.project, { portId: outA.id, side: "outer" }, { portId: rp.portId, side: "outer" }).project;
    const q = layoutAll(c);
    // A -> C なので C は A より右。A と B は同じ層で縦に並び、重ならない
    expect(q.blocks[rc.blockId].position.x).toBeGreaterThan(q.blocks[a].position.x);
    expect(q.blocks[a].position.x).toBe(q.blocks[b].position.x);
    const [top, bottom] = [q.blocks[a], q.blocks[b]].sort((x, y) => x.position.y - y.position.y);
    expect(bottom.position.y).toBeGreaterThanOrEqual(top.position.y + blockSize(q, top.id).height);
  });
});

describe("プロジェクトのボックス・深い階層・テンプレート (schemaVersion 3)", () => {
  it("createProject は最上位にプロジェクトのボックスを 1 つ置き、その出力が最終成果物につながる", () => {
    const p = createProject("X");
    const pj = projectBlocks(p);
    expect(pj).toHaveLength(1);
    expect(pj[0].kind).toBe("project");
    const out = portsOf(p, pj[0].id, "out")[0];
    const rootOut = portsOf(p, ROOT_ID, "out")[0];
    expect(Object.values(p.edges).some((e) => e.from.portId === out.id && e.to.portId === rootOut.id && e.kind === "up")).toBe(true);
    expect(defaultTaskParent(p)).toBe(pj[0].id);
  });

  it("4 階層の分解ができ、一番下の未接続の入力が最上位まで上がる", () => {
    let p = createProject("deep");
    let parent = defaultTaskParent(p);
    const ids: string[] = [];
    for (let d = 0; d < 4; d++) {
      const r = addBlock(p, { parentId: parent, title: `L${d}` });
      p = r.project;
      ids.push(r.blockId);
      parent = r.blockId;
    }
    const r = addPort(p, { blockId: ids[3], direction: "in", name: "素材" });
    p = r.project;
    expect(ancestorsOf(p, ids[3])).toHaveLength(5); // L2, L1, L0, プロジェクトのボックス, root
    expect(portsOf(p, ROOT_ID, "in").some((x) => x.name === "素材" && x.promotedFrom)).toBe(true);
    // 各階層に自動ポートが 1 つずつ
    for (const id of [ids[2], ids[1], ids[0], defaultTaskParent(p)]) expect(portsOf(p, id, "in").filter((x) => x.promotedFrom)).toHaveLength(1);
  });

  it("版 2 のデータ (最上位に直接タスク) は読み込み時にプロジェクトのボックスで包まれる", () => {
    let p0 = createProject("old");
    const ra = addBlock(p0, { parentId: ROOT_ID, title: "A" });
    p0 = ra.project;
    const rb = addBlock(p0, { parentId: ROOT_ID, title: "B" });
    p0 = rb.project;
    const p = p0;
    const a = ra.blockId;
    const b = rb.blockId;
    const rp = addPort(p, { blockId: b, direction: "in", name: "x" });
    const outA = portsOf(rp.project, a, "out")[0];
    const c = connect(rp.project, { portId: outA.id, side: "outer" }, { portId: rp.portId, side: "outer" }).project;
    const outB = portsOf(c, b, "out")[0];
    const rootOut = portsOf(c, ROOT_ID, "out")[0];
    const d = connect(c, { portId: outB.id, side: "outer" }, { portId: rootOut.id, side: "inner" }).project;
    const v2 = JSON.parse(toJSON(d));
    v2.schemaVersion = 2;
    // createProject が作ったプロジェクトのボックスは、版 2 のデータには無かったものとして消す
    for (const blk of Object.values(v2.blocks) as { id: string; kind?: string }[]) if (blk.kind === "project") { delete v2.blocks[blk.id]; }
    const q = fromJSON(JSON.stringify(v2));
    const pj = projectBlocks(q);
    expect(pj).toHaveLength(1);
    expect(q.blocks[a].parentId).toBe(pj[0].id);
    expect(q.blocks[b].parentId).toBe(pj[0].id);
    // A -> B の線は残り、B -> 最終成果物 はボックスの出力を経由する
    expect(Object.values(q.edges).some((e) => e.kind === "sibling" && q.ports[e.from.portId].blockId === a)).toBe(true);
    const mid = portsOf(q, pj[0].id, "out").find((o) => o.name === rootOut.name);
    expect(mid).toBeDefined();
    expect(Object.values(q.edges).some((e) => e.to.portId === mid!.id && q.ports[e.from.portId].blockId === b)).toBe(true);
    expect(Object.values(q.edges).some((e) => e.from.portId === mid!.id && e.to.portId === rootOut.id)).toBe(true);
  });

  it("テンプレートに取り出して別のプロジェクトに挿入すると、同じ構造 (子・入出力・結線) が新しい id で作られる", () => {
    let p = createProject("A");
    const pj = defaultTaskParent(p);
    const r = addBlock(p, { parentId: pj, title: "入力画像のモノクロ化" });
    p = r.project;
    p = addPort(p, { blockId: r.blockId, direction: "in", name: "カラー画像" }).project;
    p = updatePort(p, portsOf(p, r.blockId, "out")[0].id, { name: "モノクロ画像", description: "8bit グレースケール" });
    p = splitBlock(p, r.blockId, {
      blocks: [{ title: "読み込み", inputs: ["カラー画像"], outputs: ["画素配列"] }, { title: "変換", inputs: ["画素配列"], outputs: ["モノクロ画像"] }]
    , connections: [{ from: "parent.カラー画像", to: "読み込み.カラー画像" }, { from: "読み込み.画素配列", to: "変換.画素配列" }, { from: "変換.モノクロ画像", to: "parent.モノクロ画像" }]
    }, "human").project;
    const tpl = extractTemplate(p, r.blockId, { tags: ["画像処理"] });
    expect(tpl.root.children).toHaveLength(2);
    expect(tpl.root.connections).toHaveLength(3);
    const text = JSON.stringify(tpl);
    let q = createProject("B");
    const ins = instantiateTemplate(q, defaultTaskParent(q), parseTemplate(text), "human");
    q = ins.project;
    const nb = q.blocks[ins.blockId];
    expect(nb.title).toBe("入力画像のモノクロ化");
    expect(nb.template?.name).toBe("入力画像のモノクロ化");
    expect(childrenOf(q, ins.blockId)).toHaveLength(2);
    expect(portsOf(q, ins.blockId, "out")[0].description).toBe("8bit グレースケール");
    expect(Object.values(q.edges).filter((e) => !e.auto).length).toBeGreaterThanOrEqual(3 + 1);
    expect(nb.status).toBe("black"); // 挿入した部品は New のまま
    expect(nb.id).not.toBe(r.blockId);
  });
});

describe("用意できた線・進捗 %", () => {
  it("供給元の出力に成果物が付くか WhiteBox になると、線は「用意できた」になる", () => {
    const { p, a, b } = twoBlocks();
    const rp = addPort(p, { blockId: b, direction: "in", name: "x" });
    const outA = portsOf(rp.project, a, "out")[0];
    const c = connect(rp.project, { portId: outA.id, side: "outer" }, { portId: rp.portId, side: "outer" });
    const edge = incomingEdges(c.project, { portId: rp.portId, side: "outer" })[0];
    expect(isEdgeReady(c.project, edge)).toBe(false);
    expect(isInputReady(c.project, rp.portId)).toBe(false);
    const q = updatePort(c.project, outA.id, { artifacts: [createArtifact("成果", "https://example.com")] });
    expect(isEdgeReady(q, edge)).toBe(true);
    expect(isInputReady(q, rp.portId)).toBe(true);
    const w = updateBlock(c.project, a, { status: "white" });
    expect(isEdgeReady(w, edge)).toBe(true);
  });

  it("親の入力から下りる線は、親の入力の供給元までさかのぼって判定する", () => {
    const { p, a, pj } = twoBlocks();
    const r = addPort(p, { blockId: a, direction: "in", name: "仕様" });
    // 自動で pj.仕様 (inner) -> a.仕様 と root.仕様 (inner) -> pj.仕様 ができる。最上位の入力に入力物を付けると全部用意できる
    const rootIn = portsOf(r.project, ROOT_ID, "in")[0];
    const edge = incomingEdges(r.project, { portId: r.portId, side: "outer" })[0];
    expect(isEdgeReady(r.project, edge)).toBe(false);
    const q = updatePort(r.project, rootIn.id, { artifacts: [createArtifact("仕様書 v1", "https://example.com/spec")] });
    expect(isEdgeReady(q, edge)).toBe(true);
    expect(isInputReady(q, portsOf(q, pj, "in")[0].id)).toBe(true);
  });

  it("進捗 % は手入力 > WhiteBox=100 > 子の平均 の順で決まる", () => {
    const { p, a, b, pj } = twoBlocks();
    expect(effectiveProgress(p, pj)).toBe(0);
    let q = setProgress(p, a, 50, "human");
    expect(q.blocks[a].status).toBe("gray");
    expect(effectiveProgress(q, pj)).toBe(25);
    q = updateBlock(q, b, { status: "white" });
    expect(effectiveProgress(q, pj)).toBe(75);
    expect(computeProgress(q, ROOT_ID).percent).toBe(75);
    q = setProgress(q, pj, 90, "human");
    expect(effectiveProgress(q, pj)).toBe(90);
    q = setProgress(q, pj, null, "human");
    expect(effectiveProgress(q, pj)).toBe(75);
  });
});

describe("短い ID・期日・入力の供給元 (一重管理)", () => {
  it("ボックスには B1, B2 ... の短い ID が付き、ID でも探せる。古いデータにも補われる", () => {
    const { p, a, b } = twoBlocks();
    expect(p.blocks[a].key).toBe("B2"); // B1 はプロジェクトのボックス
    expect(p.blocks[b].key).toBe("B3");
    expect(findBlock(p, "b3").block?.id).toBe(b);
    expect(searchBlocks(p, "B2")[0].id).toBe(a);
    const v = JSON.parse(toJSON(p));
    for (const blk of Object.values(v.blocks) as { key?: string }[]) delete blk.key;
    delete v.nextKey;
    const q = fromJSON(JSON.stringify(v));
    const keys = Object.values(q.blocks).filter((x) => x.id !== ROOT_ID).map((x) => x.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k) => /^B\d+$/.test(k ?? ""))).toBe(true);
  });

  it("期日・開始日・時間を設定でき、期日超過が分かる", () => {
    const { p, a } = twoBlocks();
    const q = setSchedule(p, a, { startDate: "2026-10-01", dueDate: "2026-10-02", actualHours: 3.5, estimateHours: 8 }, "human");
    expect(q.blocks[a].dueDate).toBe("2026-10-02");
    expect(q.blocks[a].actualHours).toBe(3.5);
    expect(isOverdue(q.blocks[a], new Date("2026-10-03T10:00:00"))).toBe(true);
    expect(isOverdue(q.blocks[a], new Date("2026-10-02T10:00:00"))).toBe(false);
    expect(daysToDue(q.blocks[a], new Date("2026-10-01T10:00:00"))).toBe(1);
    expect(summarize(q).overdue.length).toBe(isOverdue(q.blocks[a]) ? 1 : 0);
    const r = setSchedule(q, a, { dueDate: null }, "human");
    expect(r.blocks[a].dueDate).toBeUndefined();
  });

  it("つながった入力の説明は供給元の出力の説明を使う (親を経由しても)", () => {
    const { p, a, b, pj } = twoBlocks();
    const rp = addPort(p, { blockId: b, direction: "in", name: "x" });
    const outA = portsOf(rp.project, a, "out")[0];
    let q = updatePort(rp.project, outA.id, { description: "A が作る設計書" });
    q = connect(q, { portId: outA.id, side: "outer" }, { portId: rp.portId, side: "outer" }).project;
    expect(sourceOfInput(q, rp.portId)?.id).toBe(outA.id);
    expect(effectiveDescription(q, rp.portId)).toBe("A が作る設計書");
    // 親 (プロジェクトのボックス) の入力から下りてくる場合は、さらにその供給元 (最上位の入力) まで
    const r2 = addPort(q, { blockId: a, direction: "in", name: "仕様" });
    q = r2.project;
    const rootIn = portsOf(q, ROOT_ID, "in")[0];
    q = updatePort(q, rootIn.id, { description: "顧客から受け取る仕様書" });
    expect(sourceOfInput(q, r2.portId)?.id).toBe(rootIn.id);
    expect(effectiveDescription(q, r2.portId)).toBe("顧客から受け取る仕様書");
    expect(portsOf(q, pj, "in").length).toBe(1);
  });
});

describe("1 つの出力から複数の入力へ", () => {
  it("同じ出力を 3 つのボックスの入力につなげる (枝分かれ)。入力側は 1 本まで", () => {
    const { p, a, pj } = twoBlocks();
    let q = p;
    const targets: string[] = [];
    for (const title of ["X", "Y", "Z"]) {
      const r = addBlock(q, { parentId: pj, title });
      q = r.project;
      const rp = addPort(q, { blockId: r.blockId, direction: "in", name: "設計書" });
      q = rp.project;
      targets.push(rp.portId);
    }
    const outA = portsOf(q, a, "out")[0];
    for (const t of targets) {
      const c = connect(q, { portId: outA.id, side: "outer" }, { portId: t, side: "outer" });
      expect(c.error).toBeUndefined();
      q = c.project;
    }
    const fanOut = Object.values(q.edges).filter((e) => e.from.portId === outA.id && !e.auto);
    expect(fanOut).toHaveLength(3);
    for (const t of targets) expect(incomingEdges(q, { portId: t, side: "outer" })).toHaveLength(1);
  });
});

describe("ドラッグ操作の補助", () => {
  it("ボックスを別のボックスの中へ移すと、位置は見出しの下に収まり、親は分解中になる", () => {
    const { p, a, b, pj } = twoBlocks();
    const rp = addPort(p, { blockId: b, direction: "in", name: "x" });
    const outA = portsOf(rp.project, a, "out")[0];
    let q = connect(rp.project, { portId: outA.id, side: "outer" }, { portId: rp.portId, side: "outer" }).project;
    const rc = addBlock(q, { parentId: pj, title: "C" });
    q = rc.project;
    q = moveBlockToParent(q, b, rc.blockId, { x: 10, y: 10 });
    expect(q.blocks[b].parentId).toBe(rc.blockId);
    expect(q.blocks[b].position.x).toBeGreaterThanOrEqual(48);
    expect(q.blocks[b].position.y).toBeGreaterThanOrEqual(76);
    // A -> B の線は C の入力を経由して残る
    expect(Object.values(q.edges).some((e) => !e.auto && e.from.portId === outA.id)).toBe(true);
    expect(q.blocks[rc.blockId].status).toBe("black"); // 移し先の親も New のまま
  });

  it("出力をボックスに落とすと、空いている入力か新しい入力につながる。親に落とすと親の出力につながる", () => {
    const { p, a, b, pj } = twoBlocks();
    const outA = portsOf(p, a, "out")[0];
    const r1 = connectToBlock(p, { portId: outA.id, side: "outer" }, b);
    expect(r1.error).toBeUndefined();
    const inB = portsOf(r1.project, b, "in");
    expect(inB).toHaveLength(1);
    expect(inB[0].name).toBe(outA.name);
    expect(incomingEdges(r1.project, { portId: inB[0].id, side: "outer" })[0].from.portId).toBe(outA.id);
    // 親 (プロジェクトのボックス) に落とす -> 親の出力 (inner) へ
    const outB = portsOf(r1.project, b, "out")[0];
    const r2 = connectToBlock(r1.project, { portId: outB.id, side: "outer" }, pj);
    expect(r2.error).toBeUndefined();
    const pjOut = portsOf(r2.project, pj, "out")[0];
    expect(Object.values(r2.project.edges).some((e) => e.from.portId === outB.id && e.to.portId === pjOut.id && e.to.side === "inner")).toBe(true);
  });
});

describe("階層移動の線の付け替えと重なりの解消", () => {
  it("ボックスを別のボックスの中へ移すと、兄弟との線は新しい親の入出力を経由して残る", () => {
    const { p, a, b, pj } = twoBlocks();
    // A.出力 -> B.x、 B.出力 -> D.y
    let q = addPort(p, { blockId: b, direction: "in", name: "x" }).project;
    const inB = portsOf(q, b, "in")[0];
    const outA = portsOf(q, a, "out")[0];
    q = connect(q, { portId: outA.id, side: "outer" }, { portId: inB.id, side: "outer" }).project;
    const rd = addBlock(q, { parentId: pj, title: "D" });
    q = rd.project;
    q = addPort(q, { blockId: rd.blockId, direction: "in", name: "y" }).project;
    const inD = portsOf(q, rd.blockId, "in")[0];
    const outB = portsOf(q, b, "out")[0];
    q = connect(q, { portId: outB.id, side: "outer" }, { portId: inD.id, side: "outer" }).project;
    const rc = addBlock(q, { parentId: pj, title: "C" });
    q = rc.project;
    q = moveBlockToParent(q, b, rc.blockId, { x: 10, y: 10 });
    // 線でつながる入出力は同じ名前 (A の出力は既定の仮の名前「出力」だったので、つないだ時点で入力の名前 x になっている)。その名前で探す
    const xName = q.ports[inB.id].name;
    expect(xName).toBe(q.ports[outA.id].name);
    expect(xName).toBe("x");
    const cIn = portsOf(q, rc.blockId, "in").find((x) => x.name === xName && !x.promotedFrom);
    const cOut = portsOf(q, rc.blockId, "out").find((x) => x.name === q.ports[outB.id].name);
    expect(cIn).toBeDefined();
    expect(cOut).toBeDefined();
    const edges = Object.values(q.edges).filter((e) => !e.auto);
    expect(edges.some((e) => e.from.portId === outA.id && e.to.portId === cIn!.id)).toBe(true);
    expect(edges.some((e) => e.from.portId === cIn!.id && e.from.side === "inner" && e.to.portId === inB.id)).toBe(true);
    expect(edges.some((e) => e.from.portId === outB.id && e.to.portId === cOut!.id && e.to.side === "inner")).toBe(true);
    expect(edges.some((e) => e.from.portId === cOut!.id && e.from.side === "outer" && e.to.portId === inD.id)).toBe(true);
    // 入力が供給されているので、最上位の自動ポートは増えない
    expect(portsOf(q, ROOT_ID, "in")).toHaveLength(0);
  });

  it("1 つ目のボックスが広がったとき、間のボックスと右のボックスが順に (玉突きで) 押し出されて重ならない", () => {
    // 横一列 A B C。A が広がって B と重なり、B を右へ押すと C とも重なる (B を全部の兄弟から避けさせると右 ↔ 左の往復になる)
    const p0 = createProject("t");
    const pj = defaultTaskParent(p0);
    const a = addBlock(p0, { parentId: pj, title: "A", position: { x: 120, y: 124 } });
    const b = addBlock(a.project, { parentId: pj, title: "B", position: { x: 504, y: 124 } });
    const c = addBlock(b.project, { parentId: pj, title: "C", position: { x: 888, y: 124 } });
    const q = c.project;
    const size = (pp: Project, id: string) => ({ width: pp.blocks[id].title === "A" ? 440 : 240, height: 98 }); // A だけ広い
    const r = resolveAllOverlaps(q, size);
    const rect = (id: string) => ({ ...r.blocks[id].position, ...size(r, id) });
    const ids = [a.blockId, b.blockId, c.blockId];
    for (const i of ids) for (const j of ids) {
      if (i >= j) continue;
      const u = rect(i), v = rect(j);
      const overlap = u.x < v.x + v.width && u.x + u.width > v.x && u.y < v.y + v.height && u.y + u.height > v.y;
      expect(overlap).toBe(false);
    }
    // 同じ列に並んだまま (下の段へ逃げていない)
    expect(r.blocks[b.blockId].position.y).toBe(124);
    expect(r.blocks[c.blockId].position.y).toBe(124);
  });

  it("縦に詰まった列 (隣どうしが重なる) は、どのボックスも重ならない位置まで順に押し下げられる", () => {
    // 高さ 98 のボックスを 60px 刻みで 6 つ並べる (全部が隣と重なる)。往復せずに全部ばらけること
    let p = createProject("t");
    const pj = defaultTaskParent(p);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = addBlock(p, { parentId: pj, title: `K${i}`, position: { x: 120, y: 76 + i * 60 } });
      p = r.project;
      ids.push(r.blockId);
    }
    const size = (pp: Project, id: string) => ({ width: pp.blocks[id].title === "K1" ? 460 : 300, height: pp.blocks[id].title === "K2" ? 116 : 98 });
    const r = resolveAllOverlaps(p, size);
    const rect = (id: string) => ({ ...r.blocks[id].position, ...size(r, id) });
    for (const i of ids) for (const j of ids) {
      if (i >= j) continue;
      const u = rect(i), v = rect(j);
      const overlap = u.x < v.x + v.width && u.x + u.width > v.x && u.y < v.y + v.height && u.y + u.height > v.y;
      expect(overlap).toBe(false);
    }
    // 同じ位置に積み重なっていない
    expect(new Set(ids.map((id) => `${r.blocks[id].position.x},${r.blocks[id].position.y}`)).size).toBe(ids.length);
  });

  it("重なった兄弟から最小の移動で押し出される", () => {
    const { p, a, b } = twoBlocks();
    let q = moveBlock(p, a, { x: 100, y: 200 });
    q = moveBlock(q, b, { x: 110, y: 210 });
    const size = () => ({ width: 240, height: 80 });
    const r = resolveOverlap(q, b, size);
    const A = r.blocks[a].position;
    const B = r.blocks[b].position;
    const overlap = B.x < A.x + 240 && B.x + 240 > A.x && B.y < A.y + 80 && B.y + 80 > A.y;
    expect(overlap).toBe(false);
  });
});

describe("最上位の入力のグループ", () => {
  it("グループを作って入力を入れ、JSON で書き出して別のプロジェクトに読み込める", () => {
    let p = createProject("A");
    const r = addInputGroup(p, "PCIe 仕様書");
    p = r.project;
    const a = addPort(p, { blockId: ROOT_ID, direction: "in", name: "PCIe Base 6.0" });
    p = updatePort(a.project, a.portId, { description: "PCI-SIG の基本仕様" });
    p = setInputGroup(p, a.portId, r.groupId);
    expect(rootInputsOf(p, r.groupId)).toHaveLength(1);
    expect(rootInputsOf(p, null)).toHaveLength(0);
    const text = exportInputGroup(p, r.groupId);
    let q = createProject("B");
    const im = importInputGroup(q, text);
    q = im.project;
    expect(inputGroupsOf(q)[0].name).toBe("PCIe 仕様書");
    expect(rootInputsOf(q, im.groupId)[0].description).toBe("PCI-SIG の基本仕様");
    // グループを消すと入力は既定へ戻る
    const z = removeInputGroup(q, im.groupId);
    expect(rootInputsOf(z, null)).toHaveLength(1);
  });

  it("すべての階層の重なりを押し出す", () => {
    const { p, a, b } = twoBlocks();
    // 内側の余白 (CHILD_PADDING.left = 120) より内側に置く
    let q = moveBlock(p, a, { x: 160, y: 200 });
    q = moveBlock(q, b, { x: 180, y: 220 });
    const size = () => ({ width: 240, height: 80 });
    const r = resolveAllOverlaps(q, size);
    const A = r.blocks[a].position;
    const B = r.blocks[b].position;
    const overlap = B.x < A.x + 240 && B.x + 240 > A.x && B.y < A.y + 80 && B.y + 80 > A.y;
    expect(overlap).toBe(false);
    expect(A).toEqual({ x: 160, y: 200 }); // 先にあるボックスは動かさない
  });
});

describe("カテゴリ", () => {
  it("設定・解除でき、知らないキーは拒否する", () => {
    const { p, a } = twoBlocks();
    const q = setCategory(p, a, "design");
    expect(q.blocks[a].category).toBe("design");
    expect(setCategory(q, a, null).blocks[a].category).toBeUndefined();
    expect(() => setCategory(q, a, "nope")).toThrow();
  });
  it("テンプレートの書き出し・挿入で保たれ、カテゴリ名でも検索できる", () => {
    const { p, a } = twoBlocks();
    const q = setCategory(p, a, "verify");
    const tpl = extractTemplate(q, a);
    expect(tpl.root.category).toBe("verify");
    const r = instantiateTemplate(q, q.blocks[a].parentId!, parseTemplate(JSON.stringify(tpl)), "test");
    expect(r.project.blocks[r.blockId].category).toBe("verify");
    expect(searchBlocks(r.project, "検証").map((b) => b.id)).toContain(a);
    expect(searchBlocks(r.project, "verify").map((b) => b.id)).toContain(r.blockId);
  });
});

describe("必須の入力", () => {
  it("必須の入力が未確定なら着手できない。任意にすると着手できる", () => {
    const { p: p0, b } = twoBlocks();
    const added = addPort(p0, { blockId: b, direction: "in", name: "資料" }); // 未接続の入力 (既定は必須)
    const p = added.project;
    expect(p.ports[added.portId].required).toBe(true);
    expect(missingRequiredInputs(p, b).map((q) => q.id)).toEqual([added.portId]);
    const q = updatePort(p, added.portId, { required: false });
    expect(missingRequiredInputs(q, b)).toHaveLength(0);
  });
});

describe("階層をまたぐ移動で線を保つ", () => {
  /** 親 P の中に S と X と T。wires で指定した線だけ引く (両方引いて X を外へ出すと P と X が循環するため、テストでは片方ずつ) */
  function nested(wires: { sx: boolean; xt: boolean } = { sx: true, xt: true }) {
    let p = createProject("test");
    const pj = defaultTaskParent(p);
    const rp = addBlock(p, { parentId: pj, title: "P" }); p = rp.project;
    const rs = addBlock(p, { parentId: rp.blockId, title: "S", outputName: "設計書" }); p = rs.project;
    const rx = addBlock(p, { parentId: rp.blockId, title: "X", outputName: "部品" }); p = rx.project;
    const rt = addBlock(p, { parentId: rp.blockId, title: "T" }); p = rt.project;
    const xin = addPort(p, { blockId: rx.blockId, direction: "in", name: "設計書" }); p = xin.project;
    const tin = addPort(p, { blockId: rt.blockId, direction: "in", name: "部品" }); p = tin.project;
    if (wires.sx) p = connect(p, { portId: portsOf(p, rs.blockId, "out")[0].id, side: "outer" }, { portId: xin.portId, side: "outer" }).project;
    if (wires.xt) p = connect(p, { portId: portsOf(p, rx.blockId, "out")[0].id, side: "outer" }, { portId: tin.portId, side: "outer" }).project;
    return { p, pj, P: rp.blockId, S: rs.blockId, X: rx.blockId, T: rt.blockId, xin: xin.portId, tin: tin.portId };
  }
  /** 入力ポートの供給元を、間のボックスのポート (内側 / 外側) を越えてたどり、最終的な出力のボックスを返す */
  function sourceBlock(p: Project, portId: string, side: "outer" | "inner" = "outer"): string | null {
    const e = incomingEdges(p, { portId, side })[0];
    if (!e) return null;
    const sp = p.ports[e.from.portId];
    if (sp.direction === "out" && e.from.side === "outer" && incomingEdges(p, { portId: sp.id, side: "inner" }).length > 0) return sourceBlock(p, sp.id, "inner"); // ボックスの出力: 中から来ている
    if (sp.direction === "in" && e.from.side === "inner") return sourceBlock(p, sp.id, "outer"); // 親の入力 (内側): 外から来ている
    return sp.blockId;
  }

  it("中の階層から外へ出しても、兄弟から受けていた線は親の出力を経由してつながったまま", () => {
    const { p, pj, P, S, X, xin } = nested({ sx: true, xt: false });
    const q = moveBlockToParent(p, X, pj, { x: 600, y: 100 });
    expect(q.blocks[X].parentId).toBe(pj);
    // S.out -> P.出力(内側) -> P.出力(外側) -> X.in
    expect(sourceBlock(q, xin)).toBe(S);
    expect(portsOf(q, P, "out").some((o) => o.name === "設計書")).toBe(true);
  });

  it("中の階層から外へ出しても、兄弟へ渡していた線は親の入力を経由してつながったまま", () => {
    const { p, pj, P, X, tin } = nested({ sx: false, xt: true });
    const q = moveBlockToParent(p, X, pj, { x: 600, y: 100 });
    // X.out -> P.入力(外側) -> P.入力(内側) -> T.in
    expect(sourceBlock(q, tin)).toBe(X);
    expect(portsOf(q, P, "in").some((i) => i.name === "部品" && !i.promotedFrom)).toBe(true);
    expect(outgoingEdges(q, { portId: portsOf(q, X, "out")[0].id, side: "outer" })).toHaveLength(1);
  });

  it("兄弟の中 (さらに深い階層) へ入れても線はつながったまま", () => {
    const { p, S, X, xin, tin } = nested();
    // X を T の中へ
    const T = p.blocks[p.ports[tin].blockId].id;
    const q = moveBlockToParent(p, X, T, { x: 100, y: 100 });
    expect(q.blocks[X].parentId).toBe(T);
    expect(sourceBlock(q, xin)).toBe(S); // S.out -> T.入力(外側) -> T.入力(内側) -> X.in
    // X.out -> T.in は、X が T の中に入ったので意味を失い切れる (T.in は供給元なしになる)
    expect(sourceBlock(q, tin)).toBeNull();
    expect(outgoingEdges(q, { portId: portsOf(q, X, "out")[0].id, side: "outer" })).toHaveLength(0);
  });
});

describe("ファイルに書く項目 (v5)", () => {
  it("updatedAt と version は書き出しに含めず、古いファイルの値は捨てる", () => {
    const p = createProject("x");
    const text = toJSON(p);
    expect(text).not.toContain("updatedAt");
    expect(text).not.toContain('"version"');
    const old = JSON.parse(text);
    old.schemaVersion = 4; old.updatedAt = "2026-01-01T00:00:00Z"; old.version = 7;
    const q = fromJSON(JSON.stringify(old));
    expect(q.schemaVersion).toBe(5);
    expect(toJSON(q)).not.toContain("updatedAt");
  });
});

describe("外部の課題のキー", () => {
  it("JIRA / Redmine / GitHub の URL からキーを取り出す", () => {
    expect(issueKeyOf("https://jira.example.com/browse/PROJ-123")).toBe("PROJ-123");
    expect(issueKeyOf("https://redmine.example.com/issues/45")).toBe("#45");
    expect(issueKeyOf("https://github.com/you/repo/issues/7")).toBe("#7");
    expect(issueKeyOf("https://github.com/you/repo/pull/8")).toBe("PR #8");
    expect(issueKeyOf("https://www.example.com/x")).toBe("example.com");
  });
});

describe("判断の候補を残す", () => {
  it("選ばなかった候補が残り、やり直すと前の答えが履歴に入る", () => {
    const { p, a } = twoBlocks();
    const asked = askDecision(p, a, "claude-code", "どれにする?", ["A", "B", "C"]);
    let q = answerDecision(asked.project, a, asked.decisionId!, "B", "human");
    let d = q.blocks[a].decisions[0];
    expect(candidatesOf(d)).toEqual({ chosen: "B", rejected: ["A", "C"] });
    q = reopenDecision(q, a, d.id, "human", "方針転換");
    d = q.blocks[a].decisions[0];
    expect(d.answer).toBeUndefined();
    expect(d.options).toEqual(["A", "B", "C"]); // 候補はそのまま
    expect(d.history?.[0]).toMatchObject({ answer: "B", by: "human", note: "方針転換" });
    expect(q.blocks[a].activity?.state).toBe("needs_decision");
    q = answerDecision(q, a, d.id, "C", "human");
    expect(candidatesOf(q.blocks[a].decisions[0])).toEqual({ chosen: "C", rejected: ["A", "B"] });
  });
});

describe("線のつながり (親の縁を越える)", () => {
  it("子の出力 → 親の出力 → 兄弟の入力 → 子の入力 が 1 つのつながりになる", () => {
    let p = createProject("t");
    const pj = defaultTaskParent(p);
    const rp = addBlock(p, { parentId: pj, title: "P", outputName: "成果" }); p = rp.project;
    const rc = addBlock(p, { parentId: rp.blockId, title: "C", outputName: "成果" }); p = rc.project;
    const rq = addBlock(p, { parentId: pj, title: "Q" }); p = rq.project;
    const rd = addBlock(p, { parentId: rq.blockId, title: "D" }); p = rd.project;
    const qin = addPort(p, { blockId: rq.blockId, direction: "in", name: "成果" }); p = qin.project;
    const din = addPort(p, { blockId: rd.blockId, direction: "in", name: "成果" }); p = din.project;
    const pout = portsOf(p, rp.blockId, "out")[0];
    const cout = portsOf(p, rc.blockId, "out")[0];
    const e1 = connect(p, { portId: cout.id, side: "outer" }, { portId: pout.id, side: "inner" }); p = e1.project;
    const e2 = connect(p, { portId: pout.id, side: "outer" }, { portId: qin.portId, side: "outer" }); p = e2.project;
    const e3 = connect(p, { portId: qin.portId, side: "inner" }, { portId: din.portId, side: "outer" }); p = e3.project;
    const net = wireNet(p, e2.edgeId!);
    for (const id of [e1.edgeId!, e2.edgeId!, e3.edgeId!]) expect(net.has(id)).toBe(true);
  });
});

describe("プロジェクトのボックスの出力は最上位に写る", () => {
  it("足すと同名の最上位の出力ができ、名前を変えると追従し、消すと消える", () => {
    let p = createProject("t");
    const pj = defaultTaskParent(p);
    const r = addPort(p, { blockId: pj, direction: "out", name: "2.0" }); p = r.project;
    expect(portsOf(p, ROOT_ID, "out").some((o) => o.name === "2.0")).toBe(true);
    p = updatePort(p, r.portId, { name: "Boxglow 2.0" });
    expect(portsOf(p, ROOT_ID, "out").some((o) => o.name === "Boxglow 2.0")).toBe(true);
    p = removePort(p, r.portId);
    expect(portsOf(p, ROOT_ID, "out").some((o) => o.name === "Boxglow 2.0")).toBe(false);
  });
});

describe("判断材料", () => {
  it("ask に判断材料を付けられ、未回答のうちは書き直せる。回答済みは変えない", () => {
    const { p, a } = twoBlocks();
    const asked = askDecision(p, a, "claude-code", "どれ?", ["A", "B"], "前提: ...");
    let q = asked.project;
    expect(q.blocks[a].decisions[0].context).toBe("前提: ...");
    q = updateDecision(q, a, asked.decisionId!, { context: "前提を書き直した", options: ["A", "B", "C"] });
    expect(q.blocks[a].decisions[0].context).toBe("前提を書き直した");
    expect(q.blocks[a].decisions[0].options).toEqual(["A", "B", "C"]);
    q = answerDecision(q, a, asked.decisionId!, "C", "human");
    expect(updateDecision(q, a, asked.decisionId!, { question: "x" })).toBe(q);
  });
});

describe("入力名は供給元の出力名に追従する (二重管理をなくす)", () => {
  it("出力の名前を変えると、つながる先の同じ名前の入力も変わる (親の出力や孫まで伝わる)", () => {
    let p = createProject("t");
    const pj = projectBlocks(p)[0].id;
    const a = addBlock(p, { parentId: pj, title: "A", outputName: "設計書" }); p = a.project;
    const b = addBlock(p, { parentId: pj, title: "B", outputName: "成果" }); p = b.project;
    p = addPort(p, { blockId: b.blockId, direction: "in", name: "設計書" }).project;
    const aOut = portsOf(p, a.blockId, "out")[0];
    const bIn = portsOf(p, b.blockId, "in")[0];
    p = connect(p, { portId: aOut.id, side: "outer" }, { portId: bIn.id, side: "outer" }).project;
    // B の中に子を置き、B の入力 (内側) から子の入力へつなぐ (同じ名前)
    const c = addBlock(p, { parentId: b.blockId, title: "C", outputName: "x" }); p = c.project;
    p = addPort(p, { blockId: c.blockId, direction: "in", name: "設計書" }).project;
    const cIn = portsOf(p, c.blockId, "in")[0];
    p = connect(p, { portId: bIn.id, side: "inner" }, { portId: cIn.id, side: "outer" }).project;
    p = updatePort(p, aOut.id, { name: "設計書 v2" });
    expect(p.ports[bIn.id].name).toBe("設計書 v2");
    expect(p.ports[cIn.id].name).toBe("設計書 v2");
    expect(p.ports[aOut.id].name).toBe("設計書 v2");
  });

  it("別名で作っておいた入力も、つないだ時点で供給元の出力名になる", () => {
    let p = createProject("t");
    const pj = projectBlocks(p)[0].id;
    const a = addBlock(p, { parentId: pj, title: "A", outputName: "設計書" }); p = a.project;
    const b = addBlock(p, { parentId: pj, title: "B", outputName: "成果" }); p = b.project;
    p = addPort(p, { blockId: b.blockId, direction: "in", name: "参考資料" }).project;
    const aOut = portsOf(p, a.blockId, "out")[0];
    const bIn = portsOf(p, b.blockId, "in")[0];
    p = connect(p, { portId: aOut.id, side: "outer" }, { portId: bIn.id, side: "outer" }).project;
    expect(p.ports[bIn.id].name).toBe("設計書");
  });

  it("split の結線は受け側が題名だけでよい (出力名と同じ入力が作られる)", () => {
    let p = createProject("t");
    const pj = projectBlocks(p)[0].id;
    const big = addBlock(p, { parentId: pj, title: "大きいボックス", outputName: "成果物" }); p = big.project;
    const r = splitBlock(p, big.blockId, { blocks: [{ title: "前半", outputs: ["中間ファイル"] }, { title: "後半", outputs: ["成果物"] }], connections: [{ from: "前半.中間ファイル", to: "後半" }, { from: "後半.成果物", to: "parent.成果物" }] }, "test");
    expect(r.errors).toEqual([]);
    const latter = findBlock(r.project, "後半").block!;
    const ins = portsOf(r.project, latter.id, "in");
    expect(ins.map((x) => x.name)).toEqual(["中間ファイル"]);
    expect(incomingEdges(r.project, { portId: ins[0].id, side: "outer" }).some((e) => !e.auto)).toBe(true);
  });
});

describe("線でつながる入出力は 1 つの名前 (どこで変えても全体がそろう)", () => {
  it("connect すると入力の名前が供給元の出力名になり、入力側で変えると供給元の出力と兄弟の入力も変わる", () => {
    let p = createProject("t");
    const pj = projectBlocks(p)[0].id;
    const a = addBlock(p, { parentId: pj, title: "A", outputName: "設計書" }); p = a.project;
    const b = addBlock(p, { parentId: pj, title: "B", outputName: "成果" }); p = b.project;
    const c = addBlock(p, { parentId: pj, title: "C", outputName: "別の成果" }); p = c.project;
    p = addPort(p, { blockId: b.blockId, direction: "in", name: "何か" }).project;
    p = addPort(p, { blockId: c.blockId, direction: "in", name: "何か 2" }).project;
    const aOut = portsOf(p, a.blockId, "out")[0];
    const bIn = portsOf(p, b.blockId, "in")[0];
    const cIn = portsOf(p, c.blockId, "in")[0];
    p = connect(p, { portId: aOut.id, side: "outer" }, { portId: bIn.id, side: "outer" }).project;
    p = connect(p, { portId: aOut.id, side: "outer" }, { portId: cIn.id, side: "outer" }).project;
    expect(p.ports[bIn.id].name).toBe("設計書");
    expect(p.ports[cIn.id].name).toBe("設計書");
    // 入力側で変えても全体がそろう (入力側のロックは廃止)
    p = updatePort(p, bIn.id, { name: "設計書 v2" });
    expect(p.ports[aOut.id].name).toBe("設計書 v2");
    expect(p.ports[cIn.id].name).toBe("設計書 v2");
    expect(portNet(p, aOut.id).size).toBe(3);
  });

  it("子の出力 → 親の出力をつなぐと親の出力も同じ名前になり、どちらで変えても子・最上位の写しまでそろう (一度ずれても追従する)", () => {
    let p = createProject("t");
    const pj = projectBlocks(p)[0].id;
    // 親はプロジェクトのボックス (その出力「最終成果物」は最上位の出力に写される)。子の出力 (仮の名前) を親の出力 (内側) へつなぐ
    const kid = addBlock(p, { parentId: pj, title: "子", outputName: "新しい出力" }); p = kid.project;
    const parentOut = portsOf(p, pj, "out")[0];
    const kidOut = portsOf(p, kid.blockId, "out")[0];
    p = connect(p, { portId: kidOut.id, side: "outer" }, { portId: parentOut.id, side: "inner" }).project;
    expect(p.ports[kidOut.id].name).toBe("最終成果物"); // 仮の名前の側が相手に合わせる
    // 同じ名前の子の出力 → 親の出力は 1 つの物。親側で変えると子と最上位の写しも変わり、子側で変えても同じ
    p = updatePort(p, parentOut.id, { name: "設計書 v2" });
    expect(p.ports[kidOut.id].name).toBe("設計書 v2");
    expect(portsOf(p, ROOT_ID, "out").map((x) => x.name)).toContain("設計書 v2");
    p = updatePort(p, kidOut.id, { name: "設計書 v3" });
    expect(p.ports[parentOut.id].name).toBe("設計書 v3");
    expect(portsOf(p, ROOT_ID, "out").map((x) => x.name)).toContain("設計書 v3");
  });

  it("子の出力 → 親の出力をつなぐと、親の出力 (外から見える名前) に合わせ、以後はどちらを変えても両方変わる", () => {
    let p = createProject("t");
    const pj = projectBlocks(p)[0].id;
    const parent = addBlock(p, { parentId: pj, title: "親", outputName: "仕様 (転記)" }); p = parent.project;
    const kid = addBlock(p, { parentId: parent.blockId, title: "子", outputName: "仕様" }); p = kid.project;
    const parentOut = portsOf(p, parent.blockId, "out")[0];
    const kidOut = portsOf(p, kid.blockId, "out")[0];
    p = connect(p, { portId: kidOut.id, side: "outer" }, { portId: parentOut.id, side: "inner" }).project;
    expect(p.ports[parentOut.id].name).toBe("仕様 (転記)");
    expect(p.ports[kidOut.id].name).toBe("仕様 (転記)");
    p = updatePort(p, kidOut.id, { name: "仕様 v2" });
    expect(p.ports[parentOut.id].name).toBe("仕様 v2");
  });

  it("上流が仮の名前 (新しい出力) のままなら、つないだときに受ける側の名前を採る", () => {
    let p = createProject("t");
    const pj = projectBlocks(p)[0].id;
    const parent = addBlock(p, { parentId: pj, title: "親", outputName: "キャラ A" }); p = parent.project;
    const kid = addBlock(p, { parentId: parent.blockId, title: "子", outputName: "新しい出力" }); p = kid.project;
    const parentOut = portsOf(p, parent.blockId, "out")[0];
    const kidOut = portsOf(p, kid.blockId, "out")[0];
    p = connect(p, { portId: kidOut.id, side: "outer" }, { portId: parentOut.id, side: "inner" }).project;
    expect(p.ports[kidOut.id].name).toBe("キャラ A");
    expect(p.ports[parentOut.id].name).toBe("キャラ A");
  });
});

describe("出力は作る物ごとに何本でも持てる (下の階層が無くても)", () => {
  it("addPort で 2 本目の出力を足せる。split の outputs も複数書ける", () => {
    let p = createProject("t");
    const pj = projectBlocks(p)[0].id;
    const a = addBlock(p, { parentId: pj, title: "キャラクター設定", outputName: "キャラ A" }); p = a.project;
    const r2 = addPort(p, { blockId: a.blockId, direction: "out", name: "キャラ B" }); p = r2.project;
    expect(portsOf(p, a.blockId, "out").map((x) => x.name)).toEqual(["キャラ A", "キャラ B"]);
    expect(r2.portId).not.toBe(portsOf(p, a.blockId, "out")[0].id);
    const big = addBlock(p, { parentId: pj, title: "大きいボックス", outputName: "成果物" }); p = big.project;
    const r = splitBlock(p, big.blockId, { blocks: [{ title: "設定", outputs: ["キャラ C", "キャラ D"] }, { title: "まとめ", outputs: ["成果物"] }], connections: [{ from: "設定.キャラ C", to: "まとめ" }, { from: "設定.キャラ D", to: "まとめ" }, { from: "まとめ.成果物", to: "parent.成果物" }] }, "test");
    expect(r.errors).toEqual([]);
    const made = findBlock(r.project, "設定").block!;
    expect(portsOf(r.project, made.id, "out").map((x) => x.name)).toEqual(["キャラ C", "キャラ D"]);
    const sum = findBlock(r.project, "まとめ").block!;
    expect(portsOf(r.project, sum.id, "in").map((x) => x.name)).toEqual(["キャラ C", "キャラ D"]);
  });
});

describe("Top は全階層を見せる (大項目は畳んだまま始まり、人が開く)", () => {
  it("大項目に最初の子ができたら畳んで始まる (CLI の add / split で Top の配置が動かない)。2 つ目以降は今の状態を保つ", () => {
    let p = createProject("t");
    const pj = projectBlocks(p)[0].id;
    const major = addBlock(p, { parentId: pj, title: "大項目" }); p = major.project;
    expect(p.blocks[major.blockId].collapsed).toBe(false); // 子が無いうちは畳む意味が無い
    p = addBlock(p, { parentId: major.blockId, title: "子 1" }).project;
    expect(p.blocks[major.blockId].collapsed).toBe(true);
    // 人が開いた後に子を足しても、開いたまま
    p = { ...p, blocks: { ...p.blocks, [major.blockId]: { ...p.blocks[major.blockId], collapsed: false } } };
    p = addBlock(p, { parentId: major.blockId, title: "子 2" }).project;
    expect(p.blocks[major.blockId].collapsed).toBe(false);
    // 大項目でない箱 (子の中) は、最初の子ができても畳まない
    const kid = findBlock(p, "子 2").block!;
    p = addBlock(p, { parentId: kid.id, title: "孫" }).project;
    expect(p.blocks[kid.id].collapsed).toBe(false);
  });

  it("split は大項目を畳んだままにし、大項目でない箱は展開する", () => {
    let p = createProject("t");
    const pj = projectBlocks(p)[0].id;
    const major = addBlock(p, { parentId: pj, title: "大項目", outputName: "成果" }); p = major.project;
    const r = splitBlock(p, major.blockId, { blocks: [{ title: "a", outputs: ["x"] }, { title: "b", outputs: ["成果"] }], connections: [{ from: "a.x", to: "b" }, { from: "b.成果", to: "parent.成果" }] }, "test");
    expect(r.errors).toEqual([]);
    expect(r.project.blocks[major.blockId].collapsed).toBe(true);
    const b = findBlock(r.project, "b").block!;
    const r2 = splitBlock(r.project, b.id, { blocks: [{ title: "b1", outputs: ["成果"] }], connections: [{ from: "b1.成果", to: "parent.成果" }] }, "test");
    expect(r2.errors).toEqual([]);
    expect(r2.project.blocks[b.id].collapsed).toBe(false);
  });
});

describe("消せるもの: 入力は使う箱の入力ごと、最後の出力と最後のプロジェクトのボックスは残す", () => {
  it("最上位の入力 (自動で上がったものも) を消すと、使う箱の入力も消えて復活しない", () => {
    let p = createProject("t");
    const pj = projectBlocks(p)[0].id;
    const a = addBlock(p, { parentId: pj, title: "A" }); p = a.project;
    p = addPort(p, { blockId: a.blockId, direction: "in", name: "仕様書" }).project; // 最上位まで自動で上がる
    const rootIn = portsOf(p, ROOT_ID, "in").find((x) => x.name === "仕様書")!;
    expect(rootIn.promotedFrom).toBeTruthy();
    expect(inputsFedBy(p, rootIn.id).map((x) => x.blockId)).toContain(a.blockId);
    p = removePort(p, rootIn.id);
    expect(portsOf(p, ROOT_ID, "in")).toHaveLength(0);
    expect(portsOf(p, a.blockId, "in")).toHaveLength(0);
    // 手で足した最上位の入力を子につないでから消しても同じ (線を消すだけだと子の入力が再び上がってしまう)
    p = addPort(p, { blockId: a.blockId, direction: "in", name: "資料" }).project;
    const manual = addPort(p, { blockId: ROOT_ID, direction: "in", name: "資料" }); p = manual.project;
    const aIn = portsOf(p, a.blockId, "in")[0];
    p = connect(p, { portId: manual.portId, side: "inner" }, { portId: portsOf(p, pj, "in")[0].id, side: "outer" }).project;
    void aIn;
    p = removePort(p, manual.portId);
    expect(portsOf(p, ROOT_ID, "in")).toHaveLength(0);
    expect(portsOf(p, a.blockId, "in")).toHaveLength(0);
  });

  it("最後の出力も消せる (出力の無い箱は要具体化として案内されるだけ)。判断は回答済みでも消せる", () => {
    let p = createProject("t");
    const pj = projectBlocks(p)[0].id;
    const a = addBlock(p, { parentId: pj, title: "A", outputName: "成果" }); p = a.project;
    const out = portsOf(p, a.blockId, "out")[0];
    expect(canRemovePort(p, out.id).ok).toBe(true);
    p = removePort(p, out.id);
    expect(portsOf(p, a.blockId, "out")).toHaveLength(0);
    const asked = askDecision(p, a.blockId, "claude-code", "どれ?", ["x", "y"]); p = asked.project;
    expect(removeDecision(p, a.blockId, asked.decisionId!).project.blocks[a.blockId].decisions).toHaveLength(0);
    const answered = answerDecision(p, a.blockId, asked.decisionId!, "x", "human");
    expect(removeDecision(answered, a.blockId, asked.decisionId!).project.blocks[a.blockId].decisions).toHaveLength(0);
  });

  it("プロジェクトのボックスも消せる (最後の 1 つでも)", () => {
    let p = createProject("t");
    const pj = projectBlocks(p)[0].id;
    p = removeBlock(p, pj);
    expect(p.blocks[pj]).toBeUndefined();
    expect(projectBlocks(p)).toHaveLength(0);
  });
});

describe("箱へ線を落とすと、自動で上がった同名の入力につながる (同名の入力を 2 本にしない)", () => {
  it("親の入力 (内側) を子持ちの箱へ落とすと、自動で上がった入力が供給元を得て、中の箱までつながる", () => {
    let p = createProject("t");
    const pj = projectBlocks(p)[0].id;
    const m = addBlock(p, { parentId: pj, title: "モデリング" }); p = m.project;
    const c = addBlock(p, { parentId: m.blockId, title: "キャラクターモデリング" }); p = c.project;
    p = addPort(p, { blockId: c.blockId, direction: "in", name: "シナリオ" }).project; // モデリング → プロジェクトのボックス → 最上位まで自動で上がる
    const pjIn = portsOf(p, pj, "in")[0];
    const r = connectToBlock(p, { portId: pjIn.id, side: "inner" }, m.blockId); p = r.project;
    expect(r.error).toBeUndefined();
    const ins = portsOf(p, m.blockId, "in");
    expect(ins).toHaveLength(1);
    expect(incomingEdges(p, { portId: ins[0].id, side: "outer" }).some((e) => !e.auto)).toBe(true); // 本物の線が来た
    expect(outgoingEdges(p, { portId: ins[0].id, side: "inner" })).toHaveLength(1); // 中の箱へ配られたまま
    expect(portsOf(p, ROOT_ID, "in").map((x) => x.name)).toEqual(["シナリオ"]); // 最上位の入力は 1 本のまま
  });
});

describe("階層をまたぐ結線 (connectAcross / connectToBlock) と、名前でつなぐ", () => {
  /** 最上位の入力「シナリオ」と、3 階層下の箱 (Interval › 3Dモデリング › キャラクターモデリング › 登場人物情報抽出) */
  const deep = () => {
    let p = createProject("t");
    const pj = projectBlocks(p)[0].id;
    p = addPort(p, { blockId: ROOT_ID, direction: "in", name: "シナリオ" }).project;
    const m3d = addBlock(p, { parentId: pj, title: "3Dモデリング" }); p = m3d.project;
    const chara = addBlock(p, { parentId: m3d.blockId, title: "キャラクターモデリング" }); p = chara.project;
    const leaf = addBlock(p, { parentId: chara.blockId, title: "登場人物情報抽出", outputName: "Human Woman" }); p = leaf.project;
    return { p, pj, m3d: m3d.blockId, chara: chara.blockId, leaf: leaf.blockId };
  };
  it("最上位の入力を 3 階層下の箱に落とすと、途中の箱に入力を作って通る", () => {
    const { p, pj, m3d, chara, leaf } = deep();
    const root = portsOf(p, ROOT_ID, "in")[0];
    const r = connectToBlock(p, { portId: root.id, side: "inner" }, leaf);
    expect(r.error).toBeUndefined();
    const q = r.project;
    for (const id of [pj, m3d, chara, leaf]) {
      const ins = portsOf(q, id, "in");
      expect(ins.map((x) => x.name)).toEqual(["シナリオ"]);
      expect(incomingEdges(q, { portId: ins[0].id, side: "outer" }).some((e) => !e.auto)).toBe(true);
    }
    expect(portsOf(q, ROOT_ID, "in")).toHaveLength(1); // 最上位に同名が増えない
  });
  it("深い箱に同名の入力を足すだけで、最上位の同名の入力まで自動でつながる (名前でつなぐ)", () => {
    const { p, pj, leaf } = deep();
    const q = addPort(p, { blockId: leaf, direction: "in", name: "シナリオ" }).project;
    expect(portsOf(q, ROOT_ID, "in")).toHaveLength(1);
    const pjIn = portsOf(q, pj, "in");
    expect(pjIn).toHaveLength(1);
    expect(incomingEdges(q, { portId: pjIn[0].id, side: "outer" })[0]?.from.portId).toBe(portsOf(q, ROOT_ID, "in")[0].id);
    expect(isInputReady(q, portsOf(q, leaf, "in")[0].id)).toBe(false); // 供給元 (最上位の入力) に入力物が無いのでまだ待ち
  });
  it("丸どうしでも階層が違えば通す。自分の中の箱へ自分の出力は落とせない。先祖に落とすと親の出力へ束ねる", () => {
    const { p, m3d, chara, leaf } = deep();
    const root = portsOf(p, ROOT_ID, "in")[0];
    let q = addPort(p, { blockId: leaf, direction: "in", name: "資料" }).project;
    const leafIn = portsOf(q, leaf, "in")[0];
    expect(canConnectAcross(q, { portId: root.id, side: "inner" }, { portId: leafIn.id, side: "outer" })).toBe(true);
    const r = connectAcross(q, { portId: root.id, side: "inner" }, { portId: leafIn.id, side: "outer" });
    expect(r.error).toBeUndefined(); q = r.project;
    expect(portsOf(q, leaf, "in").map((x) => x.name)).toEqual(["シナリオ"]); // 線でつながる入出力は 1 つの名前 (上流の名前)
    const charaOut = portsOf(q, chara, "out")[0];
    expect(connectToBlock(q, { portId: charaOut.id, side: "outer" }, leaf).error).toBeTruthy();
    const leafOut = portsOf(q, leaf, "out")[0];
    const up = connectToBlock(q, { portId: leafOut.id, side: "outer" }, m3d); // 2 つ上の先祖へ束ねる
    expect(up.error).toBeUndefined();
    expect(incomingEdges(up.project, { portId: portsOf(up.project, m3d, "out")[0].id, side: "inner" }).some((e) => !e.auto)).toBe(true);
  });
  it("供給元の候補は 計画の入力 → 上の階層の入力 → ほかの箱の出力 の順で、自分・先祖・子孫の出力は含まない", () => {
    const { p, pj, chara, leaf } = deep();
    const other = addBlock(p, { parentId: pj, title: "音響", outputName: "BGM" }); const q = other.project;
    const cands = sourceCandidates(q, leaf);
    expect(cands[0].label).toBe("Inputs › シナリオ");
    expect(cands.some((c) => c.label.endsWith("› BGM"))).toBe(true);
    expect(cands.some((c) => c.label.includes("Human Woman"))).toBe(false);
    const targets = targetCandidates(q, portsOf(q, leaf, "out")[0].id);
    expect(targets.some((x) => x.blockId === other.blockId)).toBe(true);
    expect(targets.some((x) => x.blockId === chara)).toBe(true); // 先祖 (親の出力へ)
    expect(targets.some((x) => x.blockId === leaf)).toBe(false);
  });
});

describe("差し戻し (sendBack): 線で戻さず、作った箱を In Progress に戻す", () => {
  it("評価の箱から供給元へ差し戻すと、供給元は gray に戻り成果物は差し戻し済みへ、評価の入力は待ちに戻る", () => {
    let p = createProject("t");
    const pj = projectBlocks(p)[0].id;
    const make = addBlock(p, { parentId: pj, title: "作成", outputName: "キャラ" }); p = make.project;
    const evalB = addBlock(p, { parentId: pj, title: "評価", outputName: "評価結果" }); p = evalB.project;
    const r = connectToBlock(p, { portId: portsOf(p, make.blockId, "out")[0].id, side: "outer" }, evalB.blockId); p = r.project;
    p = finishBlock(p, make.blockId, "claude-code", { artifacts: [{ title: "chara.glb", url: "assets/chara.glb" }] }).project;
    const evalIn = portsOf(p, evalB.blockId, "in")[0];
    expect(isInputReady(p, evalIn.id)).toBe(true);
    expect(sendBackTargets(p, evalB.blockId).map((b) => b.title)).toEqual(["作成"]);
    const sb = sendBack(p, evalB.blockId, make.blockId, "human", "顔が崩れている");
    expect(sb.error).toBeUndefined(); p = sb.project;
    expect(p.blocks[make.blockId].status).toBe("gray");
    const out = portsOf(p, make.blockId, "out")[0];
    expect(out.artifacts).toHaveLength(0);
    expect(out.rejectedArtifacts?.map((a) => [a.title, a.rejectedNote])).toEqual([["chara.glb", "顔が崩れている"]]);
    expect(isInputReady(p, evalIn.id)).toBe(false);
    expect(sentBackTo(p, make.blockId).map((x) => [x.from.title, x.record.note])).toEqual([["評価", "顔が崩れている"]]);
    expect(p.log.at(-1)?.message).toContain("差し戻し");
    // 供給元でない箱へは戻せない
    expect(sendBack(p, evalB.blockId, evalB.blockId, "human", "x").error).toBeTruthy();
  });
});

describe("どんな線でも Delete で外せる (disconnectWire)", () => {
  it("自動の線を外すと、その入力は箱に未接続のまま残り、上へは引き上げられない。線をつなぐと元に戻る", () => {
    let p = createProject("t");
    const pj = projectBlocks(p)[0].id;
    const m = addBlock(p, { parentId: pj, title: "大項目" }); p = m.project;
    const leafB = addBlock(p, { parentId: m.blockId, title: "葉" }); p = leafB.project;
    const leaf = leafB.blockId;
    p = addPort(p, { blockId: leaf, direction: "in", name: "資料" }).project; // 大項目 → プロジェクト → 最上位まで自動で上がる
    expect(portsOf(p, ROOT_ID, "in").map((x) => x.name)).toEqual(["資料"]);
    const autoEdge = Object.values(p.edges).find((e) => e.auto && p.ports[e.to.portId].blockId === leaf)!;
    const d = disconnectWire(p, autoEdge.id); p = d.project;
    expect(d.error).toBeUndefined();
    const leafIn = portsOf(p, leaf, "in")[0];
    expect(leafIn.noPromote).toBe(true);
    expect(incomingEdges(p, { portId: leafIn.id, side: "outer" })).toHaveLength(0);
    expect(portsOf(p, ROOT_ID, "in")).toHaveLength(0); // 使われなくなった引き上げのポートは消える
    expect(portsOf(p, m.blockId, "in")).toHaveLength(0);
    // 本物の線をつなぐと印が外れる
    const a = addBlock(p, { parentId: pj, title: "A", outputName: "資料" }); p = a.project;
    const r = connectToBlock(p, { portId: portsOf(p, a.blockId, "out")[0].id, side: "outer" }, leaf); p = r.project;
    expect(r.error).toBeUndefined();
    expect(portsOf(p, leaf, "in")[0].noPromote).toBeUndefined();
    // 本物の線もそのまま外せる
    const real = Object.values(p.edges).find((e) => !e.auto && e.from.portId === portsOf(p, a.blockId, "out")[0].id)!;
    expect(disconnectWire(p, real.id).project.edges[real.id]).toBeUndefined();
  });
});

describe("normalizePortNames: 古い食い違いをそろえる", () => {
  it("食い違ったファイルを読み込んだ時点で、親の出力の名前にそろう (開いただけで見た目がそろう)", () => {
    let p = createProject("t");
    const pj = projectBlocks(p)[0].id;
    const parent = addBlock(p, { parentId: pj, title: "髪の毛・髪型", outputName: "髪の毛Model" }); p = parent.project;
    const kid = addBlock(p, { parentId: parent.blockId, title: "テクスチャ", outputName: "髪の毛Model" }); p = kid.project;
    p = connect(p, { portId: portsOf(p, kid.blockId, "out")[0].id, side: "outer" }, { portId: portsOf(p, parent.blockId, "out")[0].id, side: "inner" }).project;
    const broken = JSON.parse(toJSON(p)); broken.ports[portsOf(p, kid.blockId, "out")[0].id].name = "3Dオブジェクト(テクスチャ付き)";
    expect(portsOf(fromJSON(JSON.stringify(broken)), kid.blockId, "out")[0].name).toBe("髪の毛Model");
  });

  it("供給元と違う名前の入力を、供給元の名前 (さらに上流があればその名前) にそろえる", () => {
    let p = createProject("t");
    const pj = projectBlocks(p)[0].id;
    const a = addBlock(p, { parentId: pj, title: "A", outputName: "CLI と手順" }); p = a.project;
    const b = addBlock(p, { parentId: pj, title: "B", outputName: "成果" }); p = b.project;
    p = addPort(p, { blockId: b.blockId, direction: "in", name: "CLI と手順" }).project;
    const aOut = portsOf(p, a.blockId, "out")[0];
    const bIn = portsOf(p, b.blockId, "in")[0];
    p = connect(p, { portId: aOut.id, side: "outer" }, { portId: bIn.id, side: "outer" }).project;
    // 規則が入る前のファイルを模して、入力の名前だけ食い違わせる
    const broken = structuredClone(p);
    broken.ports[bIn.id].name = "CLI と連携の仕組み";
    const r = normalizePortNames(broken);
    expect(r.renamed).toBe(1);
    expect(r.project.ports[bIn.id].name).toBe("CLI と手順");
    expect(normalizePortNames(r.project).renamed).toBe(0);
  });

  it("子の出力 → 親の出力 (上向きの線) の食い違いは、親の出力の名前にそろえる", () => {
    let p = createProject("t");
    const pj = projectBlocks(p)[0].id;
    const parent = addBlock(p, { parentId: pj, title: "親", outputName: "設計書" }); p = parent.project;
    const kid = addBlock(p, { parentId: parent.blockId, title: "子", outputName: "設計書" }); p = kid.project;
    const parentOut = portsOf(p, parent.blockId, "out")[0];
    const kidOut = portsOf(p, kid.blockId, "out")[0];
    p = connect(p, { portId: kidOut.id, side: "outer" }, { portId: parentOut.id, side: "inner" }).project;
    const broken = structuredClone(p);
    broken.ports[parentOut.id].name = "古い名前";
    const r = normalizePortNames(broken);
    expect(r.project.ports[parentOut.id].name).toBe("古い名前");
    expect(r.project.ports[kidOut.id].name).toBe("古い名前");
    expect(r.renamed).toBe(1);
    expect(normalizePortNames(r.project).renamed).toBe(0);
  });
});

// id の先頭が「-」にならないこと (「--」で始まる id は CLI でオプションと読み違えられ、指定できなくなるため)
describe("newId", () => {
  it("先頭が「-」の id を作らない (2 万個作って確かめる)", () => {
    for (let i = 0; i < 20000; i++) expect(newId().startsWith("-")).toBe(false);
  });
});

describe("出力の下流 (consumersOf)", () => {
  it("兄弟の入力、親の出力に束ねた先、親の入力から子へ配った先をたどる", () => {
    const base = createProject("下流");
    const pid = defaultTaskParent(base);
    const a = addBlock(base, { parentId: pid, title: "A", outputName: "部品" });
    let p = a.project;
    const b = addBlock(p, { parentId: pid, title: "B", outputName: "製品" }); p = b.project;
    // A.部品 → B (兄弟)
    p = connectToBlock(p, { portId: portsOf(p, a.blockId, "out")[0].id, side: "outer" }, b.blockId).project;
    expect(consumersOf(p, portsOf(p, a.blockId, "out")[0].id).map((x) => x.title)).toEqual(["B"]);
    // B の中に子 C を置き、B の入力「部品」を C へ配る → A.部品 の下流は C (B ではなく、実際に使う C)
    const c = addBlock(p, { parentId: b.blockId, title: "C", outputName: "製品の中身" }); p = c.project;
    const bIn = portsOf(p, b.blockId, "in").find((q) => q.name === "部品")!;
    p = connectToBlock(p, { portId: bIn.id, side: "inner" }, c.blockId).project;
    expect(consumersOf(p, portsOf(p, a.blockId, "out")[0].id).map((x) => x.title)).toEqual(["C"]);
    // C.製品の中身 → B.製品 (親の出力に束ねる) → B.製品 を使う D
    const d = addBlock(p, { parentId: pid, title: "D", outputName: "完成" }); p = d.project;
    p = connect(p, { portId: portsOf(p, c.blockId, "out")[0].id, side: "outer" }, { portId: portsOf(p, b.blockId, "out")[0].id, side: "inner" }).project;
    p = connectToBlock(p, { portId: portsOf(p, b.blockId, "out")[0].id, side: "outer" }, d.blockId).project;
    expect(consumersOf(p, portsOf(p, c.blockId, "out")[0].id).map((x) => x.title)).toEqual(["D"]);
  });
});

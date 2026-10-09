/**
 * 分岐と合流の確認: 未定の道は分岐待ち、答えたら選ばなかった道は見送り、合流の入力はどれか 1 つでよい
 */
import { describe, expect, it } from "vitest";
import { addBlock, addPort, answerDecision, connect, createProject, defaultTaskParent, portsOf, reopenDecision, fromJSON, toJSON } from "./graph";
import { addBranch, branchState, chosenOption, setInputAnyOf } from "./branch";

/**
 * 小さな計画: 分岐 (方式を決める: REST / GraphQL) → REST の道 X、GraphQL の道 Y (Y の中に子 Y1) → 合流先 M (X と Y の両方から入力)
 * Input : anyOf = 合流先の 2 つの入力を合流の入力にするか
 */
function fixture(anyOf = true) {
  let p = createProject("分岐");
  const parent = defaultTaskParent(p);
  const br = addBranch(p, { parentId: parent, title: "方式を決める", question: "API の方式は?", options: ["REST", "GraphQL"], actor: "human" });
  p = br.project;
  const x = addBlock(p, { parentId: parent, title: "X" }); p = x.project;
  const y = addBlock(p, { parentId: parent, title: "Y" }); p = y.project;
  const y1 = addBlock(p, { parentId: y.blockId, title: "Y1" }); p = y1.project;
  const m = addBlock(p, { parentId: parent, title: "M" }); p = m.project;
  const [rest, gql] = portsOf(p, br.blockId, "out");
  const xIn = addPort(p, { blockId: x.blockId, direction: "in", name: "REST" }); p = xIn.project;
  const yIn = addPort(p, { blockId: y.blockId, direction: "in", name: "GraphQL" }); p = yIn.project;
  p = connect(p, { portId: rest.id, side: "outer" }, { portId: xIn.portId, side: "outer" }).project;
  p = connect(p, { portId: gql.id, side: "outer" }, { portId: yIn.portId, side: "outer" }).project;
  const mIn1 = addPort(p, { blockId: m.blockId, direction: "in", name: "X の結果" }); p = mIn1.project;
  const mIn2 = addPort(p, { blockId: m.blockId, direction: "in", name: "Y の結果" }); p = mIn2.project;
  p = connect(p, { portId: portsOf(p, x.blockId, "out")[0].id, side: "outer" }, { portId: mIn1.portId, side: "outer" }).project;
  p = connect(p, { portId: portsOf(p, y.blockId, "out")[0].id, side: "outer" }, { portId: mIn2.portId, side: "outer" }).project;
  if (anyOf) { p = setInputAnyOf(p, mIn1.portId, true); p = setInputAnyOf(p, mIn2.portId, true); }
  return { p, br, x: x.blockId, y: y.blockId, y1: y1.blockId, m: m.blockId };
}

describe("分岐", () => {
  it("作ると、選択肢ごとの出力と判断待ちの質問を持つ", () => {
    const { p, br } = fixture();
    expect(portsOf(p, br.blockId, "out").map((o) => [o.name, o.branchOption])).toEqual([["REST", "REST"], ["GraphQL", "GraphQL"]]);
    expect(p.blocks[br.blockId].branch?.decisionId).toBe(br.decisionId);
    expect(p.blocks[br.blockId].decisions[0]).toMatchObject({ question: "API の方式は?", options: ["REST", "GraphQL"] });
  });
  it("答える前は、どの道の先も分岐待ち (合流先も)。見送りは無い", () => {
    const { p, br, x, y, y1, m } = fixture();
    const s = branchState(p);
    expect(s.skipped.size).toBe(0);
    expect([...s.pending.keys()].sort()).toEqual([x, y, y1, m].sort());
    expect(s.pending.get(x)).toEqual([br.blockId]);
  });
  it("答えると、選ばなかった道 (子も) は見送り、選んだ道と合流先は通常に戻る", () => {
    let { p, br, x, y, y1, m } = fixture();
    p = answerDecision(p, br.blockId, br.decisionId, "REST", "human");
    expect(chosenOption(p.blocks[br.blockId])).toBe("REST");
    const s = branchState(p);
    expect([...s.skipped].sort()).toEqual([y, y1].sort());
    expect(s.pending.size).toBe(0);
    expect(s.skipped.has(x) || s.skipped.has(m)).toBe(false);
    expect(s.rejectedEdges.size).toBeGreaterThan(0);
  });
  it("合流でない入力が見送りの道から来るボックスは、見送りになる", () => {
    let { p, br, m } = fixture(false);
    p = answerDecision(p, br.blockId, br.decisionId, "REST", "human");
    expect(branchState(p).skipped.has(m)).toBe(true);
  });
  it("判断をやり直すと、また分岐待ちに戻る。自由記述の答えはどの道も選ばない (未定のまま)", () => {
    let { p, br, y } = fixture();
    p = answerDecision(p, br.blockId, br.decisionId, "REST", "human");
    p = reopenDecision(p, br.blockId, br.decisionId, "human");
    expect(branchState(p).pending.has(y)).toBe(true);
    p = answerDecision(p, br.blockId, br.decisionId, "まだ迷っている", "human");
    expect(chosenOption(p.blocks[br.blockId])).toBeUndefined();
    expect(branchState(p).skipped.size).toBe(0);
  });
  it("ファイルに書いて読み戻しても、分岐の印・選択肢の出力・合流の入力が残る", () => {
    const { p, br, m } = fixture();
    const q = fromJSON(toJSON(p));
    expect(q.blocks[br.blockId].branch).toEqual(p.blocks[br.blockId].branch);
    expect(portsOf(q, br.blockId, "out").map((o) => o.branchOption)).toEqual(["REST", "GraphQL"]);
    expect(portsOf(q, m, "in").every((i) => i.anyOf)).toBe(true);
  });
});

describe("分岐の答えと道の届き方", () => {
  it("選択肢で答えると、分岐のボックスは完了になり、選んだ道の出力が届く (選ばなかった道は届かない)。やり直すと未着手に戻る", async () => {
    const { isSourceReady, missingRequiredInputs } = await import("./graph");
    let { p, br, x, y } = fixture();
    const [rest, gql] = portsOf(p, br.blockId, "out");
    p = answerDecision(p, br.blockId, br.decisionId, "REST", "human");
    expect(p.blocks[br.blockId].status).toBe("white");
    expect(isSourceReady(p, { portId: rest.id, side: "outer" })).toBe(true);
    expect(isSourceReady(p, { portId: gql.id, side: "outer" })).toBe(false);
    expect(missingRequiredInputs(p, x)).toEqual([]);
    expect(missingRequiredInputs(p, y).map((q) => q.name)).toEqual(["GraphQL"]);
    p = reopenDecision(p, br.blockId, br.decisionId, "human");
    expect(p.blocks[br.blockId].status).toBe("black");
  });
  it("合流の入力の待ちは、1 つにまとめて出す", async () => {
    const { waitingFor } = await import("./graph");
    const { p, m } = fixture();
    // 答える前: 合流の 2 つの入力は、つないだ出力の名前 (どちらも「出力」) に合わせて同じ名前になるので 1 件だけ。それと分岐の判断
    expect(waitingFor(p, m)).toEqual(["出力", "分岐「方式を決める」の判断"]);
  });
});

describe("分岐の判定の細部と速さ", () => {
  it("任意の入力が見送りの道から来るだけでは、見送りにも分岐待ちにもならない", async () => {
    const { updatePort } = await import("./graph");
    let { p, br } = fixture(false);
    // 必須の入力と、道 GraphQL から来る任意の入力を持つ箱
    const z = addBlock(p, { parentId: defaultTaskParent(p), title: "Z" }); p = z.project;
    const opt = addPort(p, { blockId: z.blockId, direction: "in", name: "任意" }); p = opt.project;
    p = connect(p, { portId: portsOf(p, br.blockId, "out")[1].id, side: "outer" }, { portId: opt.portId, side: "outer" }).project;
    p = updatePort(p, opt.portId, { required: false });
    expect(branchState(p).pending.has(z.blockId)).toBe(false);
    p = answerDecision(p, br.blockId, br.decisionId, "REST", "human");
    expect(branchState(p).skipped.has(z.blockId)).toBe(false);
  });
  it("分岐の後ろに 400 段の鎖があっても、速く求まる (見送りは鎖の端まで届く)", () => {
    let p = createProject("長い鎖");
    const parent = defaultTaskParent(p);
    const br = addBranch(p, { parentId: parent, title: "分岐", question: "?", options: ["A", "B"], actor: "human" }); p = br.project;
    // 道 B の先に 400 段の鎖を、計画の中身を直接組んで作る (関数で 1 つずつ足すと、作るだけで時間がかかるため)
    p = structuredClone(p);
    let prev = portsOf(p, br.blockId, "out")[1].id;
    let last = "";
    for (let i = 0; i < 400; i++) {
      const id = `s${i}`, inId = `s${i}-in`, outId = `s${i}-out`;
      p.blocks[id] = { ...structuredClone(p.blocks[br.blockId]), id, key: `C${i}`, title: `S${i}`, decisions: [], activity: null, status: "black" };
      delete p.blocks[id].branch;
      p.ports[inId] = { id: inId, blockId: id, direction: "in", name: `in${i}`, description: "", required: true, artifacts: [] };
      p.ports[outId] = { id: outId, blockId: id, direction: "out", name: `out${i}`, description: "", required: true, artifacts: [] };
      p.edges[`e${i}`] = { id: `e${i}`, from: { portId: prev, side: "outer" }, to: { portId: inId, side: "outer" }, kind: "sibling", auto: false };
      prev = outId; last = id;
    }
    p = answerDecision(p, br.blockId, br.decisionId, "A", "human");
    const started = performance.now();
    const s = branchState(p);
    const ms = performance.now() - started;
    expect(s.skipped.has(last)).toBe(true);
    expect(s.skipped.size).toBe(400);
    expect(ms).toBeLessThan(500);
  });
});

describe("答えの文面を直したとき", () => {
  it("選択肢の答えを自由記述に直すと未着手に戻り、自由記述から選択肢に直すと完了になる", async () => {
    const { editDecisionAnswer } = await import("./graph");
    let { p, br } = fixture();
    p = answerDecision(p, br.blockId, br.decisionId, "REST", "human");
    p = editDecisionAnswer(p, br.blockId, br.decisionId, "まだ迷っている", "human");
    expect(p.blocks[br.blockId].status).toBe("black");
    p = editDecisionAnswer(p, br.blockId, br.decisionId, "GraphQL", "human");
    expect(p.blocks[br.blockId].status).toBe("white");
    expect(chosenOption(p.blocks[br.blockId])).toBe("GraphQL");
  });
});

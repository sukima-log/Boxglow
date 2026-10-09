import { describe, expect, it } from "vitest";
import { addBlock, addPort, connect, createProject, portsOf, projectBlocks, updatePort } from "./graph";
import { blockSize, taskCardLayout, taskCardPorts } from "./size";

describe("全体図の縦型カード", () => {
  const setup = () => {
    const p = createProject("比較");
    const added = addBlock(p, { parentId: projectBlocks(p)[0].id, title: "画面を実装する", position: { x: 120, y: 96 } });
    return { p: added.project, id: added.blockId };
  };
  it("複数入力の下に出力を置き、全端点が別の行の中央に収まる", () => {
    let { p, id } = setup();
    for (const name of ["画面仕様", "API仕様"]) p = addPort(p, { blockId: id, direction: "in", name }).project;
    const c = taskCardLayout(p, id);
    expect(c.inputs).toHaveLength(2);
    expect(c.outputs[0].top).toBeGreaterThanOrEqual(c.inputs[1].top + c.inputs[1].height);
    for (const row of [...c.inputs, ...c.outputs]) {
      expect(row.center).toBeGreaterThan(c.headerH);
      expect(row.center).toBeLessThan(c.height);
      expect(row.center).toBe(row.top + row.height / 2);
    }
    expect(blockSize(p, id).height).toBe(c.height);
  });
  it("長い入出力名は横に際限なく広げず、高さを増やす", () => {
    let { p, id } = setup();
    const out = portsOf(p, id, "out")[0];
    const before = taskCardLayout(p, id);
    p = updatePort(p, out.id, { name: "確認を必要とする長い成果物の説明".repeat(12) });
    const after = taskCardLayout(p, id);
    expect(after.width).toBeLessThanOrEqual(360);
    expect(after.outputs[0].height).toBeGreaterThan(before.outputs[0].height);
    expect(after.height).toBeGreaterThan(before.height);
  });
  it("分類と長い題名、判断待ち・活動にそれぞれの場所を確保する", () => {
    const { p, id } = setup();
    const before = taskCardLayout(p, id);
    const q = structuredClone(p);
    q.blocks[id].title = "設計と実装の判断を読み返す".repeat(8);
    q.blocks[id].activity = { actor: "codex", state: "needs_decision", note: "確認", since: "2026-10-09T00:00:00Z" };
    q.blocks[id].decisions = [{ id: "ask", question: "実装方針", options: [], askedBy: "codex", askedAt: "2026-10-09T00:00:00Z" }];
    const after = taskCardLayout(q, id);
    expect(after.metaH).toBe(before.metaH);
    expect(after.headerH - after.metaH).toBeGreaterThan(before.headerH - before.metaH);
  });
  it("受け持ち・活動・判断が変わっても隣のタスクを動かす寸法変更は起こさない", () => {
    const { p, id } = setup();
    const before = taskCardLayout(p, id);
    p.claimPolicy = { mode: "reject", leaseMinutes: 30 };
    p.blocks[id].activity = { actor: "codex", state: "working", note: "実装", since: "2026-10-09T00:00:00Z" };
    p.blocks[id].decisions = [{ id: "ask", question: "実装方針", options: [], askedBy: "codex", askedAt: "2026-10-09T00:00:00Z" }];
    p.blocks[id].dueDate = "2026-12-01";
    expect(taskCardLayout(p, id)).toEqual(before);
  });
  it("入出力の行を接続相手の上下順に並べ、保存順は変えない", () => {
    let { p, id } = setup();
    const parentId = p.blocks[id].parentId!;
    const low = addBlock(p, { parentId, title: "下の供給元", position: { x: 120, y: 600 } }); p = low.project;
    const high = addBlock(p, { parentId, title: "上の供給元", position: { x: 120, y: 96 } }); p = high.project;
    const first = addPort(p, { blockId: id, direction: "in", name: "下の成果物" }); p = first.project;
    const second = addPort(p, { blockId: id, direction: "in", name: "上の成果物" }); p = second.project;
    p = connect(p, { portId: portsOf(p, low.blockId, "out")[0].id, side: "outer" }, { portId: first.portId, side: "outer" }).project;
    p = connect(p, { portId: portsOf(p, high.blockId, "out")[0].id, side: "outer" }, { portId: second.portId, side: "outer" }).project;
    const before = JSON.stringify(p);
    expect(taskCardPorts(p, id, "in").map(q => q.id)).toEqual([second.portId, first.portId]);
    expect(taskCardLayout(p, id).inputs.map(q => q.id)).toEqual([second.portId, first.portId]);
    expect(JSON.stringify(p)).toBe(before);
  });
  it("計測は保存済みの位置・接続・状態を書き換えない", () => {
    const { p, id } = setup();
    const before = JSON.stringify(p);
    taskCardLayout(p, id); blockSize(p, id);
    expect(JSON.stringify(p)).toBe(before);
  });
});

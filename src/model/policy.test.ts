/**
 * 方針 (全体に効く決定を、線を引かずに範囲へ配る) の確認
 *   範囲・待ち・参考・受け取らない・完了後の変化・文脈 (context) への載り方
 */
import { describe, expect, it } from "vitest";
import { addBlock, addPort, connect, changedPolicies, createProject, finishBlock, policiesFor, portsOf, projectBlocks, setPolicy, setPolicyOptOut, waitingFor } from "./graph";
import { agentContext, briefContext } from "./context";
import { ROOT_ID } from "./types";

/** 計画: 技術選定 (方針の箱) と、別の大項目「モデリング」の中に 2 つの箱 */
function fixture() {
  let p = createProject("t");
  const pj = projectBlocks(p)[0].id;
  const tech = addBlock(p, { parentId: pj, title: "技術選定", outputName: "ゲームエンジン" }); p = tech.project;
  const mod = addBlock(p, { parentId: pj, title: "モデリング" }); p = mod.project;
  const a = addBlock(p, { parentId: mod.blockId, title: "人物" }); p = a.project;
  const b = addBlock(p, { parentId: mod.blockId, title: "背景" }); p = b.project;
  const engine = portsOf(p, tech.blockId, "out")[0];
  return { p, pj, tech: tech.blockId, mod: mod.blockId, a: a.blockId, b: b.blockId, engine: engine.id };
}

describe("方針", () => {
  it("同じ親の中 (既定) に、線なしで全階層へ届く。方針の箱そのものには届かない", () => {
    let { p, tech, mod, a, b, engine } = fixture();
    p = setPolicy(p, engine, {});
    for (const id of [mod, a, b]) expect(policiesFor(p, id).map((q) => q.id)).toEqual([engine]);
    expect(policiesFor(p, tech)).toHaveLength(0);
    expect(Object.values(p.edges).some((e) => e.from.portId === engine)).toBe(false); // 線は引かない
  });

  it("決まるまで範囲の箱は「方針待ち」。参考なら待たせない。決まれば待ちが消える", () => {
    let { p, tech, a, engine } = fixture();
    p = setPolicy(p, engine, {});
    expect(waitingFor(p, a)).toContain("方針「ゲームエンジン」");
    expect(waitingFor(setPolicy(p, engine, { advisory: true }), a)).not.toContain("方針「ゲームエンジン」");
    p = finishBlock(p, tech, "human", { artifacts: [{ title: "Unity 6", url: "docs/engine.md" }] }).project;
    expect(waitingFor(p, a)).not.toContain("方針「ゲームエンジン」");
  });

  it("範囲を絞れる (その箱の中だけ)。計画全体にもできる。箱ごとに受け取らないこともできる", () => {
    let { p, pj, mod, a, b, engine } = fixture();
    const other = addBlock(p, { parentId: pj, title: "音響" }); p = other.project;
    p = setPolicy(p, engine, { scope: mod });
    expect(policiesFor(p, a)).toHaveLength(1);
    expect(policiesFor(p, other.blockId)).toHaveLength(0);
    p = setPolicy(p, engine, { scope: ROOT_ID });
    expect(policiesFor(p, other.blockId)).toHaveLength(1);
    p = setPolicyOptOut(p, b, engine, true);
    expect(policiesFor(p, b)).toHaveLength(0);
    expect(p.blocks[b].policyOptOut).toEqual([engine]);
    p = setPolicyOptOut(p, b, engine, false);
    expect(p.blocks[b].policyOptOut).toBeUndefined();
  });

  it("方針の箱の上流 (材料を作る箱) には届かない (お互いに待ち合わないように)", () => {
    let { p, pj, tech, engine } = fixture();
    const req = addBlock(p, { parentId: pj, title: "要件", outputName: "要件一覧" }); p = req.project;
    const techIn = addPort(p, { blockId: tech, direction: "in", name: "要件一覧" }); p = techIn.project;
    p = connect(p, { portId: portsOf(p, req.blockId, "out")[0].id, side: "outer" }, { portId: techIn.portId, side: "outer" }).project;
    p = setPolicy(p, engine, {});
    expect(policiesFor(p, req.blockId)).toHaveLength(0);
  });

  it("完了した後に方針が変わると「方針が変わった」になる", () => {
    let { p, tech, a, engine } = fixture();
    p = setPolicy(p, engine, {});
    p = finishBlock(p, tech, "human", { artifacts: [{ title: "Unity 6", url: "docs/engine.md" }] }).project;
    p = finishBlock(p, a, "human", { artifacts: [{ title: "人物.fbx", url: "a.fbx" }] }).project;
    expect(changedPolicies(p, a)).toHaveLength(0);
    p = finishBlock(p, tech, "human", { artifacts: [{ title: "Unreal 5", url: "docs/engine2.md" }] }).project;
    expect(changedPolicies(p, a).map((q) => q.name)).toEqual(["ゲームエンジン"]);
  });

  it("文脈 (context) に方針の中身が入る (省略版も)", () => {
    let { p, tech, a, engine } = fixture();
    p = setPolicy(p, engine, {});
    p = finishBlock(p, tech, "human", { artifacts: [{ title: "Unity 6", url: "docs/engine.md" }] }).project;
    const full = agentContext(p, a);
    expect(full.policies).toEqual([expect.objectContaining({ title: "技術選定", name: "ゲームエンジン", ready: true, artifacts: [{ title: "Unity 6", url: "docs/engine.md" }] })]);
    expect(briefContext(p, a).policies).toEqual(full.policies);
  });
});

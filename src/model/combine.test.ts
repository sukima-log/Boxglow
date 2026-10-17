/**
 * 計画のファイルの結合と分割 (src/model/combine.ts) の試験
 */
import { describe, expect, it } from "vitest";
import { addBlock, addProjectBlock, createProject, defaultTaskParent, fromJSON, toJSON, updateBlock, projectBlocks } from "./graph";
import { combineProjects, splitProject, subtreeIds } from "./combine";
import { ROOT_ID, type Project } from "./types";

/** 箱 1 つ (担当・判断・記録つき) を持つ計画 */
function plan(name: string, member: string): { p: Project; blockId: string } {
  let p = createProject(name);
  p = { ...p, members: [{ id: "m-" + member, name: member, color: "#000" }] };
  const a = addBlock(p, { parentId: defaultTaskParent(p), title: name + " の箱" }); p = a.project;
  p = updateBlock(p, a.blockId, { assigneeIds: ["m-" + member], status: "gray" });
  p.blocks[a.blockId].decisions = [{ id: "d-" + name, question: "どちら?", options: ["A", "B"], askedBy: "ai", askedAt: "2026-10-18T00:00:00.000Z" }];
  p.blocks[a.blockId].artifacts = [{ id: "art-" + name, title: "成果物", url: "https://example.test/" + name, kind: "url", addedAt: "2026-10-18T00:00:00.000Z" } as never];
  p.log = [{ id: "log-" + name, at: "2026-10-18T00:00:00.000Z", actor: "ai", kind: "started", blockId: a.blockId, message: name + " を始めた" }];
  p.now = [{ blockId: a.blockId, by: "ai", at: "2026-10-18T00:00:00.000Z" }];
  p.handoffs = { [a.blockId]: { note: "引き継ぎ " + name, actor: "ai", at: "2026-10-18T00:00:00.000Z" } };
  return { p, blockId: a.blockId };
}

describe("結合", () => {
  it("別々に作った 2 つの計画を 1 つにまとめる: ID と番号が重なっても壊れず、メンバーは名前で合い、判断・成果物・記録・NOW・引き継ぎが残る", () => {
    const A = plan("A", "太郎"), B = plan("B", "太郎");
    // 同じ ID の箱・ポート・線になるように、B を A の複製から作り直す (ID の衝突を再現)
    const Bsame = fromJSON(toJSON(A.p).replaceAll("A の箱", "B の箱").replace('"name":"A"', '"name":"B"'));
    const q = combineProjects(A.p, Bsame, "B.json");
    expect(projectBlocks(q).length).toBe(2);
    const titles = Object.values(q.blocks).map((b) => b.title);
    expect(titles).toContain("A の箱"); expect(titles).toContain("B の箱");
    // ID は全部一意、番号 B<n> も一意
    const keys = Object.values(q.blocks).map((b) => b.key).filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(q.blocks).length).toBe(Object.keys(A.p.blocks).length * 2 - 1);
    // メンバー「太郎」は 1 人にまとまり、両方の箱の担当になっている
    expect(q.members.filter((m) => m.name === "太郎").length).toBe(1);
    const taro = q.members[0].id;
    expect(Object.values(q.blocks).filter((b) => b.assigneeIds.includes(taro)).length).toBe(2);
    // 判断・成果物・記録・NOW・引き継ぎ
    expect(Object.values(q.blocks).flatMap((b) => b.decisions).length).toBe(2);
    expect(Object.values(q.blocks).flatMap((b) => b.artifacts).length).toBe(2);
    expect(q.log.filter((e) => e.kind === "started").length).toBe(2);
    expect(q.log.at(-1)?.message).toContain("結合");
    expect(q.now?.length).toBe(2);
    expect(Object.keys(q.handoffs ?? {}).length).toBe(2);
    // 線 (子の出力 → 親の出力 → 最終成果物) も両方残り、参照が切れていない
    for (const e of Object.values(q.edges)) { expect(q.ports[e.from.portId]).toBeTruthy(); expect(q.ports[e.to.portId]).toBeTruthy(); }
    for (const port of Object.values(q.ports)) expect(q.blocks[port.blockId]).toBeTruthy();
    // 往復 (JSON) しても壊れない
    expect(() => fromJSON(toJSON(q))).not.toThrow();
    expect(B.p).toBeTruthy();
  });
});

describe("分割", () => {
  it("プロジェクトの箱を切り出す: またぐ線は両側の最上位ノードに由来つきで残り、記録や NOW は中のものだけ移る。結合し直すと内容が戻る", () => {
    const A = plan("A", "太郎");
    let p = A.p;
    // 2 つ目のプロジェクト B を足し、A の箱の出力を B の箱の入力につなぐ (プロジェクトをまたぐ線)
    const pb = addProjectBlock(p, "B"); p = pb.project;
    const b = addBlock(p, { parentId: pb.blockId, title: "B の箱" }); p = b.project;
    const aOut = Object.values(p.ports).find((x) => x.blockId === A.blockId && x.direction === "out")!;
    const bIn = { id: "port-b-in", blockId: b.blockId, direction: "in" as const, name: "A から", description: "", required: true, artifacts: [] };
    p.ports[bIn.id] = bIn;
    p.edges["e-cross"] = { id: "e-cross", from: { portId: aOut.id, side: "outer" }, to: { portId: bIn.id, side: "outer" }, kind: "sibling", auto: false };
    const before = Object.keys(p.blocks).length;
    const { remaining, extracted } = splitProject(p, pb.blockId);
    // 箱の数が保たれる (ROOT は両方にある)
    expect(Object.keys(remaining.blocks).length + Object.keys(extracted.blocks).length - 1).toBe(before);
    expect(extracted.name).toBe("B");
    expect(projectBlocks(extracted).length).toBe(1);
    expect(projectBlocks(remaining).length).toBe(1);
    // またぐ線: 切り出し側に「元: A / A の箱」の最上位の入力ができ、B の箱の入力につながる。残す側には「行き先: B / B の箱」の最上位の出力ができる
    const exIn = Object.values(extracted.ports).find((x) => x.blockId === ROOT_ID && x.direction === "in")!;
    expect(exIn.description).toContain("元:");
    expect(Object.values(extracted.edges).some((e) => e.from.portId === exIn.id && e.to.portId === bIn.id)).toBe(true);
    const remOut = Object.values(remaining.ports).find((x) => x.blockId === ROOT_ID && x.direction === "out" && x.description.includes("行き先"))!;
    expect(remOut).toBeTruthy();
    expect(Object.values(remaining.edges).some((e) => e.from.portId === aOut.id && e.to.portId === remOut.id)).toBe(true);
    // 参照が切れていない
    for (const q of [remaining, extracted]) { for (const e of Object.values(q.edges)) { expect(q.ports[e.from.portId]).toBeTruthy(); expect(q.ports[e.to.portId]).toBeTruthy(); } for (const port of Object.values(q.ports)) expect(q.blocks[port.blockId]).toBeTruthy(); }
    // 記録・NOW・引き継ぎは A の箱のものなので残す側に残り、切り出し側には分割の記録だけ
    expect(remaining.log.some((e) => e.kind === "started")).toBe(true);
    expect(extracted.log.some((e) => e.kind === "started")).toBe(false);
    expect(remaining.now?.length).toBe(1);
    expect(extracted.now?.length ?? 0).toBe(0);
    expect(subtreeIds(extracted, pb.blockId).has(b.blockId)).toBe(true);
    // 結合し直す: 箱の題名がそろい、ファイルとして読める
    const back = combineProjects(remaining, extracted);
    const titles = Object.values(back.blocks).map((x) => x.title);
    expect(titles).toContain("A の箱"); expect(titles).toContain("B の箱");
    expect(() => fromJSON(toJSON(back))).not.toThrow();
    // 1 つだけの計画は分けられない
    expect(() => splitProject(A.p, defaultTaskParent(A.p))).toThrow();
  });
});

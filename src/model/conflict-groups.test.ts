import { setLang } from "../i18n/core";
/** ブロックの所属・依存と、選択を一切適用できない境界を実際の三方向マージで確かめる。 */
import { expect, it } from "vitest";
import {
  addBlock,
  createProject,
  defaultTaskParent,
  fromJSON,
  toJSON,
  removeBlock,
  updateBlock,
  portsOf,
} from "./graph";
import { mergeProjects } from "./merge";
import {
  groupConflicts,
  renderConflictValue,
  resolveGroupChoices,
  parseConflictResolution,
  blockResolutionKey,
  type ConflictReview,
} from "./conflict-groups";
import { projectProblem } from "./validate-file";

/** 入力なし。出力: 独立したブロック2つと、その正規化済みの計画。 */
function fixture() {
  const initial = createProject("Plan");
  const a = addBlock(initial, {
    parentId: defaultTaskParent(initial),
    title: "A",
  });
  const b = addBlock(a.project, {
    parentId: defaultTaskParent(a.project),
    title: "B",
  });
  return { p: fromJSON(toJSON(b.project)), a: a.blockId, b: b.blockId };
}
it("ブロックごとに別の側を選び、設定と非競合の変更を保持する", () => {
  const { p, a, b } = fixture();
  const local = updateBlock(
    updateBlock(p, a, { title: "A local", description: "keep" }),
    b,
    { title: "B local" },
  );
  const remote = updateBlock(updateBlock(p, a, { title: "A remote" }), b, {
    title: "B remote",
  });
  local.name = "Local plan";
  remote.name = "Remote plan";
  const review: ConflictReview = {
    version: 1,
    token: "current",
    groups: groupConflicts(
      p,
      local,
      remote,
      mergeProjects(p, local, remote).conflicts,
    ),
  };
  expect(review.groups).toHaveLength(3);
  expect(
    review.groups.find((g) => g.id === blockResolutionKey(a))!.fields[0],
  ).toMatchObject({
    label: "題名",
    localText: "A local",
    remoteText: "A remote",
  });
  const resolved = resolveGroupChoices(review, {
    version: 1,
    token: review.token,
    groups: {
      [blockResolutionKey(a)]: "local",
      [blockResolutionKey(b)]: "remote",
      settings: "remote",
    },
  });
  if (!("choices" in resolved)) throw new Error(resolved.error);
  const merged = mergeProjects(p, local, remote, resolved.choices).project;
  expect(merged.blocks[a].title).toBe("A local");
  expect(merged.blocks[b].title).toBe("B remote");
  expect(merged.blocks[a].description).toBe("keep");
  expect(merged.name).toBe("Remote plan");
  expect(projectProblem(merged)).toBeNull();
});

it("ポート・成果物・判断・引き継ぎは所属ブロック、配線は両端の依存グループになる", () => {
  const { p, a, b } = fixture();
  p.ports.input = {
    id: "input",
    blockId: b,
    direction: "in",
    name: "Input",
    description: "",
    required: true,
    artifacts: [],
  };
  const out = portsOf(p, a, "out")[0],
    input = p.ports.input;
  p.edges.test = {
    id: "test",
    from: { portId: out.id, side: "outer" },
    to: { portId: input.id, side: "outer" },
    kind: "sibling",
    auto: false,
  };
  const local = structuredClone(p),
    remote = structuredClone(p);
  local.ports[out.id].name = "local output";
  remote.ports[out.id].name = "remote output";
  local.blocks[a].artifacts = [
    { id: "x", title: "local", kind: "file", url: "", note: "", path: "x" },
  ];
  remote.blocks[a].artifacts = [
    { id: "y", title: "remote", kind: "file", url: "", note: "", path: "y" },
  ];
  local.handoffs = { [a]: { note: "local", actor: "a", at: "now" } };
  remote.handoffs = { [a]: { note: "remote", actor: "b", at: "now" } };
  // 両端を変えた線は、元・手元・相手のすべての端点に所属する。
  local.edges.test.kind = "up";
  remote.edges.test.kind = "down";
  const groups = groupConflicts(
    p,
    local,
    remote,
    mergeProjects(p, local, remote).conflicts,
  );
  expect(groups).toHaveLength(1);
  expect(groups[0].blocks.map((b) => b.id).sort()).toEqual([a, b].sort());
  expect(groups[0].fields.some((f) => f.label.endsWith("引き継ぎメモ"))).toBe(
    true,
  );
  expect(groups[0].fields.some((f) => f.label.endsWith("成果物"))).toBe(true);
  const review: ConflictReview = { version: 1, token: "t", groups };
  expect(
    resolveGroupChoices(review, {
      version: 1,
      token: "t",
      groups: {
        [blockResolutionKey(a)]: "local",
        [blockResolutionKey(b)]: "remote",
      },
    }),
  ).toHaveProperty("error");
});

it.each([false, true])(
  "親削除と子編集を一緒に確認し、削除/保持を明示して決める (反転=%s)",
  (reversed) => {
    const { p, a } = fixture();
    const child = addBlock(p, { parentId: a, title: "Child" });
    const base = fromJSON(toJSON(child.project));
    const deleted = removeBlock(base, a),
      edited = updateBlock(base, child.blockId, { title: "Child edited" });
    const local = reversed ? edited : deleted,
      remote = reversed ? deleted : edited;
    const review: ConflictReview = {
      version: 1,
      token: "t",
      groups: groupConflicts(
        base,
        local,
        remote,
        mergeProjects(base, local, remote).conflicts,
      ),
    };
    expect(review.groups).toHaveLength(1);
    expect(review.groups[0].structural).toBe(true);
    expect(review.groups[0].blocks.map((b) => b.id)).toEqual(
      expect.arrayContaining([a, child.blockId]),
    );
    expect(
      resolveGroupChoices(review, { version: 1, token: "t", groups: {} }),
    ).toHaveProperty("error");
    for (const prefer of ["local", "remote"] as const) {
      const choices = resolveGroupChoices(review, { token: "t", prefer });
      if (!("choices" in choices)) throw new Error(choices.error);
      const merged = mergeProjects(
        base,
        local,
        remote,
        choices.choices,
      ).project;
      expect(!!merged.blocks[a]).toBe(
        prefer === (reversed ? "local" : "remote"),
      );
      expect(projectProblem(merged)).toBeNull();
    }
  },
);

it("古い印・欠落・未知キー・二重指定を拒否し、項目別の選択を許す", () => {
  const { p, a } = fixture();
  const l = updateBlock(p, a, { title: "L", description: "LD" }),
    r = updateBlock(p, a, { title: "R", description: "RD" });
  const review: ConflictReview = {
    version: 1,
    token: "t",
    groups: groupConflicts(p, l, r, mergeProjects(p, l, r).conflicts),
  };
  const [first, second] = review.groups[0].fields;
  const request = {
    version: 1 as const,
    token: "t",
    groups: {},
    fields: { [first.id]: "local" as const, [second.id]: "remote" as const },
  };
  expect(resolveGroupChoices(review, request)).toHaveProperty("choices");
  for (const invalid of [
    { ...request, token: "old" },
    { ...request, fields: { [first.id]: "local" as const } },
    { ...request, groups: { bad: "local" as const } },
    { ...request, groups: { [review.groups[0].id]: "local" as const } },
  ])
    expect(resolveGroupChoices(review, invalid)).toHaveProperty("error");
  expect(parseConflictResolution({ ...request, version: 2 })).toBeNull();
  expect(parseConflictResolution({ ...request, groups: [] })).toBeNull();
  expect(parseConflictResolution({ ...request, prefer: "local" })).toBeNull();
});

it("親移動の競合は移動元・移動先と子の変更を同じ判断に含める", () => {
  const { p, a, b } = fixture();
  const c = addBlock(p, { parentId: a, title: "Child" });
  const d = addBlock(c.project, {
    parentId: defaultTaskParent(c.project),
    title: "Other parent",
  });
  const base = fromJSON(toJSON(d.project)),
    local = structuredClone(base),
    remote = structuredClone(base);
  local.blocks[c.blockId].parentId = b;
  remote.blocks[c.blockId].parentId = d.blockId;
  local.blocks[a].title = "Local parent";
  remote.blocks[a].title = "Remote parent";
  const groups = groupConflicts(
    base,
    local,
    remote,
    mergeProjects(base, local, remote).conflicts,
  );
  expect(groups).toHaveLength(1);
  expect(groups[0].structural).toBe(true);
  expect(groups[0].blocks.map((b) => b.id)).toEqual(
    expect.arrayContaining([a, b, c.blockId, d.blockId]),
  );
  // 名前やB番号ではなく内部IDを使う。同じ競合を逆順に列挙しても集合は変わらない。
  expect(
    groupConflicts(
      base,
      local,
      remote,
      mergeProjects(base, local, remote).conflicts.reverse(),
    ).map((g) => g.id),
  ).toEqual(groups.map((g) => g.id));
});

it("比較の値はホストと画面で別の言語を使っても、利用者の文面を翻訳しない", () => {
  const { p, a } = fixture();
  const local = removeBlock(p, a),
    remote = updateBlock(p, a, { title: "人が書いた題名" });
  setLang("ja");
  const group = groupConflicts(
    p,
    local,
    remote,
    mergeProjects(p, local, remote).conflicts,
  )[0];
  expect(group.deleted?.local).toBe(1);
  const field = group.fields.find(
    (f) => f.id === JSON.stringify(["blocks", a]),
  )!;
  try {
    setLang("en");
    expect(renderConflictValue(field.localDisplay!)).toBe("Deleted");
    const text = renderConflictValue(field.remoteDisplay!);
    expect(text).toContain("Title: 人が書いた題名");
    expect(text).not.toContain(a);
  } finally {
    setLang("ja");
  }
});

it("古いファイルの所属不明な引き継ぎメモも設定として比較できる", () => {
  const { p } = fixture(),
    local = structuredClone(p),
    remote = structuredClone(p);
  local.handoffs = { missing: { note: "Local", actor: "a", at: "now" } };
  remote.handoffs = { missing: { note: "Remote", actor: "b", at: "now" } };
  const groups = groupConflicts(
    p,
    local,
    remote,
    mergeProjects(p, local, remote).conflicts,
  );
  expect(groups).toHaveLength(1);
  expect(groups[0].settings).toBe(true);
  expect(groups[0].fields[0].localText).toContain("Local");
});

it.each(["members", "inputGroups"] as const)("%sと参照元を独立に選び、存在しない参照を正規化する", kind => {
  const { p, a } = fixture();
  const port = portsOf(p, a, "out")[0];
  if (kind === "members") p.members = [{ id: "m", name: "M", color: "red" }, { id: "n", name: "N", color: "blue" }];
  else p.inputGroups = [{ id: "m", name: "M", description: "", position: { x: 0, y: 0 } }, { id: "n", name: "N", description: "", position: { x: 0, y: 0 } }];
  const local = structuredClone(p), remote = structuredClone(p);
  if (kind === "members") local.members = local.members.filter(v => v.id !== "m");
  else local.inputGroups = local.inputGroups!.filter(v => v.id !== "m");
  remote[kind]![0].name = "Renamed";
  if (kind === "members") { local.blocks[a].assigneeIds = ["n"]; remote.blocks[a].assigneeIds = ["m"]; }
  else { local.ports[port.id].groupId = "n"; remote.ports[port.id].groupId = "m"; }
  const groups = groupConflicts(p, local, remote, mergeProjects(p, local, remote).conflicts);
  expect(groups).toHaveLength(2);
  expect(groups.some(g => g.settings)).toBe(true);
  const choices = Object.fromEntries(groups.flatMap(g => g.fields).map(f => [f.id, f.path.startsWith(kind) ? "ours" as const : "theirs" as const]));
  const merged = mergeProjects(p, local, remote, choices).project;
  expect(projectProblem(merged)).toBeNull();
  if (kind === "members") expect(merged.blocks[a].assigneeIds).toEqual([]);
  else expect(merged.ports[port.id].groupId).toBeUndefined();
});

it.each([false, true])("削除と新しい子がある場合、表示件数は復元後の実結果と一致する (反転=%s)", reversed => {
  const { p, a } = fixture();
  const child = addBlock(p, { parentId: a, title: "C" });
  const base = fromJSON(toJSON(child.project));
  const edited = updateBlock(base, child.blockId, { title: "C local" });
  const added = addBlock(edited, { parentId: a, title: "N" });
  const deleted = removeBlock(base, a);
  const local = reversed ? deleted : added.project, remote = reversed ? added.project : deleted;
  const groups = groupConflicts(base, local, remote, mergeProjects(base, local, remote).conflicts);
  const side = reversed ? "local" : "remote";
  const group = groups[0];
  const resolved = resolveGroupChoices({ version: 1, token: "t", groups }, { token: "t", prefer: side });
  if (!("choices" in resolved)) throw Error(resolved.error);
  const result = mergeProjects(base, local, remote, resolved.choices).project;
  expect(group.deleted![side]).toBe(1);
  expect(result.blocks[child.blockId]).toBeUndefined();
  expect(result.blocks[a]).toBeDefined();
  expect(result.blocks[added.blockId]).toBeDefined();
  expect(group.retained![side]).toHaveLength(2);
  expect(group.retained![side].some(name => name.endsWith(" N"))).toBe(true);
});

it("promotedFromを通る配線とポートは昇格元の別ブロックも同じ依存グループにする", () => {
  const { p, a, b } = fixture();
  const out = portsOf(p, a, "out")[0], other = portsOf(p, b, "out")[0];
  p.ports[out.id].promotedFrom = other.id;
  p.edges.e = { id: "e", from: { portId: out.id, side: "outer" }, to: { portId: other.id, side: "outer" }, kind: "sibling", auto: false };
  const local = structuredClone(p), remote = structuredClone(p);
  local.ports[out.id].name = "L"; remote.ports[out.id].name = "R";
  local.blocks[b].title = "BL"; remote.blocks[b].title = "BR";
  local.edges.e.kind = "up"; remote.edges.e.kind = "down";
  const groups = groupConflicts(p, local, remote, mergeProjects(p, local, remote).conflicts);
  expect(groups).toHaveLength(1);
  expect(groups[0].blocks.map(v => v.id).sort()).toEqual([a,b].sort());
  expect(groups[0].fields.some(f => f.path.startsWith("edges."))).toBe(true);
});

it("メンバーの名前・色と不変の昇格ポートで独立したブロック競合をまとめない", () => {
  const { p, a, b } = fixture();
  p.members = [{ id: "m", name: "M", color: "red" }];
  p.blocks[a].assigneeIds = ["m"]; p.blocks[b].assigneeIds = ["m"];
  const local = structuredClone(p), remote = structuredClone(p);
  local.members[0].name = "Renamed"; local.members[0].color = "blue";
  for (const id of [a, b]) { local.blocks[id].title = "Local"; remote.blocks[id].title = "Remote"; }
  local.name = "Local plan"; remote.name = "Remote plan";
  const groups = groupConflicts(p, local, remote, mergeProjects(p, local, remote).conflicts);
  expect(groups).toHaveLength(3);
  expect(groups.filter(g => g.blocks.length).every(g => g.blocks.length === 1 && !g.settings)).toBe(true);
});

it.each(["ja", "en"] as const)("削除された担当を名前付きの安定したログに残す (%s)", lang => {
  const { p, a } = fixture(); p.members = [{ id: "m", name: "Member M", color: "red" }];
  const local = structuredClone(p), remote = structuredClone(p);
  local.members = []; remote.blocks[a].assigneeIds = ["m"];
  const before = [toJSON(local), toJSON(remote)];
  setLang(lang);
  try {
    const result = mergeProjects(p, local, remote);
    expect(result.conflicts.filter(c => !c.automatic)).toHaveLength(0);
    expect(result.project.blocks[a].assigneeIds).toEqual([]);
    const cleanup = result.project.log.filter(e => e.id.startsWith("merge:unassign:"));
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0].message).toContain("Member M"); expect(cleanup[0].message).toContain("A");
    expect(cleanup[0].message).toMatch(lang === "ja" ? /担当.*外しました/ : /Removed.*assignees/);
    expect(mergeProjects(p, local, remote).project.log).toEqual(result.project.log);
    expect(mergeProjects(p, result.project, remote).project.log).toEqual(result.project.log);
    expect([toJSON(local), toJSON(remote)]).toEqual(before);
  } finally { setLang("ja"); }
});

it.each([false, true])("メンバー削除の比較は担当解除の上限を削除側だけに出す (反転=%s)", reversed => {
  const { p, a, b } = fixture(); p.members = [{ id: "m", name: "M", color: "red" }];
  const deleted = structuredClone(p), kept = structuredClone(p);
  deleted.members = []; kept.members[0].name = "M edited";
  kept.blocks[a].assigneeIds = ["m"]; kept.blocks[b].assigneeIds = ["m"];
  deleted.blocks[a].title = "A local"; kept.blocks[a].title = "A remote";
  const local = reversed ? kept : deleted, remote = reversed ? deleted : kept;
  const groups = groupConflicts(p, local, remote, mergeProjects(p, local, remote).conflicts);
  const field = groups.find(g => g.settings)!.fields.find(f => f.path.startsWith("members"))!;
  expect(field.unassigned).toEqual(reversed ? {local: 0, remote: 2} : {local: 2, remote: 0});
  const choices = Object.fromEntries(groups.flatMap(g => g.fields.map(f => [f.id, g.settings ? (reversed ? "theirs" : "ours") : (reversed ? "ours" : "theirs")])));
  const result = mergeProjects(p, local, remote, choices as Record<string, "ours" | "theirs">).project;
  expect(result.blocks[a].assigneeIds).toEqual([]); expect(result.blocks[b].assigneeIds).toEqual([]);
  expect(result.log.filter(e => e.id.startsWith("merge:unassign:"))).toHaveLength(2);
});

it("担当解除は注入した実時刻・次の発生・確定後のB番号を記録する", () => {
  const { p, a } = fixture(); p.members = [{ id: "m", name: "M", color: "red" }];
  const local = structuredClone(p), remote = structuredClone(p); local.members = []; remote.blocks[a].assigneeIds = ["m"];
  const at1 = "2026-10-08T00:00:00.000Z", at2 = "2026-10-08T01:00:00.000Z";
  const first = mergeProjects(p, local, remote, {}, at1).project;
  expect(first.log.at(-1)!.at).toBe(at1);
  expect(mergeProjects(p, first, remote, {}, at2).project.log).toEqual(first.log); // 同じ比較の再試行。
  const base2 = structuredClone(first); base2.members = p.members;
  const local2 = structuredClone(base2), remote2 = structuredClone(base2); local2.members = []; remote2.blocks[a].assigneeIds = ["m"];
  const second = mergeProjects(base2, local2, remote2, {}, at2).project;
  expect(second.log).toHaveLength(first.log.length + 1); expect(second.log.at(-1)!.at).toBe(at2);
  expect(new Set(second.log.map(e => e.id)).size).toBe(second.log.length);
  const added = addBlock(remote, {parentId: defaultTaskParent(remote), title: "Number collision"});
  added.project.blocks[added.blockId].key = p.blocks[a].key; added.project.blocks[added.blockId].assigneeIds = ["m"];
  const numbered = mergeProjects(p, local, added.project, {}, at2).project;
  const entry = numbered.log.find(e => e.blockId === added.blockId)!;
  expect(entry.message).toContain(numbered.blocks[added.blockId].key + " Number collision");
  expect(numbered.blocks[added.blockId].key).not.toBe(p.blocks[a].key);
});

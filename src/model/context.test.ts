/**
 * 短いコンテキスト (briefContext) の検査
 * 対象の情報は削らない・親と上流の有効な判断は残す・省いたものは件数で示す・確認トークンは全部の出力と同じ、を確かめる
 */
import { describe, expect, it } from "vitest";
import { addBlock, addPort, answerDecision, askDecision, connect, createArtifact, createProject, defaultTaskParent, editDecisionAnswer, portsOf, updateBlock } from "./graph";
import { agentContext, briefContext } from "./context";
import { briefReceipt, contextReceipt, requireContext } from "../../cli/context";
import type { Project } from "./types";

/**
 * 検査用の計画を作る
 * Input : なし
 * Output: { p = 計画, parent / upstream / target / child = 各ボックスの id }
 *   親 (範囲あり・説明あり・回答済みの判断あり) の中に、上流 (範囲なし・説明あり・出力に成果物) → 対象 (入力 2 つ) を置く
 */
function fixture() {
  let p: Project = createProject("Brief");
  const add = (parentId: string, title: string) => { const r = addBlock(p, { parentId, title, outputName: `${title}の出力` }); p = r.project; return r.blockId; };
  const parent = add(defaultTaskParent(p), "親");
  const upstream = add(parent, "上流");
  const target = add(parent, "対象");
  p = updateBlock(p, parent, { description: "親の長い説明", scope: { goal: "親の目的", nonGoals: "公開しない" } });
  p = updateBlock(p, upstream, { description: "上流の説明 (制約: 形式は JSON)" });
  p = updateBlock(p, target, { description: "対象の説明", scope: { goal: "対象の目的", acceptance: "検査が通る" } });
  // 判断: 親に回答済み (回答を 1 度直した = 履歴あり)、上流に未回答 (材料と選択肢つき)、対象に回答済みと未回答
  const ask = (id: string, question: string, options: string[] = [], context = "") => { const r = askDecision(p, id, "codex", question, options, context); p = r.project; return r.decisionId!; };
  const d1 = ask(parent, "保存先は?", ["A", "B"]);
  p = answerDecision(p, parent, d1, "A", "human");
  p = editDecisionAnswer(p, parent, d1, "B", "human");
  // (前の回答の記録。短い表示では省かれ、件数だけ出る)
  p.blocks[parent].decisions[0].history = [{ answer: "A", by: "human", at: "2026-10-04T00:00:00.000Z" }];
  ask(upstream, "形式は?", ["JSON", "YAML"], "上流の判断の材料");
  const d3 = ask(target, "名前は?");
  p = answerDecision(p, target, d3, "brief", "human");
  ask(target, "既定にする?", ["する", "しない"], "対象の判断の材料");
  // 上流の出力 → 対象 (線でつなぐ)。上流の出力に成果物を付ける
  const out = portsOf(p, upstream, "out")[0];
  out.artifacts = [createArtifact("仕様", "docs/spec.md")];
  const wired = addPort(p, { blockId: target, direction: "in", name: "上流の出力" }); p = wired.project;
  const c = connect(p, { portId: out.id, side: "outer" }, { portId: wired.portId, side: "outer" }); p = c.project;
  expect(c.error).toBeUndefined();
  // つながっていない必須の入力 (不足として出るはず)
  const lonely = addPort(p, { blockId: target, direction: "in", name: "未接続の入力" }); p = lonely.project;
  p.blocks[target].artifacts = [createArtifact("対象の資料", "docs/target.md")];
  p.handoffs = { [target]: { note: "次: 検査を足す", actor: "codex", at: "2026-10-05T00:00:00.000Z" }, [upstream]: { note: "上流の引き継ぎ", actor: "codex", at: "2026-10-05T00:00:00.000Z" } };
  return { p, parent, upstream, target };
}

describe("短いコンテキスト", () => {
  it("確認トークンは全部の出力と同じ (省いた部分が変わっても変わる)", () => {
    const { p, upstream, target } = fixture();
    expect(briefReceipt(p, target).contextToken).toBe(contextReceipt(p, target).contextToken);
    // 短い表示では省かれる「上流の引き継ぎ」を変えても、トークンは変わる
    const q = structuredClone(p); q.handoffs![upstream].note = "上流の引き継ぎを更新";
    expect(JSON.stringify(briefContext(q, target))).toBe(JSON.stringify(briefContext(p, target)));
    expect(briefReceipt(q, target).contextToken).not.toBe(briefReceipt(p, target).contextToken);
  });

  it("対象の情報は削らない: 説明・範囲・判断・引き継ぎ・入出力・成果物", () => {
    const { p, target } = fixture();
    const c = briefContext(p, target);
    expect(c.brief).toBe(true);
    expect(c.workScope.target).toEqual({ goal: "対象の目的", acceptance: "検査が通る" });
    expect(c.workScope.parents.map((x) => x.scope?.nonGoals)).toContain("公開しない");
    expect(c.target.description).toBe("対象の説明");
    expect(c.target.decisions).toEqual([expect.objectContaining({ question: "名前は?", answer: "brief" })]);
    // 対象の未回答の質問は、材料と選択肢も付ける
    expect(c.target.openQuestions).toEqual([expect.objectContaining({ question: "既定にする?", options: ["する", "しない"], context: "対象の判断の材料" })]);
    expect(c.target.handoff?.note).toBe("次: 検査を足す");
    expect(c.target.artifacts.map((a) => a.url)).toEqual(["docs/target.md"]);
    expect(c.target.outputs.map((o) => o.name)).toEqual(["対象の出力"]);
  });

  it("入力ごとに、供給元の出力・成果物・用意できているかを示し、不足を先頭にまとめる", () => {
    const { p, upstream, target } = fixture();
    const c = briefContext(p, target);
    const wired = c.target.inputs.find((i) => i.name === "上流の出力")!;
    expect(wired.sources).toEqual([expect.objectContaining({ title: "上流", output: "上流の出力" })]);
    expect(wired.sources[0].artifacts.map((a) => a.url)).toEqual(["docs/spec.md"]);
    // 出力に成果物が付いているので、用意できている
    expect(wired.ready).toBe(true);
    expect(c.target.missingInputs).toEqual(["未接続の入力"]);
    // 成果物を外すと、上流が未完了なので不足になる。完了にすると用意できる
    const q = structuredClone(p); portsOf(q, upstream, "out")[0].artifacts = [];
    expect(briefContext(q, target).target.missingInputs).toEqual(["上流の出力", "未接続の入力"]);
    q.blocks[upstream].status = "white";
    expect(briefContext(q, target).target.missingInputs).toEqual(["未接続の入力"]);
    // 任意の入力は、不足に数えない
    const lonely = portsOf(q, target, "in").find((x) => x.name === "未接続の入力")!; lonely.required = false;
    expect(briefContext(q, target).target.missingInputs).toEqual([]);
  });

  it("親の入力 (境界) を通る線は、その先の実際の供給元までたどる", () => {
    const { p, parent, upstream, target } = fixture();
    let q = structuredClone(p);
    // 親の外に供給元を作り、親の入力 → 中の子の入力へ中継する
    const outside = addBlock(q, { parentId: q.blocks[parent].parentId!, title: "外の供給元", outputName: "外の資料" }); q = outside.project;
    const boundary = addPort(q, { blockId: parent, direction: "in", name: "外の資料" }); q = boundary.project;
    const inner = addPort(q, { blockId: target, direction: "in", name: "外の資料" }); q = inner.project;
    const a = connect(q, { portId: portsOf(q, outside.blockId, "out")[0].id, side: "outer" }, { portId: boundary.portId, side: "outer" }); q = a.project;
    const b = connect(q, { portId: boundary.portId, side: "inner" }, { portId: inner.portId, side: "outer" }); q = b.project;
    expect([a.error, b.error]).toEqual([undefined, undefined]);
    const c = briefContext(q, target);
    const input = c.target.inputs.find((i) => i.name === "外の資料")!;
    expect(input.sources).toEqual([expect.objectContaining({ title: "外の供給元", output: "外の資料", via: [q.blocks[parent].key ?? "親"] })]);
    // 関係するボックスの並び: 対象へ供給するボックスが先、次に親、その後にそれ以外
    const order = c.related.map((r) => (r.feedsTarget ? "feeds" : r.relation));
    expect(order.lastIndexOf("feeds")).toBeLessThan(order.indexOf("parent"));
    expect(c.related.find((r) => r.title === "外の供給元")?.feedsTarget).toEqual(["外の資料"]);
    expect(c.related.find((r) => r.title === "上流")?.feedsTarget).toEqual(["上流の出力"]);
    void upstream;
  });

  it("親・上流は絞る: 有効な判断は残し、説明は範囲が未設定のボックスだけ残す。省いた件数を示す", () => {
    const { p, target } = fixture();
    const c = briefContext(p, target);
    const full = agentContext(p, target);
    const parent = c.related.find((r) => r.title === "親")!;
    const upstream = c.related.find((r) => r.title === "上流")!;
    expect(parent.relation).toBe("parent");
    expect(upstream.relation).toBe("upstream");
    // 親の判断は、今の回答だけ (前の回答 = 履歴は省く)
    expect(parent.decisions).toEqual([expect.objectContaining({ question: "保存先は?", answer: "B" })]);
    expect(JSON.stringify(parent)).not.toContain("history");
    // 範囲を設定済みの親は、説明を省く。未設定の上流は、説明に制約があるかもしれないので残す
    expect("description" in parent).toBe(false);
    expect(upstream.description).toBe("上流の説明 (制約: 形式は JSON)");
    // 上流の未回答も、材料と選択肢を残す
    expect(upstream.openQuestions).toEqual([expect.objectContaining({ question: "形式は?", options: ["JSON", "YAML"], context: "上流の判断の材料" })]);
    expect(JSON.stringify(c)).not.toContain("上流の引き継ぎ");
    // 省いたもの: 種類ごとの件数 (0 件の種類は出さない) と、取り方
    expect(c.omitted).toEqual(expect.objectContaining({ descriptions: 1, decisionHistory: 1, handoffs: 1, relatedBlocks: full.blocks.length - 1 }));
    // 供給元として出した出力の成果物は、省いた数に入れない (この計画では、ほかに省いた成果物は無い)
    expect("artifacts" in c.omitted).toBe(false);
    expect(c.omitted.howToGet).toContain("boxglow context");
    expect(JSON.stringify(c).length).toBeLessThan(JSON.stringify(full).length);
  });

  it("R27-01: 計画全体の説明は省かない (計画の説明にだけ書かれた制約が読める)", () => {
    const { p, target } = fixture();
    p.description = "GLOBAL_CONSTRAINT: 保存はオフラインだけ";
    expect(briefContext(p, target).project).toEqual({ name: "Brief", description: "GLOBAL_CONSTRAINT: 保存はオフラインだけ" });
  });

  it("R27-02: 回答済みの判断は、親・上流・対象のどれでも、材料と選択肢を残す (回答だけでは意味が分からないため)", () => {
    const { p, parent, upstream, target } = fixture();
    let q = structuredClone(p);
    for (const id of [parent, upstream, target]) {
      const asked = askDecision(q, id, "codex", "Which proposal?", ["A", "B"], "A = local-only; B = external service"); q = asked.project;
      q = answerDecision(q, id, asked.decisionId!, "A", "human");
    }
    const c = briefContext(q, target);
    const expected = expect.objectContaining({ question: "Which proposal?", answer: "A", options: ["A", "B"], context: "A = local-only; B = external service" });
    expect(c.target.decisions).toContainEqual(expected);
    expect(c.related.find((r) => r.title === "親")!.decisions).toContainEqual(expected);
    expect(c.related.find((r) => r.title === "上流")!.decisions).toContainEqual(expected);
  });

  it("供給元: 出力の説明を出す。ボックス全体の成果物は数だけ。束ねた出力は、資料が無いとき中の出力を展開する", () => {
    const { p, parent, upstream, target } = fixture();
    let q = structuredClone(p);
    portsOf(q, upstream, "out")[0].description = "形式: JSON Lines";
    q.blocks[upstream].artifacts = [createArtifact("上流の全体の資料", "docs/whole.md")];
    // 親の隣に「束ねる親」を作り、その中の子の出力を、親の出力に束ねて、対象の親の入力 → 対象へ渡す
    const bundle = addBlock(q, { parentId: q.blocks[parent].parentId!, title: "束ねる親", outputName: "束ねた出力" }); q = bundle.project;
    const child = addBlock(q, { parentId: bundle.blockId, title: "中の子", outputName: "子の出力" }); q = child.project;
    portsOf(q, child.blockId, "out")[0].artifacts = [createArtifact("子の資料", "docs/child.md")];
    const bundleOut = portsOf(q, bundle.blockId, "out")[0];
    const boundary = addPort(q, { blockId: parent, direction: "in", name: "束ねた出力" }); q = boundary.project;
    const inner = addPort(q, { blockId: target, direction: "in", name: "束ねた出力" }); q = inner.project;
    const edges = [
      connect(q, { portId: portsOf(q, child.blockId, "out")[0].id, side: "outer" }, { portId: bundleOut.id, side: "inner" })
    ];
    q = edges[0].project;
    edges.push(connect(q, { portId: bundleOut.id, side: "outer" }, { portId: boundary.portId, side: "outer" })); q = edges[1].project;
    edges.push(connect(q, { portId: boundary.portId, side: "inner" }, { portId: inner.portId, side: "outer" })); q = edges[2].project;
    expect(edges.map((e) => e.error)).toEqual([undefined, undefined, undefined]);
    const c = briefContext(q, target);
    const direct = c.target.inputs.find((i) => i.name === "上流の出力")!.sources[0];
    expect(direct).toMatchObject({ description: "形式: JSON Lines", otherArtifacts: 1 });
    expect(direct.artifacts.map((a) => a.url)).toEqual(["docs/spec.md"]);
    // 束ねた出力には資料が無い: 中の出力 (実体) を展開する。子の出力に資料があるので、用意できている
    const bundled = c.target.inputs.find((i) => i.name === "束ねた出力")!;
    expect(bundled.ready).toBe(true);
    expect(bundled.sources[0]).toMatchObject({ title: "束ねる親", output: "束ねた出力", bundles: 1, inner: [{ title: "中の子", output: "子の出力" }] });
    expect(bundled.sources[0].inner![0].artifacts.map((a) => a.url)).toEqual(["docs/child.md"]);
    // 束ねた出力そのものに資料を付けて用意できていれば、展開しない (数だけ)
    portsOf(q, bundle.blockId, "out")[0].artifacts = [createArtifact("まとめ", "docs/bundle.md")];
    const again = briefContext(q, target).target.inputs.find((i) => i.name === "束ねた出力")!.sources[0];
    expect(again.bundles).toBe(1);
    expect("inner" in again).toBe(false);
  });

  it("R29-01: 束ねた出力の中の資料・つながりが変わると、確認トークンが変わる (古いトークンは通らない)。中身を表示していないときも同じ", () => {
    // 束ねる親 (出力に資料なし) の中に、子 → 孫と 2 段に束ねた出力を作り、対象へ渡す
    let q: Project = createProject("Bundle");
    q.contextGuard = true;
    const add = (parentId: string, title: string, out: string) => { const r = addBlock(q, { parentId, title, outputName: out }); q = r.project; return r.blockId; };
    const top = defaultTaskParent(q);
    const bundle = add(top, "束ねる親", "束ねた出力");
    const child = add(bundle, "子", "子の出力");
    const grand = add(child, "孫", "孫の出力");
    add(bundle, "別の子", "別の出力");
    const target = add(top, "対象", "対象の出力");
    const out = (id: string) => portsOf(q, id, "out")[0];
    out(grand).artifacts = [createArtifact("仕様", "docs/spec-v1.md")];
    const input = addPort(q, { blockId: target, direction: "in", name: "束ねた出力" }); q = input.project;
    const wire = (from: string, fromSide: "outer" | "inner", to: string, toSide: "outer" | "inner") => { const r = connect(q, { portId: from, side: fromSide }, { portId: to, side: toSide }); expect(r.error).toBeUndefined(); q = r.project; return r.edgeId!; };
    wire(out(grand).id, "outer", out(child).id, "inner");
    const childEdge = wire(out(child).id, "outer", out(bundle).id, "inner");
    wire(out(bundle).id, "outer", input.portId, "outer");
    // 全部の出力に、中のボックス (子・孫) が入る。束ねていない「別の子」は入らない
    const titles = agentContext(q, target).blocks.map((b) => b.title);
    expect(titles).toEqual(expect.arrayContaining(["束ねる親", "子", "孫"]));
    expect(titles).not.toContain("別の子");
    const before = briefReceipt(q, target);
    expect(before.contextToken).toBe(contextReceipt(q, target).contextToken);
    expect(() => requireContext(q, target, before.contextToken, "codex")).not.toThrow();
    // 孫 (2 段下) の出力の参照先を変える: トークンが変わり、古いトークンは通らない
    const changed = structuredClone(q);
    portsOf(changed, grand, "out")[0].artifacts[0].url = "docs/spec-v2.md";
    expect(briefReceipt(changed, target).contextToken).not.toBe(before.contextToken);
    expect(() => requireContext(changed, target, before.contextToken, "codex")).toThrow();
    // 子の出力のつなぎ先を変える (束ねから外す): トークンが変わる
    const rewired = structuredClone(q);
    delete rewired.edges[childEdge];
    expect(briefReceipt(rewired, target).contextToken).not.toBe(before.contextToken);
    // 親の出力に資料が付いて、短い形が中身を展開しなくなっても、中の変更でトークンは変わる
    const shown = structuredClone(q);
    portsOf(shown, bundle, "out")[0].artifacts = [createArtifact("まとめ", "docs/bundle.md")];
    shown.blocks[child].status = "white"; shown.blocks[grand].status = "white";
    const source = briefContext(shown, target).target.inputs[0].sources[0];
    expect("inner" in source).toBe(false);
    const hidden = structuredClone(shown);
    portsOf(hidden, grand, "out")[0].artifacts[0].url = "docs/spec-v2.md";
    expect(JSON.stringify(briefContext(hidden, target).target)).toBe(JSON.stringify(briefContext(shown, target).target));
    expect(briefReceipt(hidden, target).contextToken).not.toBe(briefReceipt(shown, target).contextToken);
  });

  it("無いボックスは、全部の出力と同じく断る", () => {
    const { p } = fixture();
    expect(() => briefContext(p, "missing")).toThrow();
  });
});

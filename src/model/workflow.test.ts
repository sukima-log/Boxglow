import { blockToPrompt } from "./export";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setProgress, splitBlock, extractTemplate, instantiateTemplate, addBlock, addPort, createArtifact, createProject, defaultTaskParent, finishBlock, fromJSON, portsOf, removeBlock, setActivity, setStatus, summarize, toJSON, updateBlock } from "./graph";
import { candidateGroups, checkDone, checkStart, descriptionReminder, freshnessText, inFocus, noteFreshness, scopeEntries } from "./workflow";
import { resumeReport, resumeSummary } from "./resume";
import { blockReport, statusReport } from "./report";
import { validateProjectText } from "./validate-file";
import { contextReceipt } from "../../cli/context";
import { mergeProjects } from "./merge";
import { setLang } from "../i18n/core";

/** Input: なし / Output: 必須入力が不足した新しいボックスと計画。 */
function fixture() {
  setLang("ja");
  const base = createProject("確認");
  const r = addBlock(base, { parentId: defaultTaskParent(base), title: "実装", outputName: "コード" });
  return { id: r.blockId, p: addPort(r.project, {blockId:r.blockId, direction:"in", name:"仕様書"}).project };
}
afterEach(() => vi.useRealTimers());
/** 具体化済みにする (予定成果物と完了条件を付ける)。候補の「着手できる」はこれが要る */
function prepared(p: ReturnType<typeof createProject>, id: string) {
  for (const o of portsOf(p, id, "out")) o.expect = { kind: "file", hint: "src/x.ts" };
  p.blocks[id].scope = { ...p.blocks[id].scope, acceptance: "テストが通る" };
  return p;
}

describe("着手・完了の確認", () => {
  it("既存の計画は入力待ちでも警告のみで拒否しない", () => {
    const {p,id} = fixture();
    expect(checkStart(p,id,"codex").warning).toContain("仕様書");
    expect(checkStart(p,id,"codex").error).toBe("");
    expect(checkDone(p,id,0,"codex").error).toBe("");
    expect(checkDone(p,id,0,"codex").warning).not.toBe("");
    expect(p.workflowPolicy).toBeUndefined();
  });
  it("拒否は計画で選んだAI操作だけに効き、理由付き開始と人は通る", () => {
    const {p,id} = fixture(); p.workflowPolicy={startWithoutInputs:"reject",doneWithoutArtifacts:"reject"};
    expect(checkStart(p,id,"codex").error).toContain("--reason");
    // 理由があれば入力待ちは通る (要具体化の警告は別に残るが、拒否にはならない)
    expect(checkStart(p,id,"codex","モックを先に作る").error).toBe("");
    expect(checkStart(p,id,"codex","モックを先に作る").warning).not.toContain("入力待ち");
    expect(checkStart(p,id,"human").error).toBe("");
    expect(checkStart(p,id,"human:担当").error).toBe("");
    expect(checkDone(p,id,0,"codex").error).not.toBe("");
    expect(checkDone(p,id,0,"human").error).toBe("");
    expect(checkDone(p,id,1,"codex").error).toBe("");
  });
  it("任意の入力は開始を妨げず、既存の出力成果物でも完了できる", () => {
    const {p,id} = fixture(); p.workflowPolicy={startWithoutInputs:"reject",doneWithoutArtifacts:"reject"};
    portsOf(p,id,"in")[0].required=false;
    p.blocks[id].artifacts=[createArtifact("参考資料","https://example.com")];
    expect(checkDone(p,id,0,"codex").error).not.toBe("");
    portsOf(p,id,"out")[0].artifacts=[createArtifact("コード","https://example.com/code")];
    expect(checkStart(p,id,"codex").error).toBe("");
    expect(checkDone(p,id,0,"codex")).toEqual({warning:"",error:""});
  });
});

describe("範囲と候補の優先", () => {
  it("今回の配下を先に並べ、着手可能と入力待ちを分けて不足名を出す", () => {
    const {p:base,id} = fixture();
    const other=addBlock(base,{parentId:defaultTaskParent(base),title:"将来の機能"});
    const child=addBlock(other.project,{parentId:id,title:"今回の子"});
    let p=child.project; p.focusBlockId=id;
    const waiting=addBlock(p,{parentId:id,title:"待つ子"}); p=addPort(waiting.project,{blockId:waiting.blockId,direction:"in",name:"API"}).project;
    for (const bid of [other.blockId, child.blockId, waiting.blockId]) prepared(p, bid);
    const groups=candidateGroups(p,summarize(p).next);
    expect(groups.map(g=>[g.inFocus,g.ready])).toEqual([[true,true],[true,false],[false,true]]);
    expect(groups.map(g=>g.state)).toEqual(["ready","waiting","ready"]);
    expect(groups[1].items[0].missingInputs).toEqual(["API"]);
    // 具体化していないボックスは「要具体化」の組に入り、理由が付く (入力待ちより先)
    const rough=addBlock(p,{parentId:id,title:"粗い子"}); const q=addPort(rough.project,{blockId:rough.blockId,direction:"in",name:"資料"}).project;
    const g2=candidateGroups(q,summarize(q).next).find(g=>g.state==="unprepared")!;
    expect(g2.items.map(x=>x.title)).toEqual(["粗い子"]);
    expect(g2.items[0].unprepared.join()).toContain("expect");
    expect(g2.items[0].missingInputs).toEqual(["資料"]);
    expect(resumeReport(q)).toContain("要具体化");
    expect(summarize(p).next[0].id).toBe(child.blockId);
    expect(inFocus(p,id)).toBe(true);
    expect(resumeReport(p)).toContain("今回の範囲");
    expect(statusReport(p,{brief:true})).toContain("API");
  });
  it("対象指定が無い既存計画は従来どおり着手可能を先にする", () => {
    const {p,id} = fixture(); const r=addBlock(p,{parentId:defaultTaskParent(p),title:"準備済み"}); prepared(r.project,r.blockId); prepared(r.project,id);
    expect(summarize(r.project).next.map(b=>b.id)).toEqual([r.blockId,id]);
    expect(candidateGroups(r.project,summarize(r.project).next).map(g=>g.ready)).toEqual([true,false]);
  });
  it("削除した対象は解除され、読込時の古い参照も残さない", () => {
    const {p,id}=fixture();p.focusBlockId=id;
    expect(removeBlock(p,id).focusBlockId).toBeUndefined();
    const deleted=removeBlock(p,id);deleted.focusBlockId=id;
    expect(fromJSON(toJSON(deleted)).focusBlockId).toBeUndefined();
    expect(()=>validateProjectText(toJSON(deleted))).toThrow();
  });
  it("4項目を保存し、対象・親の範囲をcontextの先頭で読み直せる", () => {
    const {p:base,id}=fixture();
    const scope={goal:"実装",nonGoals:"公開",acceptance:"検査成功",consult:"形式変更"};
    const p=updateBlock(updateBlock(base,id,{scope}),defaultTaskParent(base),{scope:{goal:"親のゴール"}});
    const result=contextReceipt(p,id);
    expect(Object.keys(result.context)[0]).toBe("workScope");
    expect(result.context.workScope.target).toEqual(scope);
    expect(result.context.workScope.parents[0].scope?.goal).toBe("親のゴール");
    expect(scopeEntries({goal:" ",consult:"相談"})).toHaveLength(1);
    expect(blockReport(p,id)).toContain("今回は扱わないこと");
    expect(validateProjectText(toJSON(p)).blocks[id].scope).toEqual(scope);
  });
  it("範囲と計画設定の変更はトークンを変え、鮮度表示だけの変更は変えない", () => {
    const {p,id}=fixture();const old=contextReceipt(p,id).contextToken;
    expect(contextReceipt(updateBlock(p,id,{scope:{goal:"追加"}}),id).contextToken).not.toBe(old);
    expect(contextReceipt({...p,focusBlockId:id},id).contextToken).not.toBe(old);
    expect(contextReceipt({...p,workflowPolicy:{doneWithoutArtifacts:"reject"}},id).contextToken).not.toBe(old);
    expect(contextReceipt(setActivity(p,id,"codex","working","開始"),id).contextToken).toBe(old);
    expect(contextReceipt({...p,blocks:{...p.blocks,[id]:{...p.blocks[id],descriptionUpdatedAt:"2026-10-04T00:00:00Z"}}},id).contextToken).toBe(old);
  });
});

describe("再開情報の鮮度と互換性", () => {
  it("状態変更と説明編集だけに日時を付け、同じ値と読込では日時を変えない", () => {
    const {p:base,id}=fixture();vi.useFakeTimers();vi.setSystemTime("2026-10-01T00:00:00Z");
    const p=updateBlock(base,id,{description:"レビュー待ち"});
    expect(p.blocks[id].descriptionUpdatedAt).toBe("2026-10-01T00:00:00.000Z");
    vi.setSystemTime("2026-10-02T00:00:00Z");
    const q=setActivity(p,id,"codex","working","");
    expect(q.blocks[id].statusChangedAt).toBe("2026-10-02T00:00:00.000Z");
    const same=updateBlock(q,id,{description:"レビュー待ち",status:"gray"});
    expect(same.blocks[id]).toEqual(q.blocks[id]);
    expect(fromJSON(toJSON(same)).blocks[id]).toEqual(same.blocks[id]);
    expect(base.blocks[id].descriptionUpdatedAt).toBeUndefined();
  });
  it("Done の説明を自動編集せず、古い状況への確認案内を出す", () => {
    const {p:base,id}=fixture(); const p=updateBlock(base,id,{description:"未コミット。レビュー待ち"});
    const done=finishBlock(p,id,"codex").project;
    expect(descriptionReminder(done.blocks[id])).toContain("本文は変更していません");
    expect(done.blocks[id].description).toBe(p.blocks[id].description);
    expect(blockReport(done,id)).toContain("以前の状況");
  });
  it("日時が不明な旧記録を新しい事実と扱わず、古い日時を明示する", () => {
    const {p,id}=fixture();const b=p.blocks[id];
    expect(noteFreshness(b)).toBe("unknown");
    expect(freshnessText(b)).toContain("記録日時不明");
    b.statusChangedAt="2026-10-02T00:00:00Z";
    expect(freshnessText(b,"2026-10-01T00:00:00Z")).toContain("状態の変更より前");
    expect(noteFreshness(b,"2026-10-03T00:00:00Z")).toBe("current");
  });
  it("再開は現況を先に、完了メモは件数のみ、指定すれば本文を出す", () => {
    const {p:base,id}=fixture();const p=finishBlock(base,id,"codex").project;
    p.handoffs={[id]:{actor:"codex",note:"過去の本文",at:"2026-10-01T00:00:00Z"}};
    const snapshot=toJSON(p), result=resumeSummary(p);
    expect(result.handoffs).toHaveLength(0);expect(result.completedHandoffCount).toBe(1);
    expect(resumeReport(p)).not.toContain("過去の本文");
    expect(resumeReport(p,{includeCompleted:true})).toContain("過去の本文");
    expect(resumeReport(p).indexOf("次の候補")).toBeLessThan(resumeReport(p).indexOf("引き継ぎ（新しい順）"));
    expect(toJSON(p)).toBe(snapshot);
  });
  it("GUIとCLIが使う状態変更に鮮度記録が付き、Done のやり直しでも保持する", () => {
    const {p,id}=fixture();
    expect(updateBlock(p,id,{status:"white"}).blocks[id].statusChangedAt).toBeDefined();
    expect(setStatus(p,id,"white","codex").blocks[id].statusChangedAt).toBeDefined();
    const done=finishBlock(p,id,"codex").project;
    expect(finishBlock(done,id,"codex").project.blocks[id].statusChangedAt).toBe(done.blocks[id].statusChangedAt);
  });
  it("v5の既存計画には新しい項目を補わず、新しい任意項目は読み書きできる", () => {
    const {p,id}=fixture();const old=fromJSON(toJSON(p));
    expect(old.schemaVersion).toBe(5);expect(old.workflowPolicy).toBeUndefined();expect(old.focusBlockId).toBeUndefined();
    expect(old.blocks[id].scope).toBeUndefined();expect(old.blocks[id].statusChangedAt).toBeUndefined();
    p.focusBlockId=id;p.workflowPolicy={startWithoutInputs:"reject"};
    expect(validateProjectText(toJSON(p)).workflowPolicy).toEqual(p.workflowPolicy);
  });
  it("任意項目の不正な型をAPI保存前に拒否する", () => {
    const {p,id}=fixture();
    for (const patch of [{workflowPolicy:{startWithoutInputs:"bad"}},{focusBlockId:12},{blocks:{...p.blocks,[id]:{...p.blocks[id],scope:{goal:7}}}},{blocks:{...p.blocks,[id]:{...p.blocks[id],statusChangedAt:"bad"}}}]) {
      expect(()=>validateProjectText(JSON.stringify({...p,...patch}))).toThrow();
    }
  });
  it("並行する範囲設定と説明変更を統合して新しい設定を失わない", () => {
    const {p,id}=fixture();
    const ours={...p,workflowPolicy:{doneWithoutArtifacts:"reject" as const},focusBlockId:id};
    const theirs=updateBlock(p,id,{scope:{goal:"実装"},description:"更新"});
    const merged=mergeProjects(p,ours,theirs).project;
    expect(merged.focusBlockId).toBe(id);expect(merged.workflowPolicy).toEqual(ours.workflowPolicy);
    expect(merged.blocks[id].scope?.goal).toBe("実装");
    expect(()=>validateProjectText(toJSON(merged))).not.toThrow();
  });
});


it("固定の仕様説明は古い日時でもDoneの見直しを強く促さない", () => {
  const {p,id}=fixture();
  p.blocks[id].description="入力JSONを検証して結果を返す";
  p.blocks[id].descriptionUpdatedAt="2026-10-01T00:00:00Z";
  const done=finishBlock(p,id,"codex").project;
  expect(descriptionReminder(done.blocks[id])).toBe("");
  expect(freshnessText(done.blocks[id],done.blocks[id].descriptionUpdatedAt)).toContain("状態の変更より前");
});

it("競合で選んだ説明と状態に対応する日時を一緒に保持する", () => {
  const {p,id}=fixture();
  const ours=updateBlock(p,id,{description:"自分の説明",descriptionUpdatedAt:"2026-10-01T00:00:00Z",status:"gray",statusChangedAt:"2026-10-01T00:00:00Z"});
  const theirs=updateBlock(p,id,{description:"相手の説明",descriptionUpdatedAt:"2026-10-02T00:00:00Z",status:"white",statusChangedAt:"2026-10-02T00:00:00Z"});
  const merged=mergeProjects(p,ours,theirs,{[JSON.stringify(["blocks",id,"description"])]:"theirs",[JSON.stringify(["blocks",id,"status"])]:"theirs"}).project;
  expect(merged.blocks[id].descriptionUpdatedAt).toBe(theirs.blocks[id].descriptionUpdatedAt);
  expect(merged.blocks[id].statusChangedAt).toBe(theirs.blocks[id].statusChangedAt);
});

it("出力ポートが無い場合は追加予定の成果物だけで厳格な完了を通さない", () => {
  const {p,id}=fixture();p.workflowPolicy={doneWithoutArtifacts:"reject"};
  for(const port of portsOf(p,id,"out"))delete p.ports[port.id];
  expect(checkDone(p,id,1,"codex").error).not.toBe("");
});

it("画面からAIへ渡す文面にも対象と親の範囲を含める", () => {
  const {p:base,id}=fixture();
  const p=updateBlock(updateBlock(base,id,{scope:{nonGoals:"公開しない"}}),defaultTaskParent(base),{scope:{goal:"利用者のゴール"}});
  const prompt=blockToPrompt(p,id,"plan");
  expect(prompt).toContain("公開しない");expect(prompt).toContain("利用者のゴール");
});

it("進捗入力による状態変更と分解・部品挿入時の説明にも日時を記録する", () => {
  const {p,id}=fixture();
  expect(setProgress(p,id,10,"human").blocks[id].statusChangedAt).toBeDefined();
  const split=splitBlock(p,id,{blocks:[{title:"子",description:"新しい説明",outputs:["結果"]}]},"codex").project;
  const child=Object.values(split.blocks).find(b=>b.title==="子")!;
  expect(child.descriptionUpdatedAt).toBeDefined();
  const template=extractTemplate(split,child.id,{});
  const added=instantiateTemplate(split,id,template,"human");
  expect(added.project.blocks[added.blockId].descriptionUpdatedAt).toBeDefined();
});

describe("案内を出しすぎない (レビューで足した確認)", () => {
  it("機能や状態の名前としての「作業中」「In Progress」では見直しを促さず、途中の状況を表す言い回しでだけ促す", () => {
    const { p, id } = fixture();
    const done = (description: string) => ({ ...p.blocks[id], status: "white" as const, description });
    // 開発計画で実際に誤検出になっていた説明
    expect(descriptionReminder(done("作業中・詰まり・判断待ちの札とタイムライン"))).toBe("");
    expect(descriptionReminder(done("名前の確認とロゴ (New / In Progress / Done)"))).toBe("");
    // 途中の状況が残っている説明
    expect(descriptionReminder(done("詳細パネルの案内を短く。未コミット。Codex のレビュー待ち"))).not.toBe("");
    expect(descriptionReminder(done("npm publish は利用者の操作待ち"))).not.toBe("");
    // Done 以外では促さない
    expect(descriptionReminder({ ...done("未コミット"), status: "gray" })).toBe("");
  });
  it("日時の記録が無い古い説明には「不明」を付けない出し方ができる (known / older)。always は今までどおり", () => {
    const { p, id } = fixture();
    const b = { ...p.blocks[id], statusChangedAt: "2026-10-04T10:00:00.000Z" };
    expect(freshnessText(b, undefined)).toContain("記録日時不明");
    expect(freshnessText(b, undefined, "known")).toBe("");
    expect(freshnessText(b, undefined, "older")).toBe("");
    // 状態の変更より後の記録: known では日時だけ、older では出さない
    expect(freshnessText(b, "2026-10-04T11:00:00.000Z", "known")).toContain("2026-10-04T11:00:00.000Z");
    expect(freshnessText(b, "2026-10-04T11:00:00.000Z", "older")).toBe("");
    // 状態の変更より前の記録: どの出し方でも注記する
    expect(freshnessText(b, "2026-10-04T09:00:00.000Z", "older")).toContain("状態の変更より前");
    // 日時の無い説明は、show (blockReport) に「不明」の行を増やさない
    expect(blockReport({ ...p, blocks: { ...p.blocks, [id]: { ...p.blocks[id], description: "古い説明" } } }, id)).not.toContain("記録日時不明");
  });
  it("今回の範囲のボックスが完了していたら、再開の一覧で選び直しを促す", () => {
    const { p, id } = fixture();
    const focused = { ...p, focusBlockId: id };
    expect(resumeReport(focused)).not.toContain("完了済みです");
    const done = { ...focused, blocks: { ...focused.blocks, [id]: { ...focused.blocks[id], status: "white" as const } } };
    expect(resumeReport(done)).toContain("完了済みです。focus で次の対象を選ぶか、focus none で解除してください");
  });
});

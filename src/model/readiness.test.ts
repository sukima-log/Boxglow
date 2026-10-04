import { describe, expect, it } from "vitest";
import { buildSampleProject } from "./sample";
import { createArtifact, isEdgeReady, isInputReady, isSourceReady, portsOf } from "./graph";
import { buildEdges } from "../canvas/layout";

function fixture() {
  const p=buildSampleProject();
  const block=(title:string)=>Object.values(p.blocks).find(b=>b.title===title)!;
  const parent=block("実装する"),child=block("結合テスト"),target=block("公開する");
  return {p,parent,child,target,out:portsOf(p,parent.id,"out")[0],input:portsOf(p,target.id,"in")[0]};
}
describe("境界を越える確定状態",()=>{
  it("自動で外へ伸びた入力は、内側に付けた資料を全区間で共有する",()=>{
    const {p}=fixture();
    const req=Object.values(p.blocks).find(b=>b.title==="要件を決める")!;
    const input=portsOf(p,req.id,"in")[0];
    expect(isInputReady(p,input.id)).toBe(true);
    const project=p.blocks[req.parentId!];
    const external=portsOf(p,project.id,"in").find(x=>x.name==="企画メモ")!;
    const incoming=Object.values(p.edges).find(e=>e.to.portId===external.id)!;
    expect(isEdgeReady(p,incoming)).toBe(true);
    external.artifacts=[];
    expect(isInputReady(p,input.id)).toBe(false);
    expect(isEdgeReady(p,incoming)).toBe(false);
  });
  it("子の出力が確定したら、未完了の親を通っても確定したまま",()=>{
    const {p,parent,child,out,input}=fixture();parent.status="black";child.status="white";
    expect(isSourceReady(p,{portId:out.id,side:"outer"})).toBe(true);
    expect(isInputReady(p,input.id)).toBe(true);
    const edges=Object.values(p.edges).filter(e=>e.to.portId===out.id||e.from.portId===out.id);
    expect(edges.length).toBeGreaterThanOrEqual(2);
    expect(edges.every(e=>isEdgeReady(p,e))).toBe(true);
    expect(buildEdges(p,{selectedEdgeId:null,scope:parent.id}).find(e=>e.id===`scope-out:${out.id}`)?.className).toContain("edge-ready");
  });
  it("親が完了済みでも添付物があっても、未確定の上流を確定に変えない",()=>{
    const {p,parent,child,out,input}=fixture();parent.status="white";child.status="black";
    out.artifacts=[createArtifact("古いビルド","build.zip")];
    expect(isSourceReady(p,{portId:out.id,side:"outer"})).toBe(false);
    expect(isInputReady(p,input.id)).toBe(false);
    expect(buildEdges(p,{selectedEdgeId:null,scope:parent.id}).find(e=>e.id===`scope-out:${out.id}`)?.className ?? "").not.toContain("edge-ready");
  });
  it("中継入力と、その先の複数の子は供給元の確定状態を共有",()=>{
    const {p,parent}=fixture();
    const input=portsOf(p,parent.id,"in").find(x=>x.name==="設計書")!;
    const branches=Object.values(p.edges).filter(e=>e.from.portId===input.id);
    expect(branches.length).toBe(2);
    expect(branches.every(e=>isEdgeReady(p,e))).toBe(true);
    const source=Object.values(p.blocks).find(b=>b.title==="設計する")!;
    source.status="gray";portsOf(p,source.id,"out")[0].artifacts=[];
    expect(branches.every(e=>!isEdgeReady(p,e))).toBe(true);
    expect(buildEdges(p,{selectedEdgeId:null,scope:parent.id}).find(e=>e.id===`scope-in:${input.id}`)?.className ?? "").not.toContain("edge-ready");
  });
  it("循環した中継は確定扱いにしない",()=>{
    const {p,out}=fixture();
    p.edges={loop:{...Object.values(p.edges)[0],id:"loop",from:{portId:out.id,side:"outer"},to:{portId:out.id,side:"inner"}}};
    expect(isSourceReady(p,{portId:out.id,side:"outer"})).toBe(false);
  });
});

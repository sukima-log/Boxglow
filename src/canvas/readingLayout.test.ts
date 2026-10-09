import { describe, it, expect } from "vitest";
import { createProject, addBlock, addPort, connect, portsOf, projectBlocks } from "../model/graph";
import { blockSize } from "../model/size";
import { readingColumns, readingLayout } from "../model/readingLayout";

function example() {
  let p = createProject("工程");
  const parent = projectBlocks(p)[0].id;
  const ids: string[]=[];
  for(const title of ["起点","分岐A","分岐B","完了"]){ const r=addBlock(p,{parentId:parent,title,position:{x:1000,y:1000}});p=r.project;ids.push(r.blockId); }
  for(const [from,to] of [[0,1],[0,2],[1,3],[2,3]]) {
    const r=addPort(p,{blockId:ids[to],direction:"in",name:ids[from]});p=r.project;
    p=connect(p,{portId:portsOf(p,ids[from],"out")[0].id,side:"outer"},{portId:r.portId,side:"outer"}).project;
  }
  return {p,parent,ids};
}
describe("閲覧用の工程配置",()=>{
  it("分岐を同じ列に並べ、少ない列を中央にそろえる",()=>{
    const {p,parent,ids}=example(); const q=readingLayout(p,null);
    expect(q.blocks[ids[1]].position.x).toBe(q.blocks[ids[2]].position.x);
    expect(q.blocks[ids[0]].position.x).toBeLessThan(q.blocks[ids[1]].position.x);
    expect(q.blocks[ids[3]].position.x).toBeGreaterThan(q.blocks[ids[1]].position.x);
    expect(q.blocks[ids[0]].position.y).toBeGreaterThan(q.blocks[ids[1]].position.y);
    expect(readingColumns(q,parent)).toHaveLength(3);
  });
  it("保存済みの計画を変えず、表示の中で箱が重ならない",()=>{
    const {p,ids}=example();const before=JSON.stringify(p);const q=readingLayout(p,null);
    expect(JSON.stringify(p)).toBe(before);expect(q.edges).toEqual(p.edges);expect(q.ports).toEqual(p.ports);
    for(const a of ids)for(const b of ids)if(a!==b){const x=q.blocks[a].position,y=q.blocks[b].position,A=blockSize(q,a),B=blockSize(q,b);expect(x.x+A.width<=y.x||y.x+B.width<=x.x||x.y+A.height<=y.y||y.y+B.height<=x.y).toBe(true);}
  });
  it("状態や活動の更新で工程の順番・配置が変わらない",()=>{
    const {p,ids}=example();const before=readingLayout(p,null);
    p.blocks[ids[1]].status="white";p.blocks[ids[2]].activity={actor:"codex",state:"working",note:"実装",since:"2026-10-09"};
    const after=readingLayout(p,null);for(const id of ids)expect(after.blocks[id].position).toEqual(before.blocks[id].position);
  });
  it("階層タブでは範囲外の配置に触れない",()=>{
    const {p,parent}=example();const outside=addBlock(p,{parentId:"root",title:"範囲外",position:{x:3000,y:500}});const q=readingLayout(outside.project,parent);
    expect(q.blocks[outside.blockId]).toEqual(outside.project.blocks[outside.blockId]);expect(q.terminals).toEqual(outside.project.terminals);
  });
  it("同じカテゴリ間の接続も左から右に並べ、別カテゴリの追加で順番を変えない",()=>{
    const {p,ids,parent}=example();
    p.blocks[ids[0]].category="design";p.blocks[ids[1]].category="design";
    p.blocks[ids[2]].category="docs";p.blocks[ids[3]].category="ops";
    const q=readingLayout(p,null);
    expect(q.blocks[ids[0]].position.x+blockSize(q,ids[0]).width).toBeLessThan(q.blocks[ids[1]].position.x);
    expect(readingColumns(q,parent)).toHaveLength(3);
    const reference=ids.map(id=>q.blocks[id].position);
    for(const id of ids)p.blocks[id].category="fix";
    expect(ids.map(id=>readingLayout(p,null).blocks[id].position)).toEqual(reference);
  });
  it("四つより多い工程や長い直列の鎖も、接続先を左へ折り返さない",()=>{
    let p=createProject("長い設計工程");const parent=projectBlocks(p)[0].id;const ids:string[]=[];
    for(let i=0;i<12;i++){
      const b=addBlock(p,{parentId:parent,title:`設計 ${i+1}`,position:{x:120,y:80}});p=b.project;ids.push(b.blockId);p.blocks[b.blockId].category="design";
      if(i){const input=addPort(p,{blockId:b.blockId,direction:"in",name:"前の設計"});p=input.project;p=connect(p,{portId:portsOf(p,ids[i-1],"out")[0].id,side:"outer"},{portId:input.portId,side:"outer"}).project;}
    }
    const q=readingLayout(p,null);expect(readingColumns(q,parent)).toHaveLength(12);
    for(let i=1;i<ids.length;i++)expect(q.blocks[ids[i]].position.x).toBeGreaterThan(q.blocks[ids[i-1]].position.x+blockSize(q,ids[i-1]).width);
  });
  it("全体の入力・出力をタスク領域の左右に置く",()=>{
    const {p,parent}=example();const q=readingLayout(p,null);const box=q.blocks[parent];
    expect(q.terminals.in.x+200).toBeLessThan(box.position.x);
    expect(q.terminals.out.x).toBeGreaterThan(box.position.x+blockSize(q,parent).width);
  });

});

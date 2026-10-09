import { describe,it,expect } from "vitest";
import { createProject,addBlock,addPort,connect,portsOf,projectBlocks } from "../model/graph";
import { readingLayout } from "../model/readingLayout";
import { buildNodes } from "./layout";
import { verticalNodes,routeVertical } from "./verticalLayout";

describe("縦フロー",()=>{
 it("同じカテゴリの依存も上から下、並行作業は幅を抑えた段に置き、元のデータを変えない",()=>{
  let p=createProject("縦");const parent=projectBlocks(p)[0].id;const ids:string[]=[];
  for(let i=0;i<9;i++){const b=addBlock(p,{parentId:parent,title:`設計${i}`,position:{x:0,y:i*400}});p=b.project;ids.push(b.blockId);p.blocks[b.blockId].category="design";}
  for(const i of [1,2,3,4,5,6,7]){const a=addPort(p,{blockId:ids[i],direction:"in",name:"要件"});p=a.project;p=connect(p,{portId:portsOf(p,ids[0],"out")[0].id,side:"outer"},{portId:a.portId,side:"outer"}).project;const b=addPort(p,{blockId:ids[8],direction:"in",name:`結果${i}`});p=b.project;p=connect(p,{portId:portsOf(p,ids[i],"out")[0].id,side:"outer"},{portId:b.portId,side:"outer"}).project;}
  const before=JSON.stringify(p),q=readingLayout(p,parent),base=buildNodes(q,{scope:parent,readonly:true,selectedBlockId:null});
  const snapshot=JSON.stringify(base),ns=verticalNodes(base,q,parent),byId=new Map(ns.map(n=>[n.id,n]));
  const wide=verticalNodes(base,q,parent,false),parallel=wide.filter(n=>ids.slice(1,8).includes(n.id));
  expect(new Set(parallel.map(n=>n.position.y)).size).toBe(1);
  expect(new Set(parallel.map(n=>n.position.x)).size).toBe(7);
  expect(JSON.stringify(p)).toBe(before);expect(JSON.stringify(base)).toBe(snapshot);
  for(const i of [1,2,3,4,5,6,7]){expect(byId.get(ids[i])!.position.y).toBeGreaterThan(byId.get(ids[0])!.position.y+byId.get(ids[0])!.height!);expect(byId.get(ids[8])!.position.y).toBeGreaterThan(byId.get(ids[i])!.position.y+byId.get(ids[i])!.height!);}
  const children=ns.filter(n=>n.parentId===parent&&!n.hidden);
  for(const a of children)for(const b of children)if(a.id!==b.id)expect(a.position.x+a.width!<=b.position.x||b.position.x+b.width!<=a.position.x||a.position.y+a.height!<=b.position.y||b.position.y+b.height!<=a.position.y).toBe(true);
  const par=byId.get(parent)!;for(const n of children){expect(n.position.x+n.width!).toBeLessThan(par.width!);expect(n.position.y+n.height!).toBeLessThan(par.height!);}
  expect(byId.get('scope-in')!.position.y+byId.get('scope-in')!.height!).toBeLessThan(par.position.y);
  expect(byId.get('scope-out')!.position.y).toBeGreaterThan(par.position.y+par.height!);
 });
 it("上下の端点から垂直に出入りし、中間の箱を避ける",()=>{
  const ns=[{id:"a",parentId:"",rect:{x:0,y:0,width:320,height:200}},{id:"obstacle",parentId:"",rect:{x:80,y:300,width:160,height:200}},{id:"b",parentId:"",rect:{x:0,y:600,width:320,height:200}}];
  const p=routeVertical(ns,[{id:"edge",source:"a",target:"b",s:{x:160,y:200},t:{x:160,y:600}}]).get("edge")!;
  expect(p[1].x).toBe(160);expect(p[1].y).toBeGreaterThan(200);expect(p[p.length-2].x).toBe(160);expect(p[p.length-2].y).toBeLessThan(600);
  for(let i=1;i<p.length;i++)for(let k=0;k<=100;k++){const x=p[i-1].x+(p[i].x-p[i-1].x)*k/100,y=p[i-1].y+(p[i].y-p[i-1].y)*k/100;expect(x>80&&x<240&&y>300&&y<500).toBe(false);}
 });
});

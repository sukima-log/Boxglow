import { describe, expect, it } from "vitest";
import { routeAll, type EdgeSpec, type NodeRect } from "./routeAll";
import { sharedWires } from "./sharedWires";
import { chooseRoute, toRoundedPath, wireOverlap, type Point } from "./routeEdge";

const edges:EdgeSpec[]=[100,200,300].map((y,i)=>({id:`e${i}`,source:"A",target:`B${i}`,s:{x:200,y:100},t:{x:600,y}}));
const nodes:NodeRect[]=[{id:"A",parentId:"",rect:{x:0,y:40,width:200,height:100}},...edges.map(e=>({id:e.target,parentId:"",rect:{x:600,y:e.t.y-40,width:200,height:80}}))];
const atomKey=(a:Point,b:Point)=>[`${a.x},${a.y}`,`${b.x},${b.y}`].sort().join("|");
describe("同じ出力を共有する幹と分岐",()=>{
  it("重なりの長さを測る (経路選びの罰には足さない)",()=>{
    // wireOverlap は bundleFanout が幹をそろえた結果を比べるための物差し。
    // chooseRoute は交差だけを罰にするので、重なりがあっても元の費用が安い候補を選ぶ (重なりは後段の separate* がずらす)
    const overlap=[{x:0,y:40},{x:200,y:40}],separate=[{x:0,y:60},{x:200,y:60}];
    expect(wireOverlap(overlap,[overlap])).toBe(200);
    expect(chooseRoute([{path:overlap,base:200},{path:separate,base:240}],[overlap])).toEqual(overlap);
  });
  it("3本の枝が根元の1本の幹を共有する",()=>{
    const paths=routeAll(nodes,edges);
    expect(new Set([...paths.values()].map(p=>p[1].x)).size).toBe(1);
    const shared=sharedWires(paths,edges);
    expect([...shared.values()].flatMap(s=>s.junctions).length).toBeGreaterThan(0);
    const start=edges[0].s;
    expect([...shared.values()].flatMap(s=>s.parts).filter(p=>p[0].x===start.x&&p[0].y===start.y)).toHaveLength(1);
    const atoms=[...shared.values()].flatMap(s=>s.parts.flatMap(p=>p.slice(1).map((b,i)=>atomKey(p[i],b))));
    expect(new Set(atoms).size).toBe(atoms.length);
  });
  it("選択した枝が幹を引き受け、端から端まで追える",()=>{
    const paths=routeAll(nodes,edges);
    const wire=sharedWires(paths,edges,new Set(["e2"])).get("e2")!;
    expect(wire.parts[0][0]).toEqual(edges[2].s);
    expect(wire.parts.at(-1)?.at(-1)).toEqual(edges[2].t);
  });
  it("無関係な出力が交差しても、接続点を描かない",()=>{
    const paths=new Map<string,Point[]>([["a",[{x:0,y:50},{x:100,y:50}]],["b",[{x:50,y:0},{x:50,y:100}]]]);
    const es=[...paths].map(([id,p])=>({id,source:id,target:id+"t",s:p[0],t:p[1]}));
    expect([...sharedWires(paths,es).values()].flatMap(s=>s.junctions)).toHaveLength(0);
  });
  it("JSONの線の順序で配置が変わらない",()=>{
    const a=routeAll(nodes,edges),b=routeAll(nodes,[...edges].reverse());
    for(const e of edges) expect(a.get(e.id)).toEqual(b.get(e.id));
  });
  it("分岐点の角を丸めず、接続を途切れさせない",()=>{
    const path=[{x:0,y:0},{x:40,y:0},{x:40,y:80}];
    expect(toRoundedPath(path,10,[path[1]])).not.toContain("Q");
  });
  it("共通通路の候補にボックスがあれば、全枝をボックスの外へ通す",()=>{
    const obstacle={id:"O",parentId:"",rect:{x:230,y:150,width:240,height:60}};
    const paths=routeAll([...nodes,obstacle],edges);
    for(const path of paths.values()) for(let i=1;i<path.length;i++) {
      const a=path[i-1],b=path[i],r=obstacle.rect;
      expect(Math.max(a.x,b.x)>r.x+1&&Math.min(a.x,b.x)<r.x+r.width-1&&Math.max(a.y,b.y)>r.y+1&&Math.min(a.y,b.y)<r.y+r.height-1).toBe(false);
    }
  });
});

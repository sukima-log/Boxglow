/**
 * 同じ出力から分岐する線の束ね直し (routeAll の最後に呼ばれる)
 * 経路は 1 本ずつ選ぶので、同じ出力の線でも最初に曲がる位置 (縦の通路の x) がばらばらになる。
 * ここで曲がる位置を 1 つにそろえ、出た直後を 1 本の幹に重ねる (幹の描画は sharedWires が担当)。
 */
import { wireCrossings, wireOverlap, type Point, type Rect } from "./routeEdge";
import type { EdgeSpec, NodeRect } from "./routeAll";
import { sourceKey } from "./sharedWires";

/**
 * 同じ出力の最初の縦通路をそろえ、ボックスを避けた一つの幹から枝を出す。
 * Input : paths = 線 id -> 折れ線 (この関数が書き換える), edges = 線の一覧, nodes = ボックスの矩形,
 *         scopes = 線 id -> その線が通る階層 (親のボックスの id)
 * Output: なし (束ねられる組だけ paths の経路を置き換える。ボックスを貫く・交差や重なりが増える候補は採らない)
 */
export function bundleFanout(paths: Map<string,Point[]>, edges: EdgeSpec[], nodes: NodeRect[], scopes: Map<string,string>): void {
  // 出どころ (同じ出力) ごとに線をまとめる
  const groups=new Map<string,EdgeSpec[]>();
  for(const e of edges) { const k=sourceKey(e),g=groups.get(k)??[];g.push(e);groups.set(k,g); }
  // 線分 a-b が矩形 r に当たるか (inset が正 = 内側に入ったときだけ、負 = 縁から |inset| px 以内に近づいても当たり)
  const hits=(a:Point,b:Point,r:Rect,inset:number) => Math.max(a.x,b.x)>r.x+inset && Math.min(a.x,b.x)<r.x+r.width-inset && Math.max(a.y,b.y)>r.y+inset && Math.min(a.y,b.y)<r.y+r.height-inset;
  for(const group of groups.values()) {
    if(group.length<2) continue; // 分岐しない線はそのまま
    const scope=scopes.get(group[0].id)??"";
    // 避ける相手: 同じ階層のボックスと、同じ階層を通る別の出力の線
    const relevant=nodes.filter(n=>n.parentId===scope && n.rect.width>0);
    const others=edges.filter(e=>scopes.get(e.id)===scope && sourceKey(e)!==sourceKey(group[0])).map(e=>paths.get(e.id)??[]);
    const s=group[0].s;
    // 幹が曲がる位置 (縦の通路の x) の候補: 出口から 40 / 64 px、今の経路が曲がっている位置、行き先との中間
    const xs=new Set<number>([s.x+40,s.x+64]);
    for(const e of group) {
      const p=paths.get(e.id)!;
      if(p.length>2) xs.add(p[1].x);
      if(e.t.x>s.x+64) xs.add((s.x+e.t.x)/2);
    }
    const parent=nodes.find(n=>n.id===scope);
    // 今の経路での、別の出力の線との交差と重なり (束ねた結果がこれより悪くなる候補は捨てる)
    const originalCross=group.reduce((n,e)=>n+wireCrossings(paths.get(e.id)!,others),0);
    const originalOverlap=group.reduce((n,e)=>n+wireOverlap(paths.get(e.id)!,others),0);
    let best:Map<string,Point[]>|null=null,bestScore=Infinity;
    for(const x of [...xs].sort((a,b)=>a-b)) {
      // 出口のすぐそば (12px 未満) と、親のボックスの右の縁の外は通路にしない
      if(x<s.x+12 || (parent && x>parent.rect.x+parent.rect.width-12)) continue;
      const candidates=new Map<string,Point[]>();let valid=true;
      for(const e of group) {
        const old=paths.get(e.id)!;
        // 束ねられるのは「まっすぐ (2 点)」か「横 → 縦 → …」で始まる経路だけ。それ以外が 1 本でもあれば、この組は触らない
        if(old.length!==2 && (old.length<4 || Math.abs(old[0].y-old[1].y)>.01 || Math.abs(old[1].x-old[2].x)>.01)) {valid=false;break;}
        let p:Point[];
        // 新しい経路: 出口から x まで横に進み (幹)、元の経路の 2 本目の横線の高さへ縦に移って、残りは元のまま
        if(old.length===2) {
          if(e.t.x<x || Math.abs(e.t.y-s.y)>.01) {valid=false;break;}
          p=[s,{x,y:s.y},{x,y:s.y},e.t];
        } else p=[s,{x,y:s.y},{x,y:old[2].y},...old.slice(3)];
        // 通路をまとめるために障害物を貫いたり、別のボックスの縁へ押し付けたりしない。
        for(let i=1;i<p.length;i++) for(const n of relevant) {
          const own=n.id===e.source||n.id===e.target;
          if(hits(p[i-1],p[i],n.rect,own?8:-8)) valid=false;
        }
        if(!valid) break;
        candidates.set(e.id,p);
      }
      if(!valid) continue;
      const crossings=group.reduce((n,e)=>n+wireCrossings(candidates.get(e.id)!,others),0);
      const overlap=group.reduce((n,e)=>n+wireOverlap(candidates.get(e.id)!,others),0);
      // 別の出力の線との交差・重なりが今より増えるなら、束ねない方がまし
      if(crossings>originalCross || overlap>originalOverlap) continue;
      // 共通の幹の長さは一度だけ数える。遠回りより短い、交差の少ない通路を選ぶ。
      const ends=group.map(e=>candidates.get(e.id)![2]?.y??s.y);
      let ink=x-s.x+Math.max(s.y,...ends)-Math.min(s.y,...ends);
      for(const p of candidates.values()) for(let i=3;i<p.length;i++) ink+=Math.abs(p[i].x-p[i-1].x)+Math.abs(p[i].y-p[i-1].y);
      const score=crossings*2000+ink;
      if(score<bestScore) {bestScore=score;best=candidates;}
    }
    // 採れる候補があった組だけ経路を置き換える (無ければ元の経路のまま)
    if(best) for(const [id,path] of best) paths.set(id,path);
  }
}

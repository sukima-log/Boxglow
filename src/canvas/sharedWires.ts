/**
 * 同じ出力から分岐する線の「共有する幹」を求める (純粋関数。描画専用で、経路そのものは変えない)
 * 同じ出力の線は出だしの区間が重なる。重ねて何度も描くと太く濃く見えるので、
 * 重なる区間は 1 本の線だけが描き、分かれる点に丸 (分岐点) を置く。
 */
import type { Point } from "./routeEdge";
import type { EdgeSpec } from "./routeAll";

/** 1 本の線の描き方 (RoutedEdge が data.shared で受け取る) */
export interface SharedWire {
  /** この線が自分で描く区間 (折れ線の配列)。ほかの線が描く幹の区間は含まない */
  parts: Point[][];
  /** この線が丸を描く分岐点 (1 つの分岐点は 1 本の線だけが描く) */
  junctions: Point[];
  /** 角を丸めない点 (同じ出力の分岐点すべて)。丸めると幹と枝の間にすき間ができるため */
  corners: Point[];
}
/** 点の比較用の文字列 (1/1000 px に丸める。小数の誤差で同じ点が別物にならないように) */
const key = (p: Point) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
/** 2 点が同じ位置か */
const same = (a: Point, b: Point) => key(a) === key(b);
/**
 * 線の出どころを表す鍵 (同じボックスの同じ出力の丸から出る線は同じ鍵になる)
 * Input : e = 線 (source = 出るボックスの id、s = 出る点)
 * Output: "ボックスの id|出る点" の文字列
 */
export const sourceKey = (e: EdgeSpec) => `${e.source}|${key(e.s)}`;

/**
 * 同じ出力の経路を線分単位で共有し、幹は一度だけ描画する。
 * 入力は論理的な全経路。出力は各 edge の可視部分と本物の分岐点。
 * 選んだ枝へ幹の描画を譲るため、強調時も途中で途切れない。無関係な信号は共有しない。
 * Input : paths = 線 id -> 折れ線 (routeAll の結果), edges = 画面に出ている線,
 *         priority = 幹を優先して描かせる線 (選択中・ホバー中の線の id)
 * Output: 線 id -> SharedWire (分岐しない線は parts が経路そのまま、junctions / corners は空)
 */
export function sharedWires(paths: Map<string, Point[]>, edges: EdgeSpec[], priority: Set<string> = new Set()): Map<string, SharedWire> {
  const result = new Map<string, SharedWire>();
  // 出どころ (同じ出力) ごとに線をまとめる。まず全部の線を「共有なし (経路そのまま)」で登録しておく
  const groups = new Map<string, EdgeSpec[]>();
  for (const e of edges) {
    const group = groups.get(sourceKey(e)) ?? [];
    group.push(e); groups.set(sourceKey(e), group);
    result.set(e.id, { parts: [paths.get(e.id) ?? []], junctions: [], corners: [] });
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue; // 1 本だけなら分岐は無い
    // 同じ出力の線すべての頂点。ほかの線の頂点で線分を区切ると、重なる区間が同じ「最小の線分 (atom)」になる
    const vertices = group.flatMap((e) => paths.get(e.id) ?? []);
    // atom = 最小の線分。owner = その区間を描く線 (最初に登録した線)
    const atoms = new Map<string, { a: Point; b: Point; owner: string }>();
    // 線ごとの atom の並び (出る点から入る点へ)
    const order = new Map<string, { a: Point; b: Point; atom: string }[]>();
    // 選択中・ホバー中の線を先に処理して幹の持ち主にする (強調した線が出力の丸から途切れずに見える)。残りは id 順で安定させる
    const sorted = [...group].sort((a, b) => Number(priority.has(b.id)) - Number(priority.has(a.id)) || a.id.localeCompare(b.id));
    for (const e of sorted) {
      const path = paths.get(e.id) ?? [], pieces: { a: Point; b: Point; atom: string }[] = [];
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i], h = Math.abs(a.y - b.y) < .01;
        if (same(a, b)) continue; // 長さ 0 の線分は飛ばす
        // この線分の途中にある、同じ出力の線の頂点 (h = 水平の線分か)。そこで区切る
        const between = vertices.filter((v) => h
          ? Math.abs(v.y - a.y) < .01 && v.x > Math.min(a.x,b.x) && v.x < Math.max(a.x,b.x)
          : Math.abs(v.x - a.x) < .01 && v.y > Math.min(a.y,b.y) && v.y < Math.max(a.y,b.y));
        const points = [a,...between,b].sort((p,q) => h ? (p.x-q.x)*Math.sign(b.x-a.x) : (p.y-q.y)*Math.sign(b.y-a.y));
        for (let j=1;j<points.length;j++) {
          const u=points[j-1],v=points[j];if(same(u,v)) continue;
          // 向きに関係なく同じ区間は同じ鍵にする。最初に通った線が持ち主 (描く線) になる
          const atom=[key(u),key(v)].sort().join("|");
          if (!atoms.has(atom)) atoms.set(atom,{a:u,b:v,owner:e.id});
          pieces.push({a:u,b:v,atom});
        }
      }
      order.set(e.id,pieces);
    }
    // 分岐点 = 3 方向以上に線分が出ている点 (幹から枝が分かれる所)。角や通過点は 2 方向なので含まれない
    const neighbors=new Map<string,Set<string>>(), points=new Map<string,Point>();
    for(const {a,b} of atoms.values()) for(const [u,v] of [[a,b],[b,a]]) {
      const k=key(u), list=neighbors.get(k)??new Set<string>();list.add(key(v));neighbors.set(k,list);points.set(k,u);
    }
    const junctions=[...neighbors].filter(([,n])=>n.size>=3).map(([k])=>points.get(k)!);
    // 線ごとに「自分が持ち主の atom」だけをつないで、描く区間 (折れ線) にまとめ直す。他の線が描く区間で折れ線を切る
    for(const e of group) {
      const parts:Point[][]=[];let current:Point[]=[];
      for(const piece of order.get(e.id)??[]) {
        if(atoms.get(piece.atom)!.owner!==e.id) { if(current.length>1) parts.push(current);current=[];continue; }
        if(current.length && same(current[current.length-1],piece.a)) current.push(piece.b);
        else { if(current.length>1) parts.push(current);current=[piece.a,piece.b]; }
      }
      if(current.length>1) parts.push(current);
      result.set(e.id,{parts,junctions:[],corners:junctions});
    }
    // 分岐点の丸は、その点を通る線のうち優先度が一番高い 1 本だけが描く (重ねて描かない。選択中の線なら選択の色になる)
    for(const point of junctions) {
      const owner=sorted.find(e=>(order.get(e.id)??[]).some(p=>same(p.a,point)||same(p.b,point)));
      if(owner) result.get(owner.id)!.junctions.push(point);
    }
  }
  return result;
}

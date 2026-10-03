import { describe, expect, it } from "vitest";
import { routeEdge } from "./routeEdge";

describe("線の経路探索", () => {
  it("間に箱が無ければ Z 型 (曲がり 2 回) で結ぶ", () => {
    const path = routeEdge({ x: 100, y: 50 }, { x: 400, y: 150 }, []);
    expect(path.length).toBe(4);
    expect(path[0]).toEqual({ x: 100, y: 50 });
    expect(path[3]).toEqual({ x: 400, y: 150 });
  });

  it("間に箱があれば、それを避けて通る", () => {
    const box = { x: 200, y: 20, width: 120, height: 200 };
    const path = routeEdge({ x: 100, y: 100 }, { x: 500, y: 120 }, [box]);
    // どの線分も箱の内側を通らない
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      const hits = x1 > box.x + 1 && x0 < box.x + box.width - 1 && y1 > box.y + 1 && y0 < box.y + box.height - 1;
      expect(hits).toBe(false);
    }
  });

  it("戻る線の真下 (出た直後の縦の通路) に箱があっても貫かない (右の隙間へ回る)", () => {
    // 出す側の箱 (右上) の真下に別の箱が右へはみ出して並び、受ける側は左下
    const src = { x: 1100, y: 350, width: 180, height: 40 };
    const below = { x: 1100, y: 430, width: 210, height: 40 }; // 右端が出す側より 30px 右 → x1 (= s.x + 40) の通路にかかる
    const dst = { x: 300, y: 550, width: 200, height: 60 };
    const path = routeEdge({ x: 1280, y: 370 }, { x: 300, y: 580 }, [below], 0, [src, dst]);
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      const hits = x1 > below.x + 1 && x0 < below.x + below.width - 1 && y1 > below.y + 1 && y0 < below.y + below.height - 1;
      expect(hits).toBe(false);
    }
  });

  it("戻る線が受ける側の箱を反対側 (右) から貫いてポートに届くことはない", () => {
    // 受ける側 (左下) の入力ポートの高さに横の通路が来やすい配置 (出す側は右上、間に障害物なし)
    const src = { x: 1000, y: 100, width: 200, height: 60 };
    const dst = { x: 100, y: 400, width: 600, height: 300 }; // 大きな箱。入力は左の縁 (x = 100) の y = 500
    const path = routeEdge({ x: 1200, y: 130 }, { x: 100, y: 500 }, [], 0, [src, dst]);
    const inner = { x: dst.x + 8, y: dst.y + 8, width: dst.width - 16, height: dst.height - 16 };
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      const hits = x1 > inner.x && x0 < inner.x + inner.width && y1 > inner.y && y0 < inner.y + inner.height;
      expect(hits).toBe(false);
    }
    // 受ける側へは左から入る (最後の線分は右向き、x は箱の左縁まで)
    const last = path[path.length - 1], prev = path[path.length - 2];
    expect(prev.x).toBeLessThan(last.x);
  });

  it("箱と箱の隙間が余白 2 つ分 (72px) に満たなくても、箱を貫かずに隙間を詰めて通る", () => {
    // 段違いの配置: 出す側 (左上) の右に横長の箱、その下に 2 段目の箱。1 段目の右の箱の下端と 2 段目の上端の隙間は 60px しかない。
    // 受ける側は右端の 1 段目。親の箱は上 (題名の行) にも下にも余裕が無く、上の段を横切るには右の箱を貫くしかなく、
    // 下へ回るには 60px の隙間を通るしかない
    const src = { x: 100, y: 80, width: 200, height: 80 };
    const wide = { x: 500, y: 80, width: 600, height: 150 }; // 下端 230
    const second = { x: 500, y: 290, width: 300, height: 100 }; // 上端 290 → 隙間 60px。下端 390
    const tall = { x: 1300, y: 80, width: 300, height: 150 }; // 下端 230 (受ける側の左隣)
    const third = { x: 500, y: 450, width: 300, height: 100 }; // 3 段目 (2 段目との隙間も 60px)。下端 550
    const dst = { x: 1800, y: 80, width: 200, height: 80 };
    const bounds = { x: 0, y: 0, width: 2100, height: 555 }; // 題名の行 (76px) の直下に箱、下の縁は 3 段目の箱のすぐ下
    const path = routeEdge({ x: 300, y: 120 }, { x: 1800, y: 120 }, [wide, second, tall, third], 0, [src, dst], bounds);
    for (const box of [wide, second, tall, third]) {
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1];
        const b = path[i];
        const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
        const hits = x1 > box.x + 1 && x0 < box.x + box.width - 1 && y1 > box.y + 1 && y0 < box.y + box.height - 1;
        expect(hits).toBe(false);
      }
    }
    // 60px の隙間 (230..290 または 390..450) を通っている
    expect(path.some((q) => (q.y > 230 && q.y < 290) || (q.y > 390 && q.y < 450))).toBe(true);
  });

  it("受ける側が左にある (戻る線) ときも経路が作れる", () => {
    const path = routeEdge({ x: 500, y: 100 }, { x: 100, y: 300 }, [{ x: 150, y: 80, width: 300, height: 100 }]);
    expect(path[0]).toEqual({ x: 500, y: 100 });
    expect(path[path.length - 1]).toEqual({ x: 100, y: 300 });
    expect(path.length).toBeGreaterThanOrEqual(4);
  });
});

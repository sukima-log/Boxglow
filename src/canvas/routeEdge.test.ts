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

  it("受ける側が左にある (戻る線) ときも経路が作れる", () => {
    const path = routeEdge({ x: 500, y: 100 }, { x: 100, y: 300 }, [{ x: 150, y: 80, width: 300, height: 100 }]);
    expect(path[0]).toEqual({ x: 500, y: 100 });
    expect(path[path.length - 1]).toEqual({ x: 100, y: 300 });
    expect(path.length).toBeGreaterThanOrEqual(4);
  });
});

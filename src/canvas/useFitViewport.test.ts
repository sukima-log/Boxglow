import { describe, expect, it } from "vitest";
import { constrainVertical, availableCanvas } from "./useFitViewport";
describe("availableCanvas", () => {
  const canvas = { x: 260, y: 64, width: 1000, height: 700 };
  it("does not subtract side-by-side panels twice", () => {
    expect(availableCanvas(canvas, [{x:0,y:64,width:260,height:700},{x:1260,y:64,width:320,height:700}])).toEqual({x:0,y:0,width:1000,height:700});
  });
  it("excludes inset left drawer and overlaid right inspector", () => {
    expect(availableCanvas(canvas, [{x:268,y:72,width:280,height:680},{x:940,y:64,width:320,height:700}])).toEqual({x:288,y:0,width:392,height:700});
  });
  it("uses the union for overlapping left panels", () => {
    expect(availableCanvas({x:0,y:0,width:800,height:600}, [{x:0,y:0,width:260,height:600},{x:8,y:8,width:300,height:584}])).toEqual({x:308,y:0,width:492,height:600});
  });
  it("defers fitting when panels cover the entire canvas", () => {
    expect(availableCanvas(canvas,[{x:260,y:64,width:1000,height:700}])).toBeNull();
  });
});

it("縦の移動候補を先頭/末尾で止め、繰り返しても同じ座標を返す",()=>{
 const region={x:80,y:0,width:800,height:600},bounds={x:100,y:200,width:500,height:2000};
 const top=constrainVertical({x:0,y:9999,zoom:1},bounds,region,null);
 const bottom=constrainVertical({x:0,y:-9999,zoom:1},bounds,region,null);
 expect(top.y).toBe(32-200);expect(bottom.y).toBe(600-48-2200);
 expect(constrainVertical(top,bounds,region,null)).toEqual(top);
 expect(constrainVertical(bottom,bounds,region,null)).toEqual(bottom);
 const fit={x:300,y:24,zoom:.2};
 expect(constrainVertical({x:-10,y:-999,zoom:.2},bounds,region,fit)).toEqual(fit);
});

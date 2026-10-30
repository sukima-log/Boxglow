/**
 * 図の線の太さの倍率 (縮小したときに線を太くする)
 */

/**
 * 線の太さの倍率: 縮小するほど線を太くする (100% 以上で 1、縮むにつれて (1/倍率)^0.6、上限 3)。
 * 線は画面上の太さ (non-scaling-stroke) なので、遠くから見ると細い破線が背景に溶けて見えなかった (利用者の指摘 2026-10-30)
 * Input : zoom = 今の倍率 (1 = 100%) / Output: 倍率 (0.05 刻みに丸める。細かく変えて描き直しを増やさない)
 */
export function edgeScale(zoom: number): number {
  const k = Math.min(3, Math.max(1, Math.pow(1 / Math.max(zoom, 0.01), 0.6)));
  return Math.round(k * 20) / 20;
}


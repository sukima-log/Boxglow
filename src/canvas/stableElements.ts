/**
 * 図の部品 (React Flow の箱・線) を作り直したとき、中身が変わっていない部品は前のオブジェクトをそのまま使う
 *   React Flow は、前と同じオブジェクト (===) の部品だけを使い回す。新しいオブジェクトの箱は「まだ測っていない」扱いになり、
 *   丸の位置を DOM から測り直し、そのたびに全部の箱・線の部品へ通知が届く。
 *   箱を選ぶたびに全部を作り直していたため、箱が 1000 ある階層では選ぶだけで 13 秒かかった (2026-11-02 計測)
 */

/** React Flow が自分で書き込む項目 (比べない。測った大きさ・ドラッグ中の印) */
const RF_OWNED = new Set(["measured", "dragging", "resizing"]);

/**
 * 2 つの値が同じ中身か (図の部品の中身向け: 数・文字・真偽・配列・普通のオブジェクト。関数は同じものだけを同じとみなす)
 * Input : a, b = 比べる値 / Output: 同じなら true
 */
export function sameContent(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameContent(a[i], bb[i])) return false;
    return true;
  }
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!sameContent((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/**
 * 部品 2 つが、React Flow が自分で書き込む項目を除いて同じ中身か
 * Input : prev = 前に渡した部品 (React Flow が書き込んだ項目を含む), next = 作り直した部品 / Output: 同じなら true
 */
export function sameElement(prev: object, next: object): boolean {
  const p = prev as Record<string, unknown>, n = next as Record<string, unknown>;
  for (const k of Object.keys(n)) if (!RF_OWNED.has(k) && !sameContent(p[k], n[k])) return false;
  for (const k of Object.keys(p)) if (!RF_OWNED.has(k) && !(k in n) && p[k] !== undefined) return false;
  return true;
}

/**
 * 作り直した部品の一覧のうち、中身が変わっていないものを前のオブジェクトに差し替える
 * Input : prev = 前に渡した一覧, next = 作り直した一覧,
 *         opts.carryMeasured = true なら、変わった箱でも大きさ (width / height) が同じなら測った大きさを引き継ぐ (測り直しの間に「未測定」にしない)
 *         opts.alwaysChanged = 中身によらず作り直したものを使う部品 (部品の項目に表れない中身で丸の位置が変わるもの)
 * Output: items = React Flow に渡す一覧 (全部同じなら prev そのもの), changed = 差し替えなかった部品のうち前にもあったものの id (丸の位置を測り直す対象)
 */
export function reuseUnchanged<T extends { id: string }>(
  prev: T[]
, next: T[]
, opts: { carryMeasured?: boolean; alwaysChanged?: (item: T) => boolean } = {}
): { items: T[]; changed: string[] } {
  const before = new Map(prev.map((x) => [x.id, x]));
  const changed: string[] = [];
  let allSame = prev.length === next.length;
  const items = next.map((n, i) => {
    const p = before.get(n.id);
    if (p && !opts.alwaysChanged?.(n) && sameElement(p, n)) {
      if (prev[i] !== p) allSame = false;
      return p;
    }
    allSame = false;
    if (!p) return n;
    changed.push(n.id);
    // 大きさが同じなら測った大きさを引き継ぐ (React Flow は測った大きさが無い箱を「未測定」にし、その間は線の端が分からなくなる)
    const pm = (p as { measured?: unknown; width?: number; height?: number });
    const nn = (n as { width?: number; height?: number });
    if (opts.carryMeasured && pm.measured && pm.width === nn.width && pm.height === nn.height) return { ...n, measured: pm.measured } as T;
    return n;
  });
  return { items: allSame ? prev : items, changed };
}

/**
 * 表示領域に応じた縮小下限と、ホイールによる移動を共用する。
 * パネルの開閉・内容更新・ウィンドウ変更では、手で調整した位置と倍率を維持する。
 */
import { getViewportForBounds, useReactFlow, type Viewport } from "@xyflow/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 図に重なる左右パネルだけを除く。横に並ぶパネルの幅は二重に引かない。
 * Input: キャンバスとパネルの画面矩形。Output: 使用可能な相対矩形 (狭すぎれば null)
 */
export function availableCanvas(canvas: Area, panels: Area[]): Area | null {
  let left = canvas.x, right = canvas.x + canvas.width;
  for (const panel of panels) {
    if (panel.y >= canvas.y + canvas.height || panel.y + panel.height <= canvas.y) continue;
    if (panel.x <= canvas.x + 1 && panel.x + panel.width > canvas.x)
      left = Math.max(left, panel.x + panel.width);
    if (panel.x < canvas.x + canvas.width && panel.x + panel.width >= canvas.x + canvas.width - 1)
      right = Math.min(right, panel.x);
    // 左引き出しはキャンバス端から 8px 内側に置かれる。
    if (panel.x > canvas.x && panel.x <= canvas.x + 16)
      left = Math.max(left, panel.x + panel.width);
  }
  return right - left >= 48 && canvas.height >= 48
    ? { x: left - canvas.x, y: 0, width: right - left, height: canvas.height } : null;
}
const MIN_ZOOM = 0.001;
const different = (a: Viewport, b: Viewport) => Math.abs(a.x - b.x) > .5 || Math.abs(a.y - b.y) > .5 || Math.abs(a.zoom - b.zoom) > .00001;
/**
 * 移動の候補を先に制限し、限界を越えたフレームを描かせない。
 * Input: 移動候補、図の境界、使用可能領域、Fit の位置。Output: 境界内の viewport
 */
export function constrainVertical(view: Viewport, bounds: Area, region: Area, fit: Viewport | null): Viewport {
  if (fit && view.zoom <= fit.zoom + .0001) return fit;
  const z = view.zoom;
  const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
  const x = bounds.width * z <= region.width - 48
    ? region.x + (region.width - bounds.width * z) / 2 - bounds.x * z
    : clamp(view.x, region.x + region.width - 24 - (bounds.x + bounds.width) * z, region.x + 24 - bounds.x * z);
  const y = bounds.height * z <= region.height - 80
    ? (region.height - bounds.height * z) / 2 - bounds.y * z
    : clamp(view.y, region.height - 48 - (bounds.y + bounds.height) * z, 32 - bounds.y * z);
  return { x, y, zoom: z };
}

/**
 * Fit と縮小下限を共用。パネル・ウィンドウ・階層の寸法に追従する。
 * Input: 図形の変更印、パネルの変更印、ドラッグ中か、縦表示か
 * Output: 下限倍率、全体表示・幅合わせ・移動イベントのハンドラー
 */
export function useFitViewport(geometry: string, panelLayoutKey: string, dragging: boolean, vertical = false) {
  const rf = useReactFlow();
  const [minZoom, setMinZoom] = useState(MIN_ZOOM);
  // 今の縮小の下限 (fit の中から最新の値を読むため。state は描画まで古い値のまま)
  const minZoomNow = useRef(MIN_ZOOM);
  minZoomNow.current = minZoom;
  const area = useRef<Area | null>(null);
  const fitted = useRef<Viewport | null>(null);
  const draggingNow = useRef(dragging);
  draggingNow.current = dragging;
  const windowSize = useRef<{
    width: number;
    height: number;
  } | null>(null);
  const moveStartZoom = useRef<number | null>(null);
  /** Input: 測定済みノード。Output: 表示対象全体の矩形 (未測定なら null) */
  const boundsNow = useCallback(() => {
    const nodes = rf.getNodes().filter(n => !n.hidden && (n.measured?.width ?? 0) > 0);
    return nodes.length ? rf.getNodesBounds(nodes) : null;
  }, [rf]);

  /** Input: 現在の図と使用可能領域。Output: 幅に合わせて先頭を読む位置 */
  const readingTarget = useCallback(() => {
    const b = boundsNow(), region = area.current;
    if (!b || !region) return null;
    const zoom = Math.min(1, (region.width * .9) / Math.max(b.width, 1));
    return { x: region.x + (region.width - b.width * zoom) / 2 - b.x * zoom, y: 32 - b.y * zoom, zoom };
  }, [boundsNow]);
  /** Input: なし。Output: 幅合わせ位置を viewport に反映 */
  const readFromTop = useCallback(() => {
    const v = readingTarget();
    if (!v) return;
    void rf.setViewport(v);
  }, [rf, readingTarget]);
  /** Input: 対象 ID (省略時は全体)。Output: 使用可能領域へ収まる位置・倍率 */
  const target = useCallback((ids?: string[]) => {
    const region = area.current;
    const nodes = rf.getNodes().filter(n => !n.hidden && (n.measured?.width ?? 0) > 0 && (!ids || ids.includes(n.id)));
    if (!region || !nodes.length) return null;
    const bounds = rf.getNodesBounds(nodes);
    const v = getViewportForBounds(bounds, region.width, region.height, MIN_ZOOM, 1, ids ? .3 : .12);
    return { x: v.x + region.x, y: v.y + region.y, zoom: v.zoom };
  }, [rf]);

  /**
   * Input: 対象 ID。Output: 明示的な全体表示を実行
   * 全体表示の倍率が今の縮小の下限より小さいときは、先に下限を下げてから表示を合わせる。
   * (タブの切り替えの途中、ボックスを一部しか測れていない瞬間に下限が高く決まると、
   *  そのままでは全体表示が下限に押し戻され、Fit を押しても 100% から動かなくなるため)
   */
  const fit = useCallback((ids?: string[]) => {
    const v = target(ids);
    if (!v) return;
    if (!ids) { fitted.current = v; }
    if (v.zoom < minZoomNow.current) {
      setMinZoom(v.zoom);
      // 下限の変更が図に届いてから (次の描画の後に) 表示を合わせる
      requestAnimationFrame(() => requestAnimationFrame(() => void rf.setViewport(v, { duration: 150 })));
      return;
    }
    void rf.setViewport(v, { duration: 150 });
  }, [rf, target]);
  /**
  * 図と利用可能領域を計測して縮小下限を更新する。
  * Input: DOM と測定済みノード。ドラッグ中は寸法確定を待つ
  * Output: 下限倍率。初回と全体表示中のウィンドウ変更以外は原則位置を維持する
  */
  const updateBounds = useCallback(() => {
    if (draggingNow.current) return;
    const canvas = document.querySelector<HTMLElement>(".react-flow");
    if (!canvas) return;
    const panels = [...document.querySelectorAll<HTMLElement>(".tree-panel, .drawer, .panel.right:not(.hidden-panel)")];
    const nextArea = availableCanvas(canvas.getBoundingClientRect(), panels.filter(p => p.getClientRects().length).map(p => p.getBoundingClientRect()));
    area.current = nextArea;
    const nextFit = target();
    if (!nextFit || !nextArea) return;
    const previousFit = fitted.current;
    const first = !previousFit;
    const resized = windowSize.current && (windowSize.current.width !== window.innerWidth || windowSize.current.height !== window.innerHeight);
    windowSize.current = { width: window.innerWidth, height: window.innerHeight };
    fitted.current = nextFit;
    setMinZoom(nextFit.zoom);
    const current = rf.getViewport();
    // 倍率だけでなく位置も比較し、Fit倍率でパンした状態を全体表示と混同しない。
    const wasFitted = previousFit && !different(current, previousFit);
    if (first || (resized && wasFitted)) {
      const next = first && vertical ? readingTarget() ?? nextFit : nextFit;
      if (different(current, next))
        void rf.setViewport(next);
    }
    else if (current.zoom < nextFit.zoom - .00001) {
      // 領域が広がった場合だけ下限を引き上げる。Fit の中心への強制移動はしない。
      const ratio = nextFit.zoom / current.zoom;
      const cx = nextArea.x + nextArea.width / 2;
      const cy = nextArea.y + nextArea.height / 2;
      void rf.setViewport({ x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio, zoom: nextFit.zoom });
    }
  }, [rf, target, vertical, readingTarget]);
  // 監視の寿命をノード位置の変化から切り離す。ドラッグの各フレームで作り直さない。
  useLayoutEffect(() => {
    const canvas = document.querySelector<HTMLElement>(".react-flow");
    if (!canvas) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateBounds);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);
    for (const panel of document.querySelectorAll<HTMLElement>(".tree-panel, .drawer, .panel.right:not(.hidden-panel)"))
      observer.observe(panel);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
    };
  }, [panelLayoutKey, updateBounds]);
  // 内容・寸法が変わっても下限の再計算だけを行う。パネル監視は継続する。
  useLayoutEffect(() => { updateBounds(); }, [geometry, dragging, updateBounds]);
  // 縦の通常ホイールは「移動してから戻す」のではなく、制限した座標だけを反映する。
  // 両表示で Shift は縦移動、Ctrl+Shift は横移動。Ctrl/ピンチは既存のズームへ渡す。
  useEffect(() => {
    const canvas = document.querySelector<HTMLElement>(".react-flow");
    if (!canvas) return;
    const wheel = (event: WheelEvent) => {
      const element = event.target instanceof Element ? event.target : null;
      if (event.defaultPrevented || element?.closest(".nowheel, .react-flow__panel, .react-flow__minimap, input, textarea, select, [contenteditable=true]")) return;
      const current = rf.getViewport(), fit = fitted.current;
      const zoomKey = event.ctrlKey || event.metaKey;
      if (event.shiftKey) {
        const b = boundsNow(), region = area.current;
        if (!b || !region) return;
        if (fit && current.zoom <= fit.zoom + .0001) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        const axis = zoomKey ? "x" : "y";
        const units = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? (zoomKey ? region.width : region.height) : 1;
        // Shift によって横デルタへ変換される環境でも同じ操作になる。
        const delta = event.deltaY || event.deltaX;
        const candidate = { ...current, [axis]: current[axis] - delta * units * .5 };
        const next = { ...current, [axis]: constrainVertical(candidate, b, region, fit)[axis] };
        if (different(current, next))
          void rf.setViewport(next);
      }
      else if (event.deltaY > 0 && fit && current.zoom <= fit.zoom + .0001 && (!vertical || zoomKey)) {
        // 下限でさらに縮小しても、手で移動した viewport を Fit 中心へ戻さない。
      }
      else if (!vertical) {
        return;
      }
      else if (zoomKey) {
        return;
      }
      else {
        if (fit && current.zoom <= fit.zoom + .0001) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        const b = boundsNow(), region = area.current;
        if (!b || !region) return;
        const units = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? region.height : 1;
        const next = constrainVertical({ ...current, y: current.y - event.deltaY * units * .5 }, b, region, fit);
        if (different(current, next))
          void rf.setViewport(next);
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    canvas.addEventListener("wheel", wheel, { capture: true, passive: false });
    return () => canvas.removeEventListener("wheel", wheel, true);
  }, [vertical, rf, boundsNow]);
  /** 操作前の倍率を記憶し、パンと縮小を区別する。Input/Output: なし */
  const onMoveStart = useCallback(() => { moveStartZoom.current = rf.getViewport().zoom; }, [rf]);
  /**
  * 実際に縮小して下限へ到達したときだけ全体を収める。
  * Input: 操作開始時と終了時の倍率。Output: 必要な場合だけ位置補正
  * 同じ倍率でのドラッグ・選択・更新を理由に Fit 中心へ戻さない。
  */
  const onMoveEnd = useCallback(() => {
    const fit = fitted.current;
    const current = rf.getViewport();
    const started = moveStartZoom.current;
    moveStartZoom.current = null;
    if (fit && started !== null && started > current.zoom + .00001 && current.zoom <= fit.zoom + .0001) {
      if (different(current, fit))
        void rf.setViewport(fit);
    }
  }, [rf]);
  return { minZoom, fit, readFromTop, onMoveStart, onMoveEnd };
}

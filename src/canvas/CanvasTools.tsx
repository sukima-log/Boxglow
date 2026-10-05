/**
 * キャンバスの操作欄 (図の左下): 倍率・Fit (全体表示)・To selection (選択へ移動) と、View (表示と配置) の引き出し (凡例・吸着・階層の整列・ミニマップ・操作の説明)
 * 図の中ではなく React Flow の Panel に置くので、図を拡大縮小しても文字の大きさは変わらない。
 * 丸をクリックして結線している最中は、図の上に案内とキャンセルのボタンも出す。
 */
import { Panel, useReactFlow, useStore, useStoreApi } from "@xyflow/react";
import { useEffect, useRef } from "react";
import { t, useLang } from "../i18n";
import { layoutScope } from "../model/autolayout";
import { useProjectStore } from "../store/useProjectStore";

/**
 * キャンバスの操作欄
 * Input : snap = 吸着 (8px のグリッド) が有効か, onSnap = 吸着の切り替え,
 *         showMap = ミニマップを出しているか, onMap = ミニマップの切り替え (状態は FlowCanvas が持つ)
 * Output: 操作欄の JSX (結線中は案内の帯も)。ReactFlow の子として置くこと (useReactFlow を使うため)
 */
export function CanvasTools({ snap, onSnap, showMap, onMap }: { snap: boolean; onSnap: () => void; showMap: boolean; onMap: () => void }) {
  useLang(); // 言語が変わったら描き直す
  const menu = useRef<HTMLDetailsElement>(null);
  // View (表示と配置) の引き出しは、外を押すか Esc で閉じる (details は自動では閉じない)。Esc のときは開いたボタンへフォーカスを戻す
  useEffect(() => {
    const close = (e: PointerEvent) => { if (menu.current && !menu.current.contains(e.target as Node)) menu.current.open = false; };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape" && menu.current?.open) { menu.current.open = false; menu.current.querySelector("summary")?.focus(); } };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, []);
  const rf = useReactFlow();
  const flow = useStoreApi();
  const zoom = useStore((s) => s.transform[2]); // 今の倍率 (1 = 100%)
  // 結線の途中か (ドラッグ中、または出力の丸をクリックして接続先を待っている)
  const connecting = useStore((s) => s.connection.inProgress || !!s.connectionClickStartHandle);
  const canEdit = useProjectStore((s) => !s.readonly && s.editMode);
  const scope = useProjectStore((s) => s.viewScope);
  const selection = useProjectStore((s) => s.selection);
  // To selection で画面に収めるボックス: ボックスを選んでいればそのボックス、線を選んでいればその線 (と境界を越えた続き) の両端のボックス
  const selectedNodes = selection.blockId
    ? [selection.blockId].filter((id) => rf.getNode(id))
    : selection.edgeId
      ? [...new Set(rf.getEdges().filter((e) => !e.hidden && (e.id === selection.edgeId || e.data?.net)).flatMap((e) => [e.source, e.target]))]
      : [];
  const apply = useProjectStore((s) => s.apply);
  const toast = useProjectStore((s) => s.setToast);
  /** 結線の途中をやめる (ドラッグ中の線と、クリックで選んだ出力の両方を取り消す)。Input / Output: なし */
  const cancel = () => {
    flow.getState().cancelConnection();
    flow.setState({ connectionClickStartHandle: null });
  };
  // Edit をやめたら (View に戻したら) 接続待ちも取り消す。View では結線できないため
  useEffect(() => {
    if (!canEdit) cancel();
  }, [canEdit, flow]);
  // Esc で結線の途中をやめる
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") cancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flow]);
  /** 全体表示: 今の階層のボックスがすべて収まる倍率にする (拡大は 100% まで)。Input / Output: なし */
  const fit = () => void rf.fitView({ padding: .15, minZoom: .05, maxZoom: 1, duration: 150 });
  /** 今開いているタブ (階層) の直下のボックスだけを整列する。子の中の配置は変えない。Ctrl+Z で戻せる。Input / Output: なし */
  const align = () => {
    if (!scope || !canEdit) return;
    apply((p) => layoutScope(p, scope, { recursive: false }));
    toast(t("この階層を整列しました。Ctrl+Z で元に戻せます。"));
    requestAnimationFrame(() => requestAnimationFrame(fit));
  };
  return <>
    {connecting && <Panel position="top-center" className="canvas-connect-hint">
      <span role="status">{t("接続先の入力をクリック。Esc でキャンセル")}</span>
      <button className="btn btn-sm" onClick={cancel}>{t("キャンセル")}</button>
    </Panel>}
    <Panel position="bottom-left" className="canvas-tools">
      <div className="canvas-tools__buttons" role="group" aria-label={t("キャンバスの表示")}>
        <span className="canvas-density-label">{zoom < 0.65 && !canEdit ? t("俯瞰表示") : t("通常表示")}</span>
        <button onClick={() => void rf.zoomOut()} title={t("縮小")} aria-label={t("縮小")}>−</button>
        <button onClick={() => void rf.zoomTo(1)} title={t("100% で文字を読む")} aria-label={t("100% で文字を読む")}>{Math.round(zoom * 100)}%</button>
        <button onClick={() => void rf.zoomIn()} title={t("拡大")} aria-label={t("拡大")}>＋</button>
        <button onClick={fit} title={t("全体表示: この階層のボックスがすべて収まる倍率にする")}>Fit</button>
        {selectedNodes.length > 0 && <button onClick={() => void rf.fitView({ nodes: selectedNodes.map((id) => ({ id })), padding: .3, minZoom: .05, maxZoom: 1, duration: 150 })} title={t("選んだボックス (線を選んでいれば両端のボックス) へ移動")}>To selection</button>}
        <details ref={menu} className="canvas-tools__settings">
          <summary title={t("表示と配置 (凡例・吸着・整列・ミニマップ・操作の説明)")}>View</summary>
          <div className="canvas-tools__popover">
      <div className="canvas-tools__legend" aria-label={t("配線の凡例")}>
        <span><i />{t("未確定")}</span><span><i className="ready" />{t("確定済み")}</span><span><i className="selected" />{t("選択中の経路")}</span>
      </div>
            <div className="canvas-tools__buttons">
        {canEdit && <button aria-pressed={snap} onClick={onSnap} title={t("ドラッグしたボックスを 8px のグリッドに揃える")}>{t("吸着")}</button>}
        {canEdit && scope && <button onClick={align} title={t("この階層のボックスだけを整列。子の中や別の階層の配置は保持します。")}>{t("この階層を整列")}</button>}
              <button aria-pressed={showMap} onClick={onMap}>{t("ミニマップ")}</button>
            </div>
            <p>{canEdit ? t("右の出力 → 左の入力の順に丸をクリック、またはドラッグで接続。線を選ぶと経路を追えます。") : t("線を選ぶと経路を追えます。ボックスの移動・接続は上部の Edit で有効にできます。")}</p>
            <p>{t("ボックスをダブルクリックすると中を開きます。100% は文字を読む倍率、Fit は配置を見渡す倍率です。")}</p>
            <p>{t("分岐点の丸は同じ出力のつながりです。丸のない交差は接続されていません。")}</p>
          </div>
        </details>
      </div>

    </Panel>
  </>;
}

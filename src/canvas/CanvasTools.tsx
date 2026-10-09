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
export function CanvasTools({ snap, onSnap, showMap, onMap, fit, readFromTop }: { readFromTop: () => void; fit: (ids?: string[]) => void; snap: boolean; onSnap: () => void; showMap: boolean; onMap: () => void }) {
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
  const flowDirection = useProjectStore(s => s.flowDirection);
  const vertical = !canEdit && flowDirection === "vertical";
  const verticalWrap = useProjectStore(s => s.verticalWrap);
  const setVerticalWrap = useProjectStore(s => s.setVerticalWrap);
  const readingView = useProjectStore(s => s.readingView);
  const setReadingView = useProjectStore(s => s.setReadingView);
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
  /** 今開いているタブ (階層) の直下のボックスだけを整列する。子の中の配置は変えない。Ctrl+Z で戻せる。Input / Output: なし */
  const align = () => {
    if (!scope || !canEdit) return;
    apply((p) => layoutScope(p, scope, { recursive: false }));
    toast(t("この階層を整列しました。Ctrl+Z で元に戻せます。"));
    requestAnimationFrame(() => requestAnimationFrame(() => fit()));
  };
  return <>
    {connecting && <Panel position="top-center" className="canvas-connect-hint">
      <span role="status">{t("接続先の入力をクリック。Esc でキャンセル")}</span>
      <button className="btn btn-sm" onClick={cancel}>{t("キャンセル")}</button>
    </Panel>}
    <Panel position="bottom-left" className="canvas-tools">
      <div className="canvas-tools__buttons" role="group" aria-label={t("キャンバスの表示")}>
        <button onClick={() => void rf.zoomOut()} title={t("縮小")} aria-label={t("縮小")}>−</button>
        <button onClick={() => void rf.zoomTo(1)} title={t("100% で文字を読む")} aria-label={t("100% で文字を読む")}>{Math.round(zoom * 100)}%</button>
        <button onClick={() => void rf.zoomIn()} title={t("拡大")} aria-label={t("拡大")}>＋</button>
        <button className="canvas-tools__fit-all" onClick={() => fit()} aria-label="Fit" title={t("全体表示: この階層のボックスがすべて収まる倍率にする")}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5" />
            <rect x="8" y="8" width="8" height="8" rx="1" />
          </svg>
        </button>
        {vertical && <button className="canvas-tools__fit-width" onClick={readFromTop} aria-label={t("幅に合わせる")} title={t("横幅に合わせて、先頭から読む")}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 5v14M21 5v14M5 12h14M8 9l-3 3 3 3M16 9l3 3-3 3" />
          </svg>
        </button>}
        {vertical && <button className="canvas-tools__wrap" aria-label={t("折り返し")} aria-pressed={verticalWrap} onClick={() => setVerticalWrap(!verticalWrap)} title={t("並行するボックスを段に折り返す")}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 6h12a5 5 0 0 1 0 10H9m3-3-3 3 3 3M3 11h5M3 16h2" />
          </svg>
        </button>}
        <ViewSwitch />
        {selectedNodes.length > 0 && <button onClick={() => fit(selectedNodes)} title={t("選んだボックス (線を選んでいれば両端のボックス) へ移動")}>To selection</button>}
        <details ref={menu} className="canvas-tools__settings">
          <summary title={t("表示と配置 (凡例・吸着・整列・ミニマップ・操作の説明)")}>View</summary>
          <div className="canvas-tools__popover">
      <div className="canvas-tools__legend" aria-label={t("配線の凡例")}>
        <span><i />{t("未確定")}</span><span><i className="ready" />{t("確定済み")}</span><span><i className="selected" />{t("選択中の経路")}</span>
      </div>
            <div className="canvas-tools__buttons">
        {!canEdit && !vertical && <button aria-pressed={readingView} onClick={() => setReadingView(!readingView)} title={t("工程順に並べて表示。オフにすると保存した配置を表示します。")}>{t("工程順")}</button>}
        {canEdit && <button aria-pressed={snap} onClick={onSnap} title={t("ドラッグしたボックスを 8px のグリッドに揃える")}>{t("吸着")}</button>}
        {canEdit && scope && <button onClick={align} title={t("この階層のボックスだけを整列。子の中や別の階層の配置は保持します。")}>{t("この階層を整列")}</button>}
              <button aria-pressed={showMap} onClick={onMap}>{t("ミニマップ")}</button>
            </div>
            <p>{canEdit ? t("右の出力 → 左の入力の順に丸をクリック、またはドラッグで接続。線を選ぶと経路を追えます。") : t("線を選ぶと経路を追えます。ボックスの移動・接続は上部の Edit で有効にできます。")}</p>
            <p>{t("ボックスをダブルクリックすると中を開きます。100% は文字を読む倍率、Fit は配置を見渡す倍率です。")}</p>
            <p>{t("Shift＋ホイールで上下へ、Ctrl＋Shift＋ホイールで左右へ移動できます。")}</p>
            <p>{t("分岐点の丸は同じ出力のつながりです。丸のない交差は接続されていません。")}</p>
          </div>
        </details>
      </div>
      {vertical && <div className="canvas-tools__scroll-hint">{t("ホイールで上下へ · Ctrl＋ホイールで拡大縮小")}</div>}
    </Panel>
  </>;
}

/**
 * 見せ方の切り替え: 図を横に流す / 図を縦に流す / 担当の一覧 (表、In charge)
 * 図の左下の操作欄と、表を出しているときの左下の両方に、同じ場所・同じ形で置く (表から図へも同じ場所で戻れる)
 * Input : なし (状態は store から読む) / Output: 3 つのボタンの組
 *   - 横・縦: 表を出していれば閉じて図に戻る。方向の切り替えは View のときだけ (Edit は保存した配置で編集するため)
 *   - 表: 出していなければ、自分 (Set as me) が決まっていれば自分、決まっていなければ全員で開く。出していれば閉じる
 */
export function ViewSwitch() {
  useLang(); // 言語が変わったら描き直す
  const canEdit = useProjectStore((s) => !s.readonly && s.editMode);
  const flowDirection = useProjectStore((s) => s.flowDirection);
  const setFlowDirection = useProjectStore((s) => s.setFlowDirection);
  const taskTable = useProjectStore((s) => s.taskTable);
  const setTaskTable = useProjectStore((s) => s.setTaskTable);
  const vertical = !canEdit && flowDirection === "vertical";
  const table = taskTable !== null;
  // 図の向きを選ぶ: 表を出していれば図に戻す。Edit では向きは変えない (表を出していないときは押せない)
  const direction = (d: "horizontal" | "vertical") => {
    if (table) setTaskTable(null);
    if (!canEdit) setFlowDirection(d);
  };
  // 表を開く / 閉じる
  const toggleTable = () => {
    if (table) { setTaskTable(null); return; }
    const { meId, project } = useProjectStore.getState();
    // 自分が決まっていて、まだ計画にいるなら自分。そうでなければ全員 (メンバーの登録が無い計画でも、すべてのタスクの一覧になる)
    setTaskTable(meId && project?.members.some((m) => m.id === meId) ? { memberId: meId } : { everyone: true });
  };
  const directionTitle = (label: string) => (canEdit && !table ? t("フローの方向はViewで切り替えます") : label);
  return (
    <span className="flow-direction" role="group" aria-label={t("表示の切り替え")}>
      <button disabled={canEdit && !table} aria-pressed={!table && !vertical} aria-label={t("横フロー")} title={directionTitle(t("横フロー"))} onClick={() => direction("horizontal")}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="2" y="8" width="5" height="8" rx="1"/><path d="M9 12h6m-2-3 3 3-3 3"/><rect x="18" y="8" width="4" height="8" rx="1"/></svg>
      </button>
      <button disabled={canEdit && !table} aria-pressed={!table && vertical} aria-label={t("縦フロー")} title={directionTitle(t("縦フロー"))} onClick={() => direction("vertical")}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="8" y="2" width="8" height="5" rx="1"/><path d="M12 9v6m-3-2 3 3 3-3"/><rect x="8" y="18" width="8" height="4" rx="1"/></svg>
      </button>
      {/* 担当の一覧 (表): 記号だけにして、説明はツールチップに出す */}
      <button className="view-switch__table" aria-pressed={table} aria-label="In charge" title={t("In charge: 担当のボックスを表で見る")} onClick={toggleTable}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M9 9v11"/></svg>
      </button>
    </span>
  );
}


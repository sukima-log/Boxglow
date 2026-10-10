import { ClaimMark, useClaimClock, visibleClaim } from "../panels/Claims";
import { chosenOption, isSkipped, waitingBranches } from "../model/branch";
/**
 * ブロック (ボックス) のノード
 * 分類・題名・状態・入力・出力を縦に読むカード。親は子を包む領域として描く。
 */
import { Handle, Position, useStore, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ancestorsOf, childrenOf, computeProgress, daysToDue, effectiveProgress, isInputReady, isSourceReady, isOverdue, issueKeyOf, portsOf, waitingFor } from "../model/graph";
import type { BlockStatus } from "../model/types";
import { useProjectStore, useShownProject } from "../store/useProjectStore";
import { handleId, isExpanded, type BlockRFNode } from "./layout";
import { actorName, ACTIVITY_LABEL } from "../model/report";
import { categoryOf } from "../model/categories";
import { taskCardLayout, taskCardPorts } from "../model/size";
import { readingColumns } from "../model/readingLayout";
import { CategoryIcon } from "./CategoryIcon";
import { STATUS_LABEL } from "../model/status";
import { t, useLang } from "../i18n";

/** 状態の印 */
export const STATUS_GLYPH: Record<BlockStatus, string> = { black: "?", gray: "~", white: "✓" };

/**
 * 状態のアイコン (GitHub / Linear などと同じ約束): ○ = New (空)、◐ = In Progress (半分)、● に ✓ = Done
 * 色だけに頼らず形でも分かるようにする (ライト / ダーク両方で同じ形)
 * Input : status
 * Output: 18px の SVG
 */
export function StatusIcon({ status }: { status: BlockStatus }) {
  const label = STATUS_LABEL[status];
  if (status === "white") {
    return (
      <svg className="status-icon done" width="18" height="18" viewBox="0 0 18 18" aria-label={label}>
        <circle cx="9" cy="9" r="8" />
        <path d="M5 9.5l2.6 2.6L13 6.8" fill="none" stroke="var(--on-primary)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === "gray") {
    return (
      <svg className="status-icon progress" width="18" height="18" viewBox="0 0 18 18" aria-label={label}>
        <circle cx="9" cy="9" r="7" fill="none" strokeWidth="2" />
        <path d="M9 2a7 7 0 0 0 0 14z" />
      </svg>
    );
  }
  return (
    <svg className="status-icon new" width="18" height="18" viewBox="0 0 18 18" aria-label={label}>
      <circle cx="9" cy="9" r="7" fill="none" strokeWidth="2" strokeDasharray="3 2.5" />
    </svg>
  );
}

export const BlockNode = memo(function BlockNode({ data, selected, width, height }: NodeProps<BlockRFNode>) {
  useLang(); // 言語が変わったら文言を描き直す
  const { blockId } = data;
  const vertical = data.vertical;
  const headerH = data.headerH ?? 44;
  const viewScope = useProjectStore((s) => s.viewScope);
  const overviewZoom = useStore((s) => s.transform[2] < 0.65);
  const canEdit = useProjectStore((s) => !s.readonly && s.editMode);
  // ストアからはプロジェクト本体だけを取り (参照が変わるのは変更時だけ)、表示用の値は useMemo で導く。
  // セレクタで毎回新しい配列を作ると React が無限ループ (エラー #185) になるため。
  const project = useShownProject()!;
  const claimNow=useClaimClock();
  const claimed=visibleClaim(project,blockId,claimNow);
  const view = useMemo(() => {
    const p = project;
    const b = p.blocks[blockId];
    const ins = isExpanded(p, blockId) ? portsOf(p, blockId, "in") : taskCardPorts(p, blockId, "in");
    const outs = isExpanded(p, blockId) ? portsOf(p, blockId, "out") : taskCardPorts(p, blockId, "out");
    const kids = childrenOf(p, blockId).length;
    const prog = computeProgress(p, blockId);
    return {
      title: b?.title ?? ""
    , status: b?.status ?? "black"
    , collapsed: b?.collapsed ?? false
    , expanded: isExpanded(p, blockId)
    , kids
    , progressRatio: prog.ratio
    , progressText: `${prog.white}/${prog.total}`
    , ins: ins.map((q) => ({ id: q.id, name: q.name, required: q.required, promoted: !!q.promotedFrom, ready: isInputReady(p, q.id), anyOf: !!q.anyOf }))
      // 出力: 分岐のボックスなら、その出力が選んだ道 (chosen) か、見送りの道 (rejected) か、まだ未定 (open) か
    , outs: outs.map((q) => {
        const chosen = b?.branch ? chosenOption(b) : undefined;
        const branchState = q.branchOption === undefined ? null : chosen === undefined ? "open" : q.branchOption === chosen ? "chosen" : "rejected";
        return { id: q.id, name: q.name, ready: isSourceReady(p, { portId: q.id, side: "outer" }), branchState };
      })
      // 分岐: このボックスが分岐か / 選ばなかった道の先 (見送り) か / まだ答えていない分岐の先 (分岐待ち) か
    , branch: !!b?.branch
      // 合流のボックス (OR ゲート風の部品)。どれかの入力が届いたか (届いたら先へ通す)
    , merge: !!b?.merge
    , mergeReady: !!b?.merge && outs.length > 0 && isSourceReady(p, { portId: outs[0].id, side: "outer" })
    , skipped: isSkipped(p, blockId)
    , waitingBranch: waitingBranches(p, blockId).length > 0
    , pending: b?.decisions.filter((d) => d.answer === undefined).length ?? 0
    , activity: b?.activity ?? null
    , percent: effectiveProgress(p, blockId)
    , isProject: b?.kind === "project"
    , fromTemplate: b?.template?.name ?? null
    , category: categoryOf(b?.category) ?? null // 詳細の札 (未分類なら null)
    , startable: !!b && b.status === "black" && b.kind !== "project" && ins.length > 0 && waitingFor(p, blockId).length === 0 && !isSkipped(p, blockId) // 必須の入力がそろい、分岐待ちでも見送りでもない New
    , issue: b?.issue ? { url: b.issue, key: issueKeyOf(b.issue) } : null // 外部の課題 (JIRA / Redmine など)
    , depth: Math.min(4, Math.max(1, ancestorsOf(p, blockId).length)) // 階層の深さ (プロジェクトのボックス = 1)。枠線の太さと地色に使う
    , key: b?.key ?? ""
    , dueDate: b?.dueDate ?? null
    , overdue: b ? isOverdue(b) : false
    , daysLeft: b ? daysToDue(b) : null
    };
  }, [project, blockId]);

  const card = useMemo(() => taskCardLayout(project, blockId), [project, blockId]);
  const rowAt = (i: number, direction: "in" | "out") => view.expanded
    ? headerH + i * 26 + 13
    : (direction === "in" ? card.inputs : card.outputs)[i].center;
  const updateNodeInternals = useUpdateNodeInternals();
  const portLayout = `${JSON.stringify(vertical)}|${width}|${height}|${headerH}|${view.expanded}|${card.inputs.map(q => `${q.id}:${q.center}`)}|${card.outputs.map(q => `${q.id}:${q.center}`)}`;
  const previousPortLayout = useRef(portLayout);
  useEffect(() => {
    if (previousPortLayout.current !== portLayout) {
      previousPortLayout.current = portLayout;
      updateNodeInternals(blockId);
    }
  }, [blockId, portLayout, updateNodeInternals]);

  // white になった瞬間だけ光るアニメーションを付ける
  const prevStatus = useRef(view.status);
  const [glow, setGlow] = useState(false);
  useEffect(() => {
    if (prevStatus.current !== "white" && view.status === "white") {
      setGlow(true);
      const timer = setTimeout(() => setGlow(false), 1300);
      return () => clearTimeout(timer);
    }
    prevStatus.current = view.status;
  }, [view.status]);

  const toggleCollapsed = useProjectStore((s) => s.toggleCollapsed);
  // ▸ で中を見る (そのボックスを開く) (ファイルに差分を出さない)
  const toggle = (ev: React.MouseEvent) => {
    ev.stopPropagation();
    toggleCollapsed(blockId);
  };
  // ダブルクリック: 大項目なら Top からそのタブを開く、中のボックスなら畳む / 展開。1 回のクリックは選ぶだけ。
  // ボックスの側で受ける (React Flow のノードのダブルクリックは View のとき届かない)
  const onDoubleClick = (ev: React.MouseEvent) => {
    ev.stopPropagation();
    if (view.kids > 0 || data.major) toggleCollapsed(blockId); // 大項目はタブがあるので、中が空でも開ける
  };

  const cls = [
    "bg-block"
  , vertical ? "vertical-card" : ""
  , `status-${view.status}`
  , `depth-${view.depth}`
  , view.expanded ? "expanded" : ""
  , selected ? "selected" : ""
  , overviewZoom && !canEdit ? "is-overview" : ""
  , (view.expanded ? headerH > 60 : headerH > 88 + card.metaH) ? "has-wrapped-title" : ""
  , data.dimmed ? "dimmed" : ""
  , glow ? "just-glowed" : ""
  , view.activity ? `activity-${view.activity.state}` : ""
  , view.isProject ? "kind-project" : ""
  , data.mine ? "mine" : ""
  , data.dropTarget ? "drop-target" : ""
  , view.category ? "has-cat" : ""
  , view.branch ? "kind-branch" : ""
  , view.merge ? "kind-merge" : ""
  , view.skipped ? "is-skipped" : ""
  , view.waitingBranch && !view.skipped ? "branch-waiting" : ""
  ].filter(Boolean).join(" ");

  // ボックスの onClick: 丸 (ハンドル) を押したクリックはボックスの選択に伝えない。
  // 丸を押すだけで詳細パネルが開くと図の幅が変わり、クリックでの結線 (出力の丸 → 入力の丸) の途中で接続先がずれるため
  const verticalBand = (direction: "in" | "out") => {
    if (!vertical) return null;
    const ports = direction === "in" ? view.ins : view.outs;
    if (!ports.length) return null;
    return <div className={`vertical-ports ${direction}`} style={{height: direction === "in" ? vertical.inputH : vertical.outputH, left: direction === "in" && view.expanded ? vertical.inputStart : 0}}>
      {ports.map(q => <div key={q.id} className={`vertical-port ${q.ready ? "ready" : "waiting"}`} data-port-id={q.id} title={q.name}>
        <span className="vertical-port__direction">{t(direction === "in" ? "入力" : "出力")}{!q.ready && (direction === "out" || !("required" in q) || !!q.required) && <span className="vertical-port__waiting">{t("待ち")}</span>}</span>
        <span className="vertical-port__name">{q.name}</span>
      </div>)}
    </div>;
  };
  return (
    <div className={cls} style={{ width, height, ...(view.category ? ({ "--cat": view.category.color } as React.CSSProperties) : {}) }} onDoubleClick={onDoubleClick} onClick={(ev) => { if ((ev.target as HTMLElement).closest(".react-flow__handle")) ev.stopPropagation(); }}>
      {/* 題名の行: カテゴリ、題名、プロジェクトの札、畳むボタン。
          カテゴリを選択時だけの補助行から外し、未選択・俯瞰でも仕事の種類を読める位置に固定する。 */}
      {/* 合流のボックス: カードではなく OR ゲート風の形 (左がえぐれ、右が尖る)。縦表示では 90 度回して上から下へ流す */}
      {view.merge ? (
        <div className={`bg-merge ${vertical ? "vertical" : ""} ${view.mergeReady ? "ready" : ""}`} title={t("合流: どれか 1 つの道が届けば、先へ進みます")}>
          <svg viewBox="0 0 136 80" preserveAspectRatio="none" aria-hidden="true">
            <path d="M6 4 H70 C104 4 124 24 132 40 C124 56 104 76 70 76 H6 C20 58 20 22 6 4 Z" />
          </svg>
          <span className="bg-merge__label"><b>OR</b></span>
        </div>
      ) : <>
      {/* 分岐のボックス: 角を斜めに落とした八角形の外形の線と、上の辺にまたがる「IF」のひし形の紋章 (フローチャートの判断の記号) */}
      {view.branch && !view.expanded && (
        <>
          {(() => {
            // 大きさ: 描画の直後は width / height が無いことがあるので、計算した寸法で補う
            const w = Number(width ?? card.width), h = Number(height ?? card.height);
            return <svg className="bg-branch-outline" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
              <path d={`M14 1 H${w - 14} L${w - 1} 14 V${h - 14} L${w - 14} ${h - 1} H14 L1 ${h - 14} V14 Z`} />
            </svg>;
          })()}
          <span className="bg-branch-emblem" aria-hidden="true"><span>IF</span></span>
        </>
      )}
      {verticalBand("in")}
      <div className="bg-block__head" style={{ height: headerH - (view.expanded ? 24 : card.metaH), ...(vertical && !view.expanded ? { marginTop: vertical.inputH } : {}) }}>
        {view.category && <span className={`bg-block__cat${view.category.neutral ? " neutral" : ""}`} data-category={view.category.key} title={t("カテゴリ: {label}", { label: t(view.category.label) })}>{!view.expanded && <CategoryIcon category={view.category.key} />}{t(view.category.label)}</span>}
        {view.isProject && <span className="bg-block__tag">Project</span>}
        {/* 分岐のボックス: 「分岐」の札 (判断の答えで、どの出力の道へ進むかが決まる) */}
        {view.branch && <span className="bg-block__tag branch" title={t("分岐: 判断の答えで、進む道 (出力) が決まります")}>{t("分岐")}</span>}
        <span className="bg-block__title" title={view.fromTemplate ? t("{title} (部品: {name})", { title: view.title, name: view.fromTemplate }) : view.title}>{view.title}</span>
        {(view.kids > 0 || data.major) && viewScope !== blockId && (
          <button className="bg-block__toggle nodrag" onClick={toggle} onDoubleClick={ev => ev.stopPropagation()} title={data.major ? t("この大項目のタブを開く (中のボックス {n} 個)", { n: view.kids }) : view.collapsed ? t("下の階層を展開する") : t("下の階層を畳む")}>
            {data.major || view.collapsed ? "▸" : "▾"}
          </button>
        )}
      </div>
      {!vertical && view.expanded && readingColumns(project, blockId).map(column => (
        <div key={`${column.x}:${column.y}`} className="bg-stage" style={{ left: column.x, top: column.y, width: column.width }}>{t("工程 {n}", { n: column.index + 1 })}</div>
      ))}
      {/* 情報の行: 状態は記号と文字。細かな情報は選択時に表示 */}
      <div className="bg-block__meta" style={{ height: view.expanded ? 24 : card.metaH }}>
        {!view.isProject && <StatusIcon status={view.status} />}
        {!view.isProject && (
          <span className={`meta-chip status-${view.status}`} title={t("状態")}>{STATUS_LABEL[view.status]}</span>
        )}
        {/* 担当はボックスには出さない (押して右パネルの担当 で見る)。自分の担当だけ左の帯で分かる */}
        {view.status !== "white" && view.percent > 0 && (
          <span className="meta-chip bg-block__secondary" title={view.kids > 0 ? t("下の階層の完了 {done}", { done: view.progressText }) : t("進捗")}>{view.percent}%</span>
        )}
        {!claimed && view.activity && !(view.pending > 0 && view.activity.state === "needs_decision") && (
          <span className={`meta-chip activity ${view.activity.state}`} title={`${view.activity.actor}: ${t(ACTIVITY_LABEL[view.activity.state])} ${view.activity.note}`}>
            {t(ACTIVITY_LABEL[view.activity.state])}<span className="bg-block__actor-name"> ({actorName(view.activity.actor)})</span>
          </span>
        )}
        <ClaimMark project={project} blockId={blockId} />
        {view.pending > 0 && <span className="meta-chip needs_decision">{t("判断待ち {n}", { n: view.pending })}</span>}
        {/* 見送り: 選ばなかった分岐の道 (進捗・次の候補・担当の一覧から外れる) / 分岐待ち: まだ答えていない分岐の先 */}
        {view.skipped && <span className="meta-chip skipped" title={t("選ばなかった分岐の道です。進捗や次の候補には数えません")}>{t("見送り")}</span>}
        {view.waitingBranch && !view.skipped && <span className="meta-chip branch-waiting" title={t("まだ答えていない分岐の先です。答えると、この道へ進むかが決まります")}>{t("分岐待ち")}</span>}
        {view.dueDate && view.status !== "white" && (
          <span className={`meta-chip ${view.overdue ? "overdue" : "bg-block__secondary"}`} title={view.daysLeft === null ? t("期日 {date}", { date: view.dueDate }) : view.daysLeft < 0 ? t("期日 {date} ({d} 日超過)", { date: view.dueDate, d: -view.daysLeft }) : t("期日 {date} (あと {d} 日)", { date: view.dueDate, d: view.daysLeft })}>
            {t("期日 {date}", { date: view.dueDate.slice(5).replace("-", "/") })}
          </span>
        )}
        {view.startable && !view.activity && !claimed && <span className="meta-chip ready" title={t("必須の入力がそろっています (着手できます)")}>Ready</span>}
        {view.issue && <a className="meta-chip issue nodrag" href={view.issue.url} target="_blank" rel="noreferrer" title={t("外部の課題: {url}", { url: view.issue.url })} onClick={(e) => e.stopPropagation()}>{view.issue.key}</a>}
        {view.fromTemplate && <span className="meta-chip muted" title={t("部品: {name}", { name: view.fromTemplate })}>{t("部品")}</span>}
        <span className="bg-block__key bg-block__secondary" title={t("ID (検索や CLI で使えます)")}>{view.key}</span>
      </div>

      {verticalBand("out")}
      {!vertical && !view.expanded && (
        <div className="bg-block__ports" style={{ top: headerH }}>
          {view.ins.map((q, i) => (
            <div key={q.id} data-port-id={q.id} style={{ height: card.inputs[i].height }} className={`bg-block__port in ${q.required ? "" : "optional"} ${q.promoted ? "promoted" : ""} ${q.ready ? "ready" : ""}`} title={t("入力: {name}", { name: q.name })}>
              <span className="bg-block__direction">{t("入力")}</span>
              <span className="bg-block__port-name">{q.name}</span>
              {q.anyOf ? <span className="opt merge" title={t("合流: どれか 1 つが届けばよい入力")}>{t("合流")}</span> : !q.required ? <span className="opt">{t("(任意)")}</span> : !q.ready && <span className="bg-block__waiting">{t("待ち")}</span>}
            </div>
          ))}
          {view.outs.map((q, i) => (
            <div key={q.id} data-port-id={q.id} style={{ height: card.outputs[i].height }} className={`bg-block__port out ${q.ready ? "ready" : ""} ${q.branchState ? `branch-${q.branchState}` : ""}`} title={q.name}>
              {/* 分岐の出力: 選んだ道は ✓、見送りの道は取り消し線 (文字でも分かるよう、見送りには「見送り」と添える) */}
              <span className="bg-block__direction">{q.branchState ? t("道") : t("出力")}</span>
              <span className="bg-block__port-name">{q.branchState === "chosen" ? "✓ " : ""}{q.name}</span>
              {q.branchState === "rejected" && <span className="opt">{t("見送り")}</span>}
            </div>
          ))}
        </div>
      )}

      {view.status !== "white" && (view.kids > 0 || view.percent > 0) && (
        <div className="bg-block__progress" title={view.kids > 0 ? t("下の階層の完了 {done} ({percent}%)", { done: view.progressText, percent: view.percent }) : t("進捗 {percent}%", { percent: view.percent })}>
          <span style={{ width: `${view.percent}%` }} />
        </div>
      )}
      </>}

      {/* ハンドル: 入力は左、出力は右。展開中は内側用のハンドルも出す。
          結線できるのは Edit モードだけ (isConnectable = canEdit。View では丸を押しても線は変わらない)。
          onMouseDown の preventDefault は、丸を押したときに文字の選択やフォーカスの移動が起きないようにするため */}
      {!vertical && <>
      {view.ins.map((q, i) => (
        <Handle
          key={`${q.id}-outer`}
          type="target"
          position={Position.Left}
          id={handleId("in", q.id, "outer")}
          title={t("入力: {name}", { name: q.name })}
          className={`${q.promoted ? "port-promoted" : ""} ${q.ready ? "port-ready" : "port-waiting"}`}
          style={{ top: rowAt(i, "in") }}
          isConnectable={canEdit}
          onMouseDown={(ev) => ev.preventDefault()}
        />
      ))}
      {/* 内側のハンドル (展開中だけ): 親の入力を中へ流すので、向きは右 (線は右へ出る)。位置はボックスの内側 */}
      {view.expanded && view.ins.map((q, i) => (
        <Handle
          key={`${q.id}-inner`}
          type="source"
          position={Position.Right}
          id={handleId("in", q.id, "inner")}
          className="port-inner"
          title={t("{name} を中のブロックへ (ここから中のボックスの入力へドラッグ)", { name: q.name })}
          style={{ top: rowAt(i, "in"), zIndex: 2, left: -7, right: "auto", transform: "translate(-50%, -50%)" }}
          isConnectable={canEdit}
          onMouseDown={(ev) => ev.preventDefault()}
        />
      ))}
      {view.outs.map((q, i) => (
        <Handle
          key={`${q.id}-outer`}
          type="source"
          position={Position.Right}
          id={handleId("out", q.id, "outer")}
          title={t("出力: {name} (クリックまたはドラッグで接続)", { name: q.name })}
          className={`port-out ${q.ready ? "port-ready" : "port-waiting"}`}
          style={{ top: rowAt(i, "out"), zIndex: 1 }}
          isConnectable={canEdit}
          onMouseDown={(ev) => ev.preventDefault()}
        />
      ))}
      {/* 内側のハンドル (出力): 中のブロックの出力を受けるので、向きは左 (線は左から入る)。位置はボックスの内側 */}
      {view.expanded && view.outs.map((q, i) => (
        <Handle
          key={`${q.id}-inner`}
          type="target"
          position={Position.Left}
          id={handleId("out", q.id, "inner")}
          className="port-inner"
          title={t("中のブロックの出力を {name} へ", { name: q.name })}
          style={{ top: rowAt(i, "out"), zIndex: 0, right: -7, left: "auto", transform: "translate(50%, -50%)" }}
          isConnectable={canEdit}
          onMouseDown={(ev) => ev.preventDefault()}
        />
      ))}
      </>}
      {vertical && (["in", "out"] as const).flatMap(direction => {
        const qs = direction === "in" ? view.ins : view.outs;
        const layout = direction === "in" ? vertical.inputs : vertical.outputs;
        return qs.flatMap(q => (["outer", ...(view.expanded ? ["inner"] as const : [])] as const).map(side => {
          const input = direction === "in", inner = side === "inner";
          return <Handle key={`${q.id}-${side}`} id={handleId(direction,q.id,side)}
            type={input !== inner ? "target" : "source"}
            position={input !== inner ? Position.Top : Position.Bottom}
            title={t(input ? "入力: {name}" : "出力: {name} (クリックまたはドラッグで接続)",{name:q.name})}
            className={`${inner ? "port-inner" : ""} ${q.ready ? "port-ready" : "port-waiting"}`}
            style={{left:layout.find(p=>p.id===q.id)?.x, top:input ? (inner ? vertical.inputH+8 : 0) : Number(height)-(inner ? vertical.outputH+8 : 0), bottom:"auto", right:"auto", transform:"translate(-50%, -50%)"}}
            isConnectable={false} />;
        }));
      })}
    </div>
  );
});

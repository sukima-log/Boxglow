/**
 * ブロック (箱) のノード
 * 状態は箱の見た目で表す: black = 濃い塗り + 破線 + ?, gray = 斜線 + 進捗バー, white = 明るい塗り + チェック (光る)
 */
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ancestorsOf, childrenOf, computeProgress, daysToDue, effectiveProgress, isInputReady, isOverdue, issueKeyOf, missingRequiredInputs, portsOf } from "../model/graph";
import type { BlockStatus } from "../model/types";
import { useProjectStore, useShownProject } from "../store/useProjectStore";
import { handleId, isExpanded, type BlockRFNode } from "./layout";
import { actorName, ACTIVITY_LABEL } from "../model/report";
import { categoryOf } from "../model/categories";
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
        <path d="M5 9.5l2.6 2.6L13 6.8" fill="none" stroke="#fbfbfb" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
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
  const headerH = data.headerH ?? 44;
  /** ポート i 行目のハンドルの縦位置 (見出しの高さに追従) */
  const rowAt = (i: number) => headerH + i * 26 + 13;
  const readonly = useProjectStore((s) => s.readonly);
  // ストアからはプロジェクト本体だけを取り (参照が変わるのは変更時だけ)、表示用の値は useMemo で導く。
  // セレクタで毎回新しい配列を作ると React が無限ループ (エラー #185) になるため。
  const project = useShownProject()!;
  const view = useMemo(() => {
    const p = project;
    const b = p.blocks[blockId];
    const ins = portsOf(p, blockId, "in");
    const outs = portsOf(p, blockId, "out");
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
    , ins: ins.map((q) => ({ id: q.id, name: q.name, required: q.required, promoted: !!q.promotedFrom, ready: isInputReady(p, q.id) }))
    , outs: outs.map((q) => ({ id: q.id, name: q.name }))
    , activity: b?.activity ?? null
    , percent: effectiveProgress(p, blockId)
    , isProject: b?.kind === "project"
    , fromTemplate: b?.template?.name ?? null
    , category: categoryOf(b?.category) ?? null // 色の帯と札 (未分類なら null)
    , startable: !!b && b.status === "black" && b.kind !== "project" && ins.length > 0 && missingRequiredInputs(p, blockId).length === 0 // 必須の入力がそろった New
    , issue: b?.issue ? { url: b.issue, key: issueKeyOf(b.issue) } : null // 外部の課題 (JIRA / Redmine など)
    , depth: Math.min(4, Math.max(1, ancestorsOf(p, blockId).length)) // 階層の深さ (プロジェクトの箱 = 1)。枠線の太さと地色に使う
    , key: b?.key ?? ""
    , dueDate: b?.dueDate ?? null
    , overdue: b ? isOverdue(b) : false
    , daysLeft: b ? daysToDue(b) : null
    };
  }, [project, blockId]);

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
  // ▸ で中を見る (その箱を開く) (ファイルに差分を出さない)
  const toggle = (ev: React.MouseEvent) => {
    ev.stopPropagation();
    toggleCollapsed(blockId);
  };
  // ダブルクリック: 大項目なら All からそのタブを開く、中の箱なら畳む / 展開。1 回のクリックは選ぶだけ。
  // 箱の側で受ける (React Flow のノードのダブルクリックは View のとき届かない)
  const onDoubleClick = (ev: React.MouseEvent) => {
    ev.stopPropagation();
    if (view.kids > 0 || data.major) toggleCollapsed(blockId); // 大項目はタブがあるので、中が空でも開ける
  };

  const cls = [
    "bg-block"
  , `status-${view.status}`
  , `depth-${view.depth}`
  , view.expanded ? "expanded" : ""
  , selected ? "selected" : ""
  , data.dimmed ? "dimmed" : ""
  , glow ? "just-glowed" : ""
  , view.activity ? `activity-${view.activity.state}` : ""
  , view.isProject ? "kind-project" : ""
  , data.mine ? "mine" : ""
  , data.dropTarget ? "drop-target" : ""
  , view.category ? "has-cat" : ""
  ].filter(Boolean).join(" ");

  return (
    <div className={cls} style={{ width, height, ...(view.category ? ({ "--cat": view.category.color } as React.CSSProperties) : {}) }} onDoubleClick={onDoubleClick}>
      {/* 題名の行: 題名だけ (カテゴリとプロジェクトの札、畳むボタン以外は置かない) */}
      <div className="bg-block__head" style={{ height: headerH - 24 }}>
        {view.category && <span className={`bg-block__cat${view.category.neutral ? " neutral" : ""}`} title={t("カテゴリ: {label}", { label: t(view.category.label) })}>{t(view.category.label)}</span>}
        {view.isProject && <span className="bg-block__tag">Project</span>}
        {!view.isProject && <StatusIcon status={view.status} />}
        <span className="bg-block__title" title={view.fromTemplate ? t("{title} (部品: {name})", { title: view.title, name: view.fromTemplate }) : view.title}>{view.title}</span>
        {(view.kids > 0 || data.major) && (
          <button className="bg-block__toggle nodrag" onClick={toggle} title={data.major ? t("この大項目のタブを開く (中の箱 {n} 個)", { n: view.kids }) : view.collapsed ? t("下の階層を展開する") : t("下の階層を畳む")}>
            {data.major || view.collapsed ? "▸" : "▾"}
          </button>
        )}
      </div>
      {/* 情報の行: 記号ではなく文字で (状態・担当・進捗・活動・期日・ID) */}
      <div className="bg-block__meta">
        {!view.isProject && (
          <span className={`meta-chip status-${view.status}`} title={t("状態")}>{STATUS_LABEL[view.status]}</span>
        )}
        {/* 担当は箱には出さない (押して右パネルの Owner で見る)。自分の担当だけ左の帯で分かる */}
        {view.status !== "white" && view.percent > 0 && (
          <span className="meta-chip" title={view.kids > 0 ? t("下の階層の完了 {done}", { done: view.progressText }) : t("進捗")}>{view.percent}%</span>
        )}
        {view.activity && (
          <span className={`meta-chip activity ${view.activity.state}`} title={`${view.activity.actor}: ${t(ACTIVITY_LABEL[view.activity.state])} ${view.activity.note}`}>
            {t(ACTIVITY_LABEL[view.activity.state])} ({actorName(view.activity.actor)})
          </span>
        )}
        {view.dueDate && view.status !== "white" && (
          <span className={`meta-chip ${view.overdue ? "overdue" : ""}`} title={view.daysLeft === null ? t("期日 {date}", { date: view.dueDate }) : view.daysLeft < 0 ? t("期日 {date} ({d} 日超過)", { date: view.dueDate, d: -view.daysLeft }) : t("期日 {date} (あと {d} 日)", { date: view.dueDate, d: view.daysLeft })}>
            {t("期日 {date}", { date: view.dueDate.slice(5).replace("-", "/") })}
          </span>
        )}
        {view.startable && <span className="meta-chip ready" title={t("必須の入力がそろっています (着手できます)")}>Ready</span>}
        {view.issue && <a className="meta-chip issue nodrag" href={view.issue.url} target="_blank" rel="noreferrer" title={t("外部の課題: {url}", { url: view.issue.url })} onClick={(e) => e.stopPropagation()}>{view.issue.key}</a>}
        {view.fromTemplate && <span className="meta-chip muted" title={t("部品: {name}", { name: view.fromTemplate })}>{t("部品")}</span>}
        <span className="bg-block__key" title={t("ID (検索や CLI で使えます)")}>{view.key}</span>
      </div>

      {!view.expanded && (
        <div className="bg-block__ports">
          <div>
            {view.ins.map((q) => (
              <div key={q.id} className={`bg-block__port in ${q.required ? "" : "optional"} ${q.promoted ? "promoted" : ""} ${q.ready ? "ready" : ""}`} title={q.ready ? t("{name} (用意できています)", { name: q.name }) : q.required ? q.name : t("{name} (任意: 無くても着手できます)", { name: q.name })}>{q.ready ? "● " : ""}{q.name}{!q.required && <span className="opt">{t("(任意)")}</span>}</div>
            ))}
          </div>
          <div>
            {view.outs.map((q) => (
              <div key={q.id} className="bg-block__port out" title={q.name}>{q.name}</div>
            ))}
          </div>
        </div>
      )}

      {view.status !== "white" && (view.kids > 0 || view.percent > 0) && (
        <div className="bg-block__progress" title={view.kids > 0 ? t("下の階層の完了 {done} ({percent}%)", { done: view.progressText, percent: view.percent }) : t("進捗 {percent}%", { percent: view.percent })}>
          <span style={{ width: `${view.percent}%` }} />
        </div>
      )}

      {/* ハンドル: 入力は左、出力は右。展開中は内側用のハンドルも出す */}
      {view.ins.map((q, i) => (
        <Handle
          key={`${q.id}-outer`}
          type="target"
          position={Position.Left}
          id={handleId("in", q.id, "outer")}
          className={q.promoted ? "port-promoted" : ""}
          style={{ top: rowAt(i) }}
          isConnectable={!readonly}
        />
      ))}
      {/* 内側のハンドル (展開中だけ): 親の入力を中へ流すので、向きは右 (線は右へ出る)。位置は箱の内側 */}
      {view.expanded && view.ins.map((q, i) => (
        <Handle
          key={`${q.id}-inner`}
          type="source"
          position={Position.Right}
          id={handleId("in", q.id, "inner")}
          className="port-inner"
          title={t("{name} を中のブロックへ (ここから中の箱の入力へドラッグ)", { name: q.name })}
          style={{ top: rowAt(i), zIndex: 2, left: -7, right: "auto", transform: "translate(-50%, -50%)" }}
          isConnectable={!readonly}
        />
      ))}
      {view.outs.map((q, i) => (
        <Handle
          key={`${q.id}-outer`}
          type="source"
          position={Position.Right}
          id={handleId("out", q.id, "outer")}
          className="port-out"
          style={{ top: rowAt(i), zIndex: 1 }}
          isConnectable={!readonly}
        />
      ))}
      {/* 内側のハンドル (出力): 中のブロックの出力を受けるので、向きは左 (線は左から入る)。位置は箱の内側 */}
      {view.expanded && view.outs.map((q, i) => (
        <Handle
          key={`${q.id}-inner`}
          type="target"
          position={Position.Left}
          id={handleId("out", q.id, "inner")}
          className="port-inner"
          title={t("中のブロックの出力を {name} へ", { name: q.name })}
          style={{ top: rowAt(i), zIndex: 0, right: -7, left: "auto", transform: "translate(50%, -50%)" }}
          isConnectable={!readonly}
        />
      ))}
    </div>
  );
});

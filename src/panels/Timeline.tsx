/**
 * タイムライン: 判断待ち・作業中・ログを時系列で見る (上の帯の要約チップから開く)
 */
import { useState } from "react";
import { answerDecision, summarize, candidatesOf, reopenDecision, ancestorsOf } from "../model/graph";
import { actorLabel, ACTIVITY_LABEL, agoText, shortTime } from "../model/report";
import { ROOT_ID, type Project } from "../model/types";
import { useProjectStore } from "../store/useProjectStore";

/** 判断に答える小さなカード (ブロックの詳細とタイムラインで共用) */
export function DecisionCard({ project, blockId, decisionId }: { project: Project; blockId: string; decisionId: string }) {
  const readonly = useProjectStore((s) => s.readonly);
  const apply = useProjectStore((s) => s.apply);
  const [text, setText] = useState("");
  const d = project.blocks[blockId]?.decisions.find((x) => x.id === decisionId);
  if (!d) return null;
  const answer = (value: string) => {
    if (!value.trim()) return;
    apply((p) => answerDecision(p, blockId, decisionId, value.trim(), "human"));
  };
  return (
    <div className="flex flex-col gap-2 pl-2" style={{ borderLeft: "3px solid var(--accent)" }}>
      <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>{actorLabel(d.askedBy)} からの質問 ({agoText(d.askedAt)})</div>
      <div className="text-[13px] font-bold">{d.question}</div>
      {d.answer !== undefined ? (
        <div className="flex flex-col gap-1 text-[13px]">
          <div>選んだ: <b>{d.answer}</b> <span style={{ color: "var(--text-muted)" }}>({d.answeredBy})</span></div>
          {/* 選ばなかった候補も残す (方針転換のときに戻れるように) */}
          {candidatesOf(d).rejected.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
              残した候補:
              {candidatesOf(d).rejected.map((o) => <span key={o} className="meta-chip muted" style={{ fontSize: 11 }}>{o}</span>)}
            </div>
          )}
          {(d.history ?? []).length > 0 && (
            <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>
              以前の答え: {d.history!.map((h) => `${h.answer} (${h.by}${h.note ? "、" + h.note : ""})`).join(" → ")}
            </div>
          )}
          {!readonly && (
            <div>
              <button className="btn btn-ghost btn-sm" onClick={() => { const note = prompt("やり直す理由 (任意)") ?? ""; apply((p) => reopenDecision(p, blockId, decisionId, "human", note)); }} title="方針転換: 答えを履歴に残して、候補から選び直す">やり直す</button>
            </div>
          )}
        </div>
      ) : readonly ? null : (
        <>
          {d.options.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {d.options.map((o) => <button key={o} className="btn btn-sm" onClick={() => answer(o)}>{o}</button>)}
            </div>
          )}
          <div className="flex gap-1">
            <input className="input" placeholder={d.options.length > 0 ? "または自由に書く" : "回答を書く"} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && answer(text)} />
            <button className="btn btn-primary btn-sm" disabled={!text.trim()} onClick={() => answer(text)}>Answer</button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 箱の見出し (一覧の中で「どの箱か」をすぐ分かるように): B 番号、階層のパス、題名、箱へ飛ぶボタン
 * Input : blockId, onJump = 押したときに箱を選んで画面を寄せる
 */
function BlockRef({ project, blockId, onJump }: { project: Project; blockId: string; onJump: (id: string) => void }) {
  const b = project.blocks[blockId];
  if (!b) return null;
  const path = ancestorsOf(project, blockId).filter((a) => a.id !== ROOT_ID).reverse().map((a) => a.title).join(" › ");
  return (
    <div className="dec-head" role="button" tabIndex={0} onClick={() => onJump(blockId)} onKeyDown={(e) => e.key === "Enter" && onJump(blockId)} title="この箱を画面で選ぶ">
      <span className="dec-key">{b.key}</span>
      <div className="min-w-0 flex-1">
        {path && <div className="text-[11px] truncate" style={{ color: "var(--text-muted)" }}>{path}</div>}
        <div className="text-[13px] font-bold truncate">{b.title}</div>
      </div>
      <span className="btn btn-sm flex-none">箱へ →</span>
    </div>
  );
}

export function Timeline({ project }: { project: Project }) {
  const select = useProjectStore((s) => s.select);
  const focusBlock = useProjectStore((s) => s.focusBlock);
  const s = summarize(project);
  const jump = (blockId: string) => {
    select({ blockId });
    focusBlock(blockId);
  };
  const log = [...project.log].reverse().slice(0, 100);
  return (
    <div className="flex flex-col gap-4 p-3">
      <div className="flex items-center gap-1 mb-0">
        <span className="label flex-1">Activity</span>
        <button className="btn btn-ghost btn-sm" onClick={() => select({})} title="閉じる (Esc)">×</button>
      </div>
      <div className="text-[13px]">Done {s.white} / {s.total} · 作業中 {s.working.length} · 判断待ち {s.decisions.length}{s.blocked.length > 0 ? ` · 詰まり ${s.blocked.length}` : ""}</div>

      {s.decisions.length > 0 && (
        <section className="flex flex-col gap-2">
          <span className="label">Decisions (あなたの回答で AI が進めます)</span>
          {s.decisions.map(({ block, decision }) => (
            <div key={decision.id} className="flex flex-col gap-1">
              {/* どの箱の判断かを見出しで示す: B 番号・階層のパス・題名・箱へ飛ぶボタン */}
              <BlockRef project={project} blockId={block.id} onJump={jump} />
              <DecisionCard project={project} blockId={block.id} decisionId={decision.id} />
            </div>
          ))}
        </section>
      )}

      {(s.working.length > 0 || s.blocked.length > 0) && (
        <section className="flex flex-col gap-1">
          <span className="label">Working</span>
          {[...s.working, ...s.blocked.map((b) => ({ ...b, since: project.blocks[b.block.id].activity?.since ?? "" }))].map((w) => (
            <button key={w.block.id} className="tree-row text-left" onClick={() => jump(w.block.id)}>
              <span className="tl-actor">{actorLabel(w.actor)}</span>
              <span className="dec-key">{w.block.key}</span>
              <span className="truncate"><b>{w.block.title}</b> {ACTIVITY_LABEL[project.blocks[w.block.id].activity!.state]} {w.note}</span>
              <span className="ml-auto text-[11px] flex-none" style={{ color: "var(--text-muted)" }}>{w.since ? agoText(w.since) : ""}</span>
            </button>
          ))}
        </section>
      )}

      {s.next.length > 0 && (
        <section className="flex flex-col gap-1">
          <span className="label">Next (未着手)</span>
          <div className="flex flex-wrap gap-1">
            {s.next.slice(0, 8).map((b) => <button key={b.id} className="chip" onClick={() => jump(b.id)}>{b.title}</button>)}
          </div>
        </section>
      )}

      <section>
        <span className="label">Log</span>
        {log.length === 0 && <div className="text-[12px] mt-1" style={{ color: "var(--text-muted)" }}>まだありません。CLI や画面の操作で記録されます。</div>}
        {log.map((e) => (
          <div key={e.id} className="tl-row" style={{ cursor: e.blockId ? "pointer" : "default" }} onClick={() => e.blockId && project.blocks[e.blockId] && jump(e.blockId)}>
            <span className="tl-time">{shortTime(e.at)}</span>
            <span className="tl-actor" title={e.actor}>{actorLabel(e.actor)}</span>
            <span>{e.message}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

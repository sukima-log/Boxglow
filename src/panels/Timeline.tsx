/**
 * タイムライン: 判断待ち・作業中・ログを時系列で見る (上の帯の要約チップから開く)
 * 「再開」タブは、作業を再開するときに読み直すもの (AI 未確認の回答・引き継ぎメモ・次の候補) を 1 か所にまとめる
 */
import { CloseButton } from "./CloseButton";
import { candidateGroups } from "../model/workflow";
import { lint } from "../model/lint";
import { resumeSummary } from "../model/resume";
import { useMemo, useState } from "react";
import { answerDecision, editDecisionAnswer, summarize, candidatesOf, reopenDecision, ancestorsOf, kindOf, portsOf, isAcked } from "../model/graph";
import { actorLabel, ACTIVITY_LABEL, agoText, shortTime } from "../model/report";
import { ROOT_ID, type Project } from "../model/types";
import { STATUS_LABEL } from "../model/status";
import { useProjectStore } from "../store/useProjectStore";
import { claimListOf } from "../model/claims";
import { useClaimClock } from "./Claims";
// 言語切り替え: 日本語の文は t() で包み、英語の辞書 (src/i18n/en/parts.ts) で引く
import { t, useLang } from "../i18n";

/** 判断に答える小さなカード (ブロックの詳細とタイムラインで共用) */
export function DecisionCard({ project, blockId, decisionId }: { project: Project; blockId: string; decisionId: string }) {
  useLang(); // 言語が変わったら描き直す
  const readonly = useProjectStore((s) => s.readonly);
  const apply = useProjectStore((s) => s.apply);
  const [text, setText] = useState("");
  // 答えたあとの編集 (null = 編集していない)
  const [editing, setEditing] = useState<string | null>(null);
  const d = project.blocks[blockId]?.decisions.find((x) => x.id === decisionId);
  if (!d) return null;
  const answer = (value: string) => {
    if (!value.trim()) return;
    apply((p) => answerDecision(p, blockId, decisionId, value.trim(), "human"));
    setText("");
  };
  const saveEdit = () => {
    if (editing === null || !editing.trim()) return;
    apply((p) => editDecisionAnswer(p, blockId, decisionId, editing, "human"));
    setEditing(null);
  };
  // Ctrl+Enter (Mac は Cmd+Enter) で送る。Enter だけ・Shift+Enter は改行 (書いている途中で送られないように)
  const submitKey = (ev: React.KeyboardEvent, go: () => void) => { if (!ev.nativeEvent.isComposing && ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); go(); } };
  return (
    <div className="flex flex-col gap-2 pl-2" style={{ borderLeft: "3px solid var(--accent)" }}>
      <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>{t("{actor} · {ago}", { actor: actorLabel(d.askedBy), ago: agoText(d.askedAt) })}</div>
      <div className="text-[13px] font-bold">{d.question}</div>
      {/* 判断材料: 質問だけで判断できるように、前提・比較・影響をここに出す */}
      {d.context && <div className="text-[12px] whitespace-pre-wrap" style={{ color: "var(--text-muted)", background: "var(--bg-paper)", border: "1px solid var(--line-soft)", borderRadius: 8, padding: "6px 8px" }}>{d.context}</div>}
      {d.answer !== undefined ? (
        <div className="flex flex-col gap-1 text-[13px]">
          {editing !== null ? (
            <div className="flex flex-col gap-1">
              <textarea className="input" rows={3} value={editing} onChange={(e) => setEditing(e.target.value)} onKeyDown={(e) => submitKey(e, saveEdit)} autoFocus />
              <div className="flex gap-1 justify-end">
                <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                <button className="btn btn-primary btn-sm" disabled={!editing.trim()} onClick={saveEdit} title={t("Ctrl+Enter でも保存")}>Save</button>
              </div>
            </div>
          ) : (
            <>
              <div className="whitespace-pre-wrap">{t("選んだ:")} <b>{d.answer}</b> <span style={{ color: "var(--text-muted)" }}>({d.answeredBy})</span></div>
              {/* AI が読んだかどうか: 読まれるまでは橙の札で「未確認」。読まれたら誰がいつ引き取ったか */}
              {isAcked(project, blockId, d)
                ? (d.ackedAt && <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>{t("✓ 既読: {by} · {ago}", { by: actorLabel(d.ackedBy ?? ""), ago: agoText(d.ackedAt) })}</div>)
                : <div className="text-[11px] font-bold" style={{ color: "var(--accent)" }} title={t("AI がまだ読んでいません。編集できます")}>{t("未読")}</div>}
            </>
          )}
          {/* 選ばなかった候補も残す (方針転換のときに戻れるように) */}
          {candidatesOf(d).rejected.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
              {t("候補:")}
              {candidatesOf(d).rejected.map((o) => <span key={o} className="meta-chip muted" style={{ fontSize: 11 }}>{o}</span>)}
            </div>
          )}
          {(d.history ?? []).length > 0 && (
            <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>
              {/* 答えの履歴: 「答え (誰、理由)」を → でつなぐ。読点は言語で変わるので理由付きの形も辞書で引く */}
              {t("履歴:")} {d.history!.map((h) => h.note ? t("{answer} ({by}、{note})", { answer: h.answer, by: h.by, note: h.note }) : `${h.answer} (${h.by})`).join(" → ")}
            </div>
          )}
          {!readonly && editing === null && (
            <div className="flex gap-1">
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(d.answer ?? "")} title={t("答えの文面を直す (書き間違いや補足。選び直しではない)")}>Edit</button>
              <button className="btn btn-ghost btn-sm" onClick={() => { const note = prompt(t("やり直す理由 (任意)")) ?? ""; apply((p) => reopenDecision(p, blockId, decisionId, "human", note)); }} title={t("方針転換: 答えを履歴に残して、候補から選び直す")}>{t("Reopen")}</button>
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
          <div className="flex flex-col gap-1">
            <textarea className="input" rows={3} placeholder={d.options.length > 0 ? t("または自由に書く (複数行可)") : t("回答を書く (複数行可)")} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => submitKey(e, () => answer(text))} />
            <div className="flex items-center gap-2 justify-end">
              <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>{t("Ctrl+Enter")}</span>
              <button className="btn btn-primary btn-sm" disabled={!text.trim()} onClick={() => answer(text)}>{t("回答")}</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * ボックスの見出し (一覧の中で「どのボックスか」をすぐ分かるように): B 番号、階層のパス、題名、ボックスへ飛ぶボタン
 * Input : blockId, onJump = 押したときにボックスを選んで画面を寄せる
 */
function BlockRef({ project, blockId, onJump }: { project: Project; blockId: string; onJump: (id: string) => void }) {
  useLang(); // 言語が変わったら描き直す
  const b = project.blocks[blockId];
  if (!b) return null;
  const path = ancestorsOf(project, blockId).filter((a) => a.id !== ROOT_ID).reverse().map((a) => a.title).join(" › ");
  return (
    <button className="dec-head w-full text-left" onClick={() => onJump(blockId)} title={t("このボックスを画面で選ぶ")}>
      <span className="dec-key">{b.key}</span>
      <div className="min-w-0 flex-1">
        {path && <div className="text-[11px] truncate" style={{ color: "var(--text-muted)" }}>{path}</div>}
        <div className="text-[13px] font-bold">{b.title}</div>
      </div>
      <span className="btn btn-sm flex-none">{t("ボックスへ →")}</span>
    </button>
  );
}

/** Activity のタブ (一度に 1 項目だけ見せる。混ざって見えると、どれが判断待ちでどれが作業中か分かりにくい) */
type ActivityTab = "resume" | "decisions" | "answered" | "working" | "claims" | "next" | "lint" | "log";

export function Timeline({ project }: { project: Project }) {
  useLang(); // 言語が変わったら描き直す
  const select = useProjectStore((s) => s.select);
  const focusBlock = useProjectStore((s) => s.focusBlock);
  const s = summarize(project);
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const resume = resumeSummary(project, { includeCompleted }); // 再開のまとめ (引き継ぎメモの一覧など。CLI の resume と同じモデル)
  const jump = (blockId: string) => {
    select({ blockId });
    focusBlock(blockId);
  };
  const log = [...project.log].reverse().slice(0, 100);
  const active = [...s.working, ...s.blocked.map((b) => ({ ...b, since: project.blocks[b.block.id].activity?.since ?? "" }))];
  // 受け持ちの一覧 (Claims タブ)。時刻は受け持ちの共通の時計 (15 秒ごと) で、期限切れを判定する
  const claimNow = useClaimClock();
  const claimRows = claimListOf(project, claimNow);
  // 検査 (lint) の結果 (計画全体)。計画が変わったときだけ計算し直す
  const lintIssues = useMemo(() => lint(project), [project]);
  // タブと件数。最初に開くのは「人の対応が要る順」で中身のある最初のタブ (判断待ち → 回答済み → 作業中 → 次の候補 → ログ)
  const tabs: { id: ActivityTab; label: string; count: number | null; help: string }[] = [
    { id: "resume", label: "Resume", count: resume.handoffs.length, help: t("引き継ぎ・未確認の回答・次の候補") },
    { id: "decisions", label: "Decisions", count: s.decisions.length, help: t("判断待ち: あなたの回答で AI が進めます") }
  , { id: "answered", label: "Answered", count: s.answered.length, help: t("回答済み: AI がまだ読んでいない回答 (読まれるまで残り、編集できます)") }
  , { id: "working", label: "Working", count: active.length, help: t("作業中・詰まり・確認待ちのボックス") }
  // 受け持ち: 受け持ちを使う計画で、解除されていない受け持ちがあるときだけタブを出す (使わない計画では見せない)
  , ...(claimRows.length > 0 ? [{ id: "claims" as const, label: "Claims", count: claimRows.filter((r) => r.active).length, help: t("受け持ち: どの AI (実行 ID) がどのボックスを持っているか") }] : [])
  , { id: "next", label: "Next", count: s.next.length, help: t("未着手のボックス: 着手できる / 入力待ち") }
  // 検査 (lint): 必ず直す / 着手の前に埋める / 見直し候補。数字は必ず直すの件数
  , { id: "lint", label: "Lint", count: lintIssues.filter((x) => x.severity === "error").length, help: t("検査: 必ず直す / 着手の前に埋める / 見直し候補 (押すとそのボックスへ)") }
  , { id: "log", label: "Log", count: null, help: t("最近の記録 (新しい順)") }
  ];
  // 並びは「再開」が先頭だが、最初に開く優先順は 判断待ち → 回答済み → 再開 → 作業中 → 次の候補 (人の対応が要るものを先に)
  const firstFilled = [...tabs.slice(1, 3), tabs[0], ...tabs.slice(3)].find((x) => (x.count ?? 0) > 0)?.id ?? "log";
  // 利用者が選んだタブ (null = まだ選んでいない → 中身のある最初のタブ)。選んだ後は、中身が空になっても勝手に移らない
  // (答えた直後にタブが切り替わると、今どこを見ていたか見失う。件数の変化で行き先が分かる)
  const [picked, setPicked] = useState<ActivityTab | null>(null);
  const tab = picked ?? firstFilled;
  const empty = (text: string) => <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>{text}</div>;
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-1 mb-0">
        <span className="label flex-1">Activity</span>
        <CloseButton onClick={() => select({})} />
      </div>
      <div className="text-[13px]">Done {s.white} / {s.total}</div>

      {/* タブ: 項目ごとに開く。件数を添えて、どこに何件あるかを切り替える前に分かるようにする */}
      <div className="seg" style={{ gridTemplateColumns: `repeat(${tabs.length > 6 ? 4 : 3}, minmax(0, 1fr))` }}>
        {tabs.map((x) => (
          <button key={x.id} className="seg__btn" data-on={tab === x.id} onClick={() => setPicked(x.id)} style={{ padding: "6px 2px", fontSize: 12 }} title={x.help}>
            {x.label}
            {x.count !== null && <span style={{ display: "block", fontSize: 10, opacity: x.count > 0 ? 1 : 0.5, color: x.count > 0 && (x.id === "decisions" || x.id === "answered") ? "var(--accent)" : undefined, fontWeight: x.count > 0 ? 700 : 400 }}>{x.count}</span>}
          </button>
        ))}
      </div>

      {/* 再開: 現況 → 次の候補 (各組5件まで) → 未完了の引き継ぎ。完了メモは明示的に展開する。見るだけでは回答を確認済みにしない (ack は AI が行う) */}
      {tab === "resume" && <section className="flex flex-col gap-2">
        {active.length > 0 && <><h3 className="label">{t("作業中・確認待ち")}</h3>{active.map(w => <div key={w.block.id}><BlockRef project={project} blockId={w.block.id} onJump={jump} /><p className="text-[12px]">{w.note}</p></div>)}</>}
        {s.decisions.length > 0 && <><h3 className="label">{t("判断待ち")}</h3>{s.decisions.map(({block, decision}) => <div key={decision.id}><BlockRef project={project} blockId={block.id} onJump={jump} /><DecisionCard project={project} blockId={block.id} decisionId={decision.id} /></div>)}</>}
        {s.answered.length > 0 && <><h3 className="label">{t("AI 未読")}</h3>{s.answered.map(({block, decision}) => <div key={decision.id}><BlockRef project={project} blockId={block.id} onJump={jump} /><DecisionCard project={project} blockId={block.id} decisionId={decision.id} /></div>)}</>}
        <NextCandidates project={project} limit={5} onJump={jump} />
        <h3 className="label">{t("引き継ぎ")}</h3>
        {resume.handoffs.length === 0 && !resume.completedHandoffCount && empty(t("なし"))}
        {resume.completedHandoffCount > 0 && <button className="btn btn-ghost btn-sm" aria-expanded={includeCompleted} onClick={() => setIncludeCompleted(!includeCompleted)}>{t("Done ({n})", { n: resume.completedHandoffCount })}</button>}
        {resume.handoffs.map(({ blockId, note, actor, freshnessText, status }) => <div key={blockId} className="resume-card">
          <BlockRef project={project} blockId={blockId} onJump={jump} />
          <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>{actorLabel(actor)} · {STATUS_LABEL[status]} · {freshnessText}</div>
          <p className="whitespace-pre-wrap">{note}</p>
        </div>)}
        {resume.descriptionReminders.length > 0 && <details className="text-[12px]"><summary>{t("見直し ({n})", { n: resume.descriptionReminders.length })}</summary>{resume.descriptionReminders.map(x => <BlockRef key={x.blockId} project={project} blockId={x.blockId} onJump={jump} />)}</details>}
      </section>}

      {tab === "decisions" && (
        <section className="flex flex-col gap-2">
          {s.decisions.length === 0 && empty(s.answered.length > 0 ? t("なし") : t("なし"))}
          {s.decisions.map(({ block, decision }) => (
            <div key={decision.id} className="flex flex-col gap-1">
              {/* どのボックスの判断かを見出しで示す: B 番号・階層のパス・題名・ボックスへ飛ぶボタン */}
              <BlockRef project={project} blockId={block.id} onJump={jump} />
              <DecisionCard project={project} blockId={block.id} decisionId={decision.id} />
            </div>
          ))}
        </section>
      )}

      {tab === "answered" && (
        <section className="flex flex-col gap-2">
          {/* 答えた直後に一覧から消えると「どのボックスの何に答えたか」を見失う。AI が引き取る (ack) までここに残し、編集もできる */}
          {s.answered.length === 0 && empty(t("なし"))}
          {s.answered.map(({ block, decision }) => (
            <div key={decision.id} className="flex flex-col gap-1">
              <BlockRef project={project} blockId={block.id} onJump={jump} />
              <DecisionCard project={project} blockId={block.id} decisionId={decision.id} />
            </div>
          ))}
        </section>
      )}

      {tab === "working" && (
        <section className="flex flex-col gap-1">
          {active.length === 0 && empty(t("なし"))}
          {active.map((w) => {
            // 「全体のどこで、何のために」: ボックスの位置 (大項目 › 中項目) と、この作業が出すもの (出力の名前)
            const where = ancestorsOf(project, w.block.id).filter((a) => a.id !== ROOT_ID && kindOf(a) !== "project").reverse().map((a) => a.title).join(" › ");
            const outs = portsOf(project, w.block.id, "out").map((q) => q.name).join(", ");
            return (
              <button key={w.block.id} className="tree-row text-left flex-wrap" onClick={() => jump(w.block.id)}>
                <span className="tl-actor">{actorLabel(w.actor)}</span>
                <span className="dec-key">{w.block.key}</span>
                <span className="meta-chip">{t(ACTIVITY_LABEL[project.blocks[w.block.id].activity!.state])}</span>
                <span className="ml-auto text-[11px] flex-none" style={{ color: "var(--text-muted)" }}>{w.since ? agoText(w.since) : ""}</span>
                {/* 題名とメモは省略しない (何の作業で、何を待っているのかが切れると意味が取れない) */}
                <span className="basis-full font-bold" style={{ whiteSpace: "normal" }}>{w.block.title}</span>
                {w.note && <span className="basis-full text-[12px]" style={{ whiteSpace: "normal" }}>{w.note}</span>}
                <span className="basis-full text-[11px]" style={{ color: "var(--text-muted)", whiteSpace: "normal" }}>{where ? `${where} › ` : ""}{outs ? t("出力: {outs}", { outs }) : ""}</span>
              </button>
            );
          })}
        </section>
      )}

      {tab === "claims" && (
        <section className="flex flex-col gap-1 claim-list">
          {claimRows.length === 0 && empty(t("なし"))}
          {claimRows.map((r) => (
            <button key={r.rootId} className="tree-row text-left flex-wrap" data-expired={!r.active} onClick={() => jump(r.rootId)}>
              {/* 誰が: AI の名前と実行 ID (同じ AI のサブエージェントを見分ける) */}
              <span className="tl-actor">{actorLabel(r.actor)}</span>
              {r.instanceId && <code className="text-[11px]">{r.instanceId}</code>}
              {/* 残り時間 (期限切れは、それとわかる言葉で) */}
              <span className="ml-auto text-[11px] flex-none" style={{ color: r.active ? "var(--text-muted)" : "var(--attention-text)" }}>
                {r.active ? t("残り {min} 分", { min: r.minutesLeft }) : t("期限切れ")}
              </span>
              {/* 何を: B 番号と題名 (配下を含む受け持ちは、そう書く) */}
              <span className="basis-full" style={{ whiteSpace: "normal" }}>
                <span className="dec-key">{r.key}</span> <span className="font-bold">{r.title}</span>
                {r.subtree && <span className="text-[11px]" style={{ color: "var(--text-muted)" }}> · {t("配下を含む")}</span>}
              </span>
              {r.note && <span className="basis-full text-[12px]" style={{ whiteSpace: "normal" }}>{r.note}</span>}
            </button>
          ))}
        </section>
      )}

      {tab === "next" && <NextCandidates project={project} limit={30} onJump={jump} />}

      {tab === "lint" && (
        <section className="flex flex-col gap-2 lint-list">
          {lintIssues.length === 0 && empty(t("なし"))}
          {/* 3 組に分けて出す: 必ず直す (構造の誤り・作業中の未記入) → 着手の前に埋める (まだ始めていないボックス) → 見直し候補 */}
          {(["error", "later", "review"] as const).map((sev) => {
            const rows = lintIssues.filter((x) => x.severity === sev);
            if (!rows.length) return null;
            return <div key={sev} data-severity={sev}>
              <h3 className="label">{sev === "error" ? t("必ず直す") : sev === "later" ? t("着手の前に") : t("見直し候補")} <span className="lint-list__count">{rows.length}</span></h3>
              {rows.map((x, i) => <button key={`${x.blockId}-${x.kind}-${i}`} className="tree-row text-left" style={{ alignItems: "flex-start" }} onClick={() => jump(x.blockId)}>
                <span className="dec-key">{x.ref}</span><span className="text-[12px]" style={{ whiteSpace: "normal" }}>{x.text}</span>
              </button>)}
            </div>;
          })}
        </section>
      )}

      {tab === "log" && (
        <section>
          {log.length === 0 && <div className="text-[12px] mt-1" style={{ color: "var(--text-muted)" }}>{t("なし")}</div>}
          {log.map((e) => (
            <div key={e.id} className="tl-row" style={{ cursor: e.blockId ? "pointer" : "default" }} onClick={() => e.blockId && project.blocks[e.blockId] && jump(e.blockId)}>
              <span className="tl-time">{shortTime(e.at)}</span>
              <span className="tl-actor" title={e.actor}>{actorLabel(e.actor)}</span>
              <span>{e.message}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}


/** Input: 計画、各組の最大件数、選択処理 / Output: 範囲別・準備状況別の候補。不足する入力も同じ一覧で読める。 */
function NextCandidates({ project, limit, onJump }: { project: Project; limit: number; onJump: (id: string) => void }) {
  const groups = candidateGroups(project, summarize(project).next);
  return <section className="flex flex-col gap-2 next-candidates">
    {project.focusBlockId && <p className="text-[12px]">{t("今回の範囲: {title}", { title: project.blocks[project.focusBlockId]?.title ?? "" })}</p>}
    {!groups.length && <p className="text-[12px]">{t("なし")}</p>}
    {groups.map(g => <div key={g.title}><h3 className="label">{g.title}</h3>
      {g.items.slice(0, limit).map(b => <button key={b.blockId} className="tree-row text-left flex-wrap" onClick={() => onJump(b.blockId)}>
        <span className="dec-key">{b.key}</span><span>{b.title}</span>
        {b.unprepared.length > 0 && <span className="basis-full text-[12px]" style={{ whiteSpace: "normal", color: "var(--text-muted)" }}>{b.unprepared.join(" / ")}</span>}
        {b.missingInputs.length > 0 && <span className="basis-full text-[12px]" style={{ whiteSpace: "normal", color: "var(--text-muted)" }}>{t("待ち: {names}", { names: b.missingInputs.join(", ") })}</span>}
      </button>)}
    </div>)}
  </section>;
}

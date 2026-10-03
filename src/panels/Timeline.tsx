/**
 * タイムライン: 判断待ち・作業中・ログを時系列で見る (上の帯の要約チップから開く)
 */
import { useState } from "react";
import { answerDecision, editDecisionAnswer, summarize, candidatesOf, reopenDecision, ancestorsOf, kindOf, portsOf, isAcked } from "../model/graph";
import { actorLabel, ACTIVITY_LABEL, agoText, shortTime } from "../model/report";
import { ROOT_ID, type Project } from "../model/types";
import { useProjectStore } from "../store/useProjectStore";
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
  const submitKey = (ev: React.KeyboardEvent, go: () => void) => { if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); go(); } };
  return (
    <div className="flex flex-col gap-2 pl-2" style={{ borderLeft: "3px solid var(--accent)" }}>
      <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>{t("{actor} からの質問 ({ago})", { actor: actorLabel(d.askedBy), ago: agoText(d.askedAt) })}</div>
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
                ? (d.ackedAt && <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>{t("AI 確認済み ({by}、{ago})", { by: actorLabel(d.ackedBy ?? ""), ago: agoText(d.ackedAt) })}</div>)
                : <div className="text-[11px] font-bold" style={{ color: "var(--accent)" }}>{t("AI 未確認 (まだ読まれていません。編集できます)")}</div>}
            </>
          )}
          {/* 選ばなかった候補も残す (方針転換のときに戻れるように) */}
          {candidatesOf(d).rejected.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
              {t("残した候補:")}
              {candidatesOf(d).rejected.map((o) => <span key={o} className="meta-chip muted" style={{ fontSize: 11 }}>{o}</span>)}
            </div>
          )}
          {(d.history ?? []).length > 0 && (
            <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>
              {/* 答えの履歴: 「答え (誰、理由)」を → でつなぐ。読点は言語で変わるので理由付きの形も辞書で引く */}
              {t("以前の答え:")} {d.history!.map((h) => h.note ? t("{answer} ({by}、{note})", { answer: h.answer, by: h.by, note: h.note }) : `${h.answer} (${h.by})`).join(" → ")}
            </div>
          )}
          {!readonly && editing === null && (
            <div className="flex gap-1">
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(d.answer ?? "")} title={t("答えの文面を直す (書き間違いや補足。選び直しではない)")}>Edit</button>
              <button className="btn btn-ghost btn-sm" onClick={() => { const note = prompt(t("やり直す理由 (任意)")) ?? ""; apply((p) => reopenDecision(p, blockId, decisionId, "human", note)); }} title={t("方針転換: 答えを履歴に残して、候補から選び直す")}>{t("やり直す")}</button>
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
              <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>{t("Enter は改行。送るのはボタンか Ctrl+Enter")}</span>
              <button className="btn btn-primary btn-sm" disabled={!text.trim()} onClick={() => answer(text)}>Answer</button>
            </div>
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
  useLang(); // 言語が変わったら描き直す
  const b = project.blocks[blockId];
  if (!b) return null;
  const path = ancestorsOf(project, blockId).filter((a) => a.id !== ROOT_ID).reverse().map((a) => a.title).join(" › ");
  return (
    <div className="dec-head" role="button" tabIndex={0} onClick={() => onJump(blockId)} onKeyDown={(e) => e.key === "Enter" && onJump(blockId)} title={t("この箱を画面で選ぶ")}>
      <span className="dec-key">{b.key}</span>
      <div className="min-w-0 flex-1">
        {path && <div className="text-[11px] truncate" style={{ color: "var(--text-muted)" }}>{path}</div>}
        <div className="text-[13px] font-bold truncate">{b.title}</div>
      </div>
      <span className="btn btn-sm flex-none">{t("箱へ →")}</span>
    </div>
  );
}

/** Activity のタブ (一度に 1 項目だけ見せる。混ざって見えると、どれが判断待ちでどれが作業中か分かりにくい) */
type ActivityTab = "decisions" | "answered" | "working" | "next" | "log";

export function Timeline({ project }: { project: Project }) {
  useLang(); // 言語が変わったら描き直す
  const select = useProjectStore((s) => s.select);
  const focusBlock = useProjectStore((s) => s.focusBlock);
  const s = summarize(project);
  const jump = (blockId: string) => {
    select({ blockId });
    focusBlock(blockId);
  };
  const log = [...project.log].reverse().slice(0, 100);
  const active = [...s.working, ...s.blocked.map((b) => ({ ...b, since: project.blocks[b.block.id].activity?.since ?? "" }))];
  // タブと件数。最初に開くのは「人の対応が要る順」で中身のある最初のタブ (判断待ち → 回答済み → 作業中 → 次の候補 → ログ)
  const tabs: { id: ActivityTab; label: string; count: number | null; help: string }[] = [
    { id: "decisions", label: "Decisions", count: s.decisions.length, help: t("判断待ち: あなたの回答で AI が進めます") }
  , { id: "answered", label: "Answered", count: s.answered.length, help: t("回答済み: AI がまだ読んでいない回答 (読まれるまで残り、編集できます)") }
  , { id: "working", label: "Working", count: active.length, help: t("作業中・詰まり・確認待ちの箱") }
  , { id: "next", label: "Next", count: s.next.length, help: t("未着手で、次に着手できる箱") }
  , { id: "log", label: "Log", count: null, help: t("最近の記録 (新しい順)") }
  ];
  const firstFilled = tabs.find((x) => (x.count ?? 0) > 0)?.id ?? "log";
  // 利用者が選んだタブ (null = まだ選んでいない → 中身のある最初のタブ)。選んだ後は、中身が空になっても勝手に移らない
  // (答えた直後にタブが切り替わると、今どこを見ていたか見失う。件数の変化で行き先が分かる)
  const [picked, setPicked] = useState<ActivityTab | null>(null);
  const tab = picked ?? firstFilled;
  const empty = (text: string) => <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>{text}</div>;
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-1 mb-0">
        <span className="label flex-1">Activity</span>
        <button className="btn btn-ghost btn-sm" onClick={() => select({})} title={t("閉じる (Esc)")}>×</button>
      </div>
      <div className="text-[13px]">Done {s.white} / {s.total}</div>

      {/* タブ: 項目ごとに開く。件数を添えて、どこに何件あるかを切り替える前に分かるようにする */}
      <div className="seg" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
        {tabs.map((x) => (
          <button key={x.id} className="seg__btn" data-on={tab === x.id} onClick={() => setPicked(x.id)} style={{ padding: "6px 2px", fontSize: 12 }} title={x.help}>
            {x.label}
            {x.count !== null && <span style={{ display: "block", fontSize: 10, opacity: x.count > 0 ? 1 : 0.5, color: x.count > 0 && (x.id === "decisions" || x.id === "answered") ? "var(--accent)" : undefined, fontWeight: x.count > 0 ? 700 : 400 }}>{x.count}</span>}
          </button>
        ))}
      </div>

      {tab === "decisions" && (
        <section className="flex flex-col gap-2">
          <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>{t("あなたの回答で AI が進めます")}</span>
          {s.decisions.length === 0 && empty(s.answered.length > 0 ? t("判断待ちはありません。答えたものは Answered にあります") : t("判断待ちはありません"))}
          {s.decisions.map(({ block, decision }) => (
            <div key={decision.id} className="flex flex-col gap-1">
              {/* どの箱の判断かを見出しで示す: B 番号・階層のパス・題名・箱へ飛ぶボタン */}
              <BlockRef project={project} blockId={block.id} onJump={jump} />
              <DecisionCard project={project} blockId={block.id} decisionId={decision.id} />
            </div>
          ))}
        </section>
      )}

      {tab === "answered" && (
        <section className="flex flex-col gap-2">
          {/* 答えた直後に一覧から消えると「どの箱の何に答えたか」を見失う。AI が引き取る (ack) までここに残し、編集もできる */}
          <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>{t("AI がまだ読んでいない回答。読まれるまでここに残ります")}</span>
          {s.answered.length === 0 && empty(t("AI が未確認の回答はありません"))}
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
          {active.length === 0 && empty(t("作業中の箱はありません"))}
          {active.map((w) => {
            // 「全体のどこで、何のために」: 箱の位置 (大項目 › 中項目) と、この作業が出すもの (出力の名前)
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

      {tab === "next" && (
        <section className="flex flex-col gap-1">
          <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>{t("未着手の箱 (着手できるものから)")}</span>
          {s.next.length === 0 && empty(t("未着手の箱はありません"))}
          {s.next.slice(0, 30).map((b) => (
            <button key={b.id} className="tree-row text-left" onClick={() => jump(b.id)}>
              <span className="dec-key">{b.key}</span>
              <span className="truncate">{b.title}</span>
            </button>
          ))}
        </section>
      )}

      {tab === "log" && (
        <section>
          {log.length === 0 && <div className="text-[12px] mt-1" style={{ color: "var(--text-muted)" }}>{t("まだありません。CLI や画面の操作で記録されます。")}</div>}
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

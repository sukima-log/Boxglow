import { ClaimSettings, ClaimDetails } from "./Claims";
/**
 * 詳細パネル: 選んでいるものに応じて中身を切り替える
 *   ブロック / 線 / 入力ノード / 最終成果物ノード / プロジェクト設定
 * 何も選んでいなければ何も出さない (App 側でパネルごと隠す)
 * 文言は日本語で書き t() で包む (英語は src/i18n/en/inspector.ts の辞書で引く)
 */
import { BranchDialog } from "./BranchDialog";
import { BranchPicker } from "./BranchPicker";
import { branchDecision, canConvertToBranch } from "../model/branch";
import { reasonText, unpreparedReasons } from "../model/readiness";
import { ReviewState } from "./ReviewState";
import { CloseButton } from "./CloseButton";
import { WorkScopePanel, WorkflowSettings } from "./WorkScope";
import { descriptionReminder, freshnessText } from "../model/workflow";
import { isAcked as decisionIsAcked } from "../model/graph";
import { useEffect, useState } from "react";
import { addInputGroup, addMember, ancestorsOf, canAddOutput, exportInputGroup, importInputGroup, inputGroupsOf, portsOf, removeInputGroup, rootInputsOf, updateInputGroup, canSuggestWhite, childrenOf, clearActivity, computeProgress, daysToDue, effectiveProgress, extractTemplate, isOverdue, issueKeyOf, kindOf, removeBlock, setCategory, setProgress, setSchedule, updateBlock, waitingFor } from "../model/graph";
import { saveTemplate } from "../lib/templates";
import { actorLabel, ACTIVITY_LABEL, agoText } from "../model/report";
import { DecisionCard, Timeline } from "./Timeline";
import { agentContext } from "../model/context";
import { blockToPrompt } from "../model/export";
import { ROOT_ID, type BlockStatus, type Project } from "../model/types";
import { useProjectStore } from "../store/useProjectStore";
import { copyText, downloadText, pickTextFile, safeFilename } from "../lib/download";
import { ArtifactsEditor, DateField, DebouncedText, PortsEditor } from "./parts";
import { GLYPH, MEMBER_COLORS } from "./Drawer";
import { CATEGORIES } from "../model/categories";
import { STATUS_HELP, STATUS_LABEL } from "../model/status";
import { t, useLang } from "../i18n";


/** パネルの見出し行 (題名 + 閉じる) */
function PanelHead({ title, children }: { title: string; children?: React.ReactNode }) {
  useLang(); // 言語が変わったら描き直す
  const select = useProjectStore((s) => s.select);
  return (
    <div className="flex items-center gap-1 mb-2">
      <span className="label truncate flex-1" title={title}>{title}</span>
      {children}
      <CloseButton onClick={() => select({})} />
    </div>
  );
}

export function Inspector({ project, onOpenDrawer }: { project: Project; onOpenDrawer: () => void }) {
  const selection = useProjectStore((s) => s.selection);
  if (selection.blockId && project.blocks[selection.blockId]) return <BlockInspector project={project} blockId={selection.blockId} onOpenDrawer={onOpenDrawer} />;
  if (selection.terminal) return <TerminalInspector project={project} which={selection.terminal} groupId={selection.terminalGroup} />;
  if (selection.project) return <ProjectInspector project={project} />;
  if (selection.timeline) return <Timeline project={project} />;
  return null;
}

/** プロジェクト設定 (上のプロジェクト名を押したとき) */
function ProjectInspector({ project }: { project: Project }) {
  useLang(); // 言語が変わったら描き直す
  const readonly = useProjectStore((s) => s.readonly);
  const apply = useProjectStore((s) => s.apply);
  const prog = computeProgress(project, ROOT_ID);
  return (
    <div className="flex flex-col gap-4 p-3">
      <PanelHead title="Project" />
      <WorkflowSettings project={project} />
      <ClaimSettings project={project} />
      <input className="input font-head text-[16px]" value={project.name} disabled={readonly}
        onChange={(e) => apply((p) => ({ ...structuredClone(p), name: e.target.value }))} />
      <DebouncedText multiline className="input" placeholder={t("ゴール (何を達成したいか)")} value={project.description} disabled={readonly}
        onCommit={(v) => apply((p) => ({ ...structuredClone(p), description: v }))} />
      <div>
        <div className="progress-bar"><span style={{ width: `${Math.round(prog.ratio * 100)}%` }} /></div>
        <div className="text-[12px] mt-1" style={{ color: "var(--text-muted)" }}>{t("完了 {white} / {total}", { white: prog.white, total: prog.total })}</div>
      </div>
    </div>
  );
}

/** 入力ノード (既定 / グループ) / 最終成果物ノード */
function TerminalInspector({ project, which, groupId }: { project: Project; which: "in" | "out"; groupId: string | null }) {
  useLang(); // 言語が変わったら描き直す
  const readonly = useProjectStore((s) => s.readonly);
  const apply = useProjectStore((s) => s.apply);
  const select = useProjectStore((s) => s.select);
  const setToast = useProjectStore((s) => s.setToast);
  const group = groupId ? inputGroupsOf(project).find((g) => g.id === groupId) ?? null : null;
  const groups = inputGroupsOf(project);
  const title = which === "out" ? "Project Outputs" : group ? `Input Group` : "Project Inputs";

  const addGroup = () => {
    const name = prompt(t("グループの名前 (例: PCIe 仕様書)"));
    if (!name?.trim()) return;
    apply((p) => { const r = addInputGroup(p, name.trim()); setTimeout(() => select({ terminal: "in", terminalGroup: r.groupId }), 0); return r.project; });
  };
  const importGroup = async () => {
    const text = await pickTextFile(".json,application/json");
    if (!text) return;
    try {
      apply((p) => { const r = importInputGroup(p, text); setTimeout(() => select({ terminal: "in", terminalGroup: r.groupId }), 0); return r.project; });
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      <PanelHead title={title} />
      {group && (
        <section className="sec">
          <div className="sec__head"><span className="label">Group</span>
            <span className="flex gap-1">
              <button className="btn btn-ghost btn-sm" title={t("このグループを JSON に書き出す (他のプロジェクトで読み込める)")} onClick={() => downloadText(`${safeFilename(group.name)}.boxglow-inputs.json`, exportInputGroup(project, group.id), "application/json")}>Export</button>
              {!readonly && <button className="btn btn-ghost btn-sm btn-danger" title={t("グループを消す (入力は Inputs に戻る)")} onClick={() => { if (confirm(t("グループ「{name}」を消しますか? (入力は Inputs に戻ります)", { name: group.name }))) { select({ terminal: "in" }); apply((p) => removeInputGroup(p, group.id)); } }}>Delete</button>}
            </span>
          </div>
          <input className="input font-head text-[15px]" value={group.name} disabled={readonly} placeholder="Group name" onChange={(e) => apply((p) => updateInputGroup(p, group.id, { name: e.target.value }))} />
          <input className="input" value={group.description} disabled={readonly} placeholder={t("説明 (任意。例: PCI-SIG の仕様書一式)")} onChange={(e) => apply((p) => updateInputGroup(p, group.id, { description: e.target.value }))} />
        </section>
      )}
      <PortsEditor project={project} blockId={ROOT_ID} direction={which} readonly={readonly} title={which === "in" ? "Inputs" : "Outputs"} allowAdd={which === "out" || !!group} groupId={which === "in" ? (group ? group.id : null) : undefined} />
      {which === "in" && !group && (
        <>
          <section className="sec">
            <div className="sec__head"><span className="label" title={t("ここには、下の階層で供給元が決まっていない入力が自動で上がります。各入力はグループに移せます。")}>Groups</span>
              {!readonly && <span className="flex gap-1"><button className="btn btn-ghost btn-sm" onClick={addGroup} title={t("仕様書などを種類ごとに分けるときは、グループを作って入力を入れます (例: PCIe 仕様書、DDR 仕様書)。")}>+ Group</button><button className="btn btn-ghost btn-sm" onClick={importGroup} title={t("他のプロジェクトで書き出したグループを読み込む")}>Import</button></span>}
            </div>
            {groups.map((g) => (
              <button key={g.id} className="tree-row text-left" onClick={() => select({ terminal: "in", terminalGroup: g.id })}>
                <span className="truncate">{g.name}</span>
                <span className="ml-auto text-[11px]" style={{ color: "var(--text-muted)" }}>{rootInputsOf(project, g.id).length}</span>
              </button>
            ))}
          </section>
        </>
      )}
    </div>
  );
}

/** ブロック */
function BlockInspector({ project, blockId }: { project: Project; blockId: string; onOpenDrawer: () => void }) {
  useLang(); // 言語が変わったら描き直す
  const readonly = useProjectStore((s) => s.readonly);
  const apply = useProjectStore((s) => s.apply);
  const select = useProjectStore((s) => s.select);
  const setToast = useProjectStore((s) => s.setToast);
  const meId = useProjectStore((s) => s.meId);
  const [aiOpen, setAiOpen] = useState(false);
  const [scopeEditing, setScopeEditing] = useState(false);
  const [showPrompt, setShowPrompt] = useState<"plan" | "decompose" | "review" | null>(null);
  const [more, setMore] = useState(true);
  const [menu, setMenu] = useState(false);
  // 分岐に変えるダイアログを開いているか
  const [branching, setBranching] = useState(false);
  const [ownerQuery, setOwnerQuery] = useState("");
  const [tab, setTab] = useState<"status" | "io" | "owner" | "dates" | "more">("status");
  const b = project.blocks[blockId];
  const ownerHits = ownerQuery.trim()
    ? project.members.filter((m) => m.name.toLowerCase().includes(ownerQuery.trim().toLowerCase()) && !b.assigneeIds.includes(m.id)).slice(0, 8)
    : [];
  const kids = childrenOf(project, blockId);
  const chain = [...ancestorsOf(project, blockId)].reverse();
  const suggest = canSuggestWhite(project, blockId);
  const prog = computeProgress(project, blockId);
  // まだ答えていない質問。分岐の問いは先頭の「道を選ぶ」欄で答えるので、ここ (状態タブの「回答が必要です」) には重ねて出さない
  const branchQ = branchDecision(b);
  const pending = b.decisions.filter((d) => d.answer === undefined && d !== branchQ);
  // 人が答えたが、AI がまだ引き取っていない (ack していない) 回答。引き取られるまでパネルの先頭に残す
  const unread =b.decisions.filter((d) => d.answer !== undefined && !decisionIsAcked(project, blockId, d));
  const percent = effectiveProgress(project, blockId);
  const isProject = kindOf(b) === "project";

  // 別のブロックを選んだら開いていたものを閉じる
  useEffect(() => {
    setAiOpen(false);
    setScopeEditing(false);
    setShowPrompt(null);
    setMore(true);
    setMenu(false);
    setOwnerQuery("");
    // タブは保つ (別のボックスを選んでも I/O などを続けて見比べられるように。Status には戻さない)
  }, [blockId]);

  const setStatus = (s: BlockStatus) => apply((p) => updateBlock(p, blockId, { status: s }));
  const toggleAssignee = (id: string) =>
    apply((p) => {
      const cur = p.blocks[blockId].assigneeIds;
      return updateBlock(p, blockId, { assigneeIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
    });
  const remove = () => {
    if (kids.length > 0 && !confirm(t("「{title}」と下の階層のブロックを削除します。よろしいですか?", { title: b.title }))) return;
    select({});
    apply((p) => removeBlock(p, blockId));
  };
  const copyPrompt = async (ask: "plan" | "decompose" | "review") => {
    setAiOpen(false);
    const text = blockToPrompt(project, blockId, ask);
    if (await copyText(text)) setToast(t("AI に渡すテキストをコピーしました"));
    else setShowPrompt(ask);
  };
  const saveAsTemplate = async () => {
    setMenu(false);
    const tags = prompt(t("部品の札 (例: 画像処理, 認証。カンマ区切り。省略可)")) ?? "";
    const tpl = extractTemplate(project, blockId, { tags: tags.split(/[,、]/).map((s) => s.trim()).filter(Boolean) });
    await saveTemplate(tpl);
    setToast(t("「{name}」を部品として保存しました (☰ の「部品」から挿入)", { name: tpl.name }));
  };

  // タブの説明 (title)。キーは内部の id なので包まず、文言だけ t() で引く
  const TAB_HELP: Record<typeof tab, string> = {
    status: t("状態・進捗・活動・判断")
  , io: t("入力と出力 (成果物)")
  , owner: t("担当")
  , dates: t("開始日・期日・時間")
  , more: t("AI に渡す・メモ・資料")
  };

  return (
    <div className="flex flex-col gap-4 p-3 inspector-body">
      <div className="flex items-center gap-1">
        <span className="label truncate flex-1" title={chain.map((a) => (a.id === ROOT_ID ? "" : a.title)).filter(Boolean).join(" › ")}>
          {isProject ? "Project" : chain.map((a) => (a.id === ROOT_ID ? "" : a.title)).filter(Boolean).join(" › ") || "Top"}
        </span>
        <button className="chip" style={{ fontFamily: "ui-monospace, monospace" }} title={t("短い ID (押すとコピー。検索や CLI で使えます)")} onClick={async () => { if (await copyText(b.key ?? "")) setToast(t("ID {key} をコピーしました", { key: b.key ?? "" })); }}>{b.key}</button>
        {!readonly && (
          <div className="relative">
            <button className="btn btn-ghost btn-sm" onClick={() => setMenu(!menu)} title={t("その他")}>⋯</button>
            {menu && (
              <div className="card absolute right-0 mt-1 p-1 flex flex-col z-30" style={{ minWidth: 200 }}>
                <button className="btn btn-ghost btn-sm justify-start" onClick={() => { setMenu(false); setScopeEditing(true); }}>{t("作業範囲を編集")}</button>
                <button className="btn btn-ghost btn-sm justify-start" onClick={() => { setMenu(false); apply(p => ({ ...p, focusBlockId: p.focusBlockId === blockId ? undefined : blockId })); }}>{project.focusBlockId === blockId ? t("今回の範囲を解除") : t("今回の範囲にする")}</button>
                {!isProject && <button className="btn btn-ghost btn-sm justify-start" onClick={saveAsTemplate}>Save as Part</button>}
                <button className="btn btn-ghost btn-sm justify-start" onClick={() => { setMenu(false); setShowPrompt("plan"); setTab("more"); }}>Show AI text</button>
                {/* 分岐にする: 作った後で「決まっていない分かれ道だった」と分かったとき。中に箱を持つものは変えられない (理由をツールチップに出す) */}
                {!isProject && !b.branch && (() => {
                  const can = canConvertToBranch(project, blockId);
                  return <button className="btn btn-ghost btn-sm justify-start" disabled={!can.ok} onClick={() => { setMenu(false); setBranching(true); }}
                    title={can.ok ? t("問いと選択肢を持つ分岐に変える (今の出力は 1 つ目の選択肢の道になる)") : t("中にボックスを持つボックスは、分岐にできません")}><span aria-hidden="true">◇</span> {t("分岐にする")}</button>;
                })()}
                <div style={{ borderTop: "1px solid var(--line-soft)", margin: "4px 0" }} />
                <button className="btn btn-ghost btn-sm justify-start btn-danger" onClick={remove}>Delete</button>
              </div>
            )}
          </div>
        )}
        <CloseButton onClick={() => select({})} />
      </div>

      {branching && <BranchDialog convertBlockId={blockId} onClose={() => setBranching(false)} />}
      <DebouncedText className="input font-head text-[16px]" value={b.title} disabled={readonly} placeholder={t("Title (何を作るか)")}
        onCommit={(v) => apply((p) => updateBlock(p, blockId, { title: v }))} />
      {/* 分岐のボックス: どの道に進むかを、題名の直下で選ぶ (タブを開かなくても見つかるように) */}
      <BranchPicker project={project} blockId={blockId} />

        {/* カテゴリは「状態」タブの中ではなく題名の直下に置く。どの詳細タブでも分類を確認・変更できるようにする。
            候補が多いので選択欄にまとめる。空の値はモデルの null (カテゴリなし) に戻し、閲覧専用では変更させない。札の訳は common.ts。 */}
        <label className="category-field"><span className="label">{t("カテゴリ")}</span>
          <select className="input" aria-label={t("カテゴリ")} value={b.category ?? ""} disabled={readonly}
            onChange={(e) => apply((p) => setCategory(p, blockId, (e.target.value || null) as Parameters<typeof setCategory>[2]))}>
            <option value="">{t("カテゴリなし")}</option>
            {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{t(c.label)}</option>)}
          </select>
        </label>

      <WorkScopePanel project={project} blockId={blockId} editing={scopeEditing} onClose={() => setScopeEditing(false)} />
      {descriptionReminder(b) && <p className="text-[12px] description-reminder" style={{ color: "var(--accent)" }}>{descriptionReminder(b)}</p>}

      {/* タブ: 一度に 1 項目だけ見せる */}
      <div className="seg" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
        {([["status", t("状態")], ["io", t("入出力")], ["owner", t("担当")], ["dates", t("日程")], ["more", t("その他")]] as const).map(([id, label]) => (
          <button key={id} className="seg__btn" data-on={tab === id} onClick={() => setTab(id)} style={{ padding: "6px 2px", fontSize: 12 }}
            title={TAB_HELP[id]}>
            {label}
            {id === "status" && (pending.length > 0 || unread.length > 0) && <span className="dot decision" style={{ marginLeft: 4, display: "inline-block", width: 6, height: 6, borderRadius: 999, background: "var(--accent)" }} />}
            {id === "io" && <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.7 }}>{portsOf(project, blockId, "in").length}/{portsOf(project, blockId, "out").length}</span>}
          </button>
        ))}
      </div>

      {tab !== "status" && (pending.length > 0 || unread.length > 0) && (
        // Status 以外のタブを開いていても、回答待ちと AI 未確認の回答に気づけるようにする (タブは勝手に切り替えない)。
        // 0 件の項目は出さない。押すと Status へ移る (行き先は title と aria-label で伝える)
        <button className="btn btn-sm inspector-attention" onClick={() => setTab("status")} title={t("Status で確認")} aria-label={[
          pending.length > 0 ? t("未回答 {n}", { n: pending.length }) : "", unread.length > 0 ? t("AI 未読 {n}", { n: unread.length }) : "", t("Status で確認"),
        ].filter(Boolean).join(" ")}>
          {[pending.length > 0 ? t("未回答 {n}", { n: pending.length }) : "", unread.length > 0 ? t("AI 未読 {n}", { n: unread.length }) : ""].filter(Boolean).join("・")}
          <span aria-hidden="true" style={{ marginLeft: 8 }}>→</span>
        </button>
      )}

      {/* 1. 状態と進捗 */}
      {tab === "status" && (
      <section className="sec">
        {/* 人の対応が要るものを先頭に: 答えていない質問、次に AI がまだ読んでいない回答 (編集できる) */}
        {pending.length > 0 && <div className="attention-section">
          <h3 className="label">{t("未回答")}</h3>
          {pending.map((d) => <DecisionCard key={d.id} project={project} blockId={blockId} decisionId={d.id} />)}
        </div>}
        {unread.length > 0 && <div className="attention-section">
          <h3 className="label">{t("AI 未読")}</h3>
          {unread.map((d) => <DecisionCard key={d.id} project={project} blockId={blockId} decisionId={d.id} />)}
        </div>}
        <div className="sec__head"><span className="label">Status</span></div>
        <div className="seg">
          {(["black", "gray", "white"] as BlockStatus[]).map((s) => (
            <button key={s} className="seg__btn" data-on={b.status === s} disabled={readonly} onClick={() => setStatus(s)} title={t(STATUS_HELP[s])}>
              <span className={`tree-glyph ${s}`}>{GLYPH[s]}</span>
              <span>{STATUS_LABEL[s]}</span>
            </button>
          ))}
        </div>
        {suggest && !readonly && (
          <button className="btn btn-primary btn-sm w-full" onClick={() => setStatus("white")} title={t("下の階層が全部完了し、出力に成果物が付いています")}>{t("→ Done")}</button>
        )}
        {/* 着手の準備: 要具体化 (自身が作る出力・予定成果物・完了条件) と、必須の入力の状況を別々に出す (I/O タブの 必須 / 任意 と expect がここに効く) */}
        {b.status !== "white" && kindOf(b) !== "project" && !b.merge && (() => {
          const reasons = unpreparedReasons(project, blockId);
          // 必須の入力と、まだ答えていない分岐 (分岐待ち)
          const missing = waitingFor(project, blockId);
          if (reasons.length === 0 && missing.length === 0) return portsOf(project, blockId, "in").length > 0 || portsOf(project, blockId, "out").length > 0
            ? <div className="text-[12px]" style={{ color: "var(--primary-strong)" }}>{t("✓ Ready")}</div> : null;
          return (
            <div className="text-[12px] flex flex-col gap-1" style={{ color: "var(--text-muted)" }}>
              {reasons.length > 0 && <ul className="unprepared-list" title={t("着手の前に、出力の予定成果物 (expect) と完了条件を決めます")}>
                {/* 理由を押すと直す場所へ: 予定成果物・出力の担当は入出力タブ、完了条件は作業範囲の編集 */}
                {reasons.map((r, i) => <li key={i}>
                  <button type="button" className="unprepared-list__item" onClick={() => { if (r.kind === "missing-acceptance") setScopeEditing(true); else setTab("io"); }}
                    title={r.kind === "missing-acceptance" ? t("作業範囲を編集") : t("入出力")}>{reasonText(project, r)}</button>
                </li>)}
              </ul>}
              {missing.length > 0 && <div>{t("待ち: {names}", { names: missing.join(", ") })}</div>}
            </div>
          );
        })()}
        {/* プロジェクトのボックス: 対応するリポジトリ (複数リポジトリを 1 つのファイルで管理するときの目印) */}
        {isProject && (
          <>
            <div className="sec__head mt-2"><span className="label">Repository</span></div>
            <input className="input" placeholder={t("パスや URL (例: ../mg-core、github.com/you/repo)")} title={t("複数のリポジトリをまたぐときは、boxglow.json を上のフォルダに 1 つ置き、各リポジトリの AI には環境変数 BOXGLOW_FILE でその場所を教えます")} value={b.repo ?? ""} disabled={readonly}
              onChange={(e) => apply((p) => updateBlock(p, blockId, { repo: e.target.value }), { history: false })}
              onBlur={(e) => apply((p) => updateBlock(p, blockId, { repo: e.target.value.trim() || undefined }))} />
          </>
        )}

        {b.status !== "white" && (
          <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
            <input type="range" min={0} max={100} step={5} value={percent} disabled={readonly} className="flex-1" title={t("進捗 (ドラッグで入力)")}
              onChange={(e) => apply((p) => setProgress(p, blockId, Number(e.target.value), "human"), { history: false })}
              onMouseUp={(e) => apply((p) => setProgress(p, blockId, Number((e.target as HTMLInputElement).value), "human"))} />
            <span style={{ minWidth: 36, textAlign: "right" }}>{percent}%</span>
            {typeof b.progress === "number" ? (
              <button className="btn btn-ghost btn-sm" title={t("手入力をやめて、下の階層から自動で計算する")} onClick={() => apply((p) => setProgress(p, blockId, null, "human"))}>Auto</button>
            ) : kids.length > 0 ? (
              <span title={t("下の階層の完了数")}>{prog.white}/{prog.total}</span>
            ) : null}
          </div>
        )}
        {b.activity && (
          <div className="flex flex-col gap-1 pl-2" style={{ borderLeft: `3px solid ${b.activity.state === "needs_decision" ? "var(--accent)" : "var(--primary)"}` }}>
            <div className="flex items-center gap-2 text-[12px]">
              <span className="tl-actor">{actorLabel(b.activity.actor)}</span>
              <b>{t(ACTIVITY_LABEL[b.activity.state])}</b>
              <span style={{ color: "var(--text-muted)" }}>{agoText(b.activity.since)}</span>
              {!readonly && <button className="btn btn-ghost btn-sm ml-auto" title={t("活動の印を消す")} onClick={() => apply((p) => clearActivity(p, blockId))}>×</button>}
            </div>
            {b.activity.note && b.activity.state !== "needs_decision" && <div className="text-[13px]">{b.activity.note}</div>}
          </div>
        )}
        {/* レビューの記録の状態: 分解 (子があるとき) と着手準備。なし / 済 / 古い (何が変わったか)。人も「確認」で記録できる */}
        {b.status !== "white" && <ReviewState project={project} blockId={blockId} />}
        {/* AI への引き継ぎ: セッションをまたいで残すメモ (project.handoffs にボックスごとに 1 つ)。メモがあるときは開いた状態で出す。
            下のボタンは、判断・入出力も含めた引き継ぎ情報 (agentContext) を JSON でコピーする */}
        <details className="text-[12px]" open={!!project.handoffs?.[blockId] && b.status !== "white"}>
          <summary title={t("セッションを越えて残す発見・次の手順・未解決事項。AI は context コマンドで判断と合わせて読み直します。")}>{t("引き継ぎ")}</summary>
          {/* 引き継ぎが状態の変更より前のものだと分かったときだけ注記する (画面の文字を増やさない) */}
          {project.handoffs?.[blockId]?.note && freshnessText(b, project.handoffs[blockId].at, "older") && <p className="my-2 text-[11px]">{freshnessText(b, project.handoffs[blockId].at, "older")}</p>}
          <DebouncedText multiline className="input mt-2" value={project.handoffs?.[blockId]?.note ?? ""} disabled={readonly} placeholder={t("発見 / 次の手順 / 未解決事項")}
            onCommit={(note) => apply((q) => ({ ...q, handoffs: { ...q.handoffs, [blockId]: { note, actor: "human", at: new Date().toISOString() } } }))} />
          <button className="btn btn-sm mt-2" onClick={async () => { const ok = await copyText(JSON.stringify(agentContext(project, blockId), null, 2)); setToast(ok ? t("引き継ぎ情報をコピーしました") : t("コピーできませんでした")); }} title={t("判断・入出力も含めてコピー")}>Copy</button>
        </details>
        {/* 回答済みの判断も残す: 選んだもの・残した候補・以前の答えが見え、やり直せる */}
        {b.decisions.filter((d) => d.answer !== undefined && decisionIsAcked(project, blockId, d)).length > 0 && (
          <details className="text-[12px]">
            <summary style={{ cursor: "pointer", color: "var(--text-muted)" }}>{t("判断 ({n})", { n: b.decisions.filter((d) => d.answer !== undefined && decisionIsAcked(project, blockId, d)).length })}</summary>
            <div className="flex flex-col gap-3 mt-2">
              {b.decisions.filter((d) => d.answer !== undefined && decisionIsAcked(project, blockId, d)).map((d) => <DecisionCard key={d.id} project={project} blockId={blockId} decisionId={d.id} />)}
            </div>
          </details>
        )}
      </section>
      )}

      {/* 2. 担当: 割り当て済みはチップ、追加は検索で */}
      {tab === "owner" && (
      <section className="sec">
        {/* AI の受け持ち (誰がこのボックスを作業中に持っているか)。「誰が担当か」の情報なので担当タブに置く。
            題名の下に置くと、狭い画面で「回答が必要です」の質問が画面の外へ押し出された (質問を先に見せる方針)。
            受け持ちは図のボックスの札とツリーの錠でも見える */}
        <ClaimDetails project={project} blockId={blockId} />
        <div className="sec__head"><span className="label">{t("担当")}</span></div>
        <div className="flex items-center gap-1 flex-wrap">
          {b.assigneeIds.map((id) => {
            const m = project.members.find((x) => x.id === id);
            if (!m) return null;
            return (
              <span key={id} className="chip" data-on={m.id === meId} style={{ cursor: "default" }} title={m.id === meId ? t("{name} (自分)", { name: m.name }) : m.name}>
                <span className="avatar" style={{ background: m.color, width: 16, height: 16, fontSize: 9 }}>{m.name.slice(0, 1)}</span>
                {m.name}
                {!readonly && <button className="btn btn-ghost btn-sm" style={{ padding: "0 2px" }} title={t("外す")} onClick={() => toggleAssignee(m.id)}>×</button>}
              </span>
            );
          })}
          {b.assigneeIds.length === 0 && <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>{t("未担当")}</span>}
          {!readonly && meId && !b.assigneeIds.includes(meId) && <button className="btn btn-ghost btn-sm" onClick={() => toggleAssignee(meId)} title={t("自分を担当にする")}>Me</button>}
        </div>
        {!readonly && (
          <div className="relative">
            <input className="input" placeholder={project.members.length === 0 ? t("名前を打って Enter で登録") : t("名前で検索して Enter で割り当て")} value={ownerQuery}
              onChange={(e) => setOwnerQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") { setOwnerQuery(""); return; }
                if (e.key !== "Enter") return;
                const hit = ownerHits[0];
                if (hit) { if (!b.assigneeIds.includes(hit.id)) toggleAssignee(hit.id); setOwnerQuery(""); return; }
                const name = ownerQuery.trim();
                if (name) {
                  // 居ない名前なら登録して割り当てる
                  apply((p) => { const r = addMember(p, name, MEMBER_COLORS[p.members.length % MEMBER_COLORS.length]); return updateBlock(r.project, blockId, { assigneeIds: [...r.project.blocks[blockId].assigneeIds, r.memberId] }); });
                  setOwnerQuery("");
                }
              }} />
            {ownerQuery.trim() && (
              <div className="card absolute left-0 right-0 mt-1 p-1 flex flex-col z-30" style={{ maxHeight: 220, overflow: "auto" }}>
                {ownerHits.map((m) => (
                  <button key={m.id} className="btn btn-ghost btn-sm justify-start" onMouseDown={(e) => e.preventDefault()} onClick={() => { if (!b.assigneeIds.includes(m.id)) toggleAssignee(m.id); setOwnerQuery(""); }}>
                    <span className="avatar" style={{ background: m.color, width: 16, height: 16, fontSize: 9, marginRight: 6 }}>{m.name.slice(0, 1)}</span>{m.name}
                  </button>
                ))}
                {ownerHits.length === 0 && <div className="text-[12px] p-1" style={{ color: "var(--text-muted)" }}>{t("Enter → 「{name}」を追加", { name: ownerQuery.trim() })}</div>}
              </div>
            )}
          </div>
        )}
      </section>
      )}

      {/* 期日と時間 */}
      {tab === "dates" && (
      <section className="sec">
        <div className="sec__head"><span className="label">Schedule</span></div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[12px]">
          <label className="flex items-center gap-2 col-span-2"><span style={{ color: "var(--text-muted)", minWidth: 32 }}>{t("開始")}</span>
            <DateField value={b.startDate ?? ""} disabled={readonly} onChange={(v) => apply((p) => setSchedule(p, blockId, { startDate: v || null }, "human"))} /></label>
          <label className="flex items-center gap-2 col-span-2"><span style={{ color: isOverdue(b) ? "var(--danger)" : "var(--text-muted)", minWidth: 32 }}>{t("期日")}</span>
            <DateField value={b.dueDate ?? ""} disabled={readonly} danger={isOverdue(b)} onChange={(v) => apply((p) => setSchedule(p, blockId, { dueDate: v || null }, "human"))} /></label>
          <label className="flex items-center gap-2"><span style={{ color: "var(--text-muted)", minWidth: 32 }}>{t("見積")}</span>
            <input type="number" min={0} step={0.5} className="input input-plain" placeholder="h" value={b.estimateHours ?? ""} disabled={readonly} onChange={(e) => apply((p) => setSchedule(p, blockId, { estimateHours: e.target.value === "" ? null : Number(e.target.value) }, "human"))} /><span style={{ color: "var(--text-muted)" }}>h</span></label>
          <label className="flex items-center gap-2"><span style={{ color: "var(--text-muted)", minWidth: 32 }}>{t("実績")}</span>
            <input type="number" min={0} step={0.5} className="input input-plain" placeholder="h" value={b.actualHours ?? ""} disabled={readonly} onChange={(e) => apply((p) => setSchedule(p, blockId, { actualHours: e.target.value === "" ? null : Number(e.target.value) }, "human"))} /><span style={{ color: "var(--text-muted)" }}>h</span></label>
        </div>
        {b.dueDate && b.status !== "white" && (() => { const d = daysToDue(b); return d === null ? null : <div className="text-[12px]" style={{ color: d < 0 ? "var(--danger)" : "var(--text-muted)" }}>{d < 0 ? t("期日を {d} 日過ぎています", { d: -d }) : d === 0 ? t("期日は今日です") : t("期日まであと {d} 日", { d })}</div>; })()}
      </section>
      )}

      {/* 3. 入力 / 4. 出力 */}
      {tab === "io" && (<>
      <PortsEditor project={project} blockId={blockId} direction="in" readonly={readonly} title="Inputs" />
      <PortsEditor project={project} blockId={blockId} direction="out" readonly={readonly} title="Outputs" allowAdd={canAddOutput(project, blockId)} />
      </>)}

      {/* AI */}
      {tab === "more" && (<>
      <section className="sec">
        <div className="sec__head"><span className="label">Issue</span></div>
        {/* 外部の課題 (JIRA / Redmine / GitHub Issue) の URL。ボックスにはキー (PROJ-123, #45) の札が出て、押すと開く */}
        <input className="input" placeholder={t("JIRA / Redmine / GitHub Issue の URL")} value={b.issue ?? ""} disabled={readonly}
          onChange={(e) => apply((p) => updateBlock(p, blockId, { issue: e.target.value }), { history: false })}
          onBlur={(e) => apply((p) => updateBlock(p, blockId, { issue: e.target.value.trim() || undefined }))} />
        {b.issue && <a className="text-[12px] underline" href={b.issue} target="_blank" rel="noreferrer" style={{ color: "var(--primary-strong)" }}>{t("開く: {key}", { key: issueKeyOf(b.issue) })}</a>}
      </section>
      <section className="sec">
        <div className="sec__head"><span className="label">AI</span>
        <button className="btn btn-sm" data-on={aiOpen} onClick={() => setAiOpen(!aiOpen)} title={t("このボックスの入出力と位置づけを Markdown にしてコピーして AI に渡す")}>Copy for AI {aiOpen ? "▴" : "▾"}</button>
        </div>
      {aiOpen && (
        <div className="flex flex-col pl-2" style={{ borderLeft: "3px solid var(--line-soft)" }}>
          <button className="btn btn-ghost btn-sm justify-start" onClick={() => copyPrompt("plan")}>{t("手順案")}</button>
          <button className="btn btn-ghost btn-sm justify-start" onClick={() => copyPrompt("decompose")}>{t("分解案 (JSON)")}</button>
          <button className="btn btn-ghost btn-sm justify-start" onClick={() => copyPrompt("review")}>{t("抜けの指摘")}</button>
        </div>
      )}
      {showPrompt && (
        <div>
          <textarea className="input" style={{ minHeight: 180, fontSize: 12 }} readOnly value={blockToPrompt(project, blockId, showPrompt)} />
          <button className="btn btn-ghost btn-sm" onClick={() => setShowPrompt(null)}>Close</button>
        </div>
      )}
      </section>

      {/* メモ・資料 (必要なときだけ開く) */}
      <section className="sec">
        <div className="sec__head"><span className="label">Notes{b.description || b.artifacts.length > 0 ? " *" : ""}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setMore(!more)}>{more ? "▴" : "▾"}</button></div>
        {more && (
          <div className="flex flex-col gap-2">
            {/* 説明が状態の変更より前のものだと分かったときだけ注記する */}
            {b.description && freshnessText(b, b.descriptionUpdatedAt, "older") && <p className="text-[11px]">{freshnessText(b, b.descriptionUpdatedAt, "older")}</p>}
            <DebouncedText multiline className="input" placeholder={t("メモ (入力から出力をどう作るか)")} value={b.description} disabled={readonly}
              onCommit={(v) => apply((p) => updateBlock(p, blockId, { description: v }))} />
            <ArtifactsEditor artifacts={b.artifacts} readonly={readonly} addLabel="Link" onChange={(next) => apply((p) => updateBlock(p, blockId, { artifacts: next }))} />
          </div>
        )}
      </section>
      </>)}
    </div>
  );
}



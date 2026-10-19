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
import { outputOwners, unpreparedReasons } from "../model/readiness";
import { ReviewState } from "./ReviewState";
import { ReadinessFields } from "./ReadinessFields";
import { CloseButton } from "./CloseButton";
import { AcceptanceField, ConstraintsField, WorkScopePanel, WorkflowSettings } from "./WorkScope";
import { descriptionReminder, freshnessText } from "../model/workflow";
import { isAcked as decisionIsAcked, isLastProjectBox } from "../model/graph";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { LiveMarkdownEditor } from "./LiveMarkdownEditor";
import { addLogEntry, removeLogEntry, isNow, setNow, addInputGroup, addMember, ancestorsOf, exportInputGroup, importInputGroup, inputGroupsOf, portsOf, removeInputGroup, rootInputsOf, updateInputGroup, canSuggestWhite, childrenOf, clearActivity, computeProgress, daysToDue, effectiveProgress, extractTemplate, isOverdue, issueKeyOf, kindOf, removeBlock, setCategory, setProgress, setSchedule, updateBlock, waitingFor } from "../model/graph";
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
      {/* 手を止めてから反映する (1 文字ごとに履歴を積むと、元に戻す操作が 1 文字ずつになる) */}
      <DebouncedText className="input font-head text-[16px]" value={project.name} disabled={readonly}
        onCommit={(v) => apply((p) => ({ ...structuredClone(p), name: v }))} />
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
    // 名前は prompt で聞かない (VS Code の webview では prompt が出ない)。仮の名前で作って、開いたグループの名前欄で直す
    apply((p) => { const r = addInputGroup(p, t("新しいグループ")); setTimeout(() => select({ terminal: "in", terminalGroup: r.groupId }), 0); return r.project; });
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
              {!readonly && <button className="btn btn-ghost btn-sm btn-danger" title={t("グループを削除 (入力は Inputs に戻ります)")} onClick={() => { select({ terminal: "in" }); apply((p) => removeInputGroup(p, group.id)); setToast(t("グループ「{name}」を削除しました (入力は Inputs に戻りました。Undo で戻せます)", { name: group.name })); }}>Delete</button>}
            </span>
          </div>
          <DebouncedText className="input font-head text-[15px]" value={group.name} disabled={readonly} placeholder="Group name" onCommit={(v) => apply((p) => updateInputGroup(p, group.id, { name: v }))} />
          <DebouncedText className="input" value={group.description} disabled={readonly} placeholder={t("説明 (任意。例: PCI-SIG の仕様書一式)")} onCommit={(v) => apply((p) => updateInputGroup(p, group.id, { description: v }))} />
        </section>
      )}
      <PortsEditor project={project} blockId={ROOT_ID} direction={which} readonly={readonly} title={which === "in" ? "Inputs" : "Outputs"} groupId={which === "in" ? (group ? group.id : null) : undefined} />
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
  const saveAsset = useProjectStore((s) => s.saveAsset);
  /**
   * 貼り付け・ドロップされた画像を boxglow.assets/ に保存し、メモの末尾に ![](boxglow.assets/...) を足す (serve / VS Code)
   * Input : files = 貼り付け・ドロップのファイル, e = 元のイベント (画像があれば既定の動作を止める)
   * Output: なし (保存できなければ通知が出る)
   */
  const pasteImages = async (files: FileList | null, e: { preventDefault: () => void }) => {
    const images = files ? [...files].filter((f) => f.type.startsWith("image/")) : [];
    if (images.length === 0) return;
    e.preventDefault();
    const lines: string[] = [];
    for (const f of images) { const path = await saveAsset(f); if (path) lines.push(`![${f.name.replace(/\.[^.]+$/, "") || "image"}](${path})`); }
    if (lines.length > 0) apply((p) => { const cur = p.blocks[blockId]?.description ?? ""; return updateBlock(p, blockId, { description: (cur ? cur.replace(/\n*$/, "\n\n") : "") + lines.join("\n") + "\n" }); });
  };
  const [menu, setMenu] = useState(false);
  // 分岐に変えるダイアログを開いているか
  const [branching, setBranching] = useState(false);
  const [ownerQuery, setOwnerQuery] = useState("");
  const [tab, setTab] = useState<"status" | "io" | "owner" | "dates" | "more" | "log">("status");
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

  // 図の札 (要具体化など) から開いたときは、要求されたタブを開く
  const panelTab = useProjectStore((s) => s.selection.panelTab);
  const clearPanelTab = useProjectStore((s) => s.clearPanelTab);
  useEffect(() => { if (panelTab) { setTab(panelTab); clearPanelTab(); } }, [panelTab, clearPanelTab]);
  // 別のブロックを選んだら開いていたものを閉じる
  useEffect(() => {
    setAiOpen(false);
    setScopeEditing(false);
    setShowPrompt(null);
    setMenu(false);
    setOwnerQuery("");
    // タブは保つ (別のボックスを選んでも I/O などを続けて見比べられるように。Status には戻さない)
  }, [blockId]);

  /** 状態を変える (同じ状態なら何もしない。結果は選択の表示で分かるので通知は出さない) */
  const setStatus = (s: BlockStatus) => {
    if (b.status === s) return;
    apply((p) => updateBlock(p, blockId, { status: s }));
  };
  const toggleAssignee = (id: string) =>
    apply((p) => {
      const cur = p.blocks[blockId].assigneeIds;
      return updateBlock(p, blockId, { assigneeIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
    });
  const remove = () => {
    // 計画にはプロジェクトのボックスが 1 つは要る (最後の 1 つは消せない。中のボックスを消すか、ファイルごと作り直す)
    if (isLastProjectBox(project, blockId)) { setToast(t("最後のプロジェクトのボックスは削除できません")); return; }
    // 確認しない: 計画の中の削除は元に戻す操作で戻せる (VS Code の webview では confirm が出ないので、確認があると消せなくなる)
    select({});
    apply((p) => removeBlock(p, blockId));
    setToast(t("「{title}」を削除しました (Undo で戻せます)", { title: b.title }));
  };
  const copyPrompt = async (ask: "plan" | "decompose" | "review") => {
    setAiOpen(false);
    const text = blockToPrompt(project, blockId, ask);
    if (await copyText(text)) setToast(t("AI に渡すテキストをコピーしました"));
    else setShowPrompt(ask);
  };
  const saveAsTemplate = async () => {
    setMenu(false);
    // 札 (tags) は聞かない (prompt は VS Code の webview で出ない。札は任意で、部品の JSON を直せば付けられる)
    const tpl = extractTemplate(project, blockId, {});
    await saveTemplate(tpl);
    setToast(t("「{name}」を部品として保存しました (☰ の「部品」から挿入)", { name: tpl.name }));
  };

  // タブの説明 (title)。キーは内部の id なので包まず、文言だけ t() で引く
  const TAB_HELP: Record<typeof tab, string> = {
    status: t("状態・進捗・活動・判断")
  , io: t("入力と出力 (成果物)")
  , owner: t("担当")
  , dates: t("開始日・期日・時間")
  , more: t("操作・Issue・AI に渡す文・資料")
  , log: t("ノート (Markdown のメモ) と作業記録 (日付つき)")
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
                {/* ほかの操作 (作業範囲・今回の範囲・部品・AI 向けの文・分岐にする) は「その他」タブに置く (ここは見つけにくいため)。ここは削除だけ */}
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
      <div className="seg" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
        {/* タブは既存の記号と英語名を維持する。現在の選択も支援技術へ伝える */}
        {([["status", "Status"], ["io", "I/O"], ["owner", "Owner"], ["dates", "Dates"], ["log", "Note"], ["more", "More"]] as const).map(([id, label]) => (
          <button key={id} className="seg__btn seg__btn--tab" data-on={tab === id} onClick={() => setTab(id)} style={{ padding: "6px 2px", fontSize: 11 }}
            title={TAB_HELP[id]} aria-label={label} aria-pressed={tab === id}>
            <TabIcon id={id} />
            <span className="seg__btn-label">{label}</span>
            {id === "status" && (pending.length > 0 || unread.length > 0) && <span className="dot decision" style={{ marginLeft: 4, display: "inline-block", width: 6, height: 6, borderRadius: 999, background: "var(--accent)" }} />}
            {id === "io" && <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.7 }}>{portsOf(project, blockId, "in").length}/{portsOf(project, blockId, "out").length}</span>}
            {id === "log" && (b.log?.length ?? 0) > 0 && <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.7 }}>{b.log!.length}</span>}
          </button>
        ))}
      </div>

      {/* 要具体化: 別のタブを開いていても、着手の前に決めることが残っていると気づけるようにする (押すと状態タブへ) */}
      {tab !== "status" && b.status !== "white" && unpreparedReasons(project, blockId).length > 0 && (
        <button className="btn btn-sm inspector-attention" onClick={() => setTab("status")} title={t("着手の前に、出力の予定成果物 (expect) と完了条件を決めます")}>
          {t("要具体化")}<span aria-hidden="true" style={{ marginLeft: 8 }}>→</span>
        </button>
      )}
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
        <div className="sec__head"><span className="label">Status</span>
          {/* 今ここ (本当にいま作業しているボックス。複数可) の付け外し。図では NOW の札と太い枠 */}
          {!isProject && !readonly && (
            <button className="now-toggle" data-on={isNow(project, blockId)} onClick={() => apply((p) => setNow(p, blockId, "human", !isNow(p, blockId)))}
              title={isNow(project, blockId) ? t("今ここを解除") : t("今ここにする (いま作業しているボックスとして、図に NOW の札と太い枠を付ける。複数の人や AI がいれば、いくつでも)")}>NOW</button>
          )}
        </div>
        <div className="seg">
          {(["black", "gray", "white"] as BlockStatus[]).map((s) => (
            <button key={s} className="seg__btn" data-on={b.status === s} aria-pressed={b.status === s} disabled={readonly} onClick={() => setStatus(s)} title={t(STATUS_HELP[s])}>
              <span className={`tree-glyph ${s}`}>{GLYPH[s]}</span>
              <span>{STATUS_LABEL[s]}</span>
            </button>
          ))}
        </div>
        {suggest && !readonly && (
          <button className="btn btn-primary btn-sm w-full" onClick={() => setStatus("white")} title={t("下の階層が全部完了し、出力に成果物が付いています")}>{t("→ Done")}</button>
        )}
        {/* 完了のときの検査結果 (B160): done --checked / --not-checked / --limits で残したもの */}
        {b.verification && (
          <section className="sec verification">
            <div className="sec__head"><span className="label">{b.status === "white" && (!b.statusChangedAt || Date.parse(b.verification.at) >= Date.parse(b.statusChangedAt)) ? t("検査 (完了のとき)") : t("検査 (前回の完了のとき)")}</span><span className="text-[11px]" style={{ color: "var(--text-muted)" }}>{b.verification.by} · {new Date(b.verification.at).toLocaleString()}</span></div>
            <dl className="text-[12px] flex flex-col gap-1">
              <div><dt className="font-bold inline">{t("検査")}: </dt><dd className="inline whitespace-pre-wrap break-words">{b.verification.checked}</dd></div>
              {b.verification.notChecked && <div><dt className="font-bold inline">{t("未実施")}: </dt><dd className="inline whitespace-pre-wrap break-words">{b.verification.notChecked}</dd></div>}
              {b.verification.limits && <div><dt className="font-bold inline">{t("制限")}: </dt><dd className="inline whitespace-pre-wrap break-words">{b.verification.limits}</dd></div>}
            </dl>
          </section>
        )}
        {/* 着手の準備: 要具体化 (自身が作る出力・予定成果物・完了条件) と、必須の入力の状況を別々に出す (I/O タブの 必須 / 任意 と expect がここに効く) */}
        {b.status !== "white" && kindOf(b) !== "project" && !b.merge && (() => {
          const reasons = unpreparedReasons(project, blockId);
          // 必須の入力と、まだ答えていない分岐 (分岐待ち)
          const missing = waitingFor(project, blockId);
          // 欄 (予定成果物・完了条件) は、自身が作る出力があるかぎり埋まっても出したままにする (打っている途中で消えない。何を書いたか・どこに入るかが見える)
          const hasFields = reasons.length > 0 || outputOwners(project, blockId).some((o) => o.owner.kind === "self");
          if (!hasFields && missing.length === 0) return portsOf(project, blockId, "in").length > 0 || portsOf(project, blockId, "out").length > 0
            ? <div className="text-[12px]" style={{ color: "var(--primary-strong)" }}>{t("✓ Ready")}</div> : null;
          return (
            <div className="text-[12px] flex flex-col gap-1" style={{ color: "var(--text-muted)" }}>
              {/* 着手の準備: 不足している欄をその場で埋める (入出力タブ・作業範囲と同じ値)。埋まっても ✓ 付きで残す */}
              {hasFields && <ReadinessFields key={blockId} project={project} blockId={blockId} onOpenIo={() => setTab("io")} />}
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
              {!readonly && <button className="btn btn-ghost btn-sm ml-auto" title={t("活動の印を外す")} onClick={() => apply((p) => clearActivity(p, blockId))}>×</button>}
            </div>
            {b.activity.note && b.activity.state !== "needs_decision" && <div className="text-[13px]">{b.activity.note}</div>}
          </div>
        )}
        {/* レビューの記録の状態: 分解 (子があるとき) と着手準備。なし / 済 / 古い (何が変わったか)。人も「確認」で記録できる */}
        {b.status !== "white" && <ReviewState project={project} blockId={blockId} />}
        {/* AI への引き継ぎ: セッションをまたいで残すメモ (project.handoffs にボックスごとに 1 つ)。メモがあるときは開いた状態で出す。
            下のボタンは、判断・入出力も含めた引き継ぎ情報 (agentContext) を JSON でコピーする */}
        <details className="text-[12px]" open={!!project.handoffs?.[blockId] && b.status !== "white"}>
          <summary title={t("セッションを越えて残す発見・次の手順・未解決事項。AI は context コマンドで判断と合わせて読み直します。")}>{t("引き継ぎ")}<span className="summary-hint">{t("AI へ残すメモと次の手順")}</span></summary>
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
      <PortsEditor project={project} blockId={blockId} direction="out" readonly={readonly} title="Outputs" />
      {/* 完了条件と制約: 出力のすぐ下に置く (利用者の要望 2026-10-18: More の作業範囲の中では見つからない)。作業範囲の編集・着手の準備の欄と同じ値 */}
      <AcceptanceField project={project} blockId={blockId} />
      <ConstraintsField project={project} blockId={blockId} />
      </>)}

      {/* AI */}
      {tab === "log" && (<>
        {/* ノート: 常に編集できる 1 つの欄 (Obsidian のライブプレビュー: カーソルの行は打ったままの Markdown、ほかの行は見た目)。閲覧専用なら整形表示だけ */}
        <section className="sec notes">
          {b.description && freshnessText(b, b.descriptionUpdatedAt, "older") && <p className="text-[11px]">{freshnessText(b, b.descriptionUpdatedAt, "older")}</p>}
          {readonly ? (b.description ? <Markdown text={b.description} className="md-view md-view--notes" /> : null) : (
            <NotesEditor value={b.description} placeholder={t("メモ (Markdown で書けます: 見出し・箇条書き・表・リンク・画像)")}
              onCommit={(v) => apply((p) => updateBlock(p, blockId, { description: v }))} onFiles={(files, e) => void pasteImages(files, e)} />
          )}
        </section>
        <div className="sec__head"><span className="label">{t("記録")}</span></div>
        <WorkLog project={project} blockId={blockId} readonly={readonly} apply={apply} />
      </>)}
      {tab === "more" && (<>
      {/* 操作: 以前は ⋯ メニューにあったもの。見つけやすいようにタブの先頭に並べる */}
      {!readonly && (
      <section className="sec">
        <div className="sec__head"><span className="label">{t("操作")}</span></div>
        <p className="sec__hint">{t("このボックスに対する操作: 範囲の編集、今回の対象、部品として保存、AI に渡す文、分岐への変換")}</p>
        <div className="more-actions">
          {/* 開いている間はもう一度押すと閉じる (✓ が付く) */}
          <button className="btn btn-sm" data-on={scopeEditing} onClick={() => setScopeEditing(!scopeEditing)} title={t("今回達成すること・扱わないこと・制約・完了条件・相談する条件")}>{t("作業範囲・制約を編集")}</button>
          <button className="btn btn-sm" data-on={project.focusBlockId === blockId} onClick={() => apply(p => ({ ...p, focusBlockId: p.focusBlockId === blockId ? undefined : blockId }))} title={t("このボックスと配下を、次の候補の先頭にする")}>{project.focusBlockId === blockId ? t("今回の範囲を解除") : t("今回の範囲にする")}</button>
          {!isProject && <button className="btn btn-sm" onClick={saveAsTemplate} title={t("ほかの計画でも使い回せる部品として保存する")}>{t("部品として保存")}</button>}
          <button className="btn btn-sm" data-on={showPrompt !== null} onClick={() => setShowPrompt(showPrompt ? null : "plan")} title={t("このボックスの入出力と位置づけを Markdown にして表示する (コピーして AI に渡す)")}>{t("AI に渡す文")}</button>
          {!isProject && !b.branch && (() => {
            const can = canConvertToBranch(project, blockId);
            return <button className="btn btn-sm" disabled={!can.ok} onClick={() => setBranching(true)}
              title={can.ok ? t("問いと選択肢を持つ分岐に変える (今の出力は 1 つ目の選択肢の道になる)") : t("中にボックスを持つボックスは、分岐にできません")}><span aria-hidden="true">◇</span> {t("分岐にする")}</button>;
          })()}
        </div>
      </section>
      )}
      <section className="sec">
        <div className="sec__head"><span className="label">Issue</span></div>
        <p className="sec__hint">{t("外部の課題 (JIRA / Redmine / GitHub Issue) の URL。ボックスに札が出て、押すと開きます")}</p>
        {/* 外部の課題 (JIRA / Redmine / GitHub Issue) の URL。ボックスにはキー (PROJ-123, #45) の札が出て、押すと開く */}
        <input className="input" placeholder={t("JIRA / Redmine / GitHub Issue の URL")} value={b.issue ?? ""} disabled={readonly}
          onChange={(e) => apply((p) => updateBlock(p, blockId, { issue: e.target.value }), { history: false })}
          onBlur={(e) => apply((p) => updateBlock(p, blockId, { issue: e.target.value.trim() || undefined }))} />
        {b.issue && <a className="text-[12px] underline" href={b.issue} target="_blank" rel="noreferrer" style={{ color: "var(--primary-strong)" }}>{t("開く: {key}", { key: issueKeyOf(b.issue) })}</a>}
      </section>
      <section className="sec">
        <div className="sec__head"><span className="label">AI</span>
        <button className="btn btn-sm" data-on={aiOpen} onClick={() => setAiOpen(!aiOpen)} title={t("このボックスの入出力と位置づけを Markdown にしてコピーして AI に渡す")}>{t("コピーする文を選ぶ")} {aiOpen ? "▴" : "▾"}</button>
        </div>
        <p className="sec__hint">{t("このボックスの入出力と位置づけを文にしてコピーし、AI (Claude / Codex など) に貼って渡します")}</p>
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

      {/* 資料 (リンク)。メモ本文は「ノート」タブへ移した */}
      <section className="sec">
        <div className="sec__head"><span className="label">Links{b.artifacts.length > 0 ? " *" : ""}</span></div>
        <p className="sec__hint">{t("成果物や参考資料のリンク (URL やファイルのパス)")}</p>
        <ArtifactsEditor artifacts={b.artifacts} readonly={readonly} addLabel="Link" onChange={(next) => apply((p) => updateBlock(p, blockId, { artifacts: next }))} />
      </section>
      </>)}
    </div>
  );
}

/**
 * 作業記録 (記録タブ): 日付・書き手つきの Markdown の項目を新しい順に並べ、下 (入力欄は上) から足す。引き継ぎメモ (handoffs) があれば先頭に出す
 * Input : project, blockId, readonly, apply
 * Output: 記録の一覧と入力欄の JSX
 */
function WorkLog({ project, blockId, readonly, apply }: { project: Project; blockId: string; readonly: boolean; apply: (fn: (p: Project) => Project) => void }) {
  const b = project.blocks[blockId];
  const meId = useProjectStore((s) => s.meId);
  const me = project.members.find((m) => m.id === meId)?.name ?? "human";
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const handoff = project.handoffs?.[blockId];
  const entries = [...(b.log ?? [])].reverse();
  const add = () => { const text = draft.trim(); if (!text) return; apply((p) => addLogEntry(p, blockId, me, text)); setDraft(""); };
  const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(); };
  return (
    <section className="sec worklog" aria-label={t("作業記録")}>
      {!readonly && (
        <div className="worklog__new">
          <textarea className="input md-edit" style={{ minHeight: 72 }} placeholder={t("記録を書く (Markdown 可。Ctrl+Enter で追記)")} value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); add(); } }} />
          <div className="worklog__actions"><button className="btn btn-primary btn-sm" disabled={!draft.trim()} onClick={add}>{t("追記")}</button></div>
        </div>
      )}
      {handoff && (
        <article className="worklog__entry worklog__entry--handoff">
          <header className="worklog__head"><span className="worklog__by">{handoff.actor}</span><span className="worklog__at">{when(handoff.at)}</span><span className="worklog__kind">{t("引き継ぎ")}</span></header>
          <Markdown text={handoff.note} />
        </article>
      )}
      {entries.length === 0 && !handoff && <p className="muted">{t("まだ記録はありません。進捗や気づきを、日付つきで残せます (AI は boxglow log で足します)")}</p>}
      {entries.map((e) => (
        <article key={e.id} className="worklog__entry">
          <header className="worklog__head">
            <span className="worklog__by">{e.by}</span><span className="worklog__at">{when(e.at)}</span>
            {!readonly && <span className="worklog__tools">
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(editing === e.id ? null : e.id)} title={t("編集")}>✎</button>
              <button className="btn btn-ghost btn-sm" onClick={() => apply((p) => removeLogEntry(p, blockId, e.id))} title={t("削除 (Undo で戻せます)")}>×</button>
            </span>}
          </header>
          {editing === e.id ? (
            <DebouncedText multiline className="input md-edit" value={e.text} autoFocus onBlur={() => setEditing(null)}
              onCommit={(v) => apply((p) => { const blk = p.blocks[blockId]; if (!blk?.log) return p; return { ...p, blocks: { ...p.blocks, [blockId]: { ...blk, log: blk.log.map((x) => x.id === e.id ? { ...x, text: v } : x) } } }; })} />
          ) : <Markdown text={e.text} />}
        </article>
      ))}
    </section>
  );
}

/** タブの記号 (線画の小さな SVG。言語に依らず意味が伝わるように) */
function TabIcon({ id }: { id: "status" | "io" | "owner" | "dates" | "log" | "more" }) {
  const common = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (id) {
    case "status": return <svg {...common}><circle cx="8" cy="8" r="5.5" /><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none" /></svg>;
    case "io": return <svg {...common}><path d="M2 5.5h8M8 3l2.5 2.5L8 8M14 10.5H6M8 8 5.5 10.5 8 13" /></svg>;
    case "owner": return <svg {...common}><circle cx="8" cy="5.5" r="2.5" /><path d="M3 13.5c0-2.5 2.2-4 5-4s5 1.5 5 4" /></svg>;
    case "dates": return <svg {...common}><rect x="2.5" y="3.5" width="11" height="10" rx="1.5" /><path d="M2.5 7h11M5.5 2v3M10.5 2v3" /></svg>;
    case "log": return <svg {...common}><path d="M4 2.5h6l3 3v8H4z" /><path d="M10 2.5v3h3M6 8h4M6 10.5h4" /></svg>;
    default: return <svg {...common}><circle cx="3.5" cy="8" r="1" fill="currentColor" /><circle cx="8" cy="8" r="1" fill="currentColor" /><circle cx="12.5" cy="8" r="1" fill="currentColor" /></svg>;
  }
}

/**
 * ノートの編集欄: Markdown のライブプレビュー (LiveMarkdownEditor) に、保存のまとめ (400ms) と欄を離れたときの保存を付ける
 * Input : value = 今の本文, onCommit = 保存, onFiles = 画像の貼り付け・ドロップ
 * Output: 編集欄の JSX
 */
function NotesEditor({ value, placeholder, onCommit, onFiles }: { value: string; placeholder: string; onCommit: (v: string) => void; onFiles: (files: FileList | null, e: { preventDefault: () => void }) => void }) {
  const assetBase = useProjectStore((s) => s.assetBase);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draft = useRef(value);
  const latest = useRef(value); latest.current = value;
  const flush = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } if (draft.current !== latest.current) onCommit(draft.current); };
  // 片付け: 欄が消えるとき (別のボックスを選んだ) に、まとめ待ちの変更を保存する
  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <LiveMarkdownEditor value={value} placeholder={placeholder} assetBase={assetBase} minHeight={240}
      onChange={(v) => { draft.current = v; if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { timer.current = null; if (v !== latest.current) onCommit(v); }, 400); }}
      onBlur={flush} onFiles={onFiles} />
  );
}

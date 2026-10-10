/**
 * 引き出し (☰ で開く): 絞り込み、メンバー、部品
 * 階層の一覧と管理は TreePanel に分離する。フィルタ判定は図とツリーで共有し、結果が食い違わないようにする。
 * 既定は閉じていて、キャンバスの左に重ねて出す。
 */
import { CloseButton } from "./CloseButton";
import { useEffect, useState } from "react";
import { addMember, instantiateTemplate, kindOf, parseTemplate, removeMember } from "../model/graph";
import type { BlockTemplate } from "../model/types";
import { deleteTemplate, listTemplates, saveTemplate } from "../lib/templates";
import { downloadText, pickTextFile, safeFilename } from "../lib/download";
import { type BlockStatus, type Project } from "../model/types";
import { parentForNewBlock, useProjectStore } from "../store/useProjectStore";
import { CATEGORIES } from "../model/categories";
import { STATUS_LABEL } from "../model/status";
// 言語切り替え: 日本語の文は t() で包み、英語の辞書 (src/i18n/en/parts.ts) で引く
import { t, useLang } from "../i18n";

/** メンバーのアバター色の候補 (テーマの色から) */
export const MEMBER_COLORS = ["#0d8080", "#e8875e", "#3aa85a", "#6b7075", "#2f6fb3", "#a0522d"];

/** 状態の印 */
export const GLYPH: Record<BlockStatus, string> = { black: "?", gray: "~", white: "✓" };

export interface Filter {
  statuses: Set<BlockStatus>;
  memberId: string | null;
  /** 未担当のボックスだけ */
  unassigned: boolean;
  /** このカテゴリのボックスだけ (null なら絞らない) */
  category: string | null;
}

/** 何も絞っていないフィルタ */
export const EMPTY_FILTER: Filter = { statuses: new Set(["black", "gray", "white"]), memberId: null, unassigned: false, category: null };

/** ブロックがフィルタに合うか */
export function matchesFilter(p: Project, blockId: string, f: Filter): boolean {
  const b = p.blocks[blockId];
  if (!b) return false;
  if (!f.statuses.has(b.status)) return false;
  if (f.memberId && !b.assigneeIds.includes(f.memberId)) return false;
  if (f.unassigned && (b.assigneeIds.length > 0 || kindOf(b) === "project")) return false;
  if (f.category && b.category !== f.category) return false;
  return true;
}

/** 入力: 状態・担当・カテゴリの Filter。出力: 条件が既定値で、何も絞っていなければ true。 */
export const isFilterEmpty = (f: Filter): boolean => f.statuses.size === 3 && f.memberId === null && !f.unassigned && f.category === null;

export function Drawer({ project, filter, onFilter, onClose, width }: { project: Project; filter: Filter; onFilter: (f: Filter) => void; onClose: () => void; width: number }) {
  useLang(); // 言語が変わったら描き直す
  const readonly = useProjectStore((s) => s.readonly);
  const selection = useProjectStore((s) => s.selection);
  const select = useProjectStore((s) => s.select);
  const apply = useProjectStore((s) => s.apply);
  const [name, setName] = useState("");
  const [color, setColor] = useState(MEMBER_COLORS[0]);
  const focusBlock = useProjectStore((s) => s.focusBlock);
  const setToast = useProjectStore((s) => s.setToast);
  const meId = useProjectStore((s) => s.meId);
  const setMe = useProjectStore((s) => s.setMe);
  const [templates, setTemplates] = useState<BlockTemplate[]>([]);
  useEffect(() => {
    void listTemplates().then(setTemplates);
  }, []);
  const refreshTemplates = () => void listTemplates().then(setTemplates);

  /** テンプレートを、選んでいるボックスの中 (タスクなら隣) に挿入する */
  const insertTemplate = (tpl: BlockTemplate) => {
    const parentId = parentForNewBlock(project, selection, useProjectStore.getState().viewScope);
    apply((p) => {
      const r = instantiateTemplate(p, parentId, tpl, "human");
      setTimeout(() => { select({ blockId: r.blockId }); focusBlock(r.blockId); }, 0);
      return r.project;
    });
  };
  const importTemplateFile = async () => {
    const text = await pickTextFile(".json,application/json");
    if (!text) return;
    try {
      await saveTemplate(parseTemplate(text));
      refreshTemplates();
      setToast(t("テンプレートをライブラリに追加しました"));
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleStatus = (s: BlockStatus) => {
    const next = new Set(filter.statuses);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    if (next.size === 0) return; // 全部外すと何も見えなくなるので止める
    onFilter({ ...filter, statuses: next });
  };

  const addM = () => {
    if (!name.trim()) return;
    apply((p) => addMember(p, name.trim(), color).project);
    setName("");
    setColor(MEMBER_COLORS[(MEMBER_COLORS.indexOf(color) + 1) % MEMBER_COLORS.length]);
  };

  // ツリーとは独立した入口なので、引き出しを開いたときは絞り込みから使えるようにする。
  const [tab, setTab] = useState<"filter" | "members" | "parts">("filter");
  const tabs: { id: typeof tab; label: string; hint: string }[] = [
    { id: "filter", label: "Filter", hint: t("状態や担当でボックスを絞る") }
  , { id: "members", label: "Members", hint: t("担当にする人を登録。自分を決める") }
  , { id: "parts", label: "Parts", hint: t("他のプロジェクトでも使い回すボックス") }
  ];

  return (
    <div className="drawer card" style={{ width }}>
      <div className="flex items-center gap-1 mb-2">
        <div className="seg flex-1" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
          {tabs.map((x) => (
            <button key={x.id} className="seg__btn" data-on={tab === x.id} onClick={() => setTab(x.id)} title={x.hint} style={{ padding: "6px 2px", fontSize: 12 }}>{x.label}</button>
          ))}
        </div>
        <CloseButton onClick={onClose} title={t("閉じる")} />
      </div>
      <div className="text-[11px] mb-2" style={{ color: "var(--text-muted)" }}>{tabs.find((x) => x.id === tab)?.hint}</div>

      {tab === "filter" && (
      <div className="flex flex-wrap gap-1">
        {(["black", "gray", "white"] as BlockStatus[]).map((s) => (
          <button key={s} className="chip" data-on={filter.statuses.has(s)} onClick={() => toggleStatus(s)}>
            <span className={`tree-glyph ${s}`} style={{ width: 12, height: 12, fontSize: 8, lineHeight: "8px" }}>{GLYPH[s]}</span>
            {STATUS_LABEL[s]}
          </button>
        ))}
        {meId && (
          <button className="chip" data-on={filter.memberId === meId} onClick={() => onFilter({ ...filter, memberId: filter.memberId === meId ? null : meId, unassigned: false })} title={t("自分の担当だけ")}>Mine</button>
        )}
        <button className="chip" data-on={filter.unassigned} onClick={() => onFilter({ ...filter, unassigned: !filter.unassigned, memberId: null })} title={t("担当がいないボックスだけ")}>{t("未担当")}</button>
        {project.members.filter((m) => m.id !== meId).map((m) => (
          <button key={m.id} className="chip" data-on={filter.memberId === m.id} onClick={() => onFilter({ ...filter, memberId: filter.memberId === m.id ? null : m.id, unassigned: false })} title={t("{name} の担当だけ", { name: m.name })}>
            <span className="avatar" style={{ background: m.color, width: 16, height: 16, fontSize: 9 }}>{m.name.slice(0, 1)}</span>
            {m.name}
          </button>
        ))}
        <div className="label mt-3">Category</div>
        <div className="flex flex-wrap gap-1">
          {CATEGORIES.map((c) => (
            <button key={c.key} className={`chip cat-chip${c.neutral ? " neutral" : ""}`} data-on={filter.category === c.key} style={{ "--cat": c.color } as React.CSSProperties}
              onClick={() => onFilter({ ...filter, category: filter.category === c.key ? null : c.key })} title={t("{label} のボックスだけ", { label: t(c.label) })}>
              <span className="cat-chip__dot" />{t(c.label)}
            </button>
          ))}
        </div>
        {!isFilterEmpty(filter) && <button className="chip mt-3" onClick={() => onFilter({ ...EMPTY_FILTER, statuses: new Set(EMPTY_FILTER.statuses) })}>Clear</button>}
      </div>
      )}

      {tab === "parts" && (<>
      <div className="text-[11px] mb-1" style={{ color: "var(--text-muted)" }}>
        {/* 挿入先の表示: プロジェクトならその中、タスクならその隣、選んでいなければ最上位 */}
        {t("挿入先: {target}", { target: (() => { const pid = parentForNewBlock(project, selection, useProjectStore.getState().viewScope); const b = project.blocks[pid]; return b ? (kindOf(b) === "project" ? b.title : t("{title} の隣", { title: b.title })) : t("最上位"); })() })}
      </div>
      <div className="flex flex-col gap-1">
        {templates.length === 0 && <div className="text-[12px] px-1" style={{ color: "var(--text-muted)" }} title={t("ボックスを選び、右の「⋯」から「Save as Part」すると、ここに並びます。")}>{t("なし")}</div>}
        {templates.map((tpl) => (
          <div key={tpl.id} className="flex items-center gap-1 text-[13px] px-1">
            <span className="truncate" title={`${tpl.description || tpl.name} (v${tpl.version}${tpl.tags.length ? ", " + tpl.tags.join(", ") : ""})`}>{tpl.name}</span>
            <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>v{tpl.version}</span>
            <span className="ml-auto flex gap-0.5">
              {!readonly && <button className="btn btn-ghost btn-sm" title={t("挿入")} onClick={() => insertTemplate(tpl)}>Insert</button>}
              <button className="btn btn-ghost btn-sm" title={t("JSON で保存 (他のリポジトリや人と共有)")} onClick={() => downloadText(`${safeFilename(tpl.name)}.boxglow-block.json`, JSON.stringify(tpl, null, 2), "application/json")}>↓</button>
              <button className="btn btn-ghost btn-sm" title={t("ライブラリから消す")} onClick={() => { if (confirm(t("テンプレート「{name}」を消しますか?", { name: tpl.name }))) void deleteTemplate(tpl.id).then(refreshTemplates); }}>×</button>
            </span>
          </div>
        ))}
        <button className="btn btn-ghost btn-sm self-start" onClick={importTemplateFile}>Import</button>
      </div>
      </>)}

      {tab === "members" && (<>
      <div className="flex flex-col gap-1">
        {project.members.map((m) => (
          <div key={m.id} className="flex items-center gap-2 text-[13px] px-1">
            <span className="avatar" style={{ background: m.color }}>{m.name.slice(0, 1)}</span>
            <span className="truncate">{m.name}</span>
            <button className="chip ml-auto" data-on={meId === m.id} onClick={() => setMe(meId === m.id ? null : m.id)} title={t("このブラウザでは自分として扱う (自分の担当のボックスに帯が付く)")}>{meId === m.id ? "Me" : "Set as me"}</button>
            {!readonly && <button className="btn btn-ghost btn-sm" title={t("外す")} onClick={() => apply((p) => removeMember(p, m.id))}>×</button>}
          </div>
        ))}
      </div>
      {!readonly && (
        <div className="flex items-center gap-1 mt-2">
          <span className="avatar flex-none" style={{ background: color, cursor: "pointer" }} title={t("色を変える")} onClick={() => setColor(MEMBER_COLORS[(MEMBER_COLORS.indexOf(color) + 1) % MEMBER_COLORS.length])}>
            {name.slice(0, 1) || "+"}
          </span>
          <input className="input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addM()} />
          <button className="btn btn-sm" onClick={addM} disabled={!name.trim()}>Add</button>
        </div>
      )}
      </>)}
    </div>
  );
}

/**
 * 詳細パネルで使う小さな部品: 成果物の一覧、ポートの一覧
 * ポートの行は「名前」と、その直下に「成果物 (リンク)」を主役として並べる。形式・制約は 1 行の補足。
 */
import { useEffect, useRef, useState } from "react";
import { addPort, createArtifact, inputGroupsOf, isInputNameLocked, portsOf, removePort, rootInputsOf, setInputGroup, sourceOfInput, updatePort } from "../model/graph";
import type { Artifact, Project } from "../model/types";
import { ROOT_ID } from "../model/types";
import { useProjectStore } from "../store/useProjectStore";
// 言語切り替え: 日本語の文は t() で包み、英語の辞書 (src/i18n/en/parts.ts) で引く
import { t, useLang } from "../i18n";

/** 成果物 (URL / メモ) の一覧。「+ Add」を押したときだけ入力欄が出る */
export function ArtifactsEditor({ artifacts, onChange, readonly, addLabel = "Add" }: {
  artifacts: Artifact[];
  onChange: (next: Artifact[]) => void;
  readonly: boolean;
  addLabel?: string;
}) {
  useLang(); // 言語が変わったら描き直す
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const add = () => {
    if (!title.trim()) return;
    onChange([...artifacts, createArtifact(title.trim(), url.trim())]);
    setTitle("");
    setUrl("");
    setAdding(false);
  };
  return (
    <div className="flex flex-col gap-1">
      {artifacts.map((a) => (
        <div key={a.id} className="flex items-center gap-2 text-[13px]">
          {a.kind === "git" && <span className="chip" style={{ cursor: "default", fontSize: 10, padding: "0 5px" }} title={`Git: ${a.path ?? ""} @ ${(a.commit ?? "").slice(0, 7)}${a.repo ? " (" + a.repo + ")" : ""}`}>git</span>}
          {a.url ? (
            <a className="truncate underline" style={{ color: "var(--primary-strong)" }} href={a.url} target="_blank" rel="noopener noreferrer" title={a.kind === "git" ? `${a.path} @ ${(a.commit ?? "").slice(0, 7)}` : a.url}>{a.title}</a>
          ) : (
            <span className="truncate" title={a.kind === "git" ? `${a.path} @ ${(a.commit ?? "").slice(0, 7)}` : undefined}>{a.title}</span>
          )}
          {a.kind === "git" && a.state === "moved" && <span className="chip" style={{ cursor: "default", fontSize: 10, padding: "0 5px", borderColor: "var(--accent)" }} title={t("ファイルの移動を検出し、パスを付け替えました")}>moved</span>}
          {a.kind === "git" && a.state === "missing" && <span className="chip" style={{ cursor: "default", fontSize: 10, padding: "0 5px", borderColor: "var(--danger)", color: "var(--danger)" }} title={t("現在のリポジトリに見つかりません (コミットからは取り出せます)")}>missing</span>}
          {!readonly && <button className="btn btn-ghost btn-sm ml-auto" title="Remove" onClick={() => onChange(artifacts.filter((x) => x.id !== a.id))}>×</button>}
        </div>
      ))}
      {!readonly && !adding && (
        <button className="btn btn-ghost btn-sm self-start" onClick={() => setAdding(true)}>+ {addLabel}</button>
      )}
      {!readonly && adding && (
        <div className="flex flex-col gap-1">
          <input className="input" autoFocus placeholder={t("名前 (例: 設計書 v1, PR #12)")} value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); if (e.key === "Escape") setAdding(false); }} />
          <input className="input" placeholder={t("URL (任意)")} value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); if (e.key === "Escape") setAdding(false); }} />
          <div className="flex gap-1">
            <button className="btn btn-primary btn-sm" onClick={add} disabled={!title.trim()}>Add</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * ブロックの入力 (または出力) ポートの一覧
 * 行: 名前 → その下に成果物 (リンク) の一覧と「+ Add」。「▾」で形式・制約 (1 行) と必須の設定
 */
export function PortsEditor({ project, blockId, direction, readonly, title, allowAdd = true, groupId }: {
  project: Project;
  blockId: string;
  direction: "in" | "out";
  readonly: boolean;
  title: string;
  /** 追加ボタンを出すか (最上位の入力は自動で上がってくるものだけなので出さない) */
  allowAdd?: boolean;
  /** 最上位の入力をグループで絞る (undefined = 絞らない, null = 既定の入力ノード) */
  groupId?: string | null;
}) {
  useLang(); // 言語が変わったら描き直す
  const apply = useProjectStore((s) => s.apply);
  const ports = blockId === ROOT_ID && direction === "in" && groupId !== undefined ? rootInputsOf(project, groupId) : portsOf(project, blockId, direction);
  const groups = blockId === ROOT_ID && direction === "in" ? inputGroupsOf(project) : [];
  const [open, setOpen] = useState<string | null>(null);
  const canRemove = (promoted: boolean) => !readonly && !promoted && (direction === "in" || ports.length > 1);

  return (
    <section className="sec">
      <div className="sec__head">
        <span className="label"><span className={`io-mark ${direction}`} aria-hidden="true">{direction === "in" ? "→" : "→"}</span>{title}</span>
        {!readonly && allowAdd && (
          <button className="btn btn-sm" title={direction === "in" ? t("入力を追加") : t("出力を追加")}
            onClick={() => apply((p) => { const r = addPort(p, { blockId, direction, name: direction === "in" ? t("新しい入力") : t("新しい出力") }); return groupId ? setInputGroup(r.project, r.portId, groupId) : r.project; })}>＋ {direction === "in" ? t("入力を追加") : t("出力を追加")}</button>
        )}
      </div>
      {ports.length === 0 && <div className="text-[12px] px-1" style={{ color: "var(--text-muted)" }}>None</div>}
      {ports.map((q) => {
        const src = direction === "in" ? sourceOfInput(project, q.id) : null;
        const srcOwner = src ? (src.blockId === ROOT_ID ? "Project Inputs" : project.blocks[src.blockId]?.title ?? "?") : null;
        const desc = src ? src.description : q.description;
        return (
          <div key={q.id} className="port-card">
            <div className="flex items-center gap-1">
              {direction === "in" && isInputNameLocked(project, q.id) ? (
                // 供給元のある入力: 名前は供給元の出力名で決まる (ここでは変えられない。変えるなら供給元の出力で)
                <span className="input input-plain font-bold truncate" style={{ cursor: "default" }} title={t("入力の名前は供給元 ({owner}) の出力名です。変えるなら供給元の出力で", { owner: srcOwner ?? "?" })}>{q.name}</span>
              ) : (
                <DebouncedText className="input input-plain font-bold" value={q.name} disabled={readonly} title={q.promotedFrom ? t("下の階層の未接続の入力 (自動)。元の入力をつなぐと消えます") : direction === "in" ? t("まだ供給元の無い入力。つなぐと供給元の出力名になります") : undefined}
                  style={q.promotedFrom ? { fontStyle: "italic", opacity: 0.75 } : undefined}
                  onCommit={(v) => apply((p) => updatePort(p, q.id, { name: v }))} />
              )}
              {direction === "in" && !q.promotedFrom && !q.required && <span className="meta-chip muted" title={t("任意: 無くても着手できます")}>{t("任意")}</span>}
              {groups.length > 0 && !readonly && (
                <select className="input input-plain" style={{ width: 110, fontSize: 11 }} value={q.groupId ?? ""} title={t("入力グループ")} onChange={(e) => apply((p) => setInputGroup(p, q.id, e.target.value || null))}>
                  <option value="">Inputs</option>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              )}
              <button className="btn btn-ghost btn-sm" onClick={() => setOpen(open === q.id ? null : q.id)} title={t("形式・制約などの設定")}>{open === q.id ? "▴" : "▾"}</button>
              {canRemove(!!q.promotedFrom) && <button className="btn btn-ghost btn-sm" title="Remove" onClick={() => apply((p) => removePort(p, q.id))}>×</button>}
            </div>
            {/* 成果物 (主役): 名前の直下に並べる */}
            <div className="pl-1 pb-1">
              {src ? (
                <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                  {t("from {owner}「{name}」", { owner: srcOwner ?? "?", name: src.name })}{src.artifacts.length > 0 ? ` (${src.artifacts.map((a) => a.title).join(", ")})` : ""}
                </div>
              ) : (
                <>
                  <div className="text-[11px] mt-1" style={{ color: "var(--text-muted)" }}>{direction === "in" ? t("入力物 (この入力の実体)") : t("成果物 (この出力の実体)")}</div>
                  <ArtifactsEditor artifacts={q.artifacts} readonly={readonly} addLabel={direction === "in" ? t("入力物を追加") : t("成果物を追加")}
                    onChange={(next) => apply((p) => updatePort(p, q.id, { artifacts: next }))} />
                </>
              )}
              {desc && open !== q.id && <div className="text-[11px] mt-1" style={{ color: "var(--text-muted)" }}>{desc}</div>}
            </div>
            {open === q.id && (
              <div className="flex flex-col gap-1 pl-2 pb-2">
                {src ? (
                  <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>{t("形式・制約は供給元「{name}」の出力で書きます", { name: src.name })}{src.description ? `: ${src.description}` : ""}</div>
                ) : (
                  <DebouncedText className="input" placeholder={t("形式・制約 (任意。例: Markdown、PNG 1920x1080、API は OpenAPI 3)")} value={q.description} disabled={readonly}
                    onCommit={(v) => apply((p) => updatePort(p, q.id, { description: v }))} />
                )}
                {direction === "in" && !q.promotedFrom && (
                  <div className="flex items-center gap-2 text-[12px]">
                    {/* 必須 / 任意: 必須の入力がそろうと箱に Ready が出る。任意は無くても着手できる */}
                    <div className="seg" style={{ width: "auto" }}>
                      <button className="seg__btn" data-on={q.required} disabled={readonly} onClick={() => apply((p) => updatePort(p, q.id, { required: true }))} title={t("必須: この入力がそろうまで着手できない (箱の Ready に効く)")}>{t("必須")}</button>
                      <button className="seg__btn" data-on={!q.required} disabled={readonly} onClick={() => apply((p) => updatePort(p, q.id, { required: false }))} title={t("任意: 無くても着手できる")}>{t("任意")}</button>
                    </div>
                    <span style={{ color: "var(--text-muted)" }}>{q.required ? t("そろうまで着手できない") : t("無くても着手できる")}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

/**
 * 日付の入力欄: 欄を押すか横の暦ボタンを押すと、ブラウザのカレンダー (showPicker) が開く
 * Input : value = "YYYY-MM-DD" または "", onChange(値), disabled, danger (期日超過なら赤)
 * Output: 選んだ日付を onChange で返す ("" は消去)
 */
/**
 * パネルの境界のつまみ。ドラッグで幅を変える
 * Input : side = つまみを置く辺 (left = パネルの左辺 / right = 右辺), width = 今の幅, min/max = 幅の範囲,
 *         onWidth = 新しい幅を受け取る関数 (ドラッグ中に何度も呼ばれる)
 * Output: 幅 10px の透明な縦の帯 (ホバー / ドラッグ中は線が出る)
 */
export function ResizeHandle({ side, width, min, max, onWidth, style }: { side: "left" | "right"; width: number; min: number; max: number; onWidth: (w: number) => void; style?: React.CSSProperties }) {
  useLang(); // 言語が変わったら描き直す
  const [active, setActive] = useState(false);
  const onPointerDown = (ev: React.PointerEvent<HTMLDivElement>) => {
    ev.preventDefault();
    const startX = ev.clientX;
    const startW = width;
    const el = ev.currentTarget;
    el.setPointerCapture(ev.pointerId);
    setActive(true);
    const move = (e: PointerEvent) => {
      // 左辺のつまみは左へ引くほど広がる、右辺のつまみは右へ引くほど広がる
      const dx = e.clientX - startX;
      const w = side === "left" ? startW - dx : startW + dx;
      onWidth(Math.round(Math.max(min, Math.min(max, w))));
    };
    const up = () => {
      setActive(false);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  return <div className={`resize-handle ${side}`} data-active={active} style={style} onPointerDown={onPointerDown} title={t("ドラッグで幅を変える")} />;
}

/**
 * 文字の入力欄: 打っている間は手元の値だけを変え、手を止めてから (またはフォーカスを外したとき / Enter で) 反映する。
 * 1 文字ごとに計画を更新すると図全体 (経路や重なりの解消) を作り直して重くなるため
 * Input : value = 今の値, onCommit = 反映する関数, multiline = textarea にするか, delay = 待ち時間 (ms)。ほかは input/textarea にそのまま渡す
 * Output: input または textarea
 */
export function DebouncedText({ value, onCommit, multiline = false, delay = 400, onKeyDown, ...rest }: {
  value: string;
  onCommit: (v: string) => void;
  multiline?: boolean;
  delay?: number;
} & Omit<React.InputHTMLAttributes<HTMLInputElement> & React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(value);
  latest.current = value;
  // 外から値が変わったとき (別の箱を選んだ、AI が書き換えた) は、打っている最中でなければ追従する
  useEffect(() => { if (!focused.current) setText(value); }, [value]);
  const commit = (v: string) => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } if (v !== latest.current) onCommit(v); };
  const change = (v: string) => {
    setText(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; if (v !== latest.current) onCommit(v); }, delay);
  };
  const common = {
    value: text
  , onFocus: () => { focused.current = true; }
  , onBlur: () => { focused.current = false; commit(text); }
  , onKeyDown: (e: React.KeyboardEvent<HTMLInputElement & HTMLTextAreaElement>) => {
      if (!multiline && (e.key === "Enter" || e.key === "Escape")) { commit(text); (e.target as HTMLElement).blur(); }
      onKeyDown?.(e);
    }
  };
  if (multiline) return <textarea {...(rest as React.TextareaHTMLAttributes<HTMLTextAreaElement>)} {...common} onChange={(e) => change(e.target.value)} />;
  return <input {...(rest as React.InputHTMLAttributes<HTMLInputElement>)} {...common} onChange={(e) => change(e.target.value)} />;
}

export function DateField({ value, onChange, disabled, danger }: { value: string; onChange: (v: string) => void; disabled?: boolean; danger?: boolean }) {
  useLang(); // 言語が変わったら描き直す
  const ref = useRef<HTMLInputElement>(null);
  // showPicker は Chrome / Edge / Firefox 101+ にある。無いブラウザでは欄にフォーカスするだけ
  const open = () => {
    const el = ref.current;
    if (!el || disabled) return;
    try {
      (el as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
    } catch {
      el.focus();
    }
  };
  return (
    <span className="date-field">
      <input ref={ref} type="date" className="input input-plain" value={value} disabled={disabled}
        style={danger ? { color: "var(--danger)" } : undefined}
        onClick={open}
        onChange={(e) => onChange(e.target.value)} />
      <button type="button" className="date-field__btn" disabled={disabled} onClick={open} title={t("カレンダーから選ぶ")} aria-label={t("カレンダーから選ぶ")}>
        {/* 暦のアイコン (SVG): 上に綴じ輪、下にマス目 */}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <rect x="2" y="3.5" width="12" height="10.5" rx="2" />
          <path d="M2 7h12M5.5 2v3M10.5 2v3" />
        </svg>
      </button>
    </span>
  );
}

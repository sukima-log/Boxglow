/**
 * 詳細パネルで使う小さな部品: 成果物の一覧、ポートの一覧
 * ポートの行は「名前」と、その直下に「成果物 (リンク)」を主役として並べる。形式・制約は 1 行の補足。
 */
import { useRef, useState } from "react";
import { addPort, createArtifact, inputGroupsOf, portsOf, removePort, rootInputsOf, setInputGroup, sourceOfInput, updatePort } from "../model/graph";
import type { Artifact, Project } from "../model/types";
import { ROOT_ID } from "../model/types";
import { useProjectStore } from "../store/useProjectStore";

/** 成果物 (URL / メモ) の一覧。「+ Add」を押したときだけ入力欄が出る */
export function ArtifactsEditor({ artifacts, onChange, readonly, addLabel = "Add" }: {
  artifacts: Artifact[];
  onChange: (next: Artifact[]) => void;
  readonly: boolean;
  addLabel?: string;
}) {
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
          {a.kind === "git" && a.state === "moved" && <span className="chip" style={{ cursor: "default", fontSize: 10, padding: "0 5px", borderColor: "var(--accent)" }} title="ファイルの移動を検出し、パスを付け替えました">moved</span>}
          {a.kind === "git" && a.state === "missing" && <span className="chip" style={{ cursor: "default", fontSize: 10, padding: "0 5px", borderColor: "var(--danger)", color: "var(--danger)" }} title="現在のリポジトリに見つかりません (コミットからは取り出せます)">missing</span>}
          {!readonly && <button className="btn btn-ghost btn-sm ml-auto" title="Remove" onClick={() => onChange(artifacts.filter((x) => x.id !== a.id))}>×</button>}
        </div>
      ))}
      {!readonly && !adding && (
        <button className="btn btn-ghost btn-sm self-start" onClick={() => setAdding(true)}>+ {addLabel}</button>
      )}
      {!readonly && adding && (
        <div className="flex flex-col gap-1">
          <input className="input" autoFocus placeholder="名前 (例: 設計書 v1, PR #12)" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); if (e.key === "Escape") setAdding(false); }} />
          <input className="input" placeholder="URL (任意)" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); if (e.key === "Escape") setAdding(false); }} />
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
          <button className="btn btn-sm" title={direction === "in" ? "入力を追加" : "出力を追加"}
            onClick={() => apply((p) => { const r = addPort(p, { blockId, direction, name: direction === "in" ? "新しい入力" : "新しい出力" }); return groupId ? setInputGroup(r.project, r.portId, groupId) : r.project; })}>＋ {direction === "in" ? "入力を追加" : "出力を追加"}</button>
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
              <input className="input input-plain font-bold" value={q.name} disabled={readonly} title={q.promotedFrom ? "下の階層の未接続の入力 (自動)。元の入力をつなぐと消えます" : undefined}
                style={q.promotedFrom ? { fontStyle: "italic", opacity: 0.75 } : undefined}
                onChange={(e) => apply((p) => updatePort(p, q.id, { name: e.target.value }))} />
              {direction === "in" && !q.promotedFrom && !q.required && <span className="meta-chip muted" title="任意: 無くても着手できます">任意</span>}
              {groups.length > 0 && !readonly && (
                <select className="input input-plain" style={{ width: 110, fontSize: 11 }} value={q.groupId ?? ""} title="入力グループ" onChange={(e) => apply((p) => setInputGroup(p, q.id, e.target.value || null))}>
                  <option value="">Inputs</option>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              )}
              <button className="btn btn-ghost btn-sm" onClick={() => setOpen(open === q.id ? null : q.id)} title="形式・制約などの設定">{open === q.id ? "▴" : "▾"}</button>
              {canRemove(!!q.promotedFrom) && <button className="btn btn-ghost btn-sm" title="Remove" onClick={() => apply((p) => removePort(p, q.id))}>×</button>}
            </div>
            {/* 成果物 (主役): 名前の直下に並べる */}
            <div className="pl-1 pb-1">
              {src ? (
                <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                  from {srcOwner}「{src.name}」{src.artifacts.length > 0 ? ` (${src.artifacts.map((a) => a.title).join(", ")})` : ""}
                </div>
              ) : (
                <>
                  <div className="text-[11px] mt-1" style={{ color: "var(--text-muted)" }}>{direction === "in" ? "入力物 (この入力の実体)" : "成果物 (この出力の実体)"}</div>
                  <ArtifactsEditor artifacts={q.artifacts} readonly={readonly} addLabel={direction === "in" ? "入力物を追加" : "成果物を追加"}
                    onChange={(next) => apply((p) => updatePort(p, q.id, { artifacts: next }))} />
                </>
              )}
              {desc && open !== q.id && <div className="text-[11px] mt-1" style={{ color: "var(--text-muted)" }}>{desc}</div>}
            </div>
            {open === q.id && (
              <div className="flex flex-col gap-1 pl-2 pb-2">
                {src ? (
                  <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>形式・制約は供給元「{src.name}」の出力で書きます{src.description ? `: ${src.description}` : ""}</div>
                ) : (
                  <input className="input" placeholder="形式・制約 (任意。例: Markdown、PNG 1920x1080、API は OpenAPI 3)" value={q.description} disabled={readonly}
                    onChange={(e) => apply((p) => updatePort(p, q.id, { description: e.target.value }))} />
                )}
                {direction === "in" && !q.promotedFrom && (
                  <div className="flex items-center gap-2 text-[12px]">
                    {/* 必須 / 任意: 必須の入力がそろうと箱に Ready が出る。任意は無くても着手できる */}
                    <div className="seg" style={{ width: "auto" }}>
                      <button className="seg__btn" data-on={q.required} disabled={readonly} onClick={() => apply((p) => updatePort(p, q.id, { required: true }))} title="必須: この入力がそろうまで着手できない (箱の Ready に効く)">必須</button>
                      <button className="seg__btn" data-on={!q.required} disabled={readonly} onClick={() => apply((p) => updatePort(p, q.id, { required: false }))} title="任意: 無くても着手できる">任意</button>
                    </div>
                    <span style={{ color: "var(--text-muted)" }}>{q.required ? "そろうまで着手できない" : "無くても着手できる"}</span>
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
  return <div className={`resize-handle ${side}`} data-active={active} style={style} onPointerDown={onPointerDown} title="ドラッグで幅を変える" />;
}

export function DateField({ value, onChange, disabled, danger }: { value: string; onChange: (v: string) => void; disabled?: boolean; danger?: boolean }) {
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
      <button type="button" className="date-field__btn" disabled={disabled} onClick={open} title="カレンダーから選ぶ" aria-label="カレンダーから選ぶ">
        {/* 暦のアイコン (SVG): 上に綴じ輪、下にマス目 */}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <rect x="2" y="3.5" width="12" height="10.5" rx="2" />
          <path d="M2 7h12M5.5 2v3M10.5 2v3" />
        </svg>
      </button>
    </span>
  );
}

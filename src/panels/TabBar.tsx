/**
 * キャンバスのタブ (図の下の辺)。表計算のシート選択と同じ操作感:
 *   [一覧] [◀] [▶]  Top | 大項目1 | 大項目2 | ...   (帯はスクロールバーを出さず、◀ ▶ で左右に送る)
 * 「一覧」を押すと全部のタブが縦に並んだポップアップが出て、押せばそのタブへ飛ぶ
 * Input : project (表示用), majors = 大項目のボックス, scope = 開いているタブ (null = Top), onSelect = タブを選んだときに呼ぶ
 * Output: タブの帯 (role=tablist)
 */
import { useEffect, useRef, useState } from "react";
import { computeProgress } from "../model/graph";
import type { Block, Project } from "../model/types";
import { StatusIcon } from "../canvas/BlockNode";
import { t, useLang } from "../i18n";

/** ◀ ▶ で 1 回に送る幅 (px) */
const STEP = 240;

export function TabBar({ project, majors, scope, onSelect, marked }: { project: Project; majors: Block[]; scope: string | null; onSelect: (id: string | null) => void; marked?: Set<string | null> }) {
  useLang(); // 言語が変わったら描き直す
  const strip = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  const [listOpen, setListOpen] = useState(false);

  // 帯の端まで来たら ◀ ▶ を薄くする
  const updateArrows = () => {
    const el = strip.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 1);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };
  useEffect(() => {
    updateArrows();
    const el = strip.current;
    if (!el) return;
    const ro = new ResizeObserver(updateArrows);
    ro.observe(el);
    return () => ro.disconnect();
  }, [majors.length]);

  // 選んだタブが見えるように帯を送る
  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>('.canvas-tab[data-on="true"]');
    el?.scrollIntoView({ inline: "nearest", block: "nearest" });
    setTimeout(updateArrows, 0);
  }, [scope]);

  // ポップアップは外を押すか Esc で閉じる
  useEffect(() => {
    if (!listOpen) return;
    const close = (ev: MouseEvent) => { if (!(ev.target as HTMLElement).closest?.(".tab-list, .tab-list-btn")) setListOpen(false); };
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") setListOpen(false); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", key); };
  }, [listOpen]);

  const scrollBy = (dx: number) => strip.current?.scrollBy({ left: dx, behavior: "smooth" });
  const pick = (id: string | null) => { onSelect(id); setListOpen(false); };

  return (
    <div className="canvas-tabs" role="tablist">
      <div className="tab-nav">
        <button className="tab-nav-btn tab-list-btn" data-on={listOpen} onClick={() => setListOpen((v) => !v)} title={t("タブの一覧 (押して選ぶ)")}>≡</button>
        <button className="tab-nav-btn" disabled={!canLeft} onClick={() => scrollBy(-STEP)} title={t("左へ")}>◀</button>
        <button className="tab-nav-btn" disabled={!canRight} onClick={() => scrollBy(STEP)} title={t("右へ")}>▶</button>
      </div>
      <div className="tab-strip" ref={strip} onScroll={updateArrows}>
        <button className="canvas-tab" role="tab" data-on={scope === null} data-marked={marked?.has(null) || undefined} onClick={() => pick(null)} title={t("大項目の一覧を俯瞰する (中はそれぞれのタブで)")}>Top</button>
        {majors.map((b) => (
          <button key={b.id} className="canvas-tab" role="tab" data-on={scope === b.id} data-marked={marked?.has(b.id) || undefined} onClick={() => pick(b.id)} title={marked?.has(b.id) ? t("{title} (選んだ線の続きがある)", { title: b.title }) : t("{title} の中を見る", { title: b.title })}>
            <StatusIcon status={b.status} />
            <span className="truncate">{b.title}</span>
          </button>
        ))}
      </div>
      {listOpen && (
        <div className="tab-list card" role="menu">
          <button className="tab-list-row" data-on={scope === null} onClick={() => pick(null)}>
            <span className="tab-list-icon">⊞</span>
            <span className="truncate">Top</span>
          </button>
          {majors.map((b) => {
            const prog = computeProgress(project, b.id);
            return (
              <button key={b.id} className="tab-list-row" data-on={scope === b.id} onClick={() => pick(b.id)} title={b.title}>
                <StatusIcon status={b.status} />
                <span className="truncate">{b.title}</span>
                <span className="tab-list-prog">{prog.total > 0 ? `${prog.percent}%` : ""}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

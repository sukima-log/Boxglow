/**
 * 差し戻し (右パネルの状態タブ)
 *   - 「差し戻す」: 入力の供給元の箱から戻す先を選び、理由を書く。その箱は In Progress に戻り、成果物は差し戻し済みに (線では戻さない: 循環になる)
 *   - 記録: この箱が戻した記録と、この箱が戻された記録 (理由つき)
 */
import { useState } from "react";
import { sendBack, sendBackTargets, sentBackTo } from "../model/graph";
import type { Project } from "../model/types";
import { agoText } from "../model/report";
import { useProjectStore } from "../store/useProjectStore";
import { t, useLang } from "../i18n";

/**
 * Input : project, blockId
 * Output: 差し戻しのボタン・記入欄・記録 (候補も記録も無ければ null)
 */
export function SendBackPanel({ project, blockId }: { project: Project; blockId: string }) {
  useLang();
  const readonly = useProjectStore((s) => s.readonly);
  const apply = useProjectStore((s) => s.apply);
  const setToast = useProjectStore((s) => s.setToast);
  const select = useProjectStore((s) => s.select);
  const [form, setForm] = useState<{ to: string; note: string } | null>(null);
  const targets = sendBackTargets(project, blockId);
  const sent = project.blocks[blockId]?.sendbacks ?? [];
  const received = sentBackTo(project, blockId);
  if (targets.length === 0 && sent.length === 0 && received.length === 0) return null;
  const submit = () => {
    if (!form || !form.to || !form.note.trim()) return;
    const to = form.to;
    const note = form.note.trim();
    setForm(null);
    apply((p) => { const r = sendBack(p, blockId, to, "human", note); if (r.error) setToast(r.error); else setToast(t("「{title}」に差し戻しました (In Progress に戻りました)", { title: p.blocks[to]?.title ?? "" })); return r.project; });
  };
  return (
    <section className="sendback">
      <div className="flex items-center gap-2">
        <span className="label">{t("差し戻し")}</span>
        {!readonly && targets.length > 0 && form === null && (
          <button className="btn btn-sm" onClick={() => setForm({ to: targets[0].id, note: "" })} title={t("評価・検査が通らなかったとき、成果物を作った箱へ戻す (その箱は In Progress に戻り、成果物は差し戻し済みになる。線では戻さない)")}>{t("差し戻す")}</button>
        )}
      </div>
      {form && (
        <div className="sendback__form">
          <select className="input" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} aria-label={t("戻す先")}>
            {targets.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
          </select>
          <textarea className="input" rows={2} autoFocus placeholder={t("理由 (作り直す人が読む。例: テストが 2 件落ちる)")} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(); if (e.key === "Escape") setForm(null); }} />
          <div className="flex gap-1 justify-end">
            <button className="btn btn-ghost btn-sm" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn btn-primary btn-sm" disabled={!form.note.trim()} onClick={submit}>{t("差し戻す")}</button>
          </div>
        </div>
      )}
      {(received.length > 0 || sent.length > 0) && (
        <ul className="sendback__list">
          {received.map((x) => (
            <li key={x.record.id} className="sendback__item">
              <button type="button" className="port-consumers__item" onClick={() => select({ blockId: x.from.id })} title={t("評価した箱へ")}>← {x.from.title}</button>
              <span className="sendback__note">{x.record.note}</span>
              <span className="sendback__meta">{x.record.by} · {agoText(x.record.at)}</span>
            </li>
          ))}
          {sent.map((r) => (
            <li key={r.id} className="sendback__item">
              <button type="button" className="port-consumers__item" onClick={() => select({ blockId: r.to })} title={t("戻した箱へ")}>→ {project.blocks[r.to]?.title ?? "?"}</button>
              <span className="sendback__note">{r.note}</span>
              <span className="sendback__meta">{r.by} · {agoText(r.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

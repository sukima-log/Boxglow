/**
 * 差し戻しの記録 (右パネルの I/O タブ。入力・出力の下)
 *   - 操作は各入力カードの「↩ 差し戻す」(parts.tsx)。ここは記録だけ: この箱が戻した記録と、この箱が戻された記録 (理由つき)
 */
import { LinkifiedText } from "./LinkifiedText";
import { sentBackTo } from "../model/graph";
import type { Project } from "../model/types";
import { agoText } from "../model/report";
import { useProjectStore } from "../store/useProjectStore";
import { t, useLang } from "../i18n";

/**
 * Input : project, blockId, show = 出す記録の種類
 * Output: 記録の一覧 (戻された記録は「← 評価した箱: 理由」、戻した記録は「→ 戻した箱: 理由」)。記録が無ければ null
 */
export function SendBackPanel({ project, blockId, show = "both" }: { project: Project; blockId: string; show?: "received" | "sent" | "both" }) {
  useLang();
  const select = useProjectStore((s) => s.select);
  // show: received = 戻された記録だけ (Outputs の上に出す)、sent = 戻した記録だけ (I/O タブの下)、both = 両方
  const sent = show === "received" ? [] : project.blocks[blockId]?.sendbacks ?? [];
  const received = show === "sent" ? [] : sentBackTo(project, blockId);
  if (sent.length === 0 && received.length === 0) return null;
  return (
    <section className={`sendback${received.length > 0 ? " sendback--received" : ""}`}>
      {/* 戻された箱では見出しを「差し戻されています」にして、作り直しの理由が先に目に入るようにする */}
      <span className="label">{received.length > 0 ? t("差し戻されています") : t("差し戻し")}</span>
      <ul className="sendback__list">
        {received.map((x) => (
          <li key={x.record.id} className="sendback__item">
            <button type="button" className="port-consumers__item" onClick={() => select({ blockId: x.from.id })} title={t("評価した箱へ")}>← {x.from.title}</button>
            <span className="sendback__note"><LinkifiedText text={x.record.note} /></span>
            <span className="sendback__meta">{x.record.by} · {agoText(x.record.at)}</span>
          </li>
        ))}
        {sent.map((r) => (
          <li key={r.id} className="sendback__item">
            <button type="button" className="port-consumers__item" onClick={() => select({ blockId: r.to })} title={t("戻した箱へ")}>→ {project.blocks[r.to]?.title ?? "?"}</button>
            <span className="sendback__note"><LinkifiedText text={r.note} /></span>
            <span className="sendback__meta">{r.by} · {agoText(r.at)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

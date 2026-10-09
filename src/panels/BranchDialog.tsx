/**
 * 分岐を足すダイアログ (⋯ メニューの「+ Branch」から開く)
 * ロードマップの時点で決まっていない分かれ道を、問いと選択肢で作る。選択肢ごとに出力 (道) ができ、
 * 判断に答えると、選んだ道へ進み、選ばなかった道の先は「見送り」になる
 */
import { useState } from "react";
import { addBranch } from "../model/branch";
import { parentForNewBlock, useProjectStore } from "../store/useProjectStore";
import { t, useLang } from "../i18n";
import { CloseButton } from "./CloseButton";

/**
 * 分岐を足すダイアログ
 * Input : onClose = 閉じる処理 / Output: ダイアログの JSX (作ると、作ったボックスを選んで閉じる)
 */
export function BranchDialog({ onClose }: { onClose: () => void }) {
  useLang(); // 言語が変わったら描き直す
  const apply = useProjectStore((s) => s.apply);
  const select = useProjectStore((s) => s.select);
  const focusBlock = useProjectStore((s) => s.focusBlock);
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState("");
  const [title, setTitle] = useState("");
  // 選択肢は 1 行に 1 つ (空行と重複は除く)
  const list = [...new Set(options.split(/\r?\n/).map((x) => x.trim()).filter(Boolean))];
  const ok = question.trim().length > 0 && list.length >= 2;

  // 作る: 今見ている階層 (選んでいるボックスがあればその中) に置き、作ったボックスを選ぶ
  const create = () => {
    if (!ok) return;
    const { project, selection, viewScope } = useProjectStore.getState();
    if (!project) return;
    const parentId = parentForNewBlock(project, selection, viewScope);
    apply((p) => {
      const r = addBranch(p, { parentId, title: title.trim() || question.trim(), question: question.trim(), options: list, actor: "human" });
      const q = structuredClone(r.project);
      if (q.blocks[parentId]) q.blocks[parentId].collapsed = false;
      setTimeout(() => { select({ blockId: r.blockId }); focusBlock(r.blockId); }, 0);
      return q;
    });
    onClose();
  };

  return (
    // 背景を押して閉じるのは、何も入力していないときだけ (入力途中の内容を、確かめずに捨てないため)
    <div className="modal-backdrop" onClick={() => { if (!question.trim() && !options.trim() && !title.trim()) onClose(); }}>
      <div className="card modal branch-dialog" role="dialog" aria-label={t("分岐を足す")} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
        <div className="flex items-center gap-2">
          <h2 className="flex-1"><span aria-hidden="true">◇</span> {t("分岐を足す")}</h2>
          <CloseButton onClick={onClose} title={t("閉じる")} />
        </div>
        <p className="muted">{t("まだ決まっていない分かれ道を、問いと選択肢で表します。選択肢ごとに道 (出力) ができ、答えると選ばなかった道は「見送り」になります。")}</p>
        <label className="branch-dialog__field">{t("問い")}
          <input className="input" autoFocus value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={t("例: API の方式はどれにしますか?")} />
        </label>
        <label className="branch-dialog__field">{t("選択肢 (1 行に 1 つ、2 つ以上)")}
          <textarea className="input" rows={3} value={options} onChange={(e) => setOptions(e.target.value)} placeholder={"REST\nGraphQL"} />
        </label>
        <label className="branch-dialog__field">{t("題名 (省略すると問いと同じ)")}
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("例: API の方式を決める")} />
        </label>
        <div className="flex justify-end gap-2">
          <button className="btn btn-sm" onClick={onClose}>{t("キャンセル")}</button>
          <button className="btn btn-primary btn-sm" disabled={!ok} onClick={create}>{t("分岐を足す")}</button>
        </div>
      </div>
    </div>
  );
}

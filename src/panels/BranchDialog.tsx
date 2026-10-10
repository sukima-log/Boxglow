/**
 * 分岐を足すダイアログ (上の ⋯ メニューの「+ Branch」) と、今あるボックスを分岐に変えるダイアログ (詳細パネルの ⋯ メニューの「分岐にする」)
 * ロードマップの時点で決まっていない分かれ道を、問いと選択肢で作る。選択肢ごとに出力 (道) ができ、
 * 判断に答えると、選んだ道へ進み、選ばなかった道の先は「見送り」になる
 */
import { useState } from "react";
import { addBranch, convertToBranch } from "../model/branch";
import { parentForNewBlock, useProjectStore } from "../store/useProjectStore";
import { t, useLang } from "../i18n";
import { CloseButton } from "./CloseButton";

/**
 * 分岐を足す / 分岐に変えるダイアログ
 * Input : onClose = 閉じる処理, convertBlockId = 分岐に変えるボックス (省略時は新しく足す)
 * Output: ダイアログの JSX (作ると、そのボックスを選んで閉じる)。変えるときは題名の欄を出さない (今の題名のまま)
 */
export function BranchDialog({ onClose, convertBlockId }: { onClose: () => void; convertBlockId?: string }) {
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
  // 見出しとボタンの文言: 新しく足すか、今のボックスを変えるか
  const heading = convertBlockId ? t("分岐にする") : t("分岐を足す");

  // 作る: 今見ている階層 (選んでいるボックスがあればその中) に置き、作ったボックスを選ぶ
  const create = () => {
    if (!ok) return;
    const { project, selection, viewScope } = useProjectStore.getState();
    if (!project) return;
    // 今あるボックスを分岐に変える: 今の出力が 1 つ目の選択肢の道になる
    if (convertBlockId) {
      apply((p) => convertToBranch(p, convertBlockId, { question: question.trim(), options: list, actor: "human" }).project);
      setTimeout(() => select({ blockId: convertBlockId }), 0);
      onClose();
      return;
    }
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
      <div className="card modal branch-dialog" role="dialog" aria-label={heading} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
        <div className="flex items-center gap-2">
          <h2 className="flex-1"><span aria-hidden="true">◇</span> {heading}</h2>
          <CloseButton onClick={onClose} title={t("閉じる")} />
        </div>
        <label className="branch-dialog__field">{t("問い")}
          <input className="input" autoFocus value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={t("例: API の方式はどれにしますか?")} />
        </label>
        <label className="branch-dialog__field">{t("選択肢")}
          <textarea className="input" rows={3} value={options} onChange={(e) => setOptions(e.target.value)} placeholder={"REST\nGraphQL"} />
        </label>
        {!convertBlockId && <label className="branch-dialog__field">{t("題名 (任意)")}
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("例: API の方式を決める")} />
        </label>}
        <div className="flex justify-end gap-2">
          <button className="btn btn-sm" onClick={onClose}>{t("キャンセル")}</button>
          <button className="btn btn-primary btn-sm" disabled={!ok} onClick={create}>{heading}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * 自由に書く欄の文 (入出力の説明・検査結果・判断の文脈・作業のメモ・差し戻しの理由) を、URL と手元のファイルのパスだけ押せるようにして描く。
 * パスは成果物と同じ開き方 (VS Code = エディタ、serve = 新しいタブ、ブラウザ = パスをコピー)。URL は新しいタブ (利用者の要望 2026-10-31)
 * Input : text = 描く文 / Output: 文字とリンクの並び (改行などの見た目は呼び出し側の CSS のまま)
 */
import { splitLinks } from "../lib/localLink";
import { useProjectStore } from "../store/useProjectStore";
import { t } from "../i18n";

export function LinkifiedText({ text }: { text: string }) {
  const openAttachedFile = useProjectStore((s) => s.openAttachedFile);
  const source = useProjectStore((s) => s.source);
  return <>{splitLinks(text).map((piece, i) => {
    if (piece.kind === "url") return <a key={i} className="underline" href={piece.text} target="_blank" rel="noopener noreferrer">{piece.text}</a>;
    if (piece.kind === "path") return <button key={i} type="button" className="artifact-open underline" onClick={(e) => { e.stopPropagation(); openAttachedFile(piece.text); }}
      title={source === "vscode" ? t("エディタで開く: {path}", { path: piece.text }) : source === "serve" ? t("新しいタブで開く: {path}", { path: piece.text }) : t("パスをコピー: {path}", { path: piece.text })}>{piece.text}</button>;
    return <span key={i}>{piece.text}</span>;
  })}</>;
}

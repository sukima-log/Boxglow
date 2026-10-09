/**
 * パネルを閉じるボタン (詳細・Activity・引き出し・In charge の表で共用)
 * 広い画面では今までどおり小さな「×」。図に重なる狭い画面 (900px 以下) では、
 * 指で押しやすい枠付きの大きなボタンにして「閉じる」と文字を添える (どこで閉じるのか分かるように。見た目は index.css の .panel-close)
 */
import { t, useLang } from "../i18n";

/**
 * 閉じるボタン
 * Input : onClick = 閉じる処理, title = ツールチップ (省略時は「閉じる (Esc)」), label = 狭い画面で添える文字 (省略時は「閉じる」)
 * Output: ボタンの JSX
 */
export function CloseButton({ onClick, title, label }: { onClick: () => void; title?: string; label?: string }) {
  useLang(); // 言語が変わったら描き直す
  const text = label ?? t("閉じる");
  // 読み上げの名前は、画面の中の他の「閉じる」(ダイアログなど) と区別できるよう「パネルを閉じる」にする (表は「図に戻る」)
  const name = label ?? t("パネルを閉じる");
  return (
    <button className="btn btn-ghost btn-sm panel-close" onClick={onClick} title={title ?? t("閉じる (Esc)")} aria-label={name}>
      <span aria-hidden="true">×</span>
      <span className="panel-close__label" aria-hidden="true">{text}</span>
    </button>
  );
}

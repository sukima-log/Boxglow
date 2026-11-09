/**
 * Boxglow の全体像 (スライド 1 枚の図) を大きく見せるダイアログ。Home の「しくみを 1 枚で見る」から開く
 * 図は画面の言語に合わせて public/overview/overview.{ja,en}.webp を出す (元は docs/overview/。scripts/render-overview.mjs で書き出す)。
 * npm のパッケージ (npx boxglow serve) には図を入れていない (パッケージを軽く保つため) ので、読めなければ boxglow.app の図を読む。
 * 背景を押すか Esc で閉じる。
 */
import { useEffect, useState } from "react";
import { t, useLang } from "../i18n";
import { CloseButton } from "./CloseButton";

/** boxglow.app に置いた図 (手元に図が無いときに読む) */
const HOSTED = "https://boxglow.app/overview/";

/**
 * 全体像のダイアログ
 * Input : onClose = 閉じる処理
 * Output: 画面全体を覆うダイアログの JSX
 */
export function OverviewDialog({ onClose }: { onClose: () => void }) {
  const lang = useLang(); // 言語が変わったら、その言語の図に描き直す
  const file = `overview.${lang === "en" ? "en" : "ja"}.webp`;
  const [src, setSrc] = useState(`${import.meta.env.BASE_URL}overview/${file}`);

  // 言語が変わったら、手元の図から読み直す
  useEffect(() => { setSrc(`${import.meta.env.BASE_URL}overview/${file}`); }, [file]);

  // Esc で閉じる (図に入力欄は無いので、どこにフォーカスがあっても閉じてよい)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop overview-backdrop" onClick={onClose}>
      <div className="card modal overview-dialog" role="dialog" aria-modal="true" aria-label={t("Boxglow の全体像")} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <h2 className="flex-1">{t("Boxglow の全体像")}</h2>
          <CloseButton onClick={onClose} title={t("閉じる (Esc)")} label={t("閉じる")} />
        </div>
        {/* 押すと別のタブで原寸の図を開く (狭い画面では図が小さいので、指で拡大して読めるようにする) */}
        <a href={src} target="_blank" rel="noreferrer" title={t("図を押すと、別のタブで大きく開きます")}>
          <img
            className="overview-image"
            src={src}
            width={1600}
            height={900}
            alt={t("Boxglow の全体像。Claude Code と Codex が MCP と hooks で作業を記録し、計画全体のフロー図で、終わった所・AI の現在地・これからが分かる。人は判断が要る所だけ答える。計画は boxglow.json の 1 ファイルで、Git・VS Code・ブラウザで使える")}
            // 手元に図が無い (npx boxglow serve など) ときは boxglow.app の図を読む。それも読めなければ代わりの文が出る
            onError={() => { if (!src.startsWith(HOSTED)) setSrc(HOSTED + file); }}
          />
        </a>
        <p className="overview-hint">{t("図を押すと、別のタブで大きく開きます")}</p>
      </div>
    </div>
  );
}

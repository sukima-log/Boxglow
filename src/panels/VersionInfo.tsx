/**
 * バージョンと接続先の表示 (フッタの右端の「v0.3.0」。押すと詳細が開く)
 * 何を: 画面 (GUI) の版、保存先 (ブラウザ内 / CLI server / VS Code / 閲覧専用ファイル)、接続先 (CLI・拡張) の版と保存方式を見せる。
 * なぜ: 画面と CLI・拡張の版がずれていると保存の約束 (保存方式) が合わず、保存に失敗することがある。
 *       不具合のときに、利用者が自分で版のずれに気付けるようにする (ずれているときは更新を促す文を出す)。
 */
import { APP_VERSION, SAVE_PROTOCOL } from "../model/version";
import { useProjectStore } from "../store/useProjectStore";
import { t } from "../i18n";

/**
 * バージョンと接続先の表示
 * Input : なし (接続先の版 peerVersion と保存先 source は store から取る)
 * Output: details の JSX (畳んだ状態では版の番号だけ。開くと一覧)
 */
export function VersionInfo() {
  const peer = useProjectStore((s) => s.peerVersion); // 接続先 (CLI server / VS Code 拡張) が名乗った版。つながっていなければ無い
  const source = useProjectStore((s) => s.source); // 今の計画の保存先
  return <details className="version-info">
    <summary title={t("バージョンと接続先")}>v{APP_VERSION}</summary>
    <div className="card version-info__content">
      <b>{t("バージョンと接続先")}</b>
      <dl>
        <dt>GUI</dt><dd>{APP_VERSION}</dd>
        <dt>{t("保存先")}</dt><dd>{source === "serve" ? "CLI server" : source === "vscode" ? "VS Code" : source === "file" ? t("閲覧専用ファイル") : t("ブラウザ内")}</dd>
        {peer && <><dt>{source === "vscode" ? "Extension" : "CLI"}</dt><dd>{peer.extension ?? peer.app ?? t("取得できません")}</dd>
          <dt>{t("接続先のアプリ")}</dt><dd>{peer.app ?? t("取得できません")}</dd>
          <dt>{t("保存方式")}</dt><dd>GUI {SAVE_PROTOCOL} / {t("接続先")} {peer.protocol ?? "?"}</dd></>}
        <dt>Build (JST)</dt><dd>{__BUILD__}</dd>
      </dl>
      {peer && (peer.protocol !== SAVE_PROTOCOL || peer.app !== APP_VERSION) && <p role="status">{t("接続先と画面のバージョンが異なるか、確認できません。CLI・拡張を更新し、画面を再読み込みしてください。")}</p>}
    </div>
  </details>;
}

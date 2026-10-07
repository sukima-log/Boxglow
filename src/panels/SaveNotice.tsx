/**
 * 保存の通知 (上の帯のすぐ下に出る帯) と、保存が競合したときの比較ダイアログ
 * 何を: 保存に失敗した・ほかの編集 (AI や別の画面) と競合した・直接開いたファイルが閲覧専用である、を利用者に知らせる。
 * なぜ: 保存できていないことに気付かないまま編集を続けると、手元の編集を失う。帯は原因が解消するまで出し続け、
 *       「JSON で退避」「統合」「最新を開く」「再試行」をその場で選べるようにする。
 * 文言は日本語で書き t() で包む (英語は src/i18n/en/app.ts と gui.ts)。
 */
import { useEffect, useRef, useState } from "react";
import { useProjectStore } from "../store/useProjectStore";
import { downloadText } from "../lib/download";
import { toJSON } from "../model/graph";
import { ConflictGroups } from "./ConflictGroups";
import { t } from "../i18n";

/**
 * 入力: 閉じる操作。出力: 保存用の比較モーダル。共通フォームの結果を保存storeへ渡す。
 * showModalで背面の操作を止め、閉じたときは元の操作へフォーカスを戻す。
 */
function ConflictDialog({ onClose }: { onClose: () => void }) {
  const { previewConflictReview, resolveConflictGroups, saveError } =
    useProjectStore();
  const ref = useRef<HTMLDialogElement>(null);
  const review = previewConflictReview();
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => {
      dialog.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="conflict-dialog"
      aria-labelledby="conflict-title"
      onCancel={onClose}
    >
      <div className="conflict-dialog__head">
        <h2 id="conflict-title" className="font-head">
          {t("競合する変更を比較")}
        </h2>
        <button
          className="btn btn-ghost btn-sm"
          onClick={onClose}
          aria-label={t("閉じる (Esc)")}
        >
          ×
        </button>
      </div>
      <div className="conflict-dialog__body">
        {review && (
          <ConflictGroups
            review={review}
            remoteLabel={t("最新のファイル")}
            onSubmit={(request) => {
              if (resolveConflictGroups(request)) onClose();
            }}
          />
        )}
        {saveError && <p role="status">{saveError}</p>}
      </div>
      <div className="conflict-dialog__foot">
        <button className="btn btn-sm" onClick={onClose}>
          {t("あとで選ぶ")}
        </button>
      </div>
    </dialog>
  );
}

/**
 * 保存の通知の帯
 * Input : なし (保存の状態は store から取る)
 * Output: 帯の JSX。保存の失敗も無く、閲覧専用のファイルでもなければ何も出さない (null)
 */
/**
 * 退避した編集の取り込みの結果の帯 (保存の失敗の帯と同じ場所・見た目。操作は取り込み用: 保存の再試行は出さない。R44-01 / R44-02)
 *   partial = 一部の段だけ取り込めた → 「確かめた今の中身を保存」(通常の Save と同じ処理だと分かる名前) と閉じる
 *   info    = 取り込めた・段をやめた → 閉じる (Save は上のバーから)
 */
export function RestoreNotice() {
  const { project, restoreNotice, dismissRestoreNotice, saveNow } = useProjectStore();
  if (!project || !restoreNotice) return null;
  return <RestoreNoticeView notice={restoreNotice} onSave={saveNow} onDismiss={dismissRestoreNotice} />;
}
/**
 * 取り込みの帯の見た目 (状態は呼び出し側が渡す。試験からも、状態を渡して描画できる)
 * Input : notice = 案内の種類と文, onSave = 確かめた今の中身を保存, onDismiss = 閉じる
 */
export function RestoreNoticeView({ notice, onSave, onDismiss }: { notice: { kind: "info" | "partial"; text: string }; onSave: () => void; onDismiss: () => void }) {
  return <div className="save-notice" role={notice.kind === "partial" ? "alert" : "status"}>
    <span>{notice.text}</span>
    <div className="flex flex-wrap gap-2 mt-2">
      {notice.kind === "partial" && <button className="btn btn-sm" onClick={onSave}>{t("確かめた今の中身を保存")}</button>}
      <button className="btn btn-ghost btn-sm" onClick={onDismiss}>{t("閉じる")}</button>
    </div>
  </div>;
}

export function SaveNotice() {
  const { project, source, saveError, conflict, resolveConflict, previewConflict, saveNow, readonlyReason, evacuate, evacuateAndTakeLatest, evacuated, contentHash } = useProjectStore();
  // 退避の操作の途中 (VS Code の保存先の選択を待つ間、ボタンを押せなくする)
  const [busy, setBusy] = useState(false);
  // 今の画面の中身のハッシュ (退避した中身と同じか = 退避の後に編集していないか、を見る。R49-04)
  const [current, setCurrent] = useState("");
  useEffect(() => { if (conflict?.editorDirty) void contentHash().then(setCurrent); }, [conflict, project, contentHash]);
  // VS Code の中: 退避は拡張の保存先の選択で書く (画面とエディタの両方の未保存の編集を、取り込める形で書く。書けたかどうかも分かる)。
  // 「最新を開く」は、退避できて、その後に画面が変わっていないときだけ行う (保存先の選択をやめた・書けなかったら、何も変えない)
  const inVsCode = source === "vscode";
  const run = (job: () => Promise<unknown>) => { setBusy(true); void job().finally(() => setBusy(false)); };
  const saveCopy = () => inVsCode
    ? run(async () => {
        // (結果を、帯の下の案内に出す。書けた場所を見せ、取り込み方を案内する)
        const ok = await evacuate();
        const at = useProjectStore.getState().evacuated?.path;
        useProjectStore.setState({ restoreNotice: { kind: "info", text: ok && at ? t("退避しました ({path})。⋯ メニューの「退避した編集を読み込む」で取り込めます", { path: at }) : t("退避しませんでした (保存先を選ばなかった・書けなかった)") } });
      })
    : downloadText("boxglow-unsaved.json", toJSON(project!), "application/json");
  const openLatest = () => { if (inVsCode) { run(evacuateAndTakeLatest); return; } downloadText("boxglow-unsaved.json", toJSON(project!), "application/json"); resolveConflict("remote"); };
  // 比較ダイアログを開いているか
  const [compare, setCompare] = useState(false);
  // 出すのは 2 つの場合だけ: 保存に失敗している (saveError)、または直接開いたファイル (source = "file"。閲覧専用) を見ている
  // (VS Code の中で、拡張がファイルを読み書きできない窓も閲覧専用。理由と対処を出す)
  if (!project || (!saveError && source !== "file" && !readonlyReason)) return null;
  // VS Code のエディタに未保存の編集があるときの衝突: 統合・置き換えはさせず、退避と開き直しだけを案内する (R49-01 / R49-02)
  if (conflict?.editorDirty) {
    const upToDate = evacuated !== null && evacuated.hash === current;
    return <div className="save-notice" role="alert">
      <span>{saveError}</span>
      {upToDate && <div className="mt-2">{t("退避済み: {path}。このファイルのタブを全部閉じて (保存しない) 開き直してください", { path: evacuated!.path })}</div>}
      <div className="flex flex-wrap gap-2 mt-2">
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={saveCopy}>{upToDate ? t("もう一度退避する") : t("手元の編集を退避")}</button>
      </div>
    </div>;
  }
  // 人が選ぶ必要のある競合の数 (0 なら選ばずにそのまま統合できる)
  const preview = previewConflict();
  const conflicts = preview?.conflicts.filter((item) => !item.automatic).length ?? 0;
  return <div className="save-notice" role={saveError ? "alert" : "status"}>
    <span>{saveError ?? readonlyReason ?? t("このファイルは閲覧専用です。共同編集は npx boxglow serve --open または VS Code 拡張で開いてください。")}</span>
    {saveError && <div className="flex flex-wrap gap-2 mt-2">
      <button className="btn btn-sm" disabled={busy} onClick={saveCopy}>{t("手元の編集を JSON で退避")}</button>
      {conflict ? preview && <>
        {conflicts > 0
          ? <button className="btn btn-primary btn-sm" onClick={() => setCompare(true)}>{t("変更を比較して選ぶ")} ({conflicts})</button>
          : <button className="btn btn-primary btn-sm" onClick={() => resolveConflict("merge")}>{t("両方の変更を統合")}</button>}
        <button className="btn btn-sm" disabled={busy} onClick={openLatest}>{t("手元を退避して最新のファイルを開く")}</button>
      </> : <button className="btn btn-sm" onClick={saveNow}>{t("保存を再試行")}</button>}
    </div>}
    {compare && conflict && <ConflictDialog onClose={() => setCompare(false)} />}
  </div>;
}

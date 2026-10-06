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
import type { ConflictChoices, MergeConflict } from "../model/merge";
import { t } from "../i18n";

/**
 * 競合した値を、比較ダイアログに出す文字列にする
 * Input : value = 競合した項目の値 (文字列・オブジェクト・undefined など。undefined = その側では削除された)
 * Output: 表示用の文字列 (引き継ぎメモは「本文 + 書いた人・日時」、そのほかのオブジェクトは整形した JSON)
 */
const displayValue = (value: unknown) => {
  if (value === undefined) return t("削除済み");
  if (typeof value === "string") return value || t("空欄");
  if (value && typeof value === "object" && "note" in value && "actor" in value && "at" in value) {
    return `${value.note}\n\n${value.actor} · ${value.at}`;
  }
  return JSON.stringify(value, null, 2);
};

/**
 * 競合の比較ダイアログ: 同じ項目を両方が変えた箇所を左右に並べ、項目ごとに残す側を選んで統合する
 * Input : onClose = 閉じるときに呼ぶ関数 (× / あとで選ぶ / Esc / 統合の成功)
 * Output: モーダルの dialog の JSX (競合の内容は store の previewConflict から取る)
 */
function ConflictDialog({ onClose }: { onClose: () => void }) {
  const { project, conflict, previewConflict, resolveConflict, saveError } = useProjectStore();
  // 項目ごとの選択 (競合の id -> "ours" = 手元 / "theirs" = 最新のファイル)。全部選ぶまで統合ボタンは押せない
  const [choices, setChoices] = useState<ConflictChoices>({});
  const ref = useRef<HTMLDialogElement>(null);
  const preview = previewConflict();
  // モーダルとして開く (showModal で背面の操作を止める)。閉じたら、開く前にフォーカスがあった要素へ戻す
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  // 競合の相手 (最新のファイル) が変わったら選択を捨てる (古い内容に対する選択で統合しないように)
  useEffect(() => { setChoices({}); }, [conflict?.revision, conflict?.text]);
  const items = preview?.conflicts ?? [];
  // まだ選んでいない項目の数 (番号の重複など自動で解消する項目は数えない)
  const unresolved = items.filter((item) => !item.automatic && !choices[item.id]).length;
  /**
   * 競合した項目の見出しを作る
   * Input : item = 競合 1 件 (segments = ["blocks", ボックスの id, 項目名] など)
   * Output: 「B12 題名 · 項目名」の形の文字列 (ボックスに属さない項目は項目名だけ)
   */
  const label = (item: MergeConflict) => {
    const [kind, id, field] = item.segments;
    const block = kind === "blocks" || kind === "handoffs" ? project?.blocks[id] : undefined;
    const fields: Record<string, string> = { title: t("題名"), name: t("名前"), description: t("説明"), note: t("引き継ぎメモ"), decisions: t("判断と回答"), status: "Status", artifacts: t("成果物"), position: t("位置"), category: "Category", progress: t("進捗") };
    return block ? `${block.key} ${block.title} · ${kind === "handoffs" ? t("引き継ぎメモ") : field ? fields[field] ?? field : t("タスク全体")}` : fields[item.path] ?? item.path;
  };
  return <dialog ref={ref} className="conflict-dialog" aria-labelledby="conflict-title" onCancel={onClose}>
    <div className="conflict-dialog__head">
      <h2 id="conflict-title" className="font-head">{t("競合する変更を比較")}</h2>
      <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label={t("閉じる (Esc)")}>×</button>
    </div>
    <div className="conflict-dialog__body">
      <p>{t("別の項目の変更は両方残ります。同じ項目を変更した箇所だけ、残す内容を選んでください。")}</p>
      {items.length === 0 && <p>{t("別の項目の変更です。統合できます。")}</p>}
      {items.map((item) => <fieldset key={item.id} className="conflict-item">
        <legend>{label(item)}</legend>
        {item.automatic ? <p>{t("番号の重複は自動で解消します。")}: {displayValue(item.theirs)}</p> : <div className="conflict-columns">
          {(["ours", "theirs"] as const).map((side) => <label key={side} className="conflict-choice" data-selected={choices[item.id] === side}>
            <span><input type="radio" name={item.id} checked={choices[item.id] === side} onChange={() => setChoices((c) => ({ ...c, [item.id]: side }))} /> {side === "ours" ? t("手元の編集") : t("最新のファイル")}</span>
            <pre>{displayValue(item[side])}</pre>
          </label>)}
        </div>}
      </fieldset>)}
      {saveError && <p className="text-[12px]" role="status">{saveError}</p>}
    </div>
    <div className="conflict-dialog__foot">
      <span aria-live="polite">{t("未選択: {n}", { n: unresolved })}</span>
      <button className="btn btn-sm" onClick={onClose}>{t("あとで選ぶ")}</button>
      <button className="btn btn-primary btn-sm" disabled={unresolved > 0 || !conflict} onClick={() => { if (resolveConflict("merge", choices, conflict?.revision)) onClose(); }}>{t("選択した内容で統合")}</button>
    </div>
  </dialog>;
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
  const conflicts = previewConflict()?.conflicts.filter((item) => !item.automatic).length ?? 0;
  return <div className="save-notice" role={saveError ? "alert" : "status"}>
    <span>{saveError ?? readonlyReason ?? t("このファイルは閲覧専用です。共同編集は npx boxglow serve --open または VS Code 拡張で開いてください。")}</span>
    {saveError && <div className="flex flex-wrap gap-2 mt-2">
      <button className="btn btn-sm" disabled={busy} onClick={saveCopy}>{t("手元の編集を JSON で退避")}</button>
      {conflict ? <>
        {conflicts > 0
          ? <button className="btn btn-primary btn-sm" onClick={() => setCompare(true)}>{t("変更を比較して選ぶ")} ({conflicts})</button>
          : <button className="btn btn-primary btn-sm" onClick={() => resolveConflict("merge")}>{t("両方の変更を統合")}</button>}
        <button className="btn btn-sm" disabled={busy} onClick={openLatest}>{t("手元を退避して最新のファイルを開く")}</button>
      </> : <button className="btn btn-sm" onClick={saveNow}>{t("保存を再試行")}</button>}
    </div>}
    {compare && conflict && <ConflictDialog onClose={() => setCompare(false)} />}
  </div>;
}

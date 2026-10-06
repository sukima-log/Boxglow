/**
 * 画面からの同期: 上のバーの「同期」の印と、押すと開く小さな欄
 *   - 印は 1 語 (オフ / 未サインイン / 同期済み / 送信待ち / 同期中 / 確認 / 問題 / 通信不可 / 一時停止 / 別プロセス / 未対応)。色と文言の両方で区別する
 *   - 欄: 利用者、この計画の同期のオン / オフ、状態の 1 行、確認が要る場面の短い理由と選択肢のボタン、「詳細」で展開 (版・ID・見比べ・控えの場所)
 *   - 画面は表示と操作の送信だけ (判断・通信・資格情報は裏方)。CLI のコマンドの説明は出さない (文言は共有、構成は別)
 * 表示されるのは、裏方が状態を流しているとき (boxglow serve --sync / VS Code の拡張) だけ
 */
import { useEffect, useRef, useState } from "react";
import { useProjectStore } from "../store/useProjectStore";
import { t } from "../i18n";
import type { HaltItem, SyncStatus } from "../sync/status";

/** 状態 → 印の 1 語と、見た目の区分 (色) */
function chip(status: SyncStatus): { label: string; tone: "quiet" | "ok" | "busy" | "attention" | "problem" } {
  switch (status.state) {
    case "synced": return { label: t("同期済み"), tone: "ok" };
    case "unsent": return { label: t("送信待ち"), tone: "busy" };
    case "syncing": return { label: t("同期中"), tone: "busy" };
    case "halted": return { label: t("確認"), tone: "attention" };
    case "problem": return { label: t("問題"), tone: "problem" };
    case "offline": return { label: t("通信不可"), tone: "problem" };
    case "paused": return { label: t("一時停止"), tone: "quiet" };
    case "external": return { label: t("別プロセス"), tone: "attention" };
    case "unsupported": return { label: t("未対応"), tone: "quiet" };
    case "signed-out": return { label: t("未サインイン"), tone: "quiet" };
    case "unbound": return { label: t("未接続"), tone: "quiet" };
    default: return { label: t("オフ"), tone: "quiet" };
  }
}

/** 上のバーの印 + 欄 */
export function SyncChip() {
  const status = useProjectStore((s) => s.syncStatus);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // 欄の外を押したら閉じる
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  if (!status) return null;
  const c = chip(status);
  return (
    <div className="sync-chip-wrap" ref={ref}>
      <button className={`sync-chip tone-${c.tone}`} data-state={status.state} onClick={() => setOpen((v) => !v)} title={t("同期")} aria-expanded={open}>
        <span className="sync-chip__dot" aria-hidden="true" />
        <span>{c.label}</span>
      </button>
      {open && <SyncPanel status={status} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** 欄の中身 */
function SyncPanel({ status, onClose }: { status: SyncStatus; onClose: () => void }) {
  const act = useProjectStore((s) => s.syncAct);
  const saveState = useProjectStore((s) => s.saveState);
  const [details, setDetails] = useState(false);
  const account = status.credentials.account;
  const file = status.file;
  // 画面に未保存の編集があるときは、クラウド側を採る選択を無効にする (先に保存するよう案内する。設計書 4 章)
  const unsaved = saveState === "unsaved" || saveState === "saving";
  const choices = (status.halt?.items.filter((i): i is Extract<HaltItem, { kind: "choice" }> => i.kind === "choice")) ?? [];
  const texts = (status.halt?.items.filter((i): i is Extract<HaltItem, { kind: "text" }> => i.kind === "text")) ?? [];
  return (
    <div className="sync-panel" role="dialog" aria-label={t("同期")}>
      {/* 利用者 */}
      <div className="sync-panel__row">
        {status.support !== "ok" ? <span className="muted">{t("この環境では、まだサインインを保存できません")}</span>
        : status.signIn ? <SignInCode code={status.signIn} onCancel={() => void act({ kind: "cancelSignIn" })} />
        : account ? <>
            <span className="sync-panel__who">{account.display}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => void act({ kind: "signOut" })}>{t("サインアウト")}</button>
          </>
        : status.credentials.source === "env" ? <span className="muted">{t("環境変数のトークンで同期しています")}</span>
        : <>
            <button className="btn btn-sm" onClick={() => void act({ kind: "signIn", provider: "github" })}>{t("GitHub でサインイン")}</button>
            <button className="btn btn-sm" onClick={() => void act({ kind: "signIn", provider: "google" })}>{t("Google でサインイン")}</button>
          </>}
      </div>
      {/* この計画 */}
      {file && status.state !== "signed-out" && status.state !== "unsupported" && <div className="sync-panel__row">
        <label className="sync-panel__toggle">
          <input type="checkbox" checked={file.enabled} onChange={(e) => void act({ kind: e.target.checked ? "enable" : "disable" })} />
          <span>{t("この計画を同期する")}</span>
        </label>
        {file.enabled && !file.binding && status.state === "unbound" && <button className="btn btn-sm" onClick={() => void act({ kind: "bind" })}>{t("サーバーに置く")}</button>}
        {file.enabled && file.binding && status.state !== "external" && <button className="btn btn-ghost btn-sm" onClick={() => void act({ kind: "syncNow" })} disabled={status.state === "syncing"}>{t("今すぐ同期")}</button>}
      </div>}
      {/* 状態の 1 行 */}
      {status.message && <div className="sync-panel__line">{status.message}</div>}
      {status.problem && <div className="sync-panel__line sync-panel__problem">{status.problem.text}{" "}<span className="muted">{fixHint(status.problem.fix)}</span></div>}
      {unsaved && file?.enabled && <div className="sync-panel__line muted">{t("未保存の編集があります。保存すると送られます")}</div>}
      {/* VS Code のエディタが追い付いていない (受け取った中身は確認用。保存は通らない): 退避してから開き直す */}
      <EditorBehind />
      {/* 退避した編集の取り込み (開き直した後の画面から使う。VS Code の中だけ。R39-06) */}
      <RestoreEntry />
      {/* 確認が要る場面 */}
      {status.halt && <div className="sync-panel__halt">
        {texts.slice(0, 3).map((i, n) => <div key={n} className="sync-panel__line">{i.text}</div>)}
        {choices.length > 0 ? <div className="sync-panel__choices">
          {choices.map((ch) => <button key={ch.id} className="btn btn-sm" disabled={unsaved} title={unsaved ? t("先に保存してください") : ch.command}
            onClick={() => { const id = status.halt!.choiceIds[ch.id]; if (id) void act({ kind: "choose", choiceId: id }); }}>{ch.label}</button>)}
        </div> : <div className="sync-panel__line muted">{fixHint(status.halt.fix)}</div>}
        {texts.length > 3 && <button className="btn btn-ghost btn-sm" onClick={() => setDetails((v) => !v)}>{details ? t("詳細を閉じる") : t("詳細")}</button>}
        {details && <div className="sync-panel__details">{texts.slice(3).map((i, n) => <div key={n}>{i.text}</div>)}{status.halt.done.backup && <div className="muted">{t("控え")}: {status.halt.done.backup}</div>}</div>}
      </div>}
      {/* 詳細 (版・ID) */}
      {!status.halt && file?.binding && status.state !== "signed-out" && <div className="sync-panel__line muted">{status.revision ? t("サーバーの版: {revision}", { revision: status.revision }) : ""}{" "}<span className="sync-panel__id">{file.binding.remoteId}</span></div>}
      <button className="sync-panel__close btn btn-ghost btn-sm" onClick={onClose} aria-label={t("閉じる")}>×</button>
    </div>
  );
}

/** エディタ待ち: 画面にだけある編集を退避してから、ファイルを閉じて開き直す (退避の成功は、その中身に対してだけ) */
function EditorBehind() {
  const behind = useProjectStore((s) => s.editorBehind);
  const evacuated = useProjectStore((s) => s.evacuated);
  const evacuate = useProjectStore((s) => s.evacuate);
  const contentHash = useProjectStore((s) => s.contentHash);
  const saveState = useProjectStore((s) => s.saveState);
  const project = useProjectStore((s) => s.project);
  const [current, setCurrent] = useState<string>("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (behind) void contentHash().then(setCurrent); }, [behind, project, contentHash]);
  if (!behind) return null;
  const upToDate = evacuated !== null && evacuated.hash === current;
  const dirty = saveState !== "saved";
  return (
    <div className="sync-panel__halt">
      <div className="sync-panel__line">{t("同期で受け取った最新の中身を、VS Code のエディタがまだ読み込んでいません。")}</div>
      {dirty
        ? <div className="sync-panel__line">{upToDate
            ? t("退避済み: {path}。ファイルを閉じて開き直し、「退避した編集を読み込む」で見比べてください", { path: evacuated!.path })
            : t("画面に未保存の編集があります。先に別のファイルへ退避してから、ファイルを閉じて開き直してください (退避せずに閉じると、この編集は失われます)")}</div>
        : <div className="sync-panel__line">{t("未保存の編集はありません。ファイルを閉じて開き直すと、最新の中身になります")}</div>}
      <div className="sync-panel__choices">
        {dirty && !upToDate && <button className="btn btn-sm" disabled={busy} onClick={() => { setBusy(true); void evacuate().finally(() => setBusy(false)); }}>{t("編集を退避する")}</button>}
      </div>
    </div>
  );
}

/**
 * 退避した編集の取り込みで、両側が違う値にしていた項目を選ぶ欄 (R40-03)。選ぶまで画面にも保存にも反映しない。やめれば、画面は元のまま
 */
export function RestoreDialog() {
  const pending = useProjectStore((s) => s.restorePending);
  const apply = useProjectStore((s) => s.applyRestorePicks);
  const cancel = useProjectStore((s) => s.cancelRestore);
  const [picks, setPicks] = useState<Record<string, "current" | "saved">>({});
  const [error, setError] = useState<string | null>(null);
  // (欄の中身が作り直されたら、前の選択は捨てる。表示していない値を、古い選択で採らない)
  useEffect(() => { setPicks({}); }, [pending?.basis, pending?.conflicts, pending?.step]);
  if (!pending) return null;
  const show = (v: unknown) => { const text = v === undefined ? t("(消されている)") : typeof v === "string" ? v : JSON.stringify(v); return text.length > 80 ? text.slice(0, 80) + "…" : text; };
  // (段ごとに、どの退避の版と比べているかを示す。今の値 = この段の前までを取り込んだ、今の画面の値)
  const savedLabel = pending.step === "gui" ? t("退避した画面の値") : t("退避したエディタの値");
  const done = pending.conflicts.every((c) => picks[c.id]);
  return (
    <div className="sync-panel restore-dialog" role="dialog" aria-label={t("退避した編集の取り込み")}>
      {/* (エディタの段: 画面側は取り込み済みで、今の値はその結果。この段をやめても、画面側の取り込みは残る) */}
      {pending.step === "editor" && <div className="sync-panel__line muted">{t("画面側の編集は取り込み済みです。「今の値」は、その結果です。")}</div>}
      <div className="sync-panel__line">{pending.step === "gui"
        ? t("退避した画面の編集と、今の中身で、同じ項目が違う値になっています。項目ごとに、どちらを採るかを選んでください。")
        : t("退避したエディタ側の編集と、今の中身で、同じ項目が違う値になっています。項目ごとに、どちらを採るかを選んでください。")}</div>
      {pending.conflicts.map((c) => (
        <div key={c.id} className="sync-panel__halt">
          <div className="sync-panel__id">{c.path}</div>
          {(["current", "saved"] as const).map((k) => (
            <label key={k} className="sync-panel__toggle">
              <input type="radio" name={c.id} checked={picks[c.id] === k} onChange={() => setPicks({ ...picks, [c.id]: k })} />
              <span>{k === "current" ? t("今の値") : savedLabel}: {show(k === "current" ? c.current : c.saved)}</span>
            </label>
          ))}
        </div>
      ))}
      {error && <div className="sync-panel__line sync-panel__problem">{error}</div>}
      <div className="sync-panel__choices">
        <button className="btn btn-sm" disabled={!done} onClick={() => { const message = apply(picks); setError(message); }}>{t("取り込む")}</button>
        <button className="btn btn-ghost btn-sm" onClick={() => { cancel(); setPicks({}); setError(null); }}>{pending.step === "editor" ? t("この段をやめる") : t("やめる")}</button>
      </div>
    </div>
  );
}

/** 自動保存を止めているときの短い印 (退避した編集を取り込んだ後。Save で外れる) */
export function SaveHeldChip() {
  const held = useProjectStore((s) => s.saveHeld);
  if (!held) return null;
  return <span className="save-chip unsaved" title={t("退避した編集を取り込んだので、自動保存を止めています。確かめてから Save で保存してください")}>{t("自動保存を一時停止中")}</span>;
}

/** 退避した編集を、今開いている最新の中身に取り込む入口 (エディタ待ちの間は出さない: 先に開き直す) */
function RestoreEntry() {
  const source = useProjectStore((s) => s.source);
  const behind = useProjectStore((s) => s.editorBehind);
  const loadEvacuated = useProjectStore((s) => s.loadEvacuated);
  const pending = useProjectStore((s) => s.restorePending);
  // (取り込みの確認の途中は、新しい退避ファイルを読ませない。R43-02)
  if (source !== "vscode" || behind || pending) return null;
  return <div className="sync-panel__row"><button className="btn btn-ghost btn-sm" onClick={loadEvacuated}>{t("退避した編集を読み込む")}</button></div>;
}

/** サインインの途中: コードと、開くページ */
function SignInCode({ code, onCancel }: { code: NonNullable<SyncStatus["signIn"]>; onCancel: () => void }) {
  if (code.provider === "google") {
    return (
      <div className="sync-panel__signin">
        <div>{t("ブラウザで次のページを開き、Google のアカウントで許可してください")}</div>
        <a href={code.url} target="_blank" rel="noreferrer">{t("Google のサインインのページを開く")}</a>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>{t("中止")}</button>
      </div>
    );
  }
  return (
    <div className="sync-panel__signin">
      <div>{t("ブラウザで次のページを開き、コードを入力してください")}</div>
      <a href={code.verificationUrl} target="_blank" rel="noreferrer">{code.verificationUrl}</a>
      <div className="sync-panel__code">{code.userCode}</div>
      <button className="btn btn-ghost btn-sm" onClick={onCancel}>{t("中止")}</button>
    </div>
  );
}

/** 直す場所の案内 (選べる操作が無いとき) */
function fixHint(fix: string): string {
  switch (fix) {
    case "local-file": return t("手元のファイルを直してください");
    case "sync-state": return t("同期の状態のフォルダを確かめてください");
    case "server-content": return t("サーバーの中身を確かめてください");
    case "credentials": return t("サインインを確かめてください");
    case "rerun": return t("もう一度同期してください");
    case "wait": return t("しばらく待ちます");
    default: return "";
  }
}

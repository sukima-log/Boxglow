import { SyncLifecycle } from "./SyncLifecycle";
/**
 * 画面からの同期: 上部バーの印と、押すと開く同期パネル。
 * - 印は「同期済み / 送受信中 / 確認が必要 / 停止中 / 未同期」の 5 群。元の状態は data-state に残す。
 * - 先頭は短い状態説明・主操作・確認が要る差分。アカウント・設定・版・ID・控えは詳細へ畳む。
 * - ここは表示と操作要求の送信だけ。通信、資格情報、選択の検証、保存・復旧はストアとホストに任せる。
 * - CLI の説明文は共有しても、コマンド文字列を実行しない。許可された種類の操作と opaque な choiceId を送る。
 * 裏方が状態を流す serve --sync / VS Code の拡張でだけ表示する。秘密のトークンを画面へ渡さない。
 */
import { SyncStartup } from "./SyncStartup";
import { ConflictGroups } from "./ConflictGroups";
import { useEffect, useRef, useState } from "react";
import { useProjectStore } from "../store/useProjectStore";
import { billingStatusLabel, planLabel } from "../sync/billing";
import { SignInButtons, useAutoOpened } from "./SignInButtons";
import { t } from "../i18n";
import type { HaltItem, SyncStatus } from "../sync/status";

/** 入力: ホストの状態。出力: 利用者向けの名前、記号、配色。元のstateは変更しない。 */
function chip(status: SyncStatus): {
  label: string;
  icon: string;
  tone: string;
} {
  switch (status.state) {
    case "synced":
      return { label: t("同期済み"), icon: "✓", tone: "ok" };
    case "unsent":
      return { label: t("送信待ち"), icon: "◷", tone: "quiet" };
    case "syncing":
      return { label: t("送受信中"), icon: "↻", tone: "busy" };
    case "halted":
      return { label: t("確認が必要"), icon: "!", tone: "attention" };
    case "disabled":
      // 利用者が止めた: 問題ではないので赤にしない
      return { label: t("停止中"), icon: "Ⅱ", tone: "quiet" };
    case "problem":
    case "offline":
    case "paused":
    case "external":
    case "unsupported":
      return { label: t("停止中"), icon: "Ⅱ", tone: "problem" };
    default:
      return { label: t("未同期"), icon: "○", tone: "quiet" };
  }
}

/** 入力: 元の状態。出力: 次の操作を決めるための短い説明。詳しい理由は詳細欄に保持する。 */
function explanation(status: SyncStatus): string {
  switch (status.state) {
    case "synced":
      return t("手元に保存した計画は、サーバーとそろっています。");
    case "unsent":
      return t("手元には保存済みです。サーバーへの送信を待っています。");
    case "syncing":
      return t("サーバーと変更を送受信しています。");
    case "halted":
      return t("内容を確かめて、進め方を選んでください。");
    case "offline":
      return t("サーバーに接続できません。接続後に再試行してください。");
    case "paused":
      return t("同期を一時停止しています。");
    case "disabled":
      return t("同期を止めています。「同期を再開する」で続きから同期します。");
    case "external":
      return t("別のプロセスが同期を受け持っています。");
    case "unsupported":
      return t("この環境では、まだサインインを保存できません");
    case "problem":
      return status.problem ? fixHint(status.problem.fix) : t("詳細で停止の理由を確認してください。");
    case "signed-out":
      return t("サインインすると、この計画を同期できます。");
    case "unbound":
      return t("この計画をサーバーに置くと、同期を始められます。");
    default:
      return t("この計画の同期はオフです。");
  }
}

/** 入力: ストアの同期状態。出力: 開閉ボタンと画面内に収まるポップオーバー。 */
export function SyncChip() {
  const status = useProjectStore((s) => s.syncStatus);
  // serve との接続断では最後の状態は信用できない。「接続なし」の説明だけにして操作を出さない。
  const lost = useProjectStore((s) => s.syncLost);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 60 });
  const ref = useRef<HTMLDivElement>(null);
  // 比較中は左右の値を読める幅へ広げ、外枠と配置計算で同じ幅を使う。
  const panelWidth = status?.halt?.review && !lost ? 680 : 400;
  useEffect(() => {
    if (!open) return;
    // 入力: ボタンの座標と viewport。出力: パネルの左上。狭い画面でも右端へはみ出さないよう制限する。
    const place = () => {
      const box = ref.current?.getBoundingClientRect();
      if (box)
        setPosition({
          left: Math.max(8, Math.min(box.left, innerWidth - Math.min(panelWidth, innerWidth - 16) - 8)),
          top: Math.max(8, Math.min(box.bottom + 8, innerHeight - 160)),
        });
    };
    // 入力: MouseEvent。出力: void。パネル内の操作は保ち、外側のクリックでだけ閉じる。
    const close = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    // 入力: KeyboardEvent。出力: void。Escape で閉じた後は入口に戻し、キー操作を続けられるようにする。
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        ref.current?.querySelector("button")?.focus();
      }
    };
    place();
    window.addEventListener("resize", place);
    // 帯のスクロールに追従し、入口から離れた場所にパネルを残さない。
    const bar = ref.current?.closest(".topbar-scroll");
    bar?.addEventListener("scroll", place);
    // (捕捉段階で受ける: キャンバスや他の部品が押下の伝播を止めても、外側の押下で閉じる)
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("resize", place);
      bar?.removeEventListener("scroll", place);
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", escape);
    };
  }, [open, panelWidth]);
  if (!status) return null;
  const c = lost ? { label: t("停止中"), icon: "Ⅱ", tone: "problem" } : chip(status);
  return (
    <div className="sync-chip-wrap" ref={ref}>
      <button
        className={`sync-chip tone-${c.tone}`}
        data-state={lost ? "disconnected" : status.state}
        onClick={() => setOpen(!open)}
        title={t("同期")}
        aria-expanded={open}
      >
        <span aria-hidden="true">{c.icon}</span>
        <span>
          {t("同期")}: {c.label}
        </span>
        {/* 押すと開く印 (保存状態の札は押せないので、見た目で区別する) */}
        <span className="sync-chip__chev" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          className="sync-popover"
          style={{
            width: `min(${panelWidth}px, calc(100vw - 16px))`,
            left: position.left,
            top: position.top,
            maxHeight: `calc(100dvh - ${position.top + 8}px)`,
          }}
        >
          {lost ? (
            <div className="sync-panel" role="dialog" aria-label={t("同期")}>
              <strong>
                {t("停止中")} · {t("接続なし")}
              </strong>
              <div className="sync-panel__line">
                {t(
                  "boxglow serve と接続できません。同期の状態は分かりません (最後の表示は古い可能性があります)。serve が動いているか確かめてください。つながり直すと、表示は戻ります",
                )}
              </div>
              <button
                className="sync-panel__close btn btn-ghost btn-sm"
                onClick={() => setOpen(false)}
                aria-label={t("閉じる")}
              >
                ×
              </button>
            </div>
          ) : (
            <SyncPanel status={status} onClose={() => setOpen(false)} />
          )}
        </div>
      )}
    </div>
  );
}

/** 入力: 最新の同期状態と閉じる操作。出力: 主操作、比較、折りたたんだ設定・詳細。 */
function SyncPanel({ status, onClose }: { status: SyncStatus; onClose: () => void }) {
  const act = useProjectStore((s) => s.syncAct);
  const [syncRequested, setSyncRequested] = useState(false);
  const syncPending = useRef(false);
  /** Input: なし。Output: 同期要求と確認結果の表示。成功を先取りせずホストの最終状態で通知する。 */
  const syncNow = async () => {
    if (syncPending.current) return;
    syncPending.current = true;
    setSyncRequested(true);
    const before = useProjectStore.getState().syncStatus;
    try {
      await act({ kind: "syncNow" });
      const latest = useProjectStore.getState();
      const updated = latest.syncStatus && before && (latest.syncStatus.session !== before.session || latest.syncStatus.seq > before.seq);
      // VS Code の postMessage は完了を待たず戻る。古い「同期済み」を今回の結果と取り違えない。
      if (!latest.syncLost && updated && latest.syncStatus?.state === "synced") latest.setToast(t("サーバーと最新の内容を確認しました"));
      else if (!updated) latest.setToast(t("同期を要求しました。結果は同期の状態で確認できます"));
    } finally { syncPending.current = false; setSyncRequested(false); }
  };
  const saveState = useProjectStore((s) => s.saveState);
  const file = status.file;
  const account = status.credentials.account;
  const c = chip(status);
  // 設計書 4 章: 未保存の画面を残してサーバー側を採ると、保存前の編集を失うおそれがある。
  // 同じ基準で比較し直せるよう、保存中も含めて選択を止める。最終的な可否はホストも再検証する。
  const unsaved = saveState === "unsaved" || saveState === "saving";
  // 表示の文と操作を分離。command の文面を解釈せず、ホストの choiceIds だけを操作に渡す。
  const choices =
    status.halt?.items.filter((i): i is Extract<HaltItem, { kind: "choice" }> => i.kind === "choice") ?? [];
  const texts =
    status.halt?.items.filter((i): i is Extract<HaltItem, { kind: "text" }> => i.kind === "text") ?? [];
  // 旧ホストは競合値を「  - path: 手元 ... / サーバー ...」として返す。
  // 値そのものは解釈せず表示し、共通の前置きだけを詳細へ移す。全件を見比べられるように残す。
  const conflicts =
    status.halt?.reason === "conflicts" ? texts.filter((item) => item.text.trimStart().startsWith("- ")) : [];
  const comparison = conflicts.length ? conflicts : texts;
  const extra = conflicts.length ? texts.filter((item) => !conflicts.includes(item)) : [];
  const ready = status.support === "ok" && status.state !== "signed-out";
  return (
    <div className="sync-panel" role="dialog" aria-label={t("同期")}>
      <div className={`sync-panel__heading tone-${c.tone}`} role="status" aria-live="polite">
        <span aria-hidden="true">{c.icon}</span>
        <strong>{status.startup && !file?.binding ? t("同期を始める") : c.label}</strong>
      </div>
      {!status.startup && <div className="sync-panel__line">{explanation(status)}</div>}
      {/* 知らせ: 補足・停止の理由と直し方・控えの場所 (あるときだけ) */}
      {(status.message || status.problem || extra.length > 0 || status.halt?.done.backup) && (
        <div className="sync-panel__notes">
          {status.message && <div className="sync-panel__line">{status.message}</div>}
          {status.problem && <div className="sync-panel__line sync-panel__problem">{status.problem.text} {fixHint(status.problem.fix)}</div>}
          {extra.map((item, n) => <div key={n}>{item.text}</div>)}
          {status.halt?.done.backup && <div>{t("控え")}: {status.halt.done.backup}</div>}
        </div>
      )}
      {/* 1 段目: 状態と、いちばんよく使う操作 (サインイン / 同期を始める / 今すぐ同期)。情報は最小限にする */}
      {unsaved && file?.enabled && (
        <div className="sync-panel__line muted">{t("未保存の編集があります。保存すると送られます")}</div>
      )}
      {/* R49: エディタの未保存編集がある受信待ちは、自動統合・自動の開き直しへ進めず、先に退避を案内する。 */}
      <EditorBehind />
      {/* 同期の開始の流れ: まだ結び付いていない計画ではここ (主操作)。結び付いた計画では「サーバーの計画を開く」の行の下 (SyncLifecycle) */}
      {status.server && file && !file.binding && (!status.halt || status.startup) && status.support === "ok" && <SyncStartup key={status.startup?.operationId ?? "entry"} status={status} act={act} unsaved={unsaved}/>}
      {/* 招待されていない (開始の手順の外でサインインしたとき。手順の中では SyncStartup が出す) */}
      {status.notInvited && !status.startup && !status.signIn && (
        <div className="sync-panel__line" role="alert">
          {t("同期は招待制の試験中です。このアカウントはまだ招待されていません。")}
          {status.notInvited.waitlist && <> <a href={status.notInvited.waitlist} target="_blank" rel="noreferrer">{t("順番待ちに登録する")}</a></>}
        </div>
      )}
      {status.signIn ? (
        <SignInCode code={status.signIn} onCancel={() => void act({ kind: "cancelSignIn" })} />
      ) : (
        <div className="sync-panel__row">
          {status.support === "ok" && !account && status.credentials.source !== "env" && (!status.server || file?.binding) && !status.startup && (
            <SignInButtons act={act} />
          )}
          {file?.enabled && ready && !file.binding && !status.server && !status.startup && status.state === "unbound" && (
            <button className="btn btn-primary btn-sm" onClick={() => void act({ kind: "bind" })}>
              {t("サーバーに置く")}
            </button>
          )}
          {file?.binding?.team && <p className="muted sync-panel__team">{t("ワークスペース")}: {file.binding.team.name}</p>}
          {file?.enabled &&
            ready &&
            file.binding &&
            status.state !== "external" &&
            status.state !== "halted" && (
              <button
                className="btn btn-sm"
                disabled={syncRequested || status.state === "syncing"} aria-busy={syncRequested || status.state === "syncing"}
                onClick={() => void syncNow()}
              >
                {syncRequested || status.state === "syncing" ? t("送受信中…") : t("今すぐ同期")}
              </button>
            )}
        </div>
      )}
      {status.localBackup && (
        <div role="status" className="sync-panel__line break-all">
          {t("置き換え前の手元の編集を保存しました。控え: {path}", { path: status.localBackup })}
        </div>
      )}
      {status.halt && (
        <div className="sync-panel__halt">
          {status.halt.review && status.halt.resolutionChoiceId ? (
            <>
              <ConflictGroups
                review={status.halt.review}
                remoteLabel={t("サーバーの値")}
                disabled={unsaved}
                onSubmit={(resolution) =>
                  void act({
                    kind: "resolveGroups",
                    choiceId: status.halt!.resolutionChoiceId!,
                    resolution,
                  })
                }
              />
              {status.halt.resolutionError && <p role="status">{status.halt.resolutionError}</p>}
            </>
          ) : (
            <>
              {/* 置き換え・復旧の注意も含むホストの説明を維持する。競合時は左右の選択を隣に置く。 */}
              <div className="sync-panel__comparison">
                {comparison.map((item, n) => (
                  <div className="sync-panel__line" key={n}>
                    {item.text}
                  </div>
                ))}
              </div>
              {choices.length ? (
                <div className="sync-panel__choices">
                  {choices.map((ch) => (
                    <button
                      key={ch.id}
                      className="btn btn-sm"
                      disabled={unsaved}
                      title={unsaved ? t("先に保存してください") : ch.label}
                      onClick={() => {
                        const id = status.halt!.choiceIds[ch.id];
                        if (id) void act({ kind: "choose", choiceId: id });
                      }}
                    >
                      {ch.label}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="muted">{fixHint(status.halt.fix)}</div>
              )}
            </>
          )}
        </div>
      )}
      {/* 2 段目: アカウント (誰で・どの手段で・プラン)。サインアウトは右端の小さな文字 */}
      {status.support === "ok" && status.server && (account || status.credentials.source === "env") && (
        <div className="sync-account" aria-label={t("アカウント")}>
          <span className="sync-account__dot" aria-hidden="true" />
          <div className="sync-account__who">
            {account ? <>
              <span className="sync-account__name sync-panel__who">{account.display}</span>
              <span className="sync-account__via">{account.signedInWith === "google" ? "Google" : account.signedInWith === "github" ? "GitHub" : ""}</span>
              {account.billing && account.billing.plan && (
                <span className="sync-account__plan" data-entitled={account.billing.entitled ? "true" : "false"} title={account.billing.plan !== "comp" ? billingStatusLabel(account.billing.status) : undefined}>
                  {planLabel(account.billing.plan)}{account.billing.plan === "team" && account.billing.seats > 0 ? ` × ${account.billing.seats}` : ""}
                </span>
              )}
            </> : <span className="sync-account__name">{t("環境変数のトークン")}</span>}
          </div>
          {account && (
            <button className="btn btn-sm sync-account__out" title={t("プラン・サインインの手段・サインアウト")} onClick={() => useProjectStore.getState().setAccountMenuOpen(true)}>
              {t("アカウント設定")}
            </button>
          )}
        </div>
      )}
      {/* 3 段目: この計画の同期を止める / 再開する (小さなスイッチだと見つからない、と利用者の指摘 2026-10-18。はっきりしたボタンにする) */}
      {file && ready && !status.startup && (!status.server || file.binding) && (
        <div className="sync-panel__row sync-panel__stop">
          {file.enabled
            ? <button className="btn btn-sm" disabled={status.lifecycle?.busy} onClick={() => void act({ kind: "disable" })} title={t("この端末で、この計画の送受信を止めます (サーバーの控えは残ります)")}>{t("同期を止める")}</button>
            : <button className="btn btn-primary btn-sm" disabled={status.lifecycle?.busy} onClick={() => void act({ kind: "enable" })} title={t("止める前の続きから同期します")}>{t("同期を再開する")}</button>}
        </div>
      )}
      {/* 4 段目: 操作の一覧 (履歴・共有リンク・ゴミ箱・別の計画を開く)。押すと、その下に内容が開く */}
      {status.support === "ok" && status.credentials.source !== "none" && <SyncLifecycle status={status} act={act} unsaved={unsaved}/>}
      {/* 5 段目: その他 (技術情報・サインインの手段・契約の管理・取り返しのつかない操作)。ふだんは畳んでおく */}
      {status.support === "ok" && status.server && (
        <details className="sync-panel__details">
          <summary>{t("その他")}</summary>
          <div className="sync-panel__group">
            <div className="sync-panel__group-title">{t("技術情報")}</div>
            <dl className="sync-panel__facts">
              {status.server && <><dt>{t("送り先")}</dt><dd className="break-all">{status.server}</dd></>}
              {file && <><dt>{t("ファイル")}</dt><dd className="break-all">{file.path}</dd></>}
              {status.startup?.opened && <><dt>{t("保存先")}</dt><dd className="break-all">{status.startup.opened.path}</dd></>}
              {file?.binding && status.state !== "signed-out" && <><dt>{t("サーバー ID")}</dt><dd className="sync-panel__id">{file.binding.remoteId}{status.revision ? ` (${t("版")} ${status.revision})` : ""}</dd></>}
            </dl>
            {/* R39-06: 開き直した後の VS Code で退避を取り込む入口。 */}
            <RestoreEntry />
          </div>
          {/* この端末での同期をやめる (結び付けを消す)。サーバーの控えは残るので、取り返しのつかない操作には入れない */}
          {file?.binding && (
            <div className="sync-panel__group">
              <div className="sync-panel__group-title">{t("この端末での同期")}</div>
              <div className="sync-panel__row">
                <button className="btn btn-sm" disabled={status.lifecycle?.busy} onClick={() => void act({ kind: "unbind" })} title={t("結び付けを消します。計画とサーバーの控えは残り、「サーバーの計画を開く」で受け取り直せます")}>{t("この計画の同期をやめる (サーバーの控えは残す)")}</button>
              </div>
            </div>
          )}
          {file?.binding && status.features?.trash !== false && (
            <div className="sync-panel__group sync-panel__group--danger">
              <div className="sync-panel__group-title">{t("削除 (元に戻せません)")}</div>
              <div className="sync-panel__row">
                <button className="btn btn-ghost btn-sm sync-panel__danger" disabled={status.lifecycle?.busy} onClick={() => void act({ kind: "previewDelete", projectId: file.binding!.remoteId })}>{t("この計画をサーバーから削除…")}</button>
              </div>
            </div>
          )}
        </details>
      )}
      <button className="sync-panel__close btn btn-ghost btn-sm" onClick={onClose} aria-label={t("閉じる")}>
        ×
      </button>
    </div>
  );
}

/**
 * 入力: 引数なし。ストアの editorBehind・現在の計画・保存状態・退避結果を読む。
 * 出力: エディタ待ちの説明と退避ボタン、待っていなければ null。
 * R49: 画面とテキストエディタの未保存データを勝手に統合・破棄せず、退避して人が開き直す手順を案内する。
 */
function EditorBehind() {
  const behind = useProjectStore((s) => s.editorBehind);
  const evacuated = useProjectStore((s) => s.evacuated);
  const evacuate = useProjectStore((s) => s.evacuate);
  const contentHash = useProjectStore((s) => s.contentHash);
  const saveState = useProjectStore((s) => s.saveState);
  const project = useProjectStore((s) => s.project);
  const [current, setCurrent] = useState<string>("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (behind) void contentHash().then(setCurrent);
  }, [behind, project, contentHash]);
  if (!behind) return null;
  // 退避後に再編集した場合、古い控えを「退避済み」と案内しない。内容ハッシュで一致を確認する。
  const upToDate = evacuated !== null && evacuated.hash === current;
  const dirty = saveState !== "saved";
  return (
    <div className="sync-panel__halt">
      <div className="sync-panel__line">
        {t("同期で受け取った最新の中身を、VS Code のエディタがまだ読み込んでいません。")}
      </div>
      {dirty ? (
        <div className="sync-panel__line">
          {upToDate
            ? t("退避済み: {path}。ファイルを閉じて開き直し、「退避した編集を読み込む」で見比べてください", {
                path: evacuated!.path,
              })
            : t(
                "画面に未保存の編集があります。先に別のファイルへ退避してから、ファイルを閉じて開き直してください (退避せずに閉じると、この編集は失われます)",
              )}
        </div>
      ) : (
        <div className="sync-panel__line">
          {t("未保存の編集はありません。ファイルを閉じて開き直すと、最新の中身になります")}
        </div>
      )}
      <div className="sync-panel__choices">
        {dirty && !upToDate && (
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void evacuate().finally(() => setBusy(false));
            }}
          >
            {t("編集を退避する")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 入力: 引数なし。ストアの restorePending (比較の基準・段階・競合集合) を読む。
 * 出力: 項目ごとの current / saved の選択欄。比較がなければ null。選択結果は applyRestorePicks へ渡す。
 * R40-03: 選び終わるまで画面にも保存にも反映しない。取り消しても、その段階の前の画面を保持する。
 */
export function RestoreDialog() {
  const pending = useProjectStore((s) => s.restorePending);
  const apply = useProjectStore((s) => s.applyRestorePicks);
  const cancel = useProjectStore((s) => s.cancelRestore);
  const [picks, setPicks] = useState<Record<string, "current" | "saved">>({});
  const [error, setError] = useState<string | null>(null);
  // (欄の中身が作り直されたら、前の選択は捨てる。表示していない値を、古い選択で採らない)
  useEffect(() => {
    setPicks({});
  }, [pending?.basis, pending?.conflicts, pending?.step]);
  if (!pending) return null;
  /** 入力: 任意の項目値 (unknown)。出力: 表示用の文字列。省略は表示だけで、選択には元の値を使う。 */
  const show = (v: unknown) => {
    const text = v === undefined ? t("(消されている)") : typeof v === "string" ? v : JSON.stringify(v);
    return text.length > 80 ? text.slice(0, 80) + "…" : text;
  };
  // (段ごとに、どの退避の版と比べているかを示す。今の値 = この段の前までを取り込んだ、今の画面の値)
  const savedLabel = pending.step === "gui" ? t("退避した画面の値") : t("退避したエディタの値");
  const done = pending.conflicts.every((c) => picks[c.id]);
  return (
    <div className="sync-panel restore-dialog" role="dialog" aria-label={t("退避した編集の取り込み")}>
      {/* (エディタの段: 画面側は取り込み済みで、今の値はその結果。この段をやめても、画面側の取り込みは残る) */}
      {pending.step === "editor" && (
        <div className="sync-panel__line muted">
          {t("画面側の編集は取り込み済みです。「今の値」は、その結果です。")}
        </div>
      )}
      <div className="sync-panel__line">
        {pending.step === "gui"
          ? t(
              "退避した画面の編集と、今の中身で、同じ項目が違う値になっています。項目ごとに、どちらを採るかを選んでください。",
            )
          : t(
              "退避したエディタ側の編集と、今の中身で、同じ項目が違う値になっています。項目ごとに、どちらを採るかを選んでください。",
            )}
      </div>
      {pending.conflicts.map((c) => (
        <div key={c.id} className="sync-panel__halt">
          <div className="sync-panel__id">{c.path}</div>
          {(["current", "saved"] as const).map((k) => (
            <label key={k} className="sync-panel__toggle">
              <input
                type="radio"
                name={c.id}
                checked={picks[c.id] === k}
                onChange={() => setPicks({ ...picks, [c.id]: k })}
              />
              <span>
                {k === "current" ? t("今の値") : savedLabel}: {show(k === "current" ? c.current : c.saved)}
              </span>
            </label>
          ))}
        </div>
      ))}
      {error && <div className="sync-panel__line sync-panel__problem">{error}</div>}
      <div className="sync-panel__choices">
        <button
          className="btn btn-sm"
          disabled={!done}
          onClick={() => {
            const message = apply(picks);
            setError(message);
          }}
        >
          {t("取り込む")}
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            cancel();
            setPicks({});
            setError(null);
          }}
        >
          {pending.step === "editor" ? t("この段をやめる") : t("やめる")}
        </button>
      </div>
    </div>
  );
}

/** 入力: 引数なし。ストアの saveHeld を読む。出力: 自動保存保留の印、保留がなければ null。
 * 取り込み結果の確認前に書かないための保留。解除と実際の保存はストアの Save に任せる。 */
export function SaveHeldChip() {
  const held = useProjectStore((s) => s.saveHeld);
  if (!held) return null;
  return (
    <span
      className="save-chip unsaved"
      title={t("退避した編集を取り込んだので、自動保存を止めています。確かめてから Save で保存してください")}
    >
      {t("自動保存を一時停止中")}
    </span>
  );
}

/** 入力: 引数なし。実行環境・エディタ待ち・比較中かをストアから読む。出力: 取り込みボタンまたは null。
 * R39-06: VS Code のファイル選択を通じて退避を読む。エディタ待ちでは先に開き直すので入口を出さない。 */
function RestoreEntry() {
  const source = useProjectStore((s) => s.source);
  const behind = useProjectStore((s) => s.editorBehind);
  const loadEvacuated = useProjectStore((s) => s.loadEvacuated);
  const pending = useProjectStore((s) => s.restorePending);
  // (取り込みの確認の途中は、新しい退避ファイルを読ませない。R43-02)
  if (source !== "vscode" || behind || pending) return null;
  return (
    <div className="sync-panel__row">
      <button className="btn btn-ghost btn-sm" onClick={loadEvacuated}>
        {t("退避した編集を読み込む")}
      </button>
    </div>
  );
}

/** 入力: SyncStatus の signIn (プロバイダー別の公開案内情報) と取消コールバック。
 * 出力: 認可ページへのリンク、必要ならユーザーコード、取消ボタン。トークン保存・認可の監視はホストに任せる。 */
export function SignInCode({ code, onCancel }: { code: NonNullable<SyncStatus["signIn"]>; onCancel: () => void }) {
  const [copyFailed,setCopyFailed] = useState(false);
  const opened = useAutoOpened(code);
  if (code.provider === "google") {
    return (
      <div className="sync-panel__signin">
        {opened
          ? <div>{t("開いた Google のページで許可してください。終わると、ここに戻って続きます")} <a href={code.url} target="_blank" rel="noreferrer">{t("(開かなかった場合はこちら)")}</a></div>
          : <>
            <div>{code.link ? t("Google を足す: ブラウザで次のページを開き、Google のアカウントで許可してください") : t("ブラウザで次のページを開き、Google のアカウントで許可してください")}</div>
            <a href={code.url} target="_blank" rel="noreferrer">{t("Google のサインインのページを開く")}</a>
          </>}
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>
          {t("中止")}
        </button>
      </div>
    );
  }
  return (
    <div className="sync-panel__signin">
      {/* GitHub はコードを先に見せる (ページへ先に飛ばすと、コードを探すことになる)。コードの下のボタンで、コピーしてから GitHub を開く */}
      <div>{code.link ? t("GitHub を足す: このコードを GitHub のページで入力します") : t("このコードを GitHub のページで入力します")}</div>
      <div className="sync-panel__code-row">
        <span className="sync-panel__code">{code.userCode}</span>
        {/* 貼り付けられなかったときのために、コードだけをコピーする手段も置く */}
        <button className="btn btn-ghost btn-sm" onClick={()=>{ void navigator.clipboard?.writeText(code.userCode).then(()=>setCopyFailed(false)).catch(()=>setCopyFailed(true)); }}>{t("コピー")}</button>
      </div>
      {<button className="btn btn-primary btn-sm" onClick={()=>{
        // クリック内で行う。コピーを先に始めてからページを開く (先に開くと、この画面の焦点が外れてコピーが断られる)。
        // コピーできない環境でもコードを残し、認可を代行しない。
        const copied = navigator.clipboard?.writeText(code.userCode);
        if (copied) copied.then(()=>setCopyFailed(false)).catch(()=>setCopyFailed(true)); else setCopyFailed(true);
        window.open(code.verificationUrl,"_blank","noopener,noreferrer");
      }}>{t("コードをコピーして GitHub を開く")}</button>}
      {copyFailed&&<p role="status">{t("コピーできませんでした。上のコードを入力してください。")}</p>}
      <button className="btn btn-ghost btn-sm" onClick={onCancel}>
        {t("中止")}
      </button>
    </div>
  );
}

/** 入力: 裏方が返す対処先のキー (fix: string)。出力: 翻訳した案内、未知なら空文字列。
 * 選べる操作がない場合も、どこを確かめるか伝える。ここでは修復処理を実行しない。 */
function fixHint(fix: string): string {
  switch (fix) {
    case "server-setting":
      return t("同期先の設定を確認し、https の URL に変更してください。");
    case "local-file":
      return t("手元のファイルを直してください");
    case "sync-state":
      return t("同期の状態のフォルダを確かめてください");
    case "server-content":
      return t("サーバーの中身を確かめてください");
    case "billing":
      return t("右上のアカウントから有料プランを申し込んでください");
    case "credentials":
      return t("サインインを確かめてください");
    case "rerun":
      return t("もう一度同期してください");
    case "wait":
      return t("しばらく待ちます");
    default:
      return "";
  }
}


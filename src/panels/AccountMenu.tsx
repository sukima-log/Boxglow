/**
 * 右上のアカウント: 丸いボタン (サインイン中は頭文字 + 緑の点、未サインインは人型) と、押すと開くメニュー
 *   メニューの中身: 誰で・どの手段で / プラン (申し込み・契約の管理 = 支払い方法の変更・解約) / サインインの手段の追加 / サインアウト / アカウントの削除
 *   同期パネルは同期の状態と計画の操作だけにし、アカウントに関わる設定はここにまとめる (利用者の要望 2026-10-17)
 * Input : なし (店の syncStatus / syncAct を使う)。Output: JSX
 */
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { useProjectStore } from "../store/useProjectStore";
import { TEAM_PLAN_AVAILABLE, billingStatusLabel, planLabel } from "../sync/billing";
import { openBilling } from "./accountActions";
import { SignInButtons, signInOneStep } from "./SignInButtons";
import { SignInCode } from "./SyncPanel";
import { claudeCodeCommand, claudeCodeMcpJson, codexConfig, gitignoreWithMcpJson, mergeMcpJson } from "../sync/agent";

/**
 * Claude Code で開くフォルダを選ばせて、その直下の .mcp.json に boxglow の項目を書く (ブラウザ版。Chrome / Edge の File System Access API)
 * 既にある .mcp.json はほかの項目を残して併合し、.gitignore があれば .mcp.json を足す
 * Input : server, token。Output: 書いたフォルダ名と .gitignore に入れたか。取り消しは null
 */
async function writeMcpJsonToFolder(server: string, token: string): Promise<{ folder: string; gitignored: boolean } | null> {
  if (!window.showDirectoryPicker) return null;
  let dir: FileSystemDirectoryHandle;
  try { dir = await window.showDirectoryPicker({ mode: "readwrite", id: "boxglow-mcp" }); }
  catch (e) { if (e instanceof DOMException && e.name === "AbortError") return null; throw e; }
  const readText = async (name: string): Promise<string | null> => {
    try { return await (await (await dir.getFileHandle(name)).getFile()).text(); }
    catch (e) { if (e instanceof DOMException && e.name === "NotFoundError") return null; throw e; }
  };
  const writeText = async (name: string, text: string): Promise<void> => {
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(text); await w.close();
  };
  await writeText(".mcp.json", mergeMcpJson(await readText(".mcp.json"), server, token));
  const gi = await readText(".gitignore");
  let gitignored = false;
  if (gi !== null) { const next = gitignoreWithMcpJson(gi); if (next !== null) await writeText(".gitignore", next); gitignored = true; }
  return { folder: dir.name, gitignored };
}

/** 文字列をファイルとしてダウンロードさせる (ブラウザ版で設定ファイルを渡す)。Input: name = ファイル名, text = 中身 */
function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 人型の印 (未サインイン) */
function PersonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  );
}

export function AccountButton() {
  const status = useProjectStore((s) => s.syncStatus);
  const act = useProjectStore((s) => s.syncAct);
  const open = useProjectStore((s) => s.accountMenuOpen);
  const setOpen = useProjectStore((s) => s.setAccountMenuOpen);
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 60, right: 8 });
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** AI エージェントの接続: 欄の開閉、作るトークンの名前と権限、コピーしたもの */
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentWrite, setAgentWrite] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  /** ブラウザ版でフォルダを選んで .mcp.json を書いた結果 (ok) か、書けなかった理由 (error) */
  const [picked, setPicked] = useState<{ folder: string; gitignored: boolean } | { error: string } | null>(null);
  const canPickFolder = typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
  useEffect(() => { if (agentOpen && status?.credentials.account && !status.agent) void act({ kind: "listAgentTokens" }); }, [agentOpen, !!status?.credentials.account]);
  const account = status?.credentials.account;
  const initial = account ? (account.display.trim()[0] ?? "?").toUpperCase() : null;
  useEffect(() => {
    if (!open) { setConfirmDelete(false); return; }
    // 入口の下に、画面基準で置く (帯は横にスクロールするので絶対配置では切れる)
    const place = () => {
      const box = ref.current?.getBoundingClientRect();
      if (box) setPosition({ top: box.bottom + 6, right: Math.max(8, window.innerWidth - box.right) });
    };
    const close = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", escape);
    return () => { window.removeEventListener("resize", place); document.removeEventListener("pointerdown", close, true); document.removeEventListener("keydown", escape); };
  }, [open, setOpen]);
  // サインアウトしたら閉じる
  useEffect(() => { if (!account) setConfirmDelete(false); }, [!!account]);
  const billing = account?.billing;
  return (
    <div className="account-wrap" ref={ref}>
      <button className="account-button" data-on={account ? "true" : "false"} onClick={() => setOpen(!open)} aria-haspopup="dialog" aria-expanded={open}
        title={account ? t("アカウント: {name}", { name: account.display }) : t("アカウント (サインインしていません)")} aria-label={t("アカウント")}>
        {initial ? <span className="account-button__initial">{initial}</span> : <PersonIcon />}
        {account && <span className="account-button__dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="account-menu card" role="dialog" aria-label={t("アカウント")} style={{ top: position.top, right: position.right }}>
          {!status ? (
            <p className="muted">{t("このページではアカウントと同期を使えません (boxglow.app か、npx boxglow serve --sync、VS Code の拡張で使えます)")}</p>
          ) : !account ? (
            <>
              <div className="account-menu__head"><PersonIcon /><span>{t("サインインしていません")}</span></div>
              {status.signIn && !status.signIn.link
                ? <SignInCode code={status.signIn} onCancel={() => void act({ kind: "cancelSignIn" })} />
                : status.support === "ok" && status.server && status.credentials.source !== "env" && <SignInButtons act={act} />}
              {status.credentials.source === "env" && <p className="muted">{t("環境変数のトークンで同期しています")}</p>}
            </>
          ) : (
            <>
              <div className="account-menu__head">
                <span className="account-button account-button--static" data-on="true"><span className="account-button__initial">{initial}</span></span>
                <div className="account-menu__who">
                  <span className="sync-account__name">{account.display}</span>
                  <span className="sync-account__via">{account.signedInWith === "google" ? "Google" : account.signedInWith === "github" ? "GitHub" : ""}</span>
                </div>
              </div>
              {/* プラン: 状態と、申し込み / 契約の管理 (支払い方法の変更・解約は Stripe の画面) */}
              {billing && (billing.required || billing.plan || billing.checkout) && (
                <div className="sync-panel__group">
                  <div className="sync-panel__group-title">{t("プラン")}</div>
                  <div className="sync-panel__row">
                    <span className="sync-account__plan" data-entitled={billing.entitled ? "true" : "false"}>{billing.plan ? planLabel(billing.plan) : t("未契約")}{billing.plan === "team" && billing.seats > 0 ? ` × ${billing.seats}` : ""}</span>
                    {billing.plan && billing.plan !== "comp" && <span className="muted">{billingStatusLabel(billing.status)}{billing.periodEnd ? ` · ${t("次の更新")} ${billing.periodEnd.slice(0, 10)}` : ""}</span>}
                  </div>
                  {billing.checkout && (!billing.plan || !billing.entitled) && (
                    <div className="sync-panel__row">
                      <button className="btn btn-primary btn-sm" onClick={() => void openBilling(act, { kind: "billingCheckout", plan: "personal" })}>{t("Personal を申し込む (月 500 円)")}</button>
                      {TEAM_PLAN_AVAILABLE && <button className="btn btn-sm" onClick={() => void openBilling(act, { kind: "billingCheckout", plan: "team", seats: 2 })}>{t("Team を申し込む (1 人 月 800 円)")}</button>}
                    </div>
                  )}
                  {billing.portal && (
                    <div className="sync-panel__row">
                      <button className="btn btn-sm" onClick={() => void openBilling(act, { kind: "billingPortal" })}>{t("契約の管理 (支払い方法・解約)")}</button>
                    </div>
                  )}
                  {status.billingLink && (
                    <div className="sync-panel__row sync-panel__billing-link">
                      <a href={status.billingLink.url} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm">
                        {status.billingLink.kind === "checkout" ? t("申し込みの画面を開く (Stripe)") : t("契約の管理を開く (Stripe)")}
                      </a>
                      <button className="btn btn-ghost btn-sm" onClick={() => void act({ kind: "billingDismiss" })}>{t("閉じる")}</button>
                    </div>
                  )}
                  {status.message && <div className="sync-panel__line muted">{status.message}</div>}
                </div>
              )}
              {/* サインインの手段: 付いているものを記号で示し、無い方は「+」で足せる */}
              {account.identities && status.credentials.source === "stored" && (
                <div className="sync-panel__group">
                  <div className="sync-panel__group-title">{t("サインインの手段")}</div>
                  {status.signIn?.link
                    ? <SignInCode code={status.signIn} onCancel={() => void act({ kind: "cancelSignIn" })} />
                    : <div className="sync-panel__row sync-panel__identities" title={t("このアカウントのサインインの手段。もう一方を足すと、どちらでサインインしても同じアカウントになります")}>
                      {(["github", "google"] as const).map((p) => account.identities!.includes(p)
                        ? <span key={p} className="sync-panel__identity" data-on="true">{p === "github" ? "GitHub" : "Google"} ✓</span>
                        : <button key={p} className="btn btn-ghost btn-sm" onClick={() => void signInOneStep(act, p, true)} title={p === "github" ? t("GitHub でもサインインできるようにする") : t("Google でもサインインできるようにする")}>+ {p === "github" ? "GitHub" : "Google"}</button>)}
                    </div>}
                </div>
              )}
              {/* AI エージェントの接続: 計画ごと・権限ごとのトークン。トークンは作ったときだけ表示 (サーバーはハッシュしか持たない) */}
              {status.server && (
                <div className="sync-panel__group">
                  <button className="sync-action" data-open={agentOpen ? "true" : "false"} aria-expanded={agentOpen} onClick={() => setAgentOpen(!agentOpen)}>
                    <span className="sync-action__icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/></svg></span>
                    <span className="sync-action__text"><span className="sync-action__label">{t("AI エージェントの接続")}</span><span className="sync-action__hint">{t("手元にファイルが無い端末やクラウドの AI 向け。この計画をサーバー経由で読み書きさせる (手元で開いている計画には不要)")}</span></span>
                    <span className="sync-action__chev" aria-hidden="true">{agentOpen ? "▾" : "▸"}</span>
                  </button>
                  {agentOpen && (
                    <div className="agent-tokens">
                      {!status.file?.binding ? (
                        <p className="muted">{t("今開いている計画をサーバーに置くと、AI エージェントをつなげます")}</p>
                      ) : (
                        <div className="agent-tokens__new">
                          <label className="sync-switch" title={t("オフにすると、読む道具だけが使えます")}>
                            <input type="checkbox" checked={agentWrite} onChange={(e) => setAgentWrite(e.target.checked)} />
                            <span className="sync-switch__track" aria-hidden="true"><span className="sync-switch__knob" /></span>
                            <span>{t("書き込みも許可")}</span>
                          </label>
                          <div className="sync-panel__row">
                            <button className="btn btn-primary btn-sm" disabled={status.agent?.busy} title={status.features?.agentConfig ? t("この計画のフォルダに、Claude Code が読む設定ファイル .mcp.json を作ります (あれば項目を足します)") : t("設定ファイルを作り、置き方を案内します")} onClick={() => { setCopied(null); setPicked(null); void act({ kind: "connectAgent", projectId: status.file!.binding!.remoteId, target: "claude-code", write: agentWrite }); }}>{t("Claude Code に接続")}</button>
                            <button className="btn btn-sm" disabled={status.agent?.busy} title={status.features?.agentConfig ? t("ホームフォルダの .codex/config.toml に設定を書きます") : t("設定を作り、置き方を案内します")} onClick={() => { setCopied(null); void act({ kind: "connectAgent", projectId: status.file!.binding!.remoteId, target: "codex", write: agentWrite }); }}>{t("Codex に接続")}</button>
                          </div>
                        </div>
                      )}
                      {status.agent?.error && <p role="alert" className="sync-panel__problem">{status.agent.error}</p>}
                      {status.agent?.connected && (
                        <div className="agent-tokens__token agent-connect">
                          {status.agent.connected.wrote ? (
                            <>
                              <strong>{status.agent.connected.target === "codex" ? t("Codex に接続しました") : t("Claude Code に接続しました")}</strong>
                              <p className="muted break-all">{t("設定を書きました")}: {status.agent.connected.path}{status.agent.connected.target === "claude-code" && status.agent.connected.gitignored ? ` (${t(".gitignore にも追加")})` : ""}</p>
                              {status.agent.connected.target === "claude-code" && !status.agent.connected.gitignored && <p className="muted">{t("このファイルにはトークンが入るので、共有やコミットをしないでください")}</p>}
                              <p>{status.agent.connected.target === "codex" ? t("Codex を開き直すと、boxglow のツールが使えます") : t("Claude Code を開き直すと、boxglow のツールが使えます。初回に「このプロジェクトの MCP サーバーを使うか」と聞かれたら許可してください")}</p>
                            </>
                          ) : status.agent.newToken && status.agent.connected.target === "claude-code" ? (
                            <>
                              {canPickFolder ? (
                                <>
                                  <strong>{picked && "folder" in picked ? t("Claude Code に接続しました") : t("あと 2 手順で Claude Code から使えます")}</strong>
                                  <ol className="agent-connect__steps">
                                    <li>
                                      {picked && "folder" in picked
                                        ? <span>{t("設定を書きました")}: {picked.folder}/.mcp.json{picked.gitignored ? ` (${t(".gitignore にも追加")})` : ""}</span>
                                        : <><button className="btn btn-primary btn-sm" onClick={() => { void writeMcpJsonToFolder(status.server!, status.agent!.newToken!.token).then((r) => { if (r) setPicked(r); }).catch((e) => setPicked({ error: e instanceof Error ? e.message : String(e) })); }}>{t("フォルダを選んで設定を書く")}</button> <span className="muted">{t("Claude Code で開くフォルダ (プロジェクトの直下) を選ぶと、Claude Code が読む設定ファイル .mcp.json をそこに作ります (あれば boxglow の項目を足します)")}</span></>}
                                      {picked && "error" in picked && <span role="alert" className="sync-panel__problem"> {t("書けませんでした")}: {picked.error}</span>}
                                    </li>
                                    <li>{t("Claude Code を開き直す。初回に「このプロジェクトの MCP サーバーを使うか」と聞かれたら許可する")}</li>
                                  </ol>
                                  {picked && "folder" in picked && !picked.gitignored && <p className="muted">{t("このファイルにはトークンが入るので、共有やコミットをしないでください")}</p>}
                                </>
                              ) : (
                                <>
                                  <strong>{t("あと 3 手順で Claude Code から使えます")}</strong>
                                  <ol className="agent-connect__steps">
                                    <li><button className="btn btn-primary btn-sm" onClick={() => { downloadText(".mcp.json", claudeCodeMcpJson(status.server!, status.agent!.newToken!.token)); setCopied("download"); }}>{t("設定ファイル (.mcp.json) をダウンロード")}</button>{copied === "download" && <span className="muted"> {t("保存しました")}</span>}</li>
                                    <li>{t("保存したファイルの名前が mcp.json になっていたら、先頭に . を付けて .mcp.json にし、Claude Code で開くフォルダの直下に置く (既に .mcp.json があるなら、中の boxglow の項目を足す)")}</li>
                                    <li>{t("Claude Code を開き直す。初回に「このプロジェクトの MCP サーバーを使うか」と聞かれたら許可する")}</li>
                                  </ol>
                                </>
                              )}
                              <p className="muted">{t("CLI の claude を使う場合は、コマンド 1 つで済みます")}: <button className="btn btn-ghost btn-sm" onClick={() => { void navigator.clipboard?.writeText(claudeCodeCommand(status.server!, status.agent!.newToken!.token)).then(() => setCopied("claude")).catch(() => setCopied(null)); }}>{copied === "claude" ? t("コピーしました") : t("登録コマンドをコピー")}</button></p>
                            </>
                          ) : status.agent.newToken && (
                            <>
                              <strong>{t("あと 3 手順で Codex から使えます")}</strong>
                              <ol className="agent-connect__steps">
                                <li><button className="btn btn-primary btn-sm" onClick={() => { void navigator.clipboard?.writeText(codexConfig(status.server!, status.agent!.newToken!.token)).then(() => setCopied("codex")).catch(() => setCopied(null)); }}>{copied === "codex" ? t("コピーしました") : t("設定をコピー")}</button></li>
                                <li>{t("ホームフォルダの .codex/config.toml を開き (無ければ作る)、末尾に貼り付けて保存する")}</li>
                                <li>{t("Codex を開き直す")}</li>
                              </ol>
                            </>
                          )}
                          <div className="sync-panel__row"><button className="btn btn-ghost btn-sm" onClick={() => { setCopied(null); setPicked(null); void act({ kind: "agentTokenDismiss" }); }}>{t("閉じる")}</button></div>
                        </div>
                      )}
                      {status.agent?.tokens?.map((tk) => (
                        <div className="sync-project-row agent-tokens__row" key={tk.id} data-off={tk.revoked ? "true" : "false"}>
                          <strong>{tk.name}</strong>
                          <small>{tk.write ? t("読み書き") : t("読み取り専用")} · {tk.projectId}{tk.requests > 0 ? ` · ${t("{n} 回", { n: String(tk.requests) })}` : ""}{tk.revoked ? ` · ${t("失効")}` : ""}</small>
                          {!tk.revoked && <button className="btn btn-ghost btn-sm" disabled={status.agent?.busy} onClick={() => void act({ kind: "revokeAgentToken", id: tk.id })}>{t("失効")}</button>}
                        </div>
                      ))}
                      {status.agent?.tokens?.length === 0 && <p className="muted">{t("トークンはまだありません。")}</p>}
                    </div>
                  )}
                </div>
              )}
              <div className="sync-panel__group">
                <button className="btn btn-sm" title={t("この端末の同期を止めてサインアウトします。手元の計画は残ります")} onClick={() => { setOpen(false); void act({ kind: "signOut" }); }}>{t("サインアウト")}</button>
              </div>
              {/* アカウントの削除: 欄の中で 2 段階の確認 (元に戻せない操作) */}
              <div className="sync-panel__group sync-panel__group--danger">
                <div className="sync-panel__group-title">{t("削除 (元に戻せません)")}</div>
                {confirmDelete ? (
                  <div className="sync-panel__confirm-delete" role="group" aria-label={t("アカウントの削除の確認")}>
                    <div>{t("サーバーの計画は 30 日後に消えます (それまでは support@boxglow.app への連絡で取り消せます)。手元のファイルは残ります。")}</div>
                    <div className="sync-panel__actions">
                      <button className="btn btn-sm btn-danger" onClick={() => { setConfirmDelete(false); setOpen(false); void act({ kind: "deleteAccount" }); }}>{t("アカウントを削除する")}</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(false)}>{t("やめる")}</button>
                    </div>
                  </div>
                ) : (
                  <button className="btn btn-ghost btn-sm sync-panel__danger" onClick={() => setConfirmDelete(true)}>{t("アカウントを削除…")}</button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

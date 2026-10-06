/**
 * boxglow login / logout / whoami: 同期サーバーへのサインイン (GitHub の端末向けの手順を、サーバーが仲立ちする)
 *   login : サーバーに手順を始めさせ、表示されたコードを利用者がブラウザで入力する。許可されたら、サーバーが発行したトークンを保存する
 *   logout: 保存済みのトークンを、サーバー側で取り消してから、手元を消す
 *   whoami: 今のトークンの利用者と、端末・使用量を表示する
 * トークンは、表示しない・ログに出さない。https 以外のサーバーには送らない (localhost を除く)。リダイレクトには従わない
 */
import { hostname } from "node:os";
import { t } from "../../src/i18n/core";
import { APP_VERSION } from "../../src/model/version";
import { CredentialsBusy, CredentialsSaveFailed, CredentialsUnsafe, inspectCredentials, removeCredentials, resolveToken, saveCredentials, withCredentialsLock } from "./credentials";
import { normalizeServer } from "./state-store";

export interface LoginOptions {
  server: string;
  /** 出力の関数 */
  out: (text: string) => void;
  /** 通信の関数 (試験で差し替える) */
  fetch?: typeof fetch;
  /** 待つ関数 (ms。試験で差し替える) */
  sleep?: (ms: number) => Promise<void>;
  /** 端末の名前 (省略時は、マシンの名前) */
  deviceName?: string;
  /** コードが発行されたときに呼ぶ (画面の裏方が、コードと URL を画面に出すために使う。表示は out にも出る) */
  onCode?: (code: { userCode: string; verificationUrl: string; expiresAt: string }) => void;
  /** 中止の合図 (true を返したら、待つのをやめて失敗として終える。発行済みのトークンは無い) */
  cancelled?: () => boolean;
}

/** サーバーの場所が、トークンを送ってよい場所か (https、または手元の http) */
export function serverProblem(server: string): string | null {
  let url: URL;
  try { url = new URL(server); } catch { return t("サーバーの場所が URL として読めません: {server}", { server }); }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
  return t("https ではないサーバーには、サインインしません (手元の localhost を除く): {server}", { server });
}

const headers = (token?: string): Record<string, string> => ({ ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", "x-boxglow-version": APP_VERSION });

/** 今のトークンを、サーバー側で取り消す。Output: 取り消せたら true (通信できなければ false) */
async function revoke(server: string, token: string, doFetch: typeof fetch): Promise<boolean> {
  try { const res = await doFetch(`${server}/v1/tokens/current`, { method: "DELETE", headers: headers(token), redirect: "error" }); return res.status === 200 || res.status === 401; } catch { return false; }
}

/**
 * boxglow login
 * Output: 終了コード (0 = サインインした, 1 = できなかった)
 */
export async function runLogin(o: LoginOptions): Promise<number> {
  const { out } = o;
  const doFetch = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const problem = serverProblem(o.server);
  if (problem) { out(problem); return 1; }
  const server = normalizeServer(o.server);
  try {
    return await withCredentialsLock(server, async () => {
      // 保存済みの資格情報が「在るが、安全に読めない」なら、始めない (誰のものか確かめられないまま、置き換えない)
      const stored = inspectCredentials(server);
      if (stored.kind === "unusable") {
        out(t("保存済みの資格情報がありますが、安全に読めません: {reason}", { reason: stored.reason }));
        out(t("誰のサインインかを確かめられないので、置き換えません。ファイルを確かめて、直すか、消してから、もう一度実行してください: {path}", { path: stored.path }));
        return 1;
      }
      const previous = stored.kind === "valid" ? stored.credentials : null;
      // ---- 手順を始める ----
      let started: { device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number };
      try {
        const res = await doFetch(`${server}/v1/auth/device`, { method: "POST", headers: headers(), redirect: "error" });
        if (res.status === 429) { out(t("サインインの要求が多すぎます。少し待ってから、もう一度実行してください")); return 1; }
        if (res.status === 503) { out(t("サーバーは保守中です。しばらくしてから、もう一度実行してください")); return 1; }
        if (!res.ok) { out(t("サインインを始められませんでした (サーバーの応答: {status})", { status: res.status })); return 1; }
        started = await res.json() as typeof started;
        if (typeof started.device_code !== "string" || typeof started.user_code !== "string" || typeof started.verification_uri !== "string") throw new Error("bad response");
      } catch (e) { out(t("サーバーと通信できませんでした: {message}", { message: e instanceof Error ? e.message : String(e) })); return 1; }
      out(t("ブラウザで次のページを開き、コードを入力してください (GitHub のアカウントで許可します):"));
      out(`  ${started.verification_uri}`);
      out(t("  コード: {code}", { code: started.user_code }));
      out(t("許可されるのを待っています... (中止は Ctrl+C)"));
      // ---- 許可されるまで、決められた間隔で確かめる ----
      let interval = Math.max(1, Number(started.interval) || 5);
      const deadline = Date.now() + Math.max(1, Number(started.expires_in) || 900) * 1000;
      o.onCode?.({ userCode: started.user_code, verificationUrl: started.verification_uri, expiresAt: new Date(deadline).toISOString() });
      let issued: { token: string; account: string; login: string } | null = null;
      while (issued === null) {
        await sleep(interval * 1000);
        // 中止された (画面のキャンセル・サインアウト): 待つのをやめる。遅れて許可されても、この手順ではトークンを受け取らない
        if (o.cancelled?.()) { out(t("サインインを中止しました")); return 1; }
        if (Date.now() > deadline) { out(t("コードの期限が切れました。もう一度 boxglow login を実行してください")); return 1; }
        let res: Response;
        try {
          res = await doFetch(`${server}/v1/auth/device/token`, { method: "POST", headers: headers(), redirect: "error"
          , body: JSON.stringify({ device_code: started.device_code, device_name: (o.deviceName ?? hostname()).slice(0, 64) }) });
        } catch { continue; } // 通信の失敗は、次の間隔でやり直す (期限まで)
        if (res.status === 429) { interval = Math.max(interval, Number(res.headers.get("retry-after")) || 60); continue; }
        if (res.status === 502 || res.status === 503) continue;
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        if (res.status === 200 && body.status === "pending") continue;
        if (res.status === 200 && body.status === "slow_down") { interval = Math.max(interval + 5, Number(body.interval) || 0); continue; }
        if (res.status === 200 && body.status === "ok" && typeof body.token === "string" && typeof body.account === "string") {
          // (待っている間に中止されていたら、受け取ったトークンは保存せずに取り消す)
          if (o.cancelled?.()) { await revoke(server, body.token, doFetch); out(t("サインインを中止しました")); return 1; }
          issued = { token: body.token, account: body.account, login: String(body.login ?? "") };
          break;
        }
        if (res.status === 403 && body.code === "not-invited") {
          out(t("この GitHub のアカウント ({login}) は、まだ招待されていません。同期は、招待した利用者だけが使えます", { login: String(body.login ?? "?") }));
          if (typeof body.waitlist === "string") out(t("順番待ちの登録: {url}", { url: body.waitlist }));
          return 1;
        }
        if (res.status === 403 && body.code === "suspended") { out(t("このアカウントは、止められています")); return 1; }
        if (res.status === 403 && body.code === "too-many-devices") { out(t("サインイン済みの端末が上限に届いています。使っていない端末で boxglow logout を実行してから、もう一度試してください")); return 1; }
        if (body.code === "access_denied") { out(t("許可されませんでした (ブラウザで拒否されました)")); return 1; }
        if (body.code === "expired_token") { out(t("コードの期限が切れました。もう一度 boxglow login を実行してください")); return 1; }
        out(t("サインインできませんでした (サーバーの応答: {status} {code})", { status: res.status, code: String(body.code ?? "") }));
        return 1;
      }
      // ---- 保存する。すでに別の利用者でサインイン済みなら、黙って置き換えない ----
      if (previous && previous.account !== issued.account) {
        const revoked = await revoke(server, issued.token, doFetch);
        out(t("このサーバーには、すでに {current} としてサインインしています。{next} に替えるには、先に boxglow logout を実行してください", { current: previous.login, next: issued.login }));
        if (!revoked) out(t("(今回発行されたトークンを、サーバー側で取り消せませんでした。使われないトークンが残っています)"));
        return 1;
      }
      try {
        saveCredentials({ server, account: issued.account, login: issued.login, token: issued.token, createdAt: new Date().toISOString() });
      } catch (e) {
        // 保存できなかった (権限の確認の失敗でも、ふつうのファイル操作の失敗でも): 新しいトークンは、使い続ける前提にしない。取り消しを試みる
        const revoked = await revoke(server, issued.token, doFetch);
        const failed = e instanceof CredentialsSaveFailed ? e : null;
        out(t("資格情報を、安全に保存できませんでした: {reason}", { reason: failed ? failed.reason : e instanceof Error ? e.message : String(e) }));
        if (failed && !failed.restored) out(failed.backup
          ? t("今までの資格情報を、元の場所に戻せませんでした。控えはここにあります: {path}", { path: failed.backup })
          : t("資格情報の置き場に、今回のファイルが残っているかもしれません。確かめてください"));
        out(revoked ? t("今回発行されたトークンは、取り消しました。") : t("今回発行されたトークンを、サーバー側で取り消せませんでした (まだ有効かもしれません)。"));
        out(t("保存せずに使うには、トークンを環境変数 BOXGLOW_TOKEN で渡してください"));
        return 1;
      }
      // 保存に成功してから、古いトークンを取り消す (同じ利用者のサインインし直し)
      if (previous && previous.token !== issued.token) await revoke(server, previous.token, doFetch);
      out(t("サインインしました: {login} ({account})", { login: issued.login, account: issued.account }));
      if (process.env.BOXGLOW_TOKEN) out(t("注意: 環境変数 BOXGLOW_TOKEN が設定されています。同期では、保存したサインインより、そちらが優先されます"));
      return 0;
    });
  } catch (e) {
    if (e instanceof CredentialsBusy) { out(t("ほかの boxglow login / logout が動いています。終わってから、もう一度実行してください")); return 1; }
    if (e instanceof CredentialsUnsafe) { out(t("資格情報を、安全に保存できません: {reason}", { reason: e.reason })); out(t("保存せずに使うには、トークンを環境変数 BOXGLOW_TOKEN で渡してください")); return 1; }
    throw e;
  }
}

/**
 * boxglow logout: 保存済みの資格情報だけを対象にする (環境変数のトークンは、取り消さない)
 * Output: 終了コード
 */
export async function runLogout(o: Pick<LoginOptions, "server" | "out" | "fetch">): Promise<number> {
  const { out } = o;
  const doFetch = o.fetch ?? fetch;
  const server = normalizeServer(o.server);
  try {
    return await withCredentialsLock(server, async () => {
      const stored = inspectCredentials(server);
      // 「在るが、安全に読めない」は、サインアウトできたとも、サインインしていないとも言わない (ファイルもトークンも残っている)
      if (stored.kind === "unusable") {
        out(t("保存済みの資格情報がありますが、安全に読めません: {reason}", { reason: stored.reason }));
        out(t("サインアウトは、できていません (ファイルが残っていて、サーバー側のトークンも有効なままかもしれません)。ファイルを確かめてください: {path}", { path: stored.path }));
        return 1;
      }
      const saved = stored.kind === "valid" ? stored.credentials : null;
      if (!saved) { out(t("このサーバーには、サインインしていません")); }
      else {
        const revoked = serverProblem(server) === null && await revoke(server, saved.token, doFetch);
        removeCredentials(server);
        out(revoked ? t("サインアウトしました (サーバー側のトークンも取り消しました)") : t("手元の資格情報を消しました。サーバーと通信できなかったので、サーバー側のトークンは取り消せていません (期限まで有効です)"));
      }
      if (process.env.BOXGLOW_TOKEN) out(t("環境変数 BOXGLOW_TOKEN は、この操作では取り消されません (同期では、引き続きそのトークンが使われます)"));
      return 0;
    });
  } catch (e) {
    if (e instanceof CredentialsBusy) { out(t("ほかの boxglow login / logout が動いています。終わってから、もう一度実行してください")); return 1; }
    // 置き場のフォルダを確かめられない: サインインしていない、とは言わない
    if (e instanceof CredentialsUnsafe) {
      out(t("資格情報の置き場を、安全に確かめられません: {reason}", { reason: e.reason }));
      out(t("サインアウトは、できていません (資格情報のファイルが残っているかもしれません)"));
      return 1;
    }
    throw e;
  }
}

/**
 * boxglow whoami: 今のトークン (環境変数 > 保存済み) の利用者と、端末・使用量を表示する
 * Output: 終了コード
 */
export async function runWhoami(o: Pick<LoginOptions, "server" | "out" | "fetch">): Promise<number> {
  const { out } = o;
  const server = normalizeServer(o.server);
  const problem = serverProblem(server);
  if (problem) { out(problem); return 1; }
  const resolved = resolveToken(server);
  if (!resolved) { out(t("サインインしていません。boxglow login --server {server} を実行してください", { server })); return 1; }
  let res: Response;
  try { res = await (o.fetch ?? fetch)(`${server}/v1/me`, { headers: headers(resolved.token), redirect: "error" }); }
  catch (e) { out(t("サーバーと通信できませんでした: {message}", { message: e instanceof Error ? e.message : String(e) })); return 1; }
  if (res.status === 401 || res.status === 403) { out(authHint(resolved.source, res.status)); return 1; }
  if (!res.ok) { out(t("サーバーの応答: {status}", { status: res.status })); return 1; }
  const me = await res.json() as { account?: string; login?: string; devices?: { name: string; current?: boolean; lastUsedAt?: string | null }[]; usage?: { projects: number; contentBytes: number }; limits?: { projects: number; contentBytes: number } };
  out(t("利用者: {login} ({account})", { login: me.login ?? "-", account: me.account ?? "-" }));
  out(t("トークンの出どころ: {source}", { source: resolved.source === "env" ? t("環境変数 BOXGLOW_TOKEN") : t("保存済みのサインイン") }));
  if (me.usage) {
    const mb = (n: number) => (n / 1_000_000).toFixed(1) + " MB";
    out(t("計画: {count} 個{limit}", { count: me.usage.projects, limit: me.limits ? ` / ${me.limits.projects}` : "" }));
    out(t("保存量: {used}{limit}", { used: mb(me.usage.contentBytes), limit: me.limits ? ` / ${mb(me.limits.contentBytes)}` : "" }));
  }
  for (const d of me.devices ?? []) out(`  - ${d.name}${d.current ? " " + t("(この端末)") : ""}`);
  return 0;
}

/**
 * 利用者を確かめられなかったときの案内 (使ったトークンの出どころで変える)
 * Input : source = トークンの出どころ ("env" / "file" / null = 無し), status = 応答の状態コード
 */
export function authHint(source: "env" | "file" | null, status: number): string {
  if (status === 403) return t("このアカウントでは、同期を使えません (止められている、または招待されていません)");
  if (source === "env") return t("環境変数 BOXGLOW_TOKEN のトークンが無効です。直すか、外してください (外すと、保存済みのサインインを使います)");
  if (source === "file") return t("保存済みのサインインが無効になっています (期限切れ・取り消し)。boxglow login をやり直してください");
  return t("サインインしていません。boxglow login --server <URL> を実行してください (または、環境変数 BOXGLOW_TOKEN)");
}

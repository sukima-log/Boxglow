/** 同期先の選択。未指定と明示的な無効を分け、既存の結び付けを既定値で移さない。 */
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { bindingsOf, configDir, hashOf, normalizeServer, realFile } from "./state-store";
import { commitFile, revisionOf } from "../file-store";
import { t } from "../../src/i18n/core";
import { DEFAULT_SYNC_SERVER, environmentTokenAllowed } from "./server-policy";
export { DEFAULT_SYNC_SERVER } from "./server-policy";
/** 選択の根拠は自動開始に使う。認証は送り先URLで毎回判定する。 */
export interface SyncServerSelection {
  server: string | null;
  source: "explicit" | "environment" | "binding" | "default";
  /** 表示・検査用の現在値。実送信はresolveTokenが改めて検査する。 */
  allowEnvironmentToken: boolean;
}
/** 入力: 明示値・環境値・対象。出力: 送り先と選択根拠。読み取りだけで通信しない。 */
export function selectSyncServer(file?: string, explicit?: string | null, environment = process.env.BOXGLOW_SERVER): SyncServerSelection {
  const configured = explicit !== undefined || !!environment?.trim();
  if (configured) {
    const chosen = explicit !== undefined ? explicit : environment!;
    const source = explicit !== undefined ? "explicit" : "environment";
    const server = chosen === null || !chosen.trim() || chosen.trim().toLowerCase() === "off" ? null : normalizeServer(chosen.trim());
    return { server, source, allowEnvironmentToken: server !== null && environmentTokenAllowed(server) };
  }
  if (file) {
    const { bindings, unreadable } = bindingsOf(file);
    if (unreadable.length) throw new Error(t("同期の状態のフォルダを確かめてください"));
    if (bindings.length > 1) throw new Error(t("同期先を明示してください。複数の結び付けがあります。"));
    if (bindings.length === 1) return { server: bindings[0].server, source: "binding", allowEnvironmentToken: environmentTokenAllowed(bindings[0].server) };
  }
  return { server: DEFAULT_SYNC_SERVER, source: "default", allowEnvironmentToken: environmentTokenAllowed(DEFAULT_SYNC_SERVER) };
}
/** 送り先だけが必要な呼出元向け。認証情報はresolveTokenの共通規則で選ぶ。 */
export function syncServerFor(file?: string, explicit?: string | null, environment = process.env.BOXGLOW_SERVER): string | null {
  return selectSyncServer(file, explicit, environment).server;
}
/** 有効化の記憶は計画JSONの外、ファイルとサーバーごと。未指定の起動でのみ復元する。 */
const preferencePath = (file: string, server: string) => join(configDir(), "sync-enabled", hashOf(JSON.stringify([realFile(file), normalizeServer(server)])) + ".json");
export function syncWasEnabled(file: string, server: string): boolean | undefined {
  try {
    return JSON.parse(readFileSync(preferencePath(file, server), "utf8")).enabled === true;
  }
  catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? undefined : false;
  }
}
/** 入力: 実ファイル・送り先・有効化の意図。出力: CASで更新したホスト側の設定。 */
export function rememberSync(file: string, server: string, enabled: boolean): void {
  const path = preferencePath(file, server);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  let previous: string | null = null;
  try {
    previous = readFileSync(path, "utf8");
  }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      throw e;
  }
  commitFile(path, JSON.stringify({ enabled }) + "\n", previous === null ? null : revisionOf(previous));
  chmodSync(path, 0o600);
}

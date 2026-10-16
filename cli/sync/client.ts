/**
 * 同期の実行 (Node の入口): 計画のファイルと設定フォルダの状態 (cli/sync/node-io.ts) を、同期の本体 (src/sync/run.ts) につなぐ
 * 本体は環境に依存せず、ブラウザだけの画面 (src/sync/browser-io.ts) からも同じものを使う
 */
import { hashOf, normalizeServer } from "./state-store";
import { nodeSyncIO } from "./node-io";
import { runSync, recoveryToken as runRecoveryToken, type SyncOptions, type SyncResult } from "../../src/sync/run";
import type { RemoteMark, SyncState } from "../../src/sync/engine";

export {
  fetchHeads, unquote, bindingIdOf, normalizeServer, stateVersionOf
, SyncNetworkError, SyncConfigurationError, SyncAuthError, SyncRejectedError, HumanSyncRequired
, type SyncResult, type SyncResultWithGeneration, type ClientHalt, type SyncOptions
} from "../../src/sync/run";

/** 止まっている「受け取りの再開」の印 (Node のハッシュで) */
export function recoveryToken(state: SyncState, localHash: string | null, remote: RemoteMark, bindingId: string): string {
  return runRecoveryToken(state, localHash, remote, bindingId, hashOf);
}

/**
 * 1 回の同期 (手元とサーバーがそろうか、止まるまで)
 * Input : options = SyncOptions (file = 計画のファイル)
 * Output: SyncResult。通信の失敗は SyncNetworkError (やりかけの操作は残る。もう一度実行すれば続きから)
 */
export async function syncOnce(options: SyncOptions & { file: string }): Promise<SyncResult> {
  return runSync(options, nodeSyncIO(options.file, normalizeServer(options.server)));
}

/**
 * 同期の入出力 (SyncIO) の Node 実装: 計画のファイルと、設定フォルダの同期の状態 (cli/sync/state-store.ts) をつなぐ
 *   - 手元 = boxglow.json (commitFile: ロック + 版の照合 + 原子的な置換)
 *   - 状態 = 結び付けのフォルダ (state.json・objects・relinks)
 *   - ロック = ファイルのロック (lockFileSync) と状態のロック (StateStore.lock)
 * 同期の fs 呼び出しを async で包むだけで、個々の操作の原子性は従来のまま
 */
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { commitFile, FileBusy, FileConflict } from "../file-store";
import { LocalBusy, LocalConflict, type SyncIO, type SyncStoredState } from "../../src/sync/io";
import { bindingDir, bindingsOf, hashOf, lockFileSync, realFile, StateStore } from "./state-store";

/**
 * Node の入出力を組み立てる
 * Input : file = 計画のファイル (実パスに直す), server = サーバーの URL (末尾のスラッシュは除いたもの)
 * Output: SyncIO
 */
/**
 * この端末の結び付け (同期の状態のフォルダ) を消す (「結び付けを解除する」)。計画のファイルとサーバーの控えは残る
 *   同期 (runSync) と同じ順番でロックを取る: ファイルのロック → 状態のロック。別の同期 (sync --watch など) が動いていれば消さない。
 *   結果未確認の操作 (送った応答待ち pending・結び直しの途中 relink) があれば、復旧に要るので消さない (Codex レビュー 29 R29-04)
 * Input : file = 計画のファイル, server = サーバーの URL
 * Output: "ok" (消した。結び付けが無かったときも) / "busy" (別の同期が動いている) / "pending" (結果未確認の操作が残っている)
 */
export function removeNodeSyncState(file: string, server: string): "ok" | "busy" | "pending" {
  const real = realFile(file);
  const dir = bindingDir(real, server);
  if (!existsSync(join(dir, "state.json"))) { rmSync(dir, { recursive: true, force: true }); return "ok"; }
  const unlockFile = lockFileSync(real);
  if (!unlockFile) return "busy";
  const store = new StateStore(dir);
  let unlockState: (() => void) | null = null;
  try {
    unlockState = store.lock();
    if (!unlockState) return "busy";
    let state: ReturnType<StateStore["read"]> = null;
    try { state = store.read(); } catch { state = null; }   // 読めない状態 (壊れている) は、解除で消してよい
    if (state?.pending || state?.relink) return "pending";
    // ロックを持ったまま、状態・写し・控え・止めている印を消す (ロックのファイルはこの後に消す)
    for (const name of ["state.json", "objects", "relinks", "stopped"]) rmSync(join(dir, name), { recursive: true, force: true });
  } finally { unlockState?.(); unlockFile(); }
  // 残り (ロックのファイルなど) を消す。その間に別の同期が結び直していたら (state.json が戻っていたら) 触らない
  if (!existsSync(join(dir, "state.json"))) rmSync(dir, { recursive: true, force: true });
  return "ok";
}

/**
 * 「この端末では止めている」の印 (結び付けのフォルダの stopped)。画面で「同期を止める」と置き、「再開する」で外す。
 * 別のプロセスの見張り (boxglow sync --watch) もこの印を見て、その計画を送受信しない (Codex レビュー 29 R29-05)。結び付けが無ければ何もしない
 * Input : file, server, on = 置く / 外す。Output: なし
 */
export function setSyncStopped(file: string, server: string, on: boolean): void {
  const dir = bindingDir(realFile(file), server);
  if (!existsSync(join(dir, "state.json"))) return;
  const path = join(dir, "stopped");
  try { if (on) writeFileSync(path, new Date().toISOString() + "\n", { mode: 0o600 }); else rmSync(path, { force: true }); } catch { /* 印を置けなくても、画面側の停止は効く */ }
}
/** 「止めている」の印があるか。Input: 結び付けのフォルダ。Output: true = 止めている */
export const isSyncStopped = (dir: string): boolean => existsSync(join(dir, "stopped"));

export function nodeSyncIO(file: string, server: string): SyncIO {
  const real = realFile(file);
  const store = new StateStore(bindingDir(real, server));
  return {
    file: real
  , storeName: basename(store.dir)
  , hashOf
  , newId: () => randomUUID()
  , lockLocal: async () => lockFileSync(real)
  , bindings: async () => bindingsOf(real)
  , lockState: async () => store.lock()
  , readState: async () => store.read() as SyncStoredState | null
  , writeState: async (next, expected) => { store.write(next, expected); }
  , getObject: async (hash) => store.getObject(hash)
  , putObject: async (text) => store.putObject(text)
  , putRelinkBackup: async (name, files, manifest) => store.putRelinkBackup(name, files, manifest)
  , relinkBackupPath: (name) => join(store.dir, "relinks", name)
  , readLocal: async () => {
      // 空 (空白だけ) のファイルは「まだ無い」と同じに扱う (空のファイルを作って開き、サーバーの計画を受け取る入口のため)
      const raw = existsSync(real) ? readFileSync(real, "utf8") : null;
      return raw !== null && raw.trim() === "" ? null : raw;
    }
  , revisionOf: (text) => `"${hashOf(text)}"`
  , writeLocal: async (text, expected) => {
      // 版の照合は、中身のハッシュを引用符で包んだ ETag の形 (file-store の revisionOf と同じ)
      try { commitFile(real, text, expected === null ? null : `"${expected}"`); }
      catch (e) { if (e instanceof FileConflict) throw new LocalConflict(); if (e instanceof FileBusy) throw new LocalBusy(); throw e; }
    }
  , backupLocal: async (_text, hash) => {
      // 置き換える前のファイルを、隣に写す (中身は今のファイルそのもの)
      const backup = `${real}.before-sync-${hash.slice(0, 8)}.json`;
      copyFileSync(real, backup);
      return backup;
    }
  };
}

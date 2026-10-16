/**
 * 同期の入出力 (SyncIO) の Node 実装: 計画のファイルと、設定フォルダの同期の状態 (cli/sync/state-store.ts) をつなぐ
 *   - 手元 = boxglow.json (commitFile: ロック + 版の照合 + 原子的な置換)
 *   - 状態 = 結び付けのフォルダ (state.json・objects・relinks)
 *   - ロック = ファイルのロック (lockFileSync) と状態のロック (StateStore.lock)
 * 同期の fs 呼び出しを async で包むだけで、個々の操作の原子性は従来のまま
 */
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { commitFile, FileBusy, FileConflict } from "../file-store";
import { LocalBusy, LocalConflict, type SyncIO, type SyncStoredState } from "../../src/sync/io";
import { bindingDir, bindingsOf, hashOf, lockFileSync, realFile, StateStore } from "./state-store";

/**
 * Node の入出力を組み立てる
 * Input : file = 計画のファイル (実パスに直す), server = サーバーの URL (末尾のスラッシュは除いたもの)
 * Output: SyncIO
 */
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

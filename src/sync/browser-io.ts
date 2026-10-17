/**
 * 同期の入出力 (SyncIO) のブラウザ実装: ブラウザ内の計画 (IndexedDB) と、同期の状態 (同じ IndexedDB の別の store) をつなぐ
 *   - 手元 = ブラウザ内の計画 (src/lib/storage.ts の boxglow:project:<id>。ここでは計画の JSON 文字列として読み書きする)
 *   - 状態 = store "sync" のキー "<計画 id>|<サーバー>" (基準・保留中の操作・結び付け)、写し = store "objects" (ハッシュ → 中身)、
 *     退避 = store "backups" (置き換え前の中身・結び直しの控え)
 *   - ロック = Web Locks API (navigator.locks)。無いブラウザでは、このタブの中だけのロック (複数タブは同期の役の調停で 1 つに絞る)
 * 設計書: docs/private/SYNC_BROWSER_DESIGN.md 4 章
 */
import { createStore, del, get, keys, set, type UseStore } from "idb-keyval";
import { sha256Hex } from "../lib/sha256";
import { loadProject, saveProject } from "../lib/storage";
import { fromJSON, toJSON } from "../model/graph";
import { LocalBusy, LocalConflict, type SyncBinding, type SyncIO, type SyncStoredState } from "./io";

/** IndexedDB の store (計画そのものは storage.ts の store を使う) */
const DB = "boxglow-sync";
let stores: { state: UseStore; objects: UseStore; backups: UseStore } | null = null;
function db(): { state: UseStore; objects: UseStore; backups: UseStore } {
  if (!stores) stores = { state: createStore(DB, "state"), objects: createStore(DB + "-objects", "objects"), backups: createStore(DB + "-backups", "backups") };
  return stores;
}
/** 試験用: store を作り直す (fake-indexeddb を差し替えた後に呼ぶ) */
export function resetBrowserSyncStores(): void { stores = null; }

/** 状態のキー (計画 id とサーバーの組) */
const stateKey = (projectId: string, server: string): string => `${projectId}|${server}`;
/** 計画 id の接頭辞 (この計画の結び付けを全部のサーバーから探すため) */
const statePrefix = (projectId: string): string => `${projectId}|`;

/** 状態の読み書きの「読んだ世代のままなら置き換える」を、このタブの中で直列にする (IndexedDB の 1 取引で読んで書く代わり) */
const writers = new Map<string, Promise<void>>();

/**
 * このタブの中だけのロック (Web Locks が無いとき)。name ごとに 1 つ。取れなければ null
 */
const localLocks = new Set<string>();
async function acquire(name: string): Promise<(() => void) | null> {
  const locks = (globalThis.navigator as Navigator & { locks?: LockManager } | undefined)?.locks;
  if (locks) {
    // Web Locks: 取れたらロックを保持したまま解放の関数を返す (ifAvailable: 待たない)
    return new Promise((resolve) => {
      void locks.request(name, { ifAvailable: true }, (lock) => {
        if (!lock) { resolve(null); return; }
        return new Promise<void>((release) => resolve(() => release()));
      });
    });
  }
  if (localLocks.has(name)) return null;
  localLocks.add(name);
  return () => { localLocks.delete(name); };
}

/**
 * ブラウザの入出力を組み立てる
 * Input : projectId = ブラウザ内の計画の id, server = サーバーの URL (末尾のスラッシュは除いたもの)
 * Output: SyncIO
 */
/**
 * この計画とサーバーの結び付け (同期の状態) を消す (「同期をやめる」)。計画そのものと、サーバーの控えは消さない
 * Input : projectId = ブラウザ内の計画の ID, server = サーバーの場所
 * Output: なし
 */
export async function removeBrowserSyncState(projectId: string, server: string): Promise<void> {
  await del(stateKey(projectId, server), db().state);
}

export function browserSyncIO(projectId: string, server: string): SyncIO {
  const key = stateKey(projectId, server);
  const { state, objects, backups } = db();
  return {
    file: projectId
    // (結び付けの印に入る名前。Node のフォルダ名と同じ役割。サーバーのホストと計画 id で一意)
  , storeName: `${projectId}@${server.replace(/^https?:\/\//, "")}`
  , hashOf: sha256Hex
  , newId: () => crypto.randomUUID()
  , lockLocal: () => acquire(`boxglow:local:${projectId}`)
  , bindings: async () => {
      // この計画の、全部のサーバーの結び付け (状態が読めないものは unreadable に)
      const all = (await keys(state)) as string[];
      const bindings: SyncBinding[] = [], unreadable: string[] = [];
      for (const k of all.filter((k) => k.startsWith(statePrefix(projectId)))) {
        try { const v = await get<SyncStoredState>(k, state); if (v?.binding) bindings.push(v.binding); else unreadable.push(k); }
        catch { unreadable.push(k); }
      }
      return { bindings, unreadable };
    }
  , lockState: () => acquire(`boxglow:sync:${key}`)
  , readState: async () => (await get<SyncStoredState>(key, state)) ?? null
  , writeState: async (next, expected) => {
      // 読んだ世代のままなら置き換える (このタブの中では直列。別タブは状態のロックで排他)
      const run = async () => {
        const current = await get<SyncStoredState>(key, state);
        if ((current?.generation ?? null) !== expected) throw new Error("sync state changed (generation)");
        await set(key, next, state);
      };
      const prev = writers.get(key) ?? Promise.resolve();
      const mine = prev.then(run, run);
      writers.set(key, mine.catch(() => undefined));
      await mine;
    }
  , getObject: async (hash) => { const text = await get<string>(hash, objects); return typeof text === "string" && sha256Hex(text) === hash ? text : null; }
  , putObject: async (text) => { const hash = sha256Hex(text); if ((await get<string>(hash, objects)) !== text) await set(hash, text, objects); return hash; }
  , putRelinkBackup: async (name, files, manifest) => { await set(`relink:${key}:${name}`, { files, manifest: { ...manifest, files: Object.keys(files), complete: true } }, backups); return `relink:${name}`; }
  , relinkBackupPath: (name) => `relink:${name}`
  , readLocal: async () => {
      // ブラウザ内の計画を、ファイルと同じ正規の JSON 文字列として読む (保存は toJSON と同じ形)
      const p = await loadProject(projectId);
      return p ? toJSON(p) + "\n" : null;
    }
  , revisionOf: (text) => sha256Hex(text)
  , writeLocal: async (text, expected) => {
      // 読んだときの中身 (ハッシュ) のままなら置き換える。違えば LocalConflict (書かない)
      const current = await loadProject(projectId);
      const currentHash = current ? sha256Hex(toJSON(current) + "\n") : null;
      if (currentHash !== expected) throw new LocalConflict();
      let p;
      try { p = fromJSON(text); } catch (e) { throw new Error("received content is not a plan: " + (e instanceof Error ? e.message : String(e))); }
      if (p.id !== projectId) throw new LocalBusy(); // (別の id の計画は、この置き場に書けない。呼び出し側が受け取りの前に id をそろえる)
      await saveProject(p);
    }
  , backupLocal: async (text, hash) => { const name = `before-sync:${key}:${hash.slice(0, 8)}:${new Date().toISOString()}`; await set(name, text, backups); return name; }
  };
}

/** 試験・画面用: この計画の結び付け済みの状態を消す (サインアウトや計画の削除のとき) */
export async function clearBrowserSyncState(projectId: string, server: string): Promise<void> { await del(stateKey(projectId, server), db().state); }

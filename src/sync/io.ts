/**
 * 同期の本体 (src/sync/run.ts) が使う入出力の約束。Node (ファイルと状態のフォルダ) とブラウザ (IndexedDB) で実装を差し替える
 *   - 手元の中身の読み書き (計画のファイル / ブラウザ内の計画)
 *   - 同期の状態 (基準・保留中の操作・結び付け) と、中身の写し (objects)、結び直しの控え
 *   - ロック (同じ結び付けを扱う同期の処理を 1 つに絞る)
 * どの操作も非同期でよい (ブラウザの保存は非同期)。Node は同期の fs 呼び出しを包む
 */
import type { SyncState } from "./engine";

/** 結び付け (手元の計画 ↔ サーバー側の計画) の記録。cli/sync/state-store.ts の Binding と同じ形 */
export interface SyncBinding {
  /** 手元の計画の場所 (Node = ファイルの実パス、ブラウザ = 計画の id) */
  file: string;
  server: string;
  remoteId: string;
  /** 結び付けたときの手元の計画の ID (初めての受け取りを書く前は "") */
  planId: string;
  /** 受け取りを書く前に控えた、これから書く計画の ID (書けたと確かめたら planId に移す) */
  pendingPlanId?: string;
  /** サーバーが確かめた利用者の ID (記録する前の状態では無い) */
  account?: string;
}
/** 保存する同期の状態 (SyncState + 形式の版 + 結び付け) */
export interface SyncStoredState extends SyncState { version: 1 | 2; binding: SyncBinding }

/** 手元の中身を書くときに「読んだときから変わっていた」(書かなかった) */
export class LocalConflict extends Error { constructor() { super("local content changed"); } }
/** 手元の中身が書き込み中で、今回は書けなかった (待てば直る) */
export class LocalBusy extends Error { constructor() { super("local content is busy"); } }

export interface SyncIO {
  /** 手元の場所の表示用の名前 (結果の target.file に入れる) */
  readonly file: string;
  /** 同期の状態の置き場の名前 (結び付けの印 bindingId に使う。Node = フォルダ名、ブラウザ = 計画 id とサーバーから作る) */
  readonly storeName: string;
  /** 文字列の SHA-256 (16 進)。サーバーの中身のハッシュと同じ計算 */
  hashOf(text: string): string;
  /** 一意の ID (操作 ID・サーバー側の計画の ID に使う) */
  newId(): string;
  /** 手元の場所のロック (サーバーが違っても、同じ手元を扱う同期は 1 つ)。取れなければ null (待たない) */
  lockLocal(): Promise<(() => void) | null>;
  /** この手元の、既知の結び付け (全部のサーバー) と、読めない状態の置き場 */
  bindings(): Promise<{ bindings: SyncBinding[]; unreadable: string[] }>;
  /** 状態のロック (同じ結び付けを扱う同期の処理を 1 つに絞る)。取れなければ null */
  lockState(): Promise<(() => void) | null>;
  /** 状態を読む (まだ無ければ null。壊れていれば例外) */
  readState(): Promise<SyncStoredState | null>;
  /** 状態を書く (読んだ世代のままなら置き換える。違えば例外) */
  writeState(next: SyncStoredState, expectedGeneration: number | null): Promise<void>;
  /** 中身の写しを読む (無い・壊れているなら null) */
  getObject(hash: string): Promise<string | null>;
  /** 中身の写しを置く (状態がそのハッシュを指す前に置く)。Output: ハッシュ */
  putObject(text: string): Promise<string>;
  /** 結び直しの控えを置く。Output: 控えの場所 (表示用) */
  putRelinkBackup(name: string, files: Record<string, string>, manifest: Record<string, unknown>): Promise<string>;
  /** 結び直しの控えの場所 (表示用。前の実行が置いたもの) */
  relinkBackupPath(name: string): string;
  /** 手元の中身を読む (無ければ null。空 (空白だけ) も null) */
  readLocal(): Promise<string | null>;
  /** 手元の中身の版 (書くときの照合に使う。Node = リビジョン、ブラウザ = ハッシュ) */
  revisionOf(text: string): string;
  /** 手元に書く。expected = 読んだときの版 (無かったなら null)。変わっていれば LocalConflict、書き込み中なら LocalBusy */
  writeLocal(text: string, expected: string | null): Promise<void>;
  /** 置き換える前の手元の中身を退避する。Output: 退避の場所 (表示用) */
  backupLocal(text: string, hash: string): Promise<string>;
}

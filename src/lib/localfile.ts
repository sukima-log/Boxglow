/**
 * ローカルファイル連携 (File System Access API)
 * リポジトリ内の boxglow.json を開き、1.5 秒ごとに更新を監視し、画面での変更を書き戻す。
 * AI エージェントが CLI でファイルを更新すると、画面にすぐ反映される。
 */
import { get, set } from "idb-keyval";

const LAST_HANDLE_KEY = "boxglow:lastFileHandle";

/** この環境でローカルファイルを開けるか (Chrome / Edge) */
export const canOpenLocalFile = (): boolean => typeof window !== "undefined" && typeof window.showOpenFilePicker === "function";

/** ファイル選択ダイアログで boxglow.json を選ぶ (キャンセルなら null) */
export async function pickLocalFile(): Promise<FileSystemFileHandle | null> {
  if (!window.showOpenFilePicker) return null;
  try {
    const [handle] = await window.showOpenFilePicker({
      multiple: false
    , types: [{ description: "Boxglow project", accept: { "application/json": [".json"] } }]
    });
    await set(LAST_HANDLE_KEY, handle);
    return handle;
  } catch {
    return null; // キャンセル
  }
}

/** 前回開いたファイルのハンドル (無ければ null) */
export async function lastLocalFile(): Promise<FileSystemFileHandle | null> {
  try {
    return (await get<FileSystemFileHandle>(LAST_HANDLE_KEY)) ?? null;
  } catch {
    return null;
  }
}

/** 読み書きの許可を取る (ユーザー操作の中で呼ぶ)。許可されたら true */
export async function ensurePermission(handle: FileSystemFileHandle, mode: "read" | "readwrite" = "readwrite"): Promise<boolean> {
  try {
    // 見るだけなら read で足りる (開いた直後に「変更を保存しますか」と聞かれない)。書き込みは最初の保存のときに readwrite を求める
    if ((await handle.queryPermission({ mode })) === "granted") return true;
    return (await handle.requestPermission({ mode })) === "granted";
  } catch {
    return false;
  }
}

/** ファイルを読む (中身と更新時刻) */
export async function readLocalFile(handle: FileSystemFileHandle): Promise<{ text: string; lastModified: number }> {
  const f = await handle.getFile();
  return { text: await f.text(), lastModified: f.lastModified };
}

/** ファイルに書く。書いた後の更新時刻を返す */
export async function writeLocalFile(handle: FileSystemFileHandle, text: string): Promise<number> {
  const w = await handle.createWritable();
  await w.write(text);
  await w.close();
  return (await handle.getFile()).lastModified;
}

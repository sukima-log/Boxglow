/**
 * ブラウザでの書き出し (ファイル保存・クリップボード)
 */

/** 文字列をファイルとして保存する (ダウンロード) */
export function downloadText(filename: string, text: string, mime = "text/plain"): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** クリップボードにコピーする。成功したら true */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** ファイル選択ダイアログを開き、選んだテキストファイルの中身を返す (キャンセルなら null) */
export function pickTextFile(accept: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      resolve(await f.text());
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** ファイル名に使える形にする */
export const safeFilename = (s: string): string => s.replace(/[\\/:*?"<>|]/g, "_").trim() || "boxglow";

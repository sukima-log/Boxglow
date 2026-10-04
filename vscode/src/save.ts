/**
 * VS Code 拡張の保存の本体 (vscode の API に依存しない形にして、テストで失敗の場面を再現できるようにしてある)
 * CLI・serve と同じロック (cli/file-store.ts) の中で、ディスクとドキュメントが「画面が読んだときの中身」のままかを確かめてから
 * ドキュメントを置き換えて保存し、保存後にディスクの中身まで確かめる。どこかで食い違えば FileConflict、
 * VS Code が編集や保存を断ったら通常のエラーにする (呼び出し側が webview に失敗の応答を返す。成功の応答は最後まで通ったときだけ)
 */
import { readFileSync } from "node:fs";
import { FileConflict, lockFile } from "../../cli/file-store";
import { validateProjectText } from "../../src/model/validate-file";
// 文言を今の言語 (日本語 / 英語) で出す。言語は呼び出し側 (extension.ts) が計画の言語に合わせてある
import { t } from "../../src/i18n/core";

/** webview からの保存の要求: text = 保存したい中身, baseText = 画面が元にした中身, version = 画面が元にしたドキュメントの版 */
export interface SaveRequest { text: string; baseText: string; version: number }

/** 保存先のドキュメントの操作 (本番は vscode.TextDocument を包んだもの、テストは模擬) */
export interface SaveDocument {
  /** ファイルのパス */
  path: string;
  /** 今のドキュメントの中身 */
  text(): string;
  /** 今のドキュメントの版 (編集のたびに増える) */
  version(): number;
  /** ドキュメント全体を置き換える (WorkspaceEdit)。適用できたら true */
  replace(text: string): PromiseLike<boolean>;
  /** ディスクに保存する。保存できたら true */
  save(): PromiseLike<boolean>;
}

/**
 * 拡張 (Node 側) が、このファイルのある場所を直接読み書きできるかを確かめる
 * VS Code は、拡張がネットワーク形式の場所 (\\\\ホスト名\\... の UNC パス) を読み書きするのを、許可したホスト以外は止める。
 * Windows の窓で WSL のファイル (\\\\wsl.localhost\\...) を開いたときがこれに当たる。
 * 止められていると、保存のロックも照合もできないので、安全に保存できない (画面は閲覧専用にして理由を見せる)
 * Input : path = ファイルのパス
 * Output: 読み書きできるなら null。できないなら、利用者に見せる理由と対処の文 (今の言語)
 */
export function diskAccess(path: string): string | null {
  try {
    readFileSync(path, "utf8");
    return null;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ERR_UNC_HOST_NOT_ALLOWED") {
      const host = /^[\\/]{2}([^\\/]+)/.exec(path)?.[1] ?? "";
      return host.toLowerCase().startsWith("wsl")
        ? t("この窓からは保存できません (閲覧専用)。VS Code が、拡張による {host} へのアクセスを許可していないためです。WSL の窓 (左下に「WSL: ...」と出る窓) でこのファイルを開いてください。この窓のまま使うなら、設定 security.allowedUNCHosts に {host} を追加して VS Code を再起動します", { host })
        : t("この窓からは保存できません (閲覧専用)。VS Code が、拡張による {host} へのアクセスを許可していないためです。設定 security.allowedUNCHosts に {host} を追加して VS Code を再起動してください", { host });
    }
    return t("この窓からは保存できません (閲覧専用)。拡張がファイルを読めませんでした: {message}", { message: err.message ?? String(e) });
  }
}

/**
 * 改行を LF にそろえる (比べるとき用)
 * 画面は LF の文字列を送るが、VS Code は挿入した文字列の改行をドキュメントの改行 (CRLF のファイルなら CRLF) に合わせる。
 * そのまま比べると、CRLF のファイルでは「置き換えた直後のドキュメント」と「要求の中身」が必ず食い違い、毎回競合になる
 * Input : text = 文字列 (改行は LF / CRLF どちらでもよい)
 * Output: 改行を LF にした文字列
 */
const lf = (text: string): string => text.replace(/\r\n/g, "\n");

/**
 * ドキュメントを要求の中身で保存する (照合・置き換え・保存・保存後の確認を、同じロックの中で行う)
 * Input : doc = 保存先の操作, request = webview からの要求, diskBase = 拡張が最後に確かめたディスクの中身
 *         (中身の照合はすべて、改行を LF にそろえてから行う。CRLF のファイルは CRLF のまま保存される)
 * Output: 保存後のドキュメントの版。競合は FileConflict、ロック中は FileBusy、計画として不正・編集や保存の失敗は Error を投げる
 */
export async function saveDocument(doc: SaveDocument, request: SaveRequest, diskBase: string): Promise<number> {
  // 計画として正しいものだけを書く (壊れた参照を保存しない)
  validateProjectText(request.text);
  // 比べる基準は改行を LF にそろえておく
  const wanted = lf(request.text);
  const unlock = lockFile(doc.path);
  try {
    // ディスクが、拡張が最後に確かめた中身から変わっていたら競合 (CLI などが先に書いた)
    if (lf(readFileSync(doc.path, "utf8")) !== lf(diskBase)) throw new FileConflict();
    // 前回ディスクへの保存だけ失敗した場合、ドキュメントにはもう同じ編集が入っている (そのときは置き換えを飛ばして保存だけやり直す)
    if (lf(doc.text()) !== wanted) {
      // 画面が元にした版・中身からドキュメントが変わっていたら競合
      if (doc.version() !== request.version || lf(doc.text()) !== lf(request.baseText)) throw new FileConflict();
      if (!await doc.replace(request.text)) throw new Error(t("VS Code が編集を適用できませんでした。変更は図に残っています"));
    }
    if (lf(doc.text()) !== wanted) throw new FileConflict();
    if (!await doc.save()) throw new Error(t("VS Code がファイルを保存できませんでした。再試行するか、変更を書き出してください"));
    // 保存中に別の編集が入っていないか、ディスクの中身が要求どおりかを最後に確かめる
    if (lf(doc.text()) !== wanted || lf(readFileSync(doc.path, "utf8")) !== wanted) throw new FileConflict();
    return doc.version();
  } finally {
    unlock();
  }
}

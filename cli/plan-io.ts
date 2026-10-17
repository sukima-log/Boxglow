/**
 * 計画 (boxglow.json) の入出力の層。CLI の処理 (main.ts) はこの層だけを通して計画を読み書きする
 *   - ファイル版 (既定): 手元の boxglow.json を、ロックと版の照合つきで読み書きする (file-store.ts)
 *   - メモリ版: ホスト型の MCP (Workers) で、サーバーに保存した計画の中身に対して同じ処理を動かすために使う (ファイルは無い)
 * Input / Output は各関数のコメントを参照
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { commitFile, FileConflict, revisionOf } from "./file-store";
import { t } from "../src/i18n/core";

export interface PlanIO {
  /**
   * 計画の場所を決める
   * Input : opt = --file の指定, forInit = init のとき (無くてもよい)。Output: 計画のパス。見つからなければ例外
   */
  locate(opt: string | undefined, forInit: boolean): string;
  /** 計画があるか */
  exists(path: string): boolean;
  /** 計画の中身を読む (無ければ例外) */
  read(path: string): string;
  /**
   * 計画を書く: 読んだときの版 (expected。無い前提なら null) と照合してから置き換える
   * Input : prepare = ロックと照合の後に、今の中身を見て最終の中身を決める関数。Output: 書いた後の版。版が違えば FileConflict
   */
  commit(path: string, text: string, expected: string | null, opts?: { prepare?: (current: string | null, proposed: string) => string }): string;
}

/** ファイル版 (--file > BOXGLOW_FILE > カレントから上へ探す) */
export const filePlanIO: PlanIO = {
  locate(opt, forInit) {
    if (opt) return resolve(opt);
    if (process.env.BOXGLOW_FILE) return resolve(process.env.BOXGLOW_FILE);
    let dir = process.cwd();
    for (let i = 0; i < 12; i++) {
      const candidate = join(dir, "boxglow.json");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (forInit) return join(process.cwd(), "boxglow.json");
    throw new Error(t("boxglow.json が見つかりません (--file で指定するか、`boxglow init` で作ってください)"));
  }
, exists: (path) => existsSync(path)
, read: (path) => readFileSync(path, "utf8")
, commit: (path, text, expected, opts) => commitFile(path, text, expected, opts)
};

/**
 * メモリ版: 1 つの計画の中身を持つ。版の照合はファイル版と同じ規則 (中身のハッシュ)
 * Input : initial = 最初の中身 (無ければ null), path = 見かけのパス。Output: PlanIO + current() (今の中身)
 */
export function memoryPlanIO(initial: string | null, path = "/boxglow/boxglow.json"): PlanIO & { current: () => string | null } {
  let text = initial;
  return {
    locate: () => path
  , exists: () => text !== null
  , read: () => { if (text === null) throw new Error(t("boxglow.json が見つかりません (--file で指定するか、`boxglow init` で作ってください)")); return text; }
  , commit: (_path, proposed, expected, opts) => {
      const currentRevision = text === null ? null : revisionOf(text);
      if (expected !== currentRevision) throw new FileConflict();
      const final = opts?.prepare ? opts.prepare(text, proposed) : proposed;
      text = final;
      return revisionOf(final);
    }
  , current: () => text
  };
}

let current: PlanIO = filePlanIO;
/** 今の入出力の層 */
export const planIO = (): PlanIO => current;
/** 入出力の層を差し替えて fn を実行し、終わったら元に戻す (同期的。常駐の MCP でも要求ごとに差し替えられる) */
export function withPlanIO<T>(io: PlanIO, fn: () => T): T {
  const previous = current;
  current = io;
  try { return fn(); } finally { current = previous; }
}

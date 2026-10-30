/**
 * 成果物・資料・Notes のリンクに書かれた手元のファイルの場所を探す (VS Code 拡張と serve で共通)
 * 付けたときのパスは、Git のファイルならリポジトリの一番上から、それ以外は CLI を動かした場所 (多くは計画のフォルダかリポジトリの一番上) からの相対パス。
 * そのため「計画のファイルのフォルダ」と「Git のリポジトリの一番上」の両方を基準に探す (利用者の要望 2026-10-31: 紐づいたファイルを押すだけで開きたい)
 */
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * フォルダから上へたどって、Git のリポジトリの一番上 (.git があるフォルダ) を返す
 * Input : dir = 探し始めるフォルダ / Output: リポジトリの一番上のフォルダ (無ければ null)
 */
export function gitRootOf(dir: string): string | null {
  let cur = resolve(dir);
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(cur, ".git"))) return cur;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

/**
 * 探す基準のフォルダ (計画のファイルのフォルダ、その上の Git のリポジトリの一番上)
 * Input : planFile = boxglow.json のパス / Output: フォルダの配列 (重複なし)
 */
export function attachedFileBases(planFile: string): string[] {
  const planDir = dirname(resolve(planFile));
  const root = gitRootOf(planDir);
  return [...new Set([planDir, ...(root ? [root] : [])])];
}

/**
 * 成果物・資料のパスから、実在するファイルを探す
 * Input : planFile = boxglow.json のパス, path = 成果物に書かれたパス (相対か絶対。先頭の ./ や file:// も可)
 * Output: 見つかったファイルの絶対パス (無ければ null。フォルダは対象外)
 */
export function resolveAttachedFile(planFile: string, path: string): string | null {
  let p = path.trim();
  if (p.startsWith("file://")) p = decodeURIComponent(p.slice("file://".length));
  p = p.replace(/[?#].*$/, ""); // 行番号などの付け足し (#L10) は外す
  if (!p) return null;
  const candidates = isAbsolute(p) ? [p] : attachedFileBases(planFile).map((base) => resolve(base, p));
  for (const c of candidates) {
    try { if (existsSync(c) && statSync(c).isFile()) return c; } catch { /* 読めない場所は飛ばす */ }
  }
  return null;
}

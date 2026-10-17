/**
 * 履歴の版 (サーバーの GET /v1/projects/:id/versions) に関する、ホスト共通の処理
 *   - 一覧の応答の検証 (信頼しない入力として扱う)
 *   - 版の中身から計画名を取り出す
 *   - 版の中身を手元のファイルへ戻す (控えを取ってから置き換える。サーバーの履歴は変えず、次の同期で新しい版として送られる)
 */
import type { SyncIO } from "./io";

export interface VersionEntry { revision: string; at: string }

/**
 * 版の一覧の応答を検証して、新しい順の配列にする
 * Input : data = サーバーの応答 (JSON を読んだもの)。Output: [{ revision, at }] (多くても 200 件)。形が合わなければ例外
 */
export function parseVersionList(data: unknown): VersionEntry[] {
  if (!Array.isArray(data) || data.length > 10_000) throw new Error("versions: unexpected response");
  const out: VersionEntry[] = [];
  for (const v of data.slice(0, 200)) {
    if (!v || typeof v !== "object") throw new Error("versions: unexpected entry");
    const { revision, at } = v as { revision?: unknown; at?: unknown };
    if (typeof revision !== "string" || revision.length === 0 || revision.length > 64 || typeof at !== "string" || at.length > 64) throw new Error("versions: unexpected entry");
    out.push({ revision, at });
  }
  return out;
}

/** 版の中身 (計画の JSON) から名前を取り出す。読めなければ fallback */
export function planNameOf(text: string, fallback: string): string {
  try {
    const name = (JSON.parse(text) as { name?: unknown }).name;
    return typeof name === "string" && name.length > 0 ? name.slice(0, 512) : fallback;
  } catch { return fallback; }
}

/**
 * 版の中身を手元のファイルへ戻す
 *   手順: 今の中身を読む → 控えを取る (今の中身があるとき) → 今の中身のハッシュを前提に書き換える (その間に変わっていれば失敗する)
 * Input : io = ホストの入出力, text = 戻す版の中身。Output: { backup: 控えの場所 (無ければ null) }
 */
export async function applyRevert(io: SyncIO, text: string): Promise<{ backup: string | null }> {
  const current = await io.readLocal();
  const hash = current === null ? null : io.hashOf(current);
  const backup = current === null ? null : await io.backupLocal(current, hash!);
  await io.writeLocal(text, hash);
  return { backup };
}

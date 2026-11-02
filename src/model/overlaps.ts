/**
 * 箱の重なりの解消を、画面の編集の確定・CLI の保存・表示用の計画から呼ぶための入口
 *   重なりの解消は箱の位置だけを変える (ポート・線・親子の組み立ては変えない) ので、位置だけを変える処理向けの索引 (withMoveIndex) で引き、
 *   箱の大きさは同じ版の中で使い回す (memoBlockSize)。結果は索引・使い回しなしで求めたときと同じ。
 *   箱が 1000 を超える計画では、編集 1 回の重なりの解消に 4 秒かかっていた (全部の箱の大きさを、変更前と変更後で 2 回ずつ求めるため。2026-11-02 計測)
 */
import { resolveAllOverlaps, resolveChangedOverlaps, withMoveIndex, withViewIndex } from "./graph";
import { memoBlockSize } from "./size";
import type { Project } from "./types";

/**
 * 編集で変えた箱だけ重なりを解く (画面の編集の確定・CLI の保存)
 * Input : before = 変更前の計画 (書き換えない。画面に出ている計画、または読み直した原本), after = 変更後の計画 (書き換えない)
 * Output: 今回の操作と、その押し出しに必要な位置だけを補正した計画 (resolveChangedOverlaps と同じ)
 */
export function resolveEditOverlaps(before: Project, after: Project): Project {
  return withViewIndex(before, () => withMoveIndex(after, () => resolveChangedOverlaps(before, after, memoBlockSize())));
}

/**
 * すべての階層で重なっている兄弟を押し出す (表示用の計画、CLI の新規保存)
 * Input : p = 計画 (書き換えない) / Output: 位置を直した計画 (何も動かなければ p のまま。resolveAllOverlaps と同じ)
 */
export function resolveShownOverlaps(p: Project): Project {
  return withMoveIndex(p, () => resolveAllOverlaps(p, memoBlockSize()));
}

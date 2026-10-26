/** 閲覧用の工程配置。座標は表示だけに使い、保存済みの計画へ書き戻さない。 */
import { ROOT_ID, type Project } from "./types";
import { childrenOf } from "./graph";
import { isExpanded } from "./size";
import { layoutScope, type LayoutColumn } from "./autolayout";

const columns = new WeakMap<Project, Map<string, LayoutColumn[]>>();
/**
 * Input: 表示用計画と親の ID。Output: その階層の工程列 (保存モデルには追加しない)
 */
export function readingColumns(p: Project, id: string): LayoutColumn[] {
  return columns.get(p)?.get(id) ?? [];
}

/**
 * 開いている階層から子の寸法を確定し、親を工程順に配置する。
 * Input: 元の計画、表示範囲 (null は Top)
 * Output: 配置した表示専用コピー。元の位置・接続は変更しない
 */
export function readingLayout(p: Project, scope: string | null): Project {
  let q = p;
  const result = new Map<string, LayoutColumn[]>();
  const walk = (id: string) => {
    for (const child of childrenOf(q, id))
      if (isExpanded(q, child.id))
        walk(child.id);
    const list: LayoutColumn[] = [];
    q = layoutScope(q, id, { recursive: false, presentation: true, columns: list });
    if (list.length)
      result.set(id, list);
  };
  walk(scope ?? ROOT_ID);
  columns.set(q, result);
  return q;
}

/**
 * Auto Layout (Edit で保存する配置) を View の工程順の並べ方と同じにする (利用者の要望 2026-10-26: Edit と View で配置が大きく変わる)。
 * readingLayout と違い、畳んでいる箱の中も並べる (後で開いたときにも同じ並びになるように)。工程の見出しの位置は返さない
 * Input : p = 計画, scope = 並べる範囲の箱 (null か ROOT_ID は計画全体)
 * Output: 位置を更新した計画 (元は変更しない)
 */
export function layoutLikeView(p: Project, scope: string | null): Project {
  let q = p;
  const walk = (id: string) => {
    for (const child of childrenOf(q, id))
      if (childrenOf(q, child.id).length > 0)
        walk(child.id);
    q = layoutScope(q, id, { recursive: false, presentation: true });
  };
  walk(scope ?? ROOT_ID);
  return q;
}

import { ClaimMark } from "./Claims";
/**
 * 図を素早く探して移動するための独立した階層一覧。行は題名と小さな分類・状態の印に絞る。
 * 開閉とキーボードの位置はこの表示だけの状態。図の折りたたみや共有ファイルには保存しない。
 * 編集は既存モデル API をストアの apply に渡す。検証・履歴・Undo を図の編集と共有する。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { addBlock, kindOf, moveBlockToParent, removeBlock, setStatus, updateBlock } from "../model/graph";
import { ROOT_ID, type Block, type BlockStatus, type Project } from "../model/types";
import { useProjectStore } from "../store/useProjectStore";
import { t, useLang } from "../i18n";
import { categoryOf } from "../model/categories";
import { STATUS_LABEL } from "../model/status";
import { TreeIcon } from "./TreeIcon";
import { isFilterEmpty, matchesFilter, type Filter } from "./Drawer";

/**
 * 入力: 計画 Project、図と共通の Filter、パネルを閉じる () => void。
 * 出力: 階層の aside 要素。選択・図への移動・編集はストアへ渡し、readonly では編集入口を出さない。
 */
export function TreePanel({ project, filter, onClose }: { project: Project; filter: Filter; onClose: () => void }) {
  useLang();
  const selection = useProjectStore((s) => s.selection);
  const selected = selection.blockId;
  const readonly = useProjectStore((s) => s.readonly);
  const select = useProjectStore((s) => s.select);
  const focus = useProjectStore((s) => s.focusBlock);
  const apply = useProjectStore((s) => s.apply);
  // closed は枝の開閉、active はキー操作の位置、selected は図と共有する選択。
  // 矢印で探している間に図が動かないよう、フォーカスと選択を分ける。
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  // Enter と blur の二重確定や、Escape 後の blur による誤確定を防ぐ同期的な印。
  // 再描画を待たず解除できる ref と、入力欄を出す editing を分けて持つ。
  const renameTarget = useRef<string | null>(null);
  const [title, setTitle] = useState("");
  const [moving, setMoving] = useState(false);
  const [target, setTarget] = useState("");
  const list = useRef<HTMLDivElement>(null);
  // 子の索引は計画の変更時だけ作る。行ごとの全件走査を避け、数百件でも同じ手順で描く。
  const index = useMemo(() => {
    const children = new Map<string, Block[]>();
    for (const b of Object.values(project.blocks))
      if (b.parentId) {
        const siblings = children.get(b.parentId) ?? [];
        siblings.push(b);
        children.set(b.parentId, siblings);
      }
    for (const siblings of children.values())
      siblings.sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
    return children;
  }, [project]);
  // effectiveProgress と同じルールを子の索引で計算する。各ボックスは一度だけ訪ねる。
  const progress = useMemo(() => {
    const values = new Map<string, number>();
    /** 入力: 子の索引にある Block。出力: 0〜100 の進捗。子孫の値も values に記録する。 */
    const visit = (b: Block): number => {
      const kids = index.get(b.id) ?? [];
      const children = kids.map(visit);
      const value =
        b.status === "white"
          ? 100
          : typeof b.progress === "number"
            ? Math.max(0, Math.min(100, b.progress))
            : children.length
              ? Math.round(children.reduce((a, n) => a + n, 0) / children.length)
              : 0;
      values.set(b.id, value);
      return value;
    };
    for (const b of index.get(ROOT_ID) ?? []) visit(b);
    return values;
  }, [index]);
  const filtered = !isFilterEmpty(filter);
  // 一致した子だけを孤立させず、親も残す。通った祖先で止めて共有の道を何度も走査しない。
  const visible = useMemo(() => {
    const keep = new Set<string>();
    for (const b of Object.values(project.blocks))
      if (b.id !== ROOT_ID && matchesFilter(project, b.id, filter)) {
        let id: string | null = b.id;
        while (id && !keep.has(id)) {
          keep.add(id);
          id = project.blocks[id]?.parentId ?? null;
        }
      }
    return keep;
  }, [project, filter]);
  // DOM とキー移動を同じ順序にするため、見える枝を深さ優先の平らな配列へ展開する。
  const rows = useMemo(() => {
    const result: { block: Block; depth: number }[] = [];
    /** 入力: 親の内部 ID と表示の深さ。出力: void。見える子を result に追加する。 */
    const visit = (id: string, depth: number) => {
      for (const block of index.get(id) ?? [])
        if (visible.has(block.id)) {
          result.push({ block, depth });
          if (!closed.has(block.id)) visit(block.id, depth + 1);
        }
    };
    visit(ROOT_ID, 0);
    return result;
  }, [index, visible, filtered, closed]);
  // キャンバスで選んだ行の祖先を開く。表示の開閉はファイルへ書かない。
  useEffect(() => {
    if (!selected) return;
    setClosed((prev) => {
      const next = new Set(prev);
      let id = project.blocks[selected]?.parentId;
      while (id) {
        next.delete(id);
        id = project.blocks[id]?.parentId;
      }
      return next.size === prev.size ? prev : next;
    });
  }, [selection, project]);
  // 祖先を開いた後に行が描かれるため、選択だけでなく rows の更新後も位置を合わせる。
  useEffect(() => {
    list.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected, rows]);
  // 別計画を開いたら、前の計画の ID を参照する入力・メニュー・開閉を持ち越さない。
  useEffect(() => {
    setMenu(null);
    setEditing(null);
    renameTarget.current = null;
    setActive(null);
    setClosed(new Set());
  }, [project.id]);
  // 絞り込みを変更した直後は一致する枝を開く。その後は、絞り込み中でも自由に畳める。
  useEffect(() => {
    setClosed(new Set());
  }, [filter]);
  const current = menu ? project.blocks[menu] : null;
  // 移動先は自分・子孫・最上位を除く。実行時もモデル側が同じ制約を確認する。
  const destinations = useMemo(() => {
    if (!current) return [];
    const excluded = new Set<string>([ROOT_ID, current.id]);
    /** 入力: 除外する親の内部 ID。出力: void。全子孫を excluded に加え、循環する移動を候補から外す。 */
    const visit = (id: string) => {
      for (const b of index.get(id) ?? []) {
        excluded.add(b.id);
        visit(b.id);
      }
    };
    visit(current.id);
    return Object.values(project.blocks).filter((b) => !excluded.has(b.id) && b.id !== current.parentId);
  }, [current, index, project]);
  /** 入力: 行の内部 ID (string)。出力: void。図と一覧の選択を同じボックスへ移す。 */
  const jump = (id: string) => {
    setMenu(null);
    select({ blockId: id });
    focus(id);
  };
  /** 入力: 行の内部 ID と元の題名 (string)。出力: void。改名を開始し、確定/取消を blur より先に識別できるようにする。 */
  const beginRename = (id: string, value: string) => {
    renameTarget.current = id;
    setEditing(id);
    setTitle(value);
  };
  /** 入力: 親の内部 ID (string)。出力: void。新しい子を追加し、題名の編集を開始する。 */
  const add = (parentId: string) => {
    let id = "";
    apply((p) => {
      const result = addBlock(p, { parentId, title: t("新しいボックス"), actor: "human" });
      id = result.blockId;
      return result.project;
    });
    if (id) {
      jump(id);
      beginRename(id, t("新しいボックス"));
    }
    setMenu(null);
  };
  /** 入力: state の題名と ref の改名対象。出力: void。空文字は採らず、確定を一度だけ履歴へ追加する。 */
  const rename = () => {
    const id = renameTarget.current;
    renameTarget.current = null;
    if (id && title.trim()) apply((p) => updateBlock(p, id, { title: title.trim() }));
    setEditing(null);
  };
  /** 入力: 行の内部 ID と任意の閉じる指定 (boolean)。出力: void。一覧の枝だけを変更し、図の折り畳みは変えない。 */
  const toggle = (id: string, close?: boolean) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (close ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });
  /** 入力: 行の内部 ID (string)。出力: void。スクロールとキーボードのフォーカスだけを移す。 */
  const focusRow = (id: string) => {
    setActive(id);
    /** 入力: 外側の行 ID。出力: DOM に行があれば true。フォーカスと見える位置だけを合わせる。 */
    const reveal = () => {
      const row = list.current?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);
      row?.focus({ preventScroll: true });
      row?.scrollIntoView({ block: "nearest" });
      return !!row;
    };
    // 既にある行はすぐ移動する。新しく追加した行だけ描画を待つ（連続した方向キーを取りこぼさない）。
    if (!reveal()) requestAnimationFrame(reveal);
  };
  /** 入力: 行の内部 ID (string)。出力: void。管理操作を開き、キーボードでも最初の操作へ届くようにする。 */
  const showActions = (id: string) => {
    if (readonly) return;
    setActive(id);
    setMenu(id);
    setMoving(false);
    setTarget("");
    requestAnimationFrame(() =>
      list.current?.parentElement?.querySelector<HTMLButtonElement>(".tree-actions__buttons button")?.focus(),
    );
  };
  /** 入力: 行の KeyboardEvent と Block。出力: void。上下で移動、左右で階層を開閉、Enter で図へ、F2 で改名。 */
  const onRowKey = (e: KeyboardEvent<HTMLDivElement>, b: Block) => {
    // 入力欄・ボタン自身の操作や IME 確定を、行のショートカットとして二重処理しない。
    if (e.target !== e.currentTarget || e.nativeEvent.isComposing) return;
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      showActions(b.id);
      return;
    }
    const at = rows.findIndex((row) => row.block.id === b.id);
    if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End", "Enter", " ", "F2"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "ArrowDown" || e.key === "ArrowUp")
      focusRow(rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))].block.id);
    if (e.key === "Home") focusRow(rows[0].block.id);
    if (e.key === "End") focusRow(rows[rows.length - 1].block.id);
    if (e.key === "ArrowRight" && index.has(b.id)) {
      if (closed.has(b.id)) toggle(b.id, false);
      else if (rows[at + 1]?.depth > rows[at].depth) focusRow(rows[at + 1].block.id);
    }
    if (e.key === "ArrowLeft") {
      if (index.has(b.id) && !closed.has(b.id)) toggle(b.id, true);
      else if (b.parentId && b.parentId !== ROOT_ID) focusRow(b.parentId);
    }
    if (e.key === "Enter" || e.key === " ") jump(b.id);
    if (e.key === "F2" && !readonly) beginRename(b.id, b.title);
  };
  // Tab キーで数百行を通過させないため、ツリー内の通常の Tab 停止位置は 1 行にする。
  const tabbable = rows.some((row) => row.block.id === active) ? active : rows[0]?.block.id;
  // Escape/Delete/Backspace はツリー内で扱い、Ctrl+Z は App の Undo まで伝える。
  return (
    <aside
      className="tree-panel"
      id="project-tree"
      aria-label={t("ツリー")}
      onKeyDown={(e) => {
        if (["Escape", "Delete", "Backspace"].includes(e.key)) e.stopPropagation();
        if (e.key === "Escape") {
          const id = menu ?? editing;
          renameTarget.current = null;
          setMenu(null);
          setEditing(null);
          if (id) focusRow(id);
        }
      }}
    >
      <div className="tree-panel__head">
        <strong>{t("ブロック")}</strong>
        {filtered && (
          <span title={t("絞り込み中・親の階層も表示")}>
            <TreeIcon name="filter" />
          </span>
        )}
        <div className="tree-panel__tools">
          <button
            className="tree-tool"
            title={t("すべて展開")}
            aria-label={t("すべて展開")}
            onClick={() => setClosed(new Set())}
          >
            <TreeIcon name="expand" />
          </button>
          <button
            className="tree-tool"
            title={t("すべて折りたたむ")}
            aria-label={t("すべて折りたたむ")}
            onClick={() => {
              setClosed(new Set(index.keys()));
              setMenu(null);
            }}
          >
            <TreeIcon name="collapse" />
          </button>
          <button
            className="tree-tool"
            title={t("サイドバーを隠す")}
            aria-label={t("ツリーを閉じる")}
            onClick={onClose}
          >
            <TreeIcon name="close" />
          </button>
        </div>
      </div>
      <div className="tree-panel__list" ref={list} role="tree" aria-label={t("ブロック")}>
        {rows.length === 0 && <p className="muted">{t("見つかりません")}</p>}
        {rows.map(({ block: b, depth }) => {
          const category = categoryOf(b.category);
          const hasKids = !!index.get(b.id)?.length;
          const expanded = hasKids && !closed.has(b.id);
          const pending = b.decisions.filter((d) => d.answer === undefined).length;
          const alert = pending
            ? t("判断待ち {count}", { count: pending })
            : b.activity?.state === "blocked"
              ? t("詰まり")
              : b.activity?.state === "waiting_review"
                ? t("確認待ち")
                : null;
          const categoryLabel = category ? t("カテゴリ: {label}", { label: t(category.label) }) : t("カテゴリなし");
          // 行を長い説明で埋めず、分類・進捗・活動はツールチップと読み上げにも渡す。
          const description = [
            b.title,
            categoryLabel,
            STATUS_LABEL[b.status],
            b.status === "gray" ? `${progress.get(b.id) ?? 0}%` : "",
            alert,
            b.activity?.actor,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <div
              className="tree-row"
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={hasKids ? expanded : undefined}
              aria-selected={selected === b.id}
              aria-label={description}
              tabIndex={tabbable === b.id ? 0 : -1}
              data-block-id={b.id}
              data-selected={selected === b.id}
              key={b.id}
              style={{ paddingLeft: 4 + depth * 16, minWidth: 150 + depth * 16 }}
              onFocus={(e) => {
                if (e.target === e.currentTarget) setActive(b.id);
              }}
              onKeyDown={(e) => onRowKey(e, b)}
              onContextMenu={(e) => {
                if (!readonly) {
                  e.preventDefault();
                  showActions(b.id);
                }
              }}
              onClick={(e) => {
                if ((e.target as Element).closest("button,input")) return;
                focusRow(b.id);
                jump(b.id);
              }}
              onDoubleClick={(e) => {
                if (!(e.target as Element).closest("button,input") && hasKids) toggle(b.id);
              }}
            >
              {/* ガイドは装飾。読み上げでは重複させず、aria-level で階層を伝える。 */}
              <span className="tree-guides" aria-hidden="true" style={{ width: depth * 16 }} />
              <button
                className="tree-branch"
                tabIndex={-1}
                disabled={!hasKids}
                aria-label={expanded ? t("閉じる") : t("開く")}
                aria-expanded={hasKids ? expanded : undefined}
                onClick={() => {
                  toggle(b.id);
                  focusRow(b.id);
                }}
              >
                <TreeIcon name="chevron" />
              </button>
              <span
                className="tree-kind"
                role="img"
                aria-label={categoryLabel}
                title={categoryLabel}
                data-category={b.category ?? ""}
                style={{ ["--cat" as string]: category?.color ?? "var(--text-muted)" }}
              >
                <TreeIcon name={b.kind === "project" ? "folder" : (category?.key ?? (hasKids ? "folder" : "box"))} />
              </span>
              {editing === b.id ? (
                <input
                  className="input tree-title-input"
                  autoFocus
                  disabled={readonly}
                  aria-label={t("題名")}
                  value={title}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => setTitle(e.target.value)}
                  onBlur={rename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      rename();
                      focusRow(b.id);
                    }
                    if (e.key === "Escape") {
                      renameTarget.current = null;
                      setEditing(null);
                      focusRow(b.id);
                    }
                  }}
                />
              ) : (
                <span className="tree-row__content" title={description}>
                  <span className="tree-row__title">{b.title}</span>
                </span>
              )}
              <ClaimMark project={project} blockId={b.id} compact />
              {alert && (
                <span className="tree-alert" role="img" aria-label={alert} title={alert}>
                  !
                </span>
              )}
              <span
                className={`tree-state ${b.status}`}
                role="img"
                aria-label={STATUS_LABEL[b.status]}
                title={description}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" />
                  {b.status === "white" ? (
                    <path d="m5 8 2 2 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  ) : b.status === "gray" ? (
                    <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" />
                  ) : null}
                </svg>
              </span>
              {!readonly && (
                <button
                  className="tree-row__menu tree-tool"
                  tabIndex={-1}
                  aria-label={t("{title} の操作", { title: b.title })}
                  aria-expanded={menu === b.id}
                  onClick={() => {
                    setMenu(menu === b.id ? null : b.id);
                    setMoving(false);
                    setTarget("");
                  }}
                >
                  …
                </button>
              )}
            </div>
          );
        })}
      </div>
      {/* 管理操作は必要なときだけ出す。追加・移動・削除は図と同じモデル規則を通す。 */}
      {current && !readonly && (
        <div className="tree-actions card" role="dialog" aria-label={t("ボックスの操作")}>
          <div className="tree-panel__head">
            <strong className="truncate">{current.title}</strong>
            <button className="btn btn-ghost btn-sm" onClick={() => setMenu(null)} aria-label={t("閉じる")}>
              ×
            </button>
          </div>
          <div className="tree-actions__buttons">
            <button className="btn btn-sm" onClick={() => add(current.id)}>
              {t("子を追加")}
            </button>
            {kindOf(current) !== "project" && current.parentId && (
              <button className="btn btn-sm" onClick={() => add(current.parentId!)}>
                {t("兄弟を追加")}
              </button>
            )}
            <button
              className="btn btn-sm"
              onClick={() => {
                beginRename(current.id, current.title);
                setMenu(null);
              }}
            >
              {t("名前を変更")}
            </button>
            {kindOf(current) !== "project" && (
              <button className="btn btn-sm" onClick={() => setMoving(!moving)}>
                {t("親を変更")}
              </button>
            )}
          </div>
          {moving && (
            <div className="tree-actions__move">
              <select
                className="input"
                aria-label={t("移動先")}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">{t("移動先を選ぶ")}</option>
                {destinations.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.key} {b.title}
                  </option>
                ))}
              </select>
              <button
                className="btn btn-primary btn-sm"
                disabled={!target}
                onClick={() => {
                  apply((p) => moveBlockToParent(p, current.id, target, { x: 40, y: 80 }));
                  jump(current.id);
                  setMenu(null);
                }}
              >
                {t("移動")}
              </button>
            </div>
          )}
          <div className="seg">
            {(["black", "gray", "white"] as BlockStatus[]).map((status) => (
              <button
                className="seg__btn"
                key={status}
                data-on={current.status === status}
                onClick={() => apply((p) => setStatus(p, current.id, status, "human"))}
              >
                {STATUS_LABEL[status]}
              </button>
            ))}
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              if (window.confirm(t("「{title}」と子ボックス・接続を削除しますか？", { title: current.title }))) {
                apply((p) => removeBlock(p, current.id));
                select({ blockId: null });
                setMenu(null);
              }
            }}
          >
            {t("削除")}
          </button>
        </div>
      )}
    </aside>
  );
}

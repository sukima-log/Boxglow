/**
 * 入力: 操作名またはカテゴリの保存キー (name: string)。出力: 16px の装飾用 SVG 要素。
 * ツリーと開閉ボタンの線幅をそろえる。カテゴリの未知値は箱に戻し、空の表示にしない。
 * SVG 自体は aria-hidden。意味と翻訳は親の title / aria-label で伝え、二重に読み上げない。
 */
export function TreeIcon({ name }: { name: string }) {
  // 24×24 の共通座標。カテゴリと同じキーにして、表示側で別の対応表を維持せずに済むようにする。
  const paths: Record<string, string> = {
    sidebar: "M3 4h18v16H3z M9 4v16",
    collapse: "M7 3h14v14 M3 7h14v14H3z M6 14h8",
    expand: "M7 3h14v14 M3 7h14v14H3z M6 14h8 M10 10v8",
    chevron: "M9 5l7 7-7 7",
    folder: "M3 6h7l2 2h9v12H3z M3 6V4h7l2 2",
    box: "M4 5h16v15H4z M4 9h16",
    study: "M9 18h6 M10 21h4 M8 15c0-3-3-3-3-7a7 7 0 0 1 14 0c0 4-3 4-3 7v1H8z",
    research: "M16 16l5 5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
    design: "M4 20 12 3l8 17 M7 14h10 M12 3v4",
    ui: "M4 4h16v16H4z M4 9h16 M9 9v11",
    build: "M8 6l-6 6 6 6 M16 6l6 6-6 6 M14 3l-4 18",
    verify: "M4 4h16v16H4z M7 12l3 3 7-7",
    evaluate: "M3 3v18h18 M7 16v-4 M12 16V8 M17 16V5",
    improve: "M3 17l7-7 4 4 7-9 M15 5h6v6",
    fix: "M14 3a6 6 0 0 0-7 7L2 17a3 3 0 0 0 5 4l7-7a6 6 0 0 0 7-7l-5 5-4-4z",
    docs: "M5 2h9l5 5v15H5z M14 2v6h5 M8 12h8 M8 16h8",
    ops: "M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.5 5.5l2 2 M16.5 16.5l2 2 M5.5 18.5l2-2 M16.5 7.5l2-2 M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0",
    filter: "M3 4h18l-7 8v7l-4 2v-9z",
    close: "M6 6l12 12 M18 6 6 18",
  };
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.box} />
    </svg>
  );
}

/** 分類名を読む前にも形で見分けられる、補助のアイコン。分類名は常に併記する。 */
export function CategoryIcon({ category }: { category: string }) {
  const paths: Record<string, string> = {
    research: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
    design: "M12 3l8 8-4 9-9-4-4-13 9 1ZM3 3l8 8m4 1a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
    build: "M8 6l-6 6 6 6m8-12 6 6-6 6M14 3l-4 18",
    verify: "M3 5l2 2 3-4m4 3h9M3 13l2 2 3-4m4 3h9M12 21h9",
    ui: "M3 3h18v18H3ZM3 9h18M9 9v12",
    docs: "M5 2h10l4 4v16H5ZM9 11h6M9 15h6M15 2v5h4",
    fix: "M14 3a6 6 0 0 0-7 8L2 17l5 5 6-6a6 6 0 0 0 8-7l-4 4-6-6Z",
    ops: "M4 4h16v6H4ZM4 14h16v6H4M7 7h1M7 17h1",
    evaluate: "M4 20V10m8 10V4m8 16v-7M2 22h20",
    improve: "M3 18l7-7 4 4 7-12M14 3h7v7",
    study: "M8 17h8M9 21h6M8 17v-2a7 7 0 1 1 8 0v2",
    other: "M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z"
  };
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[category] ?? paths.other} /></svg>;
}

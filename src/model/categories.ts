/**
 * ボックスのカテゴリ (何の種類の仕事か): 色の帯 + 文字の札で一目で分かるようにする
 * 記号 (アイコン) は直感的でないという方針なので、色と短い文字で表す。
 * 色は白文字を載せてコントラスト比 4.5 以上 (WCAG AA) になるものを選んでいる。
 */

export interface Category {
  /** 保存に使う固定のキー (英小文字) */
  key: string;
  /** ボックスに出す短い札 (日本語) */
  label: string;
  /** CLI や検索で使える英語名 */
  en: string;
  /** 帯と札の色 (白文字を載せる) */
  color: string;
  /** true なら「その他」のような色を持たない札 (枠線だけで表示) */
  neutral?: boolean;
}

export const CATEGORIES: Category[] = [
  { key: "study", label: "検討", en: "study", color: "#6b7075" }
, { key: "research", label: "調査", en: "research", color: "#7a5230" }
, { key: "design", label: "設計", en: "design", color: "#2f6fb3" }
, { key: "ui", label: "デザイン", en: "ui", color: "#c0427a" }
, { key: "build", label: "実装", en: "build", color: "#5a4fcf" }
, { key: "verify", label: "検証", en: "verify", color: "#26753d" }
, { key: "evaluate", label: "評価", en: "evaluate", color: "#8a6508" }
, { key: "improve", label: "改善", en: "improve", color: "#b5581a" }
, { key: "fix", label: "課題解決", en: "fix", color: "#c0392b" }
, { key: "docs", label: "文書", en: "docs", color: "#5f6f3a" }
, { key: "ops", label: "運用", en: "ops", color: "#1f7a8c" }
  // 迷ったときの逃げ道: どれにも当てはまらない / まだ決めない
, { key: "other", label: "その他", en: "other", color: "#8a8f94", neutral: true }
];

/**
 * キーからカテゴリを引く
 * Input : key = 保存されたキー (未設定や知らないキーなら undefined)
 * Output: Category | undefined
 */
export function categoryOf(key: string | undefined | null): Category | undefined {
  if (!key) return undefined;
  return CATEGORIES.find((c) => c.key === key);
}

/**
 * 人が入れた文字 (キー / 英語名 / 日本語の札) からカテゴリを引く (CLI 用。大文字小文字は無視)
 * Input : text = "design" / "設計" など
 * Output: Category | undefined
 */
export function findCategory(text: string): Category | undefined {
  const q = text.trim().toLowerCase();
  if (!q) return undefined;
  return CATEGORIES.find((c) => c.key === q || c.en.toLowerCase() === q || c.label === text.trim());
}

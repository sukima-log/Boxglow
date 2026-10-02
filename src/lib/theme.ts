/**
 * 表示モード (ライト / ダーク)
 * OS の設定 (prefers-color-scheme) に従い、手動で切り替えたら localStorage に記憶する。
 * html[data-theme="light|dark"] で CSS のトークンを切り替える (ブログのテーマと同じ流儀)。
 */
export type Theme = "light" | "dark";

const KEY = "boxglow:theme";

/** 今のテーマ (記憶があればそれ、無ければ OS の設定) */
export function currentTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* localStorage が使えない環境 (プライベートモード等) では OS の設定だけを見る */
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** テーマを適用する (html の data-theme と localStorage) */
export function applyTheme(theme: Theme, remember = true): void {
  document.documentElement.dataset.theme = theme;
  if (remember) {
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* 記憶できなくても表示は切り替わる */
    }
  }
}

/** 起動時: 記憶または OS 設定を適用し、OS 設定の変化にも追従する (手動で決めていない間だけ) */
export function initTheme(): void {
  applyTheme(currentTheme(), false);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (ev) => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(KEY);
    } catch {
      /* 無視 */
    }
    if (!saved) applyTheme(ev.matches ? "dark" : "light", false);
  });
}

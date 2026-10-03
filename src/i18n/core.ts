/**
 * 画面の文言の言語切り替え (日本語 / 英語)
 *
 * 方針: ソースの文言は日本語のまま書き、t("日本語の文") で包む。英語は辞書 (src/i18n/en/*.ts) で「日本語の文 → 英語」を引く。
 * 辞書に無い文は日本語のまま出る (訳し漏れがあっても壊れない)。差し込む値は {name} の形で書き、t(文, { name: 値 }) で埋める。
 * 言語の決め方: URL の ?lang=en|ja > ブラウザに記憶した値 (boxglow:lang) > ブラウザの言語 (日本語なら ja、それ以外は en)。
 * CLI (Node) では window が無いので常に日本語 (AI エージェント向けの出力は日本語のまま)。
 * このファイルは React に依存しない (model/*.ts は CLI にも束ねるため)。画面用の useLang は index.ts にある。
 */
import { en } from "./en";

export type Lang = "ja" | "en";

const STORAGE_KEY = "boxglow:lang";
const listeners = new Set<() => void>();
let current: Lang = detect();

/**
 * 最初の言語を決める
 * Input : なし (URL・localStorage・navigator を見る)
 * Output: "ja" | "en"
 */
function detect(): Lang {
  // CLI (Node): 既定は日本語。boxglow.json の lang や --lang / BOXGLOW_LANG で CLI が setLang する
  if (typeof window === "undefined") return "ja";
  try {
    const q = new URLSearchParams(window.location.search).get("lang");
    if (q === "en" || q === "ja") return q;
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "ja") return saved;
  } catch {
    /* 記憶できなくても動く */
  }
  const nav = typeof navigator !== "undefined" ? navigator.language : "ja";
  return nav.toLowerCase().startsWith("ja") ? "ja" : "en";
}

/** 今の言語 */
export const getLang = (): Lang => current;

/**
 * 言語を切り替えて記憶する (購読している画面は描き直される)
 * Input : lang
 * Output: なし
 */
export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* 記憶できなくても動く */
  }
  if (typeof document !== "undefined") document.documentElement.lang = lang;
  for (const l of listeners) l();
}

/**
 * 言語の変化を購読する (React 以外からも使える)
 * Input : cb = 変わったときに呼ぶ関数
 * Output: 購読をやめる関数
 */
export function subscribeLang(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/**
 * 文言を今の言語で返す
 * Input : ja = 日本語の文 (辞書のキー。{name} で値を差し込める), vars = 差し込む値
 * Output: 英語なら辞書の訳 (無ければ日本語)、値を埋めた文
 */
export function t(ja: string, vars?: Record<string, string | number>): string {
  const s = current === "en" ? (en[ja] ?? ja) : ja;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

if (typeof document !== "undefined") document.documentElement.lang = current;

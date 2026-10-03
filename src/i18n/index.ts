/**
 * 画面の文言の言語切り替え (日本語 / 英語)。仕組みは core.ts を参照
 * 画面 (React) からはここを import する: t / getLang / setLang / useLang
 */
import { useSyncExternalStore } from "react";
import { getLang, subscribeLang, type Lang } from "./core";

export { t, getLang, setLang, type Lang } from "./core";

/** 画面で今の言語を購読する (言語が変わると描き直す) */
export function useLang(): Lang {
  return useSyncExternalStore(subscribeLang, getLang, () => "ja");
}

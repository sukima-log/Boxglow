/**
 * 起動: テーマを当てて App を描く
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { initTheme } from "./lib/theme";
import { useProjectStore } from "./store/useProjectStore";
import "@xyflow/react/dist/style.css";
import "./index.css";

initTheme();

// PWA (B152): Service Worker は本番の画面 (boxglow.app) でだけ登録する。serve / VS Code / プレビュー / 試験では登録しない
// (登録すると、ホーム画面に追加でき、オフラインでも前回の画面と保存済みの計画を開ける)
// (?pwa=1 は試験用: 手元のプレビューでもオフラインの動きを確かめられるようにする)
if ("serviceWorker" in navigator && (/(^|\.)boxglow\.app$/.test(window.location.hostname) || new URLSearchParams(window.location.search).get("pwa") === "1") && !window.acquireVsCodeApi) {
  window.addEventListener("load", () => { navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => { /* 登録できなくても画面は動く */ }); });
}

// 動作確認やデバッグ用に、状態 (store) をコンソールから触れるようにしておく (window.boxglow.store.getState())
declare global {
  interface Window {
    boxglow: { store: typeof useProjectStore };
  }
}
window.boxglow = { store: useProjectStore };

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

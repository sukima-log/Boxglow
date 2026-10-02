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

// Vite の設定
// 配置先の URL パス (base) は環境変数 VITE_BASE で切り替える。
//   段階 1: livedoor のファイル置き場 https://www.sukimalog.com/apps/boxglow/  -> 既定値 "/apps/boxglow/"
//   段階 2: Cloudflare Pages (app.sukimalog.com)                              -> VITE_BASE=/ でビルド
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: process.env.VITE_BASE ?? "/apps/boxglow/",
  // 画面の下の帯に出すビルド日時 (配信のキャッシュで古い版を見ていないか確認するため)
  define: { __BUILD__: JSON.stringify(new Date().toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }).slice(0, 16)) },
  plugins: [react(), tailwindcss()],
  build: {
    // 更新が最大 1 時間キャッシュされる配信先 (livedoor) でも、ハッシュ付きの資産名なら即時に新しい中身が取れる
    assetsDir: "assets",
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

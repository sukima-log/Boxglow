// Vite の設定
// 配置先の URL パス (base) は環境変数 VITE_BASE で切り替える。
//   既定は相対パス "./" (npm に同梱して boxglow serve で配る dist/ と、ブログの /apps/boxglow/ の両方で動く)
//   段階 2: Cloudflare Pages (https://boxglow.pages.dev/)                     -> VITE_BASE=/ でビルド (npm run build:pages -> dist-pages/)
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: process.env.VITE_BASE ?? "./", // 相対パス: npm 同梱 (boxglow serve)、ブログの /apps/boxglow/、Pages のどこに置いても動く
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

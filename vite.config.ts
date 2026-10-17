import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Vite の設定
// 配置先の URL パス (base) は環境変数 VITE_BASE で切り替える。
//   既定は相対パス "./" (npm に同梱して boxglow serve で配る dist/ と、ブログの /apps/boxglow/ の両方で動く)
//   段階 2: Cloudflare Pages (https://boxglow.pages.dev/)                     -> VITE_BASE=/ でビルド (npm run build:pages -> dist-pages/)
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** PWA の Service Worker: scripts/sw.template.js に版 (ビルド日時) と base を埋めて、出力先の直下に sw.js として書く (フックの this には状態を持てないので閉包で持つ) */
function swPlugin() {
  let outDir = "dist", base = "/";
  return {
    name: "boxglow-sw",
    apply: "build" as const,
    configResolved(config: { build: { outDir: string }; base: string }) { outDir = config.build.outDir; base = config.base === "./" ? "/" : config.base; },   // 相対 base (npm 同梱・ブログ) では配置先が分からないので "/" を仮定 (登録は boxglow.app だけ)
    closeBundle() {
      const build = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }).slice(0, 16);
      writeFileSync(join(outDir, "sw.js"), readFileSync("scripts/sw.template.js", "utf8").replaceAll("__BUILD__", build).replaceAll("__BASE__", base));
    }
  };
}

export default defineConfig({
  base: process.env.VITE_BASE ?? "./", // 相対パス: npm 同梱 (boxglow serve)、ブログの /apps/boxglow/、Pages のどこに置いても動く
  // 画面の下の帯に出すビルド日時 (配信のキャッシュで古い版を見ていないか確認するため)
  define: { __BUILD__: JSON.stringify(new Date().toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }).slice(0, 16)) },
  plugins: [react(), tailwindcss(), swPlugin(), {
    // .md を文字列として読み込む (CLI の説明文書を vitest から読むため。esbuild の loader md:text と同じ)
    name: "md-as-text", enforce: "pre",
    load(id: string) { if (id.endsWith(".md")) return { code: `export default ${JSON.stringify(readFileSync(id, "utf8"))};`, map: null }; }
  }],
  build: {
    // 更新が最大 1 時間キャッシュされる配信先 (livedoor) でも、ハッシュ付きの資産名なら即時に新しい中身が取れる
    assetsDir: "assets",
  },
  test: {
    environment: "node",
    globalSetup: ["./cli/test-global-setup.ts"],
    setupFiles: ["./cli/test-environment.ts"],
    include: ["src/**/*.test.ts", "cli/**/*.test.ts"],
  },
});

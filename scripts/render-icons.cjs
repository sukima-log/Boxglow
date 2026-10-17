/**
 * アプリのアイコンを docs/logo/app-icon.svg から PNG に描く (Playwright の Chromium で撮る)
 *   出力: public/icon-512.png, icon-192.png, icon-180.png (any: 角丸タイルのまま), public/icon-512-maskable.png (背景を外周まで伸ばし、箱は中央 80% の安全域に)
 * 使い方: PLAYWRIGHT=<playwright の場所> node scripts/render-icons.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
const svg = fs.readFileSync(path.join(__dirname, "..", "docs", "logo", "app-icon.svg"), "utf8");
// maskable: 角丸を無くして外周まで背景にし、箱を 0.78 倍に縮めて中央へ (安全域 80% の中)
// maskable: 角丸と縁を無くして外周まで背景にし、箱を安全域 (中央 80%) に収める (1.28 → 1.0 倍 = 中央 60%)
const maskable = svg.replace(/rx="112"/g, 'rx="0"').replace(/<rect id="edge"[^>]*\/>/, "").replace('scale(1.28)', 'scale(1.0)');
// iPhone (apple-touch-icon): 角は iOS が丸めるので、透明にせず背景を全面に (透明だと黒く埋まる)。箱はそのまま
const square = svg.replace(/rx="112"/g, 'rx="0"').replace(/<rect id="edge"[^>]*\/>/, "");
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
  const shoot = async (text, size, file) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${text.replace(/width="512" height="512"/, `width="${size}" height="${size}"`)}</body></html>`);
    await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    console.log("wrote", file);
  };
  const out = path.join(__dirname, "..", "public");
  await shoot(svg, 512, path.join(out, "icon-512.png"));
  await shoot(svg, 192, path.join(out, "icon-192.png"));
  await shoot(square, 180, path.join(out, "icon-180.png"));
  await shoot(maskable, 512, path.join(out, "icon-512-maskable.png"));
  await browser.close();
})();

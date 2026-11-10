/**
 * Boxglow の全体像 (スライド 1 枚のポンチ絵) を、日本語と英語の画像に書き出す
 *
 * 元: docs/overview/overview.html (ひな形。文言は {{キー}}) と docs/overview/strings.json (キーごとの ja / en)
 * 出力:
 *   docs/overview/overview.ja.png / overview.en.png   2560x1440 (README・ブログ・SNS 用)
 *   public/overview/overview.ja.webp / overview.en.webp 1600x900 (boxglow.app の Home で開く図。軽くするため WebP)
 *
 * 撮影には Chrome を使う (日本語の書体 BIZ UDPゴシックと英語の書体 Segoe UI がある Windows の Chrome を想定)。
 * 撮る前に、開いたページで各区画の文字の右端と下端を測り、区画からはみ出した文言があれば知らせる。
 * 右上の名前の下に、図が説明している版 (package.json の version) を入れる。版を上げたら書き出し直す。
 *
 * 使い方: node scripts/render-overview.mjs [ja|en]   (言語を省くと両方)
 *   Chrome の場所は環境変数 CHROME で変えられる (既定: WSL から見た Windows の Chrome)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "docs", "overview");
const CHROME = process.env.CHROME ?? "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe";
// 図の大きさ (CSS px) と、撮る密度 (2 倍で撮り、縮小されても文字がにじまないようにする)
const WIDTH = 1280;
const HEIGHT = 720;
const SCALE = 2;
// Home で開く図の幅 (px)
const WEB_WIDTH = 1600;

/**
 * Chrome に渡すパスにする (WSL から Windows の Chrome を使うときは \\wsl.localhost\... に変える)
 * Input : path = このマシンの絶対パス
 * Output: Chrome が読めるパスの文字列
 */
function chromePath(path) {
  if (!CHROME.startsWith("/mnt/")) return path;
  return execFileSync("wslpath", ["-w", path], { encoding: "utf8" }).trim();
}

/**
 * Chrome に渡す URL にする
 * Input : path = HTML の絶対パス
 * Output: file:/// の URL
 */
function fileUrl(path) {
  const p = chromePath(path).replace(/\\/g, "/");
  return p.startsWith("/") ? `file://${p}` : `file:///${p}`;
}

/**
 * Chrome を画面なしで動かす
 * Input : args = Chrome の引数 (共通の --headless などは付ける)
 * Output: 標準出力の文字列
 */
function chrome(args) {
  return execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
}

// 図に添える版 (この図が説明している Boxglow の版)。package.json の version をそのまま使うので、版を上げて書き出し直せば変わる
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

/**
 * ひな形に文言を差し込む
 * Input : template = ひな形の HTML, strings = { キー: { ja, en } }, lang = "ja" | "en"
 * Output: その言語の HTML (キーが表に無い・訳が無いときは止める。{{lang}} は言語、{{version}} は package.json の版)
 */
function fill(template, strings, lang) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (key === "lang") return lang;
    if (key === "version") return VERSION;
    const s = strings[key]?.[lang];
    if (!s) throw new Error(`strings.json に ${key} の ${lang} がありません`);
    return s;
  });
}

// はみ出しを測る仕掛け (開いたページの末尾に足す)。結果は <pre id="probe"> に書き、--dump-dom で受け取る
const PROBE = `<pre id="probe"></pre><script>
const out = [];
for (const zone of document.querySelectorAll(".zone, .band")) {
  const z = zone.getBoundingClientRect(), cs = getComputedStyle(zone);
  const right = z.right - parseFloat(cs.paddingRight) + 1, bottom = z.bottom - 2;
  for (const el of zone.querySelectorAll(".lb, .cp, .cardlb b, .cardlb > span, h2, .who, .grp, .rowlb, .legend span")) {
    const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect();
    if (b.right > right || b.bottom > bottom) out.push(el.textContent.trim() + " (右 " + (b.right - right).toFixed(1) + "px / 下 " + (b.bottom - bottom).toFixed(1) + "px)");
  }
}
const head = document.querySelector(".head h1").getBoundingClientRect(), brand = document.querySelector(".brand").getBoundingClientRect();
if (head.right > brand.left - 16) out.push("見出しが右上の名前に近すぎます (" + (head.right - brand.left + 16).toFixed(1) + "px)");
document.getElementById("probe").textContent = out.join("\\n");
</script></body>`;

/**
 * 1 つの言語を書き出す
 * Input : lang = "ja" | "en", work = 作業用のフォルダ
 * Output: はみ出した文言の一覧 (無ければ空)
 */
function render(lang, work) {
  const template = readFileSync(join(SRC, "overview.html"), "utf8");
  const strings = JSON.parse(readFileSync(join(SRC, "strings.json"), "utf8"));
  const html = fill(template, strings, lang);

  // 1. はみ出しを測る
  const probeHtml = join(work, `probe.${lang}.html`);
  writeFileSync(probeHtml, html.replace("</body>", PROBE));
  const dom = chrome([`--window-size=${WIDTH},${HEIGHT}`, "--virtual-time-budget=3000", "--dump-dom", fileUrl(probeHtml)]);
  const m = dom.match(/<pre id="probe">([\s\S]*?)<\/pre>/);
  const overflow = m && m[1].trim() ? m[1].trim().split("\n") : [];

  // 2. 撮る (窓の大きさ = 図の大きさなので、切り落としは要らない)
  const page = join(work, `overview.${lang}.html`);
  writeFileSync(page, html);
  const png = join(SRC, `overview.${lang}.png`);
  rmSync(png, { force: true });
  chrome([`--force-device-scale-factor=${SCALE}`, `--window-size=${WIDTH},${HEIGHT}`, "--virtual-time-budget=3000", `--screenshot=${chromePath(png)}`, fileUrl(page)]);
  if (!existsSync(png)) throw new Error(`${lang} の撮影に失敗しました`);

  // 3. Home 用の WebP (幅 1600px)。PNG を data: URL で読み込み、Chrome の canvas で縮めて WebP にする
  const b64 = readFileSync(png).toString("base64");
  const conv = join(work, `webp.${lang}.html`);
  const height = Math.round((WEB_WIDTH * HEIGHT) / WIDTH);
  writeFileSync(conv, `<!doctype html><body><pre id="out"></pre><script>
const img = new Image();
img.onload = () => {
  const c = document.createElement("canvas"); c.width = ${WEB_WIDTH}; c.height = ${height};
  const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(img, 0, 0, c.width, c.height);
  document.getElementById("out").textContent = c.toDataURL("image/webp", 0.9);
};
img.src = "data:image/png;base64,${b64}";
</script></body>`);
  const out = chrome(["--virtual-time-budget=5000", "--dump-dom", fileUrl(conv)]);
  const w = out.match(/data:image\/webp;base64,([A-Za-z0-9+/=]+)/);
  if (!w) throw new Error(`${lang} の WebP を作れませんでした`);
  const webDir = join(ROOT, "public", "overview");
  mkdirSync(webDir, { recursive: true });
  writeFileSync(join(webDir, `overview.${lang}.webp`), Buffer.from(w[1], "base64"));
  return overflow;
}

const langs = process.argv[2] ? [process.argv[2]] : ["ja", "en"];
const work = mkdtempSync(join(tmpdir(), "boxglow-overview-"));
let bad = false;
try {
  for (const lang of langs) {
    const overflow = render(lang, work);
    console.log(`${lang}: docs/overview/overview.${lang}.png, public/overview/overview.${lang}.webp`);
    for (const line of overflow) console.log(`  はみ出し: ${line}`);
    if (overflow.length) bad = true;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (bad) process.exitCode = 1;

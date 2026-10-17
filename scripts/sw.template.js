/* eslint-disable */
/**
 * Boxglow の Service Worker (PWA。B152)。ビルド時に scripts/sw.template.js から dist/sw.js を作る (版・base・資産の一覧を埋める)
 *   - 入れたとき (install) に、画面の入口 (index.html) と、ビルドした資産 (assets/ の JS / CSS) を 1 つずつ控える
 *     (1 つ失敗しても続ける。iPhone の「ホーム画面に追加」は Safari と別の保存領域なので、最初の起動で全部そろえる必要がある)
 *   - 画面の入口 (HTML) は「まずネット、だめなら控え」: 配備した新しい版をすぐ出し、オフラインでは前回の画面を出す
 *   - ハッシュ付きの資産 (assets/) は「控えがあればそれ、無ければ取って控える」(名前がハッシュなので古くならない)
 *   - それ以外 (同期サーバーや外部) は触らない (ネットのまま)。新しい版が入ったら古い控えを消す。登録は boxglow.app だけ (src/main.tsx)
 */
const VERSION = "__BUILD__";
const BASE = "__BASE__";
const ASSETS = __ASSETS__;
const CACHE = "boxglow-" + VERSION;
const SHELL_KEY = BASE;   // 入口の控えの鍵 (どの経路の入口でもこの 1 つに控える)
const EXTRA = [BASE + "manifest.webmanifest", BASE + "icon-192.png", BASE + "icon-512.png", BASE + "favicon.svg"];

/** 1 つずつ取って控える (失敗しても続ける)。Input: 控え, URL の一覧 */
async function precache(cache, urls) {
  for (const url of urls) {
    try { const res = await fetch(url, { cache: "no-cache" }); if (res.ok) await cache.put(url, res); } catch (e) { /* 次の起動で取り直す */ }
  }
}
/** 入口 (index.html) を取って控える。Output: 控えられたか */
async function cacheShell(cache) {
  try { const res = await fetch(BASE, { cache: "no-cache" }); if (res.ok) { await cache.put(SHELL_KEY, res); return true; } } catch (e) { /* オフライン */ }
  return false;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cacheShell(cache);
    await precache(cache, ASSETS.map((a) => BASE + a).concat(EXTRA));
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("boxglow-") && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                 // 同期サーバーやフォントは触らない
  if (!url.pathname.startsWith(BASE)) return;
  if (url.pathname.startsWith(BASE + "api/") || url.pathname.startsWith(BASE + "v1/")) return;
  if (req.mode === "navigate" || req.destination === "document") {
    // 入口: ネット優先。取れたら控えを更新。だめなら控え
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try { const res = await fetch(req); if (res.ok) await cache.put(SHELL_KEY, res.clone()); return res; }
      catch (e) { const hit = await cache.match(SHELL_KEY, { ignoreVary: true }); return hit ?? Response.error(); }
    })());
    return;
  }
  // 資産・マニフェスト・アイコン: 控え優先、無ければ取って控える
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // (Vary: Origin などで取り違えない: 鍵は URL だけで照合する)
    const hit = await cache.match(req, { ignoreVary: true, ignoreSearch: false });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) await cache.put(req, res.clone());
    return res;
  })());
});

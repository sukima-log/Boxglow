/* eslint-disable */
/**
 * Boxglow の Service Worker (PWA。B152)。ビルド時に scripts/sw.template.js から dist/sw.js を作る (__BUILD__ と __BASE__ を埋める)
 *   - 画面の入口 (HTML) は「まずネット、だめなら控え」: 配備した新しい版をすぐ出し、オフラインでは前回の画面を出す
 *   - ハッシュ付きの資産 (assets/) は「控えがあればそれ、無ければ取って控える」(名前がハッシュなので古くならない)
 *   - それ以外 (同期サーバーや外部) は触らない (ネットのまま)
 *   - 新しい版が入ったら古い控えを消す。登録は boxglow.app だけ (src/main.tsx)
 */
const VERSION = "__BUILD__";
const BASE = "__BASE__";
const CACHE = "boxglow-" + VERSION;
const SHELL = [BASE, BASE + "index.html", BASE + "manifest.webmanifest", BASE + "icon-192.png", BASE + "icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("boxglow-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                 // 同期サーバーやフォントは触らない
  if (!url.pathname.startsWith(BASE)) return;
  if (url.pathname.startsWith(BASE + "api/") || url.pathname.startsWith(BASE + "v1/")) return;
  const isAsset = url.pathname.startsWith(BASE + "assets/");
  if (isAsset) {
    // 資産: 控え優先 (名前にハッシュが付くので、同じ名前は同じ中身)
    event.respondWith(caches.match(req).then((hit) => hit ?? fetch(req).then((res) => { if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone())); return res; })));
    return;
  }
  if (req.mode === "navigate" || req.destination === "document") {
    // 入口: ネット優先。だめなら控えの index.html
    event.respondWith(fetch(req).then((res) => { if (res.ok) caches.open(CACHE).then((c) => c.put(BASE + "index.html", res.clone())); return res; }).catch(() => caches.match(BASE + "index.html").then((hit) => hit ?? Response.error())));
    return;
  }
  // そのほか (マニフェスト・アイコン・favicon): 控えがあれば控え、無ければネット
  event.respondWith(caches.match(req).then((hit) => hit ?? fetch(req).then((res) => { if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone())); return res; })));
});

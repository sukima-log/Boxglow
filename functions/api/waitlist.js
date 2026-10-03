/**
 * 待ちリスト (Boxglow Cloud の案内希望) の受付。Cloudflare Pages Functions。
 * POST /api/waitlist  JSON { email, note?, want? }  -> 200 { ok: true }
 * - email は必須。形だけ検査し、小文字にして KV のキー (email:<addr>) に保存する (同じ人は上書き = 重複しない)
 * - note は 500 文字まで、want は興味のある機能 (配列) を 10 個まで
 * - hp (honeypot) に値があれば bot とみなし、保存せず 200 を返す
 * - 同じ IP から 1 分に 5 回を超えたら 429
 * 保存する値: { email, note, want, at, ua, lang } (個人情報はメールだけ。IP は保存しない)
 */
const MAX_NOTE = 500;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export async function onRequestPost(context) {
  const { request, env } = context;
  let data;
  try {
    data = await request.json();
  } catch {
    return json(400, { ok: false, error: "JSON を送ってください" });
  }
  if (typeof data.hp === "string" && data.hp.trim() !== "") return json(200, { ok: true }); // bot
  const email = String(data.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json(400, { ok: false, error: "メールアドレスの形が違います" });
  // 簡単な回数制限 (IP ごと、1 分)
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const rlKey = `rl:${ip}:${Math.floor(Date.now() / 60000)}`;
  const count = Number((await env.WAITLIST.get(rlKey)) ?? "0");
  if (count >= 5) return json(429, { ok: false, error: "少し時間をおいてからもう一度お試しください" });
  await env.WAITLIST.put(rlKey, String(count + 1), { expirationTtl: 120 });
  const record = {
    email
  , note: String(data.note ?? "").slice(0, MAX_NOTE)
  , want: Array.isArray(data.want) ? data.want.map((w) => String(w).slice(0, 40)).slice(0, 10) : []
  , at: new Date().toISOString()
  , ua: (request.headers.get("user-agent") ?? "").slice(0, 200)
  , lang: (request.headers.get("accept-language") ?? "").slice(0, 60)
  };
  await env.WAITLIST.put(`email:${email}`, JSON.stringify(record));
  return json(200, { ok: true });
}

export async function onRequestGet() {
  return json(405, { ok: false, error: "POST で送ってください" });
}

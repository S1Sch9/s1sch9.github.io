import { adminPage } from "./admin-page.js";
import { buildPushPayload } from "@block65/webcrypto-web-push";

// Combined appeals and news administration.
const SITE_ORIGIN = "https://s1sch9.github.io";
const MAX_BODY = 8192;
const MAX_WEBHOOK_BODY = 256 * 1024;
const MAX_UPLOAD_BODY = 22 * 1024 * 1024;
const MAX_MESSAGE = 1500;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...securityHeaders(), "content-type": "application/json; charset=utf-8", ...headers }
  });
}
function securityHeaders() {
  return {
    "Strict-Transport-Security": "max-age=31536000",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "X-Permitted-Cross-Domain-Policies": "none",
    "Cache-Control": "no-store"
  };
}
async function readRequestBytes(request, maxBytes = MAX_BODY) {
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("body-too-large");
  }
  if (!request.body) throw new Error("empty-body");
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("body-too-large");
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
async function readJsonBody(request, maxBytes = MAX_BODY) {
  const bytes = await readRequestBytes(request, maxBytes);
  const body = JSON.parse(new TextDecoder().decode(bytes));
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("invalid-json-object");
  }
  return body;
}
function cors(origin) {
  if (origin !== SITE_ORIGIN) return {};
  return {
    "Access-Control-Allow-Origin": SITE_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}
function cleanText(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function constantTimeEqual(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
function authorized(request, env) {
  const expected = env.ADMIN_TOKEN || "";
  const got = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  return expected.length >= 32 && got.length > 0 && constantTimeEqual(got, expected);
}
async function verifyTurnstile(token, request, env) {
  if (!env.TURNSTILE_SECRET) return { ok: false, reason: "missing-secret" };
  if (!token) return { ok: false, reason: "missing-token" };
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret: env.TURNSTILE_SECRET,
      response: token
    })
  });
  const raw = await response.text();
  let result = null;
  try { result = JSON.parse(raw); } catch {}
  // Siteverify normally returns JSON even for rejected tokens. Preserve its
  // safe error codes so configuration problems can be diagnosed accurately.
  if (result && Array.isArray(result["error-codes"]) && result["error-codes"].length) {
    return { ok: false, reason: result["error-codes"].join(",") };
  }
  if (!response.ok) {
    return { ok: false, reason: "siteverify-http-" + response.status };
  }
  if (!result || typeof result.success !== "boolean") {
    return { ok: false, reason: "invalid-siteverify-response" };
  }
  if (!result.success) return { ok: false, reason: "verification-failed" };
  if (result.hostname !== "s1sch9.github.io") {
    return { ok: false, reason: "hostname-mismatch" };
  }
  return { ok: true };
}
async function ensureAppealSecurity(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS appeal_ip_blocks (
    ip_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, note TEXT NOT NULL DEFAULT ''
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS appeal_sender_keys (
    appeal_id INTEGER PRIMARY KEY, ip_hash TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS appeal_security_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ip_hash TEXT NOT NULL, event TEXT NOT NULL, created_at INTEGER NOT NULL
  )`).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_appeal_security_events_time ON appeal_security_events(created_at)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_appeal_security_events_ip ON appeal_security_events(ip_hash, created_at)").run();
}
async function clientIpHash(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return sha256("s1sch9-appeals-rate:" + ip);
}
async function isIpBlocked(env, hash) {
  await ensureAppealSecurity(env);
  return !!(await env.DB.prepare("SELECT ip_hash FROM appeal_ip_blocks WHERE ip_hash = ?").bind(hash).first());
}
async function logSecurityEvent(env, hash, event) {
  await ensureAppealSecurity(env);
  await env.DB.prepare("INSERT INTO appeal_security_events (ip_hash, event, created_at) VALUES (?, ?, ?)")
    .bind(hash, event, Math.floor(Date.now() / 1000)).run();
}
async function rateAllowed(env, key) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS appeal_rate_limits (
      ip_hash TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL
    )
  `).run();
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(`
    INSERT INTO appeal_rate_limits (ip_hash, window_start, attempts) VALUES (?, ?, 1)
    ON CONFLICT(ip_hash) DO UPDATE SET
      attempts = CASE WHEN window_start <= ? THEN 1 ELSE attempts + 1 END,
      window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END
    RETURNING attempts
  `).bind(key, now, now - 3600, now - 3600, now).first();
  return { allowed: !!row && row.attempts <= 10, attempts: row?.attempts || 0 };
}
async function ensureTelegramNews(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_news (
    id TEXT PRIMARY KEY, date TEXT NOT NULL, text TEXT NOT NULL, media TEXT NOT NULL DEFAULT '[]'
  )`).run();
  // Additive migrations preserve every existing publication and media reference.
  for (const sql of [
    "ALTER TABLE telegram_news ADD COLUMN title TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE telegram_news ADD COLUMN description TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE telegram_news ADD COLUMN publish_at TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE telegram_news ADD COLUMN status TEXT NOT NULL DEFAULT 'published'"
  ]) {
    try { await env.DB.prepare(sql).run(); } catch {}
  }
}
async function telegramApi(env, method, payload) {
  const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/" + method, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload || {})
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error("Telegram API error");
  return result.result;
}
async function telegramReply(env, chatId, text, replyMarkup) {
  return telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

async function ensurePushTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    subscription_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS push_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`).run();
}
async function sendPushNotifications(env, data) {
  try {
    await ensurePushTables(env);
    const setting = await env.DB.prepare("SELECT value FROM push_settings WHERE key = 'public_key'").first();
    if (!setting?.value || !env.VAPID_PRIVATE_KEY) return { sent: 0, skipped: true };
    const rows = await env.DB.prepare("SELECT endpoint, subscription_json FROM push_subscriptions").all();
    const vapid = {
      subject: "https://s1sch9.github.io",
      publicKey: setting.value,
      privateKey: env.VAPID_PRIVATE_KEY
    };
    let sent = 0;
    await Promise.all((rows.results || []).map(async row => {
      try {
        const subscription = JSON.parse(row.subscription_json);
        const payload = await buildPushPayload({
          data,
          options: { ttl: 3600, urgency: "high", topic: "new-appeal" }
        }, subscription, vapid);
        const response = await fetch(row.endpoint, payload);
        if (response.status === 404 || response.status === 410) {
          await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(row.endpoint).run();
        } else if (response.ok) {
          sent++;
        } else {
          console.error("Push delivery returned status", response.status);
        }
      } catch (error) {
        console.error("Push delivery failed");
      }
    }));
    return { sent, skipped: false };
  } catch (error) {
    console.error("Push notification processing failed");
    return { sent: 0, failed: true };
  }
}
async function ensureTelegramAppeals(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_appeal_sessions (
    chat_id TEXT PRIMARY KEY,
    awaiting INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    rules_accepted INTEGER NOT NULL DEFAULT 0
  )`).run();
  // Existing bot users must also confirm the current rules once.
  try { await env.DB.prepare("ALTER TABLE telegram_appeal_sessions ADD COLUMN rules_accepted INTEGER NOT NULL DEFAULT 0").run(); } catch {}
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_appeal_updates (
    update_id INTEGER PRIMARY KEY,
    created_at INTEGER NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_appeal_sender_keys (
    appeal_id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_appeal_blocks (
    chat_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, note TEXT NOT NULL DEFAULT ''
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_appeal_rate_limits (
    chat_id TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL
  )`).run();
}
async function clearTelegramCommands(env) {
  // Убираем старое меню slash-команд: бот работает через понятные кнопки.
  await telegramApi(env, "deleteMyCommands", {});
}
async function telegramWebhook(request, env) {
  if (!env.TELEGRAM_WEBHOOK_SECRET ||
      !constantTimeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "", env.TELEGRAM_WEBHOOK_SECRET)) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!env.TELEGRAM_BOT_TOKEN) return json({ error: "Bot is not configured" }, 503);
  const update = await readJsonBody(request, MAX_WEBHOOK_BODY);
  const callback = update && update.callback_query;
  const msg = update && update.message;
  const chat = callback?.message?.chat || msg?.chat;
  if (!chat || chat.type !== "private") return json({ ok: true });
  const chatId = String(chat.id);
  const text = cleanText(msg?.text, 64);
  const keyboard = {
    keyboard: [[{ text: "✍️ Написать обращение" }]],
    resize_keyboard: true,
    is_persistent: true
  };
  const cancelKeyboard = {
    keyboard: [[{ text: "↩️ Отменить отправку" }]],
    resize_keyboard: true,
    is_persistent: true
  };
  const rulesText = `📋 ПРАВИЛА ПОЛЬЗОВАНИЯ

Пожалуйста, ознакомьтесь с правилами перед отправкой обращения.

1. О ЧЁМ МОЖНО НАПИСАТЬ
Идеи по улучшению школы, предложения мероприятий, конструктивную обратную связь, новости и интересные события школьной жизни.

2. ЧТО НЕДОПУСТИМО
Оскорбления, угрозы, нецензурная лексика, спам, реклама и сообщения, не относящиеся к проекту.

3. КОНФИДЕНЦИАЛЬНОСТЬ И ПУБЛИКАЦИЯ
Бот не запрашивает имя и контакты. Подходящие обращения могут быть опубликованы на сайте без указания автора. Личная информация не публикуется.

4. КАК МЫ РАССМАТРИВАЕМ ОБРАЩЕНИЯ
Каждое обращение мы читаем и обсуждаем. Если идея подходит и есть возможность, постараемся воплотить её в школьной жизни. Если пока не получается, вернёмся к ней позже.

5. ВАЖНЫЙ МОМЕНТ
Отправка обращения не означает, что предложение обязательно будет реализовано. Всё зависит от возможностей, безопасности и необходимых согласований.`;
  await ensureTelegramAppeals(env);
  const telegramBlock = await env.DB.prepare("SELECT chat_id FROM telegram_appeal_blocks WHERE chat_id = ?").bind(chatId).first();
  if (telegramBlock) {
    await telegramReply(env, chatId, "⛔ Доступ к отправке обращений в Telegram-боте заблокирован из-за нарушения правил пользования ботом Совета. Если вы считаете, что блокировка произошла по ошибке, обратитесь к Совету.");
    return json({ ok: true });
  }
  if (Number.isSafeInteger(update.update_id)) {
    const seen = await env.DB.prepare("INSERT OR IGNORE INTO telegram_appeal_updates (update_id, created_at) VALUES (?, ?)")
      .bind(update.update_id, Math.floor(Date.now() / 1000)).run();
    if (!seen.meta.changes) return json({ ok: true });
  }
  if (callback) {
    try { await telegramApi(env, "answerCallbackQuery", { callback_query_id: callback.id }); } catch {}
    return json({ ok: true });
  }
  if (!msg) return json({ ok: true });
  const command = text.split(/\\s/)[0].toLowerCase();
  if (command === "/start") {
    await env.DB.prepare("INSERT INTO telegram_appeal_sessions (chat_id, awaiting, updated_at) VALUES (?, 0, ?) ON CONFLICT(chat_id) DO UPDATE SET awaiting=0, updated_at=excluded.updated_at")
      .bind(chatId, Math.floor(Date.now() / 1000)).run();
    // Согласие с правилами сохраняется между запусками бота и новыми обращениями.
    await telegramReply(env, chatId,
      "💙 Добро пожаловать!\n\nЭто бот обратной связи Совета Первых школы № 9. Здесь можно поделиться идеей, предложением или задать вопрос.\n\nНажмите «Написать обращение», чтобы начать. Сначала бот предложит ознакомиться с правилами, а после подтверждения вы сможете написать обращение прямо здесь, в чате. 💙",
      keyboard);
    return json({ ok: true });
  }
  if (command === "/cancel" || text === "Отмена" || text === "↩️ Отменить отправку") {
    await env.DB.prepare("INSERT INTO telegram_appeal_sessions (chat_id, awaiting, updated_at) VALUES (?, 0, ?) ON CONFLICT(chat_id) DO UPDATE SET awaiting=0, updated_at=excluded.updated_at")
      .bind(chatId, Math.floor(Date.now() / 1000)).run();
    await telegramReply(env, chatId, "↩️ Отправка отменена.\n\nЕсли появится идея или вопрос — мы всегда на связи! 💙", keyboard);
    return json({ ok: true });
  }
  if (command === "/new" || text === "✍️ Написать обращение") {
    const previous = await env.DB.prepare("SELECT rules_accepted FROM telegram_appeal_sessions WHERE chat_id = ?").bind(chatId).first();
    const accepted = Number(previous?.rules_accepted) === 1;
    await env.DB.prepare("INSERT INTO telegram_appeal_sessions (chat_id, awaiting, updated_at, rules_accepted) VALUES (?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET awaiting=excluded.awaiting, updated_at=excluded.updated_at")
      .bind(chatId, accepted ? 1 : 0, Math.floor(Date.now() / 1000), accepted ? 1 : 0).run();
    if (accepted) {
      await telegramReply(env, chatId,
        "💙 Вы уже ознакомились с правилами и подтвердили согласие. Повторно читать их не нужно.\n\nНапишите своё обращение следующим сообщением прямо здесь. Максимальная длина — 1500 символов. Если передумали, нажмите «Отменить отправку».",
        cancelKeyboard);
    } else {
      await telegramReply(env, chatId,
        "📖 Перед отправкой обращения, пожалуйста, прочитайте правила пользования.\n\nНажмите кнопку ниже. В приложении будут только правила и подтверждение согласия. После этого вы сможете написать своё обращение следующим сообщением в этом чате.",
        { inline_keyboard: [[{ text: "📖 Прочитать правила", web_app: { url: "https://s1sch9.github.io/appeal-app.html?v=rules-only-2" } }]] });
    }
    return json({ ok: true });
  }
  const session = await env.DB.prepare("SELECT awaiting, rules_accepted FROM telegram_appeal_sessions WHERE chat_id = ?").bind(chatId).first();
  if (!session || !session.awaiting) {
    await telegramReply(env, chatId, "💬 Чтобы начать новое обращение, нажмите «Написать обращение» внизу чата. Сначала откроются правила пользования.", keyboard);
    return json({ ok: true });
  }
  if (!session.rules_accepted) {
    await env.DB.prepare("UPDATE telegram_appeal_sessions SET awaiting=0 WHERE chat_id=?").bind(chatId).run();
    await telegramReply(env, chatId, "Сначала ознакомьтесь с правилами пользования и подтвердите согласие.", keyboard);
    await telegramReply(env, chatId, rulesText,
      { inline_keyboard: [[{ text: "✓ Я ознакомился(ась) и согласен(на)", callback_data: "appeal_rules_accept" }]] });
    return json({ ok: true });
  }
  const rawMessage = typeof (msg.text || msg.caption) === "string" ? (msg.text || msg.caption).trim() : "";
  if (rawMessage.length > MAX_MESSAGE) {
    await telegramReply(env, chatId, "📝 Получилось слишком длинное сообщение.\n\nМаксимальный объём — 1500 символов. Немного сократите текст и отправьте его ещё раз, пожалуйста.", cancelKeyboard);
    return json({ ok: true });
  }
  const message = cleanText(rawMessage, MAX_MESSAGE);
  if (message.length < 5) {
    await telegramReply(env, chatId, "💙 Кажется, сообщение получилось слишком коротким.\n\nДобавьте немного подробностей — нужно хотя бы 5 символов. Если передумали, нажмите «Отменить отправку».", cancelKeyboard);
    return json({ ok: true });
  }
  const rateNow = Math.floor(Date.now() / 1000);
  const rateRow = await env.DB.prepare(`
    INSERT INTO telegram_appeal_rate_limits (chat_id, window_start, attempts) VALUES (?, ?, 1)
    ON CONFLICT(chat_id) DO UPDATE SET
      attempts = CASE WHEN window_start <= ? THEN 1 ELSE attempts + 1 END,
      window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END
    RETURNING attempts
  `).bind(chatId, rateNow, rateNow - 3600, rateNow - 3600, rateNow).first();
  if (!rateRow || rateRow.attempts > 10) {
    await telegramReply(env, chatId, "🛡 В целях безопасности с одного аккаунта можно отправить не более 10 обращений в час. Пожалуйста, попробуйте позже.", keyboard);
    return json({ ok: true });
  }
  const insertedAppeal = await env.DB.prepare("INSERT INTO appeals (role, category, message, status) VALUES (?, ?, ?, 'new')")
    .bind("Telegram", "Через Telegram-бота", message).run();
  if (insertedAppeal.meta?.last_row_id) {
    await env.DB.prepare("INSERT OR REPLACE INTO telegram_appeal_sender_keys (appeal_id, chat_id) VALUES (?, ?)")
      .bind(insertedAppeal.meta.last_row_id, chatId).run();
  }
  await sendPushNotifications(env, {
    title: "Совет Первых · Новое обращение",
    body: "Поступило обращение из Telegram-бота. Нажмите, чтобы открыть админку.",
    url: "/admin#appeals",
    tag: "new-appeal"
  });
  await env.DB.prepare("UPDATE telegram_appeal_sessions SET awaiting=0, updated_at=? WHERE chat_id=?")
    .bind(Math.floor(Date.now() / 1000), chatId).run();
  await telegramReply(env, chatId,
    "✨ Спасибо! Ваше обращение уже поступило в Совет Первых.\n\nМы внимательно прочитаем его, обсудим предложение и постараемся воплотить полезную идею в школьной жизни.\n\n💙 Важен каждый голос — вместе мы можем сделать школу лучше!\n\nЕсли появится ещё одна идея, вы всегда можете отправить новое обращение.",
    keyboard);
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const headers = securityHeaders();


    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      try { return await telegramWebhook(request, env); }
      catch (error) { return json({ error: "Webhook processing failed" }, 500); }
    }
    if (url.pathname === "/api/news" && request.method === "GET") {
      try {
        await ensureTelegramNews(env);
        const result = await env.DB.prepare("SELECT id, date, text, media, title, description, publish_at, status FROM telegram_news WHERE status = 'published' AND (publish_at = '' OR publish_at <= ?) ORDER BY date DESC, rowid DESC LIMIT 50")
          .bind(new Date().toISOString()).all();
        const items = (result.results || []).map(item => {
          const lines = String(item.text || "").split(/\r?\n/);
          const fallbackTitle = lines.shift() || "Новость";
          return {
            id: item.id,
            date: item.date,
            text: item.text,
            title: item.title || fallbackTitle,
            description: item.description || lines.join("\n").trim(),
            media: JSON.parse(item.media || "[]").map((m, index) => ({
              type: m.type,
              url: new URL("/api/news-media/" + encodeURIComponent(item.id) + "/" + index, request.url).toString()
            }))
          };
        });
        return json(items, 200, { ...headers, ...cors(origin) });
      } catch { return json([], 200, { ...headers, ...cors(origin) }); }
    }
    const mediaMatch = url.pathname.match(/^\/api\/news-media\/([^/]+)\/(\d+)$/);
    if (mediaMatch && request.method === "GET") {
      try {
        await ensureTelegramNews(env);
        const item = await env.DB.prepare("SELECT media, status, publish_at FROM telegram_news WHERE id = ?").bind(decodeURIComponent(mediaMatch[1])).first();
        const nowIso = new Date().toISOString();
        const isPublic = item && item.status === "published" && (!item.publish_at || item.publish_at <= nowIso);
        const media = isPublic ? JSON.parse(item.media || "[]")[Number(mediaMatch[2])] : null;
        if (!media || !media.file_id || !env.TELEGRAM_BOT_TOKEN) return new Response("Not found", { status: 404, headers });
        const fileInfo = await telegramApi(env, "getFile", { file_id: media.file_id });
        const fileResponse = await fetch("https://api.telegram.org/file/bot" + env.TELEGRAM_BOT_TOKEN + "/" + fileInfo.file_path);
        if (!fileResponse.ok) return new Response("Media unavailable", { status: 502, headers });
        return new Response(fileResponse.body, { headers: { ...headers, ...cors(origin), "Content-Type": fileResponse.headers.get("Content-Type") || (media.type === "video" ? "video/mp4" : "image/jpeg"), "Cache-Control": "public, max-age=3600" } });
      } catch { return new Response("Media unavailable", { status: 502, headers }); }
    }
    if (url.pathname === "/admin-icon.png" && request.method === "GET") {
      const icon = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAAAD8UlEQVR42u3dQXLbMAxGYZujm6QXycXbi+Qu6cKbTuM4tiQSBPi9fUcW8fQTpBj1+vvydgHu0QwByAFygBwgB8gBcoAcIAfIAXIA5AA5QA6QA+QAOUAOkAPkADkAcoAcIAfIAXKAHCAHyAFyrMT758fKt78x4FU//lx/LXLv16rf53j//DhYxedjo6ouBeX4t6hHyvbqnFJPkTpyfFfLfTU70m2UsWQrrEXs7ymgSO7keFKLHXU6S7jUimSVo2tDcHoUJVWkZdRiR/EW37FYQo4jNX7y39IoX0OqZnqO7lo8nv57KJi3J92WMkMCFZFDFTWkIMdKUzU5QA7hsfAtSA6QA/Xk0JaSoyz7XhNe5tjmWW77fPIU/O9mY4Oz1RjTLCnSI2P64U8TZjcm8NnI0XOUDI8JoyJfz1Gs80j0bDRmuP2sPYcX91YrzJhxKGyCYRo5nn8CxEb4gGwz3KQXKJaywiDZslbPgQnkEBvphlFyIFoOsZFxMCUHQuUQG0mH1HmOR4vDxbXuvs8x7fjGfutn/C1Ijl5jevsnqwXJRoukigzYKm3MmLAqP/6AMb+hMSOXH3XerRRO4BA/Bl+0fnL0G9DBpRqvY2PG/AUb1mQsJMewyhULjBVXK/wmR8CwVj3m2FEO79vIIY3LhoeeAxFyRC3AkCY5xisSZWS9J6ENGzgpQg6K1FnxBTSkFJEcFCEH+s8sUZMLOSjyLf40IWV/6pgggoOkFX68yl+3tyKSA+QAOQITPuROu3amkgNTytH1aRv5KFc989ZKmoGscgzb7Kt0lSXkGDyUvS9XO/9aYTN6XzTcjN6b6Et8h7THpVfomQZ9MC58KM/9AYt00y3jUxv7S9ZZZ631yv5W191T9WrL7xH/a0KBT/FNeAsDjnSse9jnmYMzvkP6NrISyBIbFy/eEC+Hv0LIOJiSAxPIITzSDaPkQPRqxbLl1TC4O1CD09cfNaUxZvxzNTo5hEeiVkzPgZnksGzJMhR6DlpMNq0sHh5Zbr/NP0C3bwCZjDSkd7SolzdZ1mtbbO1n2OpBjuT4cfoQHiMJ2AT7Okw7Sl5gJ21+0ePlWGHyTiqHHVJmkwPkADmK9KST34LkADmEBzlwIl7ZR+I8R52CnTsF2CFNNlX/WLBTrpvlDZHkMI9oSE+q3JHqpnulTI4RNU56ks1b2Z0lf/LSqQ+g5JYjtkl8fN0C55IqNKS3MhxR5NxCljmuViE5jgfJKd8XrHf0taAcrypysKj7jjmSI4cuDruTY62Hnhzoi00wkAPkADlADpAD5AA5QA6QA+QAyAFygBwgB8gBcoAcIAfIAXIA5AA5QA6QA+QAOUAOkAPl+Atk0K26a296KQAAAABJRU5ErkJggg=="), c => c.charCodeAt(0));
      return new Response(icon, { headers: { ...headers, "content-type": "image/png", "cache-control": "public, max-age=86400" } });
    }
    if (url.pathname === "/service-worker.js" && request.method === "GET") {
      const script = `self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const title = data.title || "Совет Первых · школа №9";
  const options = {
    body: data.body || "Поступило новое обращение.",
    icon: "/admin-icon.png",
    badge: "/admin-icon.png",
    tag: data.tag || "s1sch9-notification",
    renotify: true,
    data: { url: data.url || "/admin#appeals" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/admin#appeals", self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const client of list) {
      if (client.url.startsWith(self.location.origin)) {
        client.navigate(target);
        return client.focus();
      }
    }
    return clients.openWindow(target);
  }));
});`;
      return new Response(script, { headers: { ...headers, "content-type": "application/javascript; charset=utf-8", "Service-Worker-Allowed": "/", "cache-control": "no-cache" } });
    }
    if (url.pathname === "/manifest.webmanifest" && request.method === "GET") {
      return json({
        id: "/admin",
        name: "Админка",
        short_name: "Админка",
        start_url: "/admin",
        scope: "/",
        display: "standalone",
        background_color: "#f6f4f5",
        theme_color: "#470014",
        icons: [
          { src: "/admin-icon.png", sizes: "180x180", type: "image/png" },
          { src: "/admin-icon.png", sizes: "180x180", type: "image/png" }
        ]
      }, 200, { ...headers, "content-type": "application/manifest+json; charset=utf-8" });
    }
    if (url.pathname === "/api/admin/push/config" && request.method === "GET") {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401, headers);
      try {
        await ensurePushTables(env);
        const row = await env.DB.prepare("SELECT value FROM push_settings WHERE key = 'public_key'").first();
        return json({ publicKey: row?.value || "", ready: !!row?.value && !!env.VAPID_PRIVATE_KEY }, 200, headers);
      } catch { return json({ error: "Не удалось проверить настройки уведомлений." }, 500, headers); }
    }
    if (url.pathname === "/api/admin/push/config" && request.method === "POST") {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401, headers);
      try {
        const body = await readJsonBody(request);
        const publicKey = cleanText(body.publicKey, 120);
        if (!/^[A-Za-z0-9_-]{80,100}$/.test(publicKey)) return json({ error: "Некорректный публичный ключ." }, 400, headers);
        await ensurePushTables(env);
        await env.DB.prepare("INSERT INTO push_settings (key, value) VALUES ('public_key', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(publicKey).run();
        return json({ success: true }, 200, headers);
      } catch { return json({ error: "Не удалось сохранить публичный ключ." }, 500, headers); }
    }
    if (url.pathname === "/api/admin/push/subscribe" && request.method === "POST") {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401, headers);
      try {
        const body = await readJsonBody(request);
        const sub = body.subscription;
        if (!sub || typeof sub.endpoint !== "string" || !sub.endpoint.startsWith("https://") ||
            !sub.keys || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string") {
          return json({ error: "Некорректная подписка браузера." }, 400, headers);
        }
        await ensurePushTables(env);
        await env.DB.prepare("INSERT INTO push_subscriptions (endpoint, subscription_json, created_at) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET subscription_json=excluded.subscription_json")
          .bind(sub.endpoint, JSON.stringify(sub), Math.floor(Date.now() / 1000)).run();
        return json({ success: true }, 201, headers);
      } catch { return json({ error: "Не удалось сохранить подписку." }, 500, headers); }
    }
    if (url.pathname === "/api/admin/push/subscribe" && request.method === "DELETE") {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401, headers);
      try {
        const body = await readJsonBody(request);
        const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
        await ensurePushTables(env);
        await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run();
        return json({ success: true }, 200, headers);
      } catch { return json({ error: "Не удалось отключить уведомления." }, 500, headers); }
    }
    if (url.pathname === "/api/admin/push/test" && request.method === "POST") {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401, headers);
      const result = await sendPushNotifications(env, {
        title: "Совет Первых · Уведомления подключены",
        body: "Отлично! Теперь новые обращения будут приходить сюда.",
        url: "/admin#appeals",
        tag: "push-test"
      });
      return json({ success: result.sent > 0, sent: result.sent, skipped: !!result.skipped }, result.sent > 0 ? 200 : 503, headers);
    }

    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      return new Response(adminPage(), {
        headers: {
          ...headers,
          "content-type": "text/html; charset=utf-8",
          "X-Robots-Tag": "noindex, nofollow",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self' data:; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
        }
      });
    }
    if (url.pathname.startsWith("/api/") && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...cors(origin), ...headers } });
    }
    if (url.pathname === "/api/telegram-miniapp/accept" && request.method === "POST") {
      if (origin !== SITE_ORIGIN) return json({ error: "Недопустимый источник запроса." }, 403, { ...headers, ...cors(origin) });
      const length = Number(request.headers.get("Content-Length") || 0);
      if (length > MAX_BODY) return json({ error: "Слишком большой запрос." }, 413, { ...headers, ...cors(origin) });
      let body;
      try { body = await readJsonBody(request); } catch { return json({ error: "Некорректный запрос." }, 400, { ...headers, ...cors(origin) }); }
      const initData = typeof body.initData === "string" ? body.initData : "";
      if (body.rulesAccepted !== true || body.rulesVersion !== "2026-11-12" || !initData || initData.length > 4096) {
        return json({ error: "Сначала прочитайте правила и подтвердите согласие." }, 400, { ...headers, ...cors(origin) });
      }
      try {
        if (!env.TELEGRAM_BOT_TOKEN) return json({ error: "Telegram пока не настроен." }, 503, { ...headers, ...cors(origin) });
        const params = new URLSearchParams(initData);
        const receivedHash = params.get("hash") || "";
        const authDate = Number(params.get("auth_date") || 0);
        const user = JSON.parse(params.get("user") || "null");
        params.delete("hash");
        const checkString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + "=" + v).join("\n");
        const encoder = new TextEncoder();
        const webAppKey = await crypto.subtle.importKey("raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const secret = await crypto.subtle.sign("HMAC", webAppKey, encoder.encode(env.TELEGRAM_BOT_TOKEN));
        const hmacKey = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const digest = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(checkString)));
        const expectedHash = [...digest].map(b => b.toString(16).padStart(2, "0")).join("");
        const now = Math.floor(Date.now() / 1000);
        if (!/^[a-f0-9]{64}$/i.test(receivedHash) || !constantTimeEqual(receivedHash, expectedHash) ||
            !Number.isSafeInteger(authDate) || authDate > now + 60 || now - authDate > 1800 ||
            !user || !Number.isSafeInteger(user.id) || user.is_bot) {
          return json({ error: "Не удалось подтвердить Telegram. Закройте приложение и откройте его заново из сообщения бота." }, 401, { ...headers, ...cors(origin) });
        }
        const chatId = String(user.id);
        await ensureTelegramAppeals(env);
        const blockedTelegramUser = await env.DB.prepare("SELECT chat_id FROM telegram_appeal_blocks WHERE chat_id = ?").bind(chatId).first();
        if (blockedTelegramUser) {
          return json({ error: "Доступ к отправке обращений в Telegram-боте заблокирован. Если вы считаете это ошибкой, обратитесь к Совету." }, 403, { ...headers, ...cors(origin) });
        }
        await env.DB.prepare("INSERT INTO telegram_appeal_sessions (chat_id, awaiting, updated_at, rules_accepted) VALUES (?, 1, ?, 1) ON CONFLICT(chat_id) DO UPDATE SET awaiting=1, updated_at=excluded.updated_at, rules_accepted=1")
          .bind(chatId, now).run();
        await telegramReply(env, chatId,
          "✅ Спасибо! Вы ознакомились с правилами и подтвердили согласие.\n\nТеперь напишите своё обращение следующим сообщением прямо в этом чате. Можно подробно описать идею, предложение, новость или вопрос.\n\nМаксимальная длина — 1500 символов. Если передумали, нажмите «Отменить отправку». 💙",
          { keyboard: [[{ text: "↩️ Отменить отправку" }]], resize_keyboard: true, is_persistent: true });
        return json({ success: true }, 200, { ...headers, ...cors(origin) });
      } catch {
        return json({ error: "Не удалось подтвердить согласие. Попробуйте закрыть приложение и открыть его ещё раз." }, 503, { ...headers, ...cors(origin) });
      }
    }

    if (url.pathname === "/api/appeals" && request.method === "POST") {
      if (origin !== SITE_ORIGIN) return json({ error: "Недопустимый источник запроса." }, 403, headers);
      const length = Number(request.headers.get("Content-Length") || 0);
      if (length > MAX_BODY) return json({ error: "Слишком большой запрос." }, 413, { ...headers, ...cors(origin) });
      let body;
      try { body = await readJsonBody(request); } catch { return json({ error: "Некорректный запрос." }, 400, { ...headers, ...cors(origin) }); }
      const role = cleanText(body.role, 30);
      const category = cleanText(body.category, 60);
      const message = cleanText(body.message, MAX_MESSAGE);
      const captchaToken = cleanText(body.turnstileToken, 2048);
      if (body.rulesAccepted !== true ||
          !["Ученик", "Родитель", "Учитель"].includes(role) ||
          !["Идея или предложение", "Новость школы", "Обратная связь"].includes(category) ||
          message.length < 5 || message.length > MAX_MESSAGE) {
        return json({ error: "Проверьте заполнение формы." }, 400, { ...headers, ...cors(origin) });
      }
      try {
        const ipHash = await clientIpHash(request);
        if (await isIpBlocked(env, ipHash)) {
          return json({ error: "Доступ к отправке обращений с этого подключения заблокирован из-за нарушения правил пользования ботом для обращений Совета. Если вы считаете, что блокировка произошла по ошибке, обратитесь к администрации Совета." }, 403, { ...headers, ...cors(origin) });
        }
        const captchaCheck = await verifyTurnstile(captchaToken, request, env);
        if (!captchaCheck.ok) {
          return json({
            error: "Не пройдена проверка защиты от автоматических отправок.",
            diagnostic: captchaCheck.reason
          }, 400, { ...headers, ...cors(origin) });
        }
        const limit = await rateAllowed(env, ipHash);
        await logSecurityEvent(env, ipHash, limit.allowed ? "accepted" : "rate_limited");
        if (!limit.allowed) {
          return json({ error: "В целях безопасности с одного подключения можно отправить не более 10 обращений в час. Пожалуйста, попробуйте позже." }, 429, { ...headers, ...cors(origin) });
        }
        const inserted = await env.DB.prepare("INSERT INTO appeals (role, category, message, status) VALUES (?, ?, ?, 'new')")
          .bind(role, category, message).run();
        if (inserted.meta?.last_row_id) {
          await env.DB.prepare("INSERT OR REPLACE INTO appeal_sender_keys (appeal_id, ip_hash) VALUES (?, ?)")
            .bind(inserted.meta.last_row_id, ipHash).run();
        }
        await sendPushNotifications(env, {
          title: "Совет Первых · Новое обращение",
          body: "Поступило новое обращение с сайта. Нажмите, чтобы открыть админку.",
          url: "/admin#appeals",
          tag: "new-appeal"
        });
        return json({ success: true }, 201, { ...headers, ...cors(origin) });
      } catch {
        return json({ error: "Сервис временно недоступен. Попробуйте позже." }, 503, { ...headers, ...cors(origin) });
      }
    }

    if (url.pathname === "/api/admin/news/upload" && request.method === "POST") {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401, headers);
      try {
        const uploadLength = Number(request.headers.get("Content-Length") || 0);
        if (Number.isFinite(uploadLength) && uploadLength > MAX_UPLOAD_BODY) return json({ error: "Файл слишком большой." }, 413, headers);
        const uploadBytes = await readRequestBytes(request, MAX_UPLOAD_BODY);
        const uploadHeaders = new Headers(request.headers);
        uploadHeaders.delete("Content-Length");
        const boundedRequest = new Request(request.url, { method: "POST", headers: uploadHeaders, body: uploadBytes });
        const form = await boundedRequest.formData();
        const file = form.get("file");
        if (!file || typeof file.arrayBuffer !== "function") return json({ error: "Выберите файл." }, 400, headers);
        const isVideo = file.type === "video/mp4";
        const isImage = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(String(file.type || "").toLowerCase());
        if (!isVideo && !isImage) return json({ error: "Можно загружать только фото и видео." }, 415, headers);
        const limit = isVideo ? 20 * 1024 * 1024 : 10 * 1024 * 1024;
        if (file.size > limit) return json({ error: isVideo ? "Видео должно быть не больше 20 МБ." : "Фото должно быть не больше 10 МБ." }, 413, headers);
        if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID) return json({ error: "Хранилище медиа не настроено." }, 503, headers);
        const upload = new FormData();
        upload.set("chat_id", String(env.TELEGRAM_ADMIN_ID));
        upload.set(isVideo ? "video" : "photo", file, file.name || (isVideo ? "video.mp4" : "photo.jpg"));
        const method = isVideo ? "sendVideo" : "sendPhoto";
        const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/" + method, { method: "POST", body: upload });
        const result = await response.json();
        if (!response.ok || !result.ok || !result.result) return json({ error: "Не удалось сохранить медиафайл." }, 502, headers);
        const message = result.result;
        const uploaded = isVideo ? message.video : (Array.isArray(message.photo) ? message.photo[message.photo.length - 1] : null);
        if (!uploaded || !uploaded.file_id) return json({ error: "Не удалось получить файл." }, 502, headers);
        try {
          await telegramApi(env, "deleteMessage", { chat_id: env.TELEGRAM_ADMIN_ID, message_id: message.message_id });
        } catch {}
        return json({ media: { type: isVideo ? "video" : "image", file_id: uploaded.file_id } }, 200, headers);
      } catch (error) {
        if (error?.message === "body-too-large") return json({ error: "Файл слишком большой." }, 413, headers);
        return json({ error: "Ошибка загрузки медиафайла." }, 500, headers);
      }
    }

    if (url.pathname === "/api/admin/news" && request.method === "GET") {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401, headers);
      try {
        await ensureTelegramNews(env);
        const result = await env.DB.prepare("SELECT id, date, text, media, title, description, publish_at, status FROM telegram_news ORDER BY date DESC, rowid DESC LIMIT 100").all();
        const items = (result.results || []).map(item => ({
          ...item,
          media: JSON.parse(item.media || "[]").map((m, index) => ({
            ...m,
            url: new URL("/api/news-media/" + encodeURIComponent(item.id) + "/" + index, request.url).toString()
          }))
        }));
        return json({ items }, 200, headers);
      } catch { return json({ error: "Не удалось загрузить новости." }, 500, headers); }
    }

    if (url.pathname === "/api/admin/news" && request.method === "POST") {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401, headers);
      try {
        await ensureTelegramNews(env);
        const body = await readJsonBody(request);
        const title = cleanText(body.title, 120);
        const description = cleanText(body.description, 3000);
        const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : new Date().toISOString().slice(0, 10);
        const publishAt = cleanText(body.publish_at, 40);
        const status = body.status === "draft" ? "draft" : "published";
        const media = Array.isArray(body.media) ? body.media.filter(m => m && m.file_id && ["image", "video"].includes(m.type)).slice(0, 10) : [];
        if (title.length < 2) return json({ error: "Укажите заголовок новости." }, 400, headers);
        const id = "web-" + crypto.randomUUID();
        await env.DB.prepare("INSERT INTO telegram_news (id,date,text,media,title,description,publish_at,status) VALUES (?,?,?,?,?,?,?,?)")
          .bind(id, date, title + (description ? "\n" + description : ""), JSON.stringify(media), title, description, publishAt, status).run();
        return json({ success: true, id }, 201, headers);
      } catch { return json({ error: "Не удалось сохранить новость." }, 500, headers); }
    }

    const newsMatch = url.pathname.match(/^\/api\/admin\/news\/(.+)$/);
    if (newsMatch && (request.method === "PATCH" || request.method === "DELETE")) {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401, headers);
      const id = decodeURIComponent(newsMatch[1]);
      try {
        await ensureTelegramNews(env);
        if (request.method === "DELETE") {
          await env.DB.prepare("DELETE FROM telegram_news WHERE id = ?").bind(id).run();
          return json({ success: true }, 200, headers);
        }
        const body = await readJsonBody(request);
        const title = cleanText(body.title, 120);
        const description = cleanText(body.description, 3000);
        const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : new Date().toISOString().slice(0, 10);
        const publishAt = cleanText(body.publish_at, 40);
        const status = body.status === "draft" ? "draft" : "published";
        const media = Array.isArray(body.media) ? body.media.filter(m => m && m.file_id && ["image", "video"].includes(m.type)).slice(0, 10) : [];
        if (title.length < 2) return json({ error: "Укажите заголовок новости." }, 400, headers);
        const result = await env.DB.prepare("UPDATE telegram_news SET date=?, text=?, media=?, title=?, description=?, publish_at=?, status=? WHERE id=?")
          .bind(date, title + (description ? "\n" + description : ""), JSON.stringify(media), title, description, publishAt, status, id).run();
        if (!result.meta.changes) return json({ error: "Новость не найдена." }, 404, headers);
        return json({ success: true }, 200, headers);
      } catch { return json({ error: "Не удалось изменить новость." }, 500, headers); }
    }

    if (url.pathname === "/api/admin/security" && request.method === "GET") {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401, headers);
      try {
        await ensureAppealSecurity(env);
        const blocks = await env.DB.prepare(`SELECT b.ip_hash, b.created_at, b.note, COUNT(s.appeal_id) AS appeals_count FROM appeal_ip_blocks b LEFT JOIN appeal_sender_keys s ON s.ip_hash = b.ip_hash GROUP BY b.ip_hash ORDER BY b.created_at DESC LIMIT 100`).all();
        const since = Math.floor(Date.now() / 1000) - 7 * 86400;
        const events = await env.DB.prepare(`SELECT e.ip_hash, COUNT(*) AS attempts, MAX(e.created_at) AS last_seen, SUM(CASE WHEN e.event = 'rate_limited' THEN 1 ELSE 0 END) AS limited, CASE WHEN b.ip_hash IS NULL THEN 0 ELSE 1 END AS blocked FROM appeal_security_events e LEFT JOIN appeal_ip_blocks b ON b.ip_hash = e.ip_hash WHERE e.created_at >= ? AND e.event IN ('accepted','rate_limited') GROUP BY e.ip_hash ORDER BY attempts DESC, last_seen DESC LIMIT 40`).bind(since).all();
        const totals = await env.DB.prepare(`SELECT COUNT(*) AS attempts, SUM(CASE WHEN event = 'rate_limited' THEN 1 ELSE 0 END) AS limited FROM appeal_security_events WHERE created_at >= ? AND event IN ('accepted','rate_limited')`).bind(since).first();
        const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM appeal_ip_blocks").first();
        return json({ blocks: blocks.results || [], events: events.results || [], totals: totals || {}, blockedCount: count?.total || 0 }, 200, headers);
      } catch { return json({ error: "Не удалось загрузить данные защиты." }, 500, headers); }
    }
    const clearSecurityEventMatch = url.pathname.match(/^\/api\/admin\/security\/events\/([a-f0-9]{64})$/);
    if (clearSecurityEventMatch && request.method === "DELETE") {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401, headers);
      try {
        await ensureAppealSecurity(env);
        await env.DB.prepare("DELETE FROM appeal_security_events WHERE ip_hash = ?").bind(clearSecurityEventMatch[1]).run();
        return json({ success: true }, 200, headers);
      } catch { return json({ error: "Не удалось удалить запись активности." }, 500, headers); }
    }
    if (url.pathname === "/api/admin/security/blocks" && request.method === "POST") {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401, headers);
      try {
        const body = await readJsonBody(request), hash = cleanText(body.hash, 64), note = cleanText(body.note, 160);
        if (!/^[a-f0-9]{64}$/.test(hash)) return json({ error: "Некорректный идентификатор отправителя." }, 400, headers);
        await ensureAppealSecurity(env);
        await env.DB.prepare("INSERT INTO appeal_ip_blocks (ip_hash, created_at, note) VALUES (?, ?, ?) ON CONFLICT(ip_hash) DO UPDATE SET note=excluded.note").bind(hash, Math.floor(Date.now() / 1000), note || "Блокировка из админки").run();
        await logSecurityEvent(env, hash, "blocked");
        return json({ success: true }, 200, headers);
      } catch { return json({ error: "Не удалось заблокировать отправителя." }, 500, headers); }
    }
    const unblockMatch = url.pathname.match(/^\/api\/admin\/security\/blocks\/([a-f0-9]{64})$/);
    if (unblockMatch && request.method === "DELETE") {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401, headers);
      try {
        await ensureAppealSecurity(env);
        await env.DB.prepare("DELETE FROM appeal_ip_blocks WHERE ip_hash = ?").bind(unblockMatch[1]).run();
        await logSecurityEvent(env, unblockMatch[1], "unblocked");
        return json({ success: true }, 200, headers);
      } catch { return json({ error: "Не удалось снять блокировку." }, 500, headers); }
    }
    if (url.pathname === "/api/admin/telegram-blocks" && request.method === "GET") {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401, headers);
      try {
        await ensureTelegramAppeals(env);
        const result = await env.DB.prepare("SELECT chat_id, created_at, note FROM telegram_appeal_blocks ORDER BY created_at DESC LIMIT 100").all();
        return json({ blocks: result.results || [] }, 200, headers);
      } catch { return json({ error: "Не удалось загрузить блокировки Telegram." }, 500, headers); }
    }
    if (url.pathname === "/api/admin/telegram-blocks" && request.method === "POST") {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401, headers);
      try {
        const body = await readJsonBody(request), chatId = cleanText(body.chatId, 32), note = cleanText(body.note, 160);
        if (!/^\d{5,20}$/.test(chatId)) return json({ error: "Некорректный Telegram ID." }, 400, headers);
        await ensureTelegramAppeals(env);
        await env.DB.prepare("INSERT INTO telegram_appeal_blocks (chat_id, created_at, note) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET note=excluded.note").bind(chatId, Math.floor(Date.now() / 1000), note || "Блокировка из админки").run();
        return json({ success: true }, 200, headers);
      } catch { return json({ error: "Не удалось заблокировать Telegram-аккаунт." }, 500, headers); }
    }
    const telegramUnblockMatch = url.pathname.match(/^\/api\/admin\/telegram-blocks\/(\d+)$/);
    if (telegramUnblockMatch && request.method === "DELETE") {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401, headers);
      try {
        await ensureTelegramAppeals(env);
        await env.DB.prepare("DELETE FROM telegram_appeal_blocks WHERE chat_id = ?").bind(telegramUnblockMatch[1]).run();
        return json({ success: true }, 200, headers);
      } catch { return json({ error: "Не удалось снять блокировку Telegram." }, 500, headers); }
    }
    if (url.pathname === "/api/admin/appeals" && request.method === "GET") {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401, headers);
      try {
        await ensureAppealSecurity(env);
        await ensureTelegramAppeals(env);
        const result = await env.DB.prepare("SELECT a.id, a.role, a.category, a.message, a.status, a.created_at, s.ip_hash, CASE WHEN b.ip_hash IS NULL THEN 0 ELSE 1 END AS sender_blocked, ts.chat_id AS telegram_chat_id, CASE WHEN tb.chat_id IS NULL THEN 0 ELSE 1 END AS telegram_sender_blocked FROM appeals a LEFT JOIN appeal_sender_keys s ON s.appeal_id = a.id LEFT JOIN appeal_ip_blocks b ON b.ip_hash = s.ip_hash LEFT JOIN telegram_appeal_sender_keys ts ON ts.appeal_id = a.id LEFT JOIN telegram_appeal_blocks tb ON tb.chat_id = ts.chat_id ORDER BY a.id DESC").all();
        return json({ items: result.results || [] }, 200, headers);
      } catch { return json({ error: "Не удалось загрузить обращения." }, 500, headers); }
    }

    const match = url.pathname.match(/^\/api\/admin\/appeals\/(\d+)$/);
    if (match && (request.method === "DELETE" || request.method === "PATCH")) {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401, headers);
      const id = Number(match[1]);
      if (!Number.isSafeInteger(id) || id < 1) return json({ error: "Некорректный ID." }, 400, headers);
      try {
        if (request.method === "DELETE") {
          await env.DB.prepare("DELETE FROM appeals WHERE id = ?").bind(id).run();
          return json({ success: true }, 200, headers);
        }
        const body = await readJsonBody(request);
        if (!["reviewed", "done"].includes(body.status)) return json({ error: "Некорректный статус." }, 400, headers);
        await env.DB.prepare("UPDATE appeals SET status = ? WHERE id = ?").bind(body.status, id).run();
        return json({ success: true }, 200, headers);
      } catch { return json({ error: "Не удалось изменить обращение." }, 500, headers); }
    }
    return new Response("Not found", { status: 404, headers });
  }
};
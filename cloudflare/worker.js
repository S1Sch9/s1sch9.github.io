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
  const rulesText = `💙 ЗДЕСЬ ВАЖЕН КАЖДЫЙ

О СОВЕТЕ ПЕРВЫХ И ПРАВИЛА ПОЛЬЗОВАНИЯ

1. ЗАЧЕМ НУЖЕН СОВЕТ
Совет Первых школы № 9 — это пространство для школьных инициатив, идей и совместных дел. Его смысл — помогать делать школьную жизнь интереснее, добрее и насыщеннее, поддерживать предложения учеников и давать возможность каждому быть услышанным. Для этого не обязательно состоять в Совете: предложить идею, задать вопрос или поделиться мнением может любой ученик.

2. ЧТО ЕСТЬ НА САЙТЕ И В БОТЕ
На сайте собраны новости, события, проекты, полезные ссылки и материалы о деятельности Совета. Здесь же можно отправить обращение. Telegram-бот помогает сделать это прямо в мессенджере. Новости и важные обновления публикуются в официальных информационных каналах Совета. На сайте также есть интерактивная игра — отдельная часть проекта, не требующая регистрации.

3. О ЧЁМ МОЖНО НАПИСАТЬ
Предложить мероприятие или школьный проект, поделиться идеей по улучшению школьной жизни, задать вопрос, оставить конструктивное замечание, рассказать о полезной инициативе или интересном школьном событии. Пожалуйста, формулируйте обращение понятно и по существу.

4. УВАЖЕНИЕ И НЕДОПУСТИМЫЕ СООБЩЕНИЯ
Общайтесь уважительно. Нельзя отправлять оскорбления, угрозы, травлю, нецензурные сообщения, спам, рекламу, заведомо ложные сведения и материалы, не относящиеся к работе Совета и школьной жизни. Не используйте обращения для давления на других людей или распространения конфликтов.

5. КАК РАССМАТРИВАЮТСЯ ОБРАЩЕНИЯ
Поступившие сообщения читаются и рассматриваются Советом. Идеи могут обсуждаться, уточняться и оцениваться с учётом реальных возможностей, безопасности и необходимых согласований. Если предложение окажется подходящим, Совет постарается помочь ему воплотиться. На рассмотрение может потребоваться время; отправка обращения не означает, что его обязательно получится реализовать.

6. КОНФИДЕНЦИАЛЬНОСТЬ И ЛИЧНЫЕ ДАННЫЕ
На сайте не требуется указывать имя, номер телефона или другие контактные данные. Для защиты от спама сайт использует технический обезличенный идентификатор подключения; он не является именем или номером телефона. В Telegram-боте для обработки обращений и защиты от злоупотреблений используется технический Telegram ID аккаунта. Эти технические идентификаторы не публикуются на сайте. Не указывайте в сообщении свои личные данные и данные других людей, если в этом нет необходимости.

7. ПУБЛИКАЦИЯ ПРЕДЛОЖЕНИЙ
Обращения не появляются на сайте автоматически. Если идея окажется полезной для школьного сообщества, Совет может отдельно рассказать о ней или использовать её как основу для инициативы. При подготовке публичного материала личные сведения и данные, позволяющие определить автора, не раскрываются.

8. ОГРАНИЧЕНИЯ И БЛОКИРОВКА
При нарушении правил Совет может ограничить возможность отправлять обращения. В Telegram ограничение применяется к аккаунту, а на сайте — к техническому идентификатору подключения. Поэтому блокировка на сайте иногда может затронуть и других пользователей той же сети. Если вы считаете, что ограничение применено ошибочно, свяжитесь с Советом через доступные официальные каналы.

9. РЕГИСТРАЦИЯ И ИГРА
Для просмотра сайта регистрация не нужна. Результаты игры сохраняются в браузере на том устройстве, где вы играете, и не привязываются к имени или профилю. При очистке данных браузера или переходе на другое устройство сохранённый результат может потеряться.

Совет начинается с инициативы. Не бойся предложить, спросить или поделиться тем, что действительно важно. Даже небольшая идея может стать началом хорошего общего дела. Мы хотим, чтобы каждый ученик знал: его голос имеет значение. Важен каждый! 💙`;
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
        { inline_keyboard: [[{ text: "📖 Прочитать правила", web_app: { url: "https://s1sch9.github.io/appeal-app.html?v=rules-only-3" } }]] });
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
      const icon = Uint8Array.from(atob("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"), c => c.charCodeAt(0));
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
      if (body.rulesAccepted !== true || body.rulesVersion !== "2026-11-12-v2" || !initData || initData.length > 4096) {
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

    if (url.pathname === "/api/appeal-status" && request.method === "GET") {
      try {
        const ipHash = await clientIpHash(request);
        await ensureAppealSecurity(env);
        const block = await env.DB.prepare("SELECT created_at, note FROM appeal_ip_blocks WHERE ip_hash = ?").bind(ipHash).first();
        return json({ blocked: !!block, created_at: block?.created_at || null, note: block?.note || "" }, 200, { ...headers, ...cors(origin) });
      } catch {
        return json({ error: "Не удалось проверить доступ." }, 503, { ...headers, ...cors(origin) });
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
        const previous = await env.DB.prepare("SELECT chat_id FROM telegram_appeal_blocks WHERE chat_id = ?").bind(chatId).first();
        const reason = note || "Нарушение правил пользования";
        await env.DB.prepare("INSERT INTO telegram_appeal_blocks (chat_id, created_at, note) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET note=excluded.note").bind(chatId, Math.floor(Date.now() / 1000), reason).run();
        let notificationSent = false;
        if (!previous && env.TELEGRAM_BOT_TOKEN) {
          try {
            await telegramReply(env, chatId,
              "⛔ Уведомление от Совета Первых школы № 9\n\nДоступ к отправке обращений через Telegram-бот заблокирован из-за нарушения правил пользования.\n\nПричина: " + reason + "\n\nЕсли вы считаете, что блокировка произошла по ошибке, обратитесь к Совету.");
            notificationSent = true;
          } catch { /* Блокировка сохраняется, даже если пользователь запретил сообщения от бота. */ }
        }
        return json({ success: true, notificationSent }, 200, headers);
      } catch { return json({ error: "Не удалось заблокировать Telegram-аккаунт." }, 500, headers); }
    }
    const telegramUnblockMatch = url.pathname.match(/^\/api\/admin\/telegram-blocks\/(\d+)$/);
    if (telegramUnblockMatch && request.method === "DELETE") {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401, headers);
      try {
        await ensureTelegramAppeals(env);
        const chatId = telegramUnblockMatch[1];
        const previous = await env.DB.prepare("SELECT chat_id FROM telegram_appeal_blocks WHERE chat_id = ?").bind(chatId).first();
        await env.DB.prepare("DELETE FROM telegram_appeal_blocks WHERE chat_id = ?").bind(chatId).run();
        let notificationSent = false;
        if (previous && env.TELEGRAM_BOT_TOKEN) {
          try {
            await telegramReply(env, chatId,
              "💙 Уведомление от Совета Первых школы № 9\n\nБлокировка снята. Доступ к отправке обращений через Telegram-бот восстановлен. Спасибо за понимание!");
            notificationSent = true;
          } catch { /* Разблокировка сохраняется, даже если сообщение доставить не удалось. */ }
        }
        return json({ success: true, notificationSent }, 200, headers);
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
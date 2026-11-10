import { adminPage } from "./admin-page.js";

// Combined appeals and news administration.
const SITE_ORIGIN = "https://s1sch9.github.io";
const MAX_BODY = 8192;
const MAX_MESSAGE = 1500;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}
function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store"
  };
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
  if (result.hostname && result.hostname !== "s1sch9.github.io") {
    return { ok: false, reason: "hostname-mismatch" };
  }
  return { ok: true };
}
async function rateAllowed(request, env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS appeal_rate_limits (
      ip_hash TEXT PRIMARY KEY,
      window_start INTEGER NOT NULL,
      attempts INTEGER NOT NULL
    )
  `).run();
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = await sha256("s1sch9-appeals-rate:" + ip);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(`
    INSERT INTO appeal_rate_limits (ip_hash, window_start, attempts)
    VALUES (?, ?, 1)
    ON CONFLICT(ip_hash) DO UPDATE SET
      attempts = CASE WHEN window_start <= ? THEN 1 ELSE attempts + 1 END,
      window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END
    RETURNING attempts
  `).bind(key, now, now - 3600, now - 3600, now).first();
  return !!row && row.attempts <= 5;
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
async function ensureTelegramAppeals(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_appeal_sessions (
    chat_id TEXT PRIMARY KEY,
    awaiting INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_appeal_updates (
    update_id INTEGER PRIMARY KEY,
    created_at INTEGER NOT NULL
  )`).run();
}
async function setTelegramCommands(env) {
  await telegramApi(env, "setMyCommands", {
    commands: [
      { command: "start", description: "Начать и открыть меню" },
      { command: "new", description: "Написать обращение" },
      { command: "cancel", description: "Отменить отправку" },
      { command: "help", description: "Как отправить обращение" }
    ]
  });
}
async function telegramWebhook(request, env) {
  if (!env.TELEGRAM_WEBHOOK_SECRET ||
      !constantTimeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "", env.TELEGRAM_WEBHOOK_SECRET)) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!env.TELEGRAM_BOT_TOKEN) return json({ error: "Bot is not configured" }, 503);
  const update = await request.json();
  const msg = update && update.message;
  if (!msg || !msg.chat || msg.chat.type !== "private") return json({ ok: true });
  const chatId = String(msg.chat.id);
  const text = cleanText(msg.text, MAX_MESSAGE);
  const keyboard = {
    keyboard: [[{ text: "✍️ Написать обращение" }]],
    resize_keyboard: true,
    is_persistent: true
  };
  const hideKeyboard = { remove_keyboard: true };
  await ensureTelegramAppeals(env);
  if (Number.isSafeInteger(update.update_id)) {
    const seen = await env.DB.prepare("INSERT OR IGNORE INTO telegram_appeal_updates (update_id, created_at) VALUES (?, ?)")
      .bind(update.update_id, Math.floor(Date.now() / 1000)).run();
    if (!seen.meta.changes) return json({ ok: true });
  }
  const command = text.split(/\\s/)[0].toLowerCase();
  if (command === "/start" || command === "/help") {
    await env.DB.prepare("INSERT INTO telegram_appeal_sessions (chat_id, awaiting, updated_at) VALUES (?, 0, ?) ON CONFLICT(chat_id) DO UPDATE SET awaiting=0, updated_at=excluded.updated_at")
      .bind(chatId, Math.floor(Date.now() / 1000)).run();
    await telegramReply(env, chatId,
      "Здравствуйте! Это бот обратной связи Совета Первых школы №9 💙\\n\\nЗдесь можно отправить идею, предложение или обращение. Оно сразу появится в нашей админке сайта.\\n\\nНажмите «Написать обращение», чтобы начать.",
      keyboard);
    return json({ ok: true });
  }
  if (command === "/cancel" || text === "Отмена") {
    await env.DB.prepare("INSERT INTO telegram_appeal_sessions (chat_id, awaiting, updated_at) VALUES (?, 0, ?) ON CONFLICT(chat_id) DO UPDATE SET awaiting=0, updated_at=excluded.updated_at")
      .bind(chatId, Math.floor(Date.now() / 1000)).run();
    await telegramReply(env, chatId, "Отправка отменена. Если захотите написать нам, нажмите кнопку ниже.", keyboard);
    return json({ ok: true });
  }
  if (command === "/new" || text === "✍️ Написать обращение") {
    await env.DB.prepare("INSERT INTO telegram_appeal_sessions (chat_id, awaiting, updated_at) VALUES (?, 1, ?) ON CONFLICT(chat_id) DO UPDATE SET awaiting=1, updated_at=excluded.updated_at")
      .bind(chatId, Math.floor(Date.now() / 1000)).run();
    await telegramReply(env, chatId,
      "Напишите ваше обращение одним сообщением (от 5 до 1500 символов).\\n\\nПожалуйста, не отправляйте пароли и другие конфиденциальные данные. Для отмены используйте /cancel.",
      { ...keyboard, one_time_keyboard: true });
    return json({ ok: true });
  }
  const session = await env.DB.prepare("SELECT awaiting FROM telegram_appeal_sessions WHERE chat_id = ?").bind(chatId).first();
  if (!session || !session.awaiting) {
    await telegramReply(env, chatId, "Чтобы отправить обращение, нажмите кнопку «Написать обращение».", keyboard);
    return json({ ok: true });
  }
  const message = cleanText(msg.text || msg.caption, MAX_MESSAGE);
  if (message.length < 5) {
    await telegramReply(env, chatId, "Пожалуйста, напишите обращение чуть подробнее — минимум 5 символов. Или отправьте /cancel.", keyboard);
    return json({ ok: true });
  }
  if (message.length > MAX_MESSAGE) {
    await telegramReply(env, chatId, "Сообщение слишком длинное. Максимум — 1500 символов. Сократите его и отправьте ещё раз.", keyboard);
    return json({ ok: true });
  }
  await env.DB.prepare("INSERT INTO appeals (role, category, message, status) VALUES (?, ?, ?, 'new')")
    .bind("Telegram", "Через Telegram-бота", message).run();
  await env.DB.prepare("UPDATE telegram_appeal_sessions SET awaiting=0, updated_at=? WHERE chat_id=?")
    .bind(Math.floor(Date.now() / 1000), chatId).run();
  await telegramReply(env, chatId,
    "Спасибо за обращение! 💙\\n\\nОно успешно отправлено и уже поступило в Совет Первых.\\n\\nСтановимся лучше благодаря вам!",
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
        const item = await env.DB.prepare("SELECT media FROM telegram_news WHERE id = ?").bind(decodeURIComponent(mediaMatch[1])).first();
        const media = item ? JSON.parse(item.media || "[]")[Number(mediaMatch[2])] : null;
        if (!media || !media.file_id || !env.TELEGRAM_BOT_TOKEN) return new Response("Not found", { status: 404, headers });
        const fileInfo = await telegramApi(env, "getFile", { file_id: media.file_id });
        const fileResponse = await fetch("https://api.telegram.org/file/bot" + env.TELEGRAM_BOT_TOKEN + "/" + fileInfo.file_path);
        if (!fileResponse.ok) return new Response("Media unavailable", { status: 502, headers });
        return new Response(fileResponse.body, { headers: { ...headers, ...cors(origin), "Content-Type": fileResponse.headers.get("Content-Type") || (media.type === "video" ? "video/mp4" : "image/jpeg"), "Cache-Control": "public, max-age=3600" } });
      } catch { return new Response("Media unavailable", { status: 502, headers }); }
    }
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      return new Response(adminPage(), { headers: { "content-type": "text/html; charset=utf-8", ...headers } });
    }
    if (url.pathname.startsWith("/api/") && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...cors(origin), ...headers } });
    }
    if (url.pathname === "/api/appeals" && request.method === "POST") {
      if (origin !== SITE_ORIGIN) return json({ error: "Недопустимый источник запроса." }, 403, headers);
      const length = Number(request.headers.get("Content-Length") || 0);
      if (length > MAX_BODY) return json({ error: "Слишком большой запрос." }, 413, { ...headers, ...cors(origin) });
      let body;
      try { body = await request.json(); } catch { return json({ error: "Некорректный запрос." }, 400, { ...headers, ...cors(origin) }); }
      const role = cleanText(body.role, 30);
      const category = cleanText(body.category, 60);
      const message = cleanText(body.message, MAX_MESSAGE);
      const captchaToken = cleanText(body.turnstileToken, 2048);
      if (!["Ученик", "Родитель", "Учитель"].includes(role) ||
          !["Идея или предложение", "Новость школы", "Обратная связь"].includes(category) ||
          message.length < 5 || message.length > MAX_MESSAGE) {
        return json({ error: "Проверьте заполнение формы." }, 400, { ...headers, ...cors(origin) });
      }
      try {
        const captchaCheck = await verifyTurnstile(captchaToken, request, env);
        if (!captchaCheck.ok) {
          return json({
            error: "Не пройдена проверка защиты от автоматических отправок.",
            diagnostic: captchaCheck.reason
          }, 400, { ...headers, ...cors(origin) });
        }
        if (!(await rateAllowed(request, env))) {
          return json({ error: "Слишком много обращений. Попробуйте позже." }, 429, { ...headers, ...cors(origin) });
        }
        await env.DB.prepare("INSERT INTO appeals (role, category, message, status) VALUES (?, ?, ?, 'new')")
          .bind(role, category, message).run();
        return json({ success: true }, 201, { ...headers, ...cors(origin) });
      } catch {
        return json({ error: "Сервис временно недоступен. Попробуйте позже." }, 503, { ...headers, ...cors(origin) });
      }
    }

    if (url.pathname === "/api/admin/news/upload" && request.method === "POST") {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401, headers);
      try {
        const form = await request.formData();
        const file = form.get("file");
        if (!file || typeof file.arrayBuffer !== "function") return json({ error: "Выберите файл." }, 400, headers);
        const isVideo = String(file.type || "").startsWith("video/");
        const isImage = String(file.type || "").startsWith("image/");
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
        const body = await request.json();
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
        const body = await request.json();
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

    if (url.pathname === "/api/admin/appeals" && request.method === "GET") {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401, headers);
      try {
        const result = await env.DB.prepare("SELECT id, role, category, message, status, created_at FROM appeals ORDER BY id DESC").all();
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
        const body = await request.json();
        if (!["reviewed", "done"].includes(body.status)) return json({ error: "Некорректный статус." }, 400, headers);
        await env.DB.prepare("UPDATE appeals SET status = ? WHERE id = ?").bind(body.status, id).run();
        return json({ success: true }, 200, headers);
      } catch { return json({ error: "Не удалось изменить обращение." }, 500, headers); }
    }
    return new Response("Not found", { status: 404, headers });
  }
};
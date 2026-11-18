const API = "https://api.telegram.org/bot";
const BRAND = "https://s1sch9.github.io";
const CHANNEL = "@dvizhenieschool9";
const REQUEST_TIMEOUT_MS = 25000;

async function fetchWithTimeout(url, options = {}, label = "Запрос", timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(label + ": превышено время ожидания (25 сек.).");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function tg(env, method, payload, timeoutMs = REQUEST_TIMEOUT_MS) {
  const response = await fetchWithTimeout(API + env.SOVETTG_BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {})
  }, "Telegram " + method, timeoutMs);
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error("Telegram " + method + ": " + String(data.description || response.status));
  return data.result;
}

async function tgMultipart(env, method, form) {
  const response = await fetchWithTimeout(API + env.SOVETTG_BOT_TOKEN + "/" + method, { method: "POST", body: form }, "Telegram " + method);
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error("Telegram " + method + ": " + String(data.description || response.status));
  return data.result;
}
function escapeHtml(value) {
  return String(value || "").replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
}
async function assetDataUrl(url) {
  const response = await fetchWithTimeout(url, {}, "Загрузка фирменного изображения");
  if (!response.ok) throw new Error("Не удалось загрузить фирменный логотип Совета или графику «Важен каждый!».");
  const mime = response.headers.get("content-type") || "image/png";
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (let i=0;i<bytes.length;i+=0x8000) binary += String.fromCharCode(...bytes.subarray(i,i+0x8000));
  return "data:" + mime + ";base64," + btoa(binary);
}

async function renderBrandCard({ type, title, subtitle, photoDataUrl }) {
  const councilLogo = await assetDataUrl(BRAND + "/official-logo.svg");
  const schoolCrest = await assetDataUrl(BRAND + "/gerb.png");
  const safeTitle = escapeHtml(title || "Новости и события");
  const safeSubtitle = escapeHtml(subtitle || "");
  if (type !== "photo" || !photoDataUrl || !String(photoDataUrl).startsWith("data:image/")) {
    throw new Error("Не удалось подготовить исходную фотографию.");
  }
  const html =
    '<div style="display:flex;position:relative;width:1280px;height:720px;overflow:hidden;background:#fff;font-family:Arial,sans-serif">' +
      '<div style="display:flex;position:absolute;left:-110px;top:420px;width:300px;height:300px;border-radius:50%;background:rgba(161,0,31,.045)"></div>' +
      '<div style="display:flex;position:absolute;right:-120px;top:-150px;width:360px;height:360px;border-radius:50%;background:rgba(240,200,105,.10)"></div>' +
      '<div style="display:flex;position:absolute;left:52px;top:38px;width:1176px;height:116px;align-items:center;padding:0 28px;box-sizing:border-box;background:#fff;border:3px solid #a1001f;border-radius:24px">' +
        '<img src="' + councilLogo + '" style="display:flex;width:78px;height:78px;object-fit:contain;margin-right:18px"/>' +
        '<img src="' + schoolCrest + '" style="display:flex;width:78px;height:78px;object-fit:contain;margin-right:22px"/>' +
        '<div style="display:flex;flex-direction:column;gap:5px"><div style="display:flex;font-size:30px;font-weight:800;color:#3d000d">СОВЕТ ПЕРВЫХ</div><div style="display:flex;font-size:22px;font-weight:600;color:#745b65">ШКОЛЫ №9</div></div>' +
        '<div style="display:flex;margin-left:auto;max-width:400px;font-size:25px;font-weight:800;color:#3d000d;text-align:right">' + safeTitle + '</div>' +
      '</div>' +
      '<div style="display:flex;position:absolute;left:52px;top:184px;width:1176px;height:452px;align-items:center;justify-content:center;padding:12px;box-sizing:border-box;background:#fff;border:4px solid #a1001f;border-radius:30px;box-shadow:0 16px 42px rgba(61,0,13,.10)">' +
        '<img src="' + photoDataUrl + '" style="display:flex;width:100%;height:100%;object-fit:contain;object-position:center;border-radius:18px"/>' +
      '</div>' +
      '<div style="display:flex;position:absolute;left:72px;bottom:20px;max-width:1120px;font-size:18px;font-weight:600;color:#745b65">' + safeSubtitle + '</div>' +
    '</div>';
  const { ImageResponse } = await import("workers-og");
  const response = new ImageResponse(html, { width:1280, height:720 });
  return new Uint8Array(await response.arrayBuffer());
}
async function telegramImageData(env, fileId) {
  const info = await tg(env, "getFile", { file_id:fileId }, 60000);
  if (!info || !info.file_path) throw new Error("Telegram не вернул путь к фотографии.");
  const response = await fetchWithTimeout("https://api.telegram.org/file/bot" + env.SOVETTG_BOT_TOKEN + "/" + info.file_path, {}, "Загрузка оригинала фото");
  if (!response.ok) throw new Error("Не удалось загрузить фотографию из Telegram.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 8 * 1024 * 1024) throw new Error("Фото больше 8 МБ — отправь его в обычном размере.");
  let binary = "";
  for (let i=0;i<bytes.length;i+=0x8000) binary += String.fromCharCode(...bytes.subarray(i,i+0x8000));
  const headerMime = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const extension = String(info.file_path || "").split(".").pop().toLowerCase();
  let detectedMime = headerMime.startsWith("image/") ? headerMime : "";
  if (!detectedMime) {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) detectedMime = "image/png";
    else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) detectedMime = "image/jpeg";
    else if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0,4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8,12)) === "WEBP") detectedMime = "image/webp";
    else if (extension === "jpg" || extension === "jpeg") detectedMime = "image/jpeg";
    else if (extension === "png") detectedMime = "image/png";
    else if (extension === "webp") detectedMime = "image/webp";
  }
  if (!detectedMime) throw new Error("Telegram передал файл, но его формат не распознан как изображение.");
  return "data:" + detectedMime + ";base64," + btoa(binary);
}
async function sendBrandedPhoto(env, chatId, bytes, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", new Blob([bytes], {type:"image/png"}), "s1sch9-brand.png");
  if (caption) form.append("caption", caption.slice(0,1024));
  return tgMultipart(env, "sendPhoto", form);
}

async function ensureTables(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS social_publication_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS social_publication_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, source_message_id INTEGER NOT NULL, preview_message_id INTEGER NOT NULL, template_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS social_publication_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, status TEXT NOT NULL, notice_message_id INTEGER NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER)").run();
}

const TYPES = {
  post: { title: "Пост", prompt: "Отправь текст публикации одним сообщением." },
  photo: { title: "Фото", prompt: "Сначала отправь заголовок отдельным сообщением, затем фотографию. Можно и наоборот: отправь фото сразу с подписью — она станет заголовком." },
};

const TEMPLATES = {
  post: [
    { id: "clean", name: "Текстовая публикация", description: "Обычный текст без графической карточки" }
  ],
  photo: [
    { id: "gallery", name: "Фото Совета", description: "Горизонтальная карточка с логотипом и надписью «Важен каждый!»" }
  ],
};

function typeKeyboard() {
  return { inline_keyboard: [
    [{ text: "✍️ Текстовый пост", callback_data: "social:type:post" }, { text: "🖼 Фото", callback_data: "social:type:photo" }],
  ] };
}

function templateKeyboard(type) {
  return { inline_keyboard: TEMPLATES[type].map(item => [
    { text: item.name + " — " + item.description, callback_data: "social:template:" + type + ":" + item.id }
  ]) };
}

function publishKeyboard(id) {
  return { inline_keyboard: [
    [{ text: "✅ Опубликовать в канал", callback_data: "social:publish:" + id }],
    [{ text: "✖️ Отклонить", callback_data: "social:reject:" + id }]
  ] };
}

async function selectedTemplate(env, type) {
  const row = await env.DB.prepare("SELECT value FROM social_publication_state WHERE key = ?").bind("template:" + type).first();
  const id = String(row && row.value || "");
  return TEMPLATES[type].find(item => item.id === id) || TEMPLATES[type][0];
}

function captionFor(type, templateId, raw) {
  const text = String(raw || "").trim();
  const footer = "Совет Первых школы №9  ·  @dvizhenieschool9";
  if (type === "post") {
    if (templateId === "editorial") return "◆  СОВЕТ ПЕРВЫХ · ШКОЛА №9\n\n" + text + "\n\n" + footer;
    return text + "\n\n" + footer;
  }
  const prefix = "●  СОВЕТ ПЕРВЫХ · ШКОЛА №9";
  return [prefix, text, footer].filter(Boolean).join("\n\n").slice(0, 1024);
}

async function sendTypeMenu(env, adminId) {
  await tg(env, "sendMessage", {
    chat_id: adminId,
    text: "Что готовим для канала? Выбери формат.",
    reply_markup: typeKeyboard()
  });
}

async function processQueuedSocialPhotos(env) {
  await ensureTables(env);
  const now = Math.floor(Date.now() / 1000);
  const stale = await env.DB.prepare("SELECT id, started_at FROM social_publication_queue WHERE status = 'processing'").all();
  for (const row of stale.results || []) {
    if (Number(row.started_at || 0) && now - Number(row.started_at) > 240) {
      await env.DB.prepare("UPDATE social_publication_queue SET status='pending', started_at=NULL WHERE id=? AND status='processing'").bind(row.id).run();
    }
  }
  const next = await env.DB.prepare("SELECT id, payload, notice_message_id FROM social_publication_queue WHERE status='pending' ORDER BY id LIMIT 1").first();
  if (!next) return;
  const lock = await env.DB.prepare("UPDATE social_publication_queue SET status='processing', started_at=? WHERE id=? AND status='pending'").bind(now, next.id).run();
  if (!lock.meta || !lock.meta.changes) return;
  let stage = "чтение задания из очереди";
  const adminId = String(env.TELEGRAM_ADMIN_ID);
  try {
    const payload = JSON.parse(next.payload);
    const msg = payload.message;
    if (!msg || !Array.isArray(msg.photo) || !msg.photo.length) throw new Error("В очереди не найдено исходное фото.");
    const template = await selectedTemplate(env, "photo");
    const rawCaption = String(msg.caption || payload.title || "").trim();
    if (!rawCaption) throw new Error("Не найден заголовок публикации. Отправь заголовок, затем фотографию, либо добавь заголовок к фото как подпись.");
    const title = rawCaption;
    const caption = captionFor("photo", template.id, rawCaption);
    stage = "загрузка оригинала фото";
    const photo = msg.photo[msg.photo.length - 1];
    const dataUrl = await telegramImageData(env, photo.file_id);
    stage = "сборка горизонтальной карточки";
    const card = await renderBrandCard({ type:"photo", title, subtitle:rawCaption || "События и инициативы Совета", photoDataUrl:dataUrl });
    stage = "отправка предпросмотра";
    const preview = await sendBrandedPhoto(env, adminId, card, caption);
    stage = "сохранение черновика";
    const inserted = await env.DB.prepare("INSERT INTO social_publication_drafts (type,source_message_id,preview_message_id,template_id,status,created_at) VALUES (?,?,?,?,?,?)")
      .bind("photo", msg.message_id, preview.message_id, template.id, "pending", now).run();
    const draftId = inserted.meta && inserted.meta.last_row_id;
    if (!draftId) throw new Error("Не удалось сохранить черновик в базе данных.");
    stage = "обновление статуса";
    await tg(env, "editMessageText", {
      chat_id: adminId,
      message_id: next.notice_message_id,
      text: "✅ Предпросмотр готов · Фото · шаблон «" + template.name + "».\n\nПроверь карточку выше. В канал ничего не отправлено — публикация произойдёт только после твоего подтверждения."
    });
    await tg(env, "sendMessage", {
      chat_id: adminId,
      text: "Готово! Если всё выглядит правильно, подтверди публикацию:",
      reply_markup: publishKeyboard(draftId)
    });
    await env.DB.prepare("DELETE FROM social_publication_state WHERE key IN ('compose_type','compose_title')").run();
    await env.DB.prepare("UPDATE social_publication_queue SET status='done' WHERE id=?").bind(next.id).run();
  } catch (error) {
    const detail = String(error && error.message ? error.message : "неизвестная ошибка").slice(0, 220);
    console.error("Social photo queue failed at " + stage + ":", detail);
    try {
      await tg(env, "editMessageText", {
        chat_id: adminId,
        message_id: next.notice_message_id,
        text: "⚠️ Не удалось подготовить предпросмотр.\nЭтап: " + stage + ".\nПричина: " + detail + "\n\nВ канал ничего не опубликовано. Формат сохранён — после исправления можно отправить фото ещё раз."
      });
    } catch (notifyError) {
      console.error("Could not update queued social photo status:", notifyError && notifyError.message ? notifyError.message : "unknown error");
    }
    await env.DB.prepare("UPDATE social_publication_queue SET status='failed' WHERE id=?").bind(next.id).run();
  }
}

async function handleSocialUpdate(env, item, adminId) {
  if (!env || !env.DB || !env.SOVETTG_BOT_TOKEN) return false;
  await ensureTables(env);

  if (item.callback_query) {
    const q = item.callback_query;
    const chat = q.message && q.message.chat;
    if (!chat || chat.type !== "private" || String(chat.id) !== adminId || String(q.from && q.from.id) !== adminId) return false;
    const data = String(q.data || "");

    if (data === "social:new") {
      await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
      await sendTypeMenu(env, adminId);
      return true;
    }
    const typeMatch = data.match(/^social:type:(post|photo)$/);
    if (typeMatch) {
      const type = typeMatch[1];
      const templateMode = await env.DB.prepare("SELECT value FROM social_publication_state WHERE key='template_mode'").first();
      if (templateMode && templateMode.value === "1") {
        await env.DB.prepare("DELETE FROM social_publication_state WHERE key='template_mode'").run();
        await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Выбери оформление." });
        await tg(env, "sendMessage", { chat_id: adminId, text: "Варианты оформления для формата «" + TYPES[type].title + "»:", reply_markup: templateKeyboard(type) });
        return true;
      }
      await env.DB.prepare("INSERT INTO social_publication_state (key,value) VALUES ('compose_type',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(type).run();
      await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Формат выбран." });
      await tg(env, "sendMessage", { chat_id: adminId, text: TYPES[type].prompt + "\n\nЕдиный фирменный шаблон будет применён автоматически." });
      return true;
    }
    const publishMatch = data.match(/^social:(publish|reject):(\d+)$/);
    if (publishMatch) {
      const [, action, id] = publishMatch;
      const draft = await env.DB.prepare("SELECT * FROM social_publication_drafts WHERE id = ?").bind(Number(id)).first();
      if (!draft || draft.status !== "pending") {
        await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Этот черновик уже обработан.", show_alert: true });
        return true;
      }
      if (action === "reject") {
        await env.DB.prepare("UPDATE social_publication_drafts SET status='rejected' WHERE id=? AND status='pending'").bind(Number(id)).run();
        await tg(env, "editMessageReplyMarkup", { chat_id: adminId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
        await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Отклонено. В канал ничего не отправлено." });
        return true;
      }
      const lock = await env.DB.prepare("UPDATE social_publication_drafts SET status='publishing' WHERE id=? AND status='pending'").bind(Number(id)).run();
      if (!lock.meta || !lock.meta.changes) {
        await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Черновик уже обрабатывается." });
        return true;
      }
      try {
        await tg(env, "copyMessage", { chat_id: CHANNEL, from_chat_id: adminId, message_id: draft.preview_message_id });
        await env.DB.prepare("UPDATE social_publication_drafts SET status='published' WHERE id=?").bind(Number(id)).run();
        await tg(env, "editMessageReplyMarkup", { chat_id: adminId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
        await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Опубликовано в канале!" });
      } catch (error) {
        await env.DB.prepare("UPDATE social_publication_drafts SET status='pending' WHERE id=? AND status='publishing'").bind(Number(id)).run();
        await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Не удалось опубликовать. Черновик сохранён.", show_alert: true });
      }
      return true;
    }
    return false;
  }

  const msg = item.message;
  if (!msg || !msg.chat || msg.chat.type !== "private" || String(msg.chat.id) !== adminId || String(msg.from && msg.from.id) !== adminId) return false;
  const text = String(msg.text || "").trim();
  const normalized = text.toLocaleLowerCase("ru");

  if (normalized === "✍️ публикация" || normalized === "/social") {
    await sendTypeMenu(env, adminId);
    return true;
  }


  if (msg.photo || text) {
    const state = await env.DB.prepare("SELECT value FROM social_publication_state WHERE key='compose_type'").first();
    const type = String(state && state.value || "");
    if (!TYPES[type]) return false;
    if (type === "post" && !text) {
      await tg(env, "sendMessage", { chat_id: adminId, text: "Для формата «Пост» пришли текстовое сообщение." });
      return true;
    }
    if (type === "photo" && !msg.photo) {
      if (text) {
        await env.DB.prepare("INSERT INTO social_publication_state (key,value) VALUES ('compose_title',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(text.slice(0,180)).run();
        await tg(env, "sendMessage", { chat_id: adminId, text: "Заголовок сохранён: «" + text.slice(0,180) + "». Теперь отправь фотографию. Подпись к фото тоже можно использовать как заголовок." });
      } else {
        await tg(env, "sendMessage", { chat_id: adminId, text: "Сначала отправь заголовок текстом, затем фотографию. Или отправь фото с подписью." });
      }
      return true;
    }
    if (type === "photo") {
      const savedTitleRow = await env.DB.prepare("SELECT value FROM social_publication_state WHERE key='compose_title'").first();
      const publicationTitle = String(msg.caption || (savedTitleRow && savedTitleRow.value) || "").trim();
      if (!publicationTitle) {
        await tg(env, "sendMessage", { chat_id: adminId, text: "Сначала отправь заголовок отдельным сообщением, затем фотографию. Либо отправь фотографию с подписью." });
        return true;
      }
      const notice = await tg(env, "sendMessage", {
        chat_id: adminId,
        text: "📥 Фото получил! Поставил обработку в очередь. Соберу горизонтальную карточку и пришлю предпросмотр отдельным сообщением."
      });
      await env.DB.prepare("INSERT INTO social_publication_queue (payload,status,notice_message_id,created_at,started_at) VALUES (?, 'pending', ?, ?, NULL)")
        .bind(JSON.stringify({ message: msg, title: publicationTitle }), notice.message_id, Math.floor(Date.now()/1000)).run();
      return true;
    }
    let processingNotice = null;
    let stage = "приём сообщения";
    try {
      processingNotice = await tg(env, "sendMessage", {
        chat_id: adminId,
        text: type === "photo"
          ? "📥 Фото получил! Загружаю оригинал и собираю горизонтальную карточку Совета. Скоро пришлю предпросмотр."
          : "📥 Текст получил! Готовлю предпросмотр публикации."
      });
      stage = "чтение настроек оформления";
      const template = await selectedTemplate(env, type);
      const rawCaption = String(msg.caption || text || "").trim();
      const caption = captionFor(type, template.id, rawCaption);
      let preview;
      const title = rawCaption.split(/[.!?\n]/)[0].slice(0, 58) || "Новости и события";
      if (type === "post") {
        stage = "отправка текстового предпросмотра";
        preview = await tg(env, "sendMessage", { chat_id: adminId, text: caption });
      } else if (type === "photo") {
        stage = "загрузка оригинала фото";
        const photo = msg.photo[msg.photo.length - 1];
        const dataUrl = await telegramImageData(env, photo.file_id);
        stage = "сборка карточки";
        const card = await renderBrandCard({ type, title, subtitle:rawCaption || "События и инициативы Совета", photoDataUrl:dataUrl });
        stage = "отправка предпросмотра";
        preview = await sendBrandedPhoto(env, adminId, card, caption);
      }
      stage = "сохранение черновика";
      const id = await env.DB.prepare("INSERT INTO social_publication_drafts (type,source_message_id,preview_message_id,template_id,status,created_at) VALUES (?,?,?,?,?,?)")
        .bind(type, msg.message_id, preview.message_id, template.id, "pending", Math.floor(Date.now()/1000)).run();
      const draftId = id.meta && id.meta.last_row_id;
      stage = "обновление статуса";
      await tg(env, "editMessageText", {
        chat_id: adminId,
        message_id: processingNotice.message_id,
        text: "✅ Предпросмотр готов · " + TYPES[type].title + " · шаблон «" + template.name + "».\n\nПроверь публикацию выше. В канал ничего не отправлено — публикация произойдёт только после твоего подтверждения."
      });
      await tg(env, "sendMessage", {
        chat_id: adminId,
        text: "Готово! Если всё выглядит правильно, подтверди публикацию:",
        reply_markup: publishKeyboard(draftId)
      });
      await env.DB.prepare("DELETE FROM social_publication_state WHERE key='compose_type'").run();
      return true;
    } catch (error) {
      const detail = String(error && error.message ? error.message : "неизвестная ошибка").slice(0, 220);
      const message = "⚠️ Не удалось подготовить предпросмотр.\nЭтап: " + stage + ".\nПричина: " + detail + "\n\nВ канал ничего не опубликовано. Настройка формата сохранена — можно отправить фото ещё раз после исправления.";
      console.error("Social publisher failed at " + stage + ":", detail);
      try {
        if (processingNotice && processingNotice.message_id) {
          await tg(env, "editMessageText", { chat_id: adminId, message_id: processingNotice.message_id, text: message });
        } else {
          await tg(env, "sendMessage", { chat_id: adminId, text: message });
        }
      } catch (notifyError) {
        console.error("Could not notify admin about social publisher failure:", notifyError && notifyError.message ? notifyError.message : "unknown error");
      }
      return true;
    }
  }
  return false;
}

export { handleSocialUpdate, processQueuedSocialPhotos };

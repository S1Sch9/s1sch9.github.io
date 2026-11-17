const API = "https://api.telegram.org/bot";
const BRAND = "https://s1sch9.github.io";
const CHANNEL = "@dvizhenieschool9";
const REQUEST_TIMEOUT_MS = 25000;

async function fetchWithTimeout(url, options = {}, label = "Запрос") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(label + ": превышено время ожидания (25 сек.).");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function tg(env, method, payload) {
  const response = await fetchWithTimeout(API + env.SOVETTG_BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {})
  }, "Telegram " + method);
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
  // Единственный фирменный знак проекта — оригинальный логотип Совета.
  const councilLogo = await assetDataUrl(BRAND + "/logo-soveta-pervykh.png");
  const importantMark = await assetDataUrl(BRAND + "/vazhen.png");
  const safeTitle = escapeHtml(title || "СОВЕТ ПЕРВЫХ");
  const safeSubtitle = escapeHtml(subtitle || "Школы №9");
  const isPhoto = Boolean(photoDataUrl);
  const main = isPhoto
    ? '<div style="display:flex;position:absolute;left:54px;top:132px;width:1172px;height:454px;align-items:center;justify-content:center;background-color:#fff;border:4px solid #a1001f;border-radius:28px;padding:12px;box-sizing:border-box;box-shadow:0 18px 48px rgba(61,0,13,.18)"><img src="' + photoDataUrl + '" width="1140" height="422" style="width:1140px;height:422px;object-fit:contain;object-position:center;border-radius:18px" /></div>'
    : '<div style="display:flex;position:absolute;left:78px;top:142px;width:1124px;height:420px;flex-direction:column;justify-content:center;align-items:flex-start;padding:60px;box-sizing:border-box;background-color:rgba(255,255,255,.88);border:3px solid #a1001f;border-radius:30px;box-shadow:0 18px 48px rgba(61,0,13,.12)"><div style="display:flex;font-size:22px;font-weight:700;letter-spacing:5px;color:#a1001f">СОВЕТ ПЕРВЫХ · ШКОЛА №9</div><div style="display:flex;font-size:64px;line-height:1.1;font-weight:800;color:#3d000d;margin-top:28px">' + safeTitle + '</div><div style="display:flex;font-size:28px;color:#745b65;margin-top:22px">' + safeSubtitle + '</div><div style="display:flex;width:120px;height:7px;background-color:#f0c869;margin-top:28px;border-radius:8px"></div></div>';
  const photoHeading = isPhoto
    ? '<div style="display:flex;position:absolute;left:54px;top:34px;width:1172px;height:76px;align-items:center;padding:0 30px;box-sizing:border-box;background-color:#fff;border-left:5px solid #a1001f;border-radius:18px;box-shadow:0 8px 24px rgba(61,0,13,.08)"><div style="display:flex;font-size:34px;font-weight:800;color:#3d000d;line-height:1.1">' + safeTitle + '</div></div>'
    : '';
  const html = '<div style="display:flex;position:relative;width:1280px;height:720px;overflow:hidden;background-color:#fffafb;font-family:Arial,sans-serif">' +
    '<div style="display:flex;position:absolute;left:-90px;top:230px;width:260px;height:260px;border-radius:999px;background-color:rgba(161,0,31,.055)"></div>' +
    '<div style="display:flex;position:absolute;right:-100px;top:-100px;width:330px;height:330px;border-radius:999px;background-color:rgba(240,200,105,.12)"></div>' +
    photoHeading + main +
    '<div style="display:flex;position:absolute;left:0;bottom:0;width:100%;height:104px;background-color:rgba(255,255,255,.97);border-top:3px solid #a1001f;align-items:center;justify-content:flex-start;padding:0 58px;box-sizing:border-box">' +
    '<div style="display:flex;width:100%;align-items:center;justify-content:space-between"><div style="display:flex;align-items:center;gap:18px"><img src="' + councilLogo + '" width="76" height="76" style="width:76px;height:76px;object-fit:contain" /><div style="display:flex;flex-direction:column"><div style="display:flex;font-size:25px;font-weight:800;color:#3d000d">СОВЕТ ПЕРВЫХ</div><div style="display:flex;font-size:18px;color:#745b65;margin-top:5px">ШКОЛЫ №9</div></div></div><img src="' + importantMark + '" width="210" height="76" style="width:210px;height:76px;object-fit:contain;object-position:right center" /></div></div></div>';
  const { ImageResponse } = await import("workers-og");
  const response = new ImageResponse(html, { width:1280, height:720 });
  return new Uint8Array(await response.arrayBuffer());
}
async function telegramImageData(env, fileId) {
  const info = await tg(env, "getFile", { file_id:fileId });
  if (!info || !info.file_path) throw new Error("Telegram не вернул путь к фотографии.");
  const response = await fetchWithTimeout("https://api.telegram.org/file/bot" + env.SOVETTG_BOT_TOKEN + "/" + info.file_path, {}, "Загрузка оригинала фото");
  if (!response.ok) throw new Error("Не удалось загрузить фотографию из Telegram.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 8 * 1024 * 1024) throw new Error("Фото больше 8 МБ — отправь его в обычном размере.");
  let binary = "";
  for (let i=0;i<bytes.length;i+=0x8000) binary += String.fromCharCode(...bytes.subarray(i,i+0x8000));
  return "data:" + (response.headers.get("content-type") || "image/jpeg") + ";base64," + btoa(binary);
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
}

const TYPES = {
  post: { title: "Пост", prompt: "Отправь текст публикации одним сообщением." },
  photo: { title: "Фото", prompt: "Отправь одно фото. Подпись можно добавить к нему." },
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
    [{ text: "✍️ Пост", callback_data: "social:type:post" }, { text: "🖼 Фото", callback_data: "social:type:photo" }],
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
      await tg(env, "sendMessage", { chat_id: adminId, text: TYPES[type].prompt + "\n\nТекущий шаблон будет применён автоматически. Чтобы поменять его, нажми «🎨 Шаблоны публикаций» в меню." });
      return true;
    }
    const templateMatch = data.match(/^social:template:(post|photo):([a-z]+)$/);
    if (templateMatch) {
      const [, type, id] = templateMatch;
      const template = TEMPLATES[type].find(x => x.id === id);
      if (!template) {
        await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Шаблон не найден." });
        return true;
      }
      await env.DB.prepare("INSERT INTO social_publication_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind("template:" + type, id).run();
      await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Сохранено для следующих публикаций." });
      await tg(env, "sendMessage", { chat_id: adminId, text: "✅ Для формата «" + TYPES[type].title + "» сохранён шаблон «" + template.name + "». Больше не буду спрашивать его при каждой публикации." });
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
  if (normalized === "🎨 шаблоны публикаций" || normalized === "/templates") {
    await env.DB.prepare("INSERT INTO social_publication_state (key,value) VALUES ('template_mode','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    await tg(env, "sendMessage", { chat_id: adminId, text: "Выбери формат, для которого хочешь изменить сохранённый шаблон:", reply_markup: typeKeyboard() });
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
      await tg(env, "sendMessage", { chat_id: adminId, text: "Для формата «Фото» пришли фотографию или альбом." });
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
        text: "✅ Предпросмотр готов · " + TYPES[type].title + " · шаблон «" + template.name + "».\\n\\nПроверь публикацию выше. В канал ничего не отправлено — публикация произойдёт только после твоего подтверждения."
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
      const message = "⚠️ Не удалось подготовить предпросмотр.\\nЭтап: " + stage + ".\\nПричина: " + detail + "\\n\\nВ канал ничего не опубликовано. Настройка формата сохранена — можно отправить фото ещё раз после исправления.";
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

export { handleSocialUpdate };

const API = "https://api.telegram.org/bot";
const BRAND = "https://s1sch9.github.io";
const CHANNEL = "@dvizhenieschool9";

async function tg(env, method, payload) {
  const response = await fetch(API + env.SOVETTG_BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error("Telegram " + method + " failed");
  return data.result;
}


async function tgMultipart(env, method, form) {
  const response = await fetch(API + env.SOVETTG_BOT_TOKEN + "/" + method, { method: "POST", body: form });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error("Telegram " + method + " failed");
  return data.result;
}
function escapeHtml(value) {
  return String(value || "").replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
}
async function renderBrandCard({ type, title, subtitle, photoDataUrl }) {
  const councilLogo = BRAND + "/logo-soveta-pervykh.png";
  const schoolCrest = BRAND + "/school9-emblem.png";
  const safeTitle = escapeHtml(title || "СОВЕТ ПЕРВЫХ");
  const safeSubtitle = escapeHtml(subtitle || "Школы №9");
  const photo = photoDataUrl ? '<img src="' + photoDataUrl + '" style="position:absolute;left:0;top:0;width:1280px;height:600px;object-fit:cover" />' : "";
  const shade = photoDataUrl ? '<div style="position:absolute;left:0;top:0;width:1280px;height:600px;background:linear-gradient(90deg,rgba(40,0,15,.78),rgba(40,0,15,.08))"></div>' : "";
  const titleColor = photoDataUrl ? "#ffffff" : "#3d000d";
  const html = '<div style="display:flex;flex-direction:column;position:relative;width:1280px;height:720px;background:#fbf9fa;font-family:Arial,sans-serif;overflow:hidden">' +
    photo + shade +
    '<div style="display:flex;position:absolute;left:0;top:0;width:100%;height:600px;padding:64px 76px;box-sizing:border-box;flex-direction:column;justify-content:space-between">' +
    '<div style="display:flex;align-items:center;gap:18px"><div style="width:9px;height:46px;background:#a1001f"></div><div style="font-size:22px;font-weight:700;letter-spacing:4px;color:' + titleColor + '">СОВЕТ ПЕРВЫХ  /  ШКОЛА №9</div></div>' +
    '<div style="display:flex;flex-direction:column;gap:20px;max-width:1050px"><div style="font-size:62px;line-height:1.12;font-weight:800;color:' + titleColor + '">' + safeTitle + '</div><div style="font-size:27px;color:' + titleColor + '">' + safeSubtitle + '</div><div style="width:100px;height:7px;background:#f0c869"></div></div></div>' +
    '<div style="display:flex;position:absolute;left:0;bottom:0;width:100%;height:120px;background:#fff;border-top:3px solid #a1001f;align-items:center;justify-content:space-between;padding:0 54px;box-sizing:border-box">' +
    '<div style="display:flex;align-items:center;gap:18px"><img src="' + councilLogo + '" style="width:76px;height:76px;object-fit:contain" /><div style="display:flex;flex-direction:column"><div style="font-size:24px;font-weight:800;color:#3d000d">СОВЕТ ПЕРВЫХ</div><div style="font-size:18px;color:#745b65">ШКОЛЫ №9</div></div></div>' +
    '<div style="display:flex;align-items:center;gap:16px"><div style="font-size:16px;color:#806b74">' + (type === "video" ? "ВИДЕО" : type === "photo" ? "ФОТОРЕПОРТАЖ" : "НОВОСТИ") + '</div><img src="' + schoolCrest + '" style="width:78px;height:78px;object-fit:contain" /></div></div></div>';
  const { ImageResponse } = await import("workers-og");
  const response = new ImageResponse(html, { width:1280, height:720 });
  return new Uint8Array(await response.arrayBuffer());
}
async function telegramImageData(env, fileId) {
  const info = await tg(env, "getFile", { file_id:fileId });
  const response = await fetch("https://api.telegram.org/file/bot" + env.SOVETTG_BOT_TOKEN + "/" + info.file_path);
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
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS social_publication_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, source_message_id INTEGER NOT NULL, preview_message_id INTEGER NOT NULL, preview_video_message_id INTEGER, template_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL)").run();
  try { await env.DB.prepare("ALTER TABLE social_publication_drafts ADD COLUMN preview_video_message_id INTEGER").run(); } catch {}
}

const TYPES = {
  post: { title: "Пост", prompt: "Отправь текст публикации одним сообщением." },
  photo: { title: "Фото", prompt: "Отправь одно фото. Подпись можно добавить к нему." },
  video: { title: "Видео", prompt: "Отправь видео. Подпись можно добавить к нему." }
};

const TEMPLATES = {
  post: [
    { id: "clean", name: "Чистый", description: "Заголовок и аккуратные абзацы" },
    { id: "editorial", name: "Редакционный", description: "Выразительный заголовок и короткая подпись" }
  ],
  photo: [
    { id: "gallery", name: "Фотодневник", description: "Лаконичная подпись к кадрам" },
    { id: "report", name: "Репортаж", description: "Акцент на событии и его участниках" }
  ],
  video: [
    { id: "wide", name: "Кинолента", description: "Короткая подпись к горизонтальному видео" },
    { id: "recap", name: "Момент", description: "Акцент на главном моменте" }
  ]
};

function typeKeyboard() {
  return { inline_keyboard: [
    [{ text: "✍️ Пост", callback_data: "social:type:post" }, { text: "🖼 Фото", callback_data: "social:type:photo" }],
    [{ text: "🎬 Видео", callback_data: "social:type:video" }]
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
  const prefix = type === "video"
    ? (templateId === "recap" ? "▶  МОМЕНТЫ СОБЫТИЯ" : "▶  СОВЕТ ПЕРВЫХ · ВИДЕО")
    : (templateId === "report" ? "●  СОБЫТИЯ СОВЕТА" : "●  ФОТОДНЕВНИК");
  return [prefix, text, footer].filter(Boolean).join("\n\n").slice(0, 1024);
}

async function sendTypeMenu(env, adminId) {
  await tg(env, "sendMessage", {
    chat_id: adminId,
    text: "Что готовим для канала? Выбери один из трёх форматов.",
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
    const typeMatch = data.match(/^social:type:(post|photo|video)$/);
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
    const templateMatch = data.match(/^social:template:(post|photo|video):([a-z]+)$/);
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
        if (draft.preview_video_message_id) {
          await tg(env, "copyMessage", { chat_id: CHANNEL, from_chat_id: adminId, message_id: draft.preview_video_message_id });
        }
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

  if (msg.document || msg.photo || msg.video || text) {
    const state = await env.DB.prepare("SELECT value FROM social_publication_state WHERE key='compose_type'").first();
    const type = String(state && state.value || "");
    if (!TYPES[type]) return false;
    if (type === "post" && !text) {
      await tg(env, "sendMessage", { chat_id: adminId, text: "Для формата «Пост» пришли текстовое сообщение." });
      return true;
    }
    if (type === "photo" && !msg.photo && !(msg.document && String(msg.document.mime_type || "").startsWith("image/"))) {
      await tg(env, "sendMessage", { chat_id: adminId, text: "Для формата «Фото» пришли фотографию или альбом." });
      return true;
    }
    if (type === "video" && !msg.video) {
      await tg(env, "sendMessage", { chat_id: adminId, text: "Для формата «Видео» пришли видеофайл." });
      return true;
    }
    const template = await selectedTemplate(env, type);
    const rawCaption = String(msg.caption || text || "").trim();
    const caption = captionFor(type, template.id, rawCaption);
    let preview;
    let videoPreviewId = null;
    const title = rawCaption.split(/[.!?\\n]/)[0].slice(0, 58) || (type === "video" ? "События Совета" : "Новости и события");
    if (type === "post") {
      const card = await renderBrandCard({ type, title, subtitle:"Новости и события школьного Совета" });
      preview = await sendBrandedPhoto(env, adminId, card, caption);
    } else if (type === "photo") {
      const photo = msg.photo[msg.photo.length - 1];
      const dataUrl = await telegramImageData(env, photo.file_id);
      const card = await renderBrandCard({ type, title, subtitle:rawCaption || "События и инициативы Совета", photoDataUrl:dataUrl });
      preview = await sendBrandedPhoto(env, adminId, card, caption);
    } else {
      const cover = await renderBrandCard({ type, title, subtitle:rawCaption || "Смотрите видео" });
      preview = await sendBrandedPhoto(env, adminId, cover, "");
      const videoMessage = await tg(env, "sendVideo", { chat_id:adminId, video:msg.video.file_id, caption:caption.slice(0,1024) });
      videoPreviewId = videoMessage.message_id;
    }
    const id = await env.DB.prepare("INSERT INTO social_publication_drafts (type,source_message_id,preview_message_id,preview_video_message_id,template_id,status,created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(type, msg.message_id, preview.message_id, videoPreviewId, template.id, "pending", Math.floor(Date.now()/1000)).run();
    const draftId = id.meta && id.meta.last_row_id;
    await tg(env, "sendMessage", {
      chat_id: adminId,
      text: "Предпросмотр готов · " + TYPES[type].title + " · шаблон «" + template.name + "».\n\nВ канал ничего не отправлено. Проверь публикацию выше и нажми кнопку только если всё готово.",
      reply_markup: publishKeyboard(draftId)
    });
    await env.DB.prepare("DELETE FROM social_publication_state WHERE key='compose_type'").run();
    return true;
  }
  return false;
}

export { handleSocialUpdate };

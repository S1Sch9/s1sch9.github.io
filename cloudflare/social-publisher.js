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
  if (!response.ok || !data.ok) throw new Error("Telegram " + method + ": " + String(data.description || response.status));
  return data.result;
}


async function tgMultipart(env, method, form) {
  const response = await fetch(API + env.SOVETTG_BOT_TOKEN + "/" + method, { method: "POST", body: form });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error("Telegram " + method + ": " + String(data.description || response.status));
  return data.result;
}
function escapeHtml(value) {
  return String(value || "").replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
}
async function assetDataUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Не удалось загрузить оригинальный логотип или герб школы.");
  const mime = response.headers.get("content-type") || "image/png";
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (let i=0;i<bytes.length;i+=0x8000) binary += String.fromCharCode(...bytes.subarray(i,i+0x8000));
  return "data:" + mime + ";base64," + btoa(binary);
}

async function renderBrandCard({ type, title, subtitle, photoDataUrl }) {
  const councilLogo = await assetDataUrl(BRAND + "/logo-soveta-pervykh.png");
  const schoolCrest = await assetDataUrl(BRAND + "/school9-emblem.png");
  const safeTitle = escapeHtml(title || "СОВЕТ ПЕРВЫХ");
  const safeSubtitle = escapeHtml(subtitle || "Школы №9");
  const isPhoto = Boolean(photoDataUrl);
  const main = isPhoto
    ? '<div style="position:absolute;left:54px;top:38px;width:1172px;height:548px;display:flex;align-items:center;justify-content:center;background-color:#fff;border:4px solid #a1001f;border-radius:28px;padding:12px;box-sizing:border-box;box-shadow:0 18px 48px rgba(61,0,13,.18)"><img src="' + photoDataUrl + '" width="1140" height="516" style="width:1140px;height:516px;object-fit:contain;border-radius:16px" /></div>'
    : '<div style="position:absolute;left:78px;top:112px;width:1124px;height:430px;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;padding:60px;box-sizing:border-box;background-color:rgba(255,255,255,.88);border:3px solid #a1001f;border-radius:30px;box-shadow:0 18px 48px rgba(61,0,13,.12)"><div style="font-size:22px;font-weight:700;letter-spacing:5px;color:#a1001f">СОВЕТ ПЕРВЫХ · ШКОЛА №9</div><div style="font-size:64px;line-height:1.1;font-weight:800;color:#3d000d;margin-top:28px">' + safeTitle + '</div><div style="font-size:28px;color:#745b65;margin-top:22px">' + safeSubtitle + '</div><div style="width:120px;height:7px;background-color:#f0c869;margin-top:28px;border-radius:8px"></div></div>';
  const html = '<div style="display:flex;position:relative;width:1280px;height:720px;overflow:hidden;background-color:#fffafb;font-family:Arial,sans-serif">' +
    '<div style="position:absolute;left:-90px;top:230px;width:260px;height:260px;border-radius:999px;background-color:rgba(161,0,31,.055)"></div>' +
    '<div style="position:absolute;right:-100px;top:-100px;width:330px;height:330px;border-radius:999px;background-color:rgba(240,200,105,.12)"></div>' +
    main +
    '<div style="display:flex;position:absolute;left:0;bottom:0;width:100%;height:112px;background-color:rgba(255,255,255,.97);border-top:3px solid #a1001f;align-items:center;justify-content:space-between;padding:0 58px;box-sizing:border-box">' +
    '<div style="display:flex;align-items:center;gap:18px"><img src="' + councilLogo + '" width="76" height="76" style="width:76px;height:76px;object-fit:contain" /><div style="display:flex;flex-direction:column"><div style="font-size:25px;font-weight:800;color:#3d000d">СОВЕТ ПЕРВЫХ</div><div style="font-size:18px;color:#745b65;margin-top:5px">ШКОЛЫ №9</div></div></div>' +
    '<div style="display:flex;align-items:center;gap:18px"><div style="font-size:16px;font-weight:700;letter-spacing:2px;color:#806b74">' + (isPhoto ? "НАШИ СОБЫТИЯ" : "НОВОСТИ И ИНИЦИАТИВЫ") + '</div><img src="' + schoolCrest + '" width="78" height="78" style="width:78px;height:78px;object-fit:contain" /></div></div></div>';
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
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS social_publication_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, source_message_id INTEGER NOT NULL, preview_message_id INTEGER NOT NULL, template_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL)").run();
}

const TYPES = {
  post: { title: "Пост", prompt: "Отправь текст публикации одним сообщением." },
  photo: { title: "Фото", prompt: "Отправь одно фото. Подпись можно добавить к нему." },
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
  const prefix = templateId === "report" ? "●  СОБЫТИЯ СОВЕТА" : "●  ФОТОДНЕВНИК";
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
    const processingNotice = await tg(env, "sendMessage", {
      chat_id: adminId,
      text: type === "photo"
        ? "📥 Фото получил! Уже начал обработку: загружаю оригинал и собираю фирменную карточку. Скоро пришлю предпросмотр."
        : "📥 Текст получил! Уже начал оформление и подготовку предпросмотра. Скоро пришлю результат."
    });
    const template = await selectedTemplate(env, type);
    const rawCaption = String(msg.caption || text || "").trim();
    const caption = captionFor(type, template.id, rawCaption);
    let preview;
    const title = rawCaption.split(/[.!?\\n]/)[0].slice(0, 58) || "Новости и события";
    if (type === "post") {
      const card = await renderBrandCard({ type, title, subtitle:"Новости и события школьного Совета" });
      preview = await sendBrandedPhoto(env, adminId, card, caption);
    } else if (type === "photo") {
      const photo = msg.photo[msg.photo.length - 1];
      const dataUrl = await telegramImageData(env, photo.file_id);
      const card = await renderBrandCard({ type, title, subtitle:rawCaption || "События и инициативы Совета", photoDataUrl:dataUrl });
      preview = await sendBrandedPhoto(env, adminId, card, caption);
    }
    const id = await env.DB.prepare("INSERT INTO social_publication_drafts (type,source_message_id,preview_message_id,template_id,status,created_at) VALUES (?,?,?,?,?,?)")
      .bind(type, msg.message_id, preview.message_id, template.id, "pending", Math.floor(Date.now()/1000)).run();
    const draftId = id.meta && id.meta.last_row_id;
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
  }
  return false;
}

export { handleSocialUpdate };

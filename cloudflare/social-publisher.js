const API = "https://api.telegram.org/bot";
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

async function ensureTables(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS social_publication_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS social_publication_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, source_message_id INTEGER NOT NULL, preview_message_id INTEGER NOT NULL, template_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL)").run();
}

const TYPES = {
  post: { title: "Пост", prompt: "Отправь текст публикации одним сообщением." },
  photo: { title: "Фото", prompt: "Отправь одно фото или альбом. Подпись можно добавить к фото." },
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
    if (type === "photo" && !msg.photo && !msg.document) {
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
    if (type === "post") {
      preview = await tg(env, "sendMessage", { chat_id: adminId, text: caption, reply_markup: { inline_keyboard: [] } });
    } else {
      const copied = await tg(env, "copyMessage", {
        chat_id: adminId, from_chat_id: adminId, message_id: msg.message_id,
        caption: caption.slice(0, 1024)
      });
      preview = copied;
    }
    const id = await env.DB.prepare("INSERT INTO social_publication_drafts (type,source_message_id,preview_message_id,template_id,status,created_at) VALUES (?,?,?,?,?,?)")
      .bind(type, msg.message_id, preview.message_id, template.id, "pending", Math.floor(Date.now()/1000)).run();
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

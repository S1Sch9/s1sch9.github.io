const API = "https://api.telegram.org/bot";
const CHANNEL = "@dvizhenieschool9";
const TEXT_MODEL = "@cf/google/gemma-4-26b-a4b-it";
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const POLL_CRON = "* * * * *";
const DAILY_CRON = "0 5 * * *";

async function tg(env, method, payload) {
  const response = await fetch(API + env.SOVETTG_BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error("Telegram " + method + " failed");
  return result.result;
}

async function tables(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS daily_holiday_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS daily_holiday_drafts (date TEXT PRIMARY KEY, chat_id TEXT NOT NULL, message_id INTEGER, status TEXT NOT NULL, holiday_title TEXT NOT NULL DEFAULT '', source_url TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)").run();
}

function localDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return p.year + "-" + p.month + "-" + p.day;
}

function plain(html) {
  return String(html || "").replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&mdash;/gi, "—").replace(/&ndash;/gi, "–")
    .replace(/&laquo;/gi, "«").replace(/&raquo;/gi, "»")
    .replace(/\s+/g, " ").trim();
}

async function candidatesFor(date) {
  const response = await fetch("https://www.calend.ru/holidays/" + date + "/", {
    headers: { "Accept": "text/html", "Accept-Language": "ru-RU,ru;q=0.9" }
  });
  if (!response.ok) throw new Error("Calendar source unavailable");
  const html = await response.text();
  const re = /<div class="caption">\s*<span class="title">\s*<a href="([^"]+)">([\s\S]*?)<\/a>[\s\S]*?<p class="descr descrFixed">\s*<a href="[^"]+">([\s\S]*?)<\/a>/g;
  const list = [];
  for (const m of html.matchAll(re)) {
    const title = plain(m[2]);
    if (!title) continue;
    list.push({ title, description: plain(m[3]).slice(0, 450), url: new URL(m[1], "https://www.calend.ru").toString() });
    if (list.length === 10) break;
  }
  return list;
}

function modelText(result) {
  if (typeof result === "string") return result;
  return (result && result.response) ||
    (result && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content) || "";
}

function parseObject(value) {
  const s = String(value || "").replace(/^\s*\x60{3}(?:json)?/i, "").replace(/\x60{3}\s*$/, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("AI JSON missing");
  return JSON.parse(s.slice(a, b + 1));
}

async function makeDraft(env) {
  if (!env.SOVETTG_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID || !env.AI || !env.DB) return;
  await tables(env);
  const date = localDate();
  const old = await env.DB.prepare("SELECT status, created_at FROM daily_holiday_drafts WHERE date = ?").bind(date).first();
  if (old && ["pending", "publishing", "published", "skipped"].includes(old.status)) return;
  if (old && ["generating", "failed"].includes(old.status) && Date.now() / 1000 - old.created_at < 1800) return;
  await env.DB.prepare("INSERT INTO daily_holiday_drafts (date, chat_id, status, created_at) VALUES (?, ?, 'generating', ?) ON CONFLICT(date) DO UPDATE SET chat_id=excluded.chat_id, message_id=NULL, status='generating', created_at=excluded.created_at")
    .bind(date, String(env.TELEGRAM_ADMIN_ID), Math.floor(Date.now() / 1000)).run();

  try {
    const list = await candidatesFor(date);
    if (!list.length) throw new Error("No holiday candidates");
    const dateLabel = new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow", day: "numeric", month: "long", year: "numeric", weekday: "long"
    }).format(new Date(date + "T12:00:00+03:00"));
    const prompt = [
      "Ты редактор школьного сообщества «Совет Первых школы № 9».",
      "Дата: " + dateLabel + ". Выбери один позитивный, интересный и уместный для школьников праздник из списка.",
      "Не выбирай политику, войну, трагедии, медицину или спорные темы. Предпочитай образование, культуру, науку, творчество и добрые поводы.",
      "Не придумывай факты и даты: опирайся только на описания. Напиши живой русский пост примерно 450–700 знаков, с уместными эмодзи, без канцелярита.",
      "Верни строго JSON: selected_index (индекс выбранного события с нуля), post (текст поста), image_prompt (подробный промпт на английском).",
      "Для картинки: выразительная праздничная редакционная иллюстрация, глубокий фиолетовый фон, белые и золотистые акценты, мягкое освещение; без текста, букв, логотипов и водяных знаков.",
      "Список: " + JSON.stringify(list)
    ].join("\n");
    const answer = await env.AI.run(TEXT_MODEL, {
      messages: [
        { role: "system", content: "Пиши грамотно, не выдумывай факты. Ответ — только JSON." },
        { role: "user", content: prompt }
      ],
      max_completion_tokens: 1000,
      temperature: 0.65,
      response_format: { type: "json_object" }
    });
    const draft = parseObject(modelText(answer));
    const index = Number(draft.selected_index);
    if (!Number.isInteger(index) || index < 0 || index >= list.length) throw new Error("Invalid selected holiday");
    const chosen = list[index];
    const post = Array.from(String(draft.post || "").trim()).slice(0, 800).join("");
    const imagePrompt = String(draft.image_prompt || "").slice(0, 1700);
    if (post.length < 80 || imagePrompt.length < 30) throw new Error("Incomplete AI draft");

    const picture = await env.AI.run(IMAGE_MODEL, {
      prompt: imagePrompt + ". Square composition, high quality, no text, no letters, no logo, no watermark.",
      steps: 4,
      seed: Math.floor(Date.now() / 1000) % 2147483647
    });
    if (!picture || !picture.image) throw new Error("Image generation failed");
    const bytes = Uint8Array.from(atob(picture.image), c => c.charCodeAt(0));
    const keyboard = { inline_keyboard: [[
      { text: "✅ Опубликовать", callback_data: "publish:" + date },
      { text: "✖️ Отклонить", callback_data: "skip:" + date }
    ]] };
    const form = new FormData();
    form.append("chat_id", String(env.TELEGRAM_ADMIN_ID));
    form.append("photo", new Blob([bytes], { type: "image/jpeg" }), "holiday-" + date + ".jpg");
    form.append("caption", (post + "\n\nИсточник календаря: " + chosen.url).slice(0, 1024));
    form.append("reply_markup", JSON.stringify(keyboard));
    const sentResponse = await fetch(API + env.SOVETTG_BOT_TOKEN + "/sendPhoto", { method: "POST", body: form });
    const sent = await sentResponse.json();
    if (!sentResponse.ok || !sent.ok || !sent.result || !sent.result.message_id) throw new Error("Draft delivery failed");
    await env.DB.prepare("UPDATE daily_holiday_drafts SET message_id = ?, status = 'pending', holiday_title = ?, source_url = ? WHERE date = ?")
      .bind(sent.result.message_id, chosen.title, chosen.url, date).run();
  } catch (error) {
    await env.DB.prepare("UPDATE daily_holiday_drafts SET status = 'failed' WHERE date = ?").bind(date).run();
    console.error("Daily post generation failed:", error && error.message ? error.message : "unknown error");
  }
}

async function callback(env, item, adminId) {
  const q = item.callback_query;
  const chat = q && q.message && q.message.chat;
  if (!chat || chat.type !== "private" || String(chat.id) !== adminId || String(q.from && q.from.id) !== adminId) {
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Недоступно." });
    return;
  }
  const match = String(q.data || "").match(/^(publish|skip):(\d{4}-\d{2}-\d{2})$/);
  if (!match) {
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Неизвестное действие." });
    return;
  }
  const action = match[1], date = match[2];
  const row = await env.DB.prepare("SELECT chat_id, message_id, status FROM daily_holiday_drafts WHERE date = ?").bind(date).first();
  if (!row || row.status !== "pending" || String(row.chat_id) !== adminId || !row.message_id) {
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Черновик уже обработан." });
    return;
  }
  if (action === "skip") {
    await env.DB.prepare("UPDATE daily_holiday_drafts SET status = 'skipped' WHERE date = ? AND status = 'pending'").bind(date).run();
    await tg(env, "editMessageReplyMarkup", { chat_id: adminId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Отклонено. В канал ничего не отправлено." });
    return;
  }
  const lock = await env.DB.prepare("UPDATE daily_holiday_drafts SET status = 'publishing' WHERE date = ? AND status = 'pending'").bind(date).run();
  if (!lock.meta || !lock.meta.changes) {
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Уже обрабатывается." });
    return;
  }
  try {
    await tg(env, "copyMessage", { chat_id: CHANNEL, from_chat_id: adminId, message_id: row.message_id });
    await env.DB.prepare("UPDATE daily_holiday_drafts SET status = 'published' WHERE date = ?").bind(date).run();
  } catch (error) {
    await env.DB.prepare("UPDATE daily_holiday_drafts SET status = 'pending' WHERE date = ? AND status = 'publishing'").bind(date).run();
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Ошибка публикации. Черновик сохранён." });
    throw error;
  }
  try {
    await tg(env, "editMessageReplyMarkup", { chat_id: adminId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
  } catch {}
  await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Опубликовано в канале!" });
}

async function processUpdate(env, item, adminId) {
  if (item.callback_query) return callback(env, item, adminId);
  const msg = item.message;
  if (!msg || !msg.chat || msg.chat.type !== "private" || String(msg.chat.id) !== adminId || String(msg.from && msg.from.id) !== adminId) return;
  const text = String(msg.text || "").trim().toLowerCase();
  if (text === "/start" || text === "/help") {
    await tg(env, "sendMessage", {
      chat_id: adminId,
      text: "💙 Это отдельный бот рубрики «Праздник каждый день». Каждый день здесь будет появляться готовый пост с картинкой. В канал он попадёт только после нажатия «Опубликовать»."
    });
  }
}

async function poll(env) {
  if (!env.SOVETTG_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID || !env.DB) return;
  await tables(env);
  const adminId = String(env.TELEGRAM_ADMIN_ID);
  const initialized = await env.DB.prepare("SELECT value FROM daily_holiday_state WHERE key = 'polling_initialized'").first();
  if (!initialized) {
    await tg(env, "deleteWebhook", { drop_pending_updates: false });
    await env.DB.prepare("INSERT INTO daily_holiday_state (key, value) VALUES ('polling_initialized', '1')").run();
  }
  const saved = await env.DB.prepare("SELECT value FROM daily_holiday_state WHERE key = 'update_offset'").first();
  const updates = await tg(env, "getUpdates", {
    offset: Number(saved && saved.value || 0), timeout: 0, allowed_updates: ["message", "callback_query"]
  });
  for (const item of updates || []) {
    try {
      await processUpdate(env, item, adminId);
      await env.DB.prepare("INSERT INTO daily_holiday_state (key, value) VALUES ('update_offset', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(String(Number(item.update_id) + 1)).run();
    } catch (error) {
      console.error("Daily bot update failed:", error && error.message ? error.message : "unknown error");
      break;
    }
  }
}

export async function runDailyHolidayCron(controller, env) {
  if (!env || !env.SOVETTG_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID || !env.DB) return;
  if (controller && controller.cron === DAILY_CRON) {
    await makeDraft(env);
    await poll(env);
  } else if (controller && controller.cron === POLL_CRON) {
    await poll(env);
  }
}

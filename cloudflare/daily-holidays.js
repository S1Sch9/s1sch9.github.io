const API = "https://api.telegram.org/bot";
const CHANNEL = "@dvizhenieschool9";
const TEXT_MODEL = "@cf/google/gemma-4-26b-a4b-it";
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const POLL_CRON = "* * * * *";
const DAILY_CRON = "0 5 * * *";
const REQUEST_TIMEOUT_MS = 25000;
const AI_TIMEOUT_MS = 45000;

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS, label = "Запрос") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(label + ": превышено время ожидания (" + Math.round(timeoutMs / 1000) + " сек.).");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ": превышено время ожидания (" + Math.round(timeoutMs / 1000) + " сек.).")), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function tg(env, method, payload) {
  const response = await fetchWithTimeout(API + env.SOVETTG_BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {})
  }, REQUEST_TIMEOUT_MS, "Telegram " + method);
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error("Telegram " + method + " failed");
  return result.result;
}

async function tables(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS daily_holiday_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS daily_holiday_drafts (date TEXT PRIMARY KEY, chat_id TEXT NOT NULL, message_id INTEGER, status TEXT NOT NULL, holiday_title TEXT NOT NULL DEFAULT '', source_url TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS daily_holiday_updates (update_id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS daily_holiday_assets (key TEXT PRIMARY KEY, mime_type TEXT NOT NULL, file_name TEXT NOT NULL, content_base64 TEXT NOT NULL, updated_at INTEGER NOT NULL)").run();
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
  const response = await fetchWithTimeout("https://www.calend.ru/holidays/" + date + "/", {
    headers: { "Accept": "text/html", "Accept-Language": "ru-RU,ru;q=0.9" }
  }, REQUEST_TIMEOUT_MS, "Календарь");
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
  const extract = value => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(item => {
      if (typeof item === "string") return item;
      if (item && typeof item.text === "string") return item.text;
      if (item && typeof item.content === "string") return item.content;
      return "";
    }).filter(Boolean).join("\\n");
    return "";
  };
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const direct = extract(result.response) || extract(result.output_text) || extract(result.text) || extract(result.content);
  if (direct) return direct;
  const choice = result.choices && result.choices[0];
  if (choice) {
    const fromMessage = extract(choice.message && choice.message.content);
    if (fromMessage) return fromMessage;
    const fromChoice = extract(choice.text);
    if (fromChoice) return fromChoice;
  }
  for (const item of (Array.isArray(result.output) ? result.output : [])) {
    const value = extract(item && item.content);
    if (value) return value;
  }
  return "";
}

function parseObject(value) {
  const s = String(value || "").replace(/^\s*\x60{3}(?:json)?/i, "").replace(/\x60{3}\s*$/, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("AI JSON missing");
  return JSON.parse(s.slice(a, b + 1));
}


const ROBOTO_BLACK_WIDTHS = {
  А:.681,Б:.625,В:.645,Г:.558,Д:.742,Е:.560,Ё:.560,Ж:1.043,З:.629,И:.693,Й:.693,
  К:.647,Л:.705,М:.876,Н:.703,О:.690,П:.704,Р:.651,С:.656,Т:.631,У:.633,Ф:.838,
  Х:.639,Ц:.772,Ч:.699,Ш:.966,Щ:1.046,Ъ:.779,Ы:.872,Ь:.623,Э:.636,Ю:.972,Я:.572,
  " ":.249,"-":.450
};
function robotoBlackWidth(value, fontSize) {
  return Array.from(String(value || "")).reduce((sum, char) => sum + (ROBOTO_BLACK_WIDTHS[char] || .62) * fontSize, 0);
}
function wrapHolidayTitle(value, maxWidth = 430, fontSize = 76) {
  const words = String(value || "").toLocaleUpperCase("ru").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (robotoBlackWidth(word, fontSize) > maxWidth) {
      if (line) { lines.push(line); line = ""; }
      let chunk = "";
      for (const char of Array.from(word)) {
        const candidate = chunk + char;
        if (chunk && robotoBlackWidth(candidate + "-", fontSize) > maxWidth) {
          lines.push(chunk + "-");
          chunk = char;
        } else chunk = candidate;
      }
      line = chunk;
      continue;
    }
    const next = line ? line + " " + word : word;
    if (line && robotoBlackWidth(next, fontSize) > maxWidth) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}
function fitHolidayTitle(value) {
  for (let fontSize = 76; fontSize >= 42; fontSize -= 2) {
    const lines = wrapHolidayTitle(value, 430, fontSize);
    if (lines.length <= 4) return { lines, fontSize };
  }
  throw new Error("Название праздника слишком длинное для исходного шаблона. Черновик не отправлен.");
}

function holidayIllustration(title) {
  const t = String(title || "").toLocaleLowerCase("ru");
  if (/космос|космонавт|астрон/.test(t)) return '<g stroke="#21105f" stroke-width="9" stroke-linejoin="round"><path d="M132 28 C92 70 90 145 132 188 C174 145 172 70 132 28Z" fill="#ffcf55"/><path d="M132 45 L132 180" stroke="#fff"/><path d="M94 122 L56 157 L108 165 M170 122 L208 157 L156 165" fill="#ef6b59"/><circle cx="132" cy="100" r="22" fill="#65b9d4"/><path d="M110 180 L90 218 L132 202 L174 218 L154 180" fill="#ef6b59"/></g>';
  if (/наук|математ|физик|хим|изобрет/.test(t)) return '<g stroke="#21105f" stroke-width="9" fill="none"><ellipse cx="132" cy="128" rx="96" ry="42"/><ellipse cx="132" cy="128" rx="96" ry="42" transform="rotate(60 132 128)"/><ellipse cx="132" cy="128" rx="96" ry="42" transform="rotate(120 132 128)"/><circle cx="132" cy="128" r="18" fill="#ffcf55"/><circle cx="48" cy="128" r="12" fill="#ef6b59"/><circle cx="178" cy="45" r="12" fill="#65b9d4"/></g>';
  if (/музык|песн|композ|танц/.test(t)) return '<g stroke="#21105f" stroke-width="9" stroke-linejoin="round"><path d="M112 42 V160 C92 145 54 154 50 180 C46 215 104 221 112 187 V88 L208 65 V145 C188 130 150 140 146 166 C142 201 200 207 208 173 V34Z" fill="#ef6b59"/><path d="M112 88 L208 65" stroke="#fff" stroke-width="7"/></g>';
  if (/эколог|природ|лес|земл|вод|живот|птиц|растен/.test(t)) return '<g stroke="#21105f" stroke-width="9" stroke-linejoin="round"><path d="M132 218 C36 160 54 58 210 36 C214 142 176 196 132 218Z" fill="#75bd82"/><path d="M132 218 C128 154 146 100 194 55" fill="none" stroke="#fff" stroke-width="8"/><path d="M130 160 L90 120 M151 126 L184 111" fill="none" stroke="#fff" stroke-width="7"/></g>';
  if (/книг|чтен|писател|поэз|литератур|школ|учител/.test(t)) return '<g stroke="#21105f" stroke-width="9" stroke-linejoin="round"><path d="M28 60 Q82 38 132 72 V210 Q82 176 28 194Z" fill="#65b9d4"/><path d="M236 60 Q182 38 132 72 V210 Q182 176 236 194Z" fill="#ef6b59"/><path d="M132 72 V210" fill="none" stroke="#fff"/><path d="M52 92 Q84 82 106 98 M52 124 Q84 114 106 130 M158 98 Q184 82 212 92 M158 130 Q184 114 212 124" fill="none" stroke="#fff" stroke-width="7"/></g>';
  return '<g stroke="#21105f" stroke-width="9" stroke-linejoin="round"><path d="M44 100 L132 48 L220 100 V212 H44Z" fill="#65b9d4"/><path d="M44 100 L132 154 L220 100" fill="#ef6b59"/><path d="M132 48 V154" fill="none" stroke="#fff"/><path d="M132 20 L145 45 L173 49 L153 69 L158 98 L132 84 L106 98 L111 69 L91 49 L119 45Z" fill="#ffcf55"/></g>';
}

async function loadHolidayFont() {
  const fontResponse = await fetchWithTimeout(
    "https://raw.githubusercontent.com/go-flutter-desktop/examples/56920efbce6e92a63689ca549750511c2fe14431/stocks/fonts/Roboto/Roboto-Black.ttf",
    {},
    REQUEST_TIMEOUT_MS,
    "Загрузка шрифта Roboto Black"
  );
  if (!fontResponse.ok) throw new Error("Не удалось загрузить шрифт Roboto Black (HTTP " + fontResponse.status + ").");
  const fontData = await fontResponse.arrayBuffer();
  if (fontData.byteLength < 100000) throw new Error("Файл шрифта Roboto Black повреждён или неполный.");
  return fontData;
}
async function renderHolidayTemplate(template, dateLabel, holidayTitle, illustrationBase64) {
  const { ImageResponse } = await import("workers-og");
  const fontData = await loadHolidayFont();
  const fittedTitle = fitHolidayTitle(holidayTitle);
  const lines = fittedTitle.lines;
  const fontSize = fittedTitle.fontSize;
  const lineHeight = Math.round(fontSize * 1.16);
  const titleMarkup = lines.map((line, index) =>
    '<div style="display:flex;position:absolute;left:778px;top:' + (142 + index * lineHeight) + 'px;width:430px;height:' + lineHeight + 'px;color:#fff;font-family:Roboto Black,sans-serif;font-size:' + fontSize + 'px;font-weight:900;line-height:' + lineHeight + 'px;white-space:nowrap;letter-spacing:-1px">' + escapeHtml(line) + '</div>'
  ).join("");
  // These two shapes exactly rebuild the original flat purple panel and its white circular corner.
  // This clears only the old date/title and old illustration; the left artwork and top-right crest stay untouched.
  const svg = '<svg width="1536" height="765" viewBox="0 0 1536 765" style="position:absolute;left:0;top:0"><path d="M770 20 H1220 V345 H1400 A320 320 0 0 0 1080 665 H770 Z" fill="#1a0b5c"/><path d="M1080 665 A320 320 0 0 1 1400 345 H1516 V765 H1080 Z" fill="#fff"/></svg>';
  const html = '<div style="display:flex;position:relative;width:1536px;height:765px;overflow:hidden;background:#1a0b5c"><img src="data:' + template.mime_type + ';base64,' + template.content_base64 + '" style="position:absolute;left:0;top:0;width:1536px;height:765px;object-fit:fill"/>' +
    svg +
    '<div style="display:flex;position:absolute;left:780px;top:35px;width:425px;height:88px;color:#fff;font-family:Roboto Black,sans-serif;font-size:68px;font-weight:900;line-height:1;white-space:nowrap;letter-spacing:-1px">' + escapeHtml(dateLabel.toLocaleUpperCase("ru")) + '</div>' +
    titleMarkup +
    '<img src="data:image/png;base64,' + illustrationBase64 + '" style="position:absolute;left:1200px;top:430px;width:310px;height:325px;object-fit:contain;object-position:center bottom"/>' +
    '</div>';
  const rendered = new ImageResponse(html, {
    width: 1536,
    height: 765,
    fonts: [{ name: "Roboto Black", data: fontData, weight: 900, style: "normal" }]
  });
  return new Uint8Array(await rendered.arrayBuffer());
}
function escapeHtml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function makeDraft(env, force = false) {
  if (!env.SOVETTG_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID || !env.AI || !env.DB) {
    return { ok: false, stage: "configuration", error: "Не настроены обязательные параметры Worker." };
  }
  await tables(env);
  const template = await env.DB.prepare("SELECT mime_type, content_base64 FROM daily_holiday_assets WHERE key = 'template'").first();
  if (!template || !template.content_base64 || !["image/png", "image/jpeg"].includes(template.mime_type)) {
    return { ok: false, stage: "template", error: "Оригинальный шаблон не найден или повреждён. Черновик не отправлен." };
  }
  const date = localDate();
  const old = await env.DB.prepare("SELECT status, created_at, chat_id, message_id FROM daily_holiday_drafts WHERE date = ?").bind(date).first();
  if (old && ["publishing", "published"].includes(old.status)) {
    return { ok: false, stage: "already-processed", error: old.status === "published"
      ? "Сегодняшняя публикация уже размещена в канале. Повторная публикация заблокирована."
      : "Сегодняшняя публикация сейчас обрабатывается. Повторный запуск заблокирован." };
  }
  if (!force && old && ["pending", "skipped"].includes(old.status)) {
    return { ok: false, stage: "already-processed", error: "Черновик на сегодня уже создан или отклонён. Для повторной подготовки используй /draft." };
  }
  if (force && old && old.status === "pending" && old.message_id) {
    try {
      await tg(env, "editMessageReplyMarkup", {
        chat_id: String(old.chat_id || env.TELEGRAM_ADMIN_ID),
        message_id: old.message_id,
        reply_markup: { inline_keyboard: [] }
      });
    } catch (error) {
      console.warn("Could not disable buttons on replaced daily draft:", error && error.message ? error.message : "unknown error");
    }
  }
  if (!force && old && ["generating", "failed"].includes(old.status) && Date.now() / 1000 - old.created_at < 1800) {
    return { ok: false, stage: "cooldown", error: "Недавно уже была попытка. Для ручной проверки используй /draft." };
  }
  let stage = "calendar";
  await env.DB.prepare("INSERT INTO daily_holiday_drafts (date, chat_id, status, created_at) VALUES (?, ?, 'generating', ?) ON CONFLICT(date) DO UPDATE SET chat_id=excluded.chat_id, message_id=NULL, status='generating', created_at=excluded.created_at")
    .bind(date, String(env.TELEGRAM_ADMIN_ID), Math.floor(Date.now() / 1000)).run();

  try {
    const list = await candidatesFor(date);
    if (!list.length) throw new Error("На сайте календаря не найдены праздники для этой даты.");
    const dateLabel = new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow", day: "numeric", month: "long", year: "numeric", weekday: "long"
    }).format(new Date(date + "T12:00:00+03:00"));
    const prompt = [
      "Ты — автор ТОЛЬКО основной информационной части ежедневной рубрики школьного сообщества «Совет Первых школы № 9».",
      "Дата публикации: " + dateLabel + ". Выбери один позитивный, интересный и уместный для школьников праздник из списка.",
      "Не выбирай политику, войну, трагедии, медицину или спорные темы. Предпочитай образование, культуру, науку, творчество и добрые поводы.",
      "Строго: не пиши приветствие, название рубрики, дату, название праздника, пожелание, подпись, ссылки, хэштеги и источники. Эти элементы добавит программа по неизменному шаблону.",
      "Создай только body: 2 коротких содержательных абзаца на русском (примерно 350–500 знаков суммарно). Первый — история/происхождение или значение праздника; второй — как его отмечают или интересный факт. Не выдумывай факты, используй только сведения из описания. Не добавляй заголовки и эмодзи.",
      "Верни строго JSON с полями: selected_index (индекс события с нуля), body (только два абзаца основного текста), image_prompt (подробный промпт на английском для тематической иллюстрации).",
      "Для маленькой иллюстрации в правом нижнем углу: выразительная праздничная редакционная иллюстрация в стиле ручного рисунка, на чистом белом фоне; без текста, букв, логотипов и водяных знаков.",
      "Список событий: " + JSON.stringify(list)
    ].join("\n");
    stage = "text-ai";
    const answer = await withTimeout(env.AI.run(TEXT_MODEL, {
      messages: [
        { role: "system", content: "Пиши грамотно, не выдумывай факты. Ответ — только JSON." },
        { role: "user", content: prompt }
      ],
      max_completion_tokens: 1200,
      temperature: 0.4,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_object" }
    }), AI_TIMEOUT_MS, "Текстовая AI-модель");
    const generatedText = modelText(answer);
    if (!generatedText.trim()) {
      const shape = answer && typeof answer === "object" ? Object.keys(answer).join(", ") : typeof answer;
      const modelError = answer && (answer.error || answer.message || answer.details);
      throw new Error("Модель вернула пустой текст. Поля ответа: " + (shape || "нет") + (modelError ? "; " + String(modelError).slice(0, 120) : ""));
    }
    const draft = parseObject(generatedText);
    const index = Number(draft.selected_index);
    if (!Number.isInteger(index) || index < 0 || index >= list.length) throw new Error("Invalid selected holiday");
    const chosen = list[index];
    const body = String(draft.body || "").replace(/\r/g, "").split(/\n{2,}/).map(part => part.trim()).filter(Boolean).slice(0, 2).join("\n\n");
    const imagePrompt = String(draft.image_prompt || "").slice(0, 1700);
    if (body.length < 180 || imagePrompt.length < 30) throw new Error("Основной текст праздника неполный. Черновик не отправлен.");
    const dateForPost = new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow", day: "numeric", month: "long"
    }).format(new Date(date + "T12:00:00+03:00"));
    const post = [
      "Доброе утро! ☀️",
      "Наша ежедневная рубрика «Праздник каждый день»!",
      dateForPost,
      chosen.title,
      body,
      "Желаем вам отличного дня! 😊",
      "👉 С1Шк9.Сайт: https://s1sch9.github.io/ | TGK: https://t.me/dvizhenieschool9 | MAX: https://max.ru/join/R9RTsj6Z4VcAem7B3TH7kAKDHbU3Wkm5WuoYiXOxteI"
    ].join("\n\n");
    if (post.length > 1024) throw new Error("Текст по утверждённому шаблону превышает лимит Telegram. Черновик не отправлен.");

    stage = "image-ai";
    const illustrationPrompt = [
      imagePrompt,
      "Create one small standalone corner illustration for a Russian school holiday poster.",
      "Style: warm, polished hand-drawn editorial cartoon with gentle watercolor texture, clean confident outlines and friendly expressive characters.",
      "Background must be pure solid white (#FFFFFF), evenly lit, with no frame, no shadow outside the subject.",
      "No text, no letters, no numbers, no logos, no watermark, no poster layout.",
      "Show only the holiday-related subject, centered, with clear silhouette and enough white margin around it."
    ].join(" ").slice(0, 2048);
    const illustrationResult = await withTimeout(env.AI.run(IMAGE_MODEL, {
      prompt: illustrationPrompt,
      steps: 4
    }), AI_TIMEOUT_MS, "Генерация тематической иллюстрации");
    if (!illustrationResult || typeof illustrationResult.image !== "string" || illustrationResult.image.length < 4000) {
      throw new Error("Модель изображений не вернула готовую иллюстрацию. Черновик не отправлен.");
    }

    stage = "template-render";
    const dateForImage = new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow", day: "numeric", month: "long"
    }).format(new Date(date + "T12:00:00+03:00"));
    const bytes = await withTimeout(
      renderHolidayTemplate(template, dateForImage, chosen.title, illustrationResult.image),
      REQUEST_TIMEOUT_MS,
      "Сборка изображения"
    );
    const keyboard = { inline_keyboard: [[
      { text: "✅ Опубликовать", callback_data: "publish:" + date },
      { text: "✖️ Отклонить", callback_data: "skip:" + date }
    ]] };
    const form = new FormData();
    form.append("chat_id", String(env.TELEGRAM_ADMIN_ID));
    form.append("photo", new Blob([bytes], { type: "image/png" }), "holiday-" + date + ".png");
    form.append("caption", post);
    form.append("reply_markup", JSON.stringify(keyboard));
    stage = "telegram-sendPhoto";
    const sentResponse = await fetchWithTimeout(API + env.SOVETTG_BOT_TOKEN + "/sendPhoto", { method: "POST", body: form }, REQUEST_TIMEOUT_MS, "Отправка черновика в Telegram");
    const sent = await sentResponse.json();
    if (!sentResponse.ok || !sent.ok || !sent.result || !sent.result.message_id) {
      throw new Error("Telegram sendPhoto: " + String(sent.description || sentResponse.status).slice(0, 180));
    }
    await env.DB.prepare("UPDATE daily_holiday_drafts SET message_id = ?, status = 'pending', holiday_title = ?, source_url = ? WHERE date = ?")
      .bind(sent.result.message_id, chosen.title, chosen.url, date).run();
    return { ok: true, title: chosen.title };
  } catch (error) {
    await env.DB.prepare("UPDATE daily_holiday_drafts SET status = 'failed' WHERE date = ?").bind(date).run();
    const detail = String(error && error.message ? error.message : "Неизвестная ошибка").slice(0, 220);
    console.error("Daily post generation failed at " + stage + ":", detail);
    return { ok: false, stage, error: detail };
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

async function saveTemplateFromTelegram(env, msg, adminId) {
  const doc = msg.document;
  const photo = Array.isArray(msg.photo) && msg.photo.length ? msg.photo[msg.photo.length - 1] : null;
  const file = doc || photo;
  if (!file) return false;

  const name = String(doc && doc.file_name || "telegram-template.jpg");
  const extension = /\.(jpe?g|png)$/i.exec(name);
  const reportedSize = Number(file.file_size || 0);
  if (!extension) {
    await tg(env, "sendMessage", { chat_id: adminId, text: "Не удалось распознать формат. Пришли файл с именем, оканчивающимся на .JPG, .JPEG или .PNG." });
    return true;
  }
  if (reportedSize > 900000) {
    await tg(env, "sendMessage", { chat_id: adminId, text: "Файл слишком большой: " + (reportedSize / 1024).toFixed(0) + " КБ. Лимит сейчас 900 КБ. Ничего не сохранено." });
    return true;
  }

  const meta = await tg(env, "getFile", { file_id: file.file_id });
  if (!meta || !meta.file_path) throw new Error("Telegram не вернул путь к файлу шаблона.");
  const response = await fetch("https://api.telegram.org/file/bot" + env.SOVETTG_BOT_TOKEN + "/" + meta.file_path);
  if (!response.ok) throw new Error("Не удалось скачать шаблон из Telegram.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 900000) {
    await tg(env, "sendMessage", { chat_id: adminId, text: "Скачанный файл превышает лимит 900 КБ. Ничего не сохранено." });
    return true;
  }

  const isPng = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!isPng && !isJpeg) {
    await tg(env, "sendMessage", { chat_id: adminId, text: "Файл получен, но его содержимое не распознано как настоящий PNG или JPEG. Шаблон не сохранён." });
    return true;
  }

  const mime = isPng ? "image/png" : "image/jpeg";
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const base64 = btoa(binary);
  await env.DB.prepare("INSERT INTO daily_holiday_assets (key, mime_type, file_name, content_base64, updated_at) VALUES ('template', ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET mime_type=excluded.mime_type, file_name=excluded.file_name, content_base64=excluded.content_base64, updated_at=excluded.updated_at")
    .bind(mime, name, base64, Math.floor(Date.now() / 1000)).run();
  await tg(env, "sendMessage", { chat_id: adminId, text: "✅ Оригинальный шаблон получен и сохранён без сжатия. Теперь можно собирать публикации на его основе. Сам шаблон не буду перерисовывать." });
  return true;
}

async function processUpdate(env, item, adminId) {
  if (item.callback_query) return callback(env, item, adminId);
  const msg = item.message;
  if (!msg || !msg.chat || msg.chat.type !== "private" || String(msg.chat.id) !== adminId || String(msg.from && msg.from.id) !== adminId) return;
  if (msg.document || msg.photo) { await saveTemplateFromTelegram(env, msg, adminId); return; }
  const text = String(msg.text || "").trim().toLowerCase();
  if (text === "/template") {
    await tables(env);
    const asset = await env.DB.prepare("SELECT mime_type, file_name, content_base64 FROM daily_holiday_assets WHERE key = 'template'").first();
    if (!asset || !asset.content_base64) {
      await tg(env, "sendMessage", { chat_id: adminId, text: "Сохранённый шаблон не найден." });
      return;
    }
    const binary = atob(asset.content_base64);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    const form = new FormData();
    form.append("chat_id", adminId);
    form.append("document", new Blob([bytes], { type: asset.mime_type }), asset.file_name || "IMG_4517.PNG");
    const response = await fetch(API + env.SOVETTG_BOT_TOKEN + "/sendDocument", { method: "POST", body: form });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error("Не удалось отправить сохранённый шаблон из хранилища.");
    await tg(env, "sendMessage", { chat_id: adminId, text: "Вот точная копия сохранённого оригинала. Отправь этот файл сюда в ChatGPT, чтобы я мог измерить области макета." });
    return;
  }
  if (text === "/status" || text === "/status@" + String(env.SOVETTG_BOT_USERNAME || "").toLowerCase()) {
    await tables(env);
    const date = localDate();
    const queued = await env.DB.prepare("SELECT value FROM daily_holiday_state WHERE key = 'manual_draft_requested'").first();
    const row = await env.DB.prepare("SELECT status, created_at, holiday_title, message_id FROM daily_holiday_drafts WHERE date = ?").bind(date).first();
    let statusText;
    if (queued && queued.value === date) {
      statusText = "⏳ Запрос на подготовку черновика принят и ожидает фонового запуска.\nДата: " + date;
    } else if (queued && queued.value === "processing:" + date) {
      statusText = "⏳ Черновик сейчас готовится в фоновой задаче.\nДата: " + date;
    } else if (!row) {
      statusText = "ℹ️ На сегодня (" + date + ") черновик ещё не запускался.";
    } else {
      const age = Math.max(0, Math.floor(Date.now() / 1000) - Number(row.created_at || 0));
      const minutes = Math.floor(age / 60);
      const elapsed = minutes ? minutes + " мин. назад" : age + " сек. назад";
      const states = {
        generating: "⏳ Черновик сейчас готовится.",
        pending: "✅ Черновик отправлен тебе и ожидает решения. В канал ничего не публиковалось.",
        skipped: "✖️ Черновик отклонён. В канал ничего не публиковалось.",
        published: "📣 Черновик уже опубликован в канале.",
        publishing: "⏳ Идёт публикация в канал.",
        failed: "⚠️ Последняя попытка завершилась ошибкой. Можно будет повторить после проверки."
      };
      statusText = (states[row.status] || "ℹ️ Статус: " + row.status) + "\nДата: " + date + "\nПоследнее изменение: " + elapsed;
      if (row.holiday_title) statusText += "\nПраздник: " + row.holiday_title;
      if (row.status === "pending" && row.message_id) statusText += "\nКнопки «Опубликовать» и «Отклонить» находятся в сообщении с черновиком.";
      if (row.status === "generating" && age > 120) statusText += "\n⚠️ Подготовка длится необычно долго. Не запускай повторно, пока не проверим состояние.";
    }
    await tg(env, "sendMessage", { chat_id: adminId, text: statusText });
    return;
  }
  if (text === "/draft" || text.startsWith("/draft@")) {
    await tables(env);
    const date = localDate();
    const current = await env.DB.prepare("SELECT value FROM daily_holiday_state WHERE key = 'manual_draft_requested'").first();
    if (current && current.value) {
      await tg(env, "sendMessage", { chat_id: adminId, text: "⏳ Запрос на подготовку уже стоит в очереди. Повторно запускать не нужно." });
      return;
    }
    await env.DB.prepare("INSERT INTO daily_holiday_state (key, value) VALUES ('manual_draft_requested', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(date).run();
    await tg(env, "sendMessage", {
      chat_id: adminId,
      text: "⏳ Запрос принят. Подготовка запущена в фоновой задаче — она не зависит от времени жизни Telegram webhook. Я пришлю отдельное сообщение, когда черновик будет готов или если возникнет ошибка."
    });
    return;
  }
  if (text === "/start" || text === "/help") {
    await tg(env, "sendMessage", {
      chat_id: adminId,
      text: "💙 Это отдельный бот рубрики «Праздник каждый день». Каждый день здесь будет появляться готовый пост с картинкой. В канал он попадёт только после нажатия «Опубликовать».\n\nДля ручной проверки отправь /draft — бот подготовит черновик на сегодня."
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

export async function dailyWebhookPath(env) {
  const token = String(env && env.SOVETTG_BOT_TOKEN || "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const key = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return "/telegram/daily/" + key;
}

export async function handleDailyWebhook(request, env, context) {
  if (!env || !env.SOVETTG_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID || !env.DB) return new Response("Service unavailable", { status: 503 });
  if (new URL(request.url).pathname !== await dailyWebhookPath(env)) return new Response("Not found", { status: 404 });
  let update;
  try { update = await request.json(); } catch { return new Response("Bad request", { status: 400 }); }
  if (!update || !Number.isSafeInteger(update.update_id)) return new Response("OK");
  const task = (async () => {
    await tables(env);
    const inserted = await env.DB.prepare("INSERT OR IGNORE INTO daily_holiday_updates (update_id, created_at) VALUES (?, ?)").bind(update.update_id, Math.floor(Date.now() / 1000)).run();
    if (!inserted.meta || !inserted.meta.changes) return;
    try { await processUpdate(env, update, String(env.TELEGRAM_ADMIN_ID)); }
    catch (error) {
      const detail = String(error && error.message ? error.message : "unknown error").slice(0, 180);
      console.error("Daily webhook update failed:", detail);
      if (update.message && update.message.chat && String(update.message.chat.id) === String(env.TELEGRAM_ADMIN_ID)) {
        try { await tg(env, "sendMessage", { chat_id: String(env.TELEGRAM_ADMIN_ID), text: "⚠️ Не удалось обработать команду: " + detail }); } catch {}
      }
    }
  })();
  if (context && typeof context.waitUntil === "function") context.waitUntil(task); else await task;
  return new Response("OK");
}

export async function runDailyHolidayCron(controller, env) {
  if (!env || !env.SOVETTG_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID || !env.DB) return;
  await tables(env);

  // Manual requests run from the scheduled Worker invocation, not from
  // webhook waitUntil (whose lifetime is too short for image generation).
  const queued = await env.DB.prepare("SELECT value FROM daily_holiday_state WHERE key = 'manual_draft_requested'").first();
  if (queued && queued.value && /^\d{4}-\d{2}-\d{2}$/.test(queued.value)) {
    const date = queued.value;
    const lock = await env.DB.prepare("UPDATE daily_holiday_state SET value = ? WHERE key = 'manual_draft_requested' AND value = ?")
      .bind("processing:" + date, date).run();
    if (lock.meta && lock.meta.changes) {
      let result;
      try {
        result = await makeDraft(env, true);
        let message = result && result.ok
          ? "✅ Черновик готов и отправлен выше. Проверь текст и картинку — в канал он попадёт только после нажатия «Опубликовать»."
          : result && result.stage === "already-processed"
            ? "ℹ️ Сегодняшний черновик уже обработан. Повторная отправка не выполнялась."
            : "⚠️ Не удалось подготовить черновик" + (result && result.stage ? " на этапе «" + result.stage + "»" : "") + ": " + String(result && result.error || "неизвестная ошибка").slice(0, 220) + "\nВ канал ничего не публиковалось.";
        await tg(env, "sendMessage", { chat_id: String(env.TELEGRAM_ADMIN_ID), text: message });
      } catch (error) {
        const detail = String(error && error.message ? error.message : "unknown error").slice(0, 180);
        console.error("Manual daily draft job failed:", detail);
        try {
          await tg(env, "sendMessage", { chat_id: String(env.TELEGRAM_ADMIN_ID), text: "⚠️ Фоновая подготовка черновика завершилась ошибкой: " + detail + "\nВ канал ничего не публиковалось." });
        } catch {}
      } finally {
        await env.DB.prepare("DELETE FROM daily_holiday_state WHERE key = 'manual_draft_requested' AND value = ?")
          .bind("processing:" + date).run();
      }
    }
  }

  if (controller && controller.cron === DAILY_CRON) await makeDraft(env);
}

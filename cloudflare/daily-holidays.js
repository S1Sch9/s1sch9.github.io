import { handleSocialUpdate, processQueuedSocialPhotos } from "./social-publisher.js";

const API = "https://api.telegram.org/bot";
const CHANNEL = "@dvizhenieschool9";
const TEXT_MODEL = "@cf/google/gemma-4-26b-a4b-it";
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const POLL_CRON = "* * * * *";
const DAILY_DRAFT_HOUR = 17;
const REQUEST_TIMEOUT_MS = 25000;
const AI_TIMEOUT_MS = 45000;

function dailyMenuMarkup() {
  return {
    keyboard: [
      [{ text: "📝 Создать черновик" }],
      [{ text: "✍️ Публикация" }],
      [{ text: "📊 Проверить статус" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Выбери действие"
  };
}

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
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS daily_holiday_drafts (date TEXT PRIMARY KEY, chat_id TEXT NOT NULL, message_id INTEGER, status TEXT NOT NULL, holiday_title TEXT NOT NULL DEFAULT '', source_url TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, published_at INTEGER)").run();
  try { await env.DB.prepare("ALTER TABLE daily_holiday_drafts ADD COLUMN published_at INTEGER").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE daily_holiday_drafts ADD COLUMN scheduled_publish_at INTEGER").run(); } catch {}
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

function moscowTimestamp(date, hour, minute = 0) {
  const [year, month, day] = date.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day, hour - 3, minute, 0) / 1000);
}

function moscowTimeParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(now);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function shiftDate(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return value.getUTCFullYear() + "-" +
    String(value.getUTCMonth() + 1).padStart(2, "0") + "-" +
    String(value.getUTCDate()).padStart(2, "0");
}

function validIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function parseDateInput(value) {
  const input = String(value || "").trim();
  let match = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    const date = match[1] + "-" + match[2].padStart(2, "0") + "-" + match[3].padStart(2, "0");
    return validIsoDate(date) ? date : null;
  }
  match = input.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
  if (!match) return null;
  const date = match[3] + "-" + match[2].padStart(2, "0") + "-" + match[1].padStart(2, "0");
  return validIsoDate(date) ? date : null;
}

function formatHolidayDate(date) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow", day: "numeric", month: "long", year: "numeric"
  }).format(new Date(date + "T12:00:00+03:00"));
}

async function queueManualDraft(env, adminId, date) {
  await tables(env);
  if (!validIsoDate(date)) {
    await tg(env, "sendMessage", {
      chat_id: adminId,
      text: "⚠️ Можно выбрать сегодняшнюю или будущую дату. Проверь дату и попробуй ещё раз.",
      reply_markup: dailyMenuMarkup()
    });
    return { ok: false, reason: "invalid-date" };
  }
  const existing = await env.DB.prepare("SELECT status FROM daily_holiday_drafts WHERE date = ?").bind(date).first();
  if (existing && existing.status === "publishing") {
    await tg(env, "sendMessage", {
      chat_id: adminId,
      text: "ℹ️ На " + formatHolidayDate(date) + " публикация уже размещена или сейчас публикуется. Повторная генерация не запущена.",
      reply_markup: dailyMenuMarkup()
    });
    return { ok: false, reason: "already-published" };
  }
  const lock = await env.DB.prepare("INSERT INTO daily_holiday_state (key, value) VALUES ('manual_draft_requested', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE daily_holiday_state.value = ''")
    .bind(date).run();
  if (!lock.meta || !lock.meta.changes) {
    await tg(env, "sendMessage", {
      chat_id: adminId,
      text: "⏳ Сейчас уже обрабатывается другой запрос. Дождись готового черновика, затем можно выбрать следующую дату.",
      reply_markup: dailyMenuMarkup()
    });
    return { ok: false, reason: "busy" };
  }
  const statusMessage = await tg(env, "sendMessage", {
    chat_id: adminId,
    text: "⏳ Запрос принят. Готовлю черновик на " + formatHolidayDate(date) + ".\n\n📅 Сейчас начну подготовку — буду показывать этапы здесь. В канал пост попадёт только после твоего нажатия «Опубликовать».",
    reply_markup: dailyMenuMarkup()
  });
  if (statusMessage && statusMessage.message_id) {
    await env.DB.prepare("INSERT INTO daily_holiday_state (key, value) VALUES ('manual_draft_status_message_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(String(statusMessage.message_id)).run();
  }
  return { ok: true, date };
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
async function holidayBrandAsset(url) {
  const response = await fetchWithTimeout(url, {}, REQUEST_TIMEOUT_MS, "Загрузка фирменного логотипа");
  if (!response.ok) throw new Error("Не удалось загрузить оригинальный логотип Совета.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 500000) throw new Error("Файл логотипа повреждён или слишком большой.");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return "data:" + (response.headers.get("content-type") || "image/png") + ";base64," + btoa(binary);
}

async function renderHolidayTemplate(template, dateLabel, holidayTitle, illustrationBase64, bodyText = "") {
  const councilLogo = await holidayBrandAsset("https://s1sch9.github.io/official-logo.svg");
  const schoolCrest = await holidayBrandAsset("https://s1sch9.github.io/gerb.png");
  const { ImageResponse } = await import("workers-og");
  const fontData = await loadHolidayFont();
  const fittedTitle = fitHolidayTitle(holidayTitle);
  const lines = fittedTitle.lines;
  const fontSize = Math.min(66, fittedTitle.fontSize);
  const lineHeight = Math.round(fontSize * 1.12);
  const dateText = String(dateLabel || "").toLocaleUpperCase("ru");
  const safeBody = escapeHtml(bodyText || "");
  const titleMarkup = lines.map((line, index) =>
    '<div style="display:flex;position:absolute;left:78px;top:' + (290 + index * lineHeight) + 'px;width:680px;height:' + lineHeight + 'px;color:#1a0b5c;font-family:Roboto Black,sans-serif;font-size:' + fontSize + 'px;font-weight:900;line-height:' + lineHeight + 'px;white-space:nowrap;letter-spacing:-1px">' + escapeHtml(line) + '</div>'
  ).join("");
  const html =
    '<div style="display:flex;position:relative;width:1536px;height:765px;overflow:hidden;background:#fff;font-family:Arial,sans-serif">' +
      '<div style="display:flex;position:absolute;left:-150px;bottom:-210px;width:470px;height:470px;border-radius:50%;background:rgba(26,11,92,.035)"></div>' +
      '<div style="display:flex;position:absolute;right:-130px;top:-190px;width:430px;height:430px;border-radius:50%;background:rgba(26,11,92,.035)"></div>' +
      '<div style="display:flex;position:absolute;left:34px;top:28px;width:1468px;height:709px;border:5px solid #1a0b5c;border-radius:34px;box-sizing:border-box"></div>' +
      '<div style="display:flex;position:absolute;left:72px;top:62px;width:700px;height:142px;align-items:center">' +
        '<img src="' + councilLogo + '" style="display:flex;width:112px;height:112px;object-fit:contain;margin-right:22px"/>' +
        '<img src="' + schoolCrest + '" style="display:flex;width:112px;height:112px;object-fit:contain;margin-right:24px"/>' +
        '<div style="display:flex;flex-direction:column;gap:8px"><div style="display:flex;font-size:34px;font-weight:900;color:#1a0b5c">СОВЕТ ПЕРВЫХ</div><div style="display:flex;font-size:26px;font-weight:700;color:#51477a">ШКОЛЫ №9</div></div>' +
      '</div>' +
      '<div style="display:flex;position:absolute;left:790px;top:88px;width:650px;height:74px;align-items:center;justify-content:flex-end;color:#1a0b5c;font-family:Roboto Black,sans-serif;font-size:34px;font-weight:900;text-align:right">' + escapeHtml(dateText) + '</div>' +
      '<div style="display:flex;position:absolute;left:80px;top:228px;width:650px;height:48px;align-items:center;color:#655b91;font-size:26px;font-weight:800;letter-spacing:1px">ПРАЗДНИК КАЖДЫЙ ДЕНЬ</div>' +
      titleMarkup +
      '<div style="display:flex;position:absolute;left:82px;top:545px;width:660px;height:118px;overflow:hidden;color:#40395d;font-size:24px;line-height:1.35">' + safeBody + '</div>' +
      '<div style="display:flex;position:absolute;left:830px;top:198px;width:590px;height:450px;align-items:center;justify-content:center;background:#fff;border:5px solid #1a0b5c;border-radius:34px;padding:18px;box-sizing:border-box;box-shadow:0 16px 40px rgba(26,11,92,.10)">' +
        '<img src="data:image/jpeg;charset=utf-8;base64,' + illustrationBase64 + '" style="display:flex;width:100%;height:100%;object-fit:contain;border-radius:22px"/>' +
      '</div>' +
      '<div style="display:flex;position:absolute;left:840px;top:672px;width:570px;height:36px;align-items:center;justify-content:flex-end;color:#655b91;font-size:20px;font-weight:700">СОВЕТ ПЕРВЫХ ШКОЛЫ №9</div>' +
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

async function makeDraft(env, force = false, requestedDate = null, onProgress = null) {
  if (!env.SOVETTG_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID || !env.AI || !env.DB) {
    return { ok: false, stage: "configuration", error: "Не настроены обязательные параметры Worker." };
  }
  await tables(env);
  const date = requestedDate || localDate();
  if (!validIsoDate(date)) return { ok: false, stage: "date", error: "Выбрана некорректная или прошедшая дата." };
  const old = await env.DB.prepare("SELECT status, created_at, chat_id, message_id FROM daily_holiday_drafts WHERE date = ?").bind(date).first();
  if (old && old.status === "publishing") {
    return { ok: false, stage: "already-processed", error: "Публикация на выбранную дату сейчас обрабатывается. Повторный запуск заблокирован." };
  }
  if (old && ["scheduled", "published", "publishing"].includes(old.status)) {
    return { ok: false, stage: "already-processed", error: "На выбранную дату публикация уже одобрена, запланирована или опубликована. Повторная генерация заблокирована." };
  }
  if (!force && old && ["pending", "skipped"].includes(old.status)) {
    return { ok: false, stage: "already-processed", error: "Черновик на выбранную дату уже создан или отклонён. Для повторной подготовки выбери эту дату в меню ещё раз." };
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
  if (onProgress) await onProgress(stage);
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
      "Верни строго JSON с полями: selected_index (индекс события с нуля), body (только два абзаца основного текста), image_prompt (короткое описание только предмета/персонажа/действия иллюстрации на английском; не описывай стиль, технику, фон, освещение или реализм).",
      "Для image_prompt опиши только конкретный предмет, персонажа или действие, связанное с праздником. Стиль и белый фон будут заданы отдельно программой.",
      "Список событий: " + JSON.stringify(list)
    ].join("\n");
    stage = "text-ai";
    if (onProgress) await onProgress(stage);
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
    const imagePrompt = String(draft.image_prompt || "").slice(0, 700);
    if (body.length < 180 || imagePrompt.length < 30) throw new Error("Основной текст праздника неполный. Черновик не отправлен.");
    const dateForPost = new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow", day: "numeric", month: "long"
    }).format(new Date(date + "T12:00:00+03:00"));
    const footerPlain = "👉 С1Шк9.Сайт | TGK | MAX";
    const post = [
      "Доброе утро! ☀️",
      "Наша ежедневная рубрика «Праздник каждый день»!",
      dateForPost + "\n" + chosen.title,
      body,
      "Желаем вам отличного дня! 😊",
      footerPlain
    ].join("\n\n");
    if (post.length > 1024) throw new Error("Текст по утверждённому шаблону превышает лимит Telegram. Черновик не отправлен.");
    const postHtml = [
      escapeHtml("Доброе утро! ☀️"),
      escapeHtml("Наша ежедневная рубрика «Праздник каждый день»!"),
      escapeHtml(dateForPost + "\n" + chosen.title),
      escapeHtml(body),
      escapeHtml("Желаем вам отличного дня! 😊"),
      '👉 <a href="https://s1sch9.github.io/">С1Шк9.Сайт</a> | <a href="https://t.me/dvizhenieschool9">TGK</a> | <a href="https://max.ru/join/R9RTsj6Z4VcAem7B3TH7kAKDHbU3Wkm5WuoYiXOxteI">MAX</a>'
    ].join("\n\n");

    stage = "image-ai";
    if (onProgress) await onProgress(stage);
    const illustrationPrompt = [
      "Create one small standalone illustration for the lower-right white circle of a Russian school holiday poster.",
      "LOCKED ART STYLE: friendly flat 2D hand-drawn cartoon, like a warm illustrated school storybook: simple rounded shapes, clean confident dark-purple outlines, solid cheerful color fills, minimal soft shading, slightly playful proportions and expressive friendly details.",
      "It must look unmistakably DRAWN and ILLUSTRATED, not like a photograph. Keep the same simple cartoon visual language for every holiday so the series looks consistent.",
      "Holiday subject: " + imagePrompt,
      "COMPOSITION: one compact centered subject, fully visible, with generous pure-white empty margin on every side. Keep all important parts well away from the image edges; nothing may touch or cross the edge.",
      "BACKGROUND: perfectly clean solid white (#FFFFFF), no frame, no border, no cast shadow outside the subject.",
      "STRICTLY AVOID: photorealism, realistic photography, 3D render, realistic skin or material textures, cinematic lighting, gradients, glossy effects, watercolor realism, text, letters, numbers, logos, watermarks, poster layout."
    ].join(" ").slice(0, 2048);
    const illustrationResult = await withTimeout(env.AI.run(IMAGE_MODEL, {
      prompt: illustrationPrompt,
      steps: 4
    }), AI_TIMEOUT_MS, "Генерация тематической иллюстрации");
    if (!illustrationResult || typeof illustrationResult.image !== "string" || illustrationResult.image.length < 4000) {
      throw new Error("Модель изображений не вернула готовую иллюстрацию. Черновик не отправлен.");
    }
    const illustrationBase64 = illustrationResult.image.replace(/\s/g, "");
    if (!illustrationBase64.startsWith("/9j/")) {
      throw new Error("Иллюстрация пришла не в ожидаемом JPEG-формате. Черновик не отправлен.");
    }

    stage = "template-render";
    if (onProgress) await onProgress(stage);
    const dateForImage = new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow", day: "numeric", month: "long"
    }).format(new Date(date + "T12:00:00+03:00"));
    const bytes = await withTimeout(
      renderHolidayTemplate(null, dateForImage, chosen.title, illustrationBase64, body),
      REQUEST_TIMEOUT_MS,
      "Сборка изображения"
    );
    const keyboard = { inline_keyboard: [
      [{ text: "✅ Опубликовать сейчас", callback_data: "publish:" + date }],
      [{ text: "🕒 Выложить позже", callback_data: "schedule:" + date }],
      [{ text: "🔄 Переделать картинку", callback_data: "redoimage:" + date }],
      [{ text: "✖️ Отклонить", callback_data: "skip:" + date }]
    ] };
    const form = new FormData();
    form.append("chat_id", String(env.TELEGRAM_ADMIN_ID));
    form.append("photo", new Blob([bytes], { type: "image/png" }), "holiday-" + date + ".png");
    form.append("caption", postHtml);
    form.append("parse_mode", "HTML");
    form.append("reply_markup", JSON.stringify(keyboard));
    stage = "telegram-sendPhoto";
    if (onProgress) await onProgress(stage);
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
  const draftChoice = String(q.data || "").match(/^draft:(today|tomorrow|custom|cancel)$/);
  if (draftChoice) {
    const choice = draftChoice[1];
    if (choice === "custom") {
      await env.DB.prepare("INSERT INTO daily_holiday_state (key, value) VALUES ('awaiting_custom_date', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
      await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Жду дату." });
      await tg(env, "sendMessage", {
        chat_id: adminId,
        text: "📅 Напиши дату, на которую подготовить публикацию.\n\nПодойдут форматы 25.12.2026 или 2026-12-25. Можно выбрать сегодня или любую будущую дату.",
        reply_markup: dailyMenuMarkup()
      });
      return;
    }
    if (choice === "cancel") {
      await env.DB.prepare("DELETE FROM daily_holiday_state WHERE key = 'awaiting_custom_date'").run();
      await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Выбор отменён." });
      await tg(env, "sendMessage", { chat_id: adminId, text: "Хорошо, ничего не запускаю.", reply_markup: dailyMenuMarkup() });
      return;
    }
    const date = choice === "tomorrow" ? shiftDate(localDate(), 1) : localDate();
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Запускаю подготовку." });
    await queueManualDraft(env, adminId, date);
    return;
  }
  const match = String(q.data || "").match(/^(publish|skip|schedule|redoimage):(\d{4}-\d{2}-\d{2})$/);
  if (!match) {
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Неизвестное действие." });
    return;
  }
  const action = match[1], date = match[2];
  const row = await env.DB.prepare("SELECT chat_id, message_id, status, published_at, holiday_title FROM daily_holiday_drafts WHERE date = ?").bind(date).first();
  if (!row || row.status !== "pending" || String(row.chat_id) !== adminId || !row.message_id) {
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Черновик уже обработан." });
    return;
  }
  if (action === "publish" && row.published_at) {
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "На эту дату публикация уже была размещена. Новый черновик создан, но повторно публиковать его нельзя.", show_alert: true });
    return;
  }
  if (action === "schedule") {
    await env.DB.prepare("INSERT INTO daily_holiday_state (key, value) VALUES ('awaiting_publish_time', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(date).run();
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Настраиваем время публикации." });
    await tg(env, "sendMessage", { chat_id: adminId, text: "🕒 На какое время по Москве запланировать публикацию на " + formatHolidayDate(date) + "?\n\nНапиши время в формате ЧЧ:ММ, например 08:30 или 19:15.\n\nМожно написать «отмена».", reply_markup: dailyMenuMarkup() });
    return;
  }
  if (action === "redoimage") {
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Создаю новую картинку. Текст и шаблон не меняю." });
    try {
      const title = String(row.holiday_title || "Праздник");
      const prompt = "Create a fresh small standalone friendly flat 2D hand-drawn cartoon illustration for the lower-right white circle of a Russian school holiday poster. Warm school storybook style, rounded shapes, confident dark-purple outlines, solid cheerful colors, minimal soft shading. Holiday subject: " + title + ". Make a different visual interpretation. One compact centered fully visible subject, pure white background, generous white margins. No text, letters, numbers, logos, watermarks, poster layout, gradients, photorealism or 3D.";
      const result = await withTimeout(env.AI.run(IMAGE_MODEL, { prompt: prompt.slice(0, 1800), steps: 4 }), AI_TIMEOUT_MS, "Генерация новой иллюстрации");
      if (!result || typeof result.image !== "string" || result.image.length < 4000) throw new Error("Модель не вернула готовую иллюстрацию.");
      const imageBase64 = result.image.replace(/\s/g, "");
      if (!imageBase64.startsWith("/9j/")) throw new Error("Иллюстрация пришла не в JPEG-формате.");
      const dateLabel = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long" }).format(new Date(date + "T12:00:00+03:00"));
      const bytes = await withTimeout(renderHolidayTemplate(template, dateLabel, title, imageBase64), REQUEST_TIMEOUT_MS, "Сборка изображения");
      const form = new FormData();
      form.append("chat_id", adminId);
      form.append("message_id", String(row.message_id));
      form.append("media", JSON.stringify({ type: "photo", media: "attach://photo", caption: String(q.message.caption || ""), parse_mode: "HTML" }));
      form.append("photo", new Blob([bytes], { type: "image/png" }), "holiday-" + date + "-new.png");
      form.append("reply_markup", JSON.stringify({ inline_keyboard: [
        [{ text: "✅ Опубликовать сейчас", callback_data: "publish:" + date }],
        [{ text: "🕒 Выложить позже", callback_data: "schedule:" + date }],
        [{ text: "🔄 Переделать картинку", callback_data: "redoimage:" + date }],
        [{ text: "✖️ Отклонить", callback_data: "skip:" + date }]
      ] }));
      const response = await fetchWithTimeout(API + env.SOVETTG_BOT_TOKEN + "/editMessageMedia", { method: "POST", body: form }, REQUEST_TIMEOUT_MS, "Замена изображения в черновике");
      const edited = await response.json();
      if (!response.ok || !edited.ok) throw new Error("Telegram не смог заменить изображение: " + String(edited.description || response.status).slice(0, 150));
      await tg(env, "sendMessage", { chat_id: adminId, text: "✅ Готово! Картинка заменена. Текст и исходный шаблон оставлены без изменений.", reply_markup: dailyMenuMarkup() });
    } catch (error) {
      await tg(env, "sendMessage", { chat_id: adminId, text: "⚠️ Не получилось переделать картинку: " + String(error && error.message || "неизвестная ошибка").slice(0, 200) + "\nСтарый черновик и его изображение сохранены.", reply_markup: dailyMenuMarkup() });
    }
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
    await env.DB.prepare("UPDATE daily_holiday_drafts SET status = 'published', published_at = COALESCE(published_at, ?), scheduled_publish_at = NULL WHERE date = ?").bind(Math.floor(Date.now() / 1000), date).run();
  } catch (error) {
    await env.DB.prepare("UPDATE daily_holiday_drafts SET status = 'pending' WHERE date = ? AND status = 'publishing'").bind(date).run();
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Ошибка публикации. Черновик сохранён." });
    throw error;
  }
  try { await tg(env, "editMessageReplyMarkup", { chat_id: adminId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }); } catch {}
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
    await tg(env, "sendMessage", { chat_id: adminId, text: "Не удалось распознать формат. Пришли файл с именем, оканчивающимся на .JPG, .JPEG или .PNG.", reply_markup: dailyMenuMarkup() });
    return true;
  }
  if (reportedSize > 900000) {
    await tg(env, "sendMessage", { chat_id: adminId, text: "Файл слишком большой: " + (reportedSize / 1024).toFixed(0) + " КБ. Лимит сейчас 900 КБ. Ничего не сохранено.", reply_markup: dailyMenuMarkup() });
    return true;
  }

  const meta = await tg(env, "getFile", { file_id: file.file_id });
  if (!meta || !meta.file_path) throw new Error("Telegram не вернул путь к файлу шаблона.");
  const response = await fetch("https://api.telegram.org/file/bot" + env.SOVETTG_BOT_TOKEN + "/" + meta.file_path);
  if (!response.ok) throw new Error("Не удалось скачать шаблон из Telegram.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 900000) {
    await tg(env, "sendMessage", { chat_id: adminId, text: "Скачанный файл превышает лимит 900 КБ. Ничего не сохранено.", reply_markup: dailyMenuMarkup() });
    return true;
  }

  const isPng = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!isPng && !isJpeg) {
    await tg(env, "sendMessage", { chat_id: adminId, text: "Файл получен, но его содержимое не распознано как настоящий PNG или JPEG. Шаблон не сохранён.", reply_markup: dailyMenuMarkup() });
    return true;
  }

  const mime = isPng ? "image/png" : "image/jpeg";
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const base64 = btoa(binary);
  await env.DB.prepare("INSERT INTO daily_holiday_assets (key, mime_type, file_name, content_base64, updated_at) VALUES ('template', ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET mime_type=excluded.mime_type, file_name=excluded.file_name, content_base64=excluded.content_base64, updated_at=excluded.updated_at")
    .bind(mime, name, base64, Math.floor(Date.now() / 1000)).run();
  await tg(env, "sendMessage", { chat_id: adminId, text: "✅ Оригинальный шаблон получен и сохранён без сжатия. Теперь можно собирать публикации на его основе. Сам шаблон не буду перерисовывать.", reply_markup: dailyMenuMarkup() });
  return true;
}

async function processUpdate(env, item, adminId) {
  if (await handleSocialUpdate(env, item, adminId)) return;
  if (item.callback_query) return callback(env, item, adminId);
  const msg = item.message;
  if (!msg || !msg.chat || msg.chat.type !== "private" || String(msg.chat.id) !== adminId || String(msg.from && msg.from.id) !== adminId) return;
  if (msg.document || msg.photo) { await saveTemplateFromTelegram(env, msg, adminId); return; }
  const incomingText = String(msg.text || "").trim();
  const normalizedIncoming = incomingText.toLocaleLowerCase("ru");
  const text = ({
    "📊 проверить статус": "/status",
    "🖼 оригинальный шаблон": "/template",
    "ℹ️ помощь": "/help"
  }[normalizedIncoming] || incomingText).toLowerCase();

  const waitingForPublishTime = await env.DB.prepare("SELECT value FROM daily_holiday_state WHERE key = 'awaiting_publish_time'").first();
  if (waitingForPublishTime && /^\d{4}-\d{2}-\d{2}$/.test(waitingForPublishTime.value || "")) {
    const scheduleDate = waitingForPublishTime.value;
    if (normalizedIncoming === "отмена" || normalizedIncoming === "↩️ отмена" || text === "/cancel") {
      await env.DB.prepare("DELETE FROM daily_holiday_state WHERE key = 'awaiting_publish_time'").run();
      await tg(env, "sendMessage", { chat_id: adminId, text: "Настройка отложенной публикации отменена. Черновик остался без изменений.", reply_markup: dailyMenuMarkup() });
      return;
    }
    const tm = incomingText.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (!tm) {
      await tg(env, "sendMessage", { chat_id: adminId, text: "⚠️ Не распознал время. Напиши ЧЧ:ММ, например 08:30, или «отмена».", reply_markup: dailyMenuMarkup() });
      return;
    }
    const publishAt = moscowTimestamp(scheduleDate, Number(tm[1]), Number(tm[2]));
    if (publishAt <= Math.floor(Date.now() / 1000) + 30) {
      await tg(env, "sendMessage", { chat_id: adminId, text: "⚠️ Это время уже прошло. Укажи будущее время по Москве.", reply_markup: dailyMenuMarkup() });
      return;
    }
    const draftRow = await env.DB.prepare("SELECT message_id, status FROM daily_holiday_drafts WHERE date = ? AND chat_id = ?").bind(scheduleDate, adminId).first();
    if (!draftRow || draftRow.status !== "pending" || !draftRow.message_id) {
      await env.DB.prepare("DELETE FROM daily_holiday_state WHERE key = 'awaiting_publish_time'").run();
      await tg(env, "sendMessage", { chat_id: adminId, text: "⚠️ Этот черновик уже обработан или не найден.", reply_markup: dailyMenuMarkup() });
      return;
    }
    const saved = await env.DB.prepare("UPDATE daily_holiday_drafts SET status = 'scheduled', scheduled_publish_at = ? WHERE date = ? AND status = 'pending'").bind(publishAt, scheduleDate).run();
    if (!saved.meta || !saved.meta.changes) {
      await tg(env, "sendMessage", { chat_id: adminId, text: "⚠️ Не удалось сохранить расписание. Попробуй ещё раз.", reply_markup: dailyMenuMarkup() });
      return;
    }
    await env.DB.prepare("DELETE FROM daily_holiday_state WHERE key = 'awaiting_publish_time'").run();
    try { await tg(env, "editMessageReplyMarkup", { chat_id: adminId, message_id: draftRow.message_id, reply_markup: { inline_keyboard: [] } }); } catch {}
    const label = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(publishAt * 1000));
    await tg(env, "sendMessage", { chat_id: adminId, text: "✅ Отложенная публикация настроена!\n\n📅 Дата: " + formatHolidayDate(scheduleDate) + "\n🕒 Время: " + label + " по Москве.\n\nБот автоматически опубликует именно этот текст и изображение.", reply_markup: dailyMenuMarkup() });
    return;
  }

  const waitingForDate = await env.DB.prepare("SELECT value FROM daily_holiday_state WHERE key = 'awaiting_custom_date'").first();
  if (waitingForDate && waitingForDate.value === "1") {
    const isMenuAction = ["📝 создать черновик", "📊 проверить статус", "🖼 оригинальный шаблон", "ℹ️ помощь"].includes(normalizedIncoming);
    if (text === "/cancel" || normalizedIncoming === "отмена" || normalizedIncoming === "↩️ отмена") {
      await env.DB.prepare("DELETE FROM daily_holiday_state WHERE key = 'awaiting_custom_date'").run();
      await tg(env, "sendMessage", { chat_id: adminId, text: "Выбор даты отменён.", reply_markup: dailyMenuMarkup() });
      return;
    }
    if (!isMenuAction && !text.startsWith("/")) {
      const selectedDate = parseDateInput(incomingText);
      if (!selectedDate) {
        await tg(env, "sendMessage", {
          chat_id: adminId,
          text: "⚠️ Не распознал дату. Напиши её, например, 25.12.2026 или 2026-12-25.",
          reply_markup: dailyMenuMarkup()
        });
        return;
      }
      await env.DB.prepare("DELETE FROM daily_holiday_state WHERE key = 'awaiting_custom_date'").run();
      await queueManualDraft(env, adminId, selectedDate);
      return;
    }
    await env.DB.prepare("DELETE FROM daily_holiday_state WHERE key = 'awaiting_custom_date'").run();
  }

  if (text === "📝 создать черновик") {
    await tg(env, "sendMessage", {
      chat_id: adminId,
      text: "На какую дату подготовить публикацию?",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Сегодня", callback_data: "draft:today" }, { text: "Завтра", callback_data: "draft:tomorrow" }],
          [{ text: "📅 Указать другую дату", callback_data: "draft:custom" }],
          [{ text: "↩️ Отмена", callback_data: "draft:cancel" }]
        ]
      }
    });
    return;
  }
  if (text === "/template") {
    await tables(env);
    const asset = await env.DB.prepare("SELECT mime_type, file_name, content_base64 FROM daily_holiday_assets WHERE key = 'template'").first();
    if (!asset || !asset.content_base64) {
      await tg(env, "sendMessage", { chat_id: adminId, text: "Сохранённый шаблон не найден.", reply_markup: dailyMenuMarkup() });
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
    await tg(env, "sendMessage", { chat_id: adminId, text: "Это точная копия оригинального шаблона из хранилища бота. Он остаётся неизменным и используется при подготовке публикаций.", reply_markup: dailyMenuMarkup() });
    return;
  }
  if (text === "/status" || text === "/status@" + String(env.SOVETTG_BOT_USERNAME || "").toLowerCase()) {
    await tables(env);
    const date = localDate();
    const queued = await env.DB.prepare("SELECT value FROM daily_holiday_state WHERE key = 'manual_draft_requested'").first();
    const queuedValue = String(queued && queued.value || "");
    const queuedDate = validIsoDate(queuedValue) ? queuedValue : "";
    const processingMatch = queuedValue.match(/^processing:(\d{4}-\d{2}-\d{2})(?::(\d+))?$/);
    const statusDate = queuedDate || (processingMatch ? processingMatch[1] : date);
    const row = await env.DB.prepare("SELECT status, created_at, holiday_title, message_id, scheduled_publish_at FROM daily_holiday_drafts WHERE date = ?").bind(statusDate).first();
    const processingStartedAt = processingMatch ? Number(processingMatch[2] || row && row.created_at || 0) : 0;
    const processingAge = processingStartedAt ? Math.max(0, Math.floor(Date.now() / 1000) - processingStartedAt) : 0;
    let statusText;
    if (queuedDate) {
      statusText = "⏳ Запрос на подготовку черновика принят и ожидает фонового запуска.\nДата: " + statusDate;
    } else if (processingMatch && processingAge > 240) {
      statusText = "⚠️ Фоновая задача, похоже, зависла. Бот должен восстановить её автоматически.\nДата: " + statusDate + "\nПоследний запуск: " + Math.floor(processingAge / 60) + " мин. назад.";
    } else if (processingMatch) {
      statusText = "⏳ Черновик сейчас готовится в фоновой задаче.\nДата: " + statusDate;
    } else if (!row) {
      statusText = "ℹ️ На " + formatHolidayDate(statusDate) + " черновик ещё не запускался.";
    } else {
      const age = Math.max(0, Math.floor(Date.now() / 1000) - Number(row.created_at || 0));
      const minutes = Math.floor(age / 60);
      const elapsed = minutes ? minutes + " мин. назад" : age + " сек. назад";
      const states = {
        generating: age > 240 ? "⚠️ Подготовка черновика зависла." : "⏳ Черновик сейчас готовится.",
        pending: "✅ Черновик отправлен тебе и ожидает решения. В канал ничего не публиковалось.",
        scheduled: "🕒 Черновик одобрен и ожидает запланированной публикации.",
        skipped: "✖️ Черновик отклонён. В канал ничего не публиковалось.",
        published: "📣 Черновик уже опубликован в канале.",
        publishing: "⏳ Идёт публикация в канал.",
        failed: "⚠️ Последняя попытка завершилась ошибкой. Можно будет повторить после проверки."
      };
      statusText = (states[row.status] || "ℹ️ Статус: " + row.status) + "\nДата: " + statusDate + "\nПоследнее изменение: " + elapsed;
      if (row.holiday_title) statusText += "\nПраздник: " + row.holiday_title;
      if (row.status === "scheduled" && row.scheduled_publish_at) {
        statusText += "\nВремя публикации: " + new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", dateStyle: "short", timeStyle: "short" }).format(new Date(row.scheduled_publish_at * 1000)) + " (Москва)";
      }
      if (row.status === "pending" && row.message_id) statusText += "\nКнопки «Опубликовать» и «Отклонить» находятся в сообщении с черновиком.";
    }
    await tg(env, "sendMessage", { chat_id: adminId, text: statusText, reply_markup: dailyMenuMarkup() });
    return;
  }
  if (text === "/draft" || text.startsWith("/draft@")) {
    await queueManualDraft(env, adminId, localDate());
    return;
  }
  if (text === "/start" || text === "/help") {
    await tg(env, "sendMessage", {
      chat_id: adminId,
      text: "💙 Это бот рубрики «Праздник каждый день». Нажми «Создать черновик», выбери сегодня, завтра или укажи любую дату. Я подготовлю текст и картинку по сохранённому шаблону.\n\nВ канал публикация попадёт только после твоего нажатия «Опубликовать» под готовым черновиком.",
      reply_markup: dailyMenuMarkup()
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
    try {
      // Photo rendering is handled by the scheduled Worker, not inside
      // the short-lived Telegram webhook task. The queue is picked up by Cron. 
      await processUpdate(env, update, String(env.TELEGRAM_ADMIN_ID));
    }
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

  // Process at most one queued photo per scheduled invocation; image rendering
  // must not run inside the short-lived Telegram webhook waitUntil task.
  try { await processQueuedSocialPhotos(env); }
  catch (error) { console.error("Queued social photo processing failed:", error && error.message ? error.message : "unknown error"); }

  // Publish approved future-dated drafts at 06:00 Moscow time.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const due = await env.DB.prepare("SELECT date, chat_id, message_id FROM daily_holiday_drafts WHERE status = 'scheduled' AND scheduled_publish_at IS NOT NULL AND scheduled_publish_at <= ? ORDER BY scheduled_publish_at LIMIT 20").bind(nowSeconds).all();
  for (const draft of (due.results || [])) {
    const lock = await env.DB.prepare("UPDATE daily_holiday_drafts SET status = 'publishing' WHERE date = ? AND status = 'scheduled' AND scheduled_publish_at <= ?").bind(draft.date, nowSeconds).run();
    if (!lock.meta || !lock.meta.changes) continue;
    try {
      await tg(env, "copyMessage", { chat_id: CHANNEL, from_chat_id: String(draft.chat_id), message_id: draft.message_id });
      await env.DB.prepare("UPDATE daily_holiday_drafts SET status = 'published', published_at = ?, scheduled_publish_at = NULL WHERE date = ? AND status = 'publishing'").bind(nowSeconds, draft.date).run();
      const publishedTime = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(nowSeconds * 1000));
      await tg(env, "sendMessage", { chat_id: String(env.TELEGRAM_ADMIN_ID), text: "📣 Готово! Одобренный пост на " + formatHolidayDate(draft.date) + " опубликован в канале в " + publishedTime + " по Москве." });
    } catch (error) {
      await env.DB.prepare("UPDATE daily_holiday_drafts SET status = 'scheduled' WHERE date = ? AND status = 'publishing'").bind(draft.date).run();
      console.error("Scheduled daily holiday publish failed:", error && error.message ? error.message : "unknown error");
      try { await tg(env, "sendMessage", { chat_id: String(env.TELEGRAM_ADMIN_ID), text: "⚠️ Не удалось опубликовать одобренный пост на " + formatHolidayDate(draft.date) + ". Он остался в очереди, бот повторит попытку автоматически." }); } catch {}
    }
  }

  // Manual requests run from the scheduled Worker invocation, not from
  // webhook waitUntil (whose lifetime is too short for image generation).
  const queued = await env.DB.prepare("SELECT value FROM daily_holiday_state WHERE key = 'manual_draft_requested'").first();
  let queueValue = String(queued && queued.value || "");
  let requestedDate = /^\d{4}-\d{2}-\d{2}$/.test(queueValue) ? queueValue : "";
  const processingMatch = queueValue.match(/^processing:(\d{4}-\d{2}-\d{2})(?::(\d+))?$/);

  // Recover a queue lock left behind by an interrupted Worker execution.
  if (processingMatch) {
    const stuckDate = processingMatch[1];
    const oldDraft = await env.DB.prepare("SELECT status, created_at FROM daily_holiday_drafts WHERE date = ?").bind(stuckDate).first();
    const startedAt = Number(processingMatch[2] || oldDraft && oldDraft.created_at || 0);
    const age = startedAt ? Math.max(0, Math.floor(Date.now() / 1000) - startedAt) : 0;
    if (age > 240) {
      if (oldDraft && oldDraft.status === "pending") {
        await env.DB.prepare("DELETE FROM daily_holiday_state WHERE key = 'manual_draft_requested' AND value = ?").bind(queueValue).run();
        await tg(env, "sendMessage", { chat_id: String(env.TELEGRAM_ADMIN_ID), text: "✅ Черновик уже был сформирован и отправлен. Проверь предыдущее сообщение с кнопками — повторная генерация не запускалась." });
      } else if (oldDraft && ["failed", "skipped", "published", "publishing"].includes(oldDraft.status)) {
        await env.DB.prepare("DELETE FROM daily_holiday_state WHERE key = 'manual_draft_requested' AND value = ?").bind(queueValue).run();
        if (oldDraft.status === "failed") await tg(env, "sendMessage", { chat_id: String(env.TELEGRAM_ADMIN_ID), text: "⚠️ Предыдущая фоновая попытка завершилась ошибкой. Зависшая отметка очищена; после проверки можно выбрать дату в меню и повторить.", reply_markup: dailyMenuMarkup() });
      } else {
        const recovered = await env.DB.prepare("UPDATE daily_holiday_state SET value = ? WHERE key = 'manual_draft_requested' AND value = ?").bind(stuckDate, queueValue).run();
        if (recovered.meta && recovered.meta.changes) {
          queueValue = stuckDate;
          requestedDate = stuckDate;
          console.warn("Recovered stale manual daily draft lock for " + stuckDate);
        }
      }
    }
  }

  if (requestedDate && queueValue === requestedDate) {
    const processingValue = "processing:" + requestedDate + ":" + Math.floor(Date.now() / 1000);
    const lock = await env.DB.prepare("UPDATE daily_holiday_state SET value = ? WHERE key = 'manual_draft_requested' AND value = ?").bind(processingValue, requestedDate).run();
    if (lock.meta && lock.meta.changes) {
      let result;
      const statusRow = await env.DB.prepare("SELECT value FROM daily_holiday_state WHERE key = 'manual_draft_status_message_id'").first();
      const statusMessageId = Number(statusRow && statusRow.value || 0);
      const progressText = {
        calendar: "📅 Ищу праздники и проверяю календарь…",
        "text-ai": "✍️ Выбираю подходящий праздник и готовлю текст…",
        "image-ai": "🎨 Создаю тематическую иллюстрацию…",
        "template-render": "🖼 Собираю изображение по твоему оригинальному шаблону…",
        "telegram-sendPhoto": "📨 Отправляю готовый черновик…"
      };
      const updateStatus = async (message) => {
        if (!statusMessageId) return false;
        try {
          await tg(env, "editMessageText", {
            chat_id: String(env.TELEGRAM_ADMIN_ID),
            message_id: statusMessageId,
            text: message
          });
          return true;
        } catch (error) {
          console.warn("Could not update daily draft progress message:", error && error.message ? error.message : "unknown error");
          return false;
        }
      };
      try {
        result = await makeDraft(env, true, requestedDate, async stage => {
          await updateStatus(progressText[stage] || "⏳ Готовлю черновик…");
        });
        const message = result && result.ok
          ? "✅ Черновик готов и отправлен выше. Проверь текст и картинку — в канал он попадёт только после нажатия «Опубликовать»."
          : result && result.stage === "already-processed"
            ? "ℹ️ Черновик на выбранную дату уже обработан. Повторная отправка не выполнялась."
            : "⚠️ Не удалось подготовить черновик" + (result && result.stage ? " на этапе «" + result.stage + "»" : "") + ": " + String(result && result.error || "неизвестная ошибка").slice(0, 220) + "\nВ канал ничего не публиковалось.";
        if (!await updateStatus(message)) {
          await tg(env, "sendMessage", { chat_id: String(env.TELEGRAM_ADMIN_ID), text: message, reply_markup: dailyMenuMarkup() });
        }
      } catch (error) {
        const detail = String(error && error.message ? error.message : "unknown error").slice(0, 180);
        console.error("Manual daily draft job failed:", detail);
        const message = "⚠️ Фоновая подготовка черновика завершилась ошибкой: " + detail + "\nВ канал ничего не публиковалось.";
        if (!await updateStatus(message)) {
          try { await tg(env, "sendMessage", { chat_id: String(env.TELEGRAM_ADMIN_ID), text: message }); } catch {}
        }
      } finally {
        await env.DB.prepare("DELETE FROM daily_holiday_state WHERE key = 'manual_draft_requested' AND value = ?").bind(processingValue).run();
        await env.DB.prepare("DELETE FROM daily_holiday_state WHERE key = 'manual_draft_status_message_id'").run();
      }
    }
  }

  const moscowTime = moscowTimeParts();
  if (moscowTime.hour === String(DAILY_DRAFT_HOUR).padStart(2, "0") && moscowTime.minute === "00") {
    const automaticDraft = await makeDraft(env, false, shiftDate(localDate(), 1));
    if (!automaticDraft.ok && !["already-processed", "cooldown"].includes(automaticDraft.stage)) {
      const detail = String(automaticDraft.error || "Неизвестная ошибка").slice(0, 220);
      try {
        await tg(env, "sendMessage", {
          chat_id: String(env.TELEGRAM_ADMIN_ID),
          text: "⚠️ Не удалось автоматически подготовить черновик «Праздник каждый день» на завтра.\nЭтап: " + String(automaticDraft.stage || "unknown") + "\nПричина: " + detail + "\nВ канал ничего не публиковалось."
        });
      } catch (notifyError) {
        console.error("Could not notify admin about automatic daily draft failure:", notifyError && notifyError.message ? notifyError.message : "unknown error");
      }
    }
  }
}

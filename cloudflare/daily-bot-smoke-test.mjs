import assert from "node:assert/strict";
import fs from "node:fs";
import { modelText } from "./daily-holidays.js";

const sample = {
  selected_index: 1,
  body: "Первый абзац о празднике.\n\nВторой абзац с интересным фактом.",
  image_prompt: "A cheerful school child holding a small paper star"
};

assert.equal(modelText({ response: sample }), JSON.stringify(sample));
assert.equal(modelText({ choices: [{ message: { content: JSON.stringify(sample) } }] }), JSON.stringify(sample));
assert.equal(modelText({ choices: [{ message: { content: [{ type: "text", text: JSON.stringify(sample) }] } }] }), JSON.stringify(sample));
assert.equal(modelText({ output: [{ content: [{ type: "output_text", text: JSON.stringify(sample) }] }] }), JSON.stringify(sample));
assert.equal(modelText(JSON.stringify(sample)), JSON.stringify(sample));
assert.equal(modelText({ response: null, choices: [] }), "");
assert.equal(modelText({ result: { generated_text: JSON.stringify(sample) } }), JSON.stringify(sample));
assert.equal(modelText({ response: { result: JSON.stringify(sample) } }), JSON.stringify(sample));

const daily = fs.readFileSync(new URL("./daily-holidays.js", import.meta.url), "utf8");
const social = fs.readFileSync(new URL("./social-publisher.js", import.meta.url), "utf8");

for (const phrase of [
  "Доброе утро! ☀️",
  "Наша ежедневная рубрика «Праздник каждый день»!",
  "Желаем вам отличного дня! 😊",
  "👉 С1Шк9.Сайт | TGK | MAX",
  "https://t.me/dvizhenieschool9"
]) assert.ok(daily.includes(phrase), "Approved daily caption phrase missing: " + phrase);

assert.ok(daily.includes("env.AI.run(IMAGE_MODEL, {"));
assert.ok(daily.includes("prompt: illustrationPrompt,"));
assert.ok(daily.includes("steps: 4"));
assert.doesNotMatch(daily, /env\.AI\.run\(IMAGE_MODEL,\s*\{[^}]*\bseed\s*:/s);
assert.ok(daily.includes('const TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast"'));
assert.ok(daily.includes("max_tokens: 1000"));
assert.ok(daily.includes("attempt < 3 && !draft"));
assert.ok(daily.includes("ПРЕДЫДУЩИЙ ОТВЕТ НЕ ПРОШЁЛ ПРОВЕРКУ"));
assert.ok(daily.includes("Не удалось получить полный текст после 3 попыток"));
assert.ok(daily.includes("void loadHolidayBrandAssets().catch"));
assert.ok(daily.indexOf("// Manual requests run from the scheduled Worker invocation") < daily.indexOf("// Publish approved future-dated drafts at 06:00 Moscow time."));
assert.ok(daily.includes("AI_TIMEOUT_MS = 60000"));
assert.ok(!daily.includes('response_format: { type: "json_object" }'));
assert.ok(daily.includes('result.image.replace(/\\s/g, "")'));

assert.ok(daily.includes('🔄 Бот обновлён!'));
assert.ok(daily.includes('ВАЖЕН</div><div style="display:flex">КАЖДЫЙ!</div>'));
assert.ok(daily.includes('ВАЖЕН</div><div style="display:flex">КАЖДЫЙ!</div>'));
assert.ok(daily.includes('ШКОЛЫ ДЕВЯТЬ'));
assert.ok(!daily.includes('ШКОЛЫ №9'));
assert.ok(daily.includes('text-align:left'));
assert.ok(daily.includes('ПРАЗДНИК</div><div style="display:flex;font-family:Arial,sans-serif;font-size:27px;line-height:30px;font-weight:900'));
assert.ok(daily.includes('background:rgba(26,11,92,.07)'));
assert.ok(!daily.includes('border:3px solid rgba(255,255,255,.85)'));

assert.ok(daily.includes("DELETE FROM daily_holiday_state WHERE key IN ('awaiting_publish_time', 'awaiting_custom_date')"));
assert.ok(daily.includes("Все уже созданные черновики и ожидающие подтверждения публикации сохранены."));
assert.ok(social.includes('normalized === "/start" || normalized.startsWith("/start@")'));
assert.ok(social.includes('BRAND + "/official-logo.svg"'));
assert.ok(social.includes('ВАЖЕН</div><div style="display:flex">КАЖДЫЙ!</div>'));
assert.ok(social.includes('font-family:Roboto,sans-serif;font-size:26px;line-height:25px;font-weight:900'));
assert.ok(social.includes('text-align:left'));
assert.ok(!social.includes('border-radius:50%;background:#a1001f;color:#fff;font-size:18px'));
assert.ok(social.includes('name: "Roboto", data: robotoBlackFont, weight: 900'));
assert.ok(daily.includes('Roboto%5Bwdth,wght%5D.ttf'));
assert.ok(daily.includes("retrying holiday card with system font"));
assert.ok(daily.includes('"▰".repeat(filled) + "▱".repeat(10-filled) + " " + value + "%\\n" + message'));
assert.ok(daily.includes('Бот работает · «Праздник каждый день»'));
assert.ok(daily.includes('Could not edit the single daily draft progress message'));
assert.ok(daily.includes('attempt < 2 && !draft'));
assert.ok(daily.includes('AI не вернула корректный JSON даже после повторной попытки'));
assert.ok(!daily.includes('Could not send fallback daily draft progress message'));
assert.ok(!daily.includes('const sent = await tg(env, "sendMessage"'));
assert.ok(daily.includes('await updateStatus(message);'));
assert.ok(daily.includes("manual_draft_last_date"));
assert.ok(daily.includes("const statusDate = queuedDate || (processingMatch ? processingMatch[1] : \"\") || lastRequestedDate || localDate();"));
assert.ok(daily.indexOf("if (requestedDate && queueValue === requestedDate)") < daily.indexOf("try { await processQueuedSocialPhotos(env); }"));
assert.ok(daily.includes("A slow unrelated social-photo job"));

assert.ok(social.includes('Roboto%5Bwdth,wght%5D.ttf'));
assert.ok(social.includes('BRAND + "/gerb.png"'));
assert.ok(social.includes("width:1280px;height:720px"));
assert.ok(social.includes("#a1001f"));
assert.ok(social.includes("В канал ничего не отправлено"));

console.log("Daily bot smoke tests passed: Workers AI response formats, approved caption, Flux input schema, original brand assets, and safe preview flow.");

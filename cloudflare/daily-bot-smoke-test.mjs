import assert from "node:assert/strict";
import fs from "node:fs";
import { buildHolidayIllustrationPrompt, fallbackHolidayIllustrationSubject, fitTelegramCaptionBody, modelText } from "./daily-holidays.js";

const sample = {
  selected_index: 1,
  body: "Первый абзац о празднике.\\n\\nВторой абзац с интересным фактом.",
  image_prompt: "A cheerful school child holding a small paper star"
};

assert.equal(modelText({ response: sample }), JSON.stringify(sample));
assert.equal(modelText({ choices: [{ message: { content: JSON.stringify(sample) } }] }), JSON.stringify(sample));
assert.equal(modelText({ choices: [{ message: { content: [{ type: "text", text: JSON.stringify(sample) }] } }] }), JSON.stringify(sample));
assert.equal(modelText({ output: [{ content: [{ type: "output_text", text: JSON.stringify(sample) }] }] }), JSON.stringify(sample));
assert.equal(modelText(JSON.stringify(sample)), JSON.stringify(sample));
assert.equal(modelText({ response: null, choices: [] }), "");
assert.equal(fitTelegramCaptionBody("Короткий текст", 100), "Короткий текст");

const fallbackWithCalendar = fallbackHolidayIllustrationSubject(
  "Международный день семьи",
  "Праздник посвящён семье, заботе и совместному времени родителей и детей."
);
assert.ok(fallbackWithCalendar.length >= 25);
assert.match(fallbackWithCalendar, /Международный день семьи/);
assert.match(fallbackWithCalendar, /родителей и детей/);
const fallbackWithoutDescription = fallbackHolidayIllustrationSubject("День книги", "", "");
assert.ok(fallbackWithoutDescription.length >= 25);
assert.match(fallbackWithoutDescription, /День книги/);

const illustrationPrompt = buildHolidayIllustrationPrompt(
  "Международный день семьи",
  "Праздник семьи",
  "A warm family scene with parents and children spending time together"
);
assert.match(illustrationPrompt, /flat 2D hand-drawn illustration/);
assert.match(illustrationPrompt, /one tiny scene with at most two directly relevant elements/);
assert.match(illustrationPrompt, /ABSOLUTELY NO TEXT OR LETTERING of any kind/);
assert.match(illustrationPrompt, /no words, letters, numbers, labels, signs, captions, logos, watermarks or pseudo-writing/);

const longCaptionBody = "Это первое предложение о празднике. ".repeat(50);
const fittedCaptionBody = fitTelegramCaptionBody(longCaptionBody, 180);
assert.ok(fittedCaptionBody.length <= 180);
assert.ok(/[.!?…]$/.test(fittedCaptionBody));

const daily = fs.readFileSync(new URL("./daily-holidays.js", import.meta.url), "utf8");
const social = fs.readFileSync(new URL("./social-publisher.js", import.meta.url), "utf8");

for (const phrase of [
  "Доброе утро! ☀️",
  "Наша ежедневная рубрика «Праздник каждый день»!",
  "Желаем вам отличного дня! 😊",
  "👉 С1Шк9.Сайт | TGK | MAX",
  "https://t.me/dvizhenieschool9"
]) assert.ok(daily.includes(phrase), "Approved daily caption phrase missing: " + phrase);

assert.ok(daily.includes('const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell"'));
assert.ok(daily.includes("env.AI.run(IMAGE_MODEL, {"));
assert.ok(daily.includes("prompt: illustrationPrompt,"));
assert.ok(daily.includes("steps: 8"));
assert.ok(!/env\\.AI\\.run\\(IMAGE_MODEL,\\s*\\{[^}]*\\bseed\\s*:/s.test(daily));
assert.ok(daily.includes("buildHolidayIllustrationPrompt(chosen.title, chosen.description, imagePrompt)"));
assert.ok(daily.includes("renderHolidayTemplate(null, dateForImage, chosen.title, illustrationDataUrl, body)"));
assert.ok(daily.includes("left:820px;top:205px;width:360px;height:360px"));
assert.ok(daily.includes("left:78px;top:' + (346 + index * lineHeight)"));
assert.ok(daily.includes("left:72px;top:205px;width:680px;height:62px"));
assert.ok(daily.includes("СОВЕТ ПЕРВЫХ</div><div style=\"display:flex\">ШКОЛЫ №9"));
assert.ok(daily.includes("ПРАЗДНИК</div><div style=\"display:flex\">КАЖДЫЙ ДЕНЬ"));
assert.ok(daily.includes("official-logo.svg"));
assert.ok(daily.includes("gerb.png"));
assert.ok(daily.includes("border:2px solid #21145f;border-radius:31px"));
assert.ok(daily.includes("background:#f7f7fa"));
assert.ok(!daily.includes("ВАЖЕН</div>"));
assert.ok(!daily.includes("СОВЕТ ПЕРВЫХ · ШКОЛЫ №9"));
assert.ok(daily.includes("font-family:Georgia,Times New Roman,serif"));
assert.ok(daily.includes("const TEXT_MODEL = \"@cf/google/gemma-4-26b-a4b-it\""));
assert.ok(daily.includes("AI_TIMEOUT_MS = 60000"));
assert.ok(daily.includes("fitTelegramCaptionBody(body, bodyLimit)"));
assert.ok(daily.includes("const bodyLimit = Math.max(0, 1000 - fixedCaptionLength)"));
assert.ok(daily.includes("В канал ничего не публиковалось."));
assert.ok(daily.includes("A slow unrelated social-photo job"));
assert.ok(daily.includes("manual_draft_status_message_id"));
assert.ok(daily.includes("Опубликовать сейчас"));
assert.ok(daily.includes("Переделать картинку"));
assert.ok(daily.includes("Отклонить"));

assert.ok(social.includes('BRAND + "/official-logo.svg"'));
assert.ok(social.includes('BRAND + "/gerb.png"'));
assert.ok(social.includes("width:1280px;height:720px"));
assert.ok(social.includes("В канал ничего не отправлено"));

console.log("Daily bot smoke tests passed: AI output parsing, text-free illustration prompt, exact branded 16:9 template, Flux request schema, and manual approval flow.");

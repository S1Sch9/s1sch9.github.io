import assert from "node:assert/strict";
import fs from "node:fs";
import { buildHolidayIllustrationPrompt, fallbackHolidayIllustrationSubject, holidayIllustrationSubjectForTitle, guinnessIllustrationSvg, fitTelegramCaptionBody, modelText } from "./daily-holidays.js";

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
assert.match(illustrationPrompt, /premium, beautifully art-directed editorial illustration/);
assert.match(illustrationPrompt, /OBJECT LIMIT: show exactly the one or two objects/);
assert.match(illustrationPrompt, /one large central subject/);
assert.match(illustrationPrompt, /isolated cut-out subject on transparent background if supported/);
assert.match(illustrationPrompt, /room, landscape, scenery, floor, horizon/);
assert.match(illustrationPrompt, /if an outline is essential, use only the Council's deep navy #21145f/);
assert.match(illustrationPrompt, /TEXT BAN: ZERO text of any kind/);
assert.match(illustrationPrompt, /No letters, words, numbers, typography, handwriting, book titles/);

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

assert.ok(daily.includes('const IMAGE_MODEL = "@cf/black-forest-labs/flux-2-dev"'));
assert.ok(daily.includes("env.AI.run(IMAGE_MODEL, {"));
assert.ok(daily.includes("multipart: {"));
assert.ok(daily.includes('form.append("steps", "20")'));
assert.ok(daily.includes('form.append("guidance", "4")'));
assert.ok(daily.includes("generateVerifiedHolidayIllustration"));
assert.ok(daily.includes('base64.startsWith("iVBORw0KGgo")'));
assert.ok(daily.includes('base64.startsWith("/9j/")'));
assert.ok(daily.includes('base64.startsWith("UklGR")'));
assert.ok(daily.includes('let imageMime = ""'));
assert.ok(daily.includes('"data:" + imageMime + ";base64," + base64'));

assert.ok(daily.includes("const illustrationSubject = holidayIllustrationSubjectForTitle("));
const redoBlock = daily.slice(daily.indexOf('if (action === "redoimage")'), daily.indexOf('if (action === "skip")'));
assert.ok(redoBlock.includes('holidayIllustrationSubjectForTitle('));
assert.ok(!redoBlock.includes('env.AI.run(TEXT_MODEL'));
assert.ok(!redoBlock.includes('Не удалось определить сюжет иллюстрации'));

assert.ok(daily.includes("background_clean"));
assert.ok(daily.includes("verdict.within_object_limit === true"));
assert.ok(daily.includes("const footerPlain = \"👉 С1Шк9.Сайт | TGK | MAX\""));
assert.ok(daily.includes('captionHtml = captionPlain.endsWith(footerPlain)'));
assert.ok(daily.includes('<a href="https://s1sch9.github.io/">С1Шк9.Сайт</a>'));
assert.ok(daily.includes('<a href="https://t.me/dvizhenieschool9">TGK</a>'));
assert.ok(daily.includes('<a href="https://max.ru/join/R9RTsj6Z4VcAem7B3TH7kAKDHbU3Wkm5WuoYiXOxteI">MAX</a>'));

assert.ok(daily.includes("findCommonsHolidayIllustration(env, title, description, subject)"));
const commonsBlock = daily.slice(daily.indexOf("async function findCommonsHolidayIllustration"), daily.indexOf("async function generateVerifiedHolidayIllustration"));
assert.ok(commonsBlock.includes("Skip AI vision review"));
assert.ok(!commonsBlock.includes("reviewHolidayIllustration(env"));

assert.ok(daily.includes("Wikimedia Commons"));
assert.ok(daily.includes("public domain|cc0|creative commons zero"));
assert.ok(daily.includes("background_clean"));
assert.ok(daily.includes("semi-realistic hand-painted editorial artwork"));
assert.ok(daily.includes("background:#fbfaff"));
assert.ok(daily.includes("background:#f0eef8"));
assert.ok(daily.includes("background:#f8edf1"));
assert.ok(daily.includes("opacity:.045"));
assert.ok(daily.includes("opacity:.055"));
assert.ok(daily.includes("text_free"));
assert.ok(daily.includes("within_object_limit"));
assert.ok(!daily.includes("seed:"));
assert.ok(daily.includes("holidayIllustrationSubjectForTitle(chosen.title, chosen.description, body, imagePrompt)"));
const recordsSubject = holidayIllustrationSubjectForTitle("Всемирный день рекордов Гиннесса", "", "", "three children at school");
assert.match(recordsSubject, /golden trophy/);
assert.match(recordsSubject, /open, deep-navy record book/);
assert.match(recordsSubject, /No people/);
assert.ok(!recordsSubject.includes("children"));
const guinnessSvg = guinnessIllustrationSvg();
assert.match(guinnessSvg, /<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
assert.match(guinnessSvg, /linearGradient id="gold"/);
assert.match(guinnessSvg, /linearGradient id="cover"/);
assert.doesNotMatch(guinnessSvg, /<text\b|<foreignObject\b|letter|Guinness|World Records/i);
assert.match(guinnessSvg, /M178 91/);
assert.match(guinnessSvg, /M91 333/);

assert.ok(daily.includes("renderHolidayTemplate(null, dateForImage, chosen.title, illustrationDataUrl, body)"));
assert.ok(daily.includes("left:820px;top:205px;width:360px;height:360px"));\nassert.ok(daily.includes("ВАЖЕН"));\nassert.ok(daily.includes("КАЖДЫЙ!"));\nassert.ok(daily.includes("left:69px;top:585px"));\nassert.ok(daily.includes("verdict.background_clean === true"));\nassert.ok(daily.includes("attempt < 3"));
assert.ok(daily.includes("left:72px;top:' + (346 + index * lineHeight)"));
assert.ok(daily.includes("left:72px;top:205px;width:680px;height:62px"));
assert.ok(daily.includes("СОВЕТ ПЕРВЫХ</div><div style=\"display:flex\">ШКОЛЫ №9"));
assert.ok(daily.includes("ПРАЗДНИК</div><div style=\"display:flex\">КАЖДЫЙ ДЕНЬ"));
assert.ok(daily.includes("official-logo.svg"));
assert.ok(daily.includes("gerb.png"));
assert.ok(daily.includes("border:2.5px solid #21145f;border-radius:31px"));
assert.ok(daily.includes("mix-blend-mode:multiply"));
assert.ok(daily.includes("FINAL STRICT RETRY"));
assert.ok(daily.includes("within_object_limit"));
assert.ok(daily.includes("left:70px;top:52px;width:650px;height:82px;align-items:center"));
assert.ok(daily.includes("color:#21145f;font-family:Georgia,Times New Roman,serif;font-size:47px"));
assert.ok(!daily.includes("#d9d9e2"));
assert.ok(!daily.includes("#777394"));
assert.ok(!daily.includes("left:488px;top:23px;width:334px;height:3px"));
assert.ok(!daily.includes("background:#f7f7fa"));
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

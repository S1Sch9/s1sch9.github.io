import assert from "node:assert/strict";
import fs from "node:fs";
import { modelText } from "./daily-holidays.js";

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

const daily = fs.readFileSync(new URL("./daily-holidays.js", import.meta.url), "utf8");
const social = fs.readFileSync(new URL("./social-publisher.js", import.meta.url), "utf8");

for (const phrase of [
  "Доброе утро! ☀️",
  "Наша ежедневная рубрика «Праздник каждый день»!",
  "Желаем вам отличного дня! 😊",
  "👉 С1Шк9.Сайт | TGK | MAX",
  "https://t.me/dvizhenieschool9"
]) assert.ok(daily.includes(phrase), "Approved daily caption phrase missing: " + phrase);

assert.match(daily, /env\\.AI\\.run\\(IMAGE_MODEL, \\{\\s*prompt: illustrationPrompt,\\s*steps: 4\\s*\\}\\)/);
assert.doesNotMatch(daily, /env\\.AI\\.run\\(IMAGE_MODEL, \\{[^}]*\\bseed\\s*:/s);
assert.match(daily, /response_format: \\{ type: "json_object" \\}/);
assert.match(daily, /result\\.image\\.replace\\(\\s*\\/\\s*\\\\s\\s*\\/g/);

assert.ok(social.includes("BRAND + \"/official-logo.svg\""));
assert.ok(social.includes("BRAND + \"/gerb.png\""));
assert.ok(social.includes("width:1280px;height:720px"));
assert.ok(social.includes("#a1001f"));
assert.ok(social.includes("В канал ничего не отправлено"));

console.log("Daily bot smoke tests passed: Workers AI response formats, approved caption, Flux input schema, original brand assets, and safe preview flow.");

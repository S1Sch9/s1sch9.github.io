import assert from "node:assert/strict";
import worker from "./worker.js";

const env = { ADMIN_TOKEN: "test-admin-token-".padEnd(48, "x") };
const adminRoutes = [
  ["GET", "/api/admin/push/config"],
  ["POST", "/api/admin/push/config"],
  ["POST", "/api/admin/push/subscribe"],
  ["DELETE", "/api/admin/push/subscribe"],
  ["POST", "/api/admin/push/test"],
  ["POST", "/api/admin/news/upload"],
  ["GET", "/api/admin/news"],
  ["GET", "/api/admin/events"],
  ["POST", "/api/admin/events"],
  ["PATCH", "/api/admin/events/event-aaaaaaaa"],
  ["DELETE", "/api/admin/events/event-aaaaaaaa"],
  ["POST", "/api/admin/news"],
  ["PATCH", "/api/admin/news/draft-id"],
  ["DELETE", "/api/admin/news/draft-id"],
  ["GET", "/api/admin/security"],
  ["POST", "/api/admin/security/blocks"],
  ["DELETE", "/api/admin/security/blocks/" + "a".repeat(64)],
  ["DELETE", "/api/admin/security/events/" + "a".repeat(64)],
  ["GET", "/api/admin/telegram-blocks"],
  ["POST", "/api/admin/telegram-blocks"],
  ["DELETE", "/api/admin/telegram-blocks/123456"],
  ["GET", "/api/admin/appeals"],
  ["PATCH", "/api/admin/appeals/1"],
  ["DELETE", "/api/admin/appeals/1"]
];

for (const [method, path] of adminRoutes) {
  const request = new Request("https://worker.test" + path, {
    method,
    headers: method === "GET" || method === "DELETE" ? {} : { "Content-Type": "application/json" },
    ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" })
  });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 401, method + " " + path + " must require admin authorization");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
}

const adminPage = await worker.fetch(new Request("https://worker.test/admin"), env);
assert.equal(adminPage.status, 200);
assert.match(adminPage.headers.get("Content-Security-Policy") || "", /frame-ancestors 'none'/);
assert.equal(adminPage.headers.get("X-Robots-Tag"), "noindex, nofollow");

const webhook = await worker.fetch(new Request("https://worker.test/telegram/webhook", { method: "POST", body: "{}" }), env);
assert.equal(webhook.status, 401, "Telegram webhook must reject missing secret");

const deniedAppeal = await worker.fetch(new Request("https://worker.test/api/appeals", {
  method: "POST",
  headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
  body: "{}"
}), env);
assert.equal(deniedAppeal.status, 403, "Appeal API must reject foreign origins");

const deniedMiniApp = await worker.fetch(new Request("https://worker.test/api/telegram-miniapp/accept", {
  method: "POST",
  headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
  body: "{}"
}), env);
assert.equal(deniedMiniApp.status, 403, "Mini App API must reject foreign origins");

const malformedAppeal = await worker.fetch(new Request("https://worker.test/api/appeals", {
  method: "POST",
  headers: { Origin: "https://s1sch9.github.io", "Content-Type": "application/json" },
  body: "null"
}), env);
assert.equal(malformedAppeal.status, 400, "Appeal API must reject non-object JSON bodies");

console.log("Security smoke tests passed: admin auth, response headers, webhook secret, CORS, and JSON validation");

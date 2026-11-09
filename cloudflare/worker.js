// Trigger Cloudflare Workers Builds deployment; no runtime behavior changed.
const SITE_ORIGIN = "https://s1sch9.github.io";
const MAX_BODY = 8192;
const MAX_MESSAGE = 1500;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}
function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store"
  };
}
function cors(origin) {
  if (origin !== SITE_ORIGIN) return {};
  return {
    "Access-Control-Allow-Origin": SITE_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}
function cleanText(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function constantTimeEqual(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
function authorized(request, env) {
  const expected = env.ADMIN_TOKEN || "";
  const got = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  return expected.length >= 32 && got.length > 0 && constantTimeEqual(got, expected);
}
async function verifyTurnstile(token, request, env) {
  if (!env.TURNSTILE_SECRET) return { ok: false, reason: "missing-secret" };
  if (!token) return { ok: false, reason: "missing-token" };
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret: env.TURNSTILE_SECRET,
      response: token
    })
  });
  const raw = await response.text();
  let result = null;
  try { result = JSON.parse(raw); } catch {}
  // Siteverify normally returns JSON even for rejected tokens. Preserve its
  // safe error codes so configuration problems can be diagnosed accurately.
  if (result && Array.isArray(result["error-codes"]) && result["error-codes"].length) {
    return { ok: false, reason: result["error-codes"].join(",") };
  }
  if (!response.ok) {
    return { ok: false, reason: "siteverify-http-" + response.status };
  }
  if (!result || typeof result.success !== "boolean") {
    return { ok: false, reason: "invalid-siteverify-response" };
  }
  if (!result.success) return { ok: false, reason: "verification-failed" };
  if (result.hostname && result.hostname !== "s1sch9.github.io") {
    return { ok: false, reason: "hostname-mismatch" };
  }
  return { ok: true };
}
async function rateAllowed(request, env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS appeal_rate_limits (
      ip_hash TEXT PRIMARY KEY,
      window_start INTEGER NOT NULL,
      attempts INTEGER NOT NULL
    )
  `).run();
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = await sha256("s1sch9-appeals-rate:" + ip);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(`
    INSERT INTO appeal_rate_limits (ip_hash, window_start, attempts)
    VALUES (?, ?, 1)
    ON CONFLICT(ip_hash) DO UPDATE SET
      attempts = CASE WHEN window_start <= ? THEN 1 ELSE attempts + 1 END,
      window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END
    RETURNING attempts
  `).bind(key, now, now - 3600, now - 3600, now).first();
  return !!row && row.attempts <= 5;
}
function adminPage() {
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Обращения — Совет Первых школы №9</title>
  <style>
  *{box-sizing:border-box}body{margin:0;background:#f7f5f6;color:#24151a;font:16px system-ui,-apple-system,sans-serif}
  header{background:linear-gradient(115deg,#3d000d,#790d2a);color:#fff;padding:24px max(18px,calc((100% - 980px)/2));box-shadow:0 5px 24px #3d000d18}
  main{max-width:980px;margin:28px auto;padding:0 16px}.panel,.item{background:#fff;border:1px solid #eee5e8;border-radius:20px;padding:20px;margin:14px 0;box-shadow:0 8px 28px #321b2208}
  input{font:inherit;padding:13px;border:1px solid #d9cbd0;border-radius:12px;width:100%;margin:8px 0}
  button{font:inherit;font-size:14px;font-weight:700;border:0;border-radius:12px;padding:11px 14px;background:#a1001f;color:white;cursor:pointer;margin:5px 5px 5px 0}
  button.gray{background:#f1eaed;color:#421d29}button.danger{background:#7d0019}
  button:active{transform:scale(.98)}.muted{color:#82747a;font-size:14px}.msg{white-space:pre-wrap;overflow-wrap:anywhere;margin:16px 0;line-height:1.6}
  .top{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
  .tag{display:inline-block;background:#f6e4e8;color:#a1001f;border-radius:99px;padding:5px 11px;font-size:12px;font-weight:700}
  .tabs{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}.tabs button{margin:0;background:#eee8eb;color:#51313b}.tabs button.active{background:#a1001f;color:#fff}
  .stats{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 18px}.stat{background:#fff;border:1px solid #eee5e8;border-radius:14px;padding:10px 14px;font-size:13px;color:#75686c}.stat b{display:block;font-size:21px;color:#321b22}
  .item{padding:20px}.itemhead{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}.actions{display:flex;gap:6px;flex-wrap:wrap;border-top:1px solid #f1eaed;padding-top:12px}.empty{text-align:center;padding:34px 18px;color:#82747a}
  </style><body><header><h2 style="margin:0">Обращения · Совет Первых школы №9</h2><div class="muted" style="color:#e9cbd2">Закрытая панель модерации</div></header><main>
  <section id="login" class="panel"><h3>Вход администратора</h3><p class="muted">Введите административный пароль. Он проверяется сервером и не хранится в адресе страницы.</p><input id="token" type="password" autocomplete="current-password" placeholder="Административный пароль"><button id="loginBtn">Войти</button><p id="loginError" class="muted"></p></section>
  <section id="app" hidden><div class="top"><div><h2 style="margin:0 0 5px">Обращения</h2><div class="muted">Все сообщения в одном месте</div></div><button class="gray" id="logout">Выйти</button></div><div class="stats" id="stats"></div><nav class="tabs" id="tabs"><button class="active" data-filter="all">Все</button><button data-filter="new">Новые</button><button data-filter="reviewed">Просмотренные</button><button data-filter="done">Завершённые</button></nav><div id="list"></div></section>
  </main><script>
  const $=s=>document.querySelector(s);let token=sessionStorage.getItem("appeals_admin_token")||"";
  const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json",...(opts.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||"Ошибка запроса");return d}
  function show(){const ok=!!token;$("#login").hidden=ok;$("#app").hidden=!ok;if(ok)load().catch(e=>{token="";sessionStorage.removeItem("appeals_admin_token");show();$("#loginError").textContent=e.message})}
  let items=[],filter="all";
  function render(){
    const counts={all:items.length,new:items.filter(x=>x.status==="new").length,reviewed:items.filter(x=>x.status==="reviewed").length,done:items.filter(x=>x.status==="done").length};
    $("#stats").innerHTML='<div class="stat"><b>'+counts.all+'</b>Всего</div><div class="stat"><b>'+counts.new+'</b>Новых</div><div class="stat"><b>'+counts.reviewed+'</b>Просмотрено</div><div class="stat"><b>'+counts.done+'</b>Завершено</div>';
    document.querySelectorAll("#tabs button").forEach(b=>b.classList.toggle("active",b.dataset.filter===filter));
    const shown=items.filter(x=>filter==="all"||x.status===filter);
    $("#list").innerHTML=shown.length?shown.map(x=>{
      const label=x.status==="new"?"Новое":x.status==="reviewed"?"Просмотрено":"Завершено";
      const actions=x.status==="new"
        ?'<button class="gray" data-status="reviewed" data-id="'+x.id+'">Отметить просмотренным</button><button data-status="done" data-id="'+x.id+'">Завершить</button>'
        :x.status==="reviewed"
          ?'<button class="gray" data-status="new" data-id="'+x.id+'">Вернуть в новые</button><button data-status="done" data-id="'+x.id+'">Завершить</button>'
          :'<button class="gray" data-status="reviewed" data-id="'+x.id+'">Вернуть в просмотренные</button><button class="gray" data-status="new" data-id="'+x.id+'">Вернуть в новые</button>';
      return '<article class="item"><div class="itemhead"><span class="tag">'+label+'</span><span class="muted">'+esc(new Date(x.created_at+"Z").toLocaleString("ru-RU"))+'</span></div><p><b>'+esc(x.role)+'</b> · '+esc(x.category)+'</p><div class="msg">'+esc(x.message)+'</div><div class="actions">'+actions+'<button class="danger" data-delete="'+x.id+'">Удалить</button></div></article>';
    }).join(""):'<div class="panel empty">'+(items.length?'В этой категории пока пусто.':'Пока обращений нет 💙')+'</div>';
  }
  async function load(){const d=await api("/api/admin/appeals");items=d.items||[];render()}
  $("#loginBtn").onclick=async()=>{token=$("#token").value.trim();try{await api("/api/admin/appeals");sessionStorage.setItem("appeals_admin_token",token);$("#loginError").textContent="";show()}catch(e){token="";$("#loginError").textContent="Не удалось войти. Проверьте пароль."}};
  $("#logout").onclick=()=>{token="";sessionStorage.removeItem("appeals_admin_token");show()};
  $("#tabs").onclick=e=>{const b=e.target.closest("button[data-filter]");if(!b)return;filter=b.dataset.filter;render()};
  $("#list").onclick=async e=>{const b=e.target.closest("button");if(!b)return;try{if(b.dataset.delete){if(!confirm("Удалить это обращение без возможности восстановления?"))return;await api("/api/admin/appeals/"+b.dataset.delete,{method:"DELETE"})}else if(b.dataset.status){await api("/api/admin/appeals/"+b.dataset.id,{method:"PATCH",body:JSON.stringify({status:b.dataset.status})})}await load()}catch(err){alert(err.message)}};
  show();
  </script></body></html>`;
}

async function ensureTelegramNews(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_news (
    id TEXT PRIMARY KEY, date TEXT NOT NULL, text TEXT NOT NULL, media TEXT NOT NULL DEFAULT '[]'
  )`).run();
}
async function telegramApi(env, method, payload) {
  const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/" + method, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload || {})
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error("Telegram API error");
  return result.result;
}
async function telegramReply(env, chatId, text) {
  return telegramApi(env, "sendMessage", { chat_id: chatId, text });
}
async function setTelegramCommands(env) {
  await telegramApi(env, "setMyCommands", {
    commands: [
      { command: "start", description: "Открыть меню бота" },
      { command: "help", description: "Помощь и список команд" },
      { command: "list", description: "Показать опубликованные новости" },
      { command: "edit", description: "Изменить новость: ID и новый текст" },
      { command: "delete", description: "Удалить новость: ID" }
    ]
  });
}
async function telegramWebhook(request, env) {
  if (!env.TELEGRAM_WEBHOOK_SECRET ||
      !constantTimeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "", env.TELEGRAM_WEBHOOK_SECRET)) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID) return json({ error: "Bot is not configured" }, 503);
  const update = await request.json();
  const msg = update && update.message;
  if (!msg || !msg.chat || msg.chat.type !== "private") return json({ ok: true });
  const chatId = String(msg.chat.id);
  const text = cleanText(msg.text || msg.caption || "", 1500);
  const isAdmin = chatId === String(env.TELEGRAM_ADMIN_ID).trim();
  if (text === "/start" || text === "/help") {
    if (isAdmin) await setTelegramCommands(env);
    await telegramReply(env, chatId, isAdmin
      ? "Привет! Я бот сайта Совета Первых школы №9. 💙\n\nНажми значок / рядом со строкой ввода, чтобы открыть меню команд. Выбери команду — она появится в поле сообщения, останется дописать ID или текст.\n\n/list — список новостей\n/edit ID новый текст — изменить\n/delete ID — удалить\n\nОтправь текст, фото или видео с подписью — и новость появится на сайте."
      : "Привет! Я бот сайта Совета Первых школы №9. 💙\nПубликовать новости может только назначенный администратор.");
    return json({ ok: true });
  }
  if (!isAdmin) {
    await telegramReply(env, chatId, "Публикация новостей доступна только назначенному администратору. 💙");
    return json({ ok: true });
  }
  await ensureTelegramNews(env);
  if (text === "/list") {
    const rows = await env.DB.prepare("SELECT id, text FROM telegram_news ORDER BY date DESC LIMIT 15").all();
    const answer = (rows.results || []).map(x => x.id + " — " + x.text.slice(0, 90)).join("\n") || "Новостей пока нет.";
    await telegramReply(env, chatId, answer);
    return json({ ok: true });
  }
  if (text === "/delete" || text === "/delete@S1Sch9Obrbot") {
    await telegramReply(env, chatId, "🗑 Удаление новости\nВыбери /delete в меню и допиши ID. Например: /delete 3");
    return json({ ok: true });
  }
  if (text.startsWith("/delete ") || text.startsWith("/delete@S1Sch9Obrbot ")) {
    const id = text.split(/\\s+/)[1] || "";
    if (!id) { await telegramReply(env, chatId, "Укажи ID новости. Например: /delete 3"); return json({ ok: true }); }
    const result = await env.DB.prepare("DELETE FROM telegram_news WHERE id = ?").bind(id).run();
    await telegramReply(env, chatId, result.meta.changes ? "Новость удалена с сайта. 💙" : "Новость не найдена.");
    return json({ ok: true });
  }
  if (text === "/edit" || text === "/edit@S1Sch9Obrbot") {
    await telegramReply(env, chatId, "✏️ Выбери /edit в меню и допиши ID и новый текст. Например: /edit 3 Наша новая новость");
    return json({ ok: true });
  }
  if (text.startsWith("/edit ") || text.startsWith("/edit@S1Sch9Obrbot ")) {
    const prefix = text.startsWith("/edit ") ? "/edit " : "/edit@S1Sch9Obrbot ";
    const rest = text.slice(prefix.length).trim();
    const splitAt = rest.indexOf(" ");
    const id = splitAt < 0 ? "" : rest.slice(0, splitAt);
    const updated = splitAt < 0 ? "" : rest.slice(splitAt + 1).trim();
    if (!id || !updated) {
      await telegramReply(env, chatId, "Формат: /edit ID новый текст");
    } else {
      const result = await env.DB.prepare("UPDATE telegram_news SET text = ? WHERE id = ?").bind(updated, id).run();
      await telegramReply(env, chatId, result.meta.changes ? "Новость изменена. 💙" : "Новость не найдена.");
    }
    return json({ ok: true });
  }
  const photo = Array.isArray(msg.photo) && msg.photo.length ? msg.photo[msg.photo.length - 1] : null;
  const video = msg.video || null;
  const file = photo || video;
  if (!text && !file) {
    await telegramReply(env, chatId, "Отправь текст, фото или видео с подписью. Для помощи — /help");
    return json({ ok: true });
  }
  const media = file ? [{ type: video ? "video" : "image", file_id: file.file_id }] : [];
  const groupId = msg.media_group_id ? "album-" + msg.media_group_id : "tg-" + update.update_id;
  const date = new Date((msg.date || Math.floor(Date.now()/1000)) * 1000).toISOString().slice(0,10);
  if (msg.media_group_id) {
    const existing = await env.DB.prepare("SELECT text, media FROM telegram_news WHERE id = ?").bind(groupId).first();
    if (existing) {
      const oldMedia = JSON.parse(existing.media || "[]");
      await env.DB.prepare("UPDATE telegram_news SET text = ?, media = ? WHERE id = ?")
        .bind(text || existing.text, JSON.stringify(oldMedia.concat(media)), groupId).run();
    } else {
      await env.DB.prepare("INSERT INTO telegram_news (id,date,text,media) VALUES (?,?,?,?)")
        .bind(groupId, date, text || "Новость Совета Первых школы №9", JSON.stringify(media)).run();
    }
  } else {
    await env.DB.prepare("INSERT INTO telegram_news (id,date,text,media) VALUES (?,?,?,?)")
      .bind(groupId, date, text || "Новость Совета Первых школы №9", JSON.stringify(media)).run();
  }
  await telegramReply(env, chatId, "Новость опубликована на сайте! 💙");
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const headers = securityHeaders();


    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      try { return await telegramWebhook(request, env); }
      catch (error) { return json({ error: "Webhook processing failed" }, 500); }
    }
    if (url.pathname === "/api/news" && request.method === "GET") {
      try {
        await ensureTelegramNews(env);
        const result = await env.DB.prepare("SELECT id, date, text, media FROM telegram_news ORDER BY date DESC, rowid DESC LIMIT 50").all();
        const items = (result.results || []).map(item => ({
          id: item.id, date: item.date, text: item.text,
          media: JSON.parse(item.media || "[]").map((m, index) => ({
            type: m.type, url: new URL("/api/news-media/" + encodeURIComponent(item.id) + "/" + index, request.url).toString()
          }))
        }));
        return json(items, 200, { ...headers, ...cors(origin) });
      } catch { return json([], 200, { ...headers, ...cors(origin) }); }
    }
    const mediaMatch = url.pathname.match(/^\/api\/news-media\/([^/]+)\/(\d+)$/);
    if (mediaMatch && request.method === "GET") {
      try {
        await ensureTelegramNews(env);
        const item = await env.DB.prepare("SELECT media FROM telegram_news WHERE id = ?").bind(decodeURIComponent(mediaMatch[1])).first();
        const media = item ? JSON.parse(item.media || "[]")[Number(mediaMatch[2])] : null;
        if (!media || !media.file_id || !env.TELEGRAM_BOT_TOKEN) return new Response("Not found", { status: 404, headers });
        const fileInfo = await telegramApi(env, "getFile", { file_id: media.file_id });
        const fileResponse = await fetch("https://api.telegram.org/file/bot" + env.TELEGRAM_BOT_TOKEN + "/" + fileInfo.file_path);
        if (!fileResponse.ok) return new Response("Media unavailable", { status: 502, headers });
        return new Response(fileResponse.body, { headers: { ...headers, ...cors(origin), "Content-Type": fileResponse.headers.get("Content-Type") || (media.type === "video" ? "video/mp4" : "image/jpeg"), "Cache-Control": "public, max-age=3600" } });
      } catch { return new Response("Media unavailable", { status: 502, headers }); }
    }
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      return new Response(adminPage(), { headers: { "content-type": "text/html; charset=utf-8", ...headers } });
    }
    if (url.pathname.startsWith("/api/") && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...cors(origin), ...headers } });
    }
    if (url.pathname === "/api/appeals" && request.method === "POST") {
      if (origin !== SITE_ORIGIN) return json({ error: "Недопустимый источник запроса." }, 403, headers);
      const length = Number(request.headers.get("Content-Length") || 0);
      if (length > MAX_BODY) return json({ error: "Слишком большой запрос." }, 413, { ...headers, ...cors(origin) });
      let body;
      try { body = await request.json(); } catch { return json({ error: "Некорректный запрос." }, 400, { ...headers, ...cors(origin) }); }
      const role = cleanText(body.role, 30);
      const category = cleanText(body.category, 60);
      const message = cleanText(body.message, MAX_MESSAGE);
      const captchaToken = cleanText(body.turnstileToken, 2048);
      if (!["Ученик", "Родитель", "Учитель"].includes(role) ||
          !["Идея или предложение", "Новость школы", "Обратная связь"].includes(category) ||
          message.length < 5 || message.length > MAX_MESSAGE) {
        return json({ error: "Проверьте заполнение формы." }, 400, { ...headers, ...cors(origin) });
      }
      try {
        const captchaCheck = await verifyTurnstile(captchaToken, request, env);
        if (!captchaCheck.ok) {
          return json({
            error: "Не пройдена проверка защиты от автоматических отправок.",
            diagnostic: captchaCheck.reason
          }, 400, { ...headers, ...cors(origin) });
        }
        if (!(await rateAllowed(request, env))) {
          return json({ error: "Слишком много обращений. Попробуйте позже." }, 429, { ...headers, ...cors(origin) });
        }
        await env.DB.prepare("INSERT INTO appeals (role, category, message, status) VALUES (?, ?, ?, 'new')")
          .bind(role, category, message).run();
        return json({ success: true }, 201, { ...headers, ...cors(origin) });
      } catch {
        return json({ error: "Сервис временно недоступен. Попробуйте позже." }, 503, { ...headers, ...cors(origin) });
      }
    }

    if (url.pathname === "/api/admin/appeals" && request.method === "GET") {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401, headers);
      try {
        const result = await env.DB.prepare("SELECT id, role, category, message, status, created_at FROM appeals ORDER BY id DESC LIMIT 200").all();
        return json({ items: result.results || [] }, 200, headers);
      } catch { return json({ error: "Не удалось загрузить обращения." }, 500, headers); }
    }

    const match = url.pathname.match(/^\/api\/admin\/appeals\/(\d+)$/);
    if (match && (request.method === "DELETE" || request.method === "PATCH")) {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401, headers);
      const id = Number(match[1]);
      if (!Number.isSafeInteger(id) || id < 1) return json({ error: "Некорректный ID." }, 400, headers);
      try {
        if (request.method === "DELETE") {
          await env.DB.prepare("DELETE FROM appeals WHERE id = ?").bind(id).run();
          return json({ success: true }, 200, headers);
        }
        const body = await request.json();
        if (!["reviewed", "done"].includes(body.status)) return json({ error: "Некорректный статус." }, 400, headers);
        await env.DB.prepare("UPDATE appeals SET status = ? WHERE id = ?").bind(body.status, id).run();
        return json({ success: true }, 200, headers);
      } catch { return json({ error: "Не удалось изменить обращение." }, 500, headers); }
    }
    return new Response("Not found", { status: 404, headers });
  }
};
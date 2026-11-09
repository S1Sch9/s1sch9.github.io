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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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
  *{box-sizing:border-box}body{margin:0;background:#faf6f6;color:#24151a;font:16px system-ui,-apple-system,sans-serif}
  header{background:#3d000d;color:#fff;padding:22px max(18px,calc((100% - 900px)/2));}
  main{max-width:900px;margin:24px auto;padding:0 16px}.panel,.item{background:white;border:1px solid #eadfe1;border-radius:18px;padding:18px;margin:12px 0}
  input{font:inherit;padding:13px;border:1px solid #d9cbd0;border-radius:12px;width:100%;margin:8px 0}
  button{font:inherit;font-weight:700;border:0;border-radius:12px;padding:11px 15px;background:#a1001f;color:white;cursor:pointer;margin:5px 5px 5px 0}
  button.gray{background:#eee5e8;color:#321b22}button.danger{background:#7d0019}
  .muted{color:#75686c;font-size:14px}.msg{white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0}
  .top{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
  .tag{display:inline-block;background:#f6e4e8;color:#a1001f;border-radius:99px;padding:4px 10px;font-size:13px}
  </style><body><header><h2 style="margin:0">Обращения · Совет Первых школы №9</h2><div class="muted" style="color:#e9cbd2">Закрытая панель модерации</div></header><main>
  <section id="login" class="panel"><h3>Вход администратора</h3><p class="muted">Введите административный пароль. Он проверяется сервером и не хранится в адресе страницы.</p><input id="token" type="password" autocomplete="current-password" placeholder="Административный пароль"><button id="loginBtn">Войти</button><p id="loginError" class="muted"></p></section>
  <section id="app" hidden><div class="top"><h3>Входящие обращения</h3><button class="gray" id="logout">Выйти</button></div><p class="muted" id="count"></p><div id="list"></div></section>
  </main><script>
  const $=s=>document.querySelector(s);let token=sessionStorage.getItem("appeals_admin_token")||"";
  const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json",...(opts.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||"Ошибка запроса");return d}
  function show(){const ok=!!token;$("#login").hidden=ok;$("#app").hidden=!ok;if(ok)load().catch(e=>{token="";sessionStorage.removeItem("appeals_admin_token");show();$("#loginError").textContent=e.message})}
  async function load(){const d=await api("/api/admin/appeals");$("#count").textContent="Всего: "+d.items.length;$("#list").innerHTML=d.items.length?d.items.map(x=>'<article class="item"><div class="top"><span class="tag">'+esc(x.status==="new"?"Новое":x.status==="reviewed"?"На рассмотрении":"Обработано")+'</span><span class="muted">'+esc(new Date(x.created_at+"Z").toLocaleString("ru-RU"))+'</span></div><p><b>'+esc(x.role)+'</b> · '+esc(x.category)+'</p><div class="msg">'+esc(x.message)+'</div><button class="gray" data-status="reviewed" data-id="'+x.id+'">На рассмотрении</button><button data-status="done" data-id="'+x.id+'">Обработано</button><button class="danger" data-delete="'+x.id+'">Удалить</button></article>').join(""):'<div class="panel">Пока обращений нет.</div>'}
  $("#loginBtn").onclick=async()=>{token=$("#token").value.trim();try{await api("/api/admin/appeals");sessionStorage.setItem("appeals_admin_token",token);$("#loginError").textContent="";show()}catch(e){token="";$("#loginError").textContent="Не удалось войти. Проверьте пароль."}};
  $("#logout").onclick=()=>{token="";sessionStorage.removeItem("appeals_admin_token");show()};
  $("#list").onclick=async e=>{const b=e.target.closest("button");if(!b)return;try{if(b.dataset.delete){if(!confirm("Удалить это обращение без возможности восстановления?"))return;await api("/api/admin/appeals/"+b.dataset.delete,{method:"DELETE"})}else if(b.dataset.status){await api("/api/admin/appeals/"+b.dataset.id,{method:"PATCH",body:JSON.stringify({status:b.dataset.status})})}await load()}catch(err){alert(err.message)}};
  show();
  </script></body></html>`;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const headers = securityHeaders();

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
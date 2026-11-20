// =====================================================================
//  AI key server (Cloudflare Worker) — keeps your Gemini key private.
//
//  Your site talks to this server; this server talks to Gemini using the
//  key. People using the AI never see the key, and it is never in your
//  site's files.
//
//  Setup (free, ~3 minutes) — full steps are in AI-SETUP.md:
//   1. dash.cloudflare.com -> Workers & Pages -> Create -> Worker -> Deploy
//   2. Edit code -> replace everything with this file -> Deploy
//   3. Settings -> Variables and Secrets -> Add -> type "Secret",
//      name GEMINI_KEY, value = your Gemini key -> Deploy
//   4. Copy the worker's URL (https://....workers.dev) into AI_PROXY_URL
//      at the top of games.html
// =====================================================================

// Only let your own site use this server. Put your site's address here once
// it's online, e.g. ["https://yourname.github.io"]. Leave empty to allow any
// site (the key still stays hidden, but others could use your free quota).
// "null" is what the page sends when it's opened from a file on a computer.
const ALLOWED_ORIGINS = ["https://drew110321-spec.github.io", "https://amber-harbor-pencil.edgeone.dev", "https://cobalt-maple-tuesday.pages.dev", "https://quiet-river-lamp.edgeone.dev"];

// Stop one person from using up the shared free quota.
const MAX_MESSAGES_PER_MINUTE_PER_PERSON = 15;

const GEMINI = "https://generativelanguage.googleapis.com/v1beta";
const recent = new Map(); // ip -> timestamps of recent requests

function reply(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------
//  ON/OFF SWITCH + MESSAGE BAR for both sites.
//  /status -> {"on":true|false,"msg":"..."}   (the sites check this)
//  /admin  -> your private control page. It asks for your password
//             (the ADMIN_PASS secret), then remembers you for 12 hours.
//  The on/off value and the message live in HUB_STATE.
// ---------------------------------------------------------------------
const SITE_ORIGINS = ["https://drew110321-spec.github.io", "https://amber-harbor-pencil.edgeone.dev", "https://cobalt-maple-tuesday.pages.dev", "https://quiet-river-lamp.pages.dev", "https://quiet-river-lamp.edgeone.dev"];
const LOGIN_TRIES_PER_10_MIN = 8;
const LOGIN_FAILS_TOTAL_PER_10_MIN = 40;
const loginTries = new Map(); // ip -> timestamps of wrong passwords

async function isOn(env) {
  if (!env.HUB_STATE) return true;
  return (await env.HUB_STATE.get("site", { cacheTtl: 30 })) !== "off";
}
async function getMsg(env) {
  if (!env.HUB_STATE) return "";
  return (await env.HUB_STATE.get("msg", { cacheTtl: 30 })) || "";
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Login cookie: a signature made from your password, so it can't be faked
// and stops working if you ever change the password.
async function sign(env, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.ADMIN_PASS),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, "");
}
async function makeToken(env) {
  const until = Date.now() + 12 * 3600 * 1000;
  return until + "." + (await sign(env, "admin:" + until));
}
async function validToken(env, token) {
  const [until, sig] = String(token || "").split(".");
  if (!until || !sig || Number(until) < Date.now()) return false;
  return sig === (await sign(env, "admin:" + until));
}
function cookieOf(request, name) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : "";
}
function sameText(a, b) {          // compare without leaking timing
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

const STYLE = `<style>*{box-sizing:border-box;border-radius:0}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#fff;
font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;text-align:center;padding:24px}
.s{font-size:12px;letter-spacing:.2em;text-transform:uppercase;opacity:.6}.big{font-size:56px;font-weight:800;letter-spacing:.06em;margin:8px 0 28px}
.w{width:min(360px,90vw);margin:0 auto}
button.k{display:block;width:100%;margin:0 0 12px;padding:22px;font:inherit;font-size:16px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;cursor:pointer;border:2px solid #fff}
.off{background:#fff;color:#000}.on{background:#000;color:#fff}.n{margin-top:18px;font-size:12px;opacity:.6}
.f{margin:36px auto 0;text-align:left}
input.t{width:100%;padding:14px;background:#000;color:#fff;border:1px solid #fff;font:inherit;font-size:14px}
button.b{width:100%;margin-top:8px;padding:14px;background:#fff;color:#000;border:0;font:inherit;font-weight:800;letter-spacing:.14em;text-transform:uppercase;cursor:pointer}
button.x{margin-top:28px;background:none;border:0;color:#fff;opacity:.5;font:inherit;font-size:11px;letter-spacing:.16em;text-transform:uppercase;cursor:pointer;text-decoration:underline}
.err{color:#fff;border:1px solid #fff;padding:10px;margin-bottom:12px;font-size:13px}</style>`;
const HEAD = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Switch</title>${STYLE}</head><body>`;

function loginPage(error) {
  return HEAD + `<form method="post" action="/admin" class="w">
<div class="s" style="margin-bottom:16px">Control page</div>
${error ? `<div class="err">${esc(error)}</div>` : ""}
<input class="t" type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus>
<input type="hidden" name="do" value="login">
<button class="b" type="submit">Log in</button></form></body></html>`;
}

function adminPage(on, note, msg) {
  return HEAD + `<div class="w"><div class="s">Your sites are</div><div class="big">${on ? "ON" : "OFF"}</div>
<form method="post" action="/admin">
${on ? `<input type="hidden" name="do" value="off"><button class="k off" type="submit">Shut down now</button>`
     : `<input type="hidden" name="do" value="on"><button class="k on" type="submit">Turn back on</button>`}
</form>
<div class="n">${esc(note || "Changes reach everyone within about a minute.")}</div>
<form method="post" action="/admin" class="f">
<div class="s" style="margin-bottom:8px">Message bar (shows at the top of the games site for everyone)</div>
<input class="t" name="msg" maxlength="200" value="${esc(msg || "")}" placeholder="Type a message, or leave empty to hide the bar">
<input type="hidden" name="do" value="msg">
<button class="b" type="submit">Save message</button></form>
<form method="post" action="/admin"><input type="hidden" name="do" value="logout"><button class="x" type="submit">Log out</button></form>
</div></body></html>`;
}

async function handleAdmin(request, env) {
  const html = (body, extra = {}) => new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", ...extra },
  });
  if (!env.ADMIN_PASS || !env.HUB_STATE) return new Response("Not set up", { status: 500 });
  const loggedIn = await validToken(env, cookieOf(request, "hub_admin"));

  if (request.method === "POST") {
    // Only accept forms sent from this page itself
    const origin = request.headers.get("Origin");
    if (origin && origin !== new URL(request.url).origin) return new Response("Forbidden", { status: 403 });
    const form = await request.formData();
    const action = form.get("do");

    if (action === "login") {
      // Wrong tries are counted in HUB_STATE, so every copy of this server sees
      // the same count: 8 per address and 40 in total every 10 minutes.
      // (If the total is hit, logging in pauses; anyone already logged in keeps working.)
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const now = Date.now();
      const tries = (loginTries.get(ip) || []).filter((t) => now - t < 600_000);
      const ipKey = "fail:" + ip, allKey = "fail:all";
      const ipFails = Number(await env.HUB_STATE.get(ipKey)) || 0;
      const allFails = Number(await env.HUB_STATE.get(allKey)) || 0;
      if (tries.length >= LOGIN_TRIES_PER_10_MIN || ipFails >= LOGIN_TRIES_PER_10_MIN || allFails >= LOGIN_FAILS_TOTAL_PER_10_MIN) {
        return html(loginPage("Too many wrong tries. Wait 10 minutes."));
      }
      if (!sameText(form.get("password") || "", env.ADMIN_PASS)) {
        tries.push(now); loginTries.set(ip, tries);
        await Promise.all([
          env.HUB_STATE.put(ipKey, String(ipFails + 1), { expirationTtl: 600 }),
          env.HUB_STATE.put(allKey, String(allFails + 1), { expirationTtl: 600 }),
        ]);
        await new Promise((r) => setTimeout(r, 1000));      // slow down guessing
        return html(loginPage("Wrong password."));
      }
      loginTries.delete(ip);
      const cookie = `hub_admin=${encodeURIComponent(await makeToken(env))}; Path=/admin; Max-Age=43200; HttpOnly; Secure; SameSite=Strict`;
      return html(adminPage(await isOn(env), "Logged in.", await getMsg(env)), { "Set-Cookie": cookie });
    }
    if (action === "logout") {
      return html(loginPage(""), { "Set-Cookie": "hub_admin=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict" });
    }
    if (!loggedIn) return html(loginPage("Please log in."));

    let on = await isOn(env), msg = await getMsg(env), note = "";
    if (action === "off" || action === "on") {
      await env.HUB_STATE.put("site", action);
      on = action === "on";
      note = on ? "Back on. Both sites work again within about a minute." : "Shut down. Everyone gets kicked off within about a minute.";
    } else if (action === "msg") {
      msg = String(form.get("msg") || "").trim().slice(0, 200);
      await env.HUB_STATE.put("msg", msg);
      note = msg ? "Message saved. Everyone sees it within about a minute." : "Message bar hidden.";
    }
    return html(adminPage(on, note, msg));
  }

  if (!loggedIn) return html(loginPage(""));
  return html(adminPage(await isOn(env), "", await getMsg(env)));
}

export default {
  async fetch(request, env) {
    const url0 = new URL(request.url);

    // Private control page (opened directly, so it skips the site check below)
    if (url0.pathname === "/admin") return handleAdmin(request, env);

    // Status the two sites check
    if (url0.pathname === "/status") {
      const o = request.headers.get("Origin") || "";
      const h = { "Content-Type": "application/json", "Cache-Control": "no-store",
                  "Access-Control-Allow-Origin": SITE_ORIGINS.includes(o) ? o : SITE_ORIGINS[0], "Vary": "Origin" };
      return new Response(JSON.stringify({ on: await isOn(env), msg: await getMsg(env) }), { headers: h });
    }

    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": allowed ? origin || "*" : "null",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!allowed) return reply({ error: { message: "This site isn't allowed to use the AI." } }, 403, cors);
    if (!(await isOn(env))) return reply({ error: { message: "This site is turned off." } }, 403, cors);

    // Rate limit per person (by IP address)
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const now = Date.now();
    const times = (recent.get(ip) || []).filter((t) => now - t < 60_000);
    if (times.length >= MAX_MESSAGES_PER_MINUTE_PER_PERSON) {
      return reply({ error: { message: "Too many messages. Wait a minute and try again." } }, 429, cors);
    }
    times.push(now);
    recent.set(ip, times);
    if (recent.size > 5000) recent.clear();

    const url = new URL(request.url);
    if (request.method === "GET" && ["/youtube/search", "/youtube/videos"].includes(url.pathname)) {
      if (!env.YOUTUBE_API_KEY) return reply({error:{message:"YouTube search is not configured."}}, 503, cors);
      const upstream = new URL("https://www.googleapis.com/youtube/v3/" + url.pathname.split("/").pop());
      for (const name of ["part","q","type","id","chart","regionCode","maxResults","pageToken","order","videoEmbeddable","safeSearch"]) {
        if (url.searchParams.has(name)) upstream.searchParams.set(name,url.searchParams.get(name));
      }
      upstream.searchParams.set("key", env.YOUTUBE_API_KEY);
      const result = await fetch(upstream);
      return new Response(result.body, {status:result.status, headers:{...cors,"Content-Type":"application/json"}});
    }
    if (!env.GEMINI_KEY) return reply({ error: { message: "The AI server has no key yet (add the GEMINI_KEY secret)." } }, 500, cors);
    const keyHeader = { "x-goog-api-key": env.GEMINI_KEY };
    let upstream;

    try {
      if (request.method === "GET" && url.pathname === "/models") {
        // Lets the page pick the newest free model
        upstream = await fetch(GEMINI + "/models?pageSize=1000", { headers: keyHeader, signal: AbortSignal.timeout(15_000) });
      } else if (request.method === "POST" && /^\/models\/[\w.\-]+:(generateContent|streamGenerateContent)$/.test(url.pathname)) {
        const body = await request.text();
        if (body.length > 300_000) return reply({ error: { message: "That chat is too long. Start a new chat." } }, 413, cors);
        const streaming = url.pathname.endsWith(":streamGenerateContent");
        // Give up if Google doesn't start answering in time (the page then tries another model)
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 30_000);
        upstream = await fetch(GEMINI + url.pathname + (streaming ? "?alt=sse" : ""), {
          method: "POST",
          headers: { ...keyHeader, "Content-Type": "application/json" },
          body,
          signal: ac.signal,
        });
        if (!streaming) {
          // Read the whole answer while the timer is still running
          const data = await upstream.arrayBuffer();
          upstream = new Response(data, { status: upstream.status, headers: upstream.headers });
        }
        clearTimeout(timer);                  // answer is flowing: let it finish
      } else {
        return reply({ error: { message: "Not found" } }, 404, cors);
      }
    } catch (e) {
      // Google didn't answer in time: tell the page so it can try another model
      return reply({ error: { message: "The AI took too long to answer.", status: "UNAVAILABLE" } }, 503, cors);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...cors, "Content-Type": upstream.headers.get("Content-Type") || "application/json" },
    });
  },
};

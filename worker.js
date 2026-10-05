/**
 * 闪传 flashdrop —— 跨设备文字 / 文件互传，纯 Cloudflare 部署
 *
 * 架构：Cloudflare Worker + R2（文字索引与文件都存在 R2，无需 KV、无需服务器）
 * 部署：GitHub 仓库 + Workers Git 集成，push 即自动上线
 *
 * 环境变量：
 *   AUTH_PASSWORD  (Secret, 必填) 登录密码
 *   FILE_TTL_DAYS  (Var, 可选) 文件保留天数，默认 7
 *   TEXT_TTL_DAYS  (Var, 可选) 文字保留天数，默认 30
 * R2 绑定：BUCKET -> bucket "flashdrop-files"
 * 定时任务：每天清理过期内容（wrangler.toml 里配 cron）
 */

const enc = new TextEncoder();

async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function sessionToken(env) {
  return sha256Hex("flashdrop-session-v1:" + (env.AUTH_PASSWORD || ""));
}

function timingEqual(a, b) {
  const x = enc.encode(a);
  const y = enc.encode(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}

function getSessionCookie(request) {
  const h = request.headers.get("Cookie") || "";
  const m = h.match(/(?:^|;\s*)fd_sess=([0-9a-f]{64})/);
  return m ? m[1] : null;
}

async function isAuthed(request, env) {
  if (!env.AUTH_PASSWORD) return false;
  const got = getSessionCookie(request);
  if (!got) return false;
  return timingEqual(got, await sessionToken(env));
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, headers || {}),
  });
}

// ---------------- R2 小工具 ----------------
async function readJson(bucket, key, fallback) {
  const obj = await bucket.get(key);
  if (!obj) return fallback;
  try {
    return await obj.json();
  } catch (e) {
    return fallback;
  }
}

async function writeJson(bucket, key, value) {
  await bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

const TEXTS_KEY = "texts/index.json";
const FILES_KEY = "files/index.json";
const MAX_TEXTS = 200;

function ttlDays(env, name, def) {
  const v = parseInt(env[name] || "", 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

function rid() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function sanitizeName(name) {
  const n = String(name || "未命名文件").replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
  return n || "未命名文件";
}

// ---------------- API ----------------
async function handleLogin(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch (e) {}
  const pw = String(body.password || "");
  const ok =
    !!env.AUTH_PASSWORD &&
    timingEqual(await sha256Hex("pw:" + pw), await sha256Hex("pw:" + env.AUTH_PASSWORD));
  if (!ok) return json({ ok: false, error: "密码错误" }, 401);
  const token = await sessionToken(env);
  return json(
    { ok: true },
    200,
    {
      "Set-Cookie":
        "fd_sess=" + token + "; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax; Secure",
    }
  );
}

async function handleTexts(request, env, url) {
  if (request.method === "GET") {
    const now = Date.now();
    const list = (await readJson(env.BUCKET, TEXTS_KEY, [])).filter((t) => t.expiresAt > now);
    list.sort((a, b) => b.createdAt - a.createdAt);
    return json({ items: list });
  }
  if (request.method === "POST") {
    let body = {};
    try {
      body = await request.json();
    } catch (e) {}
    const text = String(body.text || "").slice(0, 100000);
    if (!text.trim()) return json({ ok: false, error: "内容为空" }, 400);
    const now = Date.now();
    const item = {
      id: rid(),
      text: text,
      createdAt: now,
      expiresAt: now + ttlDays(env, "TEXT_TTL_DAYS", 30) * 86400000,
    };
    let list = await readJson(env.BUCKET, TEXTS_KEY, []);
    list = list.filter((t) => t.expiresAt > now);
    list.push(item);
    list = list.slice(-MAX_TEXTS);
    await writeJson(env.BUCKET, TEXTS_KEY, list);
    return json({ ok: true, item: item });
  }
  if (request.method === "DELETE") {
    const id = url.pathname.split("/").pop();
    let list = await readJson(env.BUCKET, TEXTS_KEY, []);
    list = list.filter((t) => t.id !== id);
    await writeJson(env.BUCKET, TEXTS_KEY, list);
    return json({ ok: true });
  }
  return json({ ok: false, error: "method not allowed" }, 405);
}

async function handleFiles(request, env, url) {
  const parts = url.pathname.split("/");
  const id = parts.length > 3 ? parts[3] : null;

  if (request.method === "GET" && !id) {
    const now = Date.now();
    const list = (await readJson(env.BUCKET, FILES_KEY, [])).filter((f) => f.expiresAt > now);
    list.sort((a, b) => b.uploadedAt - a.uploadedAt);
    return json({ items: list });
  }

  if (request.method === "GET" && id) {
    const list = await readJson(env.BUCKET, FILES_KEY, []);
    const meta = list.find((f) => f.id === id);
    if (!meta) return json({ ok: false, error: "文件不存在" }, 404);
    const obj = await env.BUCKET.get(meta.key);
    if (!obj) return json({ ok: false, error: "文件不存在" }, 404);
    const disp =
      "attachment; filename=\"" +
      meta.name.replace(/"/g, "") +
      "\"; filename*=UTF-8''" +
      encodeURIComponent(meta.name);
    return new Response(obj.body, {
      headers: {
        "Content-Type": obj.httpMetadata.contentType || "application/octet-stream",
        "Content-Disposition": disp,
        "Content-Length": String(meta.size || obj.size || 0),
      },
    });
  }

  if (request.method === "POST" && !id) {
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file.stream !== "function") {
      return json({ ok: false, error: "没有收到文件" }, 400);
    }
    let days = parseInt(String(form.get("days") || ""), 10);
    if (!Number.isFinite(days) || days <= 0) days = ttlDays(env, "FILE_TTL_DAYS", 7);
    days = Math.min(days, 365);
    const fid = rid();
    const name = sanitizeName(file.name);
    const key = "files/" + fid + "/" + name;
    const now = Date.now();
    await env.BUCKET.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
    });
    const meta = {
      id: fid,
      name: name,
      size: file.size || 0,
      key: key,
      uploadedAt: now,
      expiresAt: now + days * 86400000,
    };
    let list = await readJson(env.BUCKET, FILES_KEY, []);
    list = list.filter((f) => f.expiresAt > now);
    list.push(meta);
    await writeJson(env.BUCKET, FILES_KEY, list);
    return json({ ok: true, item: meta });
  }

  if (request.method === "DELETE" && id) {
    let list = await readJson(env.BUCKET, FILES_KEY, []);
    const meta = list.find((f) => f.id === id);
    list = list.filter((f) => f.id !== id);
    await writeJson(env.BUCKET, FILES_KEY, list);
    if (meta) {
      try {
        await env.BUCKET.delete(meta.key);
      } catch (e) {}
    }
    return json({ ok: true });
  }

  return json({ ok: false, error: "method not allowed" }, 405);
}

// 定时清理：删掉过期的文字与文件，并顺手清掉索引里没登记的孤儿文件
async function cleanup(env) {
  const now = Date.now();
  const texts = (await readJson(env.BUCKET, TEXTS_KEY, [])).filter((t) => t.expiresAt > now);
  await writeJson(env.BUCKET, TEXTS_KEY, texts.slice(-MAX_TEXTS));

  let files = await readJson(env.BUCKET, FILES_KEY, []);
  const kept = [];
  for (const f of files) {
    if (f.expiresAt > now) {
      kept.push(f);
    } else {
      try {
        await env.BUCKET.delete(f.key);
      } catch (e) {}
    }
  }
  const keptKeys = new Set(kept.map((f) => f.key));
  try {
    let cursor = undefined;
    do {
      const page = await env.BUCKET.list({ prefix: "files/", cursor: cursor });
      for (const o of page.objects) {
        if (!keptKeys.has(o.key) && now - o.uploaded.getTime() > 2 * 86400000) {
          try {
            await env.BUCKET.delete(o.key);
          } catch (e) {}
        }
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch (e) {}
  await writeJson(env.BUCKET, FILES_KEY, kept);
  return { texts: texts.length, files: kept.length };
}

// ---------------- 前端页面（单文件，内嵌在 Worker 里，无需构建） ----------------
const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>闪传</title>
<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Helvetica Neue",sans-serif;color:#1c1c1e;min-height:100vh;-webkit-font-smoothing:antialiased;background:linear-gradient(180deg,#b9cdf5 0%,#dfc2f2 52%,#bfe9da 100%)}
/* 极光背景：玻璃折射用的底 */
body::before{content:"";position:fixed;inset:-60px;z-index:0;pointer-events:none;background:radial-gradient(620px 460px at 12% 8%,rgba(0,110,255,.62),transparent 62%),radial-gradient(580px 560px at 88% 18%,rgba(170,60,220,.58),transparent 62%),radial-gradient(700px 520px at 55% 95%,rgba(60,190,250,.52),transparent 62%),radial-gradient(480px 460px at 82% 78%,rgba(255,130,0,.45),transparent 62%),radial-gradient(520px 420px at 30% 60%,rgba(40,200,90,.34),transparent 62%);animation:drift 22s ease-in-out infinite}
@keyframes drift{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(50px,-36px) scale(1.08)}}
.hidden{display:none!important}
.screen{max-width:640px;margin:0 auto;padding:12px 16px 60px;position:relative;z-index:1}
/* 通用玻璃 */
.glass,.login-box,.card,.tabs,#dropzone{position:relative;background:rgba(255,255,255,.34);-webkit-backdrop-filter:blur(30px) saturate(200%);backdrop-filter:blur(30px) saturate(200%);border:1px solid rgba(255,255,255,.8);box-shadow:0 8px 28px rgba(60,60,90,.14),inset 0 1px 1px rgba(255,255,255,.95),inset 0 -1px 0 rgba(255,255,255,.25)}
.glass::after,.login-box::after,.card::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:linear-gradient(180deg,rgba(255,255,255,.65),rgba(255,255,255,0) 42%)}
/* 登录 */
.login-box{border-radius:28px;padding:44px 28px;margin-top:13vh;text-align:center;overflow:hidden}
.login-box h1{font-size:36px;font-weight:700;margin:0 0 8px;letter-spacing:2px}
.subtitle{color:#636366;font-size:15px;margin:0 0 28px}
.field{width:100%;padding:14px 16px;font-size:17px;background:rgba(255,255,255,.42);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.7);border-radius:14px;outline:none;color:#1c1c1e;box-shadow:inset 0 1px 3px rgba(0,0,0,.05)}
.field:focus{border-color:rgba(0,122,255,.6);box-shadow:0 0 0 3px rgba(0,122,255,.15)}
.field::placeholder{color:#aeaeb2}
textarea.field{min-height:120px;resize:vertical;line-height:1.5}
.btn{width:100%;margin-top:16px;padding:14px;font-size:17px;font-weight:600;border:none;border-radius:14px;cursor:pointer;color:#fff;background:linear-gradient(180deg,#3b9bff 0%,#007aff 100%);box-shadow:0 6px 18px rgba(0,122,255,.35),inset 0 1px 0 rgba(255,255,255,.45)}
.btn:active{filter:brightness(.94)}
.err{color:#ff3b30;font-size:14px;margin-top:12px;min-height:20px}
/* 顶栏 */
header{padding:22px 6px 14px;display:flex;align-items:flex-end;justify-content:space-between}
header h1{font-size:34px;font-weight:700;margin:0;letter-spacing:1px;text-shadow:0 1px 0 rgba(255,255,255,.6)}
header button{background:rgba(255,255,255,.55);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.8);color:#007aff;font-size:15px;font-weight:600;padding:8px 14px;border-radius:999px;cursor:pointer;box-shadow:0 2px 10px rgba(60,60,90,.1)}
/* 分段选择器 */
.tabs{display:flex;border-radius:999px;padding:4px;margin:4px 0 20px;overflow:hidden}
.tabs button{flex:1;border:none;background:none;padding:9px;font-size:14px;font-weight:500;color:#3a3a3c;border-radius:999px;cursor:pointer;position:relative;z-index:1}
.tabs button.on{background:rgba(255,255,255,.85);box-shadow:0 2px 10px rgba(60,60,90,.16);font-weight:600;color:#1c1c1e}
/* 文字区 */
.send-row{display:flex;gap:10px;margin-top:12px}
.send-row .btn{margin-top:0;flex:1.4}
.btn-secondary{flex:1;padding:14px;font-size:17px;font-weight:600;border:1px solid rgba(255,255,255,.8);border-radius:14px;background:rgba(255,255,255,.55);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);color:#007aff;cursor:pointer;box-shadow:0 4px 14px rgba(60,60,90,.1)}
/* 卡片列表 */
.card{border-radius:20px;padding:16px;margin-bottom:12px;overflow:hidden}
.card .meta{font-size:13px;color:#636366;margin-bottom:6px;position:relative;z-index:1}
.card pre{white-space:pre-wrap;word-break:break-all;font-family:inherit;font-size:16px;margin:0 0 12px;line-height:1.5;max-height:240px;overflow:hidden;position:relative;z-index:1}
.card .ops{display:flex;gap:10px;position:relative;z-index:1}
.card .ops a{flex:1;text-decoration:none}
.card .ops button{flex:1;padding:10px;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer}
.card .ops button.btn-copy{background:rgba(0,122,255,.14);color:#007aff}
.card .ops button.btn-del{background:rgba(255,59,48,.12);color:#ff3b30}
.card .ops button.btn-dl{background:rgba(0,122,255,.14);color:#007aff;width:100%}
.empty{text-align:center;color:#636366;font-size:15px;padding:40px 0}
/* 文件 */
#dropzone{border-radius:22px;border:1px dashed rgba(0,122,255,.45);padding:40px 16px;text-align:center;color:#636366;font-size:16px;cursor:pointer;line-height:1.9;transition:all .2s;overflow:hidden}
#dropzone.over{border-color:#007aff;color:#007aff;background:rgba(0,122,255,.1);box-shadow:0 0 24px rgba(0,122,255,.25)}
.ttl-row{display:flex;align-items:center;gap:8px;margin-top:14px;font-size:14px;color:#636366;text-shadow:0 1px 0 rgba(255,255,255,.5)}
.ttl-row select{padding:10px 12px;border:1px solid rgba(255,255,255,.7);border-radius:12px;background:rgba(255,255,255,.42);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);font-size:15px;color:#1c1c1e;outline:none}
#upBar{height:8px;background:rgba(255,255,255,.5);border-radius:5px;margin-top:14px;overflow:hidden;box-shadow:inset 0 1px 3px rgba(0,0,0,.08)}
#upFill{height:100%;width:0;background:linear-gradient(90deg,#3b9bff,#007aff);border-radius:5px;transition:width .15s;box-shadow:0 0 8px rgba(0,122,255,.5)}
#upText{font-size:13px;color:#636366;margin-top:8px;min-height:18px}
.fname{font-size:16px;font-weight:600;word-break:break-all;margin-bottom:4px;position:relative;z-index:1}
</style>
</head>
<body>
<!-- 登录 -->
<div id="login" class="screen hidden">
  <div class="login-box">
    <h1>闪传</h1>
    <p class="subtitle">手机 ↔ 电脑，随手互传</p>
    <input id="pw" class="field" type="password" placeholder="输入访问密码" autocomplete="current-password">
    <button id="loginBtn" class="btn">进入</button>
    <div class="err" id="loginErr"></div>
  </div>
</div>
<!-- 主界面 -->
<div id="app" class="screen hidden">
  <header><h1>闪传</h1><button id="logoutBtn">退出登录</button></header>
  <div class="tabs">
    <button id="tabBtnText" class="on">文字</button>
    <button id="tabBtnFile">文件</button>
  </div>
  <section id="tabText">
    <textarea id="textInput" class="field" placeholder="粘贴或输入要同步的文字…"></textarea>
    <div class="send-row">
      <button id="sendText" class="btn">发送</button>
      <button id="clearText" class="btn-secondary">清空</button>
    </div>
    <div id="textList"></div>
  </section>
  <section id="tabFile" class="hidden">
    <div id="dropzone">点这里选择文件<br><span style="font-size:12px">或把文件拖进来（可多选）</span></div>
    <input type="file" id="fileInput" multiple class="hidden">
    <div class="ttl-row">文件保留 <select id="ttlSel"><option value="1">1 天</option><option value="7" selected>7 天</option><option value="30">30 天</option></select> 后自动删除</div>
    <div id="upBar" class="hidden"><div id="upFill"></div></div>
    <div id="upText"></div>
    <div id="fileList"></div>
  </section>
</div>
<script>
var $ = function(id){ return document.getElementById(id); };
function fmtTime(ts){ return new Date(ts).toLocaleString("zh-CN",{hour12:false}); }
function fmtSize(n){ if(n<1024) return n+" B"; if(n<1048576) return (n/1024).toFixed(1)+" KB"; if(n<1073741824) return (n/1048576).toFixed(1)+" MB"; return (n/1073741824).toFixed(2)+" GB"; }
function leftDays(ts){ var d = Math.ceil((ts - Date.now())/86400000); return d <= 0 ? "今天到期" : d + " 天后到期"; }
function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function api(path, opt){
  opt = opt || {};
  opt.headers = opt.headers || {};
  if(opt.body && typeof opt.body === "string") opt.headers["Content-Type"] = "application/json";
  return fetch(path, opt).then(function(r){
    if(r.status === 401){ showLogin(); throw new Error("unauth"); }
    return r.json().then(function(j){ return {status:r.status, data:j}; });
  });
}
/* ---- 登录 ---- */
function showLogin(){ $("login").classList.remove("hidden"); $("app").classList.add("hidden"); }
function showApp(){ $("login").classList.add("hidden"); $("app").classList.remove("hidden"); refreshTexts(); refreshFiles(); }
function doLogin(){
  var pw = $("pw").value;
  $("loginErr").textContent = "";
  api("/api/login",{method:"POST",body:JSON.stringify({password:pw})}).then(function(r){
    if(r.status === 200 && r.data.ok){ $("pw").value = ""; showApp(); }
    else $("loginErr").textContent = "密码错误，请重试";
  }).catch(function(){});
}
$("loginBtn").onclick = doLogin;
$("pw").addEventListener("keydown", function(e){ if(e.key === "Enter") doLogin(); });
$("logoutBtn").onclick = function(){ fetch("/api/logout",{method:"POST"}).then(function(){ showLogin(); }); };
/* ---- tabs ---- */
$("tabBtnText").onclick = function(){ $("tabBtnText").classList.add("on"); $("tabBtnFile").classList.remove("on"); $("tabText").classList.remove("hidden"); $("tabFile").classList.add("hidden"); };
$("tabBtnFile").onclick = function(){ $("tabBtnFile").classList.add("on"); $("tabBtnText").classList.remove("on"); $("tabFile").classList.remove("hidden"); $("tabText").classList.add("hidden"); };
/* ---- 文字 ---- */
$("sendText").onclick = function(){
  var t = $("textInput").value;
  if(!t.trim()) return;
  api("/api/texts",{method:"POST",body:JSON.stringify({text:t})}).then(function(r){
    if(r.data.ok){ $("textInput").value = ""; refreshTexts(); }
  });
};
$("clearText").onclick = function(){ $("textInput").value = ""; };
function refreshTexts(){
  api("/api/texts").then(function(r){
    var box = $("textList"), items = r.data.items || [];
    if(!items.length){ box.innerHTML = '<div class="empty">还没有文字，在上面输入第一条吧</div>'; return; }
    var html = "";
    for(var i=0;i<items.length;i++){
      var it = items[i];
      html += '<div class="card"><div class="meta">' + fmtTime(it.createdAt) + ' · ' + leftDays(it.expiresAt) + '</div>'
        + '<pre>' + esc(it.text.length > 600 ? it.text.slice(0,600) + "…" : it.text) + '</pre>'
        + '<div class="ops"><button class="btn-copy" data-tid="' + it.id + '">复制</button>'
        + '<button class="btn-del" data-dtid="' + it.id + '">删除</button></div></div>';
    }
    box.innerHTML = html;
    var cps = box.querySelectorAll(".btn-copy");
    for(var j=0;j<cps.length;j++){ (function(b){ b.onclick = function(){ copyText(b.getAttribute("data-tid"), b); }; })(cps[j]); }
    var dls = box.querySelectorAll(".btn-del");
    for(var k=0;k<dls.length;k++){ (function(b){ b.onclick = function(){
      if(confirm("删除这条文字？")) api("/api/texts/"+b.getAttribute("data-dtid"),{method:"DELETE"}).then(refreshTexts);
    }; })(dls[k]); }
  }).catch(function(){});
}
var textCache = {};
function copyText(id, btn){
  var t = textCache[id] || "";
  function done(){ var o = btn.textContent; btn.textContent = "已复制"; setTimeout(function(){ btn.textContent = o; }, 1200); }
  if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(t).then(done).catch(function(){ fallback(); }); }
  else fallback();
  function fallback(){ var ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select(); try{ document.execCommand("copy"); }catch(e){} document.body.removeChild(ta); done(); }
}
/* ---- 文件 ---- */
$("dropzone").onclick = function(){ $("fileInput").click(); };
$("fileInput").onchange = function(){ uploadFiles($("fileInput").files); $("fileInput").value = ""; };
["dragover","dragenter"].forEach(function(ev){ $("dropzone").addEventListener(ev, function(e){ e.preventDefault(); $("dropzone").classList.add("over"); }); });
["dragleave","drop"].forEach(function(ev){ $("dropzone").addEventListener(ev, function(e){ e.preventDefault(); $("dropzone").classList.remove("over"); }); });
$("dropzone").addEventListener("drop", function(e){ if(e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files); });
function uploadFiles(files){
  var days = $("ttlSel").value;
  var queue = [];
  for(var i=0;i<files.length;i++) queue.push(files[i]);
  var idx = 0;
  $("upBar").classList.remove("hidden");
  function next(){
    if(idx >= queue.length){ $("upText").textContent = "全部上传完成"; setTimeout(function(){ $("upBar").classList.add("hidden"); $("upText").textContent = ""; }, 2000); refreshFiles(); return; }
    var f = queue[idx];
    $("upText").textContent = "正在上传 (" + (idx+1) + "/" + queue.length + ")：" + f.name;
    var xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/files");
    xhr.upload.onprogress = function(e){ if(e.lengthComputable){ var p = ((idx + e.loaded/e.total) / queue.length * 100); $("upFill").style.width = p.toFixed(1) + "%"; } };
    xhr.onload = function(){ idx++; if(xhr.status === 401){ showLogin(); return; } next(); };
    xhr.onerror = function(){ $("upText").textContent = "上传失败：" + f.name; idx++; next(); };
    var fd = new FormData();
    fd.append("file", f);
    fd.append("days", days);
    xhr.send(fd);
  }
  next();
}
function refreshFiles(){
  api("/api/files").then(function(r){
    var box = $("fileList"), items = r.data.items || [];
    if(!items.length){ box.innerHTML = '<div class="empty">还没有文件，点上面传第一个吧</div>'; return; }
    var html = "";
    for(var i=0;i<items.length;i++){
      var it = items[i];
      html += '<div class="card"><div class="fname">' + esc(it.name) + '</div>'
        + '<div class="meta">' + fmtSize(it.size) + ' · ' + fmtTime(it.uploadedAt) + ' · ' + leftDays(it.expiresAt) + '</div>'
        + '<div class="ops"><a href="/api/files/' + it.id + '" style="flex:1;text-decoration:none"><button class="btn-dl" style="width:100%">下载</button></a>'
        + '<button class="btn-del" data-dfid="' + it.id + '">删除</button></div></div>';
    }
    box.innerHTML = html;
    var dls = box.querySelectorAll(".btn-del");
    for(var k=0;k<dls.length;k++){ (function(b){ b.onclick = function(){
      if(confirm("删除这个文件？")) api("/api/files/"+b.getAttribute("data-dfid"),{method:"DELETE"}).then(refreshFiles);
    }; })(dls[k]); }
  }).catch(function(){});
}
/* ---- 启动 ---- */
fetch("/api/me").then(function(r){
  if(r.status === 200) showApp(); else showLogin();
}).catch(showLogin);
/* 文字列表缓存（复制用） */
setInterval(function(){
  api("/api/texts").then(function(r){
    var items = r.data.items || [], c = {};
    for(var i=0;i<items.length;i++) c[items[i].id] = items[i].text;
    textCache = c;
  }).catch(function(){});
}, 15000);
api("/api/texts").then(function(r){
  var items = r.data.items || [], c = {};
  for(var i=0;i<items.length;i++) c[items[i].id] = items[i].text;
  textCache = c;
}).catch(function(){});
</script>
</body>
</html>`;

// ---------------- 路由 ----------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" && request.method === "GET") {
      return new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (path === "/api/login" && request.method === "POST") return handleLogin(request, env);
    if (path === "/api/logout" && request.method === "POST") {
      return json(
        { ok: true },
        200,
        { "Set-Cookie": "fd_sess=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure" }
      );
    }
    if (path === "/api/me" && request.method === "GET") {
      if (!env.AUTH_PASSWORD) return json({ ok: false, reason: "no_password" }, 401);
      return (await isAuthed(request, env)) ? json({ ok: true }) : json({ ok: false }, 401);
    }

    // 以下接口都需要登录
    if (!(await isAuthed(request, env))) return json({ ok: false, error: "未登录" }, 401);

    if (path === "/api/texts" || path.startsWith("/api/texts/")) return handleTexts(request, env, url);
    if (path === "/api/files" || path.startsWith("/api/files/")) return handleFiles(request, env, url);

    return json({ ok: false, error: "not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanup(env));
  },
};

#!/usr/bin/env node
/**
 * 橙子短剧（接手版）轻量后端
 *
 * 零原生依赖（仅 express），数据落在 /data 目录（JSON 文件 + 头像文件），
 * 通过 Docker volume 持久化。Node 单线程 + 同步 fs，低流量自用场景足够安全。
 *
 * 接口一览（均 JSON）：
 *   GET  /api/health                         健康检查
 *   POST /api/register  {username,password}  注册 -> {token,user}
 *   POST /api/login     {username,password}  登录 -> {token,user}
 *   POST /api/logout    (Bearer)             注销 -> 204
 *   POST /api/change-password (Bearer) {oldPassword,newPassword} -> {token,user}
 *   POST /api/avatar    (Bearer) {data:base64} 上传头像 -> {user}
 *   GET  /api/avatar/:id.jpg                 头像文件
 *   GET  /api/library?source=hongguo|huangguo (Bearer) -> {payload}
 *   PUT  /api/library   (Bearer) {source,payload} -> {synced:true}
 *
 * 认证：Authorization: Bearer <token>（32 字节随机 hex，服务端会话表）。
 * 密码：Node 内置 crypto.scrypt（加盐），不落明文。
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = process.env.DATA_DIR || '/data';
const TOKEN_TTL_MS = 90 * 24 * 3600 * 1000; // 90 天
const MAX_AVATAR_BYTES = 512 * 1024;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const USERNAME_RE = /^[A-Za-z0-9_]{3,24}$/;

// 黄果站点域名白名单（后端转发接口只允许抓这些域名，避免变成开放代理）
// 主站为 *.pqhybuxo.cc 系，另含官方备用域名与封面 CDN
const HUANGGUO_HOST_RE = /(^|\.)(pqhybuxo\.cc|im41z53s\.cc|huangguoju\.com|huangguoai\.com|huang-guo\.pages\.dev|huangguoai\.pages\.dev|wirqed\.cn|fisawck\.cn|tkzdds\.cn)$/i;

// ---- TOTP 动态码（RFC 6238，30 秒窗口，6 位）----
const OTP_WINDOW = 30; // 秒
const OTP_DIGITS = 6;
function base32Decode(input) {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(input).toUpperCase()) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function ensureOtpSecret() {
  const otpFile = path.join(DATA_DIR, 'otp.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(otpFile, 'utf8')); } catch { /* 首次运行 */ }
  if (!data.secret) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let secret = '';
    for (let i = 0; i < 32; i++) secret += chars[Math.floor(Math.random() * chars.length)];
    data.secret = secret;
    data.lastReset = Date.now();
    const tmp = otpFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, otpFile);
  }
  return data;
}
function totpCode(otpData, windowOffset) {
  const counter = Math.floor(Date.now() / 1000 / OTP_WINDOW) + windowOffset;
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigInt64BE(BigInt(counter));
  const key = base32Decode(otpData.secret);
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 1000000).padStart(OTP_DIGITS, '0');
}
function verifyOtp(code) {
  const input = String(code || '').trim();
  if (!/^\d{6}$/.test(input)) return false;
  const otpData = ensureOtpSecret();
  // 容忍 ±1 个窗口，避免手机与服务器时钟轻微偏差
  for (let w = -1; w <= 1; w++) if (totpCode(otpData, w) === input) return true;
  return false;
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });

const file = name => path.join(DATA_DIR, name + '.json');

function load(name) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); }
  catch { return {}; }
}
function save(name, data) {
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file(name));
}

const users = load('users');         // id -> {id,username,password,salt,avatar,createdAt}
const sessions = load('sessions');   // token -> {userId, createdAt, lastSeen}
const library = load('library');     // userId -> { source -> {updatedAt, payload} }

function flush() { save('users', users); save('sessions', sessions); save('library', library); }

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function newUserRecord(username, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { id: crypto.randomBytes(12).toString('hex'), username, password: hashPassword(password, salt),
           salt, avatar: null, createdAt: Date.now() };
}
function issueToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { userId, createdAt: Date.now(), lastSeen: Date.now() };
  return token;
}
function publicUser(user) {
  return { id: user.id, username: user.username, avatar: user.avatar, createdAt: user.createdAt };
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+([a-f0-9]{64})$/i);
  const session = match && sessions[match[1]];
  if (!session) return res.status(401).json({ error: '登录已失效，请重新登录' });
  const user = users[session.userId];
  if (!user) return res.status(401).json({ error: '账号不存在，请重新登录' });
  session.lastSeen = Date.now();
  req.user = user;
  req.token = match[1];
  next();
}
function needUser(req, res) {
  if (!req.user) { res.status(401).json({ error: '请先登录' }); return false; }
  return true;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '3mb' }));

// 状态页（浏览器直接访问根路径即可看到，含注册/登录在线测试）
app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>橙子短剧后端 · 状态页</title>
<style>
:root{--bg:#0f1115;--card:#1a1e26;--line:#2a3040;--fg:#e8ecf3;--mut:#8a93a5;--ok:#37d67a;--err:#ff5c5c;--acc:#f5d782}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding:24px;min-height:100vh}
.wrap{max-width:720px;margin:0 auto}
h1{font-size:20px;letter-spacing:.5px}
h2{font-size:15px;margin:18px 0 10px;color:var(--acc)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:14px}
.row{display:flex;flex-wrap:wrap;gap:8px 24px;align-items:center}
.k{color:var(--mut);font-size:12px}
.v{font-weight:600}
.ok{color:var(--ok)} .err{color:var(--err)}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
input{background:#0d0f13;border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:8px 10px;font-size:14px;width:100%}
button{background:var(--acc);color:#1a1e26;border:none;border-radius:8px;padding:9px 16px;font-size:14px;font-weight:700;cursor:pointer}
button:active{opacity:.8}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media(max-width:520px){.g2{grid-template-columns:1fr}}
pre{white-space:pre-wrap;word-break:break-all;background:#0d0f13;border:1px solid var(--line);border-radius:8px;padding:10px;font-size:12px;margin-top:10px;max-height:240px;overflow:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
td,th{border:1px solid var(--line);padding:6px 8px;text-align:left}
th{color:var(--mut);font-weight:600}
a{color:var(--acc)}
</style>
</head>
<body>
<div class="wrap">
<h1>橙子短剧后端</h1>
<div class="card">
<div class="row">
<span class="k">服务</span><span class="v mono" id="s-service">-</span>
<span class="k">状态</span><span class="v ok mono" id="s-status">-</span>
<span class="k">用户数</span><span class="v mono" id="s-users">-</span>
<span class="k">时间</span><span class="v mono" id="s-time">-</span>
</div>
</div>
<h2>私密模式动态码（OTP）</h2>
<div class="card">
<div class="row">
<span class="k">当前动态码</span><span class="v mono" style="font-size:26px;letter-spacing:4px" id="otp-code">------</span>
<span class="k">剩余</span><span class="v mono" id="otp-remain">-</span>秒
<button onclick="resetOtp()">重置动态码</button>
</div>
<p style="color:var(--mut);font-size:12px;margin-top:8px">APK 私密模式输入这 6 位数字；每 30 秒自动更换。重置后旧码立即失效。</p>
</div>
<h2>在线测试（注册 / 登录）</h2>
<div class="card">
<div class="g2">
<div><input id="u" placeholder="账号（3–24 位字母数字下划线）" autocomplete="off"></div>
<div><input id="p" type="password" placeholder="密码（至少 8 位）" autocomplete="new-password"></div>
</div>
<div class="row" style="margin-top:10px">
<button onclick="api('register')">注册</button>
<button onclick="api('login')">登录</button>
<button onclick="health()">刷新状态</button>
</div>
<pre id="out">等待操作…</pre>
</div>
<h2>接口一览</h2>
<div class="card"><table>
<tr><th>接口</th><th>说明</th></tr>
<tr><td class="mono">GET /api/health</td><td>健康检查</td></tr>
<tr><td class="mono">POST /api/register</td><td>注册，返回 token + 用户</td></tr>
<tr><td class="mono">POST /api/login</td><td>登录，返回 token + 用户</td></tr>
<tr><td class="mono">POST /api/logout</td><td>注销（Bearer）</td></tr>
<tr><td class="mono">POST /api/change-password</td><td>修改密码（Bearer）</td></tr>
<tr><td class="mono">POST /api/avatar</td><td>上传头像（Bearer）</td></tr>
<tr><td class="mono">GET /api/library?source=</td><td>拉取片单（Bearer）</td></tr>
<tr><td class="mono">PUT /api/library</td><td>保存片单（Bearer）</td></tr>
</table></div>
<div class="card" style="color:var(--mut);font-size:12px">
<p>数据目录：<span class="mono" id="s-datadir">-</span>（Docker 卷 <span class="mono">./chengzi-data:/data</span>，备份拷该目录）</p>
<p style="margin-top:6px">部署文档见 <a href="https://github.com/gybeyond1/HuangguoAPP-for-Andriod/tree/master/server">仓库 server/</a></p>
</div>
</div>
<script>
const out=document.getElementById('out');
let otpTimer=null;
async function refreshOtp(){
  try{
    const d=await fetch('/api/otp').then(r=>r.json());
    document.getElementById('otp-code').textContent=d.code;
    document.getElementById('otp-remain').textContent=d.expiresIn;
  }catch(e){document.getElementById('otp-code').textContent='获取失败'}
}
function tickOtp(){
  const el=document.getElementById('otp-remain');
  let s=parseInt(el.textContent,10);
  if(!isNaN(s)){ el.textContent=s>0?s-1:0; if(s<=1) refreshOtp(); }
}
otpTimer=setInterval(tickOtp,1000);
async function resetOtp(){
  if(!confirm('确定重置动态码？当前码立即失效')) return;
  try{
    const d=await fetch('/api/otp/reset',{method:'POST'}).then(r=>r.json());
    document.getElementById('otp-code').textContent=d.code;
    document.getElementById('otp-remain').textContent=d.window;
    out.textContent='动态码已重置';
  }catch(e){out.textContent='重置失败: '+e.message}
}
async function health(){
  try{
    const r=await fetch('/api/health');const d=await r.json();
    document.getElementById('s-service').textContent=d.service;
    document.getElementById('s-status').textContent=d.status==='ok'?'正常':'异常';
    document.getElementById('s-time').textContent=new Date(d.time).toLocaleString();
    const users=await fetch('/api/stats').then(x=>x.json());
    document.getElementById('s-users').textContent=users.users;
    document.getElementById('s-datadir').textContent=users.dataDir;
    out.textContent='状态正常，服务 '+d.service;
  }catch(e){document.getElementById('s-status').textContent='异常';out.textContent='连接失败: '+e.message}
}
async function api(kind){
  const u=document.getElementById('u').value.trim(),p=document.getElementById('p').value;
  out.textContent='请求中…';
  try{
    const r=await fetch('/api/'+kind,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
    const d=await r.json().catch(()=>({}));
    out.textContent=r.ok
      ? (kind==='register'?'注册成功：':'登录成功：')+'\\n'+JSON.stringify(d,null,2)
      : (r.status+' '+(d.error||'请求失败'));
  }catch(e){out.textContent='请求失败: '+e.message}
}
health();
</script>
</body>
</html>`);
});

// 状态统计（状态页用）
app.get('/api/stats', (_req, res) => {
  res.json({ service: 'chengzi-backend', status: 'ok', users: Object.keys(users).length, dataDir: DATA_DIR });
});

// 当前动态码（状态页展示；30 秒轮换一次）
app.get('/api/otp', (_req, res) => {
  const otpData = ensureOtpSecret();
  res.json({
    code: totpCode(otpData, 0),
    window: OTP_WINDOW,
    expiresIn: OTP_WINDOW - (Math.floor(Date.now() / 1000) % OTP_WINDOW),
    lastReset: otpData.lastReset || null
  });
});

// 重置动态码（重新生成 secret，旧码立即全部失效）
app.post('/api/otp/reset', (_req, res) => {
  try { fs.unlinkSync(path.join(DATA_DIR, 'otp.json')); } catch { /* 不存在则直接新建 */ }
  const otpData = ensureOtpSecret();
  res.json({ ok: true, code: totpCode(otpData, 0), window: OTP_WINDOW });
});

// 验证动态码（APK 私密模式入口）
app.post('/api/otp/verify', (req, res) => {
  if (verifyOtp(req.body && req.body.code)) return res.json({ ok: true });
  res.status(401).json({ error: '动态码不正确或已过期' });
});

// 黄果转发接口：APK 本地代理不通时绕行（只放行黄果站点/封面域名）
app.get('/api/huangguo-proxy', (req, res) => {
  const target = String(req.query.url || '');
  let parsed;
  try { parsed = new URL(target); } catch { return res.status(400).json({ error: '无效地址' }); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return res.status(400).json({ error: '仅支持 http/https' });
  if (!HUANGGUO_HOST_RE.test(parsed.hostname))
    return res.status(403).json({ error: '仅允许黄果站点域名' });
  const client = parsed.protocol === 'https:' ? https : http;
  const upstream = client.get(parsed, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
      'Accept': '*/*'
    },
    timeout: 25_000
  }, (up) => {
    if (up.statusCode < 200 || up.statusCode >= 300) {
      up.resume();
      return res.status(502).json({ error: '上游站点返回 ' + up.statusCode });
    }
    res.status(200);
    const upstreamType = up.headers['content-type'] || 'text/html; charset=utf-8';
    res.setHeader('Content-Type', upstreamType);
    res.setHeader('Cache-Control', 'no-store');
    up.pipe(res);
  });
  upstream.on('timeout', () => { upstream.destroy(); res.status(504).json({ error: '上游站点超时' }); });
  upstream.on('error', () => { if (!res.headersSent) res.status(502).json({ error: '上游站点连接失败' }); });
});

// 健康检查
app.get('/api/health', (_req, res) => {
  res.json({ code: 200, service: 'chengzi-backend', status: 'ok', time: Date.now() });
});

// 注册
app.post('/api/register', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!USERNAME_RE.test(username))
    return res.status(400).json({ error: '账号需为 3–24 位字母、数字或下划线' });
  if (password.length < 8) return res.status(400).json({ error: '密码至少需要 8 位' });
  if (Object.values(users).some(u => u.username === username))
    return res.status(409).json({ error: '该账号已被注册' });
  const user = newUserRecord(username, password);
  users[user.id] = user;
  flush();
  res.status(201).json({ token: issueToken(user.id), user: publicUser(user) });
});

// 登录
app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = Object.values(users).find(u => u.username === username);
  const ok = user && crypto.timingSafeEqual(
    Buffer.from(user.password, 'hex'), Buffer.from(hashPassword(password, user.salt), 'hex'));
  if (!ok) return res.status(401).json({ error: '账号不存在或密码错误，请检查后重试' });
  flush();
  res.json({ token: issueToken(user.id), user: publicUser(user) });
});

// 会话恢复（APK 冷启动用 token 换用户信息）
app.get('/api/me', auth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// 注销
app.post('/api/logout', auth, (req, res) => {
  delete sessions[req.token];
  flush();
  res.status(204).end();
});

// 修改密码（验旧密码，签发新 token）
app.post('/api/change-password', auth, (req, res) => {
  const oldPassword = String(req.body.oldPassword || '');
  const newPassword = String(req.body.newPassword || '');
  const oldOk = crypto.timingSafeEqual(
    Buffer.from(req.user.password, 'hex'), Buffer.from(hashPassword(oldPassword, req.user.salt), 'hex'));
  if (!oldOk) return res.status(400).json({ error: '旧密码不正确' });
  if (newPassword.length < 8) return res.status(400).json({ error: '新密码至少需要 8 位' });
  if (newPassword === oldPassword) return res.status(400).json({ error: '新密码不能与旧密码相同' });
  const user = req.user;
  user.salt = crypto.randomBytes(16).toString('hex');
  user.password = hashPassword(newPassword, user.salt);
  flush();
  res.json({ token: issueToken(user.id), user: publicUser(user) });
});

// 上传头像（base64 JPEG）
app.post('/api/avatar', auth, (req, res) => {
  if (!needUser(req, res)) return;
  let bytes;
  try {
    bytes = Buffer.from(String(req.body.data || ''), 'base64');
  } catch { return res.status(400).json({ error: '头像数据无效' }); }
  if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES)
    return res.status(400).json({ error: '头像需为 256×256 JPEG（≤512KB）' });
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
    return res.status(400).json({ error: '头像必须是 JPEG 图片' });
  const avatarFile = path.join(AVATAR_DIR, req.user.id + '.jpg');
  fs.writeFileSync(avatarFile, bytes);
  req.user.avatar = `/api/avatar/${req.user.id}.jpg?v=${Date.now()}`;
  flush();
  res.json({ user: publicUser(req.user) });
});

// 头像文件
app.get('/api/avatar/:name', (req, res) => {
  const name = path.basename(req.params.name);
  if (!/^[a-f0-9]{24}\.jpg$/.test(name)) return res.status(404).end();
  const avatarFile = path.join(AVATAR_DIR, name);
  if (!fs.existsSync(avatarFile)) return res.status(404).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(avatarFile);
});

// 片单同步：GET 拉远端快照（合并逻辑在 APK 客户端）
app.get('/api/library', auth, (req, res) => {
  if (!needUser(req, res)) return;
  const source = String(req.query.source || '');
  if (!['hongguo', 'huangguo'].includes(source)) return res.status(400).json({ error: '无效内容来源' });
  const record = (library[req.user.id] || {})[source];
  res.json({ payload: record ? record.payload : {} });
});

// 片单同步：PUT 保存合并后快照（LWW 在客户端完成，这里只做存储）
app.put('/api/library', auth, (req, res) => {
  if (!needUser(req, res)) return;
  const source = String(req.body.source || '');
  const payload = req.body.payload;
  if (!['hongguo', 'huangguo'].includes(source)) return res.status(400).json({ error: '无效内容来源' });
  if (payload === undefined || payload === null || typeof payload !== 'object')
    return res.status(400).json({ error: '片单数据无效' });
  const raw = JSON.stringify(payload);
  if (raw.length > MAX_PAYLOAD_BYTES) return res.status(400).json({ error: '片单数据过大' });
  const row = (library[req.user.id] || (library[req.user.id] = {}));
  row[source] = { updatedAt: Date.now(), payload };
  flush();
  res.json({ synced: true, updatedAt: row[source].updatedAt });
});

// 清理过期会话（启动时执行一次）
(function pruneSessions() {
  const now = Date.now();
  let changed = false;
  for (const [token, s] of Object.entries(sessions))
    if (now - s.lastSeen > TOKEN_TTL_MS) { delete sessions[token]; changed = true; }
  if (changed) flush();
})();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`chengzi-backend listening on 0.0.0.0:${PORT}, data dir: ${DATA_DIR}`);
});

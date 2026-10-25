'use strict';
// 外から使う（iPhone）：Tailscale serve 越しの通信を見分け、合言葉でログインさせる
// 設定は <ROOT>/_hub/remote.json：{ enabled, passcodeHash, salt, host, sessions: [{ id, createdAt, lastSeen, ua }], failures: [{ at, who }] }
// 札（Cookie）はそのまま保存せず、SHA-256 にした物を id として残す（ファイルが読まれても札にはならない）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COOKIE = 'hub_session';
const DAYS30 = 30 * 86400000;
const LOCK_MS = 15 * 60000;
const LOCK_COUNT = 5; // 同じ相手から15分に5回まちがえたら止める
const LOCK_ALL = 20; // 相手を偽って試され続けないよう、全体でも15分に20回で止める
const MAX_SESSIONS = 20;
const MIN_PASS = 8;

// 中継された通信（tailscale serve など）なら外から。Mac の中の画面・アプリはこの印を付けない
const isRemote = req => ['tailscale-user-login', 'x-forwarded-for', 'x-forwarded-host'].some(h => req.headers[h] !== undefined);
// 誰からか：Tailscale のアカウント、無ければ中継元の場所
const whoOf = req => String(req.headers['tailscale-user-login'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown').slice(0, 200);
function cookieOf(req, name = COOKIE) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; } }
  }
  return '';
}
const sessionCookie = token => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DAYS30 / 1000}`;
const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

const hashOf = (pass, salt) => crypto.scryptSync(String(pass), Buffer.from(salt, 'hex'), 32).toString('hex');
const idOf = token => crypto.createHash('sha256').update(String(token)).digest('hex');
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const hostOk = host => host === '' || (text(host, 200) && /^(?=.{1,200}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?::[1-9][0-9]{0,4})?$/i.test(host) && (!host.includes(':') || Number(host.split(':').at(-1)) <= 65535));
const dateOf = value => { if (typeof value !== 'string') return NaN; const date = Date.parse(value); return Number.isFinite(date) && new Date(date).toISOString() === value ? date : NaN; };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validSession = (session, now) => plain(session) && Object.keys(session).every(k => ['id', 'createdAt', 'lastSeen', 'ua'].includes(k)) && /^[a-f0-9]{64}$/.test(session.id) && text(session.ua, 200) &&
  Number.isFinite(dateOf(session.createdAt)) && Number.isFinite(dateOf(session.lastSeen)) && dateOf(session.createdAt) >= 0 && dateOf(session.createdAt) <= dateOf(session.lastSeen) && dateOf(session.lastSeen) <= now;
const validFailure = (failure, now) => plain(failure) && Object.keys(failure).every(k => ['at', 'who'].includes(k)) && Number.isSafeInteger(failure.at) && failure.at >= 0 && failure.at <= now && text(failure.who, 200) && failure.who.length > 0;
const emptySettings = () => ({ enabled: false, passcodeHash: '', salt: '', host: '', sessions: [], failures: [] });
function normalizeSettings(raw, now) {
  if (!plain(raw) || Object.keys(raw).some(k => !['enabled', 'passcodeHash', 'salt', 'host', 'sessions', 'failures'].includes(k))) throw Error('Remote settings are invalid');
  const d = { ...emptySettings(), ...raw };
  if (typeof d.enabled !== 'boolean' || !hostOk(d.host) || !((d.passcodeHash === '' && d.salt === '') || (/^[a-f0-9]{64}$/.test(d.passcodeHash) && /^[a-f0-9]{32}$/.test(d.salt))) || (d.enabled && !d.passcodeHash) ||
      !Array.isArray(d.sessions) || d.sessions.length > MAX_SESSIONS || d.sessions.some(s => !validSession(s, now)) || new Set(d.sessions.map(s => s.id)).size !== d.sessions.length ||
      !Array.isArray(d.failures) || d.failures.length > 1000 || d.failures.some(f => !validFailure(f, now))) throw Error('Remote settings are invalid');
  return d;
}

class Remote {
  constructor({ file, now = () => Date.now() }) { this.file = file; this.now = now; this.data = null; this.invalid = false; }
  load() {
    if (this.data) return this.data;
    try { const stat = fs.statSync(this.file); if (!stat.isFile() || stat.size > 256 * 1024) throw Error('invalid'); this.data = normalizeSettings(JSON.parse(fs.readFileSync(this.file, 'utf8')), this.now()); }
    catch (error) { this.invalid = error.code !== 'ENOENT'; this.data = emptySettings(); }
    return this.data;
  }
  save() { // 書きかけを読まないよう、別の名前に書いてから置き換える。合言葉の元が入るので本人だけ読める
    if (this.invalid) throw Error('Remote settings cannot be read safely');
    normalizeSettings(this.data, this.now());
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, this.file); }
    finally { try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  prune() {
    const d = this.load(), t = this.now();
    d.sessions = d.sessions.filter(s => validSession(s, t) && t - dateOf(s.createdAt) < DAYS30);
    d.failures = d.failures.filter(f => validFailure(f, t) && t - f.at < LOCK_MS);
    return d;
  }
  // 画面に出す物（合言葉の元は出さない）
  status() {
    const d = this.prune();
    return { enabled: d.enabled, hasPasscode: Boolean(d.passcodeHash), sessions: d.sessions.map(({ id, createdAt, lastSeen, ua }) => ({ id: id.slice(0, 12), createdAt, lastSeen, ua })),
      url: d.host ? `https://${d.host}` : '', hint: 'https://<Macの名前>.<tailnet>.ts.net' };
  }
  enabled() { return this.load().enabled; }
  // 設定を変える。合言葉を変えたら、前の合言葉で入った端末はすべて出す
  update(input) {
    if (!plain(input) || Object.keys(input).some(k => !['enabled', 'passcode'].includes(k))) return { error: '形式が違います' };
    const { enabled, passcode } = input;
    const d = this.load();
    if (this.invalid) return { error: 'Remote settings cannot be read safely' };
    if (enabled !== undefined && typeof enabled !== 'boolean') return { error: '形式が違います' };
    const before = structuredClone(d);
    if (passcode !== undefined) {
      if (typeof passcode !== 'string' || [...passcode].length < MIN_PASS || passcode.length > 200) return { error: `合言葉は${MIN_PASS}文字以上にしてください` };
      d.salt = crypto.randomBytes(16).toString('hex');
      d.passcodeHash = hashOf(passcode, d.salt);
      d.sessions = []; d.failures = [];
    }
    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') return { error: '形式が違います' };
      if (enabled && !d.passcodeHash) return { error: '先に合言葉を決めてください' };
      d.enabled = enabled;
    }
    try { this.prune(); this.save(); } catch (error) { this.data = before; throw error; }
    return { ok: true };
  }
  locked(who) {
    const f = this.prune().failures;
    return f.filter(x => x.who === who).length >= LOCK_COUNT || f.length >= LOCK_ALL;
  }
  // ログイン：成功したら札（token）を返す
  login(passcode, who, ua) {
    const d = this.prune();
    if (!text(who, 200) || !who.length || (ua !== undefined && !text(ua, 200))) return { status: 400, error: '形式が違います' };
    if (!d.enabled) return { status: 403, error: '外からの利用はオフです' };
    if (this.locked(who)) return { status: 423, error: '15分待ってください' };
    let ok = false;
    if (d.passcodeHash && typeof passcode === 'string' && passcode.length <= 200) {
      const a = Buffer.from(hashOf(passcode, d.salt), 'hex'), b = Buffer.from(d.passcodeHash, 'hex');
      ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    if (!ok) {
      d.failures.push({ at: this.now(), who });
      this.save();
      return this.locked(who) ? { status: 423, error: '15分待ってください' } : { status: 401, error: '合言葉が違います' };
    }
    const before = structuredClone(d), token = crypto.randomBytes(32).toString('base64url'), at = new Date(this.now()).toISOString();
    d.failures = d.failures.filter(f => f.who !== who);
    d.sessions.push({ id: idOf(token), createdAt: at, lastSeen: at, ua: String(ua || '').slice(0, 200) });
    d.sessions = d.sessions.slice(-MAX_SESSIONS);
    try { this.save(); } catch (error) { this.data = before; throw error; }
    return { ok: true, token };
  }
  // 札が生きているか。最後に使った時刻は1分に1回だけ書く
  check(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const d = this.load(), id = idOf(token), s = d.sessions.find(x => x.id === id);
    if (!d.enabled || !s || !validSession(s, this.now()) || this.now() - dateOf(s.createdAt) >= DAYS30) return null;
    if (this.now() - dateOf(s.lastSeen) > 60000) { const previous = s.lastSeen; s.lastSeen = new Date(this.now()).toISOString(); try { this.save(); } catch { s.lastSeen = previous; return null; } }
    return s;
  }
  logout(token) { const d = this.load(), id = idOf(token), n = d.sessions.length; d.sessions = d.sessions.filter(x => x.id !== id); if (d.sessions.length !== n) this.save(); }
  logoutAll() { const d = this.load(), n = d.sessions.length; d.sessions = []; this.save(); return n; }
  noteHost(host) { const d = this.load(); if (host && hostOk(host) && d.host !== host) { const previous = d.host; d.host = host; try { this.save(); } catch { d.host = previous; } } }
}

// 外から見る小さな画面（ログイン・オフの知らせ）。本体の画面とは別に、これだけで動く
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, body) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes"><title>${esc(title)}</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;margin:0;padding:40px 20px;background:#f6f6f4;color:#222}main{max-width:360px;margin:0 auto}
h1{font-size:20px}input,button{font:inherit;width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #bbb;margin-top:10px}
button{background:#222;color:#fff;border:0}#msg{color:#b00;min-height:1.5em}@media(prefers-color-scheme:dark){body{background:#1c1c1e;color:#eee}input{background:#2c2c2e;color:#eee;border-color:#555}button{background:#eee;color:#111}}</style></head>
<body><main>${body}</main></body></html>`;
const offPage = () => page('Project Hub', '<h1>Project Hub</h1><p>外からの利用はオフです。Mac の Project Hub の設定で「外から使う（iPhone）」をオンにしてください。</p>');
const loginPage = () => page('Project Hub ログイン', `<h1>Project Hub</h1><p>Mac の設定で決めた合言葉を入れてください。</p>
<form id="f"><input id="p" type="password" autocomplete="current-password" placeholder="合言葉" required autofocus><button type="submit">ログイン</button></form><p id="msg" role="alert"></p>
<script>document.getElementById('f').onsubmit=async e=>{e.preventDefault();const m=document.getElementById('msg');m.textContent='';
try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Hub':'1'},body:JSON.stringify({passcode:document.getElementById('p').value})});
if(r.ok){location.href='/';return;}const j=await r.json().catch(()=>({}));m.textContent=j.error||'ログインできませんでした';}catch(err){m.textContent='つながりませんでした';}};</script>`);

module.exports = { Remote, isRemote, whoOf, cookieOf, sessionCookie, clearCookie, offPage, loginPage, COOKIE, MIN_PASS, LOCK_COUNT };

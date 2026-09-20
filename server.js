require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { getRouter } = require('stremio-addon-sdk');
const builder = require('./addon');
const { isValidTmdbKey } = require('./utils/tmdb');

const ALL_PROVIDERS = [
  { key: '4khdhub', label: '4KHDHub', desc: 'High-quality movies & TV (Google Drive hosts)' },
  { key: 'hdhub4u', label: 'HDHub4u', desc: 'Movies & TV (direct HTTP) ' },
  { key: '111477', label: '111477', desc: ' opendir file host (movies, tv, kdrama)' },
  { key: 'videasy', label: 'Videasy', desc: 'Multi-provider embeds (Yoru/Breach/Omen)' },
  { key: 'castle', label: 'Castle', desc: 'Multi-language movies & TV (AES-CBC api)' },
  { key: 'showbox', label: 'ShowBox (FebBox)', desc: 'Needs your FebBox ui cookie. JWT from febbox.com after login.' },
  { key: 'netmirror', label: 'Netmirror', desc: 'HLS via the Netmirror NewTV API (Netflix / Prime Video / Hotstar).' },
  { key: 'playimdb', label: 'PlayIMDb', desc: 'Multi-resolution HLS (vaplayer)' },
  { key: 'movix', label: 'Movix', desc: 'HLS streams (finepulfe resolver)' },
  { key: 'purstream', label: 'Purstream', desc: 'HLS streams (same resolver as Movix)' },
  { key: 'einthusan', label: 'Einthusan', desc: 'Indian-language films (Hindi, Tamil, Telugu, Malayalam, Kannada, Bengali)' },
  { key: 'animezey', label: 'Animezey', desc: 'Anime with multi-language options' },
  { key: 'topcartoons', label: 'TopCartoons', desc: 'Cartoons and animation' },
];

const app = express();
app.use(cors());
app.use(express.json());

// ---------- JWT shape check (no upstream call) ----------
function isFebboxJwtShape(ck) {
  if (!ck) return false;
  let t = String(ck).trim();
  if (t.toLowerCase().startsWith('ui=')) t = t.slice(3);
  try { t = decodeURIComponent(t); } catch (e) {}
  if (t.toLowerCase().startsWith('ui=')) t = t.slice(3);
  const parts = t.split('.');
  if (parts.length !== 3) return false;
  try {
    const h = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return h && h.alg && p && typeof p.exp === 'number' && p.exp * 1000 > Date.now();
  } catch (e) { return false; }
}

// ---------- Parse user config out of URL ----------
// Config rides in the query string: `/?providers=4khdhub,videasy&cookie=eyJ...`
// (query works for /manifest.json too — the SDK router does not support config
// path segments before /manifest.json).
function configFromRequest(req) {
  const q = req.query || {};
  const out = {};
  const VALID_KEYS = new Set(ALL_PROVIDERS.map(p => p.key));
  if (q.cookie) {
    let c = String(q.cookie);
    try { c = decodeURIComponent(c); } catch (e) {}
    out.cookie = c;
  }
  if (q.providers) {
    const keys = String(q.providers).split(',').map(s => s.trim().toLowerCase()).filter(k => VALID_KEYS.has(k));
    if (keys.length) out.providers = keys;
  }
  if (q.region) out.region = String(q.region).toUpperCase();
  // Optional user-supplied TMDB credential (v3 32-hex key or v4 JWT token)
  const rawTmdb = q.tmdbKey || q.tmdbkey || q.tmdb;
  if (rawTmdb) {
    let t = String(rawTmdb).trim();
    try { t = decodeURIComponent(t); } catch (e) {}
    if (isValidTmdbKey(t)) out.tmdbKey = t;
  }
  return out;
}

// Also accept config as PATH segments, which is what Stremio uses when the user
// presses "Configure" on an installed addon: /providers=showbox/cookie=eyJ.../configure
function configFromPath(req) {
  const out = {};
  const segs = String(req.path || '').split('/').filter(Boolean);
  for (const seg of segs) {
    const i = seg.indexOf('=');
    if (i < 1) continue;
    const k = seg.slice(0, i);
    let v = seg.slice(i + 1);
    try { v = decodeURIComponent(v); } catch (e) {}
    out[k] = v;
  }
  return out;
}

// Populate request-scoped config
app.use((req, res, next) => {
  const config = Object.assign({}, configFromRequest(req), configFromPath(req));
  // Path segments arrive unvalidated: normalise/drop a bad TMDB credential so a
  // malformed key can never reach the TMDB calls (it would 401 silently).
  const rawTmdb = config.tmdbKey || config.tmdbkey || config.tmdb;
  delete config.tmdbkey;
  delete config.tmdb;
  if (rawTmdb !== undefined) {
    const t = String(rawTmdb).trim();
    if (isValidTmdbKey(t)) config.tmdbKey = t; else delete config.tmdbKey;
  }
  // The stremio-addon-sdk router derives a catalog request's `extra` from
  // `req.url.split('/').pop()` — which includes the query string — so any config
  // param riding along (`?providers=...`, `?tmdbKey=...`) replaces the search
  // term with garbage and returns an empty catalog. Config is already captured
  // above (and reachable per-request), and routing only needs the path, so drop
  // the query string for resource requests before the SDK router parses it.
  if (req.query && Object.keys(req.query).length && /^\/(catalog|stream|meta|subtitles|addon_catalog)\//.test(req.path)) {
    req.url = req.path;
  }
  global.currentRequestConfig = config;
  req.nuvioConfig = config;
  next();
});

// ---------- Configure page + install flow ----------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderPage(prefill) {
  prefill = prefill || {};
  const VALID_KEYS = ALL_PROVIDERS.map(p => p.key);
  const picked = (Array.isArray(prefill.providers) ? prefill.providers : String(prefill.providers || '').split(','))
    .map(s => String(s).trim().toLowerCase()).filter(k => VALID_KEYS.includes(k));
  const cookieVal = esc(prefill.cookie || '');
  const tmdbVal = esc(prefill.tmdbKey || '');
  // The FebBox cookie box is injected directly under the ShowBox row (see the
  // provider map below) so the dependency is visually obvious. It is always in
  // the DOM — never JS-gated, so a prefilled or filtered element can't go
  // missing — but visually collapsed until ShowBox is picked (or a cookie is
  // already present). Ids are preserved for the validation JS.
  const cookieBoxHtml = `
  <div class="cookiewrap" id="cookieWrap">
  <div class="box cookiebox" id="febBoxBox">
    <label for="fbToken"><b>FebBox cookie <span id="ckTag" class="tag">— needed only for ShowBox</span></b></label>
    <p class="sub" style="margin:6px 0 10px">ShowBox streams come from FebBox and need your own cookie (each FebBox account gets 100GB/month before speeds are throttled). Log in to <a href="https://www.febbox.com" target="_blank" rel="noopener">febbox.com</a>, open DevTools (F12) → Application → Cookies, copy the value of <code>ui</code>, and paste it below. Leave it blank if you don't want ShowBox.</p>
    <input type="text" id="fbToken" value="${cookieVal}" placeholder="eyJhbG...NiIs...  (the ui= cookie value)" autocomplete="off" spellcheck="false">
    <div class="ok" id="msgGood">✓ Cookie looks valid.</div>
    <div class="err" id="msgBad">This doesn't look like a FebBox cookie — it must be a JWT (three dot-separated parts) that hasn't expired.</div>
    <div class="warn" id="msgWarn">ShowBox is selected but no valid cookie was entered — ShowBox will fail or be skipped until you paste a good one.</div>
  </div>
  </div>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>LovePeaceKarma — Configure</title>
<style>
  *{box-sizing:border-box}
  :root{--accent:#a855f7;--accent2:#7c3aed;--bg:#0a0a0f;--border:rgba(255,255,255,.08);--txt:#e7e7ea;--muted:#8b8b96}
  html,body{margin:0;padding:0}
  body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:var(--bg);color:var(--txt);min-height:100vh;padding:48px 16px;overflow-x:hidden}
  body::before{content:'';position:fixed;inset:0;z-index:0;pointer-events:none;
    background:radial-gradient(640px 420px at 18% -4%,rgba(168,85,247,.16),transparent 62%),
               radial-gradient(540px 380px at 88% 104%,rgba(124,58,237,.11),transparent 62%)}
  .wrap{position:relative;z-index:1;max-width:660px;margin:0 auto}
  h1{margin:0 0 4px;font-size:30px;font-weight:700;letter-spacing:-.02em;
    background:linear-gradient(92deg,#f5f3ff 10%,#c4b5fd 55%,#a855f7 95%);-webkit-background-clip:text;background-clip:text;color:transparent}
  .sub{color:var(--muted);margin:0 0 24px;font-size:14px;line-height:1.55}
  .card{background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:16px;padding:24px;
    box-shadow:0 8px 40px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.05)}
  .box{border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:22px;background:rgba(255,255,255,.02)}
  label b{font-size:14px}
  .tag{color:var(--accent);font-weight:500;font-size:12.5px}
  h3{margin:0 0 12px;font-size:15px;letter-spacing:.01em;color:#d6d3e0}
  .provider{display:flex;align-items:flex-start;gap:12px;padding:13px 16px;border:1px solid var(--border);border-radius:12px;
    margin-bottom:10px;cursor:pointer;background:rgba(255,255,255,.02);transition:border-color .18s,background .18s,box-shadow .18s,transform .18s;position:relative}
  .provider:hover{border-color:rgba(168,85,247,.45);background:rgba(168,85,247,.05);transform:translateY(-1px)}
  .provider.checked{border-color:rgba(168,85,247,.7);background:rgba(168,85,247,.09);
    box-shadow:0 0 0 1px rgba(168,85,247,.25),0 4px 24px rgba(168,85,247,.12)}
  .provider input{position:absolute;opacity:0;pointer-events:none}
  .cb{width:20px;height:20px;border-radius:6px;border:1.5px solid rgba(255,255,255,.28);flex-shrink:0;margin-top:1px;
    display:grid;place-items:center;transition:background .15s,border-color .15s}
  .cb::after{content:'';width:9px;height:5px;border-left:2px solid #fff;border-bottom:2px solid #fff;
    transform:rotate(-45deg) scale(0);transform-origin:center;transition:transform .15s;margin-top:-2px}
  .provider.checked .cb{background:linear-gradient(135deg,var(--accent),var(--accent2));border-color:transparent}
  .provider.checked .cb::after{transform:rotate(-45deg) scale(1)}
  .ptext b{display:block;font-size:14.5px}
  .ptext small{color:var(--muted);font-size:12.5px;line-height:1.45}
  input[type=text]{width:100%;padding:12px 14px;background:rgba(0,0,0,.35);border:1px solid var(--border);border-radius:10px;
    color:var(--txt);font-size:13.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;outline:none;transition:border-color .15s,box-shadow .15s}
  input[type=text]:focus{border-color:rgba(168,85,247,.6);box-shadow:0 0 0 3px rgba(168,85,247,.15),0 0 24px rgba(168,85,247,.1)}
  input[type=text]::placeholder{color:#55555f}
  button{background:linear-gradient(135deg,#a855f7,#7c3aed);color:#fff;border:none;padding:14px 18px;border-radius:12px;
    font-size:15px;font-weight:600;cursor:pointer;margin-top:20px;width:100%;letter-spacing:.01em;
    transition:transform .18s,box-shadow .18s,filter .18s;box-shadow:0 4px 24px rgba(168,85,247,.25)}
  button:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 6px 32px rgba(168,85,247,.4);filter:brightness(1.08)}
  button:active:not(:disabled){transform:translateY(0)}
  button:disabled{background:rgba(255,255,255,.06);color:#66666f;box-shadow:none;cursor:not-allowed}
  .urlout{margin-top:16px;word-break:break-all;background:rgba(0,0,0,.35);border:1px solid var(--border);padding:12px 14px;
    border-radius:10px;display:none;align-items:flex-start;gap:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;color:#c4b5fd}
  .urlout span{flex:1;line-height:1.5}
  .copybtn{flex-shrink:0;width:auto;margin:0;padding:6px 12px;border-radius:8px;font-size:12px;font-weight:600;
    background:rgba(168,85,247,.15);border:1px solid rgba(168,85,247,.4);color:#d8b4fe;box-shadow:none}
  .copybtn:hover{background:rgba(168,85,247,.28);transform:none;filter:none}
  .err{color:#f87171;display:none;margin-top:10px;font-size:13px}
  .ok{color:#4ade80;display:none;margin-top:8px;font-size:13px}
  .warn{color:#fbbf24;display:none;margin-top:8px;font-size:13px}
  .stamp{color:#55555f;font-size:11px;margin-top:16px;letter-spacing:.04em}
  /* FebBox cookie box sits directly under the ShowBox row, indented + accent rail
     so it reads as a child of that option. Collapsed (max-height 0) until ShowBox
     is picked or a cookie is already present; overflow:hidden is required for the
     max-height animation, so the accent uses inset shadows (never clipped). */
  .cookiewrap{max-height:0;opacity:0;overflow:hidden;margin:0;padding-top:0;
    transition:max-height .3s ease,opacity .22s ease,margin .3s ease}
  .cookiewrap.open{max-height:640px;opacity:1;margin:-2px 0 10px 34px}
  .cookiebox{border-left:2px solid rgba(255,255,255,.14);border-radius:2px 12px 12px 2px;background:rgba(255,255,255,.025);margin:0}
  .provider.checked + .cookiewrap .cookiebox{border-left-color:rgba(168,85,247,.75);
    box-shadow:inset 3px 0 0 rgba(168,85,247,.3),inset 0 0 26px rgba(168,85,247,.07)}
  @media(max-width:520px){.cookiewrap.open{margin-left:0}}
  code{background:rgba(255,255,255,.06);padding:1px 5px;border-radius:5px;font-size:12.5px}
  a{color:#c4b5fd}
</style></head>
<body>
<div class="wrap">
<h1>LovePeaceKarma</h1>
<p class="sub">Direct HTTP streams from the sources you select. Metadata from TMDB.</p>
<div class="card">
<form id="f">
  <div class="box" id="tmdbBox">
    <label for="tmdbKey"><b>TMDB API key <span class="tag">— optional</span></b></label>
    <p class="sub" style="margin:6px 0 10px">Catalog search and every source that resolves titles use TMDB. This addon ships with a shared key that is rate-limited — paste your own (free) to avoid "no streams" timeouts. Get one at <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">themoviedb.org/settings/api</a> → API Key (v3 auth), a 32-character hex string. A v4 Read Access Token also works. Leave blank to use the shared key.</p>
    <input type="text" id="tmdbKey" value="${tmdbVal}" placeholder="e.g. 439c478a771f35c05022f9feabcca01c" autocomplete="off" spellcheck="false">
    <div class="ok" id="tmdbGood">✓ TMDB key looks valid — it will be used for search and title lookups.</div>
    <div class="err" id="tmdbBad">That doesn't look like a TMDB key — v3 keys are 32 hex characters. Paste the "API Key (v3 auth)" value.</div>
  </div>
  <h3>Choose your sources</h3>
  <div id="provs">
    ${ALL_PROVIDERS.map(p => `
    <label class="provider" data-key="${p.key}">
      <input type="checkbox" name="providers" value="${p.key}"${picked.includes(p.key) ? ' checked' : ''}>
      <span class="cb" aria-hidden="true"></span>
      <span class="ptext"><b>${p.label}</b><small>${p.desc}</small></span>
    </label>${p.key === 'showbox' ? cookieBoxHtml : ''}`).join('')}
  </div>
  <button type="submit" id="installBtn" disabled>Select at least one source</button>
  <div class="urlout" id="urlout"><span id="urltext"></span><button type="button" class="copybtn" id="copyBtn">Copy</button></div>
  <p class="sub" id="finalHint" style="display:none;margin-top:8px;margin-bottom:0">Copy the URL above and paste it into Stremio → Addons → Add URL.</p>
  <p class="stamp">configure build: cookie-collapse-under-showbox-2026-09-20</p>
</form>
</div>
</div>
<script>
  const boxes=[...document.querySelectorAll('input[name=providers]')];
  const febBoxBox=document.getElementById('febBoxBox');
  const fbTokenInput=document.getElementById('fbToken');
  const msgBad=document.getElementById('msgBad');
  const msgGood=document.getElementById('msgGood');
  const msgWarn=document.getElementById('msgWarn');
  const btn=document.getElementById('installBtn');
  const out=document.getElementById('urlout');
  const hint=document.getElementById('finalHint');
  const tmdbInput=document.getElementById('tmdbKey');
  const tmdbGood=document.getElementById('tmdbGood');
  const tmdbBad=document.getElementById('tmdbBad');
  // v3 key = 32 hex chars; v4 read access token = JWT
  const isTmdbKey=t=>{t=(t||'').trim();if(!t)return false;
    if(/^[0-9a-f]{32}$/i.test(t))return true;
    return /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t)};
  const isJwt=t=>{if(!t)return false;t=t.trim();if(t.toLowerCase().startsWith('ui='))t=t.slice(3);try{t=decodeURIComponent(t)}catch(e){}if(t.toLowerCase().startsWith('ui='))t.slice(3);const p=t.split('.');if(p.length!==3)return false;try{JSON.parse(atob(p[0].replace(/-/g,'+').replace(/_/g,'/')));JSON.parse(atob(p[1].replace(/-/g,'+').replace(/_/g,'/')));return true}catch(e){return false}};
  function refresh(){
    boxes.forEach(b=>b.closest('.provider').classList.toggle('checked',b.checked));
    const any=boxes.some(b=>b.checked);
    const showbox=document.querySelector('input[value=showbox]').checked;
    // The cookie box is ALWAYS on the page (rendered above the source list, never JS-gated).
    const tag=document.getElementById('ckTag');
    if(tag) tag.textContent=showbox?'(required — ShowBox is selected)':'— needed only for ShowBox';
    const has=fbTokenInput.value.trim().length>0;
    const valid=isJwt(fbTokenInput.value);
    msgBad.style.display=(has&&!valid)?'block':'none';
    msgGood.style.display=valid?'block':'none';
    msgWarn.style.display=(showbox&&!valid)?'block':'none';
    // Collapsed until ShowBox is picked — but stay open if a cookie is already
    // present (prefilled from the install URL, or typed then ShowBox unticked).
    const wrap=document.getElementById('cookieWrap');
    if(wrap) wrap.classList.toggle('open', showbox || has);
    // TMDB key is optional; only complain when something was actually typed
    const thas=tmdbInput.value.trim().length>0;
    const tvalid=isTmdbKey(tmdbInput.value);
    tmdbBad.style.display=(thas&&!tvalid)?'block':'none';
    tmdbGood.style.display=tvalid?'block':'none';
    btn.disabled=!any;
    btn.textContent=any?('Install with '+boxes.filter(b=>b.checked).length+' source(s)'):'Select at least one source';
  }
  boxes.forEach(b=>b.addEventListener('change',()=>{
    b.closest('.provider').classList.toggle('checked',b.checked);
    refresh();
    // The cookie box now sits under the ShowBox row and expands from zero height:
    // if the row is near the fold the box would grow straight off-screen, so park
    // its top around a quarter down the viewport (scrollIntoView smooth is
    // unreliable in webviews, so use window.scrollTo).
    if(b.value==='showbox'&&b.checked){
      const el=document.getElementById('cookieWrap');
      const r=el?el.getBoundingClientRect():null;
      if(r&&(r.top<60||r.bottom>window.innerHeight-140)){
        window.scrollTo({top:window.scrollY+r.top-Math.min(200,window.innerHeight*0.25),behavior:'auto'});
      }
    }
  }));
  fbTokenInput.addEventListener('input',refresh);
  tmdbInput.addEventListener('input',refresh);
  document.getElementById('f').addEventListener('submit',e=>{
    e.preventDefault();
    const configParts=[];
    const picks=boxes.filter(b=>b.checked).map(b=>b.value);
    if(picks.length)configParts.push('providers='+picks.join(','));
    if(document.querySelector('input[value=showbox]').checked)configParts.push('cookie='+encodeURIComponent(fbTokenInput.value.trim()));
    const tk=tmdbInput.value.trim();
    if(isTmdbKey(tk))configParts.push('tmdbKey='+encodeURIComponent(tk));
    const url=location.origin+'/manifest.json?'+configParts.join('&');
    document.getElementById('urltext').textContent=url;
    out.style.display='flex';
    hint.style.display='block';
  });
  document.getElementById('copyBtn').addEventListener('click',async()=>{
    const btn=document.getElementById('copyBtn');
    try{await navigator.clipboard.writeText(document.getElementById('urltext').textContent);btn.textContent='Copied ✓'}
    catch(e){
      const r=document.createRange();r.selectNodeContents(document.getElementById('urltext'));
      const s=getSelection();s.removeAllRanges();s.addRange(r);document.execCommand('copy');s.removeAllRanges();
      btn.textContent='Copied ✓';
    }
    setTimeout(()=>btn.textContent='Copy',1600);
  });
  refresh();
</script>
</body></html>`;
}

// Landing / configure page — matches "/", "/configure", and Stremio's
// path-segment form "/providers=showbox/cookie=eyJ.../configure"
function serveConfigurePage(req, res) {
  res.set('Content-Type', 'text/html; charset=utf-8');
  // Never let browsers or the CDN serve a stale configure page
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(renderPage(req.nuvioConfig || {}));
}
app.get('/', serveConfigurePage);
app.get(/^\/(?:.*\/)?configure\/?$/, serveConfigurePage);

// Bare manifest (no config) -> force the configure page instead of serving a manifest
const addonInterface = builder.getInterface();
const router = getRouter(addonInterface);
app.use((req, res, next) => {
  const isManifest = req.path === '/manifest.json' || req.path.endsWith('/manifest.json');
  // A TMDB key alone is not a usable install: without a provider/cookie choice
  // the user would get server defaults, so keep sending them to the picker.
  const hasConfig = Object.keys(req.nuvioConfig || {}).some(k => k !== 'tmdbKey');
  if (isManifest && !hasConfig) {
    return res.redirect('/configure');
  }
  next();
});
app.use(router);

const port = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(port, () => console.log(`LovePeaceKarma listening on :${port}`));
}

module.exports = app;

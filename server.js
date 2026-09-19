require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { getRouter } = require('stremio-addon-sdk');
const builder = require('./addon');

const ALL_PROVIDERS = [
  { key: '4khdhub', label: '4KHDHub', desc: 'High-quality movies & TV (Google Drive hosts)' },
  { key: 'hdhub4u', label: 'HDHub4u', desc: 'Movies & TV (direct HTTP) ' },
  { key: '111477', label: '111477', desc: ' opendir file host (movies, tv, kdrama)' },
  { key: 'videasy', label: 'Videasy', desc: 'Multi-provider embeds (Yoru/Breach/Omen)' },
  { key: 'castle', label: 'Castle', desc: 'Multi-language movies & TV (AES-CBC api)' },
  { key: 'showbox', label: 'ShowBox (FebBox)', desc: 'Needs your FebBox ui cookie. JWT from febbox.com after login.' },
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
  return out;
}

// Populate request-scoped config
app.use((req, res, next) => {
  const config = configFromRequest(req);
  global.currentRequestConfig = config;
  req.nuvioConfig = config;
  next();
});

// ---------- Configure page + install flow ----------
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>LovePeaceKarma — Configure</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#222}
  h1{color:#8e24aa;margin-bottom:4px}
  .sub{color:#666;margin-bottom:24px}
  .provider{display:flex;align-items:flex-start;gap:10px;padding:12px 14px;border:1px solid #e3e3e3;border-radius:8px;margin-bottom:10px}
  .provider.checked{border-color:#8e24aa;background:#faf6fb}
  .provider input{margin-top:4px;width:18px;height:18px}
  .provider b{display:block}
  .provider small{color:#777}
  input[type=text]{width:100%;padding:10px;border:1px solid #ccc;border-radius:6px;font-size:14px;box-sizing:border-box}
  button{background:#8e24aa;color:#fff;border:none;padding:12px 18px;border-radius:6px;font-size:15px;cursor:pointer;margin-top:16px}
  button:disabled{background:#bbb;cursor:not-allowed}
  .urlout{margin-top:16px;word-break:break-all;background:#f4f4f4;padding:10px;border-radius:6px;display:none}
  .err{color:#c62828;display:none;margin-top:10px}
  label,.cookie{font-size:14px}
</style></head>
<body>
<h1>LovePeaceKarma</h1>
<p class="sub">Direct HTTP streams from the sources you select. Metadata from TMDB.</p>
<form id="f">
  <h3 style="margin-bottom:10px">Choose your sources</h3>
  <div id="provs">
    ${ALL_PROVIDERS.map(p => `
    <label class="provider" data-key="${p.key}">
      <input type="checkbox" name="providers" value="${p.key}">
      <span><b>${p.label}</b><small>${p.desc}</small></span>
    </label>`).join('')}
  </div>
  <div class="cookie" id="cookieBlock" style="margin-top:16px">
    <label><b>FebBox cookie <span id="ckTag" style="color:#8e24aa">(used only when ShowBox is selected)</span></b></label>
    <p class="sub" style="margin:6px 0 10px">Log in to <a href="https://www.febbox.com" target="_blank">febbox.com</a>, open DevTools → Application → Cookies, copy the value of <code>ui</code> and paste it below. Leave empty if you did not pick ShowBox.</p>
    <input type="text" id="cookie" placeholder="eyJhbG...NiIs... (the ui= cookie value)">
    <div class="err" id="cookieErr">Please enter a valid FebBox cookie (a JWT — three dots-separated base64 parts, not expired).</div>
  </div>
  <button type="submit" id="installBtn" disabled>Select at least one source</button>
  <div class="urlout" id="urlout"></div>
  <p class="sub" id="finalHint" style="display:none;margin-top:8px">Copy the URL above and paste it into Stremio → Addons → Add URL.</p>
</form>
<script>
  const boxes=[...document.querySelectorAll('input[name=providers]')];
  const cookieBlock=document.getElementById('cookieBlock');
  const cookieInput=document.getElementById('cookie');
  const cookieErr=document.getElementById('cookieErr');
  const btn=document.getElementById('installBtn');
  const out=document.getElementById('urlout');
  const hint=document.getElementById('finalHint');
  const isJwt=t=>{if(!t)return false;t=t.trim();if(t.toLowerCase().startsWith('ui='))t=t.slice(3);try{t=decodeURIComponent(t)}catch(e){}if(t.toLowerCase().startsWith('ui='))t.slice(3);const p=t.split('.');if(p.length!==3)return false;try{JSON.parse(atob(p[0].replace(/-/g,'+').replace(/_/g,'/')));JSON.parse(atob(p[1].replace(/-/g,'+').replace(/_/g,'/')));return true}catch(e){return false}};
  function refresh(){
    const any=boxes.some(b=>b.checked);
    const showbox=document.querySelector('input[value=showbox]').checked;
    // cookie box is ALWAYS visible (never JS-gated) — only its emphasis changes
    cookieBlock.style.borderLeft=showbox?'4px solid #8e24aa':'none';
    cookieBlock.style.paddingLeft=showbox?'12px':'0';
    const tag=document.getElementById('ckTag');
    if(tag) tag.textContent=showbox?'(required — ShowBox is selected)':'(used only when ShowBox is selected)';
    const ckOk=!showbox||isJwt(cookieInput.value);
    cookieErr.style.display=(showbox&&cookieInput.value&&!ckOk)?'block':'none';
    btn.disabled=!(any&&ckOk);
    btn.textContent=!any?'Select at least one source':(showbox&&!ckOk?'Enter a valid FebBox cookie to continue':(any&&showbox?'Install with '+boxes.filter(b=>b.checked).length+' source(s)':'Install'));
  }
  boxes.forEach(b=>b.addEventListener('change',()=>{b.closest('.provider').classList.toggle('checked',b.checked);refresh();if(b.checked&&b.value==='showbox'){try{cookieBlock.scrollIntoView({behavior:'smooth',block:'center'})}catch(e){}}}));
  cookieInput.addEventListener('input',refresh);
  document.getElementById('f').addEventListener('submit',e=>{
    e.preventDefault();
    const configParts=[];
    const picks=boxes.filter(b=>b.checked).map(b=>b.value);
    if(picks.length)configParts.push('providers='+picks.join(','));
    if(document.querySelector('input[value=showbox]').checked)configParts.push('cookie='+encodeURIComponent(cookieInput.value.trim()));
    const url=location.origin+'/manifest.json?'+configParts.join('&');
    out.textContent=url;
    out.style.display='block';
    hint.style.display='block';
  });
  refresh();
</script>
</body></html>`;

// Landing / configure page
app.get(['/', '/configure'], (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  // Never let browsers or the CDN serve a stale configure page
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(PAGE);
});

// Bare manifest (no config) -> force the configure page instead of serving a manifest
const addonInterface = builder.getInterface();
const router = getRouter(addonInterface);
app.use((req, res, next) => {
  const isManifest = req.path === '/manifest.json' || req.path.endsWith('/manifest.json');
  const hasConfig = Object.keys(req.nuvioConfig || {}).length > 0;
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

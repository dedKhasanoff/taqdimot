const GROUP_IDS = ['101','102','103','104','105','106','107','108','109','110'];
const MAX_BYTES = 20 * 1048576;
const MIME = {
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};
const app = document.getElementById('app');
const q = document.getElementById('q');
const authEl = document.getElementById('auth');
const cfg = window.TAQDIMOT_CONFIG || {};
const BUCKET = cfg.bucket || 'taqdimotlar';

let sb = null;           // Supabase client
let items = [];          // all presentations
let dbState = 'loading'; // loading | ok | error | unconfigured
let user = null;         // signed-in Supabase user
let isAdmin = false;
let formState = {msg:'', err:false, busy:false};
let loginState = {msg:'', err:false, busy:false};

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const plural = n => n === 0 ? "Taqdimot yo'q" : n + " ta taqdimot";
const byGroup = g => items.filter(p => p.group === g);
const mb = n => (n / 1048576).toFixed(1) + ' MB';
const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2,'0')).join(''));
const ext = name => (String(name).split('.').pop() || '').toLowerCase();

function publicUrl(path, downloadName){
  const opts = downloadName ? {download: downloadName} : undefined;
  return sb.storage.from(BUCKET).getPublicUrl(path, opts).data.publicUrl;
}

const OFFICE_LIMIT = 10 * 1048576; // Office web viewer opens PowerPoint files up to ~10 MB
const viewHash = (p, kind) => '#korish/' + p.id + '/' + kind;
const officeUrl = url => 'https://view.officeapps.live.com/op/embed.aspx?src=' + encodeURIComponent(url);
// Phones often can't show a PDF inside a frame; Google's viewer can.
const pdfUrl = url => navigator.pdfViewerEnabled === false
  ? 'https://docs.google.com/gview?embedded=1&url=' + encodeURIComponent(url) : url;

function fileLinks(p){
  const files = (p.files || []).slice().sort((a, b) => a.kind === 'pptx' ? -1 : b.kind === 'pptx' ? 1 : 0);
  return files.map((f, i) => `<a class="btn${i ? ' ghost' : ''}" href="${viewHash(p, f.kind)}">${f.kind === 'pptx' ? 'Slaydlarni ko\'rish' : 'PDF ko\'rish'}</a>`).join('');
}
function presCard(p, showGroup){
  return `<article class="pres">
    <h3>${esc(p.title)}</h3>
    <div class="by">${esc(p.student)}${showGroup ? ' · ' + esc(p.group) + '-guruh' : ''}</div>
    <div class="files">${fileLinks(p)}</div>
    ${isAdmin ? `<button class="btn danger del" type="button" data-del="${esc(p.id)}">O'chirish</button>` : ''}
  </article>`;
}
function banner(){
  if(dbState === 'loading') return `<p class="note">Taqdimotlar yuklanmoqda…</p>`;
  if(dbState === 'unconfigured') return `<p class="note">Sayt hali sozlanmagan: config.js faylida Supabase manzili va kalitini kiriting.</p>`;
  if(dbState === 'error') return `<p class="note">Taqdimotlarni yuklab bo'lmadi. Sahifani yangilab ko'ring.</p>`;
  return '';
}

function renderAuth(){
  if(!sb){ authEl.innerHTML = ''; return; }
  authEl.innerHTML = user
    ? `<div class="authbar"><span>${esc(user.email)}${isAdmin ? ' · admin' : ''}</span><button class="btn ghost" type="button" id="logout">Chiqish</button></div>`
    : `<div class="authbar"><a class="btn ghost" href="#kirish">Kirish</a></div>`;
}

function home(){
  const term = q.value.trim().toLowerCase();
  if(term) return search(term);
  app.innerHTML = `
    <h1>Guruhlar bo'yicha taqdimotlar</h1>
    <p class="lead">Guruhingizni tanlang va o'quvchilar tayyorlagan taqdimotlarni oching.</p>` + banner() + `
    <div class="grid" style="margin-top:24px">` + GROUP_IDS.map(g => `
      <a class="card" href="#guruh-${g}">
        <div class="num">${g}</div>
        <div class="name">${g}-guruh</div>
        <span class="count">${plural(byGroup(g).length)}</span>
      </a>`).join('') + `</div>`;
}
function uploadForm(g){
  return `<form class="upload" id="up" autocomplete="off">
    <h2>${g}-guruhga taqdimot qo'shish</h2>
    <label class="field">Taqdimot nomi<input type="text" id="up-title" required maxlength="200"></label>
    <label class="field">O'quvchi ismi<input type="text" id="up-student" required maxlength="120"></label>
    <label class="field">PDF fayl<input type="file" id="up-pdf" accept=".pdf,application/pdf"><small>20 MB gacha</small></label>
    <label class="field">PPTX fayl<input type="file" id="up-pptx" accept=".pptx,${MIME.pptx}"><small>20 MB gacha</small></label>
    <div class="actions">
      <button class="btn" type="submit" id="up-btn"${formState.busy ? ' disabled' : ''}>Yuklash</button>
      <span class="status${formState.err ? ' err' : ''}" id="up-status" role="status">${esc(formState.msg)}</span>
    </div>
  </form>`;
}
function group(g){
  const list = byGroup(g);
  app.innerHTML = `
    <a class="back" href="#">← Barcha guruhlar</a>
    <h1>${g}-guruh</h1>
    <p class="lead">${plural(list.length)}</p>` + banner() +
    (list.length ? `<div class="list">${list.map(p => presCard(p)).join('')}</div>`
                 : (dbState === 'ok' ? `<div class="empty">Bu guruhdan hali taqdimot qo'shilmagan.</div>` : '')) +
    (isAdmin ? uploadForm(g) : '');
  const f = document.getElementById('up');
  if(f) f.addEventListener('submit', e => { e.preventDefault(); submitUpload(g); });
}
function search(term){
  const hits = items.filter(p => (p.title + ' ' + p.student + ' ' + p.group).toLowerCase().includes(term));
  app.innerHTML = `<h1>Qidiruv natijalari</h1><p class="lead">${hits.length} ta topildi</p>` +
    (hits.length ? `<div class="list">${hits.map(p => presCard(p, true)).join('')}</div>`
                 : `<div class="empty">Hech narsa topilmadi. Boshqa so'z bilan urinib ko'ring.</div>`);
}
function login(){
  if(user){ location.hash = ''; return; }
  app.innerHTML = `
    <a class="back" href="#">← Barcha guruhlar</a>
    <h1>Admin kirishi</h1>
    <p class="lead">Taqdimot qo'shish va o'chirish faqat admin uchun. Ko'rish uchun kirish shart emas.</p>
    <form class="login" id="login-form">
      <label class="field">Email<input type="email" id="li-email" required autocomplete="username"></label>
      <label class="field">Parol<input type="password" id="li-pass" required autocomplete="current-password"></label>
      <div class="actions" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
        <button class="btn" type="submit"${loginState.busy ? ' disabled' : ''}>Kirish</button>
        <span class="status${loginState.err ? ' err' : ''}" role="status">${esc(loginState.msg)}</span>
      </div>
    </form>`;
  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    if(!sb) return;
    loginState = {msg:'Tekshirilmoqda…', err:false, busy:true};
    const email = document.getElementById('li-email').value.trim();
    const password = document.getElementById('li-pass').value;
    login(); document.getElementById('li-email').value = email;
    const { error } = await sb.auth.signInWithPassword({email, password});
    if(error){
      loginState = {msg:"Email yoki parol noto'g'ri.", err:true, busy:false};
      login(); document.getElementById('li-email').value = email;
      return;
    }
    loginState = {msg:'', err:false, busy:false};
    location.hash = '';
  });
}

let viewKey = null;
function viewer(id, kind){
  const p = items.find(x => x.id === id);
  if(!p){
    viewKey = null;
    app.innerHTML = `<a class="back" href="#">← Barcha guruhlar</a>` +
      (dbState === 'ok' ? `<div class="empty" style="margin-top:24px">Bu taqdimot topilmadi yoki o'chirilgan.</div>` : banner());
    return;
  }
  const f = (p.files || []).find(x => x.kind === kind) || (p.files || [])[0];
  const key = p.id + '/' + f.kind;
  if(viewKey === key && document.getElementById('viewer')) return; // keep the frame, don't reload slides
  viewKey = key;
  const url = publicUrl(f.path);
  const tooBig = f.kind === 'pptx' && f.size > OFFICE_LIMIT;
  const src = f.kind === 'pptx' ? officeUrl(url) : pdfUrl(url);
  const tabs = (p.files || []).length > 1 ? (p.files || []).slice().sort((a, b) => a.kind === 'pptx' ? -1 : 1).map(x =>
    `<a class="btn${x.kind === f.kind ? '' : ' ghost'}" href="${viewHash(p, x.kind)}">${x.kind === 'pptx' ? 'Slaydlar' : 'PDF'}</a>`).join('') : '';
  app.innerHTML = `
    <a class="back" href="#guruh-${esc(p.group)}">← ${esc(p.group)}-guruh</a>
    <h1 style="margin-top:20px">${esc(p.title)}</h1>
    <p class="lead" style="margin-bottom:16px">${esc(p.student)} · ${esc(p.group)}-guruh</p>
    <div class="viewbar">${tabs}
      <button class="btn ghost" type="button" id="fs">To'liq ekran</button>
      <a class="btn ghost" href="${esc(publicUrl(f.path, f.name))}">Yuklab olish (${f.kind.toUpperCase()}${f.size ? ', ' + mb(f.size) : ''})</a>
    </div>
    ${tooBig ? `<p class="note">Fayl 10 MB dan katta, shuning uchun slaydlar bu yerda ochilmasligi mumkin. Unda "Yuklab olish" tugmasidan foydalaning.</p>` : ''}
    <div class="frame"><iframe id="viewer" src="${esc(src)}" title="${esc(p.title)}" allowfullscreen></iframe></div>`;
  document.getElementById('fs').addEventListener('click', () => {
    const el = document.querySelector('.frame');
    (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
  });
}
function currentView(){
  const m = location.hash.match(/^#korish\/([\w-]+)\/(pdf|pptx)$/);
  return m ? {id: m[1], kind: m[2]} : null;
}
function currentGroup(){
  const m = location.hash.match(/^#guruh-(\d+)$/);
  return m && GROUP_IDS.includes(m[1]) ? m[1] : null;
}
function route(){
  renderAuth();
  if(location.hash === '#kirish'){ q.value = ''; viewKey = null; return login(); }
  const v = currentView();
  if(v){ q.value = ''; return viewer(v.id, v.kind); }
  viewKey = null;
  const g = currentGroup();
  if(g){ q.value = ''; group(g); } else home();
}
/* Re-render after data changes without wiping a half-filled form or scroll position. */
function refresh(){
  const a = document.activeElement;
  const typing = a && a.closest && a.closest('#up, #login-form');
  if(typing || formState.busy){ renderAuth(); return; }
  const y = window.scrollY; route(); window.scrollTo(0, y);
}

async function loadItems(){
  const { data, error } = await sb.from('presentations')
    .select('id, group, title, student, files, created_at')
    .order('created_at', {ascending: false});
  if(error){ dbState = 'error'; console.error(error); }
  else { items = data; dbState = 'ok'; }
  refresh();
}

async function checkAdmin(){
  isAdmin = false;
  if(user){
    const { data, error } = await sb.from('admins').select('user_id').eq('user_id', user.id).maybeSingle();
    isAdmin = !error && !!data;
  }
  refresh();
}

function checkFile(kind, f){
  if(!f) return null;
  if(ext(f.name) !== kind) return f.name + ": faqat ." + kind + " fayl qabul qilinadi.";
  if(f.size > MAX_BYTES) return f.name + " hajmi 20 MB dan katta (" + mb(f.size) + ").";
  return null;
}

async function submitUpload(g){
  const title = document.getElementById('up-title').value.trim();
  const student = document.getElementById('up-student').value.trim();
  const pdf = document.getElementById('up-pdf').files[0];
  const pptx = document.getElementById('up-pptx').files[0];
  const setMsg = (msg, err, busy) => {
    formState = {msg, err: !!err, busy: !!busy};
    const s = document.getElementById('up-status'), b = document.getElementById('up-btn');
    if(s){ s.textContent = msg; s.className = 'status' + (err ? ' err' : ''); }
    if(b) b.disabled = !!busy;
  };
  if(!title || !student) return setMsg("Taqdimot nomi va o'quvchi ismini kiriting.", true);
  if(!pdf && !pptx) return setMsg("PDF yoki PPTX faylni tanlang.", true);
  const bad = checkFile('pdf', pdf) || checkFile('pptx', pptx);
  if(bad) return setMsg(bad, true);

  const files = [];
  try{
    for(const [kind, f] of [['pdf', pdf], ['pptx', pptx]]){
      if(!f) continue;
      setMsg(f.name + " yuklanmoqda…", false, true);
      const path = `${g}/${uid()}.${kind}`;
      const { error } = await sb.storage.from(BUCKET).upload(path, f, {contentType: MIME[kind], upsert: false});
      if(error) throw error;
      files.push({kind, path, name: f.name, size: f.size});
    }
    setMsg("Saqlanmoqda…", false, true);
    const { error } = await sb.from('presentations').insert({group: g, title, student, files});
    if(error) throw error;
    formState = {msg:'', err:false, busy:false};
    await loadItems();
    // the form still has focus, so refresh() skipped the redraw: do it here
    formState = {msg:"Qo'shildi.", err:false, busy:false};
    if(currentGroup() === g) group(g);
  }catch(e){
    // roll back files already uploaded so nothing is left orphaned
    if(files.length) await sb.storage.from(BUCKET).remove(files.map(f => f.path)).catch(() => {});
    setMsg("Yuklab bo'lmadi: " + ((e && e.message) || "noma'lum xato"), true, false);
  }
}

let confirmDel = null;
async function removeItem(id, btn){
  const p = items.find(x => x.id === id);
  if(!p) return;
  if(confirmDel !== id){
    confirmDel = id;
    btn.textContent = "Ha, o'chirilsin";
    setTimeout(() => { if(confirmDel === id) confirmDel = null; if(btn.isConnected) btn.textContent = "O'chirish"; }, 4000);
    return;
  }
  confirmDel = null;
  btn.disabled = true;
  const { error } = await sb.from('presentations').delete().eq('id', id);
  if(error){ btn.disabled = false; btn.textContent = "O'chirib bo'lmadi"; return; }
  const paths = (p.files || []).map(f => f.path).filter(Boolean);
  if(paths.length) await sb.storage.from(BUCKET).remove(paths).catch(() => {});
  await loadItems();
}

q.addEventListener('input', () => { if(location.hash) history.replaceState(null,'',location.pathname); home(); });
window.addEventListener('hashchange', () => { if(!formState.busy) formState = {msg:'', err:false, busy:false}; route(); window.scrollTo(0,0); });
app.addEventListener('click', e => { const b = e.target.closest('[data-del]'); if(b) removeItem(b.getAttribute('data-del'), b); });
authEl.addEventListener('click', async e => {
  if(e.target.id === 'logout'){ await sb.auth.signOut(); }
});

(function init(){
  const configured = cfg.supabaseUrl && cfg.supabaseAnonKey && !/YOUR-/.test(cfg.supabaseUrl + cfg.supabaseAnonKey);
  if(!configured || !window.supabase){ dbState = 'unconfigured'; return route(); }
  sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  route();
  sb.auth.onAuthStateChange((_event, session) => {
    const next = session ? session.user : null;
    if((next && next.id) === (user && user.id)) return;
    user = next;
    // run outside the auth callback, as Supabase recommends
    setTimeout(checkAdmin, 0);
  });
  loadItems();
})();

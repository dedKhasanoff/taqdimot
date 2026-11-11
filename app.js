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
const googleUrl = url => 'https://docs.google.com/gview?embedded=1&url=' + encodeURIComponent(url);
const pdfUrl = url => navigator.pdfViewerEnabled === false ? googleUrl(url) : url;

/* ---- Cover images (first slide) ---- */
const COVER_W = 960;
const LIBS = {
  jszip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  pdfjs: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  pdfWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
};
const loaded = {};
function loadScript(src){
  return loaded[src] || (loaded[src] = new Promise((res, rej) => {
    const el = document.createElement('script');
    el.src = src; el.onload = res; el.onerror = () => { delete loaded[src]; rej(new Error('Kutubxona yuklanmadi')); };
    document.head.appendChild(el);
  }));
}
const canvasToJpeg = c => new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
async function imageToJpeg(blob){
  const img = await createImageBitmap(blob);
  const k = Math.min(1, COVER_W / img.width);
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return canvasToJpeg(c);
}
async function coverFromPdf(blob){
  await loadScript(LIBS.pdfjs);
  pdfjsLib.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
  const pdf = await pdfjsLib.getDocument({data: await blob.arrayBuffer()}).promise;
  const page = await pdf.getPage(1);
  const vp = page.getViewport({scale: COVER_W / page.getViewport({scale: 1}).width});
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({canvasContext: ctx, viewport: vp}).promise;
  return canvasToJpeg(c);
}
// PowerPoint stores a small picture of the first slide inside the .pptx
async function coverFromPptx(blob){
  await loadScript(LIBS.jszip);
  const zip = await JSZip.loadAsync(blob);
  const f = zip.file(/^docProps\/thumbnail\.(jpe?g|png)$/i)[0];
  return f ? imageToJpeg(await f.async('blob')) : null;
}
// Best source first: a picture the admin chose, then the PDF, then the PPTX thumbnail.
async function makeCover({image, pdf, pptx}){
  const tries = [image && (() => imageToJpeg(image)), pdf && (() => coverFromPdf(pdf)), pptx && (() => coverFromPptx(pptx))];
  for(const t of tries){
    if(!t) continue;
    try{ const b = await t(); if(b) return b; }catch(e){ console.warn('cover', e); }
  }
  return null;
}
async function uploadCover(g, blob){
  const path = `${g}/${uid()}.jpg`;
  const { error } = await sb.storage.from(BUCKET).upload(path, blob, {contentType: 'image/jpeg', upsert: false});
  if(error) throw error;
  return path;
}

// PDF goes first: the site draws it itself, sharp on any screen. PPTX uses Microsoft's viewer.
const sortedFiles = p => (p.files || []).slice().sort((a, b) => a.kind === 'pdf' ? -1 : b.kind === 'pdf' ? 1 : 0);
function fileLinks(p){
  return sortedFiles(p).map((f, i) => `<a class="btn${i ? ' ghost' : ''}" href="${viewHash(p, f.kind)}">${i ? 'PowerPoint ko\'rinishi' : 'Slaydlarni ko\'rish'}</a>`).join('');
}
/* ---- Topics ---- */
const NO_TOPIC = '~';
const topicOf = p => (p.topic || '').trim();
const topicKey = t => t.toLocaleLowerCase('uz');
const topicHash = t => '#mavzu/' + (t ? encodeURIComponent(t) : NO_TOPIC);
// Unique topics, most used first; spelling of the first one seen wins.
function topicsList(){
  const m = new Map();
  for(const p of items){
    const t = topicOf(p);
    if(!t) continue;
    const k = topicKey(t);
    if(!m.has(k)) m.set(k, {name: t, n: 0});
    m.get(k).n++;
  }
  return [...m.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'uz'));
}
const byTopic = t => items.filter(p => t ? topicKey(topicOf(p)) === topicKey(t) : !topicOf(p));
// Reuse an existing topic's spelling so "tarix" and "Tarix" don't split into two sections.
function canonTopic(t){
  t = (t || '').trim().replace(/\s+/g, ' ');
  if(!t) return '';
  const hit = topicsList().find(x => topicKey(x.name) === topicKey(t));
  return hit ? hit.name : t;
}

function presCard(p, showGroup){
  const first = sortedFiles(p)[0];
  const thumb = p.cover
    ? `<img src="${esc(publicUrl(p.cover))}" alt="" loading="lazy">`
    : `<span class="ph"><b>${esc(p.group)}</b>${first ? first.kind.toUpperCase() : ''}</span>`;
  return `<article class="pres">
    <a class="thumb" href="${first ? viewHash(p, first.kind) : '#'}" aria-label="${esc(p.title)}">${thumb}</a>
    <h3>${esc(p.title)}</h3>
    <div class="by">${esc(p.student)}${showGroup ? ' · ' + esc(p.group) + '-guruh' : ''}</div>
    ${topicOf(p) ? `<a class="chip small" href="${topicHash(canonTopic(topicOf(p)))}">${esc(canonTopic(topicOf(p)))}</a>` : ''}
    <div class="files">${fileLinks(p)}</div>
    ${isAdmin ? `<div class="admin-row">
      <button class="btn ghost small" type="button" data-topic="${esc(p.id)}">${topicOf(p) ? 'Mavzuni o\'zgartirish' : 'Mavzu qo\'shish'}</button>
      <button class="btn ghost small" type="button" data-cover="${esc(p.id)}">${p.cover ? 'Rasmni almashtirish' : 'Rasm qo\'shish'}</button>
      <button class="btn danger small" type="button" data-del="${esc(p.id)}">O'chirish</button>
    </div>` : ''}
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
      </a>`).join('') + `</div>` + topicSections();
}
const TOPIC_PREVIEW = 3;
function topicSections(){
  const topics = topicsList();
  if(!topics.length) return '';
  const rest = byTopic('');
  const all = topics.concat(rest.length ? [{name: '', n: rest.length}] : []);
  return `<section class="topics">
    <h2 class="sec">Mavzular bo'yicha</h2>
    <nav class="chips">${all.map(t => `<a class="chip" href="${topicHash(t.name)}">${esc(t.name || 'Boshqa')} <span>${t.n}</span></a>`).join('')}</nav>
    ${all.map(t => {
      const list = byTopic(t.name);
      return `<div class="topic">
        <div class="topic-head"><h3>${esc(t.name || 'Boshqa')}</h3>
          ${list.length > TOPIC_PREVIEW ? `<a href="${topicHash(t.name)}">Hammasi (${list.length}) →</a>` : ''}</div>
        <div class="list">${list.slice(0, TOPIC_PREVIEW).map(p => presCard(p, true)).join('')}</div>
      </div>`;
    }).join('')}
  </section>`;
}
function topicPage(t){
  const list = byTopic(t);
  app.innerHTML = `
    <a class="back" href="#">← Bosh sahifa</a>
    <h1>${esc(t || 'Boshqa')}</h1>
    <p class="lead">${plural(list.length)}${t ? '' : ' · mavzusi belgilanmagan'}</p>` + banner() +
    (list.length ? `<div class="list">${list.map(p => presCard(p, true)).join('')}</div>`
                 : (dbState === 'ok' ? `<div class="empty">Bu mavzuda hali taqdimot yo'q.</div>` : ''));
}
function currentTopic(){
  const m = location.hash.match(/^#mavzu\/(.*)$/);
  if(!m) return null;
  if(m[1] === NO_TOPIC) return '';
  try{ return decodeURIComponent(m[1]); }catch(_){ return null; }
}
function uploadForm(g){
  return `<form class="upload" id="up" autocomplete="off">
    <h2>${g}-guruhga taqdimot qo'shish</h2>
    <label class="field">Taqdimot nomi<input type="text" id="up-title" required maxlength="200"></label>
    <label class="field">O'quvchi ismi<input type="text" id="up-student" required maxlength="120"></label>
    <label class="field">PDF fayl<input type="file" id="up-pdf" accept=".pdf,application/pdf"><small>20 MB gacha</small></label>
    <label class="field">PPTX fayl<input type="file" id="up-pptx" accept=".pptx,${MIME.pptx}"><small>20 MB gacha</small></label>
    <label class="field">Mavzu<input type="text" id="up-topic" list="topic-list" maxlength="80" placeholder="masalan: Tarix">
      <datalist id="topic-list">${topicsList().map(t => `<option value="${esc(t.name)}">`).join('')}</datalist>
      <small>Ro'yxatdan tanlang yoki yangisini yozing</small></label>
    <label class="field">Muqova rasmi (ixtiyoriy)<input type="file" id="up-img" accept="image/*"><small>Tanlanmasa, birinchi slayd avtomatik olinadi</small></label>
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
  const hits = items.filter(p => (p.title + ' ' + p.student + ' ' + p.group + ' ' + topicOf(p)).toLowerCase().includes(term));
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
  // Big PowerPoint files go to Google's viewer, which takes up to ~25 MB
  const big = f.kind === 'pptx' && f.size > OFFICE_LIMIT;
  const src = big ? googleUrl(url) : officeUrl(url);
  const hasPdf = (p.files || []).some(x => x.kind === 'pdf');
  const tabs = (p.files || []).length > 1 ? sortedFiles(p).map(x =>
    `<a class="btn${x.kind === f.kind ? '' : ' ghost'}" href="${viewHash(p, x.kind)}">${x.kind === 'pdf' ? 'Slaydlar' : 'PowerPoint'}</a>`).join('') : '';
  const stage = f.kind === 'pdf'
    ? `<div class="frame deck loading" id="viewer" tabindex="0" aria-label="${esc(p.title)}">
        <canvas id="slide"></canvas>
        <button class="nav prev" type="button" aria-label="Oldingi slayd">‹</button>
        <button class="nav next" type="button" aria-label="Keyingi slayd">›</button>
        <span class="counter" id="counter"></span>
      </div>`
    : `<div class="frame"><iframe id="viewer" src="${esc(src)}" title="${esc(p.title)}" allowfullscreen></iframe></div>`;
  app.innerHTML = `
    <a class="back" href="#guruh-${esc(p.group)}">← ${esc(p.group)}-guruh</a>
    <h1 style="margin-top:20px">${esc(p.title)}</h1>
    <p class="lead" style="margin-bottom:16px">${esc(p.student)} · ${esc(p.group)}-guruh</p>
    <div class="viewbar">${tabs}
      <button class="btn ghost" type="button" id="fs">To'liq ekran</button>
      <a class="btn ghost" href="${esc(publicUrl(f.path, f.name))}">Yuklab olish (${f.kind.toUpperCase()}${f.size ? ', ' + mb(f.size) : ''})</a>
    </div>
    ${big ? `<p class="note">Fayl katta (${mb(f.size)}), shuning uchun slaydlar Google orqali ochiladi va biroz sekin yuklanishi mumkin. Ochilmasa${hasPdf ? ' "Slaydlar" tugmasini bosing yoki' : ''} "Yuklab olish" tugmasidan foydalaning.</p>` : ''}
    ${f.kind === 'pptx' && !hasPdf ? `<p class="note">Telefonda slaydlar tiniqroq ko'rinishi uchun taqdimotning PDF nusxasini ham yuklang.</p>` : ''}
    ${stage}`;
  document.getElementById('fs').addEventListener('click', () => {
    const el = document.querySelector('.frame');
    (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
  });
  deck = null;
  if(f.kind === 'pdf') openDeck(url, key);
}

/* ---- Own slide viewer for PDF: renders each page at the screen's real pixel density ---- */
let deck = null; // {pdf, n, page, key, task}
async function openDeck(url, key){
  const stage = document.getElementById('viewer');
  stage.querySelector('.prev').addEventListener('click', e => { e.stopPropagation(); go(-1); });
  stage.querySelector('.next').addEventListener('click', e => { e.stopPropagation(); go(1); });
  let x0 = null;
  stage.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, {passive: true});
  stage.addEventListener('touchend', e => {
    if(x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if(Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
  });
  try{
    await loadScript(LIBS.pdfjs);
    pdfjsLib.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
    const pdf = await pdfjsLib.getDocument(url).promise;
    if(viewKey !== key) return;
    const first = (await pdf.getPage(1)).getViewport({scale: 1});
    stage.style.aspectRatio = first.width + ' / ' + first.height;
    deck = {pdf, n: pdf.numPages, page: 1, key, task: null};
    await drawSlide();
  }catch(e){
    console.error(e);
    if(viewKey === key) stage.outerHTML = `<p class="note">Slaydlarni ochib bo'lmadi. "Yuklab olish" tugmasidan foydalaning.</p>`;
  }
}
async function drawSlide(){
  const stage = document.getElementById('viewer'), canvas = document.getElementById('slide');
  if(!deck || !stage || !canvas) return;
  const d = deck, num = d.page;
  const page = await d.pdf.getPage(num);
  const base = page.getViewport({scale: 1});
  const box = stage.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const fit = Math.min(box.width / base.width, box.height / base.height);
  const vp = page.getViewport({scale: fit * dpr});
  if(d.task) d.task.cancel();
  const off = document.createElement('canvas');
  off.width = Math.floor(vp.width); off.height = Math.floor(vp.height);
  const ctx = off.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, off.width, off.height);
  d.task = page.render({canvasContext: ctx, viewport: vp});
  try{ await d.task.promise; }catch(_){ return; } // cancelled by a newer draw
  if(deck !== d || d.page !== num) return;
  canvas.width = off.width; canvas.height = off.height;
  canvas.getContext('2d').drawImage(off, 0, 0);
  canvas.style.width = off.width / dpr + 'px'; canvas.style.height = off.height / dpr + 'px';
  stage.classList.remove('loading');
  document.getElementById('counter').textContent = num + ' / ' + d.n;
  stage.querySelector('.prev').disabled = num <= 1;
  stage.querySelector('.next').disabled = num >= d.n;
  // warm up the next page so swiping feels instant
  if(num < d.n) d.pdf.getPage(num + 1).catch(() => {});
}
function go(step){
  if(!deck) return;
  const n = Math.min(deck.n, Math.max(1, deck.page + step));
  if(n !== deck.page){ deck.page = n; drawSlide(); }
}
document.addEventListener('keydown', e => {
  if(!deck || e.target.closest && e.target.closest('input, textarea')) return;
  if(e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' '){ e.preventDefault(); go(1); }
  if(e.key === 'ArrowLeft' || e.key === 'PageUp'){ e.preventDefault(); go(-1); }
});
let resizeT = null;
const redraw = () => { clearTimeout(resizeT); resizeT = setTimeout(drawSlide, 150); };
window.addEventListener('resize', redraw);
document.addEventListener('fullscreenchange', redraw);
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
  viewKey = null; deck = null;
  const t = currentTopic();
  if(t !== null){ q.value = ''; return topicPage(t); }
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
    .select('*')
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
  const image = document.getElementById('up-img').files[0];
  const topic = canonTopic(document.getElementById('up-topic').value);
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
  let cover = null;
  try{
    for(const [kind, f] of [['pdf', pdf], ['pptx', pptx]]){
      if(!f) continue;
      setMsg(f.name + " yuklanmoqda…", false, true);
      const path = `${g}/${uid()}.${kind}`;
      const { error } = await sb.storage.from(BUCKET).upload(path, f, {contentType: MIME[kind], upsert: false});
      if(error) throw error;
      files.push({kind, path, name: f.name, size: f.size});
    }
    setMsg("Muqova rasmi tayyorlanmoqda…", false, true);
    const coverBlob = await makeCover({image, pdf, pptx});
    if(coverBlob) cover = await uploadCover(g, coverBlob).catch(() => null);
    setMsg("Saqlanmoqda…", false, true);
    const row = {group: g, title, student, files};
    if(topic) row.topic = topic;
    if(cover) row.cover = cover;
    const { error } = await sb.from('presentations').insert(row);
    if(error) throw error;
    formState = {msg:'', err:false, busy:false};
    await loadItems();
    // the form still has focus, so refresh() skipped the redraw: do it here
    formState = {msg:"Qo'shildi.", err:false, busy:false};
    if(currentGroup() === g) group(g);
  }catch(e){
    // roll back files already uploaded so nothing is left orphaned
    const left = files.map(f => f.path).concat(cover ? [cover] : []);
    if(left.length) await sb.storage.from(BUCKET).remove(left).catch(() => {});
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
  const paths = (p.files || []).map(f => f.path).concat(p.cover ? [p.cover] : []).filter(Boolean);
  if(paths.length) await sb.storage.from(BUCKET).remove(paths).catch(() => {});
  await loadItems();
}

// Admin: add or replace the cover of an existing presentation.
// First try the first slide of its own files; if there is none (or a cover exists), ask for a picture.
const picker = Object.assign(document.createElement('input'), {type: 'file', accept: 'image/*'});
async function setCover(id, btn, image){
  const p = items.find(x => x.id === id);
  if(!p) return;
  btn.disabled = true; btn.textContent = 'Tayyorlanmoqda…';
  try{
    let src = {image};
    if(!image){
      for(const f of p.files || []){
        const r = await fetch(publicUrl(f.path));
        if(r.ok) src[f.kind] = await r.blob();
      }
    }
    const blob = await makeCover(src);
    if(!blob){
      btn.disabled = false; btn.textContent = 'Rasm tanlang';
      picker.onchange = () => { if(picker.files[0]) setCover(id, btn, picker.files[0]); picker.value = ''; };
      picker.click();
      return;
    }
    const path = await uploadCover(p.group, blob);
    const { error } = await sb.from('presentations').update({cover: path}).eq('id', id);
    if(error){ await sb.storage.from(BUCKET).remove([path]).catch(() => {}); throw error; }
    if(p.cover) await sb.storage.from(BUCKET).remove([p.cover]).catch(() => {});
    await loadItems();
  }catch(e){
    console.error(e);
    btn.disabled = false; btn.textContent = "Bo'lmadi: " + ((e && e.message) || 'xato');
  }
}
app.addEventListener('click', e => {
  const b = e.target.closest('[data-cover]');
  if(!b) return;
  const id = b.getAttribute('data-cover');
  const p = items.find(x => x.id === id);
  if(p && p.cover){ // replacing: let the admin pick a picture
    picker.onchange = () => { if(picker.files[0]) setCover(id, b, picker.files[0]); picker.value = ''; };
    picker.click();
  } else setCover(id, b);
});

q.addEventListener('input', () => { if(location.hash) history.replaceState(null,'',location.pathname); home(); });
window.addEventListener('hashchange', () => { if(!formState.busy) formState = {msg:'', err:false, busy:false}; route(); window.scrollTo(0,0); });
app.addEventListener('click', async e => {
  const b = e.target.closest('[data-topic]');
  if(!b) return;
  const p = items.find(x => x.id === b.getAttribute('data-topic'));
  if(!p) return;
  const names = topicsList().map(t => t.name).join(', ');
  const answer = prompt("Mavzu nomi" + (names ? " (mavjudlar: " + names + ")" : '') + ".\nBo'sh qoldirsangiz, mavzu olib tashlanadi.", topicOf(p));
  if(answer === null) return;
  const topic = canonTopic(answer).slice(0, 80) || null;
  b.disabled = true; b.textContent = 'Saqlanmoqda…';
  const { error } = await sb.from('presentations').update({topic}).eq('id', p.id);
  if(error){ b.disabled = false; b.textContent = "Bo'lmadi: " + error.message; return; }
  await loadItems();
});
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

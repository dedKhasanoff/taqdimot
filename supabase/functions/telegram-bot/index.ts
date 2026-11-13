// Telegram bot: o'quvchilardan taqdimot (PDF/PPTX) qabul qiladi va saytga joylaydi.
// Supabase Edge Function. Sozlash: README.md → "Telegram bot".
//
// Kerakli secrets (Edge Functions → Secrets):
//   TELEGRAM_BOT_TOKEN       BotFather bergan token
//   TELEGRAM_WEBHOOK_SECRET  o'zingiz o'ylab topgan maxfiy so'z (harf, raqam, _ va -)
//   SITE_URL                 sayt manzili, masalan https://taqdimo.netlify.app
//   ADMIN_CHAT_ID            (ixtiyoriy) yangi taqdimotlar haqida xabar boradigan chat id (/myid)
// SUPABASE_URL va service kalit Supabase tomonidan avtomatik beriladi.

import { createClient } from "npm:@supabase/supabase-js@2.93.3";
import JSZip from "npm:jszip@3.10.1";

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const SITE = (Deno.env.get("SITE_URL") ?? "").replace(/\/+$/, "");
const ADMIN_CHAT = Deno.env.get("ADMIN_CHAT_ID") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const TG_API = Deno.env.get("TELEGRAM_API") ?? "https://api.telegram.org";

const BUCKET = "taqdimotlar";
const GROUPS = ["101", "102", "103", "104", "105", "106", "107", "108", "109", "110"];
const MAX_BYTES = 20 * 1024 * 1024; // also the Telegram limit for bot downloads
type Kind = "pdf" | "pptx" | "html";
const KINDS: Kind[] = ["pdf", "pptx", "html"];
// Content type used in storage. HTML is kept as plain text: the site only shows it in a sandbox.
const MIME: Record<string, string> = {
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  html: "text/plain",
};
// Content type when the file is sent back to a Telegram user
const SEND_MIME: Record<string, string> = { ...MIME, html: "text/html" };
const LIMITS = { topic: 80, title: 200, student: 120 };

function serviceKey(): string {
  const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (k) return k;
  try { // newer projects: {"default": "sb_secret_..."}
    const j = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    return j.default ?? Object.values(j)[0] ?? "";
  } catch { return ""; }
}
const sb = createClient(SUPABASE_URL, serviceKey(), { auth: { persistSession: false } });

/* ---------- Telegram helpers ---------- */
type Json = Record<string, unknown>;
async function tg(method: string, body: Json): Promise<Json> {
  const r = await fetch(`${TG_API}/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ ok: false }));
  if (!j.ok) console.error("telegram", method, JSON.stringify(j));
  return j;
}
const esc = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const send = (chat_id: number | string, text: string, extra: Json = {}) =>
  tg("sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
// Multipart call, for uploading a file to Telegram
async function tgForm(method: string, form: FormData): Promise<Json> {
  const r = await fetch(`${TG_API}/bot${TOKEN}/${method}`, { method: "POST", body: form });
  const j = await r.json().catch(() => ({ ok: false }));
  if (!j.ok) console.error("telegram", method, JSON.stringify(j));
  return j;
}
const keyboard = (rows: { text: string; data: string }[][]) => ({
  reply_markup: { inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))) },
});
const chunk = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/* ---------- Conversation state (table bot_sessions) ---------- */
type FileRef = { file_id: string; name: string; size: number };
type Data = {
  group?: string; topic?: string | null; topics?: string[];
  title?: string; student?: string;
  files?: Partial<Record<Kind, FileRef>>;
};
type Session = { step: string; data: Data };

async function getSession(chat: number): Promise<Session> {
  const { data } = await sb.from("bot_sessions").select("step, data").eq("chat_id", chat).maybeSingle();
  return (data as Session) ?? { step: "idle", data: {} };
}
async function setSession(chat: number, step: string, data: Data) {
  const { error } = await sb.from("bot_sessions")
    .upsert({ chat_id: chat, step, data, updated_at: new Date().toISOString() });
  if (error) console.error("session", error);
}

/* ---------- Topics ---------- */
const topicKey = (t: string) => t.toLocaleLowerCase("uz");
async function topicsList(): Promise<string[]> {
  const { data } = await sb.from("presentations").select("topic").not("topic", "is", null);
  const m = new Map<string, { name: string; n: number }>();
  for (const r of data ?? []) {
    const t = String(r.topic ?? "").trim();
    if (!t) continue;
    const k = topicKey(t);
    if (!m.has(k)) m.set(k, { name: t, n: 0 });
    m.get(k)!.n++;
  }
  return [...m.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).map((x) => x.name);
}
function canonTopic(t: string, known: string[]): string {
  t = t.trim().replace(/\s+/g, " ");
  return known.find((k) => topicKey(k) === topicKey(t)) ?? t;
}

/* ---------- Steps ---------- */
async function askGroup(chat: number) {
  await setSession(chat, "group", {});
  await send(chat,
    "Salom! 👋 Bu bot orqali taqdimotingizni saytga yuborasiz.\n\n<b>1/5.</b> Guruhingizni tanlang:",
    keyboard(chunk(GROUPS.map((g) => ({ text: g, data: "g:" + g })), 5)));
}
async function askTopic(chat: number, data: Data) {
  const topics = (await topicsList()).slice(0, 12);
  data.topics = topics;
  await setSession(chat, "topic", data);
  const rows = chunk(topics.map((t, i) => ({ text: t, data: "t:" + i })), 2);
  rows.push([{ text: "Mavzusiz", data: "t:-" }]);
  await send(chat,
    `<b>2/5.</b> Taqdimot mavzusini tanlang yoki yangi mavzu nomini yozing (masalan: Tarix):`,
    keyboard(rows));
}
async function askTitle(chat: number, data: Data) {
  await setSession(chat, "title", data);
  await send(chat, "<b>3/5.</b> Taqdimot nomini yozing:");
}
async function askStudent(chat: number, data: Data) {
  await setSession(chat, "student", data);
  await send(chat, "<b>4/5.</b> Ism va familiyangizni yozing:");
}
async function askFiles(chat: number, data: Data) {
  data.files = {};
  await setSession(chat, "files", data);
  await send(chat,
    "<b>5/5.</b> Taqdimot faylini yuboring: <b>PDF</b>, <b>PPTX</b> yoki <b>HTML</b>, 20 MB gacha.\n" +
    "Bir nechtasini yuborsangiz ham bo'ladi. PDF telefonda eng tiniq ko'rinadi.\n" +
    "HTML bitta fayl bo'lishi kerak (rasmlar fayl ichiga joylangan).");
}

function fileKind(doc: Json): Kind | null {
  const name = String(doc.file_name ?? "").toLowerCase();
  const mime = String(doc.mime_type ?? "");
  if (name.endsWith(".pdf") || mime === MIME.pdf) return "pdf";
  if (name.endsWith(".pptx") || mime === MIME.pptx) return "pptx";
  if (name.endsWith(".html") || name.endsWith(".htm") || mime === "text/html") return "html";
  return null;
}

async function onDocument(chat: number, s: Session, doc: Json) {
  if (s.step !== "files") {
    // Outside the submission flow a PDF means "turn it into pictures"
    if (fileKind(doc) === "pdf") return offerJpeg(chat, doc);
    return send(chat, "Taqdimot yuborish uchun /start ni bosing.\nPDF'ni rasmga (JPEG) aylantirish uchun PDF faylni shunchaki yuboring.");
  }
  const kind = fileKind(doc);
  if (!kind) {
    const ppt = String(doc.file_name ?? "").toLowerCase().endsWith(".ppt");
    return send(chat, ppt
      ? "Eski .ppt format qabul qilinmaydi. PowerPoint'da <b>Fayl → Saqlash</b> orqali .pptx yoki PDF qilib saqlang va qayta yuboring."
      : "Faqat <b>PDF</b>, <b>PPTX</b> yoki <b>HTML</b> fayl qabul qilinadi.");
  }
  const size = Number(doc.file_size ?? 0);
  if (size > MAX_BYTES) {
    return send(chat, `Fayl juda katta (${(size / 1048576).toFixed(1)} MB). 20 MB gacha bo'lishi kerak. ` +
      "PowerPoint'da rasmlarni siqib (Compress Pictures) qayta saqlab ko'ring.");
  }
  const data = s.data;
  data.files = { ...(data.files ?? {}), [kind]: { file_id: String(doc.file_id), name: String(doc.file_name ?? kind), size } };
  const missing = KINDS.filter((k) => !data.files![k]);
  if (!missing.length) return finish(chat, data);
  await setSession(chat, "files", data);
  const got = KINDS.filter((k) => data.files![k]).map((k) => k.toUpperCase()).join(", ");
  await send(chat,
    `✅ Qabul qilindi: ${got}.\n${missing.map((k) => k.toUpperCase()).join(" yoki ")} ham bo'lsa, yuboring. Bo'lmasa, «Yuborish» tugmasini bosing.`,
    keyboard([[{ text: "✅ Yuborish", data: "done" }]]));
}

/* ---------- Saving ---------- */
async function download(fileId: string): Promise<Uint8Array> {
  const j = await tg("getFile", { file_id: fileId }) as { ok: boolean; result?: { file_path?: string } };
  if (!j.ok || !j.result?.file_path) throw new Error("Telegram faylni bermadi");
  const r = await fetch(`${TG_API}/file/bot${TOKEN}/${j.result.file_path}`);
  if (!r.ok) throw new Error("Faylni yuklab bo'lmadi");
  return new Uint8Array(await r.arrayBuffer());
}
// PowerPoint keeps a small JPEG of the first slide inside the .pptx
async function pptxThumb(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const f = zip.file(/^docProps\/thumbnail\.jpe?g$/i)[0];
    return f ? await f.async("uint8array") : null;
  } catch { return null; }
}

function finish(chat: number, data: Data) {
  // Reply to Telegram right away and do the slow part in the background,
  // so Telegram doesn't time out and resend the same update.
  const work = (async () => {
    await setSession(chat, "saving", data);
    await send(chat, "⏳ Saqlanmoqda…");
    await save(chat, data);
  })();
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(work); else return work;
}

async function save(chat: number, data: Data) {
  const g = data.group!;
  const uploaded: string[] = [];
  try {
    const files: StoredFile[] = [];
    let cover: string | null = null;
    for (const kind of KINDS) {
      const ref = data.files?.[kind];
      if (!ref) continue;
      const bytes = await download(ref.file_id);
      const path = `${g}/${crypto.randomUUID()}.${kind}`;
      const { error } = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: MIME[kind], upsert: false });
      if (error) throw error;
      uploaded.push(path);
      files.push({ kind, path, name: ref.name, size: bytes.length, tg_file_id: ref.file_id });
      if (kind === "pptx") {
        const thumb = await pptxThumb(bytes);
        if (thumb) {
          const cp = `${g}/${crypto.randomUUID()}.jpg`;
          const { error: ce } = await sb.storage.from(BUCKET).upload(cp, thumb, { contentType: "image/jpeg", upsert: false });
          if (!ce) { cover = cp; uploaded.push(cp); }
        }
      }
    }
    const row: Json = { group: g, title: data.title, student: data.student, files };
    if (data.topic) row.topic = data.topic;
    if (cover) row.cover = cover;
    const { data: ins, error } = await sb.from("presentations").insert(row).select("id").single();
    if (error) throw error;

    await setSession(chat, "idle", {});
    const first = files.find((f) => f.kind === "pdf") ?? files[0];
    const link = SITE ? `${SITE}/#korish/${ins.id}/${first.kind}` : "";
    await send(chat,
      `🎉 Taqdimotingiz saytga joylandi!\n\n<b>${esc(data.title)}</b>\n${esc(data.student)} · ${esc(g)}-guruh` +
      (data.topic ? ` · ${esc(data.topic)}` : "") +
      (link ? `\n\n${link}` : "") + "\n\nYana taqdimot yuborish uchun /start ni bosing.");
    if (ADMIN_CHAT) {
      await send(ADMIN_CHAT,
        `📥 Yangi taqdimot (bot orqali)\n<b>${esc(data.title)}</b>\n${esc(data.student)} · ${esc(g)}-guruh` +
        (data.topic ? ` · ${esc(data.topic)}` : "") + `\nFayllar: ${files.map((f) => f.kind.toUpperCase()).join(", ")}` +
        (link ? `\n${link}` : ""));
    }
  } catch (e) {
    console.error("save", e);
    if (uploaded.length) await sb.storage.from(BUCKET).remove(uploaded).catch(() => {});
    data.files = {};
    await setSession(chat, "files", data);
    await send(chat, "❌ Saqlab bo'lmadi. Faylni qaytadan yuboring yoki birozdan keyin urinib ko'ring.");
  }
}

/* ---------- Downloads: site button → t.me/<bot>?start=dl_<id>_<kind> ---------- */
type StoredFile = { kind: string; path: string; name: string; size: number; tg_file_id?: string };
async function sendPresentation(chat: number, id: string, kind: string) {
  const { data: p } = await sb.from("presentations")
    .select("id, title, student, group, topic, files").eq("id", id).maybeSingle();
  const files = (p?.files ?? []) as StoredFile[];
  const f = files.find((x) => x.kind === kind) ?? files[0];
  if (!p || !f) return send(chat, "Bu taqdimot topilmadi yoki o'chirilgan." + (SITE ? `\n\n${SITE}` : ""));

  await tg("sendChatAction", { chat_id: chat, action: "upload_document" });
  const link = SITE ? `${SITE}/#korish/${p.id}/${f.kind}` : "";
  const caption = `<b>${esc(p.title)}</b>\n${esc(p.student)} · ${esc(p.group)}-guruh` +
    (p.topic ? ` · ${esc(p.topic)}` : "") + (link ? `\n\n<a href="${link}">Saytda ko'rish</a>` : "");

  // Fast path: Telegram already has this file
  if (f.tg_file_id) {
    const r = await tg("sendDocument", { chat_id: chat, document: f.tg_file_id, caption, parse_mode: "HTML" });
    if (r.ok) return;
  }
  // First time: take it from storage, upload to Telegram, remember Telegram's file_id
  const { data: blob, error } = await sb.storage.from(BUCKET).download(f.path);
  if (error || !blob) {
    console.error("download", error);
    return send(chat, "Faylni olib bo'lmadi. Birozdan keyin qayta urinib ko'ring.");
  }
  const form = new FormData();
  form.append("chat_id", String(chat));
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append("document", new File([blob], f.name || `taqdimot.${f.kind}`, { type: SEND_MIME[f.kind] ?? "application/octet-stream" }));
  const r = await tgForm("sendDocument", form) as { ok: boolean; result?: { document?: { file_id?: string } } };
  if (!r.ok) return send(chat, "Faylni yuborib bo'lmadi. Birozdan keyin qayta urinib ko'ring.");
  const fileId = r.result?.document?.file_id;
  if (fileId) {
    const next = files.map((x) => x === f ? { ...x, tg_file_id: fileId } : x);
    const { error: ue } = await sb.from("presentations").update({ files: next }).eq("id", p.id);
    if (ue) console.error("save file_id", ue);
  }
}

/* ---------- PDF → JPEG ----------
   The edge runtime has only ~2 s of CPU per request, too little to render pages.
   So a Telegram Mini App (pdf.html on the site) renders them on the user's phone;
   this function only hands it the PDF and posts the finished pictures to the chat. */
async function offerJpeg(chat: number, doc: Json) {
  const size = Number(doc.file_size ?? 0);
  if (size > MAX_BYTES) return send(chat, `PDF juda katta (${(size / 1048576).toFixed(1)} MB). 20 MB gacha bo'lishi kerak.`);
  if (!SITE) return send(chat, "PDF'ni rasmga aylantirish hozircha sozlanmagan (SITE_URL yo'q).");
  const url = `${SITE}/pdf.html?f=${encodeURIComponent(String(doc.file_id))}&n=${encodeURIComponent(String(doc.file_name ?? "taqdimot.pdf"))}`;
  await send(chat, "📄 PDF qabul qilindi. Har bir sahifani JPEG rasmga aylantirish uchun tugmani bosing:", {
    reply_markup: { inline_keyboard: [[{ text: "🖼 JPEG'ga aylantirish", web_app: { url } }]] },
  });
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-init-data",
  "access-control-max-age": "86400",
};
const cors = (body: BodyInit | null, init: ResponseInit = {}) =>
  new Response(body, { ...init, headers: { ...CORS, ...(init.headers ?? {}) } });

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function hmac(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data));
}
// Checks the Mini App's initData signature (Telegram docs: "Validating data received via the Mini App").
// Returns the Telegram user id, or null when the data is missing, forged or older than a day.
export async function webAppUser(initData: string | null): Promise<number | null> {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), TOKEN);
  if (hex(await hmac(secret, check)) !== hash) return null;
  const age = Date.now() / 1000 - Number(params.get("auth_date") ?? 0);
  if (!(age < 86400)) return null;
  try { return Number(JSON.parse(params.get("user") ?? "{}").id) || null; } catch { return null; }
}

async function webApp(req: Request, action: string): Promise<Response> {
  if (req.method === "OPTIONS") return cors(null, { status: 204 });
  const userId = await webAppUser(req.headers.get("x-init-data"));
  if (!userId) return cors("Telegram orqali oching", { status: 401 });

  if (action === "pdf") { // hand the Mini App the PDF the user sent to the bot
    const fileId = new URL(req.url).searchParams.get("f") ?? "";
    const j = await tg("getFile", { file_id: fileId }) as { ok: boolean; result?: { file_path?: string; file_size?: number } };
    if (!j.ok || !j.result?.file_path) return cors("Fayl topilmadi. PDF'ni botga qaytadan yuboring.", { status: 404 });
    if ((j.result.file_size ?? 0) > MAX_BYTES) return cors("Fayl 20 MB dan katta", { status: 413 });
    const r = await fetch(`${TG_API}/file/bot${TOKEN}/${j.result.file_path}`);
    if (!r.ok) return cors("Faylni olib bo'lmadi", { status: 502 });
    return cors(r.body, { headers: { "content-type": "application/pdf" } });
  }

  if (action === "send" && req.method === "POST") { // post up to 10 finished pictures to the user's chat
    const form = await req.formData();
    const mode = form.get("mode") === "document" ? "document" : "photo";
    const caption = String(form.get("caption") ?? "").slice(0, 1000);
    const pics = form.getAll("img").filter((x): x is File => x instanceof File).slice(0, 10);
    if (!pics.length) return cors("Rasm yo'q", { status: 400 });
    if (pics.some((f) => f.size > 10 * 1024 * 1024)) return cors("Rasm 10 MB dan katta", { status: 413 });
    const out = new FormData();
    out.append("chat_id", String(userId));
    let r: Json;
    if (pics.length === 1) {
      out.append(mode, pics[0], pics[0].name);
      if (caption) out.append("caption", caption);
      r = await tgForm(mode === "photo" ? "sendPhoto" : "sendDocument", out);
    } else {
      out.append("media", JSON.stringify(pics.map((f, i) => ({
        type: mode, media: `attach://p${i}`, ...(i === 0 && caption ? { caption } : {}),
      }))));
      pics.forEach((f, i) => out.append(`p${i}`, f, f.name));
      r = await tgForm("sendMediaGroup", out);
    }
    return r.ok ? cors(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } })
      : cors(JSON.stringify(r), { status: 502, headers: { "content-type": "application/json" } });
  }
  return cors("not found", { status: 404 });
}

/* ---------- Update router ---------- */
async function onMessage(msg: Json) {
  const chat = (msg.chat as Json).id as number;
  if ((msg.chat as Json).type !== "private") return; // only direct chats
  const text = String(msg.text ?? "").trim();
  const cmd = text.startsWith("/") ? text.split(/[\s@]/)[0].toLowerCase() : "";

  if (cmd === "/start") {
    const dl = (text.split(/\s+/)[1] ?? "").match(/^dl_([0-9a-f-]{36})_(pdf|pptx|html)$/i);
    if (dl) return sendPresentation(chat, dl[1].toLowerCase(), dl[2].toLowerCase());
  }
  if (cmd === "/start" || cmd === "/yangi") return askGroup(chat);
  if (cmd === "/bekor" || cmd === "/cancel") {
    await setSession(chat, "idle", {});
    return send(chat, "Bekor qilindi. Qaytadan boshlash uchun /start ni bosing.");
  }
  if (cmd === "/myid") return send(chat, `Sizning chat ID: <code>${chat}</code>`);
  if (cmd === "/jpg") {
    await setSession(chat, "idle", {});
    return send(chat, "PDF faylni yuboring, men uni sahifama-sahifa JPEG rasmlarga aylantirib beraman.");
  }
  if (cmd === "/help" || cmd === "/yordam") {
    return send(chat, "/start — taqdimot yuborish\n/jpg — PDF'ni JPEG rasmga aylantirish\n/bekor — bekor qilish" + (SITE ? `\n\nSayt: ${SITE}` : ""));
  }

  const s = await getSession(chat);
  if (msg.document) return onDocument(chat, s, msg.document as Json);
  if (s.step === "saving") return send(chat, "⏳ Taqdimot saqlanmoqda, biroz kuting…");
  if (!text || cmd) {
    if (s.step === "files") return send(chat, "Iltimos, PDF, PPTX yoki HTML faylni <b>fayl (document)</b> sifatida yuboring.");
    return send(chat, "Taqdimot yuborish uchun /start ni bosing.");
  }

  const data = s.data ?? {};
  switch (s.step) {
    case "group":
      return send(chat, "Iltimos, guruhni tugmalardan tanlang.");
    case "topic": {
      if (text.length > LIMITS.topic) return send(chat, `Mavzu nomi ${LIMITS.topic} belgidan oshmasin.`);
      data.topic = canonTopic(text, await topicsList());
      return askTitle(chat, data);
    }
    case "title":
      if (text.length > LIMITS.title) return send(chat, `Nom ${LIMITS.title} belgidan oshmasin.`);
      data.title = text;
      return askStudent(chat, data);
    case "student":
      if (text.length > LIMITS.student) return send(chat, `Ism ${LIMITS.student} belgidan oshmasin.`);
      data.student = text;
      return askFiles(chat, data);
    case "files":
      return send(chat, "Endi PDF, PPTX yoki HTML faylni yuboring.");
    default:
      return send(chat, "Taqdimot yuborish uchun /start ni bosing.");
  }
}

async function onCallback(cq: Json) {
  const msg = cq.message as Json | undefined;
  const chat = (msg?.chat as Json | undefined)?.id as number | undefined;
  const value = String(cq.data ?? "");
  await tg("answerCallbackQuery", { callback_query_id: cq.id });
  if (!chat || !msg) return;
  const s = await getSession(chat);
  const data = s.data ?? {};
  const closeKeyboard = (text: string) =>
    tg("editMessageText", { chat_id: chat, message_id: msg.message_id, text, parse_mode: "HTML" });

  if (value.startsWith("g:") && s.step === "group" && GROUPS.includes(value.slice(2))) {
    data.group = value.slice(2);
    await closeKeyboard(`<b>1/5.</b> Guruh: <b>${esc(data.group)}</b>`);
    return askTopic(chat, data);
  }
  if (value.startsWith("t:") && s.step === "topic") {
    const v = value.slice(2);
    data.topic = v === "-" ? null : (data.topics ?? [])[Number(v)] ?? null;
    delete data.topics;
    await closeKeyboard(`<b>2/5.</b> Mavzu: <b>${esc(data.topic ?? "Mavzusiz")}</b>`);
    return askTitle(chat, data);
  }
  if (value === "done" && s.step === "files" && KINDS.some((k) => data.files?.[k])) {
    await tg("editMessageReplyMarkup", { chat_id: chat, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } });
    return finish(chat, data);
  }
  // stale button from an old message
  if (s.step === "saving") return;
  await send(chat, "Bu tugma eskirgan. Qaytadan boshlash uchun /start ni bosing.");
}

/* ---------- HTTP entry ---------- */
async function setup(): Promise<Response> {
  const url = `${SUPABASE_URL}/functions/v1/telegram-bot`;
  const hook = await tg("setWebhook", {
    url, secret_token: SECRET, allowed_updates: ["message", "callback_query"], drop_pending_updates: true,
  });
  await tg("setMyCommands", {
    commands: [
      { command: "start", description: "Taqdimot yuborish" },
      { command: "bekor", description: "Bekor qilish" },
      { command: "jpg", description: "PDF'ni JPEG rasmga aylantirish" },
      { command: "myid", description: "Chat ID'ni bilish" },
    ],
  });
  const me = await tg("getMe", {});
  return new Response(
    hook.ok ? `Tayyor! Bot @${(me.result as Json)?.username} ulandi: ${url}` : `Xato: ${JSON.stringify(hook)}`,
    { headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}

export async function handle(req: Request): Promise<Response> {
  if (!TOKEN || !SECRET) return new Response("TELEGRAM_BOT_TOKEN va TELEGRAM_WEBHOOK_SECRET sozlanmagan", { status: 500 });
  const u = new URL(req.url);
  const action = u.searchParams.get("action");
  if (action) return webApp(req, action); // calls from the PDF → JPEG Mini App
  if (req.method === "GET") {
    if (u.searchParams.get("setup") === SECRET) return setup();
    return new Response("ok");
  }
  if (req.headers.get("x-telegram-bot-api-secret-token") !== SECRET) return new Response("forbidden", { status: 401 });
  let update: Json;
  try { update = await req.json(); } catch { return new Response("bad request", { status: 400 }); }
  try {
    if (update.message) await onMessage(update.message as Json);
    else if (update.callback_query) await onCallback(update.callback_query as Json);
  } catch (e) {
    console.error("update", e); // answer 200 anyway, or Telegram keeps resending the same update
  }
  return new Response("ok");
}

// BOT_TEST lets tests import handle() without starting a server
if (!Deno.env.get("BOT_TEST")) Deno.serve(handle);

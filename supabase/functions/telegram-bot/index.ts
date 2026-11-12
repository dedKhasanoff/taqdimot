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
const MIME: Record<string, string> = {
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
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
const keyboard = (rows: { text: string; data: string }[][]) => ({
  reply_markup: { inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))) },
});
const chunk = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/* ---------- Conversation state (table bot_sessions) ---------- */
type FileRef = { file_id: string; name: string; size: number };
type Data = {
  group?: string; topic?: string | null; topics?: string[];
  title?: string; student?: string;
  files?: Partial<Record<"pdf" | "pptx", FileRef>>;
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
    "<b>5/5.</b> Taqdimot faylini yuboring: <b>PDF</b> yoki <b>PPTX</b>, 20 MB gacha.\n" +
    "Ikkalasini ham yuborsangiz yaxshi: PDF telefonda tiniqroq ko'rinadi.");
}

function fileKind(doc: Json): "pdf" | "pptx" | null {
  const name = String(doc.file_name ?? "").toLowerCase();
  const mime = String(doc.mime_type ?? "");
  if (name.endsWith(".pdf") || mime === MIME.pdf) return "pdf";
  if (name.endsWith(".pptx") || mime === MIME.pptx) return "pptx";
  return null;
}

async function onDocument(chat: number, s: Session, doc: Json) {
  if (s.step !== "files") {
    return send(chat, "Avval taqdimot ma'lumotlarini kiritamiz. Boshlash uchun /start ni bosing.");
  }
  const kind = fileKind(doc);
  if (!kind) {
    const ppt = String(doc.file_name ?? "").toLowerCase().endsWith(".ppt");
    return send(chat, ppt
      ? "Eski .ppt format qabul qilinmaydi. PowerPoint'da <b>Fayl → Saqlash</b> orqali .pptx yoki PDF qilib saqlang va qayta yuboring."
      : "Faqat <b>PDF</b> yoki <b>PPTX</b> fayl qabul qilinadi.");
  }
  const size = Number(doc.file_size ?? 0);
  if (size > MAX_BYTES) {
    return send(chat, `Fayl juda katta (${(size / 1048576).toFixed(1)} MB). 20 MB gacha bo'lishi kerak. ` +
      "PowerPoint'da rasmlarni siqib (Compress Pictures) qayta saqlab ko'ring.");
  }
  const data = s.data;
  data.files = { ...(data.files ?? {}), [kind]: { file_id: String(doc.file_id), name: String(doc.file_name ?? kind), size } };
  if (data.files.pdf && data.files.pptx) return finish(chat, data);
  await setSession(chat, "files", data);
  const other = kind === "pdf" ? "PPTX" : "PDF";
  await send(chat,
    `✅ ${kind.toUpperCase()} qabul qilindi.\n${other} ham bo'lsa, uni yuboring. Bo'lmasa, «Yuborish» tugmasini bosing.`,
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
    const files: { kind: string; path: string; name: string; size: number }[] = [];
    let cover: string | null = null;
    for (const kind of ["pdf", "pptx"] as const) {
      const ref = data.files?.[kind];
      if (!ref) continue;
      const bytes = await download(ref.file_id);
      const path = `${g}/${crypto.randomUUID()}.${kind}`;
      const { error } = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: MIME[kind], upsert: false });
      if (error) throw error;
      uploaded.push(path);
      files.push({ kind, path, name: ref.name, size: bytes.length });
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

/* ---------- Update router ---------- */
async function onMessage(msg: Json) {
  const chat = (msg.chat as Json).id as number;
  if ((msg.chat as Json).type !== "private") return; // only direct chats
  const text = String(msg.text ?? "").trim();
  const cmd = text.startsWith("/") ? text.split(/[\s@]/)[0].toLowerCase() : "";

  if (cmd === "/start" || cmd === "/yangi") return askGroup(chat);
  if (cmd === "/bekor" || cmd === "/cancel") {
    await setSession(chat, "idle", {});
    return send(chat, "Bekor qilindi. Qaytadan boshlash uchun /start ni bosing.");
  }
  if (cmd === "/myid") return send(chat, `Sizning chat ID: <code>${chat}</code>`);
  if (cmd === "/help" || cmd === "/yordam") {
    return send(chat, "/start — taqdimot yuborish\n/bekor — bekor qilish" + (SITE ? `\n\nSayt: ${SITE}` : ""));
  }

  const s = await getSession(chat);
  if (msg.document) return onDocument(chat, s, msg.document as Json);
  if (s.step === "saving") return send(chat, "⏳ Taqdimot saqlanmoqda, biroz kuting…");
  if (!text || cmd) {
    if (s.step === "files") return send(chat, "Iltimos, PDF yoki PPTX faylni <b>fayl (document)</b> sifatida yuboring.");
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
      return send(chat, "Endi PDF yoki PPTX faylni yuboring.");
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
  if (value === "done" && s.step === "files" && (data.files?.pdf || data.files?.pptx)) {
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

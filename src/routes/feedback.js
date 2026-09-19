import { Router } from "express";
import jwt from "jsonwebtoken";
import { sendFeedbackMail } from "../utils/feedbackMail.js";

const router = Router();

/**
 * POST /api/feedback/report       { text, platform?, appVersion?, lang? }
 * POST /api/feedback/suggestion   { title, desc, help?, platform?, appVersion?, lang? }
 *
 * Los usa tanto la app como la web. No exigen sesión, pero si llega el token
 * (Authorization: Bearer ...) se añade el correo del usuario al mensaje y se
 * usa como "responder a".
 */

// ── Límite simple anti-spam: 5 envíos cada 10 min por IP ───────────────
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    const fresh = arr.filter((t) => now - t < WINDOW_MS);
    if (fresh.length) hits.set(ip, fresh);
    else hits.delete(ip);
  }
}, WINDOW_MS).unref();

function allowed(req) {
  const ip = req.ip || "unknown";
  const now = Date.now();
  const fresh = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (fresh.length >= MAX_PER_WINDOW) {
    hits.set(ip, fresh);
    return false;
  }
  fresh.push(now);
  hits.set(ip, fresh);
  return true;
}

// ── Utilidades ─────────────────────────────────────────────────────────
const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

const PLATFORMS = new Set(["web", "app-android", "app-ios", "app"]);

function getMeta(req) {
  const b = req.body || {};
  let usuario = null;
  const h = req.headers.authorization;
  if (h && h.startsWith("Bearer ")) {
    try {
      usuario = jwt.verify(h.split(" ")[1], process.env.JWT_SECRET);
    } catch {}
  }
  const platform = PLATFORMS.has(b.platform) ? b.platform : "desconocida";
  return {
    platform,
    appVersion: clean(b.appVersion, 20),
    lang: clean(b.lang, 10),
    userEmail: usuario?.correo || "",
    userId: usuario?.id ? String(usuario.id) : "",
  };
}

const metaFields = (m, req) => [
  ["Plataforma", m.platform],
  ["Versión de la app", m.appVersion],
  ["Idioma", m.lang],
  ["Usuario", m.userEmail || "(sin sesión)"],
  ["Fecha", new Date().toLocaleString("es", { timeZone: "UTC" }) + " UTC"],
  ["IP", req.ip],
];

async function deliver(res, mailOpts) {
  try {
    await sendFeedbackMail(mailOpts);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[feedback] no se pudo enviar el correo:", err.message);
    if (err.code === "NOT_CONFIGURED") {
      return res.status(503).json({ error: "El envío no está configurado en el servidor." });
    }
    return res.status(502).json({ error: "No se pudo enviar. Intenta de nuevo más tarde." });
  }
}

// ── Rutas ──────────────────────────────────────────────────────────────
router.post("/report", async (req, res) => {
  const text = clean(req.body?.text, 3000);
  if (text.length < 5) {
    return res.status(400).json({ error: "Describe el problema (mínimo 5 caracteres)." });
  }
  if (!allowed(req)) {
    return res.status(429).json({ error: "Demasiados envíos. Intenta de nuevo en unos minutos." });
  }

  const m = getMeta(req);
  await deliver(res, {
    kind: "report",
    subject: `[KōmiVerso] Problema reportado (${m.platform})`,
    title: "Nuevo reporte de problema",
    fields: [["Problema", text], ...metaFields(m, req)],
    replyTo: m.userEmail || undefined,
  });
});

router.post("/suggestion", async (req, res) => {
  const title = clean(req.body?.title, 120);
  const desc = clean(req.body?.desc, 3000);
  const help = clean(req.body?.help, 2000);
  if (title.length < 3 || desc.length < 5) {
    return res.status(400).json({ error: "Completa el título y la descripción." });
  }
  if (!allowed(req)) {
    return res.status(429).json({ error: "Demasiados envíos. Intenta de nuevo en unos minutos." });
  }

  const m = getMeta(req);
  await deliver(res, {
    kind: "suggestion",
    subject: `[KōmiVerso] Nueva sugerencia: ${title}`,
    title: "Nueva sugerencia",
    fields: [
      ["Título", title],
      ["Descripción", desc],
      ["Cómo ayudaría", help],
      ...metaFields(m, req),
    ],
    replyTo: m.userEmail || undefined,
  });
});

export default router;

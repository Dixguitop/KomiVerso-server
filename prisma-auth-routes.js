import bcrypt from "bcryptjs";
import { Router } from "express";

const SALT_ROUNDS = 10;
const CODE_TTL_MS = 15 * 60 * 1000;

const ESTADO_MAP = {
  leyendo: "leyendo",
  completados: "completado",
  pendientes: "pendiente",
  pausados: "pausados",
  abandonados: "abandonados",
};
const ESTADO_REVERSE = Object.fromEntries(
  Object.entries(ESTADO_MAP).map(([k, v]) => [v, k])
);

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.correo,
    username: u.username,
    avatar: u.avatar,
    bio: u.bio || "",
    verificado: !!u.verificado,
    createdAt: u.creadoEn ? new Date(u.creadoEn).getTime() : Date.now(),
    xp: u.xp ?? 0,
    level: u.level ?? 1,
    titles: Array.isArray(u.titles) ? u.titles : [],
    activeTitle: u.activeTitle || null,
  };
}

function listEntryToFront(row) {
  return {
    id: row.mangaId,
    title: row.titulo,
    cover: row.cover || null,
    updatedAt: row.actualizadoEn ? new Date(row.actualizadoEn).getTime() : Date.now(),
    estado: ESTADO_REVERSE[row.estado] || row.estado,
    favorito: row.favorito,
    capituloActual: row.capituloActual,
  };
}

function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendVerificationEmail(to, code, username) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "KōmiVerso <onboarding@resend.dev>";

  if (!apiKey) {
    console.warn("[email] RESEND_API_KEY no configurada. Código (solo dev):", code, "→", to);
    return { ok: false, devCode: code };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: "Tu código de verificación — KōmiVerso",
      html: `
        <div style="font-family:sans-serif;max-width:420px;margin:0 auto">
          <h2>Hola${username ? ", " + username : ""}</h2>
          <p>Tu código de verificación es:</p>
          <p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p>
          <p style="color:#666">Caduca en 15 minutos. Si no creaste una cuenta en KōmiVerso, ignora este correo.</p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("[email] Resend error:", res.status, err);
    throw new Error("No se pudo enviar el correo de verificación.");
  }
  return { ok: true };
}

export function createPrismaRoutes(prisma) {
  const router = Router();

  router.post("/auth/signup", async (req, res) => {
    try {
      const email = String(req.body.email || "").trim().toLowerCase();
      const username = String(req.body.username || "").trim();
      const password = String(req.body.password || "");
      if (!email || !username || !password) {
        return res.status(400).json({ error: "Completa todos los campos." });
      }
      if (password.length < 4) {
        return res.status(400).json({ error: "La contraseña debe tener al menos 4 caracteres." });
      }
      const existing = await prisma.usuario.findUnique({ where: { correo: email } });
      if (existing && existing.verificado) {
        return res.status(409).json({ error: "Ya existe una cuenta con ese correo." });
      }

      const passHash = await bcrypt.hash(password, SALT_ROUNDS);
      const code = genCode();
      const codigoExpira = new Date(Date.now() + CODE_TTL_MS);

      let u;
      if (existing && !existing.verificado) {
        u = await prisma.usuario.update({
          where: { id: existing.id },
          data: { username, passHash, codigoVerif: code, codigoExpira, verificado: false },
        });
      } else {
        u = await prisma.usuario.create({
          data: {
            correo: email,
            username,
            passHash,
            verificado: false,
            codigoVerif: code,
            codigoExpira,
          },
        });
      }

      let emailResult;
      try {
        emailResult = await sendVerificationEmail(email, code, username);
      } catch (e) {
        return res.status(502).json({
          error: e.message || "No se pudo enviar el correo.",
          needsVerification: true,
          email,
        });
      }

      res.json({
        needsVerification: true,
        email,
        ...(emailResult.devCode ? { devCode: emailResult.devCode } : {}),
        message: "Te enviamos un código a tu correo. Introdúcelo para activar la cuenta.",
      });
    } catch (e) {
      console.error("signup", e);
      res.status(500).json({ error: "Error al registrar." });
    }
  });

  router.post("/auth/verify", async (req, res) => {
    try {
      const email = String(req.body.email || "").trim().toLowerCase();
      const code = String(req.body.code || "").trim();
      if (!email || !code) {
        return res.status(400).json({ error: "Correo y código requeridos." });
      }
      const u = await prisma.usuario.findUnique({ where: { correo: email } });
      if (!u) return res.status(404).json({ error: "No existe una cuenta con ese correo." });
      if (u.verificado) {
        return res.json({ user: publicUser(u), message: "La cuenta ya estaba verificada." });
      }
      if (!u.codigoVerif || u.codigoVerif !== code) {
        return res.status(400).json({ error: "Código incorrecto." });
      }
      if (u.codigoExpira && new Date(u.codigoExpira) < new Date()) {
        return res.status(400).json({ error: "El código ha caducado. Solicita uno nuevo." });
      }
      const updated = await prisma.usuario.update({
        where: { id: u.id },
        data: { verificado: true, codigoVerif: null, codigoExpira: null },
      });
      res.json({ user: publicUser(updated) });
    } catch (e) {
      console.error("verify", e);
      res.status(500).json({ error: "Error al verificar." });
    }
  });

  router.post("/auth/resend-code", async (req, res) => {
    try {
      const email = String(req.body.email || "").trim().toLowerCase();
      if (!email) return res.status(400).json({ error: "Falta el correo." });
      const u = await prisma.usuario.findUnique({ where: { correo: email } });
      if (!u) return res.status(404).json({ error: "No existe una cuenta con ese correo." });
      if (u.verificado) {
        return res.status(400).json({ error: "La cuenta ya está verificada." });
      }
      const code = genCode();
      const codigoExpira = new Date(Date.now() + CODE_TTL_MS);
      await prisma.usuario.update({
        where: { id: u.id },
        data: { codigoVerif: code, codigoExpira },
      });
      let emailResult;
      try {
        emailResult = await sendVerificationEmail(email, code, u.username);
      } catch (e) {
        return res.status(502).json({ error: e.message || "No se pudo enviar el correo." });
      }
      res.json({
        ok: true,
        message: "Código reenviado.",
        ...(emailResult.devCode ? { devCode: emailResult.devCode } : {}),
      });
    } catch (e) {
      console.error("resend", e);
      res.status(500).json({ error: "Error al reenviar." });
    }
  });

  router.post("/auth/login", async (req, res) => {
    try {
      const email = String(req.body.email || "").trim().toLowerCase();
      const password = String(req.body.password || "");
      if (!email || !password) {
        return res.status(400).json({ error: "Completa correo y contraseña." });
      }
      const u = await prisma.usuario.findUnique({ where: { correo: email } });
      if (!u || !(await bcrypt.compare(password, u.passHash))) {
        return res.status(401).json({ error: "Correo o contraseña incorrectos." });
      }
      if (!u.verificado) {
        return res.status(403).json({
          error: "Debes verificar tu correo antes de entrar.",
          needsVerification: true,
          email,
        });
      }
      res.json({ user: publicUser(u) });
    } catch (e) {
      console.error("login", e);
      res.status(500).json({ error: "Error al iniciar sesión." });
    }
  });

  router.post("/auth/recover", async (req, res) => {
    try {
      const email = String(req.body.email || "").trim().toLowerCase();
      const password = String(req.body.password || "");
      if (!email || !password) {
        return res.status(400).json({ error: "Ingresa correo y nueva contraseña." });
      }
      if (password.length < 4) {
        return res.status(400).json({ error: "La contraseña debe tener al menos 4 caracteres." });
      }
      const u = await prisma.usuario.findUnique({ where: { correo: email } });
      if (!u) return res.status(404).json({ error: "No existe una cuenta con ese correo." });
      if (!u.verificado) {
        return res.status(403).json({ error: "Verifica tu correo antes de cambiar la contraseña." });
      }
      const passHash = await bcrypt.hash(password, SALT_ROUNDS);
      await prisma.usuario.update({ where: { id: u.id }, data: { passHash } });
      res.json({ ok: true });
    } catch (e) {
      console.error("recover", e);
      res.status(500).json({ error: "Error al restablecer." });
    }
  });

  router.patch("/auth/profile", async (req, res) => {
    try {
      const email = String(req.body.email || "").trim().toLowerCase();
      if (!email) return res.status(400).json({ error: "Falta email." });
      const u = await prisma.usuario.findUnique({ where: { correo: email } });
      if (!u) return res.status(404).json({ error: "Usuario no encontrado." });
      const data = {};
      if (req.body.username != null) data.username = String(req.body.username);
      if (req.body.bio != null) data.bio = String(req.body.bio);
      if (req.body.avatar != null) data.avatar = req.body.avatar;
      const updated = await prisma.usuario.update({ where: { id: u.id }, data });
      res.json({ user: publicUser(updated) });
    } catch (e) {
      console.error("profile", e);
      res.status(500).json({ error: "Error al actualizar perfil." });
    }
  });

  router.get("/library/:email", async (req, res) => {
    try {
      const email = String(req.params.email || "").trim().toLowerCase();
      const u = await prisma.usuario.findUnique({ where: { correo: email } });
      if (!u) {
        return res.json({
          favoritos: [], leyendo: [], completados: [], pendientes: [], pausados: [], abandonados: [],
        });
      }
      const rows = await prisma.listaManga.findMany({
        where: { usuarioId: u.id },
        orderBy: { actualizadoEn: "desc" },
      });
      const lib = {
        favoritos: [], leyendo: [], completados: [], pendientes: [], pausados: [], abandonados: [],
      };
      for (const row of rows) {
        const item = listEntryToFront(row);
        if (row.favorito) lib.favoritos.push(item);
        const key = ESTADO_REVERSE[row.estado];
        if (key && lib[key]) lib[key].push(item);
      }
      res.json(lib);
    } catch (e) {
      console.error("library get", e);
      res.status(500).json({ error: "Error al cargar biblioteca." });
    }
  });

  router.post("/library/set-status", async (req, res) => {
    try {
      const email = String(req.body.email || "").trim().toLowerCase();
      const manga = req.body.manga || {};
      const listKey = req.body.listKey;
      const u = await prisma.usuario.findUnique({ where: { correo: email } });
      if (!u) return res.status(404).json({ error: "Usuario no encontrado." });
      if (!manga.id) return res.status(400).json({ error: "Falta manga.id" });

      const existing = await prisma.listaManga.findUnique({
        where: { usuarioId_mangaId: { usuarioId: u.id, mangaId: manga.id } },
      });

      if (listKey === null || listKey === undefined || listKey === "") {
        if (existing) {
          if (existing.favorito) {
            await prisma.listaManga.update({
              where: { id: existing.id },
              data: { estado: "pendiente" },
            });
          } else {
            await prisma.listaManga.delete({ where: { id: existing.id } });
          }
        }
      } else {
        const estado = ESTADO_MAP[listKey] || listKey;
        await prisma.listaManga.upsert({
          where: { usuarioId_mangaId: { usuarioId: u.id, mangaId: manga.id } },
          create: {
            usuarioId: u.id,
            mangaId: manga.id,
            titulo: manga.title || "Sin título",
            cover: manga.cover || null,
            estado,
            favorito: existing?.favorito || false,
          },
          update: {
            titulo: manga.title || existing?.titulo || "Sin título",
            cover: manga.cover ?? existing?.cover,
            estado,
          },
        });
      }
      res.json({ ok: true });
    } catch (e) {
      console.error("set-status", e);
      res.status(500).json({ error: "Error al actualizar lista." });
    }
  });

  router.post("/library/toggle-favorite", async (req, res) => {
    try {
      const email = String(req.body.email || "").trim().toLowerCase();
      const manga = req.body.manga || {};
      const u = await prisma.usuario.findUnique({ where: { correo: email } });
      if (!u) return res.status(404).json({ error: "Usuario no encontrado." });
      if (!manga.id) return res.status(400).json({ error: "Falta manga.id" });

      const existing = await prisma.listaManga.findUnique({
        where: { usuarioId_mangaId: { usuarioId: u.id, mangaId: manga.id } },
      });

      if (existing) {
        await prisma.listaManga.update({
          where: { id: existing.id },
          data: { favorito: !existing.favorito },
        });
      } else {
        await prisma.listaManga.create({
          data: {
            usuarioId: u.id,
            mangaId: manga.id,
            titulo: manga.title || "Sin título",
            cover: manga.cover || null,
            estado: "pendiente",
            favorito: true,
          },
        });
      }
      res.json({ ok: true });
    } catch (e) {
      console.error("toggle-favorite", e);
      res.status(500).json({ error: "Error al actualizar favorito." });
    }
  });

  router.get("/comments/:mangaId/:chapterId?", async (req, res) => {
    try {
      const { mangaId, chapterId } = req.params;
      const where = chapterId ? { mangaId, chapterId } : { mangaId, chapterId: null };
      const rows = await prisma.comentario.findMany({
        where,
        orderBy: { creadoEn: "desc" },
        include: { usuario: true },
      });
      res.json(
        rows.map((c) => ({
          id: c.id,
          user: c.usuario.username,
          avatar: c.usuario.avatar,
          text: c.texto,
          spoiler: c.spoiler,
          likes: [],
          pinned: false,
          ts: new Date(c.creadoEn).getTime(),
        }))
      );
    } catch (e) {
      console.error("comments get", e);
      res.status(500).json({ error: "Error al cargar comentarios." });
    }
  });

  router.post("/comments", async (req, res) => {
    try {
      const email = String(req.body.email || "").trim().toLowerCase();
      const mangaId = req.body.mangaId;
      const chapterId = req.body.chapterId || null;
      const text = String(req.body.text || "").trim();
      const spoiler = !!req.body.spoiler;
      if (!email || !mangaId || !text) {
        return res.status(400).json({ error: "Faltan datos." });
      }
      const u = await prisma.usuario.findUnique({ where: { correo: email } });
      if (!u) return res.status(404).json({ error: "Usuario no encontrado." });
      const c = await prisma.comentario.create({
        data: { usuarioId: u.id, mangaId, chapterId, texto: text, spoiler },
        include: { usuario: true },
      });
      res.json({
        id: c.id,
        user: c.usuario.username,
        avatar: c.usuario.avatar,
        text: c.texto,
        spoiler: c.spoiler,
        likes: [],
        pinned: false,
        ts: new Date(c.creadoEn).getTime(),
      });
    } catch (e) {
      console.error("comments post", e);
      res.status(500).json({ error: "Error al publicar." });
    }
  });

  return router;
}

export default createPrismaRoutes;

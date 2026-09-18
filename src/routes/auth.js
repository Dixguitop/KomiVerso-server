import { Router } from "express";
import jwt from "jsonwebtoken";
import prisma from "../../db.js";
import { generarCodigo, enviarCodigoVerificacion } from "../utils/mailer.js";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { subirAvatar } from "../utils/supabase.js";

const router = Router();

function publicUser(u) {
  const planActivo =
    u.plan === "fan" &&
    (u.planStatus === "active" || u.planStatus === "trialing" || u.planStatus === "past_due");
  return {
    id: u.id,
    correo: u.correo,
    username: u.username,
    bio: u.bio,
    avatar: u.avatar,
    xp: u.xp ?? 0,
    level: u.level ?? 1,
    titles: Array.isArray(u.titles) ? u.titles : [],
    activeTitle: u.activeTitle || null,
    plan: planActivo ? "fan" : "free",
    planStatus: u.planStatus || null,
    planRenewsAt: u.planRenewsAt || null,
    muestraAnuncios: !planActivo,
  };
}

router.post("/solicitar-codigo", async (req, res) => {
  const { correo } = req.body;
  if (!correo || !/^\S+@\S+\.\S+$/.test(correo)) {
    return res.status(400).json({ error: "Correo inválido" });
  }

  const codigo = generarCodigo();
  const codigoExpira = new Date(Date.now() + 10 * 60 * 1000);

  const usuario = await prisma.usuario.upsert({
    where: { correo },
    update: { codigoVerif: codigo, codigoExpira },
    create: { correo, codigoVerif: codigo, codigoExpira },
  });

  try {
    await enviarCodigoVerificacion(correo, codigo);
  } catch (err) {
    return res.status(502).json({ error: "No se pudo enviar el correo", detail: err.message });
  }

  res.json({ ok: true, mensaje: "Código enviado", usuarioId: usuario.id });
});

router.post("/verificar-codigo", async (req, res) => {
  const { correo, codigo } = req.body;
  if (!correo || !codigo) {
    return res.status(400).json({ error: "Faltan datos" });
  }

  const usuario = await prisma.usuario.findUnique({ where: { correo } });
  if (!usuario || usuario.codigoVerif !== codigo) {
    return res.status(401).json({ error: "Código incorrecto" });
  }
  if (!usuario.codigoExpira || usuario.codigoExpira < new Date()) {
    return res.status(401).json({ error: "El código expiró, solicita uno nuevo" });
  }

  const actualizado = await prisma.usuario.update({
    where: { correo },
    data: { verificado: true, codigoVerif: null, codigoExpira: null },
  });

  const token = jwt.sign(
    { id: actualizado.id, correo: actualizado.correo },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );

  res.json({ ok: true, token, usuario: publicUser(actualizado) });
});

router.patch("/profile", authMiddleware, async (req, res) => {
  console.log("BODY RECIBIDO:", JSON.stringify(req.body)?.slice(0, 200));
  try {
    const data = {};

    if (req.body.username !== undefined) {
      const username = String(req.body.username).trim();
      if (username.length < 3 || username.length > 20) {
        return res.status(400).json({ error: "El usuario debe tener entre 3 y 20 caracteres" });
      }
      if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        return res.status(400).json({ error: "Solo se permiten letras, números y guion bajo" });
      }
      const enUso = await prisma.usuario.findFirst({
        where: { username, NOT: { id: req.usuario.id } },
      });
      if (enUso) {
        return res.status(409).json({ error: "Ese nombre de usuario ya está en uso" });
      }
      data.username = username;
    }

    if (req.body.bio !== undefined) {
      data.bio = String(req.body.bio).slice(0, 300);
    }

    if (req.body.avatar !== undefined) {
      data.avatar = req.body.avatar === null
        ? null
        : await subirAvatar(req.usuario.id, req.body.avatar);
    }

    if (req.body.xp !== undefined) {
      const xp = Math.max(0, Math.floor(Number(req.body.xp) || 0));
      data.xp = xp;
    }
    if (req.body.level !== undefined) {
      const level = Math.max(1, Math.min(99, Math.floor(Number(req.body.level) || 1)));
      data.level = level;
    }
    if (req.body.titles !== undefined) {
      data.titles = Array.isArray(req.body.titles)
        ? req.body.titles.map(String).slice(0, 50)
        : [];
    }
    if (req.body.activeTitle !== undefined) {
      data.activeTitle = req.body.activeTitle === null || req.body.activeTitle === ""
        ? null
        : String(req.body.activeTitle).slice(0, 60);
    }

    const actualizado = await prisma.usuario.update({
      where: { id: req.usuario.id },
      data,
    });

    res.json({ usuario: publicUser(actualizado) });
  } catch (err) {
    console.error("profile update", err);
    res.status(500).json({ error: err.message || "Error al actualizar perfil" });
  }
});

router.get("/me", authMiddleware, async (req, res) => {
  const usuario = await prisma.usuario.findUnique({ where: { id: req.usuario.id } });
  if (!usuario) return res.status(404).json({ error: "Usuario no encontrado" });
  res.json({ usuario: publicUser(usuario) });
});

export default router;

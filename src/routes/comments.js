import { Router } from "express";
import prisma from "../../db.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = Router();

router.get("/:mangaId", async (req, res) => {
  const comentarios = await prisma.comentario.findMany({
    where: { mangaId: req.params.mangaId, parentId: null },
    orderBy: { creadoEn: "desc" },
    include: {
      usuario: { select: { username: true, avatar: true } },
      replies: {
        orderBy: { creadoEn: "asc" },
        include: { usuario: { select: { username: true, avatar: true } } },
      },
    },
  });
  res.json(comentarios);
});

router.post("/", authMiddleware, async (req, res) => {
  const { mangaId, texto, chapterId, spoiler, parentId } = req.body;
  if (!mangaId || !texto?.trim()) {
    return res.status(400).json({ error: "Faltan mangaId o texto" });
  }

  if (parentId) {
    const padre = await prisma.comentario.findUnique({ where: { id: parentId } });
    if (!padre || padre.mangaId !== mangaId) {
      return res.status(400).json({ error: "El comentario padre no existe" });
    }
  }

  const comentario = await prisma.comentario.create({
    data: {
      mangaId,
      chapterId: chapterId || null,
      texto: texto.trim(),
      spoiler: !!spoiler,
      parentId: parentId || null,
      usuarioId: req.usuario.id,
    },
    include: { usuario: { select: { username: true, avatar: true } } },
  });

  res.json(comentario);
});

router.delete("/:id", authMiddleware, async (req, res) => {
  const comentario = await prisma.comentario.findUnique({
    where: { id: req.params.id },
  });

  if (!comentario) return res.status(404).json({ error: "No existe" });

  if (comentario.usuarioId !== req.usuario.id) {
    return res.status(403).json({ error: "No puedes borrar comentarios de otros usuarios" });
  }

  await prisma.comentario.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

export default router;

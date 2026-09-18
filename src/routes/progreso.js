import { Router } from "express";
import prisma from "../../db.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = Router();
router.use(authMiddleware);

router.post("/", async (req, res) => {
  const { mangaId, chapterId } = req.body;
  if (!mangaId || !chapterId) {
    return res.status(400).json({ error: "Faltan mangaId o chapterId" });
  }

  const registro = await prisma.capituloLeido.upsert({
    where: { usuarioId_chapterId: { usuarioId: req.usuario.id, chapterId } },
    update: {},
    create: { usuarioId: req.usuario.id, mangaId, chapterId },
  });

  res.json(registro);
});

router.get("/:mangaId", async (req, res) => {
  const { mangaId } = req.params;

  const leidos = await prisma.capituloLeido.findMany({
    where: { usuarioId: req.usuario.id, mangaId },
    select: { chapterId: true },
  });

  res.json(leidos.map((l) => l.chapterId));
});

router.post("/lote", async (req, res) => {
  const { mangaId, chapterIds, leido } = req.body;
  if (!mangaId || !Array.isArray(chapterIds) || !chapterIds.length) {
    return res.status(400).json({ error: "Faltan mangaId o chapterIds" });
  }

  if (leido === false) {
    await prisma.capituloLeido.deleteMany({
      where: { usuarioId: req.usuario.id, chapterId: { in: chapterIds } },
    });
  } else {
    await prisma.$transaction(
      chapterIds.map((chapterId) =>
        prisma.capituloLeido.upsert({
          where: { usuarioId_chapterId: { usuarioId: req.usuario.id, chapterId } },
          update: {},
          create: { usuarioId: req.usuario.id, mangaId, chapterId },
        })
      )
    );
  }

  res.json({ ok: true, count: chapterIds.length, leido: leido !== false });
});

export default router;

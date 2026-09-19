import { Router } from "express";
import prisma from "../../db.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = Router();
router.use(authMiddleware);

router.get("/", async (req, res) => {
  const listas = await prisma.listaManga.findMany({
    where: { usuarioId: req.usuario.id },
    orderBy: { actualizadoEn: "desc" },
  });
  res.json(listas);
});

router.post("/", async (req, res) => {
  const { mangaId, titulo, estado, capituloActual, cover } = req.body;
  if (!mangaId || !titulo) {
    return res.status(400).json({ error: "Faltan mangaId o titulo" });
  }

  const lista = await prisma.listaManga.upsert({
    where: { usuarioId_mangaId: { usuarioId: req.usuario.id, mangaId } },
    update: { estado, capituloActual, titulo, ...(cover !== undefined ? { cover } : {}) },
    create: {
      usuarioId: req.usuario.id,
      mangaId,
      titulo,
      cover: cover || null,
      estado: estado || "leyendo",
      capituloActual: capituloActual || 0,
    },
  });

  res.json(lista);
});

router.delete("/:mangaId", async (req, res) => {
  const { mangaId } = req.params;

  const existe = await prisma.listaManga.findUnique({
    where: { usuarioId_mangaId: { usuarioId: req.usuario.id, mangaId } },
  });
  if (!existe) return res.status(404).json({ error: "No está en tu lista" });

  await prisma.listaManga.delete({
    where: { usuarioId_mangaId: { usuarioId: req.usuario.id, mangaId } },
  });

  res.json({ ok: true });
});

export default router;


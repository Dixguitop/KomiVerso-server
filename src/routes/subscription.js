import { Router } from "express";
import prisma from "../../db.js";
import { authMiddleware } from "../middleware/authMiddleware.js";
import {
  crearCheckoutFanURL,
  cancelarSuscripcion,
  verificarFirmaPostback,
} from "../utils/verotel.js";

const router = Router();

const EVENTOS_SIN_ACCESO = new Set(["cancel", "expiry", "chargeback", "refund", "credit"]);

function estadoDePlan(usuario) {
  const activo =
    usuario.plan === "fan" &&
    (usuario.planStatus === "active" || usuario.planStatus === "initial" || usuario.planStatus === "rebill");
  return {
    plan: activo ? "fan" : "free",
    planStatus: usuario.planStatus || null,
    planRenewsAt: usuario.planRenewsAt || null,
    muestraAnuncios: !activo,
  };
}

router.get("/estado", authMiddleware, async (req, res) => {
  const usuario = await prisma.usuario.findUnique({ where: { id: req.usuario.id } });
  if (!usuario) return res.status(404).json({ error: "Usuario no encontrado" });
  res.json(estadoDePlan(usuario));
});

router.post("/checkout", authMiddleware, async (req, res) => {
  try {
    const usuario = await prisma.usuario.findUnique({ where: { id: req.usuario.id } });
    if (!usuario) return res.status(404).json({ error: "Usuario no encontrado" });

    const url = crearCheckoutFanURL({ usuarioId: usuario.id, correo: usuario.correo });
    res.json({ url });
  } catch (err) {
    console.error("checkout verotel:", err);
    res.status(502).json({ error: err.message || "No se pudo iniciar el pago" });
  }
});

router.post("/cancelar", authMiddleware, async (req, res) => {
  try {
    const usuario = await prisma.usuario.findUnique({ where: { id: req.usuario.id } });
    if (!usuario?.verotelSaleID) {
      return res.status(400).json({ error: "No tienes una suscripción activa" });
    }
    await cancelarSuscripcion(usuario.verotelSaleID);
    res.json({ ok: true, mensaje: "La suscripción se cancelará al final del periodo ya pagado" });
  } catch (err) {
    console.error("cancelar verotel:", err);
    res.status(502).json({ error: err.message || "No se pudo cancelar" });
  }
});

router.all("/postback", async (req, res) => {
  const datos = { ...req.query, ...(req.body || {}) };

  console.log("Postback de Verotel recibido:", datos);

  if (!verificarFirmaPostback(datos)) {
    console.warn("Postback de Verotel con firma inválida:", datos);
    return res.status(401).send("Firma inválida");
  }

  const usuarioId = datos.custom1 || null;
  const saleID = datos.saleID ? String(datos.saleID) : null;
  const evento = String(datos.event || datos.type || "").toLowerCase();
  const renewsAtRaw = datos.nextChargeOn || datos.next_charge_date || datos.expiryDate || null;
  const planRenewsAt = renewsAtRaw ? new Date(renewsAtRaw) : null;
  const sinAcceso = EVENTOS_SIN_ACCESO.has(evento);

  try {
    if (usuarioId) {
      await prisma.usuario.update({
        where: { id: usuarioId },
        data: {
          plan: sinAcceso ? "free" : "fan",
          planStatus: evento || (sinAcceso ? "canceled" : "active"),
          planRenewsAt: sinAcceso ? null : planRenewsAt,
          ...(saleID ? { verotelSaleID: saleID } : {}),
        },
      });
    } else if (saleID) {
      await prisma.usuario.updateMany({
        where: { verotelSaleID: saleID },
        data: {
          plan: sinAcceso ? "free" : "fan",
          planStatus: evento || (sinAcceso ? "canceled" : "active"),
          planRenewsAt: sinAcceso ? null : planRenewsAt,
        },
      });
    } else {
      console.warn("Postback de Verotel sin custom1 ni saleID, no se pudo aplicar:", datos);
    }
  } catch (err) {
    console.error("Error procesando postback de Verotel:", err);
  }

  res.status(200).send("OK");
});

export default router;

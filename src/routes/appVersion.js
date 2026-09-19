import { Router } from "express";

const router = Router();

/**
 * GET /api/app/version
 *
 * Esto es lo que "administras" para forzar o avisar de una actualización.
 * No necesitas tocar la base de datos ni la app: solo cambias estas
 * variables de entorno en Render (Dashboard → tu servicio → Environment)
 * y el servidor las lee al vuelo, sin rebuild.
 *
 * - APP_LATEST_VERSION: última versión que publicaste (informativo).
 * - APP_MIN_VERSION: versión mínima permitida. Si la app instalada es
 *   MENOR a este número, se bloquea con la pantalla de actualización
 *   obligatoria. Súbela solo cuando quieras forzar a todos a actualizar
 *   (por ejemplo, tras un cambio incompatible en la API).
 * - APP_DOWNLOAD_URL: a dónde manda el botón "Actualizar ahora".
 * - APP_UPDATE_MESSAGE: mensaje opcional que se muestra en la app.
 */
router.get("/version", (req, res) => {
  res.json({
    latestVersion: process.env.APP_LATEST_VERSION || "1.0.0",
    minVersion: process.env.APP_MIN_VERSION || "1.0.0",
    downloadUrl: process.env.APP_DOWNLOAD_URL || "https://komiverso.app/descargas",
    message:
      process.env.APP_UPDATE_MESSAGE ||
      "Hay una nueva versión de KōmiVerso disponible. Actualiza para seguir disfrutando de la app.",
  });
});

export default router;


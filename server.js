import express from "express";
import cors from "cors";
import "dotenv/config";

import authRouter from "./src/routes/auth.js";
import commentsRouter from "./src/routes/comments.js";
import listsRouter from "./src/routes/lists.js";
import manhwaRouter from "./src/routes/manhwa.js";
import progresoRouter from "./src/routes/progreso.js";
import subscriptionRouter from "./src/routes/subscription.js";
import appVersionRouter from "./src/routes/appVersion.js";
import cron from "node-cron";
import { runScraper } from "./src/scraper/index.js";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api/auth", authRouter);
app.use("/api/comentarios", commentsRouter);
app.use("/api/listas", listsRouter);
app.use("/api/manhwa", manhwaRouter);
app.use("/api/progreso", progresoRouter);
app.use("/api/suscripcion", subscriptionRouter);
app.use("/api/app", appVersionRouter);

app.get("/", (req, res) => res.json({
  ok: true,
  name: "KōmiVerso API",
  source: "ManhwaWeb",
  endpoints: {
    catalogo: "/api/manhwa",
    detalle: "/api/manhwa/:id",
    paginas: "/api/manhwa/:id/chapter/:chapter"
  }
}));

app.use((req, res) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});

cron.schedule("*/20 * * * *", () => {
  runScraper();
});

setTimeout(() => runScraper(), 5000);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`KōmiVerso API escuchando en http://0.0.0.0:${PORT}`);
  console.log("Fuente del catálogo: ManhwaWeb");
});


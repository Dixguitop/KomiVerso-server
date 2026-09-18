import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTitle } from "../utils/manhwaId.js";
import { upsertManhwaBatch, catalogCount } from "../catalog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE =
  process.env.MANHWAS_FILE ||
  path.resolve(__dirname, "../../data/manhwas.json");

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("Falta DATABASE_URL en el entorno.");
    process.exit(1);
  }
  if (!fs.existsSync(FILE)) {
    console.error("No existe el archivo:", FILE);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const list = Array.isArray(raw) ? raw : [];
  console.log(`📦 Leyendo ${list.length} obras desde ${FILE}`);
  console.log(`📊 En DB ahora: ${await catalogCount()} obras`);

  const items = list
    .filter((m) => m?.id)
    .map((m) => ({
      id: String(m.id),
      remoteId: String(m.remoteId || m.id),
      nombre: m.nombre || "",
      nameKey: normalizeTitle(m.nombre),
      imagen: m.imagen || null,
      capitulo: m.capitulo ?? 0,
      sinopsis: m.sinopsis || null,
      tipo: m.tipo || null,
      demografia: m.demografia || null,
      plataforma: m.plataforma || null,
      erotico: m.erotico || null,
      estado: m.estado || null,
      autor: m.autor || null,
      artista: m.artista || null,
      anio: m.anio ?? null,
      popularidad: m.popularidad ?? 0,
      hiatus: !!m.hiatus,
      categorias: m.categorias ?? [],
      autores: m.autores ?? [],
      capitulos: Array.isArray(m.capitulos) ? m.capitulos : [],
    }));

  const CHUNK = 50;
  for (let i = 0; i < items.length; i += CHUNK) {
    await upsertManhwaBatch(items.slice(i, i + CHUNK));
    console.log(`  … ${Math.min(i + CHUNK, items.length)} / ${items.length}`);
  }

  console.log(`✅ Listo. Obras en DB: ${await catalogCount()}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


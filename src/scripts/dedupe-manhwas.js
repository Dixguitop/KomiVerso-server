import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTitle } from "../utils/manhwaId.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FILE =
  process.env.MANHWAS_FILE ||
  path.resolve(__dirname, "../../data/manhwas.json");

const DRY_RUN = process.argv.includes("--dry-run");

function getChapterNumber(value) {
  const n = Number.parseFloat(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function mergeChapters(canonical, others) {
  const byChapter = new Map();

  for (const c of Array.isArray(canonical.capitulos) ? canonical.capitulos : []) {
    byChapter.set(String(c.chapter), c);
  }

  for (const other of others) {
    for (const c of Array.isArray(other.capitulos) ? other.capitulos : []) {
      const key = String(c.chapter);
      if (!byChapter.has(key)) byChapter.set(key, c);
    }
  }

  return Array.from(byChapter.values())
    .sort((a, b) => getChapterNumber(b.chapter) - getChapterNumber(a.chapter));
}

function pickCanonical(group) {
  return [...group].sort((a, b) => {
    const chA = Array.isArray(a.capitulos) ? a.capitulos.length : 0;
    const chB = Array.isArray(b.capitulos) ? b.capitulos.length : 0;
    if (chB !== chA) return chB - chA;

    const capA = getChapterNumber(a.capitulo);
    const capB = getChapterNumber(b.capitulo);
    if (capB !== capA) return capB - capA;

    const popA = Number(a.popularidad) || 0;
    const popB = Number(b.popularidad) || 0;
    return popB - popA;
  })[0];
}

function main() {
  const raw = fs.readFileSync(FILE, "utf8");
  const data = JSON.parse(raw);

  const groups = new Map();
  for (const manga of data) {
    const key = normalizeTitle(manga?.nombre);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(manga);
  }

  const toRemoveIds = new Set();
  const report = [];
  const finalById = new Map();

  for (const [key, group] of groups) {
    if (group.length < 2) continue;

    const canonical = pickCanonical(group);
    const others = group.filter(m => m !== canonical);

    const mergedChapters = mergeChapters(canonical, others);
    if (mergedChapters.length > (canonical.capitulos?.length || 0)) {
      canonical.capitulos = mergedChapters;
      canonical.capitulo = getChapterNumber(mergedChapters[0]?.chapter ?? canonical.capitulo);
    }

    for (const other of others) {
      toRemoveIds.add(other.id);
      report.push({
        nombre: canonical.nombre,
        removedId: other.id,
        keptId: canonical.id,
        removedChapters: other.capitulos?.length || 0,
        keptChaptersAfterMerge: canonical.capitulos?.length || 0
      });
    }
  }

  const cleaned = data.filter(m => !toRemoveIds.has(m.id));

  console.log(`📚 Total obras antes: ${data.length}`);
  console.log(`🔁 Grupos con duplicados: ${report.length > 0 ? new Set(report.map(r => r.keptId)).size : 0}`);
  console.log(`🗑️  Obras a eliminar: ${toRemoveIds.size}`);
  console.log(`📚 Total obras después: ${cleaned.length}`);

  const reportPath = FILE.replace(/\.json$/, ".dedupe-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`📝 Reporte escrito en: ${reportPath}`);
  console.log(`   Antes de aplicar (sin --dry-run), corre: node src/scripts/migrate-duplicates.js`);
  console.log(`   (reasigna en la base de datos las listas/comentarios de usuarios que tenían una de las copias duplicadas — usa Prisma, no hace falta SQL)`);

  if (DRY_RUN) {
    console.log("\n👀 --dry-run: no se modificó manhwas.json.");
    return;
  }

  const backupPath = FILE.replace(/\.json$/, `.backup-before-dedupe-${Date.now()}.json`);
  fs.writeFileSync(backupPath, raw, "utf8");
  console.log(`💾 Backup original guardado en: ${backupPath}`);

  fs.writeFileSync(FILE, JSON.stringify(cleaned, null, 2), "utf8");
  console.log(`✅ manhwas.json actualizado.`);
}

main();

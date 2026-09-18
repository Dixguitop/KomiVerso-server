import prisma from "../db.js";

const DRY_RUN = process.argv.includes("--dry-run");

function fixChapters(mangaId, chapters) {
  if (!Array.isArray(chapters)) return { fixed: [], changed: false };
  let changed = false;
  const fixed = chapters.map((ch) => {
    const correctId = `${mangaId}-${ch.chapter}`;
    if (ch.id !== correctId) changed = true;
    return { ...ch, id: correctId };
  });
  return { fixed, changed };
}

async function main() {
  const rows = await prisma.manhwa.findMany({
    select: { id: true, nombre: true, capitulos: true },
  });

  console.log(`📚 Obras en la base de datos: ${rows.length}`);

  const toUpdate = [];
  for (const row of rows) {
    const { fixed, changed } = fixChapters(row.id, row.capitulos);
    if (changed) {
      toUpdate.push({ id: row.id, nombre: row.nombre, capitulos: fixed, count: fixed.length });
    }
  }

  console.log(`🔧 Obras con ids de capítulo rotos: ${toUpdate.length}`);
  const totalChapters = toUpdate.reduce((sum, m) => sum + m.count, 0);
  console.log(`📄 Capítulos que se van a corregir: ${totalChapters}`);

  if (toUpdate.length === 0) {
    console.log("✅ No había nada que arreglar.");
    return;
  }

  if (DRY_RUN) {
    console.log("\n👀 --dry-run: no se modificó la base de datos. Ejemplos:");
    for (const m of toUpdate.slice(0, 5)) {
      console.log(`  - ${m.nombre} (${m.id}): ${m.count} capítulos`);
    }
    return;
  }

  let done = 0;
  const chunk = 40;
  for (let i = 0; i < toUpdate.length; i += chunk) {
    const slice = toUpdate.slice(i, i + chunk);
    await Promise.all(
      slice.map((m) =>
        prisma.manhwa.update({
          where: { id: m.id },
          data: { capitulos: m.capitulos },
        })
      )
    );
    done += slice.length;
    console.log(`  ...${done}/${toUpdate.length} obras actualizadas`);
  }

  console.log(`✅ Listo. ${toUpdate.length} obras corregidas, ${totalChapters} capítulos con id reparado.`);
  console.log(
    "\nNota: si algún usuario ya tiene 'CapituloLeido' o 'Comentario' guardados con el chapterId roto de antes," +
    " esos registros van a quedar apuntando a un id que ya no existe (huérfanos), pero no rompen nada:" +
    " simplemente no se van a marcar como leídos / no se van a mostrar como comentario de ese capítulo específico."
  );
}

main()
  .catch((err) => {
    console.error("❌ Error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });


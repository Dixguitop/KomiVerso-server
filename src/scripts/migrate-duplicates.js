import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import prisma from "../../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPORT_FILE =
  process.env.DEDUPE_REPORT_FILE ||
  path.resolve(__dirname, "../../data/manhwas.dedupe-report.json");

async function main() {
  if (!fs.existsSync(REPORT_FILE)) {
    console.error(
      `❌ No encontré ${REPORT_FILE}.\n` +
      `   Corre primero: node src/scripts/dedupe-manhwas.js --dry-run`
    );
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(REPORT_FILE, "utf8"));
  console.log(`📋 ${report.length} obra(s) duplicada(s) a reasignar en la base de datos.\n`);

  let listasMovidas = 0;
  let listasBorradas = 0;
  let comentariosMovidos = 0;

  for (const { nombre, removedId, keptId } of report) {

    const listasDuplicadas = await prisma.listaManga.findMany({
      where: { mangaId: removedId }
    });

    for (const lista of listasDuplicadas) {
      const yaExiste = await prisma.listaManga.findUnique({
        where: {
          usuarioId_mangaId: {
            usuarioId: lista.usuarioId,
            mangaId: keptId
          }
        }
      });

      if (yaExiste) {
        await prisma.listaManga.delete({ where: { id: lista.id } });
        listasBorradas++;
      } else {
        await prisma.listaManga.update({
          where: { id: lista.id },
          data: { mangaId: keptId }
        });
        listasMovidas++;
      }
    }

    const resultComentarios = await prisma.comentario.updateMany({
      where: { mangaId: removedId },
      data: { mangaId: keptId }
    });
    comentariosMovidos += resultComentarios.count;

    if (listasDuplicadas.length > 0 || resultComentarios.count > 0) {
      console.log(
        `✅ "${nombre}": ${listasDuplicadas.length} lista(s), ${resultComentarios.count} comentario(s)`
      );
    }
  }

  console.log(`\n🎉 Listo.`);
  console.log(`   Listas reasignadas: ${listasMovidas}`);
  console.log(`   Listas duplicadas eliminadas (ya existía en la obra canónica): ${listasBorradas}`);
  console.log(`   Comentarios reasignados: ${comentariosMovidos}`);
  console.log(`\nAhora sí puedes correr: node src/scripts/dedupe-manhwas.js`);
}

main()
  .catch(err => {
    console.error("❌ Error:", err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

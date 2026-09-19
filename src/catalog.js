import prisma from "../db.js";

// ─────────────────────────────────────────────────────────────
// Cómo se lee la tabla Manhwa (importante para el egress de Neon)
//
// El 90 %+ del peso de cada fila es la columna JSON `capitulos`.
// Por eso NUNCA se hace un findMany() completo:
//
//   • loadCatalogLight()  -> scrapers. Solo columnas de comparación
//                            + hasSinopsis / chapterCount calculados en SQL.
//   • loadCatalogList()   -> listado público. Todo menos `capitulos`
//                            y `sinopsis`, con caché de 10 min.
//   • findManhwaById()    -> una sola fila completa (detalle, capítulo,
//                            y obras que el scraper realmente va a actualizar).
// ─────────────────────────────────────────────────────────────

const LIST_TTL_MS = 10 * 60_000;
let _listCache = { data: null, at: 0 };
let _listInflight = null;

export function invalidateCatalogCache() {
  _listCache = { data: null, at: 0 };
}

export function rowToItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    remoteId: row.remoteId || row.id,
    nombre: row.nombre || "",
    nameKey: row.nameKey || null,
    imagen: row.imagen || null,
    capitulo: row.capitulo ?? 0,
    sinopsis: row.sinopsis || null,
    tipo: row.tipo || null,
    demografia: row.demografia || null,
    plataforma: row.plataforma || null,
    erotico: row.erotico || null,
    estado: row.estado || null,
    autor: row.autor || null,
    artista: row.artista || null,
    anio: row.anio ?? null,
    popularidad: row.popularidad ?? 0,
    hiatus: !!row.hiatus,
    categorias: row.categorias ?? [],
    autores: row.autores ?? [],
    capitulos: Array.isArray(row.capitulos) ? row.capitulos : [],
    actualizado: row.updatedAt ? new Date(row.updatedAt).getTime() : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).getTime() : null,
  };
}

export function itemToData(item) {
  return {
    remoteId: item.remoteId ? String(item.remoteId) : String(item.id),
    nombre: String(item.nombre || ""),
    nameKey: item.nameKey || null,
    imagen: item.imagen || null,
    capitulo: Number(item.capitulo) || 0,
    sinopsis: item.sinopsis || null,
    tipo: item.tipo || null,
    demografia: item.demografia || null,
    plataforma: item.plataforma || null,
    erotico: item.erotico || null,
    estado: item.estado || null,
    autor: item.autor || null,
    artista: item.artista || null,
    anio: item.anio != null ? Number(item.anio) : null,
    popularidad: Number(item.popularidad) || 0,
    hiatus: !!item.hiatus,
    categorias: item.categorias ?? [],
    autores: item.autores ?? [],
    capitulos: Array.isArray(item.capitulos) ? item.capitulos : [],
  };
}

/**
 * Versión liviana para los scrapers. Devuelve solo lo necesario para
 * comparar contra el sitio remoto:
 *   { id, remoteId, nombre, nameKey, plataforma, capitulo, hasSinopsis, chapterCount }
 *
 * ⚠️ Estos objetos NO tienen el contenido completo. Nunca los pases a
 * upsertManhwa/upsertManhwaBatch: pisarían capitulos/categorias con vacío.
 * Para actualizar una obra existente, cárgala completa con findManhwaById().
 */
export async function loadCatalogLight() {
  const rows = await prisma.$queryRaw`
    SELECT
      id,
      "remoteId",
      nombre,
      "nameKey",
      plataforma,
      capitulo,
      (sinopsis IS NOT NULL AND sinopsis <> '') AS "hasSinopsis",
      CASE
        WHEN jsonb_typeof(capitulos) = 'array' THEN jsonb_array_length(capitulos)
        ELSE 0
      END AS "chapterCount"
    FROM "Manhwa"
  `;
  return rows.map((r) => ({
    id: r.id,
    remoteId: r.remoteId || r.id,
    nombre: r.nombre || "",
    nameKey: r.nameKey || null,
    plataforma: r.plataforma || null,
    capitulo: r.capitulo ?? 0,
    hasSinopsis: !!r.hasSinopsis,
    chapterCount: Number(r.chapterCount) || 0,
  }));
}

const LIST_SELECT = {
  id: true,
  remoteId: true,
  nombre: true,
  nameKey: true,
  imagen: true,
  capitulo: true,
  tipo: true,
  demografia: true,
  plataforma: true,
  erotico: true,
  estado: true,
  autor: true,
  artista: true,
  anio: true,
  popularidad: true,
  hiatus: true,
  categorias: true,
  autores: true,
  updatedAt: true,
};

/**
 * Catálogo para el listado público: sin `capitulos` ni `sinopsis`
 * (el detalle los trae por id). Caché de 10 min; si la DB falla
 * y hay caché viejo, se sigue sirviendo el viejo.
 */
export async function loadCatalogList(force = false) {
  const now = Date.now();
  if (!force && _listCache.data && now - _listCache.at < LIST_TTL_MS) {
    return _listCache.data;
  }

  if (_listInflight) return _listInflight;

  _listInflight = prisma.manhwa
    .findMany({ select: LIST_SELECT })
    .then((rows) => {
      const data = rows.map(rowToItem);
      _listCache = { data, at: Date.now() };
      return data;
    })
    .catch((err) => {
      if (_listCache.data) {
        console.error("[catalog] DB falló, sirviendo caché anterior:", err.message);
        return _listCache.data;
      }
      throw err;
    })
    .finally(() => {
      _listInflight = null;
    });

  return _listInflight;
}

export async function upsertManhwa(item) {
  const data = itemToData(item);
  await prisma.manhwa.upsert({
    where: { id: String(item.id) },
    create: { id: String(item.id), ...data },
    update: data,
  });
}

// No invalida la caché del listado a propósito: el scraper corre cada
// 20 min y una invalidación por lote forzaría una relectura del catálogo
// en cada ciclo. El listado se refresca solo por TTL.
export async function upsertManhwaBatch(items) {
  if (!items.length) return;
  const chunk = 40;
  for (let i = 0; i < items.length; i += chunk) {
    const slice = items.slice(i, i + chunk);
    await Promise.all(
      slice.map((item) => {
        const data = itemToData(item);
        return prisma.manhwa.upsert({
          where: { id: String(item.id) },
          create: { id: String(item.id), ...data },
          update: data,
        });
      })
    );
  }
}

/**
 * Re-vincula obras existentes (cambió su remoteId en el sitio remoto)
 * tocando solo remoteId/nameKey, sin reescribir el resto de la fila.
 * items: [{ id, remoteId, nameKey }]
 */
export async function relinkManhwaBatch(items) {
  if (!items.length) return;
  const chunk = 40;
  for (let i = 0; i < items.length; i += chunk) {
    const slice = items.slice(i, i + chunk);
    await Promise.all(
      slice.map(async (item) => {
        try {
          await prisma.manhwa.update({
            where: { id: String(item.id) },
            data: {
              remoteId: String(item.remoteId),
              ...(item.nameKey ? { nameKey: item.nameKey } : {}),
            },
          });
        } catch (err) {
          console.warn(`[catalog] no se pudo re-vincular ${item.id}: ${err.message}`);
        }
      })
    );
  }
}

export async function findManhwaById(id) {
  const row = await prisma.manhwa.findUnique({ where: { id: String(id) } });
  return rowToItem(row);
}

export async function catalogCount() {
  return prisma.manhwa.count();
}


import prisma from "../db.js";

const CACHE_TTL_MS = 30_000;
let _cache = { data: null, at: 0 };
let _inflight = null;

export function invalidateCatalogCache() {
  _cache = { data: null, at: 0 };
}

export function rowToItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    remoteId: row.remoteId || row.id,
    nombre: row.nombre || "",
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

export async function loadCatalog(force = false) {
  const now = Date.now();
  if (!force && _cache.data && now - _cache.at < CACHE_TTL_MS) {
    return _cache.data;
  }

  if (_inflight) {
    return _inflight;
  }

  _inflight = prisma.manhwa
    .findMany()
    .then((rows) => {
      const data = rows.map(rowToItem);
      _cache = { data, at: Date.now() };
      return data;
    })
    .finally(() => {
      _inflight = null;
    });

  return _inflight;
}

export async function upsertManhwa(item) {
  const data = itemToData(item);
  await prisma.manhwa.upsert({
    where: { id: String(item.id) },
    create: { id: String(item.id), ...data },
    update: data,
  });
  invalidateCatalogCache();
}

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
  invalidateCatalogCache();
}

export async function findManhwaById(id) {
  const row = await prisma.manhwa.findUnique({ where: { id: String(id) } });
  return rowToItem(row);
}

export async function catalogCount() {
  return prisma.manhwa.count();
}

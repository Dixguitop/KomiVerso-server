import { normalizeTitle } from "../utils/manhwaId.js";
import {
  loadCatalog,
  upsertManhwaBatch,
} from "../catalog.js";
import { runOlympusScraper } from "./olympus.js";

const API = "https://manhwawebbackend-production.up.railway.app";

const CONCURRENCY = 3;
const DELAY = 300;
const RETRIES = 3;
const SAVE_EVERY = 25;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url, attempt = 1) {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "KomiVerso/1.0",
        Accept: "application/json, text/plain, */*",
        Referer: "https://manhwaweb.com/",
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (attempt < RETRIES) {
      await sleep(1000 * attempt);
      return getJson(url, attempt + 1);
    }
    throw error;
  }
}

function getChapterNumber(value) {
  const number = Number.parseFloat(String(value ?? "").replace(",", "."));
  return Number.isFinite(number) ? number : 0;
}

function normalizeChapters(mangaId, chapters) {
  if (!Array.isArray(chapters)) return [];
  return chapters
    .map((chapter) => ({
      id: `${mangaId}-${chapter.chapter}`,
      chapter: chapter.chapter ?? null,
      link: chapter.link ?? null,
    }))
    .filter((chapter) => chapter.chapter !== null)
    .sort((a, b) => getChapterNumber(b.chapter) - getChapterNumber(a.chapter));
}

function updateManga(manga, detail) {
  let changed = false;
  if (detail?._sinopsis && manga.sinopsis !== detail._sinopsis) {
    manga.sinopsis = detail._sinopsis;
    changed = true;
  }
  if (detail?.name_esp && manga.nombre !== detail.name_esp) {
    manga.nombre = detail.name_esp;
    manga.nameKey = normalizeTitle(detail.name_esp);
    changed = true;
  }
  if (detail?._imagen && manga.imagen !== detail._imagen) {
    manga.imagen = detail._imagen;
    changed = true;
  }
  if (detail?._status && manga.estado !== detail._status) {
    manga.estado = detail._status;
    changed = true;
  }
  if (detail?._numero_cap !== undefined && manga.capitulo !== detail._numero_cap) {
    manga.capitulo = detail._numero_cap;
    changed = true;
  }
  if (detail?._tipo && manga.tipo !== detail._tipo) {
    manga.tipo = detail._tipo;
    changed = true;
  }
  if (detail?._demografi && manga.demografia !== detail._demografi) {
    manga.demografia = detail._demografi;
    changed = true;
  }
  if (detail?._plataforma && manga.plataforma !== detail._plataforma) {
    manga.plataforma = detail._plataforma;
    changed = true;
  }
  if (detail?._erotico && manga.erotico !== detail._erotico) {
    manga.erotico = detail._erotico;
    changed = true;
  }
  if (Array.isArray(detail?._categoris)) {
    const categories = detail._categoris;
    if (JSON.stringify(manga.categorias) !== JSON.stringify(categories)) {
      manga.categorias = categories;
      changed = true;
    }
  }
  if (Array.isArray(detail?._extras?.autores)) {
    const autores = detail._extras.autores.map((x) => String(x).trim()).filter(Boolean);
    if (JSON.stringify(manga.autores) !== JSON.stringify(autores)) {
      manga.autores = autores;
      changed = true;
    }
    if (autores[0] && manga.autor !== autores[0]) {
      manga.autor = autores[0];
      changed = true;
    }
  }
  if (detail?.popularidad !== undefined && manga.popularidad !== detail.popularidad) {
    manga.popularidad = detail.popularidad;
    changed = true;
  }
  if (Array.isArray(detail?.chapters)) {
    const chapters = normalizeChapters(manga.id, detail.chapters);
    if (chapters.length > 0) {
      const oldChapters = Array.isArray(manga.capitulos) ? manga.capitulos : [];
      if (JSON.stringify(oldChapters) !== JSON.stringify(chapters)) {
        manga.capitulos = chapters;
        changed = true;
      }
    }
  }
  return changed;
}

let running = false;
const dirty = new Set();

async function flushDirty(dataById) {
  if (dirty.size === 0) return;
  const items = [...dirty].map((id) => dataById.get(id)).filter(Boolean);
  dirty.clear();
  if (items.length) await upsertManhwaBatch(items);
}

export async function runManhwaWebScraper() {
  if (running) {
    console.log("[scraper] Ya esta corriendo, se omite esta ejecucion.");
    return;
  }
  running = true;

  try {
    console.log("[scraper] KomiVerso - Scraper incremental -> Postgres");

    const data = await loadCatalog(true);
    const dataById = new Map(data.map((m) => [String(m.id), m]));

    const catalog = [];
    let page = 0;

    while (true) {
      try {
        const url = API + "/manhwa/library?page=" + page;
        const result = await getJson(url);
        const items = Array.isArray(result)
          ? result
          : Array.isArray(result?.data)
            ? result.data
            : Array.isArray(result?.manhwas)
              ? result.manhwas
              : [];
        if (items.length === 0) break;
        catalog.push(...items);
        if (!result?.next) break;
        page++;
        await sleep(DELAY);
      } catch (error) {
        console.error(`[scraper] Error obteniendo pagina ${page}: ${error.message}`);
        console.error("[scraper] Se detiene: catalogo incompleto, no se modifica la base.");
        return;
      }
    }

    const existingByRemoteId = new Map();
    const existingByName = new Map();
    for (const manga of data) {
      if (!manga?.id) continue;
      if (!manga.remoteId) manga.remoteId = manga.id;
      if (!manga.nameKey) manga.nameKey = normalizeTitle(manga.nombre);
      existingByRemoteId.set(String(manga.remoteId), manga);
      const nameKey = manga.nameKey || normalizeTitle(manga.nombre);
      if (nameKey && !existingByName.has(nameKey)) existingByName.set(nameKey, manga);
    }

    const jobs = [];
    let newCount = 0;
    let relinkedCount = 0;
    let reviewCount = 0;

for (const remote of catalog) {
      const remoteId = String(
        remote.real_id || remote._id || remote.id || ""
      ).trim();
      if (!remoteId) continue;

      const remoteName =
        remote.name_esp ||
        remote.the_real_name ||
        remote.nombre ||
        remote.name ||
        "";
      const nameKey = normalizeTitle(remoteName);
      const remoteCap = remote._numero_cap ?? remote.capitulo ?? 0;

      let local = existingByRemoteId.get(remoteId);

      if (!local && nameKey) {
        local = existingByName.get(nameKey);
        if (local) {
          console.log(
            "[scraper] Re-vinculando \"" + local.nombre + "\": remoteId " + local.remoteId + " -> " + remoteId
          );
          existingByRemoteId.delete(String(local.remoteId));
          local.remoteId = remoteId;
          existingByRemoteId.set(remoteId, local);
          dirty.add(String(local.id));
          relinkedCount++;
        }
      }

      if (!local) {
        const manga = {
          id: remoteId,
          remoteId: remoteId,
          nombre: remoteName,
          nameKey,
          imagen: remote._imagen || remote.imagen || remote.img || null,
          capitulo: remoteCap,
          sinopsis: remote.sinopsis || remote._sinopsis || null,
          tipo: remote._tipo || remote.tipo || null,
          demografia: remote._demografi || remote.demografia || null,
          plataforma: remote._plataforma || remote.plataforma || null,
          erotico: remote._erotico || remote.erotico || null,
          estado: remote._status || remote.estado || null,
          categorias: remote._categoris || remote.categorias || [],
          autores: [],
          capitulos: [],
          popularidad: remote.popularidad ?? 0,
        };
        data.push(manga);
        dataById.set(String(manga.id), manga);
        existingByRemoteId.set(remoteId, manga);
        if (nameKey) existingByName.set(nameKey, manga);
        dirty.add(String(manga.id));
        jobs.push({ manga, type: "NEW" });
        newCount++;
        continue;
      }

      const remoteChapter = getChapterNumber(remoteCap);
      const localChapter = getChapterNumber(local.capitulo);
      const missingChapters = !Array.isArray(local.capitulos) || local.capitulos.length === 0;

      if (remoteChapter > localChapter || missingChapters) {
        if (!jobs.some((job) => job.manga === local)) {
          jobs.push({ manga: local, type: "UPDATE" });
          reviewCount++;
        }
      }
}

    console.log(
      `[scraper] Obras nuevas: ${newCount} | Re-vinculadas: ${relinkedCount} | Por revisar: ${reviewCount}`
    );

    if (jobs.length === 0) {
      await flushDirty(dataById);
      console.log("[scraper] Todo estaba actualizado.");
      return;
    }

    let cursor = 0;
    let completed = 0;
    let failed = 0;
    let changes = 0;

    async function worker() {
      while (true) {
        const index = cursor++;
        if (index >= jobs.length) return;
        const job = jobs[index];
        const manga = job.manga;
        try {
          const lookupId = manga.remoteId || manga.id;
          const detail = await getJson(
            API + "/manhwa/see/" + encodeURIComponent(lookupId)
          );
          if (updateManga(manga, detail)) {
            changes++;
            dirty.add(String(manga.id));
          } else if (job.type === "NEW") {
            dirty.add(String(manga.id));
          }
          completed++;
        } catch {
          failed++;
          if (job.type === "NEW") dirty.add(String(manga.id));
        }
        if ((completed + failed) % SAVE_EVERY === 0) {
          await flushDirty(dataById);
        }
        await sleep(DELAY);
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    await flushDirty(dataById);

    console.log(
      `[scraper] Terminado - nuevas: ${newCount}, actualizadas: ${changes}, fallidas: ${failed}`
    );
  } catch (err) {
    console.error("[scraper] Error general:", err.message);
  } finally {
    running = false;
  }
}


export async function runScraper() {
  await runManhwaWebScraper();
  try {
    await runOlympusScraper();
  } catch (err) {
    console.error("[scraper] Olympus falló (ManhwaWeb ya terminó):", err?.message || err);
  }
}

export { runOlympusScraper };

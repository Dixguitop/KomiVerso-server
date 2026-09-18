import { normalizeTitle } from "../utils/manhwaId.js";
import { loadCatalog, upsertManhwaBatch } from "../catalog.js";

const FRONT = "https://olympusxyz.com";
const PANEL = "https://panel.olympusxyz.com";

const CONCURRENCY = 2;
const DELAY = 400;
const RETRIES = 3;
const SAVE_EVERY = 20;
const MAX_CHAPTER_PAGES = 40;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, attempt = 1) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "KomiVerso/1.0",
        Accept: "application/json",
        Referer: `${FRONT}/`,
        Origin: FRONT,
      },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (attempt < RETRIES) {
      await sleep(800 * attempt);
      return getJson(url, attempt + 1);
    }
    throw err;
  }
}

function getChapterNumber(value) {
  const n = Number.parseFloat(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function statusName(status) {
  if (!status) return "ongoing";
  const id = typeof status === "object" ? status.id : status;
  const name = typeof status === "object" ? status.name : String(status);
  if (id === 1 || /activ/i.test(name)) return "ongoing";
  if (id === 3 || /hiatus|pausa/i.test(name)) return "hiatus";
  if (id === 4 || /final|complet/i.test(name)) return "completed";
  if (id === 5 || /cancel/i.test(name)) return "cancelled";
  return "ongoing";
}

async function fetchAllSeries() {
  const all = [];
  let page = 1;
  let last = 1;
  while (page <= last) {
    const data = await getJson(`${FRONT}/api/series?page=${page}`);
    const series = data?.data?.series;
    const items = Array.isArray(series?.data) ? series.data : [];
    last = Number(series?.last_page) || page;
    for (const item of items) {
      if (!item?.id) continue;
      if (item.type && item.type !== "comic") continue;
      all.push(item);
    }
    if (items.length === 0) break;
    page += 1;
    await sleep(DELAY);
  }
  return all;
}

async function fetchChapters(slug) {
  const chapters = [];
  let page = 1;
  while (page <= MAX_CHAPTER_PAGES) {
    const url =
      `${PANEL}/api/series/${encodeURIComponent(slug)}/chapters` +
      `?page=${page}&direction=desc&type=comic`;
    const data = await getJson(url);
    const list = Array.isArray(data?.data) ? data.data : [];
    if (list.length === 0) break;
    for (const ch of list) {
      if (ch?.id == null || ch?.name == null) continue;
      chapters.push({
        id: null,
        chapter: String(ch.name),
        link: String(ch.id),
        publishAt: ch.published_at || null,
      });
    }
    const lastPage =
      data?.meta?.last_page ??
      data?.last_page ??
      (list.length < 20 ? page : page + 1);
    if (page >= lastPage) break;
    page += 1;
    await sleep(DELAY / 2);
  }
  return chapters.sort(
    (a, b) => getChapterNumber(b.chapter) - getChapterNumber(a.chapter)
  );
}

async function fetchDetail(slug) {
  return getJson(
    `${FRONT}/api/series/${encodeURIComponent(slug)}?type=comic`
  );
}

function buildOlympusId(numericId) {
  return `olympus-${numericId}`;
}

let running = false;

export async function runOlympusScraper() {
  if (running) {
    console.log("[olympus] Ya hay un scrape en curso, se omite.");
    return;
  }
  running = true;
  try {
    console.log("[olympus] Inicio scraper Olympus -> Postgres");

    const catalog = await loadCatalog(true);
    const byName = new Map();
    const byOlympusId = new Map();

    for (const m of catalog) {
      const nk = m.nameKey || normalizeTitle(m.nombre);
      if (nk && !byName.has(nk)) byName.set(nk, m);
      if (String(m.id || "").startsWith("olympus-")) {
        byOlympusId.set(String(m.id), m);
      }
      if (m.plataforma === "olympus" && m.remoteId) {
        const num = String(m.remoteId).split("|")[0];
        byOlympusId.set(`olympus-${num}`, m);
      }
    }

    let remoteList = [];
    try {
      remoteList = await fetchAllSeries();
    } catch (err) {
      console.error("[olympus] No se pudo listar series:", err.message);
      return;
    }
    console.log(`[olympus] Series remotas: ${remoteList.length}`);

    const dirty = [];
    let skippedDup = 0;
    let newCount = 0;
    let updated = 0;
    let failed = 0;

    const jobs = [];

    for (const remote of remoteList) {
      const numericId = String(remote.id);
      const oid = buildOlympusId(numericId);
      const name = remote.name || "";
      const nameKey = normalizeTitle(name);
      const slug = remote.slug || "";

      let local = byOlympusId.get(oid);

      if (!local && nameKey && byName.has(nameKey)) {
        const existing = byName.get(nameKey);
        if (String(existing.id).startsWith("olympus-") || existing.plataforma === "olympus") {
          local = existing;
        } else {
          skippedDup++;
          continue;
        }
      }

      if (!local) {
        local = {
          id: oid,
          remoteId: `${numericId}|${slug}`,
          nombre: name,
          nameKey,
          imagen: remote.cover || null,
          capitulo: remote.chapter_count || 0,
          sinopsis: null,
          tipo: "manhwa",
          demografia: null,
          plataforma: "olympus",
          erotico: null,
          estado: statusName(remote.status),
          autor: null,
          artista: null,
          anio: null,
          popularidad: Number(remote.total_views || remote.monthly_views || 0) || 0,
          hiatus: false,
          categorias: [],
          autores: [],
          capitulos: [],
        };
        jobs.push({ manga: local, type: "NEW", slug });
        newCount++;
        byName.set(nameKey, local);
        byOlympusId.set(oid, local);
      } else {
        local.remoteId = `${numericId}|${slug}`;
        local.plataforma = "olympus";
        if (name) {
          local.nombre = name;
          local.nameKey = nameKey;
        }
        if (remote.cover) local.imagen = remote.cover;
        const remoteCap = Number(remote.chapter_count) || 0;
        const localCap = Array.isArray(local.capitulos) ? local.capitulos.length : 0;
        const needsUpdate =
          remoteCap > localCap ||
          !local.sinopsis ||
          !Array.isArray(local.capitulos) ||
          local.capitulos.length === 0;
        if (needsUpdate) {
          jobs.push({ manga: local, type: "UPDATE", slug });
        }
      }
    }

    console.log(
      `[olympus] Nuevas: ${newCount} | A actualizar: ${jobs.filter((j) => j.type === "UPDATE").length} | Duplicados omitidos: ${skippedDup}`
    );

    let cursor = 0;

    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= jobs.length) return;
        const job = jobs[i];
        const manga = job.manga;
        const slug = job.slug || String(manga.remoteId || "").split("|")[1] || "";
        try {
          if (slug) {
            try {
              const detailWrap = await fetchDetail(slug);
              const d = detailWrap?.data || detailWrap;
              if (d?.summary) manga.sinopsis = d.summary;
              if (d?.cover) manga.imagen = d.cover;
              if (d?.status) manga.estado = statusName(d.status);
              if (Array.isArray(d?.genres)) {
                manga.categorias = d.genres.map((g) =>
                  typeof g === "string" ? g : g?.name
                ).filter(Boolean);
              }
              if (d?.slug) {
                const num = String(manga.id).replace(/^olympus-/, "");
                manga.remoteId = `${num}|${d.slug}`;
              }
            } catch (e) {
              console.warn(`[olympus] detail ${slug}: ${e.message}`);
            }
          }

          if (slug) {
            const chapters = await fetchChapters(slug);
            const mangaId = manga.id;
            manga.capitulos = chapters.map((c) => ({
              id: `${mangaId}-${c.chapter}`,
              chapter: c.chapter,
              link: c.link,
              title: "",
              lang: "es",
              pages: 0,
              publishAt: c.publishAt,
              group: "Olympus",
            }));
            if (manga.capitulos.length) {
              manga.capitulo = getChapterNumber(manga.capitulos[0].chapter);
            }
          }

          dirty.push(manga);
          if (job.type === "NEW") {
          } else updated++;

          if (dirty.length >= SAVE_EVERY) {
            const batch = dirty.splice(0, dirty.length);
            await upsertManhwaBatch(batch);
          }
        } catch (err) {
          failed++;
          console.warn(`[olympus] falló ${manga.id}: ${err.message}`);
          if (job.type === "NEW") dirty.push(manga);
        }
        await sleep(DELAY);
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    if (dirty.length) await upsertManhwaBatch(dirty);

    console.log(
      `[olympus] Terminado — nuevas: ${newCount}, actualizadas: ${updated}, fallidas: ${failed}, omitidas(dup): ${skippedDup}`
    );
  } catch (err) {
    console.error("[olympus] Error general:", err.message);
  } finally {
    running = false;
  }
}

export async function fetchOlympusPages(slug, chapterOlympusId) {
  const url = `${FRONT}/api/capitulo/comic-${encodeURIComponent(slug)}/${encodeURIComponent(chapterOlympusId)}`;
  const data = await getJson(url);
  const pages = data?.chapter?.pages;
  return Array.isArray(pages) ? pages : [];
}

export function parseOlympusRemote(remoteId) {
  const s = String(remoteId || "");
  const i = s.indexOf("|");
  if (i <= 0) return { id: s, slug: "" };
  return { id: s.slice(0, i), slug: s.slice(i + 1) };
}

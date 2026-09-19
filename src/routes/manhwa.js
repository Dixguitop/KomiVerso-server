import express from "express";
import { loadCatalogList, findManhwaById } from "../catalog.js";
import { fetchOlympusPages, parseOlympusRemote } from "../scraper/olympus.js";
import { loadNovelChapter } from "../utils/novel.js";

const router = express.Router();

const API =
  "https://manhwawebbackend-production.up.railway.app";

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function upstreamJson(url, attempt = 1) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "KomiVerso/1.0",
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://manhwaweb.com/"
      },
      signal: AbortSignal.timeout(20000)
    });

    if (!res.ok) {
      const httpErr = new Error(`HTTP ${res.status}`);
      httpErr.status = res.status;
      throw httpErr;
    }

    return await res.json();

  } catch (err) {

    const noRetry =
      err.status >= 400 &&
      err.status < 500 &&
      err.status !== 429;

    if (!noRetry && attempt < 3) {
      await sleep(500 * attempt);
      return upstreamJson(url, attempt + 1);
    }

    throw err;
  }
}

// Listado: catálogo sin capitulos/sinopsis, con caché (ver catalog.js).
async function readCatalog() {
  try {
    return await loadCatalogList();
  } catch (err) {
    console.error("readCatalog DB:", err.message);
    return [];
  }
}

// Detalle / capítulo: una sola fila por id, nunca el catálogo entero.
async function readOne(id) {
  try {
    return await findManhwaById(id);
  } catch (err) {
    console.error("readOne DB:", err.message);
    return null;
  }
}

function listParam(value) {
  if (value == null || value === "") {
    return [];
  }

  return (
    Array.isArray(value)
      ? value
      : String(value).split(",")
  )
    .map(String)
    .map(v => v.trim())
    .filter(Boolean);
}

function normalizeStatus(value, hiatus = false) {

  if (hiatus) {
    return "hiatus";
  }

  const v = String(value || "").toLowerCase();

  if (
    ["finalizado", "completed", "finished"].includes(v)
  ) {
    return "completed";
  }

  if (
    [
      "publicandose",
      "publicándose",
      "ongoing",
      "en emisión",
      "en emision"
    ].includes(v)
  ) {
    return "ongoing";
  }

  if (
    ["cancelado", "cancelled"].includes(v)
  ) {
    return "cancelled";
  }

  if (v) {
    return v;
  }

  return "ongoing";
}

function originOf(item) {

  if (item.tipo === "manhwa") {
    return "ko";
  }

  if (item.tipo === "manhua") {
    return "zh";
  }

  return "ja";
}

function safeStr(v) {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  return null;
}

function safeNum(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function categoriesOf(item) {

  const raw =
    (Array.isArray(item.tags) && item.tags.length)
      ? item.tags
      : (Array.isArray(item.categorias) ? item.categorias : []);

  return raw
    .map(x => {
      if (typeof x === "string") return x.trim();
      if (typeof x === "object" && x) return safeStr(x.name || x.nombre);
      return safeStr(x);
    })
    .filter(Boolean);
}

function sanitizeChapters(list, mangaId) {
  if (!Array.isArray(list)) return [];
  return list.map(c => {
    const chapter = (typeof c?.chapter === "object" && c?.chapter)
      ? safeStr(c.chapter?.numero ?? c.chapter?.chapter ?? c.chapter?.value)
      : safeStr(c?.chapter) ?? c?.chapter ?? null;
    let id = safeStr(c?.id) || undefined;
    const broken = !id || id.includes("{") || /mangaId/i.test(id) || /chapter\.chapter/i.test(id);
    if (broken && mangaId != null && chapter != null) {
      id = `${mangaId}-${chapter}`;
    }
    return {
      id,
      chapter,
      title: safeStr(c?.title) || "",
      lang: safeStr(c?.lang) || "es",
      pages: safeNum(c?.pages) ?? 0,
      publishAt: safeStr(c?.publishAt) || null,
      readableAt: safeStr(c?.readableAt) || null,
      group: safeStr(c?.group) || "—",
      link: safeStr(c?.link) || null,
    };
  }).filter(c => c.chapter !== null && c.chapter !== undefined);
}

function proxiedImageUrl(url) {

  if (!url || typeof url !== "string") {
    return null;
  }

  return `/api/manhwa/image?url=${encodeURIComponent(url)}`;
}

function toManga(item) {

  const hiatus = Boolean(item.hiatus);

  return {

    id: item.id,

    title:
      String(safeStr(item.nombre) || "Sin título").trim(),

    altTitles:
      Array.isArray(item.altTitles) ? item.altTitles.map(safeStr).filter(Boolean) : [],

    synopsis:
      safeStr(item.sinopsis) || "",

    status:
      normalizeStatus(item.estado, hiatus),

    year:
      safeNum(item.anio),

    demographic:
      safeStr(item.demografia),

    origin:
      originOf(item),

    tags:
      categoriesOf(item),

    lastVolume:
      null,

    lastChapter:
      safeStr(item.capitulo) ?? item.capitulo ?? null,

    contentRating:
      item.erotico === "si"
        ? "erotica"
        : null,

    author:
      safeStr(item.autor) || "Desconocido",

    artist:
      safeStr(item.artista) ||
      safeStr(item.autor) ||
      "Desconocido",

    coverFile:
      null,

    cover:
      proxiedImageUrl(item.imagen),

    coverLarge:
      proxiedImageUrl(item.imagen),

    updatedAt:
      item.actualizado ||
      item.updatedAt ||
      null,

    tipo:
      safeStr(item.tipo),

    demografia:
      safeStr(item.demografia),

    categorias:
      categoriesOf(item),

    popularidad:
      safeNum(item.popularidad) || 0,

    hiatus,

    erotico:
      safeStr(item.erotico) || "no",

    capitulos:
      sanitizeChapters(item.capitulos, item.id)
  };
}

function numericChapter(item) {

  const n = Number.parseFloat(
    String(item.capitulo ?? "")
      .replace(",", ".")
  );

  return Number.isFinite(n)
    ? n
    : -Infinity;
}

function sortItems(items, sort) {

  const copy = [...items];

  if (
    sort === "title" ||
    sort === "name"
  ) {
    return copy.sort((a, b) =>
      String(a.nombre || "")
        .localeCompare(
          String(b.nombre || ""),
          "es"
        )
    );
  }

  if (
    sort === "createdAt" ||
    sort === "year"
  ) {
    return copy.sort(
      (a, b) =>
        numericChapter(b) -
        numericChapter(a)
    );
  }

  if (
    sort === "rating" ||
    sort === "followedCount" ||
    sort === "popularity" ||
    sort === "relevance"
  ) {
    return copy.sort(
      (a, b) =>
        Number(b.popularidad || 0) -
        Number(a.popularidad || 0)
    );
  }

  if (
    sort === "latestUploadedChapter" ||
    sort === "latest"
  ) {
    return copy.sort(
      (a, b) =>
        numericChapter(b) -
        numericChapter(a)
    );
  }

  return copy;
}


router.get("/image", async (req, res) => {

  const raw =
    String(req.query.url || "").trim();

  if (!raw) {
    return res.status(400).json({
      error: "Falta la URL de la imagen"
    });
  }

  let target;

  try {
    target = new URL(raw);

  } catch {
    return res.status(400).json({
      error: "URL de imagen inválida"
    });
  }

  if (
    !/^https?:$/.test(target.protocol)
  ) {
    return res.status(400).json({
      error: "Protocolo de imagen no permitido"
    });
  }

  const host =
    target.hostname.toLowerCase();

  const blockedHosts = new Set([
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "::1"
  ]);

  if (
    blockedHosts.has(host) ||
    host.endsWith(".local")
  ) {
    return res.status(403).json({
      error: "Destino no permitido"
    });
  }

  try {

    const upstream = await fetch(target, {

      headers: {
        "User-Agent": "KomiVerso/1.0",

        "Accept":
          "image/avif,image/webp,image/apng," +
          "image/svg+xml,image/*,*/*;q=0.8",

        "Referer":
          "https://manhwaweb.com/"
      },

      signal:
        AbortSignal.timeout(20000)
    });

    if (!upstream.ok) {
      return res
        .status(upstream.status)
        .end();
    }

    const contentType =
      upstream.headers.get(
        "content-type"
      ) || "image/jpeg";

    const buffer =
      Buffer.from(
        await upstream.arrayBuffer()
      );

    res.setHeader(
      "Content-Type",
      contentType
    );

    res.setHeader(
      "Cache-Control",
      "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400"
    );

    res.setHeader(
      "Content-Length",
      String(buffer.length)
    );

    return res.end(buffer);

  } catch (err) {

    console.error(
      "image proxy:",
      err.message
    );

    return res.status(502).end();
  }
});


router.get("/", async (req, res) => {

  try {

    let items = await readCatalog();

    const q =
      String(
        req.query.title ||
        req.query.q ||
        ""
      )
        .trim()
        .toLowerCase();

    const origin =
      req.query.origin ||
      req.query["originalLanguage[]"];

    const type =
      req.query.type || null;

    const status =
      req.query.status ||
      req.query["status[]"] ||
      null;

    const demographic =
      req.query.demographic ||
      req.query["publicationDemographic[]"] ||
      null;

    const genres =
      req.query["includedTags[]"] ||
      null;

    const limit =
      Math.min(
        Math.max(
          Number(req.query.limit) || 30,
          1
        ),
        200
      );

    const sort =
      req.query.sort || "latest";


    if (q) {

      items = items.filter(x =>
        [
          x.nombre,
          x.autor,
          x.artista
        ].some(v =>
          String(v || "")
            .toLowerCase()
            .includes(q)
        )
      );
    }


    if (origin) {

      const wanted =
        Array.isArray(origin)
          ? origin
          : [origin];

      items = items.filter(x =>
        wanted.includes(
          x.tipo === "manhwa"
            ? "ko"
            : x.tipo === "manhua"
              ? "zh"
              : "ja"
        )
      );
    }


    if (type) {

      const wantedType =
        /^novel/i.test(String(type))
          ? "novela"
          : String(type).toLowerCase();

      items = items.filter(x =>
        String(x.tipo || "")
          .toLowerCase() ===
        wantedType
      );
    }


    if (status) {

      const wanted =
        listParam(status)
          .map(v =>
            String(v).toLowerCase()
          );

      items = items.filter(x =>
        wanted.some(v =>
          normalizeStatus(
            x.estado,
            x.hiatus
          ) === v ||

          String(x.estado || "")
            .toLowerCase() === v
        )
      );
    }


    if (demographic) {

      const wanted =
        listParam(demographic);

      items = items.filter(x =>
        wanted.some(v =>
          String(
            x.demografia || ""
          ).toLowerCase() ===
          String(v).toLowerCase()
        )
      );
    }


    if (genres) {

      const wanted =
        listParam(genres);

      items = items.filter(x =>
        wanted.length === 0 ||
        wanted.some(v =>
          categoriesOf(x).some(t =>
            String(t)
              .toLowerCase() ===
            v.toLowerCase() ||

            String(t)
              .toLowerCase()
              .includes(
                v.toLowerCase()
              )
          )
        )
      );
    }


    items =
      sortItems(items, sort);


    res.json({

      data:
        items
          .slice(0, limit)
          .map(toManga),

      total:
        items.length
    });

  } catch (err) {

    res.status(500).json({

      error:
        "No se pudo cargar el catálogo",

      detail:
        err.message
    });
  }
});


router.get("/:id", async (req, res) => {

  const id = req.params.id;

  const found =
    await readOne(id);

  const tieneDetalleCompleto =
    Boolean(found) &&
    Boolean(found.sinopsis) &&
    Array.isArray(found.capitulos) &&
    found.capitulos.length > 0;

  if (tieneDetalleCompleto) {
    return res.json(toManga(found));
  }

  try {

    const detail =
      await upstreamJson(
        `${API}/manhwa/see/${encodeURIComponent(id)}`
      );


    const base =
      found || {
        id,
        nombre: null,
        imagen: null,
        capitulo: null,
        sinopsis: null
      };


    const chapters =
      Array.isArray(detail?.chapters)

        ? detail.chapters
            .map(c => ({
              id:
                `${id}-${c.chapter}`,

              chapter:
                c.chapter,

              title:
                "",

              lang:
                "es",

              pages:
                null,

              publishAt:
                null,

              readableAt:
                null,

              group:
                "—",

              link:
                c.link || null
            }))

            .sort(
              (a, b) =>
                Number.parseFloat(b.chapter) -
                Number.parseFloat(a.chapter)
            )

        : (base.capitulos || []);


    res.json(
      toManga({

        ...base,

        nombre:
          safeStr(detail?.name_esp) ||
          safeStr(detail?.name) ||
          base.nombre,

        imagen:
          safeStr(detail?._imagen) ||
          safeStr(detail?.imagen) ||
          base.imagen,

        sinopsis:
          safeStr(detail?._sinopsis) ??
          safeStr(detail?.sinopsis) ??
          safeStr(detail?.synopsis) ??
          safeStr(detail?.descripcion) ??
          safeStr(detail?.description) ??
          base.sinopsis,

        tags:
          Array.isArray(
            detail?._categoris
          )

            ? detail._categoris
                .flatMap(x =>
                  typeof x === "object" && x
                    ? Object.values(x)
                    : [x]
                )
                .map(safeStr)
                .filter(Boolean)

            : (
              Array.isArray(detail?.tags)

                ? detail.tags
                    .map(x =>
                      typeof x === "string"
                        ? x
                        : (
                          x?.name ||
                          x?.nombre
                        )
                    )
                    .map(safeStr)
                    .filter(Boolean)

                : (base.tags || [])
            ),

        categorias:
          Array.isArray(
            detail?._categoris
          )

            ? detail._categoris
                .flatMap(x =>
                  typeof x === "object" && x
                    ? Object.values(x)
                    : [x]
                )
                .map(safeStr)
                .filter(Boolean)

            : (base.categorias || []),

        estado:
          safeStr(detail?._status) ||
          safeStr(detail?.status) ||
          safeStr(detail?.estado) ||
          base.estado,

        anio:
          safeNum(detail?.year) ??
          safeNum(detail?.anio) ??
          base.anio,

        autor:
          Array.isArray(
            detail?._extras?.autores
          )

            ? (
              detail._extras.autores
                .map(safeStr)
                .filter(Boolean)
                .join(", ")
                .trim() || base.autor
            )

            : (
              safeStr(detail?.author) ||
              safeStr(detail?.autor) ||
              base.autor
            ),

        artista:
          safeStr(detail?.artist) ||
          safeStr(detail?.artista) ||
          base.artista,

        demografia:
          safeStr(detail?._demografi) ||
          safeStr(detail?.demografia) ||
          base.demografia ||
          null,

        popularidad:
          safeNum(detail?.popularidad) ??
          base.popularidad ??
          0,

        hiatus:
          Boolean(
            detail?._extras?.hiatus ??
            base.hiatus ??
            false
          ),

        erotico:
          safeStr(detail?._erotico) ||
          base.erotico ||
          "no",

        capitulo:
          safeStr(detail?._numero_cap) ??
          chapters[0]?.chapter ??
          base.capitulo,

        capitulos:
          chapters.length
            ? chapters
            : (base.capitulos || [])
      })
    );


  } catch (err) {

    if (found) {
      return res.json(
        toManga(found)
      );
    }

    res.status(502).json({

      error:
        "No se pudo cargar el manhwa desde ManhwaWeb",

      detail:
        err.message
    });
  }
});


router.get(
  "/:id/chapter/:chapter",
  async (req, res) => {

    const id =
      req.params.id;

    const chapter =
      req.params.chapter;


    try {

      const found =
        await readOne(id);


      let chapterLink =
        null;


      const localChapters =
        Array.isArray(
          found?.capitulos
        )
          ? found.capitulos
          : [];


      const localMatch =
        localChapters.find(c =>
          String(c?.chapter) ===
          String(chapter)
        );


      if (localMatch?.link) {
        chapterLink =
          localMatch.link;
      }

      const isOlympus =
        String(id).startsWith("olympus-") ||
        found?.plataforma === "olympus";

      let olympusFailReason = null;

      if (isOlympus) {
        const { slug } = parseOlympusRemote(found?.remoteId);
        const olympusChapterId = chapterLink || localMatch?.link;

        if (!slug || !olympusChapterId) {
          olympusFailReason = "Capítulo Olympus sin slug o sin id de capítulo guardado";
        } else {
          try {
            const images = await fetchOlympusPages(slug, olympusChapterId);
            if (!images.length) {
              olympusFailReason = "Olympus no devolvió imágenes para este capítulo";
            } else {
              const proxied = images.map(proxiedImageUrl).filter(Boolean);
              return res.json({
                full: proxied,
                saver: proxied,
                chapter,
                source: "olympus",
              });
            }
          } catch (err) {
            olympusFailReason = `Olympus no disponible: ${err.message}`;
          }
        }

        console.warn(
          `⚠️ Olympus falló para ${id}/${chapter} (${olympusFailReason}), intentando con manhwaweb...`
        );
      }


      if (!chapterLink) {

        try {
          const detail =
            await upstreamJson(
              `${API}/manhwa/see/${encodeURIComponent(id)}`
            );


          const remoteChapters =
            Array.isArray(
              detail?.chapters
            )
              ? detail.chapters
              : [];


          const remoteMatch =
            remoteChapters.find(c =>
              String(c?.chapter) ===
              String(chapter)
            );


          chapterLink =
            remoteMatch?.link ||
            null;
        } catch (err) {
          console.warn(
            `⚠️ No se pudo obtener el detalle de ${id} en manhwaweb (${err.message}), se usarán endpoints adivinados`
          );
        }
      }


      let confirmedEndpoint =
        null;


      if (chapterLink) {

        try {

          const chapterUrl =
            new URL(chapterLink, "https://manhwaweb.com");

          const pathname =
            chapterUrl.pathname;


          const segments =
            pathname.split("/").filter(Boolean);

          const slug =
            pathname.startsWith("/leer/")
              ? pathname
                  .replace(/^\/leer/, "")
                  .replace(/\/+$/, "")
              : (
                segments.length
                  ? `/${segments[segments.length - 1]}`
                  : ""
              );

          if (slug) {
            confirmedEndpoint =
              `${API}/chapters/see${slug}`;
          }

        } catch {
        }
      }


      const baseSlug =
        `${encodeURIComponent(id)}-` +
        `${encodeURIComponent(chapter)}`;

      const guessEndpoints = [
        `${API}/chapters/see/${baseSlug}`,
        `${API}/chapters/see/${baseSlug}_01`,
        `${API}/chapters/see/${baseSlug}_02`,
        `${API}/chapters/see/${baseSlug}_03`,
      ];

      const candidateEndpoints = confirmedEndpoint
        ? [
            confirmedEndpoint,
            ...guessEndpoints.filter(e => e !== confirmedEndpoint)
          ]
        : guessEndpoints;


      let images = [];

      if (/^novel/i.test(String(found?.tipo || ""))) {
        const notes = req.query.debug === "1" ? [] : null;

        const novel = await loadNovelChapter({
          endpoints: candidateEndpoints,
          fetchJson: upstreamJson,
          key: `${id}:${chapter}`,
          notes
        });

        if (notes) {
          return res.json({
            tipo: found?.tipo,
            endpoints: candidateEndpoints,
            notes,
            paragraphs: novel.paragraphs.length,
            images: novel.images.length,
            sample: novel.paragraphs.slice(0, 2)
          });
        }

        if (novel.paragraphs.length) {
          return res.json({
            type: "novel",
            chapter,
            paragraphs: novel.paragraphs,
            full: [],
            saver: []
          });
        }

        images = novel.images;

        if (!images.length) {
          throw new Error(
            novel.error?.message ||
            "No se encontró texto para este capítulo de novela"
          );
        }
      }

      console.log(
        `🔎 link guardado: ${chapterLink} | confirmado: ${confirmedEndpoint}`
      );

      let lastError =
        null;

      const tried = [];

      for (const endpoint of (images.length ? [] : candidateEndpoints)) {

        console.log(
          `📖 Capítulo ${id}/${chapter}`
        );

        console.log(
          `🔗 Probando endpoint: ${endpoint}`
        );

        try {

          const data =
            await upstreamJson(
              endpoint
            );

          const found =
            Array.isArray(
              data?.chapter?.img
            )
              ? data.chapter.img
              : [];

          if (found.length > 0) {
            images = found;
            break;
          }

          tried.push(
            `${endpoint} → 200 sin imágenes (claves: ${
              Object.keys(data || {}).join(",") || "ninguna"
            })`
          );

        } catch (err) {
          lastError = err;
          tried.push(`${endpoint} → ${err.message}`);
        }
      }


      if (
        images.length === 0
      ) {

        throw new Error(
          `${
            olympusFailReason ? `${olympusFailReason} | ` : ""
          }${
            lastError?.message ||
            "ManhwaWeb no devolvió imágenes para este capítulo"
          } | Probados: ${tried.join(" ; ")}`
        );
      }


      const proxied =
        images
          .map(proxiedImageUrl)
          .filter(Boolean);


      res.json({

        full:
          proxied,

        saver:
          proxied,

        chapter:
          chapter
      });


    } catch (err) {

      console.error(
        `chapter ${id}/${chapter}:`,
        err.message
      );


      res.status(502).json({

        error:
          "No se pudieron cargar las páginas",

        detail:
          err.message
      });
    }
  }
);


export default router;


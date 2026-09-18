const TEXT_KEYS = [
  "text", "texto", "content", "contenido", "body", "html",
  "novel", "novela", "story", "historia", "txt", "paragraphs", "parrafos", "lines",
];
const IMG_KEYS = ["img", "images", "imagenes", "pages", "paginas"];
const CACHE_TTL = 15 * 60 * 1000;
const CACHE_MAX = 150;
const MAX_PARTS = 300;
const MAX_PARAGRAPHS = 8000;
const cache = new Map();

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", ndash: "–", mdash: "—" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function htmlToText(s) {
  return s
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(p|div|h[1-6]|li|blockquote|section|article)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
}

export function toParagraphs(value) {
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of list) {
    if (item == null) continue;
    let raw = item;
    if (typeof raw === "object") raw = pickText(raw) ?? "";
    if (Array.isArray(raw)) {
      out.push(...toParagraphs(raw));
      continue;
    }
    const clean = decodeEntities(htmlToText(String(raw))).replace(/\r/g, "").replace(/\u00a0/g, " ");
    for (const line of clean.split("\n")) {
      const t = line.trim();
      if (t) out.push(t);
      if (out.length >= MAX_PARAGRAPHS) return out;
    }
  }
  return out;
}

function pickText(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  for (const k of TEXT_KEYS) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v;
    if (Array.isArray(v) && v.length) return v;
  }
  return null;
}

function entryUrl(e) {
  if (typeof e === "string") return e.trim();
  if (e && typeof e === "object") return e.url || e.src || e.link || e.image || e.img || null;
  return null;
}

function isHttp(s) {
  return typeof s === "string" && /^https?:\/\//i.test(s);
}

function isSafeUrl(s) {
  try {
    const u = new URL(s);
    const h = u.hostname.toLowerCase();
    return /^https?:$/.test(u.protocol) && !["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(h) && !h.endsWith(".local");
  } catch {
    return false;
  }
}

function isImageBytes(b) {
  if (!b || b.length < 12) return false;
  const ascii = (from, to) => String.fromCharCode(...b.slice(from, to));
  if (b[0] === 0xff && b[1] === 0xd8) return true;
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return true;
  if (ascii(0, 3) === "GIF") return true;
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return true;
  if (ascii(4, 8) === "ftyp") return true;
  if (ascii(0, 2) === "BM") return true;
  return false;
}

async function fetchBytes(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "KomiVerso/1.0", Accept: "*/*", Referer: "https://manhwaweb.com/" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function bytesToString(bytes) {
  let text = new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
  const bad = (text.match(/\uFFFD/g) || []).length;
  if (bad > text.length * 0.02) text = new TextDecoder("windows-1252").decode(bytes);
  return text;
}

function textToParagraphs(text, depth = 0) {
  const t = text.trim();
  if (depth < 3 && (t.startsWith("{") || t.startsWith("["))) {
    try {
      const json = JSON.parse(t);
      if (Array.isArray(json)) return toParagraphs(json);
      const inner = pickText(json) ?? pickText(json?.chapter) ?? pickText(json?.data);
      if (inner) return toParagraphs(inner);
    } catch {}
  }
  return toParagraphs(t);
}

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

export async function readNovelFromUpstream(data, notes) {
  const ch = data && typeof data === "object" && data.chapter && typeof data.chapter === "object" ? data.chapter : data;
  const note = { keys: Object.keys(ch || {}) };
  notes?.push(note);

  const direct = pickText(ch) ?? pickText(data);
  if (direct) {
    const paragraphs = toParagraphs(direct);
    note.source = "campo de texto";
    if (paragraphs.length) return { paragraphs, images: [] };
  }

  let entries = [];
  for (const k of IMG_KEYS) {
    if (Array.isArray(ch?.[k]) && ch[k].length) {
      entries = ch[k];
      note.listKey = k;
      break;
    }
  }
  note.entries = entries.length;
  note.firstEntry = entries.length ? JSON.stringify(entries[0]).slice(0, 200) : null;
  if (!entries.length) return { paragraphs: [], images: [] };

  const urls = entries.map(entryUrl).filter(u => isHttp(u) && isSafeUrl(u));
  if (!urls.length) {
    note.source = "lista de texto";
    return { paragraphs: toParagraphs(entries), images: [] };
  }

  const first = await fetchBytes(urls[0]);
  const firstIsImage = isImageBytes(first);
  note.sniff = { url: urls[0].slice(0, 200), bytes: first.length, image: firstIsImage };
  if (firstIsImage) return { paragraphs: [], images: urls };

  note.source = "archivos de texto";
  const parts = [textToParagraphs(bytesToString(first))];
  const rest = urls.slice(1, MAX_PARTS);
  const fetched = await inBatches(rest, 5, async url => {
    try {
      const bytes = await fetchBytes(url);
      return isImageBytes(bytes) ? [] : textToParagraphs(bytesToString(bytes));
    } catch {
      return [];
    }
  });
  const paragraphs = [...parts, ...fetched].flat().slice(0, MAX_PARAGRAPHS);
  return { paragraphs, images: [] };
}

export async function loadNovelChapter({ endpoints, fetchJson, key, notes }) {
  if (!notes) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
  }

  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const data = await fetchJson(endpoint);
      notes?.push({ endpoint });
      const result = await readNovelFromUpstream(data, notes);
      if (result.paragraphs.length) {
        const value = { paragraphs: result.paragraphs, images: [] };
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(key, { at: Date.now(), value });
        return value;
      }
      if (result.images.length) return { paragraphs: [], images: result.images };
    } catch (err) {
      lastError = err;
      notes?.push({ endpoint, error: err.message });
    }
  }
  return { paragraphs: [], images: [], error: lastError };
}

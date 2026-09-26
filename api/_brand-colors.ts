import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

/**
 * Social Leads › "Cores da marca": what the server reads from the client's
 * site or Instagram before asking Claude to pick the palette. The pages are
 * fetched here (not by the model) so the colours come from the real CSS,
 * the SVG logo and the images (logo, icon, profile photo) Claude looks at.
 *
 * Addresses come from what the person typed, so every fetch is checked:
 * http(s) only, public addresses only (no localhost, private networks or
 * cloud metadata), redirects checked again, time and size limited.
 */

export type Lookup = (host: string) => Promise<string[]>;
export const defaultLookup: Lookup = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

export class FetchBlocked extends Error {}

function privateV4(ip: string) {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}
export function privateAddress(ip: string) {
  if (net.isIPv4(ip)) return privateV4(ip);
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateV4(mapped[1]);
  return (
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe8") ||
    v6.startsWith("fe9") ||
    v6.startsWith("fea") ||
    v6.startsWith("feb") ||
    v6.startsWith("ff")
  );
}

async function checkUrl(raw: string, lookup: Lookup) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchBlocked("Endereço inválido.");
  }
  if (!/^https?:$/.test(url.protocol))
    throw new FetchBlocked("Só http e https.");
  if (url.username || url.password)
    throw new FetchBlocked("Endereço inválido.");
  if (url.port && !["80", "443"].includes(url.port))
    throw new FetchBlocked("Porta não permitida.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host.includes(".") && !net.isIP(host))
    throw new FetchBlocked("Endereço inválido.");
  const ips = net.isIP(host) ? [host] : await lookup(host).catch(() => []);
  if (!ips.length) throw new FetchBlocked("Endereço não encontrado.");
  if (ips.some(privateAddress))
    throw new FetchBlocked("Endereço não permitido.");
  return url;
}

export type Fetched = { url: string; type: string; body: Buffer };
/** One public page or file, redirects followed (checked), at most maxBytes. */
export async function safeFetch(
  raw: string,
  opts: {
    fetch: typeof fetch;
    lookup: Lookup;
    maxBytes: number;
    timeoutMs?: number;
  },
): Promise<Fetched> {
  let current = raw;
  for (let hop = 0; hop < 4; hop++) {
    const url = await checkUrl(current, opts.lookup);
    const res = await opts.fetch(url.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; MAVI-Workspace/1.0; +https://workspace.maso.app.br)",
        Accept: "text/html,text/css,image/*;q=0.9,*/*;q=0.5",
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) throw new FetchBlocked("Redirecionamento sem destino.");
      current = new URL(next, url).href;
      continue;
    }
    if (!res.ok) throw new FetchBlocked(`O endereço respondeu ${res.status}.`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > opts.maxBytes)
      throw new FetchBlocked("Arquivo grande demais.");
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = res.body?.getReader();
    if (reader)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > opts.maxBytes) {
          await reader.cancel();
          break;
        }
        chunks.push(Buffer.from(value));
      }
    return {
      url: url.href,
      type: (res.headers.get("content-type") ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase(),
      body: Buffer.concat(chunks),
    };
  }
  throw new FetchBlocked("Redirecionamentos demais.");
}

// ------------------------------------------------------------ colours
const HEX = /#([0-9a-f]{6}|[0-9a-f]{3})\b/gi;
const RGB =
  /rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+%?))?\s*\)/gi;
const hex2 = (n: number) =>
  Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
export function normalizeHex(value: string) {
  const v = value.replace("#", "").toLowerCase();
  return `#${v.length === 3 ? [...v].map((c) => c + c).join("") : v}`;
}
/** Every colour written in the text, with how many times it appears. */
export function countColors(text: string, into = new Map<string, number>()) {
  for (const m of text.matchAll(HEX)) {
    const h = normalizeHex(m[0]);
    into.set(h, (into.get(h) ?? 0) + 1);
  }
  for (const m of text.matchAll(RGB)) {
    const alpha = m[4] ? parseFloat(m[4]) / (m[4].endsWith("%") ? 100 : 1) : 1;
    if (alpha < 0.5) continue;
    const h = `#${hex2(+m[1])}${hex2(+m[2])}${hex2(+m[3])}`;
    into.set(h, (into.get(h) ?? 0) + 1);
  }
  return into;
}
const attr = (tag: string, name: string) =>
  tag
    .match(
      new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
    )
    ?.slice(2)
    .find(Boolean) ?? "";

export type SiteReading = {
  title: string;
  /** Colours by frequency (theme-color first). */
  colors: { hex: string; count: number }[];
  /** Images worth showing to the model (logo, icon, social image). */
  images: string[];
  stylesheets: string[];
};
/** What an HTML page tells about its colours and images. */
export function readHtml(html: string, base: string): SiteReading {
  const counts = new Map<string, number>();
  const abs = (u: string) => {
    try {
      return new URL(u.trim(), base).href;
    } catch {
      return "";
    }
  };
  const tags = html.match(/<(meta|link|img)\b[^>]*>/gi) ?? [];
  let theme = "";
  const images: string[] = [];
  const stylesheets: string[] = [];
  for (const t of tags) {
    const name = t.slice(1, 5).toLowerCase();
    if (name.startsWith("meta")) {
      const key = (attr(t, "name") || attr(t, "property")).toLowerCase();
      const content = attr(t, "content");
      if (key === "theme-color" || key === "msapplication-tilecolor")
        theme = content;
      if (key === "og:image" || key === "twitter:image")
        images.push(abs(content));
    } else if (name.startsWith("link")) {
      const rel = attr(t, "rel").toLowerCase();
      const href = abs(attr(t, "href"));
      if (!href) continue;
      if (rel.includes("stylesheet")) stylesheets.push(href);
      if (/icon/.test(rel)) images.unshift(href);
      if (rel.includes("mask-icon")) countColors(attr(t, "color"), counts);
    } else if (/logo/i.test(t)) {
      const src = abs(attr(t, "src"));
      if (src) images.unshift(src);
    }
  }
  for (const s of html.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) ?? [])
    countColors(s, counts);
  for (const s of html.match(/\bstyle\s*=\s*"[^"]*"/gi) ?? [])
    countColors(s, counts);
  for (const s of html.match(/<svg\b[\s\S]*?<\/svg>/gi) ?? [])
    countColors(s, counts);
  const colors = [...counts].map(([hex, count]) => ({ hex, count }));
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(theme.trim()))
    colors.unshift({ hex: normalizeHex(theme.trim()), count: 999 });
  return {
    title: (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160),
    colors,
    images: [...new Set(images.filter(Boolean))],
    stylesheets: [...new Set(stylesheets)],
  };
}

/** The most frequent colours, deduplicated, at most `limit`. */
export function topColors(list: { hex: string; count: number }[], limit = 30) {
  const merged = new Map<string, number>();
  for (const c of list)
    merged.set(c.hex, Math.max(merged.get(c.hex) ?? 0, 0) + c.count);
  return [...merged]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([hex, count]) => ({ hex, count }));
}

export function instagramUrl(handle: string) {
  const h = handle
    .trim()
    .replace(/^@/, "")
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, "")
    .split(/[/?#]/)[0];
  return /^[a-z0-9._]{1,30}$/i.test(h)
    ? `https://www.instagram.com/${h}/`
    : null;
}
export function siteUrl(value: string) {
  const v = value.trim();
  if (!v || /\s/.test(v)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    return url.hostname.includes(".") ? url.href : null;
  } catch {
    return null;
  }
}

export type Gathered = {
  sources: string[];
  title: string;
  colors: { hex: string; count: number }[];
  images: { media_type: string; data: string }[];
  notes: string[];
};
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** Reads the site and/or the Instagram profile. Never throws: notes say what failed. */
export async function gatherBrand(
  input: { website?: string | null; instagram?: string | null },
  opts: { fetch: typeof fetch; lookup: Lookup },
): Promise<Gathered> {
  const out: Gathered = {
    sources: [],
    title: "",
    colors: [],
    images: [],
    notes: [],
  };
  const imageUrls: string[] = [];
  const page = async (url: string, label: string) => {
    try {
      const r = await safeFetch(url, { ...opts, maxBytes: 1_500_000 });
      if (!r.type.includes("html")) {
        out.notes.push(`${label}: o endereço não é uma página.`);
        return null;
      }
      out.sources.push(r.url);
      return readHtml(r.body.toString("utf8"), r.url);
    } catch (e) {
      out.notes.push(`${label}: ${(e as Error).message || "não abriu."}`);
      return null;
    }
  };
  const site = input.website ? siteUrl(input.website) : null;
  if (site) {
    const reading = await page(site, "Site");
    if (reading) {
      out.title = reading.title;
      out.colors.push(...reading.colors);
      imageUrls.push(...reading.images);
      for (const css of reading.stylesheets.slice(0, 4)) {
        try {
          const r = await safeFetch(css, { ...opts, maxBytes: 1_000_000 });
          countColors(r.body.toString("utf8")).forEach((count, hex) =>
            out.colors.push({ hex, count }),
          );
        } catch {
          // A stylesheet that doesn't open only means fewer candidates.
        }
      }
    }
  }
  const ig = input.instagram ? instagramUrl(input.instagram) : null;
  if (ig) {
    const reading = await page(ig, "Instagram");
    // Without login Instagram usually shows only the profile photo (og:image).
    if (reading)
      imageUrls.push(
        ...reading.images.filter(
          (u) => !/static\.cdninstagram|\/rsrc\.php/.test(u),
        ),
      );
  }
  for (const url of imageUrls) {
    if (out.images.length >= 3) break;
    if (/\.svg(\?|$)/i.test(url)) {
      try {
        const r = await safeFetch(url, { ...opts, maxBytes: 500_000 });
        countColors(r.body.toString("utf8")).forEach((count, hex) =>
          out.colors.push({ hex, count: count * 5 }),
        );
      } catch {
        // Next image.
      }
      continue;
    }
    try {
      const r = await safeFetch(url, { ...opts, maxBytes: 4_000_000 });
      if (IMAGE_TYPES.includes(r.type) && r.body.length > 200)
        out.images.push({
          media_type: r.type,
          data: r.body.toString("base64"),
        });
    } catch {
      // Next image.
    }
  }
  out.colors = topColors(out.colors);
  return out;
}

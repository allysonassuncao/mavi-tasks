// Campanhas: imports the MASO's "Acompanhamento" (campaigns, cycles, links,
// daily numbers and cycle snapshots) from phpMyAdmin JSON exports into one
// SQL file for the Supabase SQL editor (runs as postgres, bypassing RLS and
// the RPCs; the tables' checks still apply). The SQL is one transaction and
// idempotent: rows are found by legacy_id and inserted with
// "on conflict do nothing", so running it again adds nothing.
//
//   node scripts/import-maso-campaigns.mjs --input maso.json [--input more.json]
//     --company <uuid> --author <uuid> --mapping mapa.csv --out import.sql
//   node scripts/import-maso-campaigns.mjs --input maso.json --template mapa.csv
//
// MASO clients have no counterpart id in MAVI, so a CSV maps each
// id_cliente to a contract (produto contratado); --template writes it with
// the contract_id column empty, for someone to fill in.
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BATCH = 500;
const MAX_WARNINGS_SHOWN = 30;
// usuarios_maso.id of the MASO robot (author of the automatic records).
const MASO_ROBOT = "75";

const PLATFORMS = {
  1: "meta",
  2: "google",
  // Meta + Google, a legacy combination: imported as Meta.
  3: "meta",
  4: "linkedin",
  5: "kwai",
  6: "tiktok",
};
const OBJECTIVES = {
  LEAD: "lead",
  LEADS: "lead",
  VENDA: "sale",
  VENDAS: "sale",
  MENSAGEM: "message",
  MENSAGENS: "message",
  TRAFEGO: "traffic",
  ENGAJAMENTO: "engagement",
  PERSONALIZADA: "custom",
  PERSONALIZADO: "custom",
  VIDEO: "video",
};

export class UsageError extends Error {}

// ------------------------------------------------------------------ text

// Windows-1252 characters for bytes 0x80–0x9F, as UTF-8 read as cp1252
// shows them ("â€™" for "’").
const CP1252 = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};
const CONTINUATION = `[\\u0080-\\u00bf${Object.keys(CP1252)
  .map((c) => `\\u${Number(c).toString(16).padStart(4, "0")}`)
  .join("")}]`;
// A UTF-8 lead byte followed by as many continuation bytes as it needs, all
// shown as latin1/cp1252 characters.
const MOJIBAKE = new RegExp(
  `[\\u00c2-\\u00df]${CONTINUATION}|[\\u00e0-\\u00ef]${CONTINUATION}{2}|[\\u00f0-\\u00f4]${CONTINUATION}{3}`,
  "g",
);
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Undoes UTF-8 text stored as latin1 ("PromoÃ§Ã£o" → "Promoção"), piece by
 * piece, since the MASO mixes both encodings in the same field. A piece is
 * only replaced when its bytes are valid UTF-8, so correct text stays.
 */
export function fixMojibake(value) {
  let text = value;
  for (let pass = 0; pass < 2; pass++) {
    const fixed = text.replace(MOJIBAKE, (piece) => {
      const bytes = [...piece].map((ch) => {
        const code = ch.codePointAt(0);
        return code <= 0xff ? code : CP1252[code];
      });
      try {
        return utf8.decode(Uint8Array.from(bytes));
      } catch {
        return piece;
      }
    });
    if (fixed === text) break;
    text = fixed;
  }
  return text;
}

const ENTITIES = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
};
const ACCENTS = {
  acute: "\u0301",
  grave: "\u0300",
  circ: "\u0302",
  tilde: "\u0303",
  uml: "\u0308",
  cedil: "\u0327",
};
// Some MASO fields hold HTML entities ("Promo&ccedil;&atilde;o").
function decodeEntities(text) {
  return text
    .replace(/&#(\d{1,7});/g, (m, n) => safeCodePoint(Number(n), m))
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, n) =>
      safeCodePoint(parseInt(n, 16), m),
    )
    .replace(
      /&([a-z])(acute|grave|circ|tilde|uml|cedil);/gi,
      (m, letter, accent) =>
        (letter + ACCENTS[accent.toLowerCase()]).normalize("NFC"),
    )
    .replace(
      /&(amp|quot|apos|lt|gt|nbsp);/gi,
      (m, name) => ENTITIES[name.toLowerCase()],
    );
}
function safeCodePoint(code, fallback) {
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}

/** A MASO text value, cleaned: '' for null, fixed encoding, trimmed. */
export function cleanText(value) {
  if (value == null) return "";
  return decodeEntities(fixMojibake(String(value)))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
}
const oneLine = (value) => cleanText(value).replace(/\s+/g, " ");

/**
 * A MASO number: "1234.56", "R$ 1.234,56", "1,5", "" or null. Returns null
 * when empty and NaN when unreadable.
 */
export function parseNumber(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  let s = String(value)
    .replace(/R\$|\s|\u00a0/gi, "")
    .trim();
  if (s === "") return null;
  const comma = s.lastIndexOf(",");
  const dot = s.lastIndexOf(".");
  if (comma >= 0 && dot >= 0)
    s =
      comma > dot
        ? s.replace(/\./g, "").replace(",", ".")
        : s.replace(/,/g, "");
  else if (comma >= 0)
    s = s.split(",").length > 2 ? s.replace(/,/g, "") : s.replace(",", ".");
  else if (s.split(".").length > 2) s = s.replace(/\./g, "");
  return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
}

/** "YYYY-MM-DD[ hh:mm:ss]" or "DD/MM/YYYY" → "YYYY-MM-DD"; null if none. */
export function parseDate(value) {
  const s = cleanText(value);
  let y, m, d;
  let match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) [, y, m, d] = match;
  else if ((match = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)))
    [, d, m, y] = match;
  else return null;
  const time = Date.UTC(+y, +m - 1, +d);
  const date = new Date(time);
  if (+y < 1900 || date.getUTCMonth() !== +m - 1 || date.getUTCDate() !== +d)
    return null;
  return date.toISOString().slice(0, 10);
}
const dayNumber = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000;
const monthStart = (iso) => `${iso.slice(0, 8)}01`;
const brDate = (iso) => iso.split("-").reverse().join("/");

/** "a, b ,0,,c" → ["a","b","c"] (MASO placeholders '0' and '' dropped). */
function csv(value) {
  return cleanText(value)
    .split(/[,;]/)
    .map((v) => v.trim())
    .filter((v) => v !== "" && v !== "0");
}
const unique = (list) => [...new Set(list)];
// MASO hashes are business keys: kept as they are, minus spaces.
const key = (value) => cleanText(value).replace(/\s+/g, "");
const isPlaceholder = (value) => value === "" || value === "0" || value === "1";

// ------------------------------------------------------------------ input

/**
 * Reads phpMyAdmin JSON exports into { table: rows }: one file with several
 * tables ([{type:"header"},{type:"table",name,data}…]), the older format
 * ("// db.table" comments before each array), a { table: rows } object, or
 * a plain array of rows named after the file (maso_acompanhamento.json).
 */
export async function readExports(files) {
  const tables = new Map();
  const add = (name, rows) => {
    const table = String(name).split(".").pop().toLowerCase();
    if (!Array.isArray(rows)) return;
    const list = tables.get(table) ?? [];
    for (const row of rows)
      if (row && typeof row === "object")
        list.push(
          Object.fromEntries(
            Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]),
          ),
        );
    tables.set(table, list);
  };
  for (const file of files) {
    let text;
    try {
      text = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
    } catch (e) {
      throw new UsageError(
        `Não foi possível ler ${file}: ${e.code === "ENOENT" ? "arquivo não encontrado" : e.message}`,
      );
    }
    const fileTable = basename(file).replace(/\.(json|sql)$/i, "");
    // phpMyAdmin's default export: an SQL dump with INSERT statements.
    if (/\.sql$/i.test(file) || /^\s*--\s*phpMyAdmin SQL Dump/.test(text)) {
      const found = parseSqlDump(text, file);
      for (const [name, rows] of found) add(name, rows);
      continue;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const sections = parseOldExport(text, file);
      for (const [name, rows] of sections) add(name ?? fileTable, rows);
      continue;
    }
    if (Array.isArray(data) && data.some((x) => x && x.type === "table")) {
      for (const entry of data)
        if (entry && entry.type === "table") add(entry.name, entry.data ?? []);
    } else if (Array.isArray(data)) {
      add(fileTable, data);
    } else if (data && typeof data === "object") {
      for (const [name, rows] of Object.entries(data)) add(name, rows);
    } else {
      throw new UsageError(
        `${file} não parece uma exportação JSON do phpMyAdmin.`,
      );
    }
  }
  return tables;
}

// Timeline rows other than snapshots only matter as a count: keeping just
// their tipo spares memory (the MASO's timeline has hundreds of thousands).
const SNAPSHOT_TABLE = "maso_acompanhamento_registro";

/**
 * The rows of every "INSERT INTO `table` (`a`, `b`) VALUES (...), (...);"
 * of a MySQL/phpMyAdmin dump, as strings (NULL as null), like phpMyAdmin's
 * JSON export. Strings follow MySQL's escaping (\' \\ \n …, and '').
 */
export function parseSqlDump(text, file = "dump") {
  const tables = new Map();
  const header = /INSERT INTO `([^`]+)` \(([^)]*)\) VALUES\s*/g;
  const escapes = { 0: "\0", n: "\n", r: "\r", t: "\t", b: "\b", Z: "\x1a" };
  let match;
  while ((match = header.exec(text))) {
    const table = match[1].toLowerCase();
    const columns = match[2]
      .split(",")
      .map((c) => c.trim().replace(/`/g, "").toLowerCase());
    const tipo = columns.indexOf("tipo");
    const rows = tables.get(table) ?? [];
    tables.set(table, rows);
    let i = header.lastIndex;
    const fail = (why) => {
      throw new UsageError(`Não foi possível ler ${file} (${table}): ${why}.`);
    };
    for (;;) {
      while (/\s/.test(text[i])) i++;
      if (text[i] !== "(") fail("esperava uma linha de valores");
      i++;
      const values = [];
      for (;;) {
        while (text[i] === " " || text[i] === "\n" || text[i] === "\r") i++;
        if (text[i] === "'") {
          let out = "";
          let start = ++i;
          for (;;) {
            const ch = text[i];
            if (ch === undefined) fail("texto sem fim");
            if (ch === "\\") {
              out += text.slice(start, i);
              const next = text[i + 1];
              out += escapes[next] ?? next;
              i += 2;
              start = i;
            } else if (ch === "'") {
              if (text[i + 1] === "'") {
                out += text.slice(start, i + 1);
                i += 2;
                start = i;
              } else {
                out += text.slice(start, i);
                i++;
                break;
              }
            } else i++;
          }
          values.push(out);
        } else {
          let end = i;
          while (end < text.length && text[end] !== "," && text[end] !== ")")
            end++;
          const raw = text.slice(i, end).trim();
          values.push(/^null$/i.test(raw) ? null : raw);
          i = end;
        }
        while (text[i] === " ") i++;
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === ")") {
          i++;
          break;
        }
        fail("esperava vírgula ou fim da linha");
      }
      if (values.length !== columns.length)
        fail("número de colunas diferente do cabeçalho");
      if (table === SNAPSHOT_TABLE && tipo >= 0 && values[tipo] !== "0")
        rows.push({ tipo: values[tipo] });
      else rows.push(Object.fromEntries(columns.map((c, k) => [c, values[k]])));
      while (/\s/.test(text[i])) i++;
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === ";") {
        header.lastIndex = i + 1;
        break;
      }
      fail("esperava vírgula ou ponto e vírgula");
    }
  }
  if (!tables.size)
    throw new UsageError(`${file} não tem nenhum INSERT de dados.`);
  return tables;
}

// phpMyAdmin before 4.x/5: a comment header, then "// db.table" and an array
// per table.
function parseOldExport(text, file) {
  const sections = [];
  let name = null;
  let buffer = [];
  const flush = () => {
    const body = buffer.join("\n").trim();
    buffer = [];
    if (!body) return;
    try {
      sections.push([name, JSON.parse(body)]);
    } catch (e) {
      throw new UsageError(
        `Não foi possível ler o JSON de ${file}: ${e.message}`,
      );
    }
  };
  for (const line of text.replace(/^\s*\/\*[\s\S]*?\*\//, "").split(/\r?\n/)) {
    const header = line.match(/^\s*\/\/\s*(\S+)\s*$/);
    if (header) {
      flush();
      name = header[1].replace(/`/g, "");
    } else if (!/^\s*\/\//.test(line)) buffer.push(line);
  }
  flush();
  if (sections.length === 0)
    throw new UsageError(`${file} está vazio ou não é JSON.`);
  return sections;
}

/** Semicolon- or comma-separated values, with "quoted" fields. */
function parseCsv(text) {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  if (lines.length === 0) return { header: [], rows: [] };
  const sep = lines[0].includes(";") ? ";" : ",";
  const split = (line) => {
    const out = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') ((field += '"'), i++);
        else if (ch === '"') quoted = false;
        else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === sep) (out.push(field.trim()), (field = ""));
      else field += ch;
    }
    out.push(field.trim());
    return out;
  };
  return {
    header: split(lines[0]).map((h) => h.toLowerCase()),
    rows: lines
      .slice(1)
      .map((line, i) => ({ line: i + 2, cells: split(line) })),
  };
}

/** id_cliente → contract uuid, from the user's CSV. */
export async function readMapping(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    throw new UsageError(
      `Não foi possível ler o mapa ${file}: ${e.code === "ENOENT" ? "arquivo não encontrado" : e.message}`,
    );
  }
  const { header, rows } = parseCsv(text);
  const clientCol = header.indexOf("id_cliente");
  const contractCol = header.indexOf("contract_id");
  if (clientCol < 0 || contractCol < 0)
    throw new UsageError(
      `O mapa ${file} precisa de um cabeçalho com as colunas id_cliente e contract_id.`,
    );
  const mapping = new Map();
  for (const { line, cells } of rows) {
    const client = key(cells[clientCol]);
    const contract = (cells[contractCol] ?? "").trim().toLowerCase();
    if (!client || !contract) continue;
    if (!UUID.test(contract))
      throw new UsageError(
        `Mapa, linha ${line}: contract_id "${contract}" não é um uuid válido.`,
      );
    if (mapping.has(client) && mapping.get(client) !== contract)
      throw new UsageError(
        `Mapa, linha ${line}: o cliente ${client} aparece com dois contratos diferentes.`,
      );
    mapping.set(client, contract);
  }
  return mapping;
}

// ------------------------------------------------------------------ report

function createReport() {
  const counter = () => new Map();
  return {
    written: {
      campaigns: 0,
      cycles: 0,
      links: 0,
      daily: 0,
      snapshots: 0,
      current: 0,
    },
    skipped: {
      campaigns: counter(),
      cycles: counter(),
      links: counter(),
      daily: counter(),
      snapshots: counter(),
    },
    notSnapshots: 0,
    unmappedClients: new Map(),
    notes: [],
    warnings: [],
    warningKinds: new Map(),
  };
}
function skip(report, entity, reason, n = 1) {
  const map = report.skipped[entity];
  map.set(reason, (map.get(reason) ?? 0) + n);
}
function warn(report, kind, message) {
  report.warnings.push(message);
  report.warningKinds.set(kind, (report.warningKinds.get(kind) ?? 0) + 1);
}

/** A metric: empty → 0; unreadable or negative → 0 with a warning. */
function metric(report, value, what, where, decimals) {
  const n = parseNumber(value);
  if (n == null) return 0;
  if (Number.isNaN(n)) {
    warn(
      report,
      "valor inválido",
      `${where}: ${what} "${value}" ilegível, usado 0.`,
    );
    return 0;
  }
  if (n < 0) {
    warn(
      report,
      "valor negativo",
      `${where}: ${what} negativo (${value}), usado 0.`,
    );
    return 0;
  }
  // numeric(14,2) holds less than 10^12: a value that big is a typo.
  if (n >= 1e12) {
    warn(
      report,
      "valor impossível",
      `${where}: ${what} ${value} impossível (digitação?), usado 0.`,
    );
    return 0;
  }
  return decimals === 0 ? Math.round(n) : Math.round(n * 100) / 100;
}

// ------------------------------------------------------------------ model

/** maso_acompanhamento → campaigns (first of each legacy id). */
function readCampaigns(tables, report) {
  const rows = tables.get("maso_acompanhamento");
  if (!rows)
    throw new UsageError(
      "A tabela maso_acompanhamento não está nas exportações informadas.",
    );
  const campaigns = new Map();
  for (const row of rows) {
    const legacy = key(row.id_campanha);
    if (!legacy || legacy === "0") {
      skip(report, "campaigns", "sem id_campanha");
      continue;
    }
    if (campaigns.has(legacy)) {
      skip(report, "campaigns", "id_campanha repetido (mantida a primeira)");
      warn(
        report,
        "id repetido",
        `Campanha ${legacy} aparece mais de uma vez (colisão de hash?): mantida a primeira ("${campaigns.get(legacy).name}"), ignorada "${oneLine(row.campanha)}".`,
      );
      continue;
    }
    campaigns.set(legacy, {
      legacy,
      client: key(row.id_cliente),
      name: oneLine(row.campanha),
      row,
    });
  }
  return campaigns;
}

function lookupNames(tables, table, columns) {
  const names = new Map();
  for (const row of tables.get(table) ?? []) {
    const id = key(row.id);
    const name = columns.map((c) => oneLine(row[c])).find((v) => v !== "");
    if (id && name) names.set(id, name);
  }
  return names;
}

/** Everything the SQL needs, already validated against the target checks. */
/**
 * options.products: MASO products to import (id_produto; all when empty).
 * options.newClients: create the client (named by its MASO id, as the ones
 * already in MAVI) and a contract of this product for clients not in the
 * mapping, instead of leaving their campaigns out.
 */
export function buildModel(tables, mapping, options = {}) {
  const products = options.products?.length ? new Set(options.products) : null;
  const report = createReport();
  const campaigns = readCampaigns(tables, report);
  const niches = lookupNames(tables, "nichomercado", [
    "nome",
    "titulo",
    "nicho",
    "descricao",
  ]);
  const users = lookupNames(tables, "usuarios_maso", [
    "nome",
    "nome_completo",
    "usuario",
  ]);
  if (!tables.has("nichomercado"))
    report.notes.push(
      "Sem a tabela nichomercado: o nicho dos ciclos fica em branco.",
    );
  if (!tables.has("usuarios_maso"))
    report.notes.push(
      'Sem a tabela usuarios_maso: os snapshots ficam com autor "MASO" (o robô, id 75, como "MASO · Robô").',
    );

  // ---- campaigns
  const accepted = new Map();
  for (const c of campaigns.values()) {
    const where = `Campanha ${c.legacy}`;
    if (!c.client || c.client === "0") {
      skip(report, "campaigns", "sem id_cliente");
      continue;
    }
    if (products && !products.has(key(c.row.id_produto))) {
      skip(report, "campaigns", "produto fora da importação");
      continue;
    }
    const contract =
      mapping.get(c.client) ?? (options.newClients ? null : undefined);
    if (contract === undefined) {
      skip(report, "campaigns", "cliente sem contrato no mapa");
      const client = report.unmappedClients.get(c.client) ?? {
        count: 0,
        example: c.name,
      };
      client.count++;
      report.unmappedClients.set(c.client, client);
      continue;
    }
    const platformCode = key(c.row.plataforma);
    const platform = PLATFORMS[platformCode];
    if (!platform) {
      skip(report, "campaigns", "plataforma desconhecida");
      warn(
        report,
        "plataforma",
        `${where}: plataforma "${platformCode}" desconhecida, campanha ignorada.`,
      );
      continue;
    }
    let name = c.name;
    if (name.length < 2) {
      name = `Campanha MASO ${c.legacy}`;
      warn(report, "nome", `${where}: sem nome, gravada como "${name}".`);
    } else if (name.length > 160) {
      name = name.slice(0, 160).trim();
      warn(
        report,
        "nome",
        `${where}: nome com mais de 160 caracteres, cortado.`,
      );
    }
    const notes = [];
    const url = (value, label) => {
      let link = cleanText(value);
      if (link === "" || link === "0") return "";
      if (/^www\./i.test(link)) link = `https://${link}`;
      if (/^https?:\/\/\S+$/i.test(link)) return link;
      notes.push(`${label} (MASO): ${link}`);
      warn(
        report,
        "link",
        `${where}: ${label.toLowerCase()} "${link}" não é um link http(s); guardado nas observações.`,
      );
      return "";
    };
    const briefing = url(c.row.briefing, "Briefing");
    const plan = url(c.row.plano_midia, "Plano de mídia");
    if (platformCode === "3")
      warn(
        report,
        "plataforma",
        `${where}: plataforma 3 (Meta + Google) importada como Meta; vínculos do Google ignorados.`,
      );
    accepted.set(c.legacy, {
      legacy: c.legacy,
      client: c.client,
      // The campaign's copy of the objective, for cycles without one.
      masoObjective: c.row.objetivo,
      contract,
      name,
      platform,
      status: key(c.row.status_campanha) === "1" ? "active" : "inactive",
      briefing,
      plan,
      notes: notes.join("\n").slice(0, 4000),
      currentHash: key(c.row.ciclo),
      cycles: [],
    });
  }

  // ---- cycles
  const cycles = new Map();
  const seenCycles = new Set();
  for (const row of tables.get("maso_acompanhamento_ciclo") ?? []) {
    const legacy = key(row.id_ciclo);
    const where = `Ciclo ${legacy}`;
    if (!legacy || legacy === "0") {
      skip(report, "cycles", "sem id_ciclo");
      continue;
    }
    if (seenCycles.has(legacy)) {
      skip(report, "cycles", "id_ciclo repetido (mantido o primeiro)");
      warn(
        report,
        "id repetido",
        `${where} aparece mais de uma vez (colisão de hash?): mantido o primeiro.`,
      );
      continue;
    }
    seenCycles.add(legacy);
    const campaign = accepted.get(key(row.id_campanha));
    if (!campaign) {
      skip(report, "cycles", "campanha não importada");
      continue;
    }
    const start = parseDate(row.data_inicio);
    const end = parseDate(row.data_termino);
    if (!start || !end) {
      skip(report, "cycles", "sem data de início ou término");
      warn(
        report,
        "ciclo inválido",
        `${where} (campanha "${campaign.name}"): sem data de início ou término, ignorado.`,
      );
      continue;
    }
    if (end < start || dayNumber(end) - dayNumber(start) >= 366) {
      skip(
        report,
        "cycles",
        end < start ? "término antes do início" : "ciclo com mais de 365 dias",
      );
      warn(
        report,
        "ciclo inválido",
        `${where} (campanha "${campaign.name}"): ${brDate(start)} a ${brDate(end)} ${end < start ? "termina antes de começar" : "passa de um ano"}, ignorado.`,
      );
      continue;
    }
    const competence = parseDate(row.competencia);
    let multiplier = parseNumber(row.multiplicador);
    if (
      multiplier == null ||
      Number.isNaN(multiplier) ||
      multiplier <= 0 ||
      multiplier > 100
    ) {
      warn(
        report,
        "M inválido",
        `${where}: multiplicador "${row.multiplicador ?? ""}" inválido, usado 1.`,
      );
      multiplier = 1;
    }
    multiplier = Math.round(multiplier * 1000) / 1000;
    const budget = metric(report, row.valor_midia_ciclo, "verba", where);
    const objectiveOf = (value) =>
      OBJECTIVES[
        oneLine(value)
          .normalize("NFD")
          .replace(/[^A-Za-z]/g, "")
          .toUpperCase()
      ];
    let objective = objectiveOf(row.objetivo);
    // Old cycles have none: the campaign's, or LEAD (the MASO form's default).
    if (!objective && !oneLine(row.objetivo)) {
      objective = objectiveOf(campaign.masoObjective) ?? "lead";
      warn(
        report,
        "objetivo vazio",
        `${where}: sem objetivo no MASO, gravado como ${objective === "lead" && !objectiveOf(campaign.masoObjective) ? "lead (padrão do MASO)" : `${objective} (o da campanha)`}.`,
      );
    }
    if (!objective) {
      objective = "custom";
      warn(
        report,
        "objetivo",
        `${where}: objetivo "${oneLine(row.objetivo)}" desconhecido, gravado como personalizado.`,
      );
    }
    const goalKind = key(row.meta_string);
    const goalValue = parseNumber(row.meta_valor);
    let goal = 0;
    if (goalKind === "3") goal = goalValue > 0 ? Math.round(goalValue) : 0;
    else if ((goalKind === "1" || goalKind === "2") && goalValue > 0) {
      // A cost goal (CPL/CPA): the quantity it implies with the net budget.
      goal = Math.floor(budget / multiplier / goalValue);
      warn(
        report,
        "meta",
        `${where}: meta por custo (${goalKind === "1" ? "CPL" : "CPA"} ${goalValue}) convertida em ${goal} resultados.`,
      );
    } else if (goalKind !== "4" && goalKind !== "") {
      warn(
        report,
        "meta",
        `${where}: tipo de meta "${goalKind}" desconhecido, sem meta.`,
      );
    }
    const capture = cleanText(row.id_capture)
      .split(/[,;]/)
      .map((v) => v.trim())
      .filter(Boolean);
    const pages = unique(
      capture.filter((v) => /^\d+$/.test(v) && v !== "0" && v !== "1"),
    );
    const destination = pages.length
      ? "make_landing_page"
      : capture[0] === "0"
        ? "lead_form"
        : "external_page";
    const nicheId = key(row.id_nichomercado);
    const niche = (
      nicheId && nicheId !== "0" ? (niches.get(nicheId) ?? "") : ""
    ).slice(0, 120);
    const cycle = {
      legacy,
      campaign: campaign.legacy,
      platform: campaign.platform,
      competence: monthStart(competence ?? start),
      start,
      end,
      objective,
      goal,
      budget,
      multiplier,
      destination,
      pages,
      niche,
      links: cycleLinks(row, campaign, where, report),
    };
    cycles.set(legacy, cycle);
    campaign.cycles.push(cycle);
  }

  // Overlaps are allowed by the tables but the app refuses to save them.
  const linkOwners = new Map();
  for (const campaign of accepted.values()) {
    const sorted = [...campaign.cycles].sort((a, b) =>
      a.start < b.start ? -1 : 1,
    );
    for (let i = 1; i < sorted.length; i++)
      if (sorted[i].start <= sorted[i - 1].end)
        warn(
          report,
          "sobreposição",
          `Campanha "${campaign.name}": ciclos ${sorted[i - 1].legacy} e ${sorted[i].legacy} se sobrepõem (importados assim; editar um deles no MAVI vai pedir para corrigir as datas).`,
        );
    for (const cycle of campaign.cycles)
      for (const link of cycle.links) {
        if (!link.external) continue;
        const id = `${campaign.platform}|${link.account}|${link.external}`;
        const owner = linkOwners.get(id);
        if (owner && owner !== campaign.name)
          warn(
            report,
            "vínculo repetido",
            `A campanha ${link.external} da conta ${link.account} está em "${owner}" e em "${campaign.name}" (no MAVI ela pertence a uma só).`,
          );
        else linkOwners.set(id, campaign.name);
      }
  }

  // ---- current cycle (and "active" only with one)
  const currents = [];
  for (const campaign of accepted.values()) {
    const current =
      !isPlaceholder(campaign.currentHash) &&
      campaign.cycles.find((y) => y.legacy === campaign.currentHash);
    if (current)
      currents.push({ campaign: campaign.legacy, cycle: current.legacy });
    else if (!isPlaceholder(campaign.currentHash))
      warn(
        report,
        "ciclo atual",
        `Campanha "${campaign.name}": o ciclo atual ${campaign.currentHash} não foi importado; fica sem ciclo atual.`,
      );
    if (!current && campaign.status === "active") {
      campaign.status = "inactive";
      warn(
        report,
        "ciclo atual",
        `Campanha "${campaign.name}": ativa no MASO mas sem ciclo atual; importada como inativa.`,
      );
    }
  }

  // ---- snapshots (registro tipo 0) and daily rows
  const author = (id) => {
    const user = key(id);
    if (user === MASO_ROBOT) return "MASO · Robô";
    return users.has(user) ? `MASO · ${users.get(user)}`.slice(0, 120) : "MASO";
  };
  // In id order when every row has a numeric id, else in file order.
  const byId = (rows) => {
    const list = rows.map((row, index) => ({
      row,
      index,
      id: parseNumber(row.id ?? row.id_registro),
    }));
    return list.every((r) => Number.isFinite(r.id))
      ? list.sort((a, b) => a.id - b.id || a.index - b.index)
      : list;
  };
  const cycleOf = (row, entity, where) => {
    const cycle = cycles.get(key(row.id_ciclo));
    if (!cycle) {
      skip(
        report,
        entity,
        key(row.id_ciclo) ? "ciclo não importado" : "sem id_ciclo",
      );
      return null;
    }
    const campaign = key(row.id_campanha);
    if (campaign && campaign !== cycle.campaign)
      warn(
        report,
        "campanha divergente",
        `${where}: id_campanha ${campaign} difere da campanha do ciclo ${cycle.legacy}; vale a do ciclo.`,
      );
    return cycle;
  };

  /**
   * Impressions and reach. The MASO's Google cron saved the impressions in
   * `alcance` (Google has no reach) and left `impressao` empty: on Google
   * that number is the impressions, and there is no reach.
   */
  const audience = (report, row, cycle, where) => {
    const impressions = metric(report, row.impressao, "impressões", where, 0);
    const reach = metric(report, row.alcance, "alcance", where, 0);
    return cycle.platform === "google" && !(impressions > 0)
      ? { impressions: reach, reach: 0 }
      : { impressions, reach };
  };

  const snapshots = new Map();
  for (const { row, index } of byId(
    tables.get("maso_acompanhamento_registro") ?? [],
  )) {
    if (key(row.tipo) !== "0") {
      report.notSnapshots++;
      continue;
    }
    const where = `Registro ${key(row.id) || `#${index + 1}`}`;
    const cycle = cycleOf(row, "snapshots", where);
    if (!cycle) continue;
    const takenOn = parseDate(row.data_registro);
    if (!takenOn) {
      skip(report, "snapshots", "sem data do registro");
      continue;
    }
    const periodStart = parseDate(row.ciclo_registro_inicio) ?? cycle.start;
    let periodEnd = parseDate(row.ciclo_registro_fim) ?? periodStart;
    if (periodEnd < periodStart) {
      warn(
        report,
        "período",
        `${where}: fim do período antes do início; usado o início (${brDate(periodStart)}).`,
      );
      periodEnd = periodStart;
    }
    const id = `${cycle.legacy}|${takenOn}`;
    if (snapshots.has(id)) {
      skip(report, "snapshots", "repetido no mesmo dia (mantido o último)");
      warn(
        report,
        "repetido",
        `${where}: ciclo ${cycle.legacy} já tem registro em ${brDate(takenOn)}; mantido o último.`,
      );
    }
    const status = key(row.status);
    snapshots.set(id, {
      cycle: cycle.legacy,
      takenOn,
      periodStart,
      periodEnd,
      spend: metric(report, row.investimento_total, "investimento", where),
      ...audience(report, row, cycle, where),
      clicks: metric(report, row.total_clique, "cliques", where, 0),
      conversions: metric(report, row.conversoes, "conversões", where),
      viewContent: metric(
        report,
        row.conversoes_vis_produto,
        "visualizações de produto",
        where,
      ),
      addToCart: metric(
        report,
        row.conversoes_add_carrinho,
        "adições ao carrinho",
        where,
      ),
      checkout: metric(
        report,
        row.conversoes_finalizacao_compra,
        "finalizações de compra",
        where,
      ),
      goalStatus: status === "1" ? "good" : status === "2" ? "bad" : null,
      author: author(row.id_usuario_maso),
    });
  }

  const daily = new Map();
  for (const { row, index } of byId(
    tables.get("maso_acompanhamento_registro_diario") ?? [],
  )) {
    const where = `Diário ${key(row.id) || `#${index + 1}`}`;
    const cycle = cycleOf(row, "daily", where);
    if (!cycle) continue;
    const day = parseDate(row.data_registro);
    if (!day) {
      skip(report, "daily", "sem data");
      continue;
    }
    if (day < cycle.start || day > cycle.end) {
      skip(report, "daily", "dia fora do período do ciclo");
      continue;
    }
    let multiplier = parseNumber(row.multiplicador);
    if (
      multiplier == null ||
      Number.isNaN(multiplier) ||
      multiplier <= 0 ||
      multiplier > 100
    ) {
      warn(
        report,
        "M inválido",
        `${where}: multiplicador "${row.multiplicador ?? ""}" inválido, usado o do ciclo (${cycle.multiplier}).`,
      );
      multiplier = cycle.multiplier;
    }
    const id = `${cycle.legacy}|${day}`;
    if (daily.has(id)) {
      skip(report, "daily", "dia repetido (mantido o último)");
      warn(
        report,
        "repetido",
        `${where}: ciclo ${cycle.legacy} já tem o dia ${brDate(day)}; mantido o último.`,
      );
    }
    daily.set(id, {
      cycle: cycle.legacy,
      day,
      multiplier: Math.round(multiplier * 1000) / 1000,
      spend: metric(report, row.investimento_total, "investimento", where),
      ...audience(report, row, cycle, where),
      clicks: metric(report, row.total_clique, "cliques", where, 0),
      conversions: metric(report, row.conversoes, "conversões", where),
      viewContent: metric(
        report,
        row.conversoes_vis_produto,
        "visualizações de produto",
        where,
      ),
      addToCart: metric(
        report,
        row.conversoes_add_carrinho,
        "adições ao carrinho",
        where,
      ),
      checkout: metric(
        report,
        row.conversoes_finalizacao_compra,
        "finalizações de compra",
        where,
      ),
    });
  }

  // Clients to create: those of campaigns without a contract in the map.
  // Without an active campaign they end up archived (former clients).
  const created = new Map();
  for (const c of accepted.values()) {
    if (c.contract) continue;
    const entry = created.get(c.client) ?? {
      client: c.client,
      name: c.client.length >= 2 ? c.client : `Cliente ${c.client}`,
      archived: true,
    };
    if (c.status === "active") entry.archived = false;
    created.set(c.client, entry);
  }
  const model = {
    campaigns: [...accepted.values()],
    newClients: [...created.values()],
    newClientsProduct: options.newClients ?? null,
    cycles: [...cycles.values()],
    currents,
    snapshots: [...snapshots.values()],
    daily: [...daily.values()],
    report,
  };
  report.written.campaigns = model.campaigns.length;
  report.written.clients = model.newClients.length;
  report.written.cycles = model.cycles.length;
  report.written.links = model.cycles.reduce((n, y) => n + y.links.length, 0);
  report.written.current = currents.length;
  report.written.snapshots = model.snapshots.length;
  report.written.daily = model.daily.length;
  return model;
}

/**
 * The cycle's platform links: every campaign on each account (as the MASO
 * associated them), or the accounts alone when there are no campaigns.
 */
function cycleLinks(row, campaign, where, report) {
  let accounts;
  let externals;
  let manager = "";
  if (campaign.platform === "google") {
    accounts = csv(row.id_conta_anuncios_google).map((a) =>
      a.replace(/[-\s]/g, ""),
    );
    externals = csv(row.id_campanha_google);
    manager = csv(row.id_mcc_google)[0]?.replace(/\D/g, "") ?? "";
    if (manager.length > 20) manager = "";
  } else if (campaign.platform === "linkedin") {
    accounts = csv(row.id_conta_anuncios_linkedin);
    externals = csv(row.id_campanha_linkedin);
  } else {
    // Meta, Kwai and TikTok share the "facebook" columns.
    accounts = csv(row.id_conta_anuncios_facebook);
    if (campaign.platform === "meta")
      accounts = accounts.map((a) => a.replace(/^act_/i, ""));
    externals = csv(row.id_campanha_facebook);
  }
  const valid = (list, what) =>
    unique(list).filter((v) => {
      if (v.length <= 60) return true;
      skip(report, "links", `${what} com mais de 60 caracteres`);
      warn(
        report,
        "vínculo",
        `${where}: ${what} "${v.slice(0, 30)}…" longo demais, ignorado.`,
      );
      return false;
    });
  accounts = valid(accounts, "conta");
  externals = valid(externals, "campanha da plataforma");
  if (accounts.length === 0) {
    if (externals.length) {
      skip(
        report,
        "links",
        "campanha da plataforma sem conta",
        externals.length,
      );
      warn(
        report,
        "vínculo",
        `${where}: campanhas da plataforma sem conta de anúncio; vínculos ignorados.`,
      );
    }
    return [];
  }
  const ids = externals.length ? externals : [""];
  return accounts.flatMap((account) =>
    ids.map((external) => ({ account, external, manager })),
  );
}

/** One line per client with campaigns, for the user to fill contract_id. */
export function buildTemplate(tables, mapping = new Map()) {
  const report = createReport();
  const clients = new Map();
  for (const c of readCampaigns(tables, report).values()) {
    if (!c.client || c.client === "0") continue;
    const client = clients.get(c.client) ?? { count: 0, example: c.name };
    client.count++;
    clients.set(c.client, client);
  }
  const cell = (v) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [...clients.entries()]
    .sort(([a], [b]) => Number(a) - Number(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map(([client, { count, example }]) =>
      [client, String(count), example, mapping.get(client) ?? ""]
        .map(cell)
        .join(";"),
    );
  return {
    text:
      ["id_cliente;campanhas;exemplo;contract_id", ...lines].join("\n") + "\n",
    clients: clients.size,
    report,
  };
}

// ------------------------------------------------------------------ SQL

/** A SQL string literal (standard_conforming_strings: only ' is special). */
export function sqlString(value) {
  return `'${String(value)
    .replace(/\u0000/g, "")
    .replace(/'/g, "''")}'`;
}
const sqlNullable = (value) => (value == null ? "null" : sqlString(value));
const sqlNumber = (value, decimals) => {
  if (!Number.isFinite(value)) throw new Error(`Número inválido: ${value}`);
  return decimals == null ? String(Math.round(value)) : value.toFixed(decimals);
};
const sqlArray = (list) =>
  sqlString(
    `{${list.map((v) => `"${v.replace(/["\\]/g, "\\$&")}"`).join(",")}}`,
  );

function* batches(list) {
  for (let i = 0; i < list.length; i += BATCH) yield list.slice(i, i + BATCH);
}
const values = (rows) => rows.map((r) => ` (${r.join(", ")})`).join(",\n");

export function renderSql(
  model,
  { company, author, mapping, generatedAt = new Date(), partBytes = 0 },
) {
  const co = sqlString(company);
  const au = sqlString(author);
  const contracts = unique([...mapping.values()]);
  const out = [];
  const w = model.report.written;
  out.push(
    `-- Campanhas: importação do MASO, gerada por scripts/import-maso-campaigns.mjs em ${generatedAt.toISOString()}.`,
    `-- Empresa ${company}, autor ${author}.`,
    `-- ${w.clients ? `${w.clients} clientes a criar (se ainda não existirem), ` : ""}${w.campaigns} campanhas, ${w.cycles} ciclos, ${w.links} vínculos, ${w.daily} registros diários, ${w.snapshots} snapshots.`,
    "-- Rode no SQL editor do Supabase (como postgres). Tudo ou nada, e idempotente: rodar de novo não duplica nada.",
    "begin;",
    "set local statement_timeout = 0;",
    "",
    "do $maso_guard$",
    "begin",
    ` if not exists (select 1 from public.companies where id = ${co}) then`,
    `  raise exception 'Empresa ${company} não encontrada.';`,
    " end if;",
    ` if not exists (select 1 from public.memberships where company_id = ${co} and user_id = ${au} and role = 'admin' and active) then`,
    `  raise exception 'O autor ${author} não é administrador ativo da empresa.';`,
    " end if;",
  );
  if (contracts.length)
    out.push(
      " if exists (select 1 from (values",
      contracts.map((c) => `  (${sqlString(c)}::uuid)`).join(",\n"),
      ` ) m(id) where not exists (select 1 from public.contracts c where c.company_id = ${co} and c.id = m.id)) then`,
      "  raise exception 'Contratos do mapa que não existem nesta empresa: %', (select string_agg(m.id::text, ', ') from (values",
      contracts.map((c) => `   (${sqlString(c)}::uuid)`).join(",\n"),
      `  ) m(id) where not exists (select 1 from public.contracts c where c.company_id = ${co} and c.id = m.id));`,
      " end if;",
    );
  if (model.newClients.length)
    out.push(
      ` if not exists (select 1 from public.products where company_id = ${co} and lower(name) = lower(${sqlString(model.newClientsProduct)})) then`,
      `  raise exception 'Produto ${model.newClientsProduct.replace(/'/g, "''")} não encontrado na empresa: crie-o antes de importar.';`,
      " end if;",
    );
  out.push(
    "end",
    "$maso_guard$;",
    "",
    "-- What this run inserted (links and events only go to new rows, so a re-run",
    "-- does not bring back links removed in the app).",
    "create temp table maso_new_campaigns(id uuid primary key) on commit drop;",
    "create temp table maso_new_cycles(id uuid primary key) on commit drop;",
    "",
  );

  // MASO client → MAVI contract, for the campaigns below.
  out.push(
    "create temp table maso_contracts(id_cliente text primary key, contract_id uuid not null) on commit drop;",
  );
  const mapped = [...mapping.entries()];
  for (const rows of batches(mapped))
    out.push(
      "insert into maso_contracts values",
      values(
        rows.map(([client, contract]) => [
          sqlString(client),
          `${sqlString(contract)}::uuid`,
        ]),
      ),
      "on conflict do nothing;",
    );
  if (model.newClients.length) {
    const product = `(select p.id from public.products p where p.company_id = ${co} and lower(p.name) = lower(${sqlString(model.newClientsProduct)}) order by p.id limit 1)`;
    out.push(
      "",
      `-- Clientes do MASO que ainda não estão no MAVI (pelo nome = id do MASO) e o`,
      `-- produto contratado ${model.newClientsProduct} de cada um. Criados ativos; os sem campanha`,
      "-- ativa são arquivados no fim (o MAVI não aceita produto novo em cliente arquivado).",
      "create temp table maso_new_clients(id_cliente text primary key, name text not null, archived boolean not null) on commit drop;",
    );
    for (const rows of batches(model.newClients))
      out.push(
        "insert into maso_new_clients values",
        values(
          rows.map((c) => [
            sqlString(c.client),
            sqlString(c.name),
            c.archived ? "true" : "false",
          ]),
        ),
        "on conflict do nothing;",
      );
    out.push(
      "create temp table maso_created_clients(id uuid primary key) on commit drop;",
      "with ins as (",
      " insert into public.clients(company_id, name)",
      ` select ${co}::uuid, n.name from maso_new_clients n`,
      ` where not exists (select 1 from public.clients c where c.company_id = ${co} and c.name = n.name)`,
      " returning id",
      ")",
      "insert into maso_created_clients select id from ins;",
      "insert into public.contracts(company_id, client_id, product_id, name)",
      ` select ${co}::uuid, c.id, ${product}, ${sqlString(`${model.newClientsProduct} · `)} || n.name`,
      " from maso_new_clients n",
      ` join lateral (select c.id from public.clients c where c.company_id = ${co} and c.name = n.name order by c.created_at limit 1) c on true`,
      ` where not exists (select 1 from public.contracts k where k.company_id = ${co} and k.client_id = c.id and k.product_id = ${product});`,
      "insert into maso_contracts",
      " select n.id_cliente, k.id from maso_new_clients n",
      ` join lateral (select c.id from public.clients c where c.company_id = ${co} and c.name = n.name order by c.created_at limit 1) c on true`,
      ` join lateral (select k.id from public.contracts k where k.company_id = ${co} and k.client_id = c.id and k.product_id = ${product} order by k.archived, k.created_at limit 1) k on true`,
      "on conflict do nothing;",
      "",
    );
  }

  out.push("-- Campanhas");
  for (const rows of batches(model.campaigns))
    out.push(
      "with v(legacy_id, id_cliente, name, platform, status, briefing_url, media_plan_url, notes) as (values",
      values(
        rows.map((c) => [
          sqlString(c.legacy),
          sqlString(c.client),
          sqlString(c.name),
          sqlString(c.platform),
          sqlString(c.status),
          sqlString(c.briefing),
          sqlString(c.plan),
          sqlString(c.notes),
        ]),
      ),
      "), ins as (",
      " insert into public.ad_campaigns(company_id, contract_id, name, platform, status, briefing_url, media_plan_url, notes, legacy_id, created_by)",
      ` select ${co}::uuid, m.contract_id, v.name, v.platform, v.status, v.briefing_url, v.media_plan_url, v.notes, v.legacy_id, ${au}::uuid`,
      " from v join maso_contracts m on m.id_cliente = v.id_cliente",
      " on conflict (company_id, legacy_id) do nothing returning id",
      ")",
      "insert into maso_new_campaigns select id from ins;",
      "",
    );

  out.push("-- Ciclos");
  for (const rows of batches(model.cycles))
    out.push(
      "with v(campaign, legacy_id, competence, start_date, end_date, objective, goal, budget, multiplier, destination, landing_pages, niche) as (values",
      values(
        rows.map((y) => [
          sqlString(y.campaign),
          sqlString(y.legacy),
          sqlString(y.competence),
          sqlString(y.start),
          sqlString(y.end),
          sqlString(y.objective),
          sqlNumber(y.goal),
          sqlNumber(y.budget, 2),
          sqlNumber(y.multiplier, 3),
          sqlString(y.destination),
          sqlArray(y.pages),
          sqlString(y.niche),
        ]),
      ),
      "), ins as (",
      " insert into public.ad_cycles(company_id, campaign_id, competence_month, start_date, end_date, objective, goal_results, budget, multiplier, destination, landing_pages, niche, legacy_id, created_by)",
      " select a.company_id, a.id, v.competence::date, v.start_date::date, v.end_date::date, v.objective, v.goal, v.budget, v.multiplier, v.destination, v.landing_pages::text[], v.niche, v.legacy_id, " +
        `${au}::uuid`,
      ` from v join public.ad_campaigns a on a.company_id = ${co} and a.legacy_id = v.campaign`,
      " on conflict (company_id, legacy_id) do nothing returning id",
      ")",
      "insert into maso_new_cycles select id from ins;",
      "",
    );

  out.push("-- Vínculos com as plataformas (só dos ciclos inseridos agora)");
  const links = model.cycles.flatMap((y) =>
    y.links.map((l) => ({ ...l, cycle: y.legacy })),
  );
  for (const rows of batches(links))
    out.push(
      "insert into public.ad_cycle_links(company_id, cycle_id, account_id, external_campaign_id, manager_id)",
      "select y.company_id, y.id, v.account_id, v.external_id, v.manager_id from (values",
      values(
        rows.map((l) => [
          sqlString(l.cycle),
          sqlString(l.account),
          sqlString(l.external),
          sqlString(l.manager),
        ]),
      ),
      ") v(cycle, account_id, external_id, manager_id)",
      ` join public.ad_cycles y on y.company_id = ${co} and y.legacy_id = v.cycle`,
      " join maso_new_cycles n on n.id = y.id",
      "on conflict (cycle_id, account_id, external_campaign_id) do nothing;",
      "",
    );

  out.push("-- Ciclo atual (só em campanhas ainda sem um)");
  for (const rows of batches(model.currents))
    out.push(
      "update public.ad_campaigns a set current_cycle_id = y.id from (values",
      values(rows.map((c) => [sqlString(c.campaign), sqlString(c.cycle)])),
      ") v(campaign, cycle)",
      ` join public.ad_cycles y on y.company_id = ${co} and y.legacy_id = v.cycle`,
      `where a.company_id = ${co} and a.legacy_id = v.campaign and y.campaign_id = a.id and a.current_cycle_id is null;`,
      "",
    );

  out.push(
    "-- Histórico: uma entrada 'imported' por campanha inserida agora",
    "insert into public.ad_campaign_events(company_id, campaign_id, actor_id, action, detail)",
    `select a.company_id, a.id, ${au}::uuid, 'imported', jsonb_build_object('legacy_id', a.legacy_id, 'source', 'MASO')`,
    "from public.ad_campaigns a join maso_new_campaigns n on n.id = a.id;",
    "",
  );

  const metrics = (m) => [
    sqlNumber(m.spend, 2),
    sqlNumber(m.impressions),
    sqlNumber(m.reach),
    sqlNumber(m.clicks),
    sqlNumber(m.conversions, 2),
    sqlNumber(m.viewContent, 2),
    sqlNumber(m.addToCart, 2),
    sqlNumber(m.checkout, 2),
  ];
  const metricColumns =
    "spend, impressions, reach, clicks, conversions, view_content, add_to_cart, initiate_checkout";
  const metricSelect =
    "v.spend, v.impressions::bigint, v.reach::bigint, v.clicks::bigint, v.conversions, v.view_content, v.add_to_cart, v.initiate_checkout";

  // The numbers (the bulk of the file), one statement per batch; each
  // stands alone (it finds its cycle by legacy_id), so they can also go in
  // separate files after the first.
  const numbers = [];
  const statement = (...lines) => numbers.push(lines.join("\n"));
  for (const rows of batches(model.snapshots))
    statement(
      "-- Snapshots do ciclo (registro tipo 0)",
      `insert into public.ad_cycle_snapshots(company_id, campaign_id, cycle_id, taken_on, period_start, period_end, ${metricColumns}, goal_status, source, author_label)`,
      `select y.company_id, y.campaign_id, y.id, v.taken_on::date, v.period_start::date, v.period_end::date, ${metricSelect}, v.goal_status::text, 'maso', v.author_label from (values`,
      values(
        rows.map((s) => [
          sqlString(s.cycle),
          sqlString(s.takenOn),
          sqlString(s.periodStart),
          sqlString(s.periodEnd),
          ...metrics(s),
          sqlNullable(s.goalStatus),
          sqlString(s.author),
        ]),
      ),
      `) v(cycle, taken_on, period_start, period_end, ${metricColumns}, goal_status, author_label)`,
      ` join public.ad_cycles y on y.company_id = ${co} and y.legacy_id = v.cycle`,
      "on conflict (company_id, cycle_id, taken_on) do nothing;",
      "",
    );

  for (const rows of batches(model.daily))
    statement(
      "-- Registros diários",
      `insert into public.ad_daily_metrics(company_id, campaign_id, cycle_id, day, multiplier, ${metricColumns}, source)`,
      `select y.company_id, y.campaign_id, y.id, v.day::date, v.multiplier, ${metricSelect}, 'maso' from (values`,
      values(
        rows.map((d) => [
          sqlString(d.cycle),
          sqlString(d.day),
          sqlNumber(d.multiplier, 3),
          ...metrics(d),
        ]),
      ),
      `) v(cycle, day, multiplier, ${metricColumns})`,
      ` join public.ad_cycles y on y.company_id = ${co} and y.legacy_id = v.cycle`,
      "on conflict (company_id, cycle_id, day) do nothing;",
      "",
    );

  if (!partBytes) out.push(...numbers);
  if (model.newClients.length)
    out.push(
      "-- Clientes criados agora sem campanha ativa: arquivados, com o produto contratado.",
      "update public.contracts k set archived = true",
      " from maso_new_clients n join public.clients c on c.name = n.name",
      " join maso_created_clients x on x.id = c.id",
      ` where n.archived and c.company_id = ${co} and k.company_id = ${co} and k.client_id = c.id;`,
      "update public.clients c set archived = true",
      " from maso_new_clients n join maso_created_clients x on true",
      ` where n.archived and x.id = c.id and c.company_id = ${co} and c.name = n.name;`,
      "",
    );
  out.push(
    "commit;",
    "",
    "-- Conferência: o que há do MASO nesta empresa.",
    "select",
    ` (select count(*) from public.ad_campaigns where company_id = ${co} and legacy_id is not null) as campanhas,`,
    ` (select count(*) from public.ad_cycles where company_id = ${co} and legacy_id is not null) as ciclos,`,
    ` (select count(*) from public.ad_daily_metrics where company_id = ${co} and source = 'maso') as registros_diarios,`,
    ` (select count(*) from public.ad_cycle_snapshots where company_id = ${co} and source = 'maso') as snapshots;`,
    "",
  );
  if (!partBytes) return out.join("\n");
  // Split: the first file has the clients, campaigns, cycles and links;
  // the others the numbers, each its own transaction, up to partBytes.
  const parts = [out.join("\n")];
  let current = [];
  let size = 0;
  const flush = () => {
    if (!current.length) return;
    parts.push(current);
    current = [];
    size = 0;
  };
  for (const text of numbers) {
    const bytes = Buffer.byteLength(text);
    if (size && size + bytes > partBytes) flush();
    current.push(text);
    size += bytes;
  }
  flush();
  const total = parts.length;
  return parts.map((part, i) =>
    i === 0
      ? part.replace(
          "begin;",
          `-- Parte 1 de ${total}: rode esta primeiro; depois as demais, em qualquer ordem.\nbegin;`,
        )
      : [
          `-- Campanhas: importação do MASO, parte ${i + 1} de ${total} (números dos ciclos).`,
          "-- Rode depois da parte 1. Idempotente: rodar de novo não duplica nada.",
          "begin;",
          "set local statement_timeout = 0;",
          "",
          ...part,
          "commit;",
          "",
        ].join("\n"),
  );
}

// ------------------------------------------------------------------ CLI

const USAGE = `Uso:
  node scripts/import-maso-campaigns.mjs --input <arquivo.json> [--input outro.json]
    --company <uuid da empresa> --author <uuid do administrador>
    --mapping <mapa.csv> --out <import.sql>
  node scripts/import-maso-campaigns.mjs --input <arquivo.json> --template <mapa.csv> [--mapping <mapa.csv>]

--input     exportação JSON do phpMyAdmin (uma ou mais; tabelas maso_acompanhamento,
            maso_acompanhamento_ciclo, maso_acompanhamento_registro,
            maso_acompanhamento_registro_diario e, opcionais, nichomercado e usuarios_maso)
--mapping   CSV "id_cliente;contract_id" (com cabeçalho) ligando cada cliente do MASO
            a um produto contratado do MAVI
--template  só escreve o modelo do mapa (um cliente por linha) para preencher contract_id
--products  produtos do MASO a importar (id_produto separados por vírgula; ex.: 1,2 = tráfego pago)
--clients   cria os clientes que não estão no mapa (nome = id do MASO) com um produto
            contratado deste produto do MAVI (ex.: "Make Ads"); sem campanha ativa, arquivados
--parts     divide o SQL em arquivos de até N MB (para o SQL editor do Supabase):
            <out>-01.sql com clientes, campanhas e ciclos, e os seguintes com os números
--company   empresa no MAVI; --author: administrador que aparece como autor
--out       arquivo SQL a gerar, para o SQL editor do Supabase`;

const OPTIONS = new Set([
  "input",
  "company",
  "author",
  "mapping",
  "out",
  "template",
  "products",
  "clients",
  "parts",
  "help",
]);

export function parseArgs(argv) {
  const opts = { input: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
      continue;
    }
    const match = arg.match(/^--([a-z]+)(?:=(.*))?$/s);
    if (!match || !OPTIONS.has(match[1]))
      throw new UsageError(`Opção desconhecida: ${arg}`);
    let value = match[2];
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined || value.startsWith("--"))
        throw new UsageError(`Falta o valor de --${match[1]}.`);
    }
    if (match[1] === "input") opts.input.push(value);
    else opts[match[1]] = value;
  }
  return opts;
}

const plural = (n, one, many) =>
  `${n.toLocaleString("pt-BR")} ${n === 1 ? one : many}`;

function printReport(report, log) {
  const entities = [
    ["campaigns", "Campanhas"],
    ["cycles", "Ciclos"],
    ["links", "Vínculos"],
    ["snapshots", "Snapshots"],
    ["daily", "Registros diários"],
  ];
  log(
    "\nResumo (linhas no arquivo SQL; as que já existirem no banco são mantidas):",
  );
  for (const [id, label] of entities) {
    const skipped = [...report.skipped[id].values()].reduce((a, b) => a + b, 0);
    log(
      `  ${label.padEnd(18)} ${String(report.written[id]).padStart(7)} gravados  ${String(skipped).padStart(6)} ignorados`,
    );
    for (const [reason, n] of report.skipped[id]) log(`      - ${n} ${reason}`);
  }
  log(
    `  Ciclo atual definido em ${plural(report.written.current, "campanha", "campanhas")}.`,
  );
  if (report.written.clients)
    log(
      `  ${plural(report.written.clients, "cliente do MASO a criar", "clientes do MASO a criar")} no MAVI (se ainda não existirem).`,
    );
  if (report.notSnapshots)
    log(
      `  ${plural(report.notSnapshots, "registro da linha do tempo não é snapshot", "registros da linha do tempo não são snapshots")} (tipo diferente de 0), fora da importação.`,
    );
  if (report.unmappedClients.size) {
    log(
      `\nClientes sem contrato no mapa (campanhas ignoradas): ${report.unmappedClients.size}`,
    );
    const list = [...report.unmappedClients.entries()];
    for (const [client, { count, example }] of list.slice(
      0,
      MAX_WARNINGS_SHOWN,
    ))
      log(
        `  - cliente ${client}: ${plural(count, "campanha", "campanhas")} (ex.: "${example}")`,
      );
    if (list.length > MAX_WARNINGS_SHOWN)
      log(`  … e mais ${list.length - MAX_WARNINGS_SHOWN} clientes.`);
  }
  for (const note of report.notes) log(`\nObs.: ${note}`);
  if (report.warnings.length) {
    log(`\nAvisos: ${report.warnings.length}`);
    for (const w of report.warnings.slice(0, MAX_WARNINGS_SHOWN))
      log(`  - ${w}`);
    if (report.warnings.length > MAX_WARNINGS_SHOWN) {
      log(`  … e mais ${report.warnings.length - MAX_WARNINGS_SHOWN} avisos.`);
      log(
        `  Por tipo: ${[...report.warningKinds].map(([k, n]) => `${k} ${n}`).join(", ")}.`,
      );
    }
  }
}

export async function main(argv, log = console.log) {
  const opts = parseArgs(argv);
  if (opts.help) {
    log(USAGE);
    return;
  }
  if (opts.input.length === 0)
    throw new UsageError(
      "Informe ao menos um --input com a exportação JSON do MASO.",
    );
  const tables = await readExports(opts.input);
  log(
    `Tabelas lidas: ${[...tables].map(([name, rows]) => `${name} (${rows.length})`).join(", ") || "nenhuma"}.`,
  );

  if (opts.template) {
    const mapping = opts.mapping ? await readMapping(opts.mapping) : new Map();
    const { text, clients } = buildTemplate(tables, mapping);
    await writeFile(opts.template, text, "utf8");
    log(
      `Modelo do mapa gravado em ${resolve(opts.template)}: ${plural(clients, "cliente", "clientes")} com campanhas.`,
    );
    log(
      "Preencha a coluna contract_id com o id do produto contratado no MAVI (deixe vazio para não importar o cliente).",
    );
    return;
  }

  for (const option of ["company", "author", "out"])
    if (!opts[option]) throw new UsageError(`Falta --${option}.`);
  if (!opts.mapping && !opts.clients)
    throw new UsageError(
      "Falta --mapping (ou --clients para criar os clientes).",
    );
  for (const option of ["company", "author"])
    if (!UUID.test(opts[option]))
      throw new UsageError(
        `--${option} precisa ser um uuid (recebido "${opts[option]}").`,
      );
  const company = opts.company.toLowerCase();
  const author = opts.author.toLowerCase();
  const mapping = opts.mapping ? await readMapping(opts.mapping) : new Map();
  if (mapping.size === 0 && !opts.clients)
    throw new UsageError(
      `O mapa ${opts.mapping} não liga nenhum cliente a um contrato.`,
    );
  const products = opts.products
    ? opts.products
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
    : [];
  if (products.some((p) => !/^\d+$/.test(p)))
    throw new UsageError(
      `--products precisa ser uma lista de números (recebido "${opts.products}").`,
    );
  const newClients = opts.clients?.trim() || undefined;

  const model = buildModel(tables, mapping, { products, newClients });
  const partMb = opts.parts ? Number(opts.parts) : 0;
  if (opts.parts && !(partMb > 0))
    throw new UsageError(
      `--parts precisa ser um número de MB (recebido "${opts.parts}").`,
    );
  const sql = renderSql(model, {
    company,
    author,
    mapping,
    partBytes: Math.round(partMb * 1024 * 1024),
  });
  const kb = (text) =>
    `${(Buffer.byteLength(text) / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} KB`;
  printReport(model.report, log);
  if (Array.isArray(sql)) {
    const base = opts.out.replace(/\.sql$/i, "");
    const files = sql.map(
      (_, i) => `${base}-${String(i + 1).padStart(2, "0")}.sql`,
    );
    for (let i = 0; i < sql.length; i++)
      await writeFile(files[i], sql[i], "utf8");
    log(`\nArquivos SQL (${sql.length}):`);
    for (let i = 0; i < sql.length; i++)
      log(`  ${resolve(files[i])} (${kb(sql[i])})`);
    log(
      "Rode no SQL editor do Supabase a parte 1 primeiro e depois as demais. Cada uma é uma transação e pode ser rodada de novo sem duplicar nada.",
    );
    return;
  }
  await writeFile(opts.out, sql, "utf8");
  log(`\nArquivo SQL: ${resolve(opts.out)} (${kb(sql)}).`);
  log(
    "Rode no SQL editor do Supabase. É uma transação só e pode ser rodado de novo sem duplicar nada.",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch((e) => {
    if (e instanceof UsageError) {
      console.error(`Erro: ${e.message}\n\n${USAGE}`);
    } else {
      console.error("Erro inesperado:", e);
    }
    process.exit(1);
  });
}

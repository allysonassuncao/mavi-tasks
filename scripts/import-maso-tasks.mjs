// Tarefas: traz o histórico de tarefas "Entregue" do MASO (maso_runrun) para
// o MAVI, com os comentários (maso_runrun_comentario), os anexos
// (maso_runrun_anexo) e as imagens coladas no texto. Lê os dumps do
// phpMyAdmin e escreve arquivos SQL para o pgAdmin / editor SQL do Supabase
// (rodam como postgres, sem as RPCs; as checagens das tabelas valem):
//
//   node scripts/import-maso-tasks.mjs --dir maso-tarefas \
//     --company <uuid> --author <uuid> --out maso-tarefas-import \
//     [--credentials gcs-credentials.json]
//   node scripts/import-maso-tasks.mjs --send maso-tarefas-import \
//     [--credentials gcs-credentials.json]
//
// A primeira forma só lê (os dumps e a lista de arquivos do bucket) e grava:
//  * 01-conferencia.sql            só leitura: quem vira quem, que clientes
//                                   ficam de fora e por quê;
//  * 02-tarefas.sql                as tarefas (e as imagens das descrições);
//  * 03-comentarios-parte-NN.sql   os comentários, em partes de ~20 MB;
//  * 04-anexos.sql                 os anexos;
//  * arquivos.json + imagens/      o que o --send põe no bucket.
// Os anexos ficam nos arquivos que o MASO já tem no bucket (o registro aponta
// para tasks/<cliente>/<tarefa>/<arquivo>; migração 20270215090000), sem
// duplicar o armazenamento. A segunda forma (--send) envia só o que não está
// lá: as imagens coladas no texto (base64 no dump) e as poucas cópias (HTML,
// um arquivo de dois anexos). Roda antes do 02: um arquivo sem registro não
// aparece em lugar nenhum.
//
// Regras combinadas com o usuário (01/10/2026):
//  * entram as tarefas com status_tarefa = 1 (Entregue), como "Entregue";
//  * o cliente é o do MAVI com o nome igual ao id_cliente do MASO (como nas
//    outras importações) e o produto contratado é o "Make Ads" dele (sem ele,
//    a importação cria um Make Ads arquivado, só para o histórico);
//  * as pessoas pelo e-mail; quem não está no MAVI (inativos, o robô) fica
//    com o --author (Allyson), e o texto ganha "No MASO: Nome";
//  * todos os comentários, os automáticos do MASO também, no horário original;
//  * as tarefas entram na base da MAVI (a fila do RAG, pelos gatilhos).
// Ninguém é avisado: o lote cala os avisos em tempo real (mavi.bulk_tasks),
// a tarefa entra com o responsável como criador (o aviso "passou para você"
// não sai) e só depois recebe o criador do MASO; comentários com menção
// entram com a menção como texto e só depois ganham a menção. Rodar de novo
// não duplica nada: os ids são derivados dos ids do MASO.
import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  UsageError,
  cleanText,
  fixMojibake,
  parseDate,
  parseSqlDump,
  sqlString,
} from "./import-maso-campaigns.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PRODUCT = "Make Ads";
const DELIVERED = "1";
export const PREFIX = "mavi:richtext:v1:";
const DOC_START = `${PREFIX}{"type":"doc","content":[`;
// comments.body aceita até 10 000 caracteres; a folga cobre a nota "No MASO"
// e os ids das menções, que o SQL põe depois.
const COMMENT_BUDGET = 9000;
const INLINE_MAX = 5 * 1024 * 1024;
const INLINE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const ATTACHMENT_MAX = 100 * 1024 * 1024;
const PART_BYTES = 20 * 1024 * 1024;
const BUCKET = "maso_storage_main";
const USAGE = `Uso:
  node scripts/import-maso-tasks.mjs --dir <pasta dos dumps> --company <uuid> \\
    --author <uuid de quem fica no lugar> --out <pasta> [--credentials gcs-credentials.json]
    [--tasks "maso_runrun (2).sql" --comments … --attachments … --users …]  (com mais de uma exportação na pasta)
  node scripts/import-maso-tasks.mjs --send <pasta> [--credentials gcs-credentials.json]`;

// Mesmas listas de src/upload-types.ts (anexos: tudo menos programas).
const CONTENT_TYPES = {
  pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  webp: "image/webp", gif: "image/gif", heic: "image/heic", heif: "image/heif",
  avif: "image/avif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
  txt: "text/plain", md: "text/plain", csv: "text/csv", json: "application/json",
  zip: "application/zip", rar: "application/vnd.rar", "7z": "application/x-7z-compressed",
  gz: "application/gzip", tar: "application/x-tar", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation", rtf: "application/rtf",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg",
  oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", weba: "audio/webm",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  mkv: "video/x-matroska", avi: "video/x-msvideo",
};
const BLOCKED = new Set(("exe msi msp mst bat cmd com scr pif cpl dll sys drv ocx vbs vbe vb js jse wsf " +
  "wsh wsc ws hta ps1 ps1xml ps2 psc1 psc2 psm1 msc msh msh1 msh2 reg inf lnk scf jar jnlp appx appxbundle " +
  "msix msixbundle apk xapk aab ipa app command sh bash csh ksh run bin pkg deb rpm gadget application xbap " +
  "ade adp chm ins isp shb shs sct xll mde mdb accde diagcab").split(" "));
const extension = (name) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};
export const contentType = (name) => CONTENT_TYPES[extension(name)] ?? "application/octet-stream";

/** Um uuid fixo para cada registro do MASO: rodar de novo dá o mesmo id. */
export function legacyUuid(kind, id) {
  const h = crypto.createHash("md5").update(`maso:${kind}:${id}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ------------------------------------------------------------ texto rico

const ENTITIES = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", ordm: "º", ordf: "ª", deg: "°",
  ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", bull: "•" };
const ACCENTS = { acute: "́", grave: "̀", circ: "̂", tilde: "̃", uml: "̈", cedil: "̧" };
function decode(text) {
  return text
    .replace(/&#(\d{1,7});/g, (m, n) => (Number(n) > 0 && Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : m))
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, n) => {
      const code = parseInt(n, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .replace(/&([a-z])(acute|grave|circ|tilde|uml|cedil);/gi, (m, letter, accent) =>
      (letter + ACCENTS[accent.toLowerCase()]).normalize("NFC"))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/ /g, " ");
}
const attr = (attrs, name) => {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? "") : null;
};
const safeHref = (value) => {
  const v = (value ?? "").trim();
  return v && v.length <= 2000 && !/[\s\\]/.test(v) && /^https?:\/\/[^/\s]+/i.test(v) ? v : null;
};
function color(value) {
  const v = (value ?? "").trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return "#" + [...v.slice(1)].map((c) => c + c).join("");
  const rgb = v.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
  return rgb && rgb.slice(1, 4).every((n) => +n <= 255)
    ? "#" + rgb.slice(1, 4).map((n) => (+n).toString(16).padStart(2, "0")).join("")
    : null;
}
const BLOCK_TAGS = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "tr", "section", "article"]);
const SKIP_TAGS = new Set(["script", "style", "head", "title", "select", "option", "textarea"]);

/** Um nó de menção do MAVI com o id do MASO; o SQL troca pelo da pessoa. */
export const mentionNode = (masoId, label) => ({ type: "mention", attrs: { id: `maso-user-${masoId}`, label } });

/**
 * O HTML do MASO (Quill) como os blocos do editor do MAVI (src/rich-text.ts):
 * parágrafos, listas, negrito/itálico/riscado, links, cores, menções e
 * imagens. Títulos viram parágrafo em negrito; tabelas, uma linha por linha
 * com as células separadas por " | ". `image(mime, base64)` decide o que
 * entra no lugar de uma imagem colada (um nó, ou null para nada).
 */
export function htmlToBlocks(html, { people = new Map(), image = () => null } = {}) {
  const source = fixMojibake(String(html ?? ""));
  if (!/<[a-z!/]/i.test(source))
    return tidy(source.split(/\r?\n/).map((line) => para(textNodes(decode(line).replace(/\s+/g, " ").trim(), []))));
  const blocks = [];
  let inline = [];
  let item = null; // o listItem aberto
  let list = null; // a lista aberta (bulletList / orderedList)
  const stack = []; // { tag, marks, mention }
  let skip = 0;
  let mention = null;
  let cellOpen = false;
  const marks = () => {
    const out = [];
    for (const e of stack) for (const m of e.marks) if (!out.some((x) => x.type === m.type)) out.push(m);
    return out;
  };
  const container = () => (item ? item.content : blocks);
  const flush = () => {
    if (inline.length || item) {
      const p = para(inline);
      if (p.content.length || !item) container().push(p);
    }
    inline = [];
  };
  const closeList = () => {
    flush();
    if (item && !item.content.length) item.content.push({ type: "paragraph", content: [] });
    item = null;
    list = null;
  };
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)|</g;
  for (let m; (m = re.exec(source)); ) {
    const [, closing, rawTag, attrs = "", text] = m;
    if (text !== undefined || (m[0] === "<" && !rawTag)) {
      if (skip) continue;
      const t = decode(text ?? "<").replace(/[\r\n\t ]+/g, " ");
      if (mention) {
        mention.text += t;
        continue;
      }
      if (!t.trim() && !inline.length) continue;
      inline.push(...textNodes(t, marks()));
      continue;
    }
    if (!rawTag) continue;
    const tag = rawTag.toLowerCase();
    if (SKIP_TAGS.has(tag)) {
      if (closing) skip = Math.max(0, skip - 1);
      else if (!/\/\s*$/.test(attrs)) skip++;
      continue;
    }
    if (skip) continue;
    if (!closing) {
      if (tag === "br") {
        if (!mention) inline.push({ type: "hardBreak" });
        continue;
      }
      if (tag === "img") {
        const src = attr(attrs, "src") ?? "";
        const data = src.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]*)$/i);
        const node = data ? image(data[1].toLowerCase(), data[2]) : null;
        if (node) inline.push(...(Array.isArray(node) ? node : [node]));
        else if (safeHref(src)) inline.push(...textNodes(src, [{ type: "link", attrs: { href: safeHref(src) } }]));
        continue;
      }
      if (tag === "hr" || tag === "input" || tag === "meta" || tag === "link") continue;
      if (BLOCK_TAGS.has(tag)) {
        flush();
        cellOpen = false;
      }
      if (tag === "ul" || tag === "ol") {
        flush();
        stack.push({ tag, marks: [], listTag: tag });
        continue;
      }
      if (tag === "li") {
        flush();
        const kind = (attr(attrs, "data-list") ?? "") === "bullet" ? "bulletList"
          : (attr(attrs, "data-list") ?? "") === "ordered" ? "orderedList"
          : [...stack].reverse().find((e) => e.listTag)?.listTag === "ul" ? "bulletList" : "orderedList";
        if (!list || list.type !== kind) {
          if (item && !item.content.length) item.content.push({ type: "paragraph", content: [] });
          item = null;
          list = { type: kind, content: [] };
          blocks.push(list);
        }
        item = { type: "listItem", content: [] };
        list.content.push(item);
        stack.push({ tag, marks: [] });
        continue;
      }
      if (tag === "td" || tag === "th") {
        if (cellOpen && inline.length) inline.push(...textNodes(" | ", []));
        cellOpen = true;
      }
      const added = [];
      if (tag === "strong" || tag === "b" || /^h[1-6]$/.test(tag) || tag === "th") added.push({ type: "bold" });
      if (tag === "em" || tag === "i") added.push({ type: "italic" });
      if (tag === "s" || tag === "strike" || tag === "del") added.push({ type: "strike" });
      if (tag === "a") {
        const href = safeHref(attr(attrs, "href"));
        if (href) added.push({ type: "link", attrs: { href } });
      }
      const style = attr(attrs, "style") ?? "";
      const fg = color(style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i)?.[1]);
      const bg = color(style.match(/background(?:-color)?\s*:\s*([^;]+)/i)?.[1]);
      if (fg && fg !== "#000000") added.push({ type: "textStyle", attrs: { color: fg } });
      if (bg && bg !== "#ffffff") added.push({ type: "highlight", attrs: { color: bg } });
      const entry = { tag, marks: added };
      const user = attr(attrs, "data-user-id") ?? attr(attrs, "data-id");
      if (tag === "span" && /ql-mention|mention/.test(attr(attrs, "class") ?? "") && user && !mention) {
        mention = { user: user.trim(), text: "", marks: marks() };
        entry.mention = true;
      }
      if (/\/\s*$/.test(attrs) && tag !== "span") continue;
      stack.push(entry);
      continue;
    }
    // Fechamento: desfaz até a abertura correspondente.
    const at = stack.map((e) => e.tag).lastIndexOf(tag);
    if (at < 0) {
      if (BLOCK_TAGS.has(tag)) flush();
      continue;
    }
    const removed = stack.splice(at);
    if (removed.some((e) => e.mention) && mention) {
      const person = people.get(mention.user);
      const label = person?.name || mention.text.replace(/^@/, "").trim();
      if (person) inline.push(mentionNode(mention.user, person.name));
      else if (label) inline.push(...textNodes(`@${label}`, mention.marks));
      mention = null;
    }
    if (tag === "li") flush();
    else if (tag === "ul" || tag === "ol") {
      if (!stack.some((e) => e.listTag)) closeList();
    } else if (BLOCK_TAGS.has(tag)) {
      flush();
      cellOpen = false;
    }
  }
  closeList();
  flush();
  return tidy(blocks);
}

/** Texto com links nos endereços soltos. */
function textNodes(text, marks) {
  if (!text) return [];
  if (marks.some((m) => m.type === "link")) return [{ type: "text", text, marks }];
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g)) {
    if (m.index > last) out.push({ type: "text", text: text.slice(last, m.index), marks });
    const href = safeHref(m[0]);
    out.push({ type: "text", text: m[0], marks: href ? [...marks, { type: "link", attrs: { href } }] : marks });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last), marks });
  return out;
}
const sameMarks = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function para(inline) {
  const content = [];
  for (const n of inline) {
    const prev = content.at(-1);
    if (n.type === "text" && prev?.type === "text" && sameMarks(prev.marks, n.marks)) prev.text += n.text;
    else content.push(n.type === "text" ? { ...n } : n);
  }
  // Sem quebras nem espaços nas pontas ("<p><br></p>" é uma linha vazia).
  while (content.length && (content[0].type === "hardBreak" || (content[0].type === "text" && !content[0].text.trim()))) content.shift();
  while (content.length && (content.at(-1).type === "hardBreak" || (content.at(-1).type === "text" && !content.at(-1).text.trim()))) content.pop();
  if (content[0]?.type === "text") content[0].text = content[0].text.replace(/^\s+/, "");
  if (content.at(-1)?.type === "text") content.at(-1).text = content.at(-1).text.replace(/\s+$/, "");
  return { type: "paragraph", content };
}
const emptyPara = (b) => b.type === "paragraph" && !b.content.length;
/** No máximo uma linha vazia seguida, e nenhuma nas pontas. */
function tidy(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.content && b.type !== "paragraph" && !b.content.length) continue;
    if (emptyPara(b) && (!out.length || emptyPara(out.at(-1)))) continue;
    out.push(b);
  }
  while (out.length && emptyPara(out.at(-1))) out.pop();
  return out;
}
const p = (text, marks = []) => ({ type: "paragraph", content: text ? [{ type: "text", text, marks }] : [] });
export const serialize = (blocks) => (blocks.length ? PREFIX + JSON.stringify({ type: "doc", content: blocks }) : "");
/** O que o usuário lê, para contar o tamanho e para o plano B. */
function plain(node) {
  if (node.type === "text") return node.text;
  if (node.type === "mention") return `@${node.attrs.label}`;
  if (node.type === "hardBreak") return "\n";
  if (node.type === "inlineImage") return "";
  return (node.content ?? []).map(plain).join(node.type === "paragraph" ? "" : "\n");
}
/** Menções como texto: o comentário entra assim e só depois ganha as menções. */
const withoutMentions = (blocks) =>
  JSON.parse(JSON.stringify(blocks), (k, v) =>
    v && typeof v === "object" && v.type === "mention" ? { type: "text", text: `@${v.attrs.label}`, marks: [] } : v);
const withoutImages = (blocks) =>
  JSON.parse(JSON.stringify(blocks), (k, v) =>
    Array.isArray(v) ? v.filter((n) => !(n && typeof n === "object" && n.type === "inlineImage")) : v);
const hasType = (blocks, type) => JSON.stringify(blocks).includes(`"type":"${type}"`);

/**
 * Os blocos de um comentário em pedaços que cabem em comments.body: um
 * comentário longo vira vários, em sequência; um bloco grande demais sozinho
 * vira texto simples em parágrafos.
 */
export function splitBlocks(blocks, budget = COMMENT_BUDGET) {
  const parts = [];
  let current = [];
  const size = (list) => serialize(list).length;
  const pieces = [];
  for (const b of blocks) {
    if (size([b]) <= budget) {
      pieces.push(b);
      continue;
    }
    if (b.content && b.type !== "paragraph") {
      // Uma lista: item a item.
      for (const it of b.content) {
        const one = { type: b.type, content: [it] };
        if (size([one]) <= budget) pieces.push(one);
        else pieces.push(...chunkText(plain(it), budget));
      }
    } else pieces.push(...chunkText(plain(b), budget));
  }
  for (const b of pieces) {
    if (current.length && size([...current, b]) > budget) {
      parts.push(current);
      current = [];
    }
    current.push(b);
  }
  if (current.length) parts.push(current);
  return parts;
}
function chunkText(text, budget) {
  const max = Math.floor(budget / 2.5);
  const out = [];
  for (let i = 0; i < text.length; i += max) out.push(p(text.slice(i, i + max)));
  return out;
}

// ------------------------------------------------------------ modelo

/** Nome do anexo como foi enviado: "1_02png-1767362554.png" → "1_02.png". */
export function originalName(name) {
  const clean = cleanText(name);
  const ext = extension(clean);
  const m = /^[a-z0-9]{1,5}$/.test(ext) && clean.match(new RegExp(`^(.+)${ext}-\\d{9,11}\\.${ext}$`, "i"));
  if (m) return `${m[1].replace(/[_\s]+$/, "") || "arquivo"}.${ext}`;
  return clean.replace(/-\d{9,11}(\.[a-z0-9]{2,5})$/i, "$1") || "arquivo";
}
const localTime = (date, time) => `${date} ${/^\d{1,2}:\d{2}(:\d{2})?$/.test(cleanText(time)) ? cleanText(time) : "12:00:00"}`;
const validId = (v) => {
  const s = cleanText(v);
  return s && s !== "0" ? s : null;
};

/**
 * Do dump ao que vai para o banco. `objects` é a lista do bucket (nome →
 * { size, contentType }); `company` e `author` montam os caminhos dos
 * arquivos (anexos: empresa/tarefa/id; imagens: empresa/quem enviou/id).
 */
export function buildModel({ tasks: taskRows, comments: commentRows, attachments: attachmentRows, users }, { company, author, objects, today }) {
  const skipped = {};
  const skip = (why, n = 1) => (skipped[why] = (skipped[why] ?? 0) + n);
  const people = new Map();
  for (const u of users) {
    const id = cleanText(u.id);
    people.set(id, {
      id,
      name: cleanText(u.nome).replace(/\s+/g, " ") || `Pessoa ${id} do MASO`,
      email: cleanText(u.email).toLowerCase(),
    });
  }
  const files = []; // o que o --send põe no bucket
  const images = []; // inline_images
  const extraAttachments = []; // imagens grandes demais para o texto
  const blobs = new Map(); // id → bytes das imagens coladas
  const imageCount = new Map(); // por tarefa ou comentário: ids estáveis
  // Uma imagem colada: no texto (até 5 MB, PNG/JPG/WebP) ou como anexo.
  const imageFor = (task, owner) => (mime, base64) => {
    const bytes = Buffer.from(base64.replace(/\s+/g, ""), "base64");
    if (!bytes.length) return null;
    const n = (imageCount.get(owner) ?? 0) + 1;
    imageCount.set(owner, n);
    const ext = INLINE_TYPES[mime] ?? (mime.split("/")[1] || "img").replace(/[^a-z0-9]/g, "").slice(0, 5);
    const id = legacyUuid(`image:${owner}`, n);
    blobs.set(id, bytes);
    if (INLINE_TYPES[mime] && bytes.length <= INLINE_MAX) {
      const name = `imagem-${n}.${ext}`;
      images.push({ id, task, owner, name, path: `${company}/${author}/${id}`, size: bytes.length });
      files.push({ path: `${company}/${author}/${id}`, local: `imagens/${id}`, contentType: mime });
      return { type: "inlineImage", attrs: { imageId: id, alt: name } };
    }
    const name = `imagem-colada-${n}.${ext}`;
    extraAttachments.push({ id, task, owner, name, path: `${company}/${task}/${id}`, size: bytes.length });
    files.push({ path: `${company}/${task}/${id}`, local: `imagens/${id}`, contentType: contentType(name) });
    return { type: "text", text: `[imagem nos anexos: ${name}]`, marks: [{ type: "italic" }] };
  };

  const delivered = taskRows.filter((r) => cleanText(r.status_tarefa) === DELIVERED);
  skip("status diferente de Entregue", taskRows.length - delivered.length);
  const byMaso = new Map(delivered.map((r) => [cleanText(r.id_tarefa), r]));
  // Comentários por tarefa, em ordem: dão o horário da entrega.
  const commentsOf = new Map();
  for (const c of commentRows) {
    const key = cleanText(c.id_tarefa);
    if (!byMaso.has(key)) continue;
    const date = parseDate(c.data_criacao);
    if (!date) {
      skip("comentário sem data");
      continue;
    }
    (commentsOf.get(key) ?? commentsOf.set(key, []).get(key)).push({ ...c, at: localTime(date, c.hora_criacao) });
  }
  for (const list of commentsOf.values()) list.sort((a, b) => a.at.localeCompare(b.at) || Number(a.id) - Number(b.id));

  const tasks = [];
  for (const r of delivered) {
    const masoId = cleanText(r.id_tarefa);
    const id = legacyUuid("task", masoId);
    const created = parseDate(r.data_criacao);
    if (!created) {
      skip("tarefa sem data de criação");
      continue;
    }
    const createdAt = localTime(created, r.hora_criacao);
    const notes = commentsOf.get(masoId) ?? [];
    let deliveredOn = parseDate(r.data_entrega_real);
    if (!deliveredOn || deliveredOn > today || deliveredOn < created)
      deliveredOn = [notes.at(-1)?.at.slice(0, 10), parseDate(r.data_entrega_interno), created]
        .find((d) => d && d >= created && d <= today) ?? created;
    // A entrega: o último comentário do dia da entrega, ou o fim da tarde.
    const sameDay = notes.filter((c) => c.at.startsWith(deliveredOn)).at(-1)?.at;
    let deliveredAt = sameDay ?? `${deliveredOn} 18:00:00`;
    if (deliveredAt < createdAt) deliveredAt = createdAt;
    const due = parseDate(r.data_entrega_interno) ?? deliveredOn;
    // A descrição, com os campos do pedido (configuracao_adicional) no fim.
    let blocks = htmlToBlocks(r.descricao, { people, image: imageFor(id, `task:${masoId}`) });
    const extra = [];
    try {
      const cfg = JSON.parse(cleanText(r.configuracao_adicional) || "{}");
      for (const [k, v] of Object.entries(cfg ?? {})) {
        if (k === "htmlcompleto" || !v || typeof v !== "object") continue;
        const value = Array.isArray(v.value) ? v.value.join(", ") : cleanText(v.value);
        if (!value) continue;
        const label = cleanText(v.label).replace(/\s*\*\s*$/, "") || k;
        extra.push({ type: "listItem", content: [para([{ type: "text", text: `${label}: `, marks: [{ type: "bold" }] }, ...textNodes(value, [])])] });
      }
    } catch {
      skip("campos adicionais ilegíveis (a tarefa entra sem eles)");
    }
    if (extra.length) blocks = [...blocks, ...(blocks.length ? [p("")] : []), p("Campos do pedido", [{ type: "bold" }]), { type: "bulletList", content: extra }];
    let title = cleanText(r.titulo).replace(/\s+/g, " ").slice(0, 240);
    if (title.length < 2) title = "Tarefa do MASO";
    const supabase = cleanText(r.supabase_task_id);
    const hasImages = hasType(blocks, "inlineImage");
    tasks.push({
      id,
      maso_id: masoId,
      parent: validId(r.id_tarefa_pai),
      client: cleanText(r.id_cliente),
      supabase: UUID.test(supabase) ? supabase.toLowerCase() : null,
      title,
      creator: validId(r.id_usuario_criador),
      assignee: validId(String(r.id_usuario_responsavel ?? "").split(",")[0]),
      description: serialize(blocks),
      // Sem as imagens: a tarefa entra assim e as ganha depois do registro delas.
      first_description: hasImages ? serialize(withoutImages(blocks)) : null,
      created_at: createdAt,
      delivered_at: deliveredAt,
      due,
    });
  }
  const taskIds = new Map(tasks.map((t) => [t.maso_id, t.id]));

  const comments = [];
  for (const [masoTask, list] of commentsOf) {
    const task = taskIds.get(masoTask);
    if (!task) continue;
    for (const c of list) {
      const owner = `comment:${cleanText(c.id)}`;
      const blocks = htmlToBlocks(c.comentario, { people, image: imageFor(task, owner) });
      if (!blocks.length) {
        skip("comentário vazio");
        continue;
      }
      const parts = splitBlocks(blocks);
      if (parts.length > 1) skip("comentário longo dividido em mais de um", parts.length - 1);
      parts.forEach((part, i) => {
        const mentions = hasType(part, "mention");
        comments.push({
          id: legacyUuid("comment", parts.length > 1 ? `${cleanText(c.id)}:${i}` : cleanText(c.id)),
          task,
          author: validId(c.id_usuario_maso),
          body: serialize(part),
          first_body: mentions ? serialize(withoutMentions(part)) : null,
          // Os pedaços seguem a ordem, um milissegundo depois do outro.
          created_at: i ? `${c.at}.${String(i).padStart(3, "0")}` : c.at,
          owner,
        });
      });
    }
  }

  const attachments = [];
  const usedSources = new Set();
  const objectFor = (r) => {
    const t = byMaso.get(cleanText(r.id_tarefa));
    const raw = String(r.arquivo ?? "");
    const names = [...new Set([raw, fixMojibake(raw), cleanText(raw)].flatMap((n) => [n, n.normalize("NFC"), n.normalize("NFD")]))];
    for (const n of names) {
      const key = `tasks/${cleanText(t.id_cliente)}/${cleanText(r.id_tarefa)}/${n}`;
      if (objects.has(key)) return key;
    }
    for (const n of names) {
      const key = objects.byTask?.get(`${cleanText(r.id_tarefa)}/${n}`);
      if (key) return key;
    }
    return null;
  };
  for (const r of attachmentRows) {
    const masoTask = cleanText(r.id_tarefa);
    const task = taskIds.get(masoTask);
    if (!task) continue;
    if (cleanText(r.ativo) !== "1") {
      skip("anexo excluído no MASO");
      continue;
    }
    const name = originalName(fixMojibake(String(r.arquivo ?? "")));
    if (BLOCKED.has(extension(name))) {
      skip("anexo de programa (bloqueado no MAVI)");
      continue;
    }
    const source = objectFor(r);
    if (!source) {
      skip("anexo sem o arquivo no bucket");
      continue;
    }
    const size = Number(objects.get(source).size);
    if (!(size >= 1 && size <= ATTACHMENT_MAX)) {
      skip("anexo vazio ou maior que 100 MB");
      continue;
    }
    const id = legacyUuid("attachment", cleanText(r.id));
    const date = parseDate(r.data_criacao);
    // O arquivo fica onde o MASO o guardou (migração 20270215090000), sem
    // cópia. Copiados só: tipos que o MAVI serve como download (HTML, SVG…:
    // no lugar, o navegador os abriria) e um arquivo que outro anexo já usa
    // (o caminho é único).
    const inPlace = CONTENT_TYPES[extension(name)] && !usedSources.has(source);
    usedSources.add(source);
    const path = inPlace ? source : `${company}/${task}/${id}`;
    attachments.push({
      id,
      task,
      author: validId(r.id_usuario_maso),
      name: name.slice(0, 240),
      path,
      size,
      created_at: date ? localTime(date, r.hora_criacao) : null,
    });
    if (!inPlace) files.push({ path, source, contentType: contentType(name) });
  }
  // As imagens coladas que não cabem no texto viram anexos da tarefa.
  const commentAt = new Map(comments.map((c) => [c.owner, c.created_at]));
  const taskAt = new Map(tasks.map((t) => [`task:${t.maso_id}`, t.created_at]));
  for (const a of extraAttachments)
    attachments.push({
      id: a.id,
      task: a.task,
      author: null,
      owner: a.owner,
      name: a.name,
      path: a.path,
      size: a.size,
      created_at: commentAt.get(a.owner) ?? taskAt.get(a.owner) ?? null,
    });
  for (const i of images) i.created_at = commentAt.get(i.owner) ?? taskAt.get(i.owner) ?? null;
  return { people: [...people.values()], tasks, comments, attachments, images, files, blobs, skipped };
}

// ------------------------------------------------------------ SQL

const sqlNullable = (v) => (v == null ? "null" : sqlString(v));
function values(table, columns, rows, row, batch) {
  const out = [];
  for (let i = 0; i < rows.length; i += batch)
    out.push(`insert into ${table}(${columns}) values\n${rows.slice(i, i + batch).map(row).join(",\n")};`);
  return out.join("\n");
}
const peopleSql = (people) => [
  "drop table if exists maso_pessoa;",
  "create temp table maso_pessoa(id text primary key, nome text not null, email text not null);",
  values("maso_pessoa", "id, nome, email", people, (u) => `(${sqlString(u.id)},${sqlString(u.name)},${sqlString(u.email)})`, 500),
].join("\n");

/** Quem é quem no MAVI (pelo e-mail) e a empresa; igual em todos os arquivos. */
const matchSql = (c, a) => `
drop table if exists maso_quem;
create temp table maso_quem as
 select p.id, p.nome, (select m.user_id from public.memberships m left join auth.users u on u.id = m.user_id
   where m.company_id = ${c} and p.email <> ''
    and lower(btrim(coalesce(nullif(m.email, ''), u.email, ''))) = p.email
   order by m.active desc, m.user_id limit 1) as user_id
 from maso_pessoa p;
drop table if exists maso_fuso;
create temp table maso_fuso as
 select coalesce((select timezone from public.companies where id = ${c}), 'America/Sao_Paulo') as tz;

do $$ begin
  if not exists (select 1 from public.companies where id = ${c}) then
    raise exception 'A empresa % não existe no MAVI.', ${c};
  end if;
  if not exists (select 1 from public.products where company_id = ${c} and lower(btrim(name)) = lower(${sqlString(PRODUCT)})) then
    raise exception 'A empresa não tem o produto ${PRODUCT}.';
  end if;
  if not exists (select 1 from public.memberships where company_id = ${c} and user_id = ${a} and active) then
    raise exception 'Quem fica no lugar (%) não é uma pessoa ativa da empresa.', ${a};
  end if;
end $$;`;

/** Troca as menções do MASO pela pessoa do MAVI (ou por texto) e põe a nota. */
const mentionSql = (table, column) => `
do $$ declare q record; begin
  for q in select * from maso_quem loop
    update ${table} set ${column} = replace(${column},
      '{"type":"mention","attrs":{"id":"maso-user-' || q.id || '","label":' || to_json(q.nome)::text || '}}',
      case when q.user_id is not null
       then '{"type":"mention","attrs":{"id":"' || q.user_id || '","label":' || to_json(q.nome)::text || '}}'
       else '{"type":"text","text":' || to_json('@' || q.nome)::text || ',"marks":[]}' end)
    where ${column} like '%"maso-user-' || q.id || '"%';
  end loop;
end $$;`;
const notePara = (textSql) =>
  `'{"type":"paragraph","content":[{"type":"text","text":' || to_json(${textSql})::text || ',"marks":[{"type":"italic"}]}]}'`;
/** Põe um parágrafo no começo de um texto rico (ou cria o texto). */
const prependSql = (column, noteSql) =>
  `case when ${column} = '' then ${sqlString(DOC_START)} || ${noteSql} || ']}'
   else ${sqlString(DOC_START)} || ${noteSql} || ',' || substr(${column}, ${DOC_START.length + 1}) end`;

const HEADER = (title, model) => [
  `-- Tarefas: ${title} do histórico do MASO (maso_runrun, status Entregue).`,
  "-- Gerado por scripts/import-maso-tasks.mjs. Roda como postgres (pgAdmin ou editor SQL do Supabase).",
  `-- Ordem: 01-conferencia → node scripts/import-maso-tasks.mjs --send → 02-tarefas → 03-comentarios-parte-NN → 04-anexos.`,
  "-- Idempotente: rodar de novo não duplica nada (os ids vêm dos ids do MASO).",
  `-- No arquivo: ${model.tasks.length} tarefas, ${model.comments.length} comentários, ${model.attachments.length} anexos, ${model.images.length} imagens no texto.`,
  "",
];

function contractSql(c) {
  return `
drop table if exists maso_contrato;
create temp table maso_contrato as
 with clientes as (select distinct cliente from maso_tarefa),
 achados as (
  select k.cliente, count(cl.id) as n_clientes, min(cl.id::text)::uuid as client_id, bool_or(cl.archived) as arquivado
  from clientes k left join public.clients cl on cl.company_id = ${c} and btrim(cl.name) = k.cliente
  group by k.cliente
 )
 select a.cliente, a.client_id, coalesce(a.arquivado, false) as arquivado,
  case when a.n_clientes = 1 then (select k.id from public.contracts k
    join public.products p on p.company_id = k.company_id and p.id = k.product_id
    where k.company_id = ${c} and k.client_id = a.client_id and lower(btrim(p.name)) = lower(${sqlString(PRODUCT)})
    order by k.archived, k.created_at, k.id limit 1) end as contract_id,
  a.n_clientes
 from achados a;
alter table maso_contrato add problema text, add cria_contrato boolean not null default false;
-- Sem o ${PRODUCT}: a importação cria um, arquivado (só guarda o histórico).
update maso_contrato set problema = case when n_clientes = 0 then 'sem cliente com esse nome no MAVI'
  when n_clientes > 1 then 'mais de um cliente com esse nome no MAVI' end,
 cria_contrato = (n_clientes = 1 and contract_id is null);`;
}

const taskStage = (tasks, withText) => [
  "drop table if exists maso_tarefa;",
  "create temp table maso_tarefa(id uuid primary key, maso_id text not null, pai text, cliente text not null, supabase_id uuid," +
    " titulo text not null, criador text, responsavel text, descricao text not null, descricao_inicial text," +
    " criada timestamp not null, entregue timestamp not null, prazo date not null);",
  values(
    "maso_tarefa",
    "id, maso_id, pai, cliente, supabase_id, titulo, criador, responsavel, descricao, descricao_inicial, criada, entregue, prazo",
    tasks,
    (t) =>
      `('${t.id}',${sqlString(t.maso_id)},${sqlNullable(t.parent)},${sqlString(t.client)},${sqlNullable(t.supabase)},` +
      `${sqlString(t.title)},${sqlNullable(t.creator)},${sqlNullable(t.assignee)},` +
      `${withText ? sqlString(t.description) : "''"},${withText ? sqlNullable(t.first_description) : "null"},` +
      `'${t.created_at}','${t.delivered_at}','${t.due}')`,
    withText ? 200 : 1000,
  ),
].join("\n");
const imageStage = (images) => [
  "drop table if exists maso_imagem;",
  "create temp table maso_imagem(id uuid primary key, tarefa uuid not null, nome text not null, path text not null, tamanho bigint not null, criada timestamp);",
  values("maso_imagem", "id, tarefa, nome, path, tamanho, criada", images,
    (i) => `('${i.id}','${i.task}',${sqlString(i.name)},${sqlString(i.path)},${i.size},${sqlNullable(i.created_at)})`, 500),
].join("\n");
const imageInsert = (c, a) => `
insert into public.inline_images(id, company_id, task_id, uploaded_by, name, path, size_bytes, created_at)
 select i.id, ${c}, i.tarefa, ${a}, i.nome, i.path, i.tamanho, coalesce(i.criada at time zone (select tz from maso_fuso), now())
 from maso_imagem i where exists (select 1 from public.tasks t where t.company_id = ${c} and t.id = i.tarefa)
 on conflict (id) do nothing;`;

export function renderPreview(model, { company, author }) {
  const c = sqlString(company);
  const a = sqlString(author);
  return [
    ...HEADER("CONFERÊNCIA (não muda nada)", model),
    peopleSql(model.people),
    taskStage(model.tasks, false),
    matchSql(c, a),
    contractSql(c),
    "",
    // O pgAdmin ("Execute script") mostra só o resultado da última consulta:
    // a conferência inteira sai numa tabela só, uma linha por item.
    "-- O resultado: uma tabela, em quatro partes (coluna parte).",
    "--  1. Quem fica no lugar de quem não está no MAVI.",
    "--  2. Cada pessoa do MASO nestas tarefas e quem ela é no MAVI (vazio = fica com a pessoa da parte 1, com a nota \"No MASO\").",
    "--  3. Clientes: \"entram\" = no Make Ads do cliente (ou num criado, arquivado); \"de fora\" = o motivo e os ids do MASO.",
    "--  4. Tarefas que já estão no MAVI: ficam como estão.",
    "select parte, item, resultado, tarefas, detalhe from (",
    ` select 1 as ordem, '1. Quem fica no lugar' as parte, m.name as item, coalesce(nullif(m.email, ''), u.email) as resultado,`,
    "  null::bigint as tarefas, null::text as detalhe",
    ` from public.memberships m left join auth.users u on u.id = m.user_id where m.company_id = ${c} and m.user_id = ${a}`,
    " union all",
    " select 2, '2. Pessoas do MASO', q.nome, coalesce(m.name, '(não está no MAVI: fica com a pessoa da parte 1)'),",
    "  (select count(*) from maso_tarefa t where t.criador = q.id or t.responsavel = q.id), nullif(p.email, '')",
    ` from maso_quem q join maso_pessoa p on p.id = q.id left join public.memberships m on m.company_id = ${c} and m.user_id = q.user_id`,
    " where exists (select 1 from maso_tarefa t where t.criador = q.id or t.responsavel = q.id)",
    " union all",
    " select 3, '3. Clientes', coalesce('de fora: ' || k.problema, case when k.cria_contrato",
    "   then 'entram num Make Ads arquivado, criado pela importação' else 'entram no Make Ads do cliente' end),",
    "  count(distinct k.cliente) || case when count(distinct k.cliente) = 1 then ' cliente' else ' clientes' end",
    "   || case when count(t.id) filter (where k.arquivado) > 0 then ' (' || count(distinct k.cliente) filter (where k.arquivado)",
    "    || case when count(distinct k.cliente) filter (where k.arquivado) = 1 then ' arquivado, que continua arquivado)'",
    "     else ' arquivados, que continuam arquivados)' end else '' end,",
    "  count(t.id), string_agg(distinct k.cliente, ', ' order by k.cliente) filter (where k.problema is not null)",
    " from maso_tarefa t join maso_contrato k on k.cliente = t.cliente group by k.problema, k.cria_contrato",
    " union all",
    " select 4, '4. Já no MAVI', 'importadas antes por este script', null,",
    "  count(*) filter (where exists (select 1 from public.tasks x where x.id = t.id)), null from maso_tarefa t",
    " union all",
    " select 4, '4. Já no MAVI', 'pelo supabase_task_id do MASO', null,",
    "  count(*) filter (where exists (select 1 from public.tasks x where x.id = t.supabase_id)), null from maso_tarefa t",
    ") r order by ordem, (resultado like '(não está%') desc, item;",
    "",
  ].join("\n");
}

export function renderTasks(model, { company, author }) {
  const c = sqlString(company);
  const a = sqlString(author);
  return [
    ...HEADER("IMPORTAÇÃO DAS TAREFAS", model),
    peopleSql(model.people),
    taskStage(model.tasks, true),
    imageStage(model.images.filter((i) => i.owner.startsWith("task:"))),
    matchSql(c, a),
    contractSql(c),
    `
begin;
set local statement_timeout = 0;
-- Sem avisos em tempo real nem de status: é um lote.
set local mavi.bulk_tasks = '1';

-- Clientes arquivados (ex-clientes) recebem o histórico: desarquivados só
-- dentro desta transação.
drop table if exists maso_desarquivado;
create temp table maso_desarquivado as
 select distinct client_id from maso_contrato where arquivado and n_clientes = 1;
update public.clients set archived = false where company_id = ${c} and id in (select client_id from maso_desarquivado);
-- Sem o ${PRODUCT}: um produto contratado ${PRODUCT} arquivado, só para o histórico.
with novos as (
 insert into public.contracts(company_id, client_id, product_id, name, archived)
 select ${c}, k.client_id, (select p.id from public.products p where p.company_id = ${c}
   and lower(btrim(p.name)) = lower(${sqlString(PRODUCT)}) order by p.id limit 1), ${sqlString(PRODUCT)}, true
 from maso_contrato k where k.cria_contrato
 returning client_id, id
)
update maso_contrato k set contract_id = n.id from novos n where k.client_id = n.client_id;

drop table if exists maso_nova;
create temp table maso_nova as
 select t.*, k.contract_id, k.arquivado, k.client_id,
  coalesce(qc.user_id, ${a}) as criador_id, coalesce(qr.user_id, ${a}) as responsavel_id,
  case when qc.user_id is null and t.criador is not null then qc.nome end as criador_fora,
  case when qr.user_id is null and t.responsavel is not null then qr.nome end as responsavel_fora,
  null::uuid as pai_id
 from maso_tarefa t
 join maso_contrato k on k.cliente = t.cliente and k.contract_id is not null
 left join maso_quem qc on qc.id = t.criador
 left join maso_quem qr on qr.id = t.responsavel
 where not exists (select 1 from public.tasks x where x.id = t.id)
  and (t.supabase_id is null or not exists (select 1 from public.tasks x where x.id = t.supabase_id));
${mentionSql("maso_nova", "descricao")}
${mentionSql("maso_nova", "descricao_inicial")}
-- Quem não está no MAVI: a nota no começo da descrição.
update maso_nova set
 descricao = ${prependSql("descricao", notePara("nota"))},
 descricao_inicial = case when descricao_inicial is null then null else ${prependSql("descricao_inicial", notePara("nota"))} end
from (select id as nid, 'No MASO: ' || concat_ws(' · ',
  case when criador_fora is not null then 'criada por ' || criador_fora end,
  case when responsavel_fora is not null then 'responsável ' || responsavel_fora end) as nota
 from maso_nova where criador_fora is not null or responsavel_fora is not null) n
where id = n.nid;
-- A principal: a do MASO, no mesmo produto contratado (importada agora, antes,
-- ou já no MAVI pelo supabase_task_id).
update maso_nova n set pai_id = (
 select x.id from maso_tarefa p join public.tasks x on x.company_id = ${c} and x.id in (p.id, p.supabase_id)
 where p.maso_id = n.pai and x.contract_id = n.contract_id limit 1)
where n.pai is not null;
update maso_nova n set pai_id = p.id from maso_nova p
where n.pai is not null and n.pai_id is null and p.maso_id = n.pai and p.contract_id = n.contract_id and p.id <> n.id;

-- Entram com o responsável como criador (o aviso "passou para você" não sai) e
-- sem as imagens; as principais antes das subtarefas.
insert into public.tasks(id, company_id, contract_id, parent_id, title, description, status, priority,
  creator_id, assignee_id, due_date, original_due_date, internal_approved_by, delivered_at, created_at,
  status_changed_at, participant_ids, executor_id, executor_ids, due_manual)
 select n.id, ${c}, n.contract_id, n.pai_id, n.titulo, coalesce(n.descricao_inicial, n.descricao), 'done', 'normal',
  n.responsavel_id, n.responsavel_id, n.prazo, n.prazo, n.criador_id,
  n.entregue at time zone (select tz from maso_fuso), n.criada at time zone (select tz from maso_fuso),
  n.entregue at time zone (select tz from maso_fuso),
  array(select distinct u from unnest(array[n.criador_id, n.responsavel_id]) u), n.responsavel_id, array[n.responsavel_id], true
 from maso_nova n where n.pai_id is null or exists (select 1 from public.tasks x where x.id = n.pai_id)
 order by n.criada, n.id;
insert into public.tasks(id, company_id, contract_id, parent_id, title, description, status, priority,
  creator_id, assignee_id, due_date, original_due_date, internal_approved_by, delivered_at, created_at,
  status_changed_at, participant_ids, executor_id, executor_ids, due_manual)
 select n.id, ${c}, n.contract_id, n.pai_id, n.titulo, coalesce(n.descricao_inicial, n.descricao), 'done', 'normal',
  n.responsavel_id, n.responsavel_id, n.prazo, n.prazo, n.criador_id,
  n.entregue at time zone (select tz from maso_fuso), n.criada at time zone (select tz from maso_fuso),
  n.entregue at time zone (select tz from maso_fuso),
  array(select distinct u from unnest(array[n.criador_id, n.responsavel_id]) u), n.responsavel_id, array[n.responsavel_id], true
 from maso_nova n where not exists (select 1 from public.tasks x where x.id = n.id)
 order by n.criada, n.id;
${imageInsert(c, a)}
-- Agora o criador do MASO e a descrição com as imagens.
update public.tasks t set creator_id = n.criador_id, description = n.descricao
from maso_nova n where t.id = n.id and (t.creator_id, t.description) is distinct from (n.criador_id, n.descricao);
insert into public.task_participants(company_id, task_id, user_id, added_at)
 select ${c}, n.id, u, n.criada at time zone (select tz from maso_fuso)
 from maso_nova n cross join lateral unnest(array[n.criador_id, n.responsavel_id]) u
 on conflict do nothing;

update public.clients set archived = true where company_id = ${c} and id in (select client_id from maso_desarquivado);
commit;

-- Resultado (uma tabela só: o pgAdmin mostra apenas o último resultado).
select item, tarefas, ids_do_maso from (
 select 1 as ordem, 'importadas agora' as item, (select count(*) from maso_nova) as tarefas, null::text as ids_do_maso
 union all
 select 2, 'do MASO já no MAVI (agora ou antes)', count(*), null from maso_tarefa t
  where exists (select 1 from public.tasks x where x.id = t.id)
 union all
 select 3, 'já estavam no MAVI pelo supabase_task_id', count(*), null from maso_tarefa t
  where t.supabase_id is not null and exists (select 1 from public.tasks x where x.id = t.supabase_id)
 union all
 select 4, 'produtos Make Ads arquivados criados', (select count(*) from maso_contrato where cria_contrato), null
 union all
 select 5, 'de fora: ' || k.problema, count(t.id), string_agg(distinct k.cliente, ', ' order by k.cliente)
 from maso_tarefa t join maso_contrato k on k.cliente = t.cliente where k.problema is not null group by k.problema
) r order by ordem, item;
`,
  ].join("\n");
}

export function renderComments(model, comments, { company, author }, part, parts) {
  const c = sqlString(company);
  const a = sqlString(author);
  const owners = new Set(comments.map((x) => x.owner));
  return [
    ...HEADER(`COMENTÁRIOS, parte ${part} de ${parts}`, model).slice(0, -2),
    `-- Nesta parte: ${comments.length} comentários.`,
    "",
    peopleSql(model.people),
    "drop table if exists maso_comentario;",
    "create temp table maso_comentario(id uuid primary key, tarefa uuid not null, autor text, corpo text not null, corpo_inicial text, criado timestamp not null);",
    values("maso_comentario", "id, tarefa, autor, corpo, corpo_inicial, criado", comments,
      (x) => `('${x.id}','${x.task}',${sqlNullable(x.author)},${sqlString(x.body)},${sqlNullable(x.first_body)},'${x.created_at}')`, 500),
    imageStage(model.images.filter((i) => owners.has(i.owner))),
    matchSql(c, a),
    `
begin;
set local statement_timeout = 0;
set local mavi.bulk_tasks = '1';

drop table if exists maso_novo;
create temp table maso_novo as
 select x.*, coalesce(q.user_id, ${a}) as autor_id, case when q.user_id is null and x.autor is not null then q.nome end as autor_fora
 from maso_comentario x
 join public.tasks t on t.company_id = ${c} and t.id = x.tarefa
 left join maso_quem q on q.id = x.autor
 where not exists (select 1 from public.comments y where y.id = x.id);
${mentionSql("maso_novo", "corpo")}
update maso_novo set corpo = ${prependSql("corpo", notePara("'No MASO: ' || autor_fora"))},
 corpo_inicial = case when corpo_inicial is null then null else ${prependSql("corpo_inicial", notePara("'No MASO: ' || autor_fora"))} end
where autor_fora is not null;
${imageInsert(c, a)}
-- Com menção: entra com a menção como texto (ninguém é avisado) e a ganha depois.
insert into public.comments(id, company_id, task_id, author_id, body, created_at)
 select x.id, ${c}, x.tarefa, x.autor_id, coalesce(x.corpo_inicial, x.corpo), x.criado at time zone (select tz from maso_fuso)
 from maso_novo x order by x.criado, x.id;
update public.comments y set body = x.corpo from maso_novo x where y.id = x.id and x.corpo_inicial is not null;
commit;

select (select count(*) from maso_novo) as importados_agora,
 (select count(*) from maso_comentario x where not exists (select 1 from public.tasks t where t.id = x.tarefa)) as sem_a_tarefa_no_mavi;
`,
  ].join("\n");
}

export function renderAttachments(model, { company, author }) {
  const c = sqlString(company);
  const a = sqlString(author);
  return [
    ...HEADER("IMPORTAÇÃO DOS ANEXOS", model),
    "-- Os anexos apontam para os arquivos do MASO no bucket (sem cópia; migração 20270215090000);",
    "-- os poucos copiados e as imagens coladas precisam do --send antes.",
    peopleSql(model.people),
    "drop table if exists maso_anexo;",
    "create temp table maso_anexo(id uuid primary key, tarefa uuid not null, autor text, nome text not null, path text not null, tamanho bigint not null, criado timestamp);",
    values("maso_anexo", "id, tarefa, autor, nome, path, tamanho, criado", model.attachments,
      (x) => `('${x.id}','${x.task}',${sqlNullable(x.author)},${sqlString(x.name)},${sqlString(x.path)},${x.size},${sqlNullable(x.created_at)})`, 500),
    matchSql(c, a),
    `
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.attachments'::regclass
   and contype = 'c' and pg_get_constraintdef(oid) like '%tasks/%') then
    raise exception 'Aplique antes a migração 20270215090000_maso_task_attachments (anexos no caminho do MASO).';
  end if;
end $$;

begin;
set local statement_timeout = 0;
set local mavi.bulk_tasks = '1';
drop table if exists maso_anexo_novo;
create temp table maso_anexo_novo as
 select x.*, coalesce(q.user_id, ${a}) as autor_id,
  coalesce(x.criado at time zone (select tz from maso_fuso), t.created_at) as criado_em
 from maso_anexo x join public.tasks t on t.company_id = ${c} and t.id = x.tarefa
 left join maso_quem q on q.id = x.autor
 where not exists (select 1 from public.attachments y where y.id = x.id);
insert into public.attachments(id, company_id, task_id, uploaded_by, name, path, size_bytes, created_at)
 select id, ${c}, tarefa, autor_id, nome, path, tamanho, criado_em from maso_anexo_novo order by criado_em, id;
commit;

select (select count(*) from maso_anexo_novo) as importados_agora,
 (select count(*) from maso_anexo x where not exists (select 1 from public.tasks t where t.id = x.tarefa)) as sem_a_tarefa_no_mavi;
`,
  ].join("\n");
}

// ------------------------------------------------------------ bucket

async function gcsToken(credentials, scope, fetchImpl = fetch) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: credentials.client_email,
    scope: `https://www.googleapis.com/auth/devstorage.${scope}`,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const jwt = `${unsigned}.${crypto.sign("RSA-SHA256", Buffer.from(unsigned), credentials.private_key).toString("base64url")}`;
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const token = await res.json();
  if (!token.access_token) throw new UsageError(`O Google recusou as credenciais: ${JSON.stringify(token)}`);
  return token.access_token;
}

/** Os arquivos do MASO no bucket (tasks/<cliente>/<tarefa>/<arquivo>). */
export async function listObjects(credentials, prefix = "tasks/", fetchImpl = fetch) {
  const token = await gcsToken(credentials, "read_only", fetchImpl);
  const objects = new Map();
  let page = "";
  do {
    const res = await fetchImpl(
      `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o?maxResults=1000&prefix=${encodeURIComponent(prefix)}` +
        `&fields=nextPageToken,items(name,size)${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`Falha ao listar o bucket (${res.status}): ${await res.text()}`);
    const data = await res.json();
    for (const o of data.items ?? []) objects.set(o.name, { size: Number(o.size) });
    page = data.nextPageToken;
  } while (page);
  return withTaskIndex(objects);
}
/** Também por tarefa/arquivo, para o anexo de uma tarefa que trocou de cliente. */
export function withTaskIndex(objects) {
  objects.byTask = new Map();
  for (const name of objects.keys()) {
    const parts = name.split("/");
    if (parts.length >= 4) objects.byTask.set(parts.slice(2).join("/"), name);
  }
  return objects;
}

/** Copia os anexos dentro do bucket e envia as imagens; pula o que já está lá. */
async function send(dir, credentials, log) {
  const manifest = JSON.parse(await readFile(join(dir, "arquivos.json"), "utf8"));
  // O token vale uma hora: renovado a cada 45 minutos.
  let auth = null;
  let since = 0;
  const authorize = async () => {
    if (Date.now() - since > 45 * 60 * 1000) {
      auth = { Authorization: `Bearer ${await gcsToken(credentials, "read_write")}` };
      since = Date.now();
    }
    return auth;
  };
  await authorize();
  const o = (name) => encodeURIComponent(name);
  let done = 0, copied = 0, uploaded = 0, existing = 0;
  const failures = [];
  const queue = [...manifest.files];
  async function worker() {
    for (let f; (f = queue.shift()); ) {
      try {
        await authorize();
        const head = await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${o(f.path)}?fields=size`, { headers: auth });
        if (head.ok) existing++;
        else if (f.source) {
          let rewriteToken = "";
          for (;;) {
            const res = await fetch(
              `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${o(f.source)}/rewriteTo/b/${BUCKET}/o/${o(f.path)}` +
                (rewriteToken ? `?rewriteToken=${encodeURIComponent(rewriteToken)}` : ""),
              { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ contentType: f.contentType }) },
            );
            const data = await res.json();
            if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(data.error ?? data)}`);
            if (data.done) break;
            rewriteToken = data.rewriteToken;
          }
          copied++;
        } else {
          const body = await readFile(join(dir, f.local));
          const res = await fetch(
            `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${o(f.path)}`,
            { method: "POST", headers: { ...auth, "content-type": f.contentType }, body },
          );
          if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
          uploaded++;
        }
      } catch (e) {
        failures.push({ path: f.path, source: f.source ?? f.local, error: e.message });
      }
      if (++done % 500 === 0) log(`${done}/${manifest.files.length} arquivos…`);
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker));
  log(`Bucket: ${copied} copiados, ${uploaded} enviados, ${existing} já estavam lá, ${failures.length} falhas.`);
  if (failures.length) {
    await writeFile(join(dir, "falhas-envio.json"), JSON.stringify(failures, null, 1));
    log(`As falhas estão em ${join(dir, "falhas-envio.json")}; rode --send de novo para tentar outra vez.`);
  }
  return { copied, uploaded, existing, failures };
}

// ------------------------------------------------------------ CLI

/**
 * Os quatro dumps da pasta. Com mais de um arquivo da mesma tabela (outra
 * exportação, "maso_runrun (2).sql"), o arquivo de cada uma vem pela opção
 * (--tasks, --comments, --attachments, --users), para nunca ler o errado.
 */
export async function readDumps(dir, chosen = {}) {
  const files = { tasks: "maso_runrun", comments: "maso_runrun_comentario", attachments: "maso_runrun_anexo", users: "usuarios_maso" };
  const { readdir } = await import("node:fs/promises");
  const names = await readdir(dir);
  const out = {};
  for (const [key, table] of Object.entries(files)) {
    let file = chosen[key];
    if (!file) {
      // "maso_runrun (1).sql" também serve; maso_runrun_* não é maso_runrun.
      const found = names.filter((n) => n.toLowerCase().replace(/\s*\(\d+\)/, "") === `${table}.sql`);
      if (!found.length) throw new UsageError(`Falta ${table}.sql em ${dir}.`);
      if (found.length > 1)
        throw new UsageError(`Há mais de um ${table} em ${dir} (${found.join(", ")}): diga qual com --${key} "<arquivo>".`);
      file = found[0];
    }
    out[key] = parseSqlDump(await readFile(resolve(dir, file), "utf8"), file).get(table) ?? [];
    if (!out[key].length) throw new UsageError(`${file} não tem linhas de ${table}.`);
  }
  return out;
}

export async function main(argv, { log = console.log, objects, today } = {}) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, "");
    if (!["dir", "company", "author", "out", "credentials", "send", "tasks", "comments", "attachments", "users"].includes(k)) throw new UsageError(`Opção desconhecida: ${argv[i]}\n${USAGE}`);
    args[k] = argv[++i];
  }
  const credentialsFile = resolve(args.credentials ?? "gcs-credentials.json");
  const credentials = async () => JSON.parse(await readFile(credentialsFile, "utf8"));
  if (args.send) return send(resolve(args.send), await credentials(), log);
  if (!args.dir || !args.out || !UUID.test(args.company ?? "") || !UUID.test(args.author ?? "")) throw new UsageError(USAGE);
  const company = args.company.toLowerCase();
  const author = args.author.toLowerCase();
  const dumps = await readDumps(resolve(args.dir), { tasks: args.tasks, comments: args.comments, attachments: args.attachments, users: args.users });
  log(`Lidos: ${dumps.tasks.length} tarefas, ${dumps.comments.length} comentários, ${dumps.attachments.length} anexos, ${dumps.users.length} pessoas.`);
  const list = objects ?? (await listObjects(await credentials()));
  log(`Bucket: ${list.size} arquivos do MASO em tasks/.`);
  const model = buildModel(dumps, { company, author, objects: list, today: today ?? new Date().toISOString().slice(0, 10) });
  const out = resolve(args.out);
  await mkdir(join(out, "imagens"), { recursive: true });
  const opts = { company, author };
  await writeFile(join(out, "01-conferencia.sql"), renderPreview(model, opts));
  await writeFile(join(out, "02-tarefas.sql"), renderTasks(model, opts));
  // Comentários em partes de ~20 MB.
  const parts = [];
  let current = [];
  let bytes = 0;
  for (const x of model.comments) {
    const size = x.body.length + (x.first_body?.length ?? 0) + 200;
    if (current.length && bytes + size > PART_BYTES) {
      parts.push(current);
      current = [];
      bytes = 0;
    }
    current.push(x);
    bytes += size;
  }
  if (current.length) parts.push(current);
  const written = [];
  for (let i = 0; i < parts.length; i++) {
    const name = `03-comentarios-parte-${String(i + 1).padStart(2, "0")}.sql`;
    await writeFile(join(out, name), renderComments(model, parts[i], opts, i + 1, parts.length));
    written.push(name);
  }
  await writeFile(join(out, "04-anexos.sql"), renderAttachments(model, opts));
  for (const [id, bytes] of model.blobs) await writeFile(join(out, "imagens", id), bytes);
  await writeFile(join(out, "arquivos.json"), JSON.stringify({ bucket: BUCKET, files: model.files }, null, 1));
  const mb = (model.attachments.reduce((s, x) => s + x.size, 0) / 1e6).toFixed(0);
  log(`Tarefas: ${model.tasks.length}; comentários: ${model.comments.length}; anexos: ${model.attachments.length} (${mb} MB); imagens no texto: ${model.images.length}.`);
  log(`Fora já no arquivo: ${JSON.stringify(model.skipped)}`);
  log(`Arquivos em ${out}: 01-conferencia.sql, 02-tarefas.sql, ${written.join(", ")}, 04-anexos.sql, arquivos.json (${model.files.length} arquivos para o --send).`);
  return model;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof UsageError ? e.message : e.stack);
    process.exit(1);
  });

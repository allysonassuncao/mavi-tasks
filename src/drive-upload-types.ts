/**
 * What a shared folder's public link may accept (migration
 * 20270118090000_drive_public_upload_rules has the same list: the database
 * decides, this copy lets the page say it up front and the server check the
 * file's content). Only formats that carry no code: no SVG or HTML, no
 * macro-enabled Office files, no archives, no programs.
 */
export type DriveUploadKind = "image" | "video" | "audio" | "pdf" | "document";

export const DRIVE_UPLOAD_KINDS: {
  kind: DriveUploadKind;
  label: string;
  /** For the sentence on the public page ("Envie fotos, vídeos…"). */
  noun: string;
}[] = [
  { kind: "image", label: "Imagens", noun: "fotos" },
  { kind: "video", label: "Vídeos", noun: "vídeos" },
  { kind: "audio", label: "Áudios", noun: "áudios" },
  { kind: "pdf", label: "PDF", noun: "PDFs" },
  { kind: "document", label: "Documentos", noun: "documentos" },
];

export const DRIVE_UPLOAD_FORMATS: Record<
  string,
  { kind: DriveUploadKind; type: string }
> = {
  jpg: { kind: "image", type: "image/jpeg" },
  jpeg: { kind: "image", type: "image/jpeg" },
  png: { kind: "image", type: "image/png" },
  gif: { kind: "image", type: "image/gif" },
  webp: { kind: "image", type: "image/webp" },
  heic: { kind: "image", type: "image/heic" },
  heif: { kind: "image", type: "image/heif" },
  avif: { kind: "image", type: "image/avif" },
  mp4: { kind: "video", type: "video/mp4" },
  mov: { kind: "video", type: "video/quicktime" },
  m4v: { kind: "video", type: "video/x-m4v" },
  webm: { kind: "video", type: "video/webm" },
  mkv: { kind: "video", type: "video/x-matroska" },
  avi: { kind: "video", type: "video/x-msvideo" },
  "3gp": { kind: "video", type: "video/3gpp" },
  mp3: { kind: "audio", type: "audio/mpeg" },
  m4a: { kind: "audio", type: "audio/mp4" },
  wav: { kind: "audio", type: "audio/wav" },
  ogg: { kind: "audio", type: "audio/ogg" },
  opus: { kind: "audio", type: "audio/ogg" },
  aac: { kind: "audio", type: "audio/aac" },
  pdf: { kind: "pdf", type: "application/pdf" },
  docx: {
    kind: "document",
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  xlsx: {
    kind: "document",
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  pptx: {
    kind: "document",
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
  odt: { kind: "document", type: "application/vnd.oasis.opendocument.text" },
  ods: {
    kind: "document",
    type: "application/vnd.oasis.opendocument.spreadsheet",
  },
  odp: {
    kind: "document",
    type: "application/vnd.oasis.opendocument.presentation",
  },
  txt: { kind: "document", type: "text/plain" },
  csv: { kind: "document", type: "text/csv" },
};

/** Largest size a link may accept, in MB (the Drive's own limit). */
export const DRIVE_UPLOAD_MAX_MB = 500;
export const DRIVE_UPLOAD_SIZES = [5, 10, 25, 50, 100, 250, 500];

export const uploadExtension = (name: string) =>
  /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";

export function uploadFormat(name: string) {
  return DRIVE_UPLOAD_FORMATS[uploadExtension(name)] ?? null;
}

/** The file input's accept list: the extensions of the kinds allowed. */
export function uploadAccept(kinds: readonly string[]) {
  return Object.entries(DRIVE_UPLOAD_FORMATS)
    .filter(([, f]) => kinds.includes(f.kind))
    .map(([ext]) => `.${ext}`)
    .join(",");
}

/** "fotos, vídeos e PDFs" */
export function uploadKindsSentence(kinds: readonly string[]) {
  const nouns = DRIVE_UPLOAD_KINDS.filter((k) => kinds.includes(k.kind)).map(
    (k) => k.noun,
  );
  return nouns.length > 1
    ? `${nouns.slice(0, -1).join(", ")} ou ${nouns.at(-1)}`
    : (nouns[0] ?? "arquivos");
}

/** Extensions per kind, for the sharing dialog ("JPG, PNG…"). */
export function uploadExtensions(kind: DriveUploadKind) {
  return Object.entries(DRIVE_UPLOAD_FORMATS)
    .filter(([ext, f]) => f.kind === kind && ext !== "jpeg")
    .map(([ext]) => ext.toUpperCase())
    .join(", ");
}

/** How many leading bytes the content check reads. */
export const SNIFF_BYTES = 4096;

const ascii = (b: Uint8Array, at: number, text: string) =>
  b.length >= at + text.length &&
  [...text].every((c, i) => b[at + i] === c.charCodeAt(0));

/** ISO base media (MP4/MOV/HEIC/AVIF/M4A/3GP): a box type at byte 4. */
const isoMedia = (b: Uint8Array) =>
  ["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot"].some((box) =>
    ascii(b, 4, box),
  );
/**
 * An Office (OOXML) or OpenDocument file: a ZIP whose first entry is one of
 * the format's own parts, so any other archive renamed to .docx is refused.
 */
function officeZip(b: Uint8Array, parts: string[]) {
  if (!(
    b.length >= 30 &&
    b[0] === 0x50 &&
    b[1] === 0x4b &&
    b[2] === 3 &&
    b[3] === 4
  ))
    return false;
  const length = b[26] | (b[27] << 8);
  const first = String.fromCharCode(...b.subarray(30, 30 + length));
  return parts.some((p) => first.startsWith(p));
}
const ooxml = (b: Uint8Array) =>
  officeZip(b, [
    "[Content_Types].xml",
    "_rels/",
    "docProps/",
    "word/",
    "xl/",
    "ppt/",
    "customXml/",
  ]);
const odf = (b: Uint8Array) => officeZip(b, ["mimetype"]);
const isEbml = (b: Uint8Array) =>
  b.length >= 4 &&
  b[0] === 0x1a &&
  b[1] === 0x45 &&
  b[2] === 0xdf &&
  b[3] === 0xa3;
/** Frame sync of MPEG audio (MP3) or ADTS (AAC). */
const mpegSync = (b: Uint8Array) =>
  b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0;
/** Plain text (TXT/CSV): no NUL byte and not a known binary. */
const isText = (b: Uint8Array) =>
  !b.includes(0) && !ascii(b, 0, "MZ") && !ascii(b, 0, "\x7fELF");

const SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  png: (b) => ascii(b, 0, "\x89PNG\r\n\x1a\n"),
  gif: (b) => ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a"),
  webp: (b) => ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP"),
  heic: isoMedia,
  avif: isoMedia,
  mp4: isoMedia,
  mov: isoMedia,
  "3gp": isoMedia,
  m4a: isoMedia,
  webm: isEbml,
  avi: (b) => ascii(b, 0, "RIFF") && ascii(b, 8, "AVI "),
  mp3: (b) => ascii(b, 0, "ID3") || mpegSync(b),
  aac: (b) => ascii(b, 0, "ADIF") || ascii(b, 0, "ID3") || mpegSync(b),
  wav: (b) => ascii(b, 0, "RIFF") && ascii(b, 8, "WAVE"),
  ogg: (b) => ascii(b, 0, "OggS"),
  // A PDF's header may come after a little junk (within the first 1 KB).
  pdf: (b) => {
    for (let i = 0; i <= Math.min(1024, b.length - 5); i++)
      if (ascii(b, i, "%PDF-")) return true;
    return false;
  },
  docx: ooxml,
  odt: odf,
  txt: isText,
};
const SAME_AS: Record<string, string> = {
  jpeg: "jpg",
  heif: "heic",
  m4v: "mp4",
  mkv: "webm",
  opus: "ogg",
  xlsx: "docx",
  pptx: "docx",
  ods: "odt",
  odp: "odt",
  csv: "txt",
};

/** Whether the file's first bytes match the format its name says. */
export function contentMatches(name: string, head: Uint8Array) {
  const ext = uploadExtension(name);
  if (!DRIVE_UPLOAD_FORMATS[ext] || !head.length) return false;
  const check = SIGNATURES[SAME_AS[ext] ?? ext];
  return !!check && check(head);
}

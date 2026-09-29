/**
 * File types for uploads, shared by the browser (validation) and the upload
 * signing server (api/_uploads.ts), which never trusts the client's content
 * type.
 *
 * Task attachments take any file except programs and scripts the system
 * would run by itself (the same list as mavi_private.blocked_file in the
 * database), up to 100 MB. Known types keep their content type, so images,
 * audio, video and PDF open in the viewer; anything else is stored as a
 * plain download.
 */
export const ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;

export const attachmentTypes: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  txt: "text/plain",
  md: "text/plain",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  gz: "application/gzip",
  tar: "application/x-tar",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  weba: "audio/webm",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
};

/**
 * Programs and scripts: never attached (a ZIP still carries them when
 * someone really needs to send one).
 */
export const blockedExtensions = new Set([
  "exe", "msi", "msp", "mst", "bat", "cmd", "com", "scr", "pif", "cpl", "dll",
  "sys", "drv", "ocx", "vbs", "vbe", "vb", "js", "jse", "wsf", "wsh", "wsc",
  "ws", "hta", "ps1", "ps1xml", "ps2", "psc1", "psc2", "psm1", "msc", "msh",
  "msh1", "msh2", "reg", "inf", "lnk", "scf", "jar", "jnlp", "appx",
  "appxbundle", "msix", "msixbundle", "apk", "xapk", "aab", "ipa", "app",
  "command", "sh", "bash", "csh", "ksh", "run", "bin", "pkg", "deb", "rpm",
  "gadget", "application", "xbap", "ade", "adp", "chm", "ins", "isp", "shb",
  "shs", "sct", "xll", "mde", "mdb", "accde", "diagcab",
]);

export const inlineImageTypes = ["image/jpeg", "image/png", "image/webp"];

const extension = (name: string) => {
  const base = name.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 || (dot === 0 && base.length > 1)
    ? base.slice(dot + 1).toLowerCase()
    : "";
};

export const isBlockedFile = (name: string) =>
  blockedExtensions.has(extension(name));

/**
 * The content type an attachment is stored with, or undefined for a blocked
 * file. Files of unknown types (and HTML/SVG, which a browser would run) are
 * stored as plain downloads.
 */
export function attachmentType(name: string): string | undefined {
  if (isBlockedFile(name)) return undefined;
  return attachmentTypes[extension(name)] ?? "application/octet-stream";
}

/** Audio recorded in the app (task descriptions and comments). */
export const recordedAudioTypes = [
  "audio/webm",
  "audio/mp4",
  "audio/ogg",
  "audio/mpeg",
  "audio/wav",
];
export const audioExtension = (mime: string) =>
  ({
    "audio/webm": "webm",
    "audio/mp4": "m4a",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
  })[mime] ?? "webm";

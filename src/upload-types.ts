/**
 * File types accepted for uploads, shared by the browser (validation) and the
 * upload signing server (api/_uploads.ts), which never trusts the client's
 * content type.
 */
export const attachmentTypes: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  txt: "text/plain",
  csv: "text/csv",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
export const inlineImageTypes = ["image/jpeg", "image/png", "image/webp"];

export function attachmentType(name: string) {
  return attachmentTypes[name.split(".").pop()?.toLowerCase() ?? ""];
}

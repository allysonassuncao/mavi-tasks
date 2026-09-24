import { supabase } from "./supabase";
import { fetchAllRows, rpc } from "./api";
import { contractProductLabel } from "./domain";
import { fold } from "./task-search";
import type {
  DriveAuditEntry,
  DriveFile,
  DriveFolder,
  DriveFolderSharing,
  DriveLocation,
  PublicFolderView,
  DriveVisibility,
  Snapshot,
} from "./types";

/** Columns clients may read; the bucket path is intentionally not among them. */
const DRIVE_COLUMNS =
  "id,company_id,name,content_type,size_bytes,visibility,share_token,status,uploaded_by,created_at,client_id,contract_id,folder_id";
export const DRIVE_MAX_BYTES = 524288000;

/** Files directly inside a location (not in its subfolders). */
export async function listDriveFiles(
  company: string,
  at: DriveLocation,
): Promise<DriveFile[]> {
  if (!supabase) throw Error("Supabase não configurado");
  return fetchAllRows<DriveFile>((count) => {
    let query = supabase!
      .from("drive_files")
      .select(DRIVE_COLUMNS, count ? { count } : undefined)
      .eq("company_id", company)
      .eq("status", "ready");
    if (at.folder) query = query.eq("folder_id", at.folder);
    else {
      query = query.is("folder_id", null);
      query = at.contract
        ? query.eq("contract_id", at.contract)
        : query.is("contract_id", null);
      query = at.client
        ? query.eq("client_id", at.client)
        : query.is("client_id", null);
    }
    // The id breaks ties between equal names, so pages never overlap.
    return query.order("name").order("id");
  });
}

/** Files the person can see (optionally in one client) whose name contains `text`. */
export async function searchDriveFiles(
  company: string,
  text: string,
  client?: string,
): Promise<DriveFile[]> {
  if (!supabase) throw Error("Supabase não configurado");
  const pattern = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  // Every match, page by page: a capped list hid files past the first ones.
  return fetchAllRows<DriveFile>((count) => {
    let query = supabase!
      .from("drive_files")
      .select(DRIVE_COLUMNS, count ? { count } : undefined)
      .eq("company_id", company)
      .eq("status", "ready")
      .ilike("name", pattern);
    if (client) query = query.eq("client_id", client);
    return query.order("name").order("id");
  });
}

/** A client, product or folder whose name matched a Drive search. */
export type DriveFolderMatch = {
  key: string;
  kind: "client" | "product" | "folder";
  name: string;
  at: DriveLocation;
  color?: string;
  folder?: DriveFolder;
};

/**
 * Clients, contracted products and folders (among those already loaded) whose
 * name contains `text`, ignoring case and accents. With `client`, only what
 * sits under that client.
 */
export function matchDriveFolders(
  data: Snapshot,
  folders: DriveFolder[],
  text: string,
  client?: string,
): DriveFolderMatch[] {
  const q = fold(text.trim());
  if (!q) return [];
  const hit = (name: string) => fold(name).includes(q);
  const byName = (a: DriveFolderMatch, b: DriveFolderMatch) =>
    a.name.localeCompare(b.name, "pt-BR");
  const clients: DriveFolderMatch[] = client
    ? []
    : data.clients
        .filter((c) => !c.archived && hit(c.name))
        .map((c) => ({
          key: `client-${c.id}`,
          kind: "client" as const,
          name: c.name,
          at: { client: c.id },
          color: c.color,
        }));
  const products: DriveFolderMatch[] = data.contracts
    .filter((k) => !k.archived && (!client || k.client_id === client))
    .map((k) => ({
      key: `product-${k.id}`,
      kind: "product" as const,
      name: contractProductLabel(data, k.id),
      at: { client: k.client_id, contract: k.id },
      color: data.products.find((p) => p.id === k.product_id)?.color,
    }))
    .filter((m) => hit(m.name));
  const seen = new Set<string>();
  const custom: DriveFolderMatch[] = folders
    .filter((f) => {
      if (seen.has(f.id)) return false;
      seen.add(f.id);
      return (!client || f.client_id === client) && hit(f.name);
    })
    .map((f) => ({
      key: `folder-${f.id}`,
      kind: "folder" as const,
      name: f.name,
      at: {
        client: f.client_id ?? undefined,
        contract: f.contract_id ?? undefined,
        folder: f.id,
      },
      folder: f,
    }));
  return [
    ...clients.sort(byName),
    ...products.sort(byName),
    ...custom.sort(byName),
  ];
}

/** Every folder the person can see, read page by page (see fetchAllRows). */
export async function listDriveFolders(
  company: string,
): Promise<DriveFolder[]> {
  if (!supabase) throw Error("Supabase não configurado");
  return fetchAllRows<DriveFolder>((count) =>
    supabase!
      .from("drive_folders")
      .select("*", count ? { count } : undefined)
      .eq("company_id", company)
      .order("name")
      .order("id"),
  );
}

export function createDriveFolder(
  company: string,
  name: string,
  at: DriveLocation,
): Promise<string> {
  return rpc("create_drive_folder", {
    p_company: company,
    p_name: name,
    p_client: at.client ?? null,
    p_contract: at.contract ?? null,
    p_parent: at.folder ?? null,
  });
}
export function renameDriveFolder(id: string, name: string) {
  return rpc("rename_drive_folder", { p_folder: id, p_name: name });
}
export function deleteDriveFolder(id: string) {
  return rpc("delete_drive_folder", { p_folder: id });
}
export function renameDriveFile(id: string, name: string) {
  return rpc("rename_drive_file", { p_file: id, p_name: name });
}

/** Calls the Drive server (api/drive.ts), which checks access and signs GCS URLs. */
async function driveServer<T>(body: Record<string, unknown>): Promise<T> {
  const token = supabase
    ? (await supabase.auth.getSession()).data.session?.access_token
    : undefined;
  const res = await fetch("/api/drive", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(data.error ?? "Não foi possível acessar o Drive.");
  return data as T;
}

export function publicFileUrl(file: Pick<DriveFile, "share_token">) {
  return `${window.location.origin}/arquivo/${file.share_token}`;
}

export async function uploadDriveFile(
  company: string,
  at: DriveLocation,
  file: File,
  visibility: DriveVisibility,
  onProgress: (fraction: number) => void,
) {
  if (file.size === 0 || file.size > DRIVE_MAX_BYTES)
    throw Error(`${file.name}: envie arquivos não vazios de até 500 MB.`);
  const id: string = await rpc("prepare_drive_file", {
    p_company: company,
    p_name: file.name,
    p_size: file.size,
    p_content_type: file.type || "application/octet-stream",
    p_visibility: visibility,
    p_client: at.client ?? null,
    p_contract: at.contract ?? null,
    p_folder: at.folder ?? null,
  });
  const { url, content_type } = await driveServer<{
    url: string;
    content_type: string;
  }>({ action: "sign-upload", file: id });
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", content_type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(Error(`${file.name}: falha no envio (${xhr.status}).`));
    xhr.onerror = () =>
      reject(Error(`${file.name}: falha de conexão no envio.`));
    xhr.send(file);
  });
  await rpc("confirm_drive_file", { p_file: id });
  return id;
}

/**
 * Downloads, or opens in a new tab when `inline`. The tab is opened on the
 * click itself (before awaiting the signed URL) so popup blockers allow it.
 */
export async function openDriveFile(id: string, inline = false) {
  const tab = inline ? window.open("about:blank", "_blank") : null;
  if (tab) tab.opener = null;
  try {
    const { url } = await driveServer<{ url: string }>({
      action: "download",
      file: id,
      inline,
    });
    if (tab) tab.location.href = url;
    else window.location.assign(url);
  } catch (error) {
    tab?.close();
    throw error;
  }
}

/** A short-lived URL that shows the file inline (logged as a view). */
export async function driveViewUrl(id: string) {
  const { url } = await driveServer<{ url: string }>({
    action: "download",
    file: id,
    inline: true,
  });
  return url;
}

export function setDriveVisibility(id: string, visibility: DriveVisibility) {
  return rpc("set_drive_file_visibility", {
    p_file: id,
    p_visibility: visibility,
  });
}

export function deleteDriveFile(id: string) {
  return driveServer<{ deleted: boolean }>({ action: "delete", file: id });
}

export function openPublicFile(token: string, inline = false) {
  return driveServer<{
    name: string;
    content_type: string;
    size_bytes: number;
    url: string;
  }>({ action: "public", token, inline });
}

// ------------------------------------------------------------ folder sharing
export function publicFolderUrl(token: string) {
  return `${window.location.origin}/pasta/${token}`;
}
/** Only folders inside a contracted product can be shared. */
export const shareableFolder = (f: Pick<DriveFolder, "contract_id">) =>
  !!f.contract_id;
export function folderSharing(folder: string): Promise<DriveFolderSharing> {
  return rpc("drive_folder_sharing", { p_folder: folder });
}
export function setFolderSharing(
  folder: string,
  isPublic: boolean,
  members: string[],
): Promise<DriveFolderSharing> {
  return rpc("set_drive_folder_sharing", {
    p_folder: folder,
    p_public: isPublic,
    p_members: members,
  });
}
/** Folders shared directly with the signed-in person. */
export async function mySharedFolders(company: string): Promise<DriveFolder[]> {
  return ((await rpc("my_shared_drive_folders", { p_company: company })) ??
    []) as DriveFolder[];
}
/** A level of a public folder; null when the link is off or wrong. */
export async function openPublicFolder(
  token: string,
  folder?: string,
): Promise<PublicFolderView | null> {
  return rpc("drive_public_folder", {
    p_token: token,
    p_folder: folder ?? null,
  });
}
export function logPublicFolderOpened(token: string) {
  return rpc("log_drive_public_folder", { p_token: token });
}
export function openPublicFolderFile(
  token: string,
  file: string,
  inline = false,
) {
  return driveServer<{ url: string }>({
    action: "public-folder-file",
    token,
    file,
    inline,
  });
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0).replace(".", ",")} ${units[unit]}`;
}

/** Records that a public link was copied (the copy itself never reaches the server). */
export function logLinkCopied(id: string) {
  return rpc("log_drive_link_copied", { p_file: id });
}

export const DRIVE_AUDIT_PAGE = 100;
/** Audit entries, newest first; `before` pages with the last loaded id. */
export async function listDriveAudit(
  company: string,
  filters: { action?: string; actor?: string; item?: string; before?: number },
): Promise<DriveAuditEntry[]> {
  if (!supabase) throw Error("Supabase não configurado");
  let query = supabase
    .from("drive_audit")
    .select("*")
    .eq("company_id", company);
  if (filters.action) query = query.eq("action", filters.action);
  if (filters.actor === "public") query = query.is("actor_id", null);
  else if (filters.actor) query = query.eq("actor_id", filters.actor);
  if (filters.item)
    query = query.ilike(
      "item_name",
      `%${filters.item.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
    );
  if (filters.before) query = query.lt("id", filters.before);
  const { data, error } = await query
    .order("id", { ascending: false })
    .limit(DRIVE_AUDIT_PAGE);
  if (error) throw error;
  return (data ?? []) as DriveAuditEntry[];
}

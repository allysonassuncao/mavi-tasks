import { supabase } from "./supabase";

/**
 * Space used by uploads (migration 20260930100000_storage_uploads): every
 * upload is a row of storage_uploads; storage_usage sums what still exists
 * per person and kind.
 */
export type StorageKind =
  "drive" | "attachment" | "inline_image" | "avatar" | "logo";

/** Fixed order and colors (validated for color-vision deficiency). */
export const storageKinds: {
  kind: StorageKind;
  label: string;
  color: string;
}[] = [
  { kind: "drive", label: "Drive", color: "#2a78d6" },
  { kind: "attachment", label: "Anexos de tarefas", color: "#eb6834" },
  { kind: "inline_image", label: "Imagens em textos", color: "#1baf7a" },
  { kind: "avatar", label: "Fotos de perfil", color: "#eda100" },
  { kind: "logo", label: "Logo da empresa", color: "#e87ba4" },
];
export const storageKindLabel = (kind: StorageKind) =>
  storageKinds.find((k) => k.kind === kind)?.label ?? kind;

export type StorageUsageRow = {
  user_id: string;
  kind: StorageKind;
  files: number;
  bytes: number;
  last_upload_at: string | null;
};

export type StorageUpload = {
  id: string;
  /** The owning record (drive_files, attachments…), to act on the file. */
  source_id: string;
  user_id: string;
  kind: StorageKind;
  name: string;
  size_bytes: number;
  created_at: string;
  completed_at: string | null;
  deleted_at: string | null;
};

/** Space and file count in use, split by kind. */
export type UsageTotals = {
  bytes: number;
  files: number;
  last_upload_at: string | null;
} & Record<StorageKind, number>;
export const emptyUsage = (): UsageTotals => ({
  bytes: 0,
  files: 0,
  drive: 0,
  attachment: 0,
  inline_image: 0,
  avatar: 0,
  logo: 0,
  last_upload_at: null,
});
export type PersonUsage = UsageTotals & { user_id: string };

type UsageRow = Pick<
  StorageUsageRow,
  "kind" | "files" | "bytes" | "last_upload_at"
>;

/** Sums rows (one per group and kind) into a total and one per group. */
export function groupUsage<R extends UsageRow>(
  rows: R[],
  keyOf: (row: R) => string,
) {
  const total = emptyUsage();
  const groups = new Map<string, UsageTotals>();
  for (const row of rows) {
    // PostgREST may send bigint sums as strings.
    const bytes = Number(row.bytes),
      files = Number(row.files);
    const key = keyOf(row);
    const group = groups.get(key) ?? emptyUsage();
    for (const t of [total, group]) {
      t.bytes += bytes;
      t.files += files;
      t[row.kind] += bytes;
      if (
        row.last_upload_at &&
        (!t.last_upload_at || row.last_upload_at > t.last_upload_at)
      )
        t.last_upload_at = row.last_upload_at;
    }
    groups.set(key, group);
  }
  return { total, groups };
}

/** The company's total and each person's, largest first. */
export function summarizeStorage(rows: StorageUsageRow[]) {
  const { total, groups } = groupUsage(rows, (r) => r.user_id);
  return {
    company: total,
    people: [...groups]
      .map(([user_id, t]): PersonUsage => ({ ...t, user_id }))
      .sort((a, b) => b.bytes - a.bytes || b.files - a.files),
  };
}

/** Uploads with no client: Drive outside client folders, loose images, photos. */
export const NO_CLIENT = "";

export type ClientUsageRow = Omit<StorageUsageRow, "user_id"> & {
  client_id: string | null;
};

/** Each client's usage, keyed by client id (NO_CLIENT for the rest). */
export function summarizeClients(rows: ClientUsageRow[]) {
  return groupUsage(rows, (r) => r.client_id ?? NO_CLIENT).groups;
}

export type ClientFile = {
  id: string;
  source_id: string;
  user_id: string;
  kind: StorageKind;
  name: string;
  size_bytes: number;
  created_at: string;
  contract_id: string | null;
};

export async function storageUsage(
  company: string,
): Promise<StorageUsageRow[]> {
  if (!supabase) throw Error("Supabase não configurado");
  const { data, error } = await supabase.rpc("storage_usage", {
    p_company: company,
  });
  if (error) throw error;
  return (data ?? []) as StorageUsageRow[];
}

export async function storageUsageByClient(
  company: string,
): Promise<ClientUsageRow[]> {
  if (!supabase) throw Error("Supabase não configurado");
  const { data, error } = await supabase.rpc("storage_usage_by_client", {
    p_company: company,
  });
  if (error) throw error;
  return (data ?? []) as ClientUsageRow[];
}

/** A client's largest files in use (NO_CLIENT: the uploads with no client). */
export async function listClientFiles(
  company: string,
  client: string,
): Promise<ClientFile[]> {
  if (!supabase) throw Error("Supabase não configurado");
  const { data, error } = await supabase.rpc("storage_client_files", {
    p_company: company,
    p_client: client || null,
    p_limit: STORAGE_UPLOADS_PAGE,
  });
  if (error) throw error;
  return (data ?? []) as ClientFile[];
}

export const STORAGE_UPLOADS_PAGE = 50;

/**
 * One person's uploads: the largest still in use, or the most recent
 * (including deleted ones, as history).
 */
export async function listStorageUploads(
  company: string,
  user: string,
  order: "size" | "recent",
): Promise<StorageUpload[]> {
  if (!supabase) throw Error("Supabase não configurado");
  let query = supabase
    .from("storage_uploads")
    .select(
      "id,source_id,user_id,kind,name,size_bytes,created_at,completed_at,deleted_at",
    )
    .eq("company_id", company)
    .eq("user_id", user);
  query =
    order === "size"
      ? query
          .not("completed_at", "is", null)
          .is("deleted_at", null)
          .order("size_bytes", { ascending: false })
      : query.order("created_at", { ascending: false });
  const { data, error } = await query.limit(STORAGE_UPLOADS_PAGE);
  if (error) throw error;
  return (data ?? []) as StorageUpload[];
}

/** Who can open a Drive file: its access and public link token. */
export type DriveSharing = {
  visibility: "private" | "public";
  share_token: string;
};

/** The access of the Drive files among `ids` (other ids are ignored). */
export async function driveSharing(
  ids: string[],
): Promise<Map<string, DriveSharing>> {
  if (!supabase) throw Error("Supabase não configurado");
  if (!ids.length) return new Map();
  const { data, error } = await supabase
    .from("drive_files")
    .select("id,visibility,share_token")
    .in("id", ids);
  if (error) throw error;
  return new Map(
    ((data ?? []) as (DriveSharing & { id: string })[]).map((f) => [
      f.id,
      { visibility: f.visibility, share_token: f.share_token },
    ]),
  );
}

/**
 * Illustrative usage for the demonstration (which stores no files): the
 * same figures on every visit, for the demo's people.
 */
export function demoStorageRows(userIds: string[]): StorageUsageRow[] {
  const MB = 1024 * 1024;
  const plan: [StorageKind, number, number][] = [
    ["drive", 38, 4200 * MB],
    ["attachment", 64, 310 * MB],
    ["inline_image", 120, 95 * MB],
    ["avatar", 1, 28 * 1024],
  ];
  return userIds.flatMap((user_id, i) =>
    plan.map(([kind, files, bytes]) => {
      const share = 1 / (i + 1);
      return {
        user_id,
        kind,
        files: Math.max(1, Math.round(files * share)),
        bytes: Math.round(bytes * share),
        last_upload_at: new Date(Date.UTC(2026, 8, 23 - i, 14)).toISOString(),
      };
    }),
  );
}

export function demoStorageUploads(user: string): StorageUpload[] {
  const MB = 1024 * 1024;
  const files: [StorageKind, string, number, boolean][] = [
    ["drive", "Vídeo institucional - versão final.mp4", 412 * MB, false],
    ["drive", "Banco de imagens - campanha de setembro.zip", 186 * MB, false],
    ["attachment", "Relatório de performance.pdf", 4.2 * MB, false],
    ["drive", "Rascunho antigo.mp4", 240 * MB, true],
    ["inline_image", "print-painel.png", 0.4 * MB, false],
  ];
  return files.map(([kind, name, size, deleted], i) => {
    const at = new Date(Date.UTC(2026, 8, 22 - i, 13)).toISOString();
    return {
      id: `${user}-${i}`,
      source_id: `${user}-file-${i}`,
      user_id: user,
      kind,
      name,
      size_bytes: Math.round(size),
      created_at: at,
      completed_at: at,
      deleted_at: deleted ? at : null,
    };
  });
}

/** Illustrative usage per client for the demonstration. */
export function demoClientRows(clientIds: string[]): ClientUsageRow[] {
  const MB = 1024 * 1024;
  const plan: [StorageKind, number, number][] = [
    ["drive", 30, 3100 * MB],
    ["attachment", 48, 260 * MB],
    ["inline_image", 90, 80 * MB],
  ];
  const rows = clientIds.flatMap((client_id, i) =>
    plan.map(([kind, files, bytes]) => {
      const share = 1 / (i + 1.4);
      return {
        client_id,
        kind,
        files: Math.max(1, Math.round(files * share)),
        bytes: Math.round(bytes * share),
        last_upload_at: new Date(Date.UTC(2026, 8, 23 - i, 15)).toISOString(),
      };
    }),
  );
  return [
    ...rows,
    {
      client_id: null,
      kind: "drive",
      files: 12,
      bytes: 640 * MB,
      last_upload_at: "2026-09-18T12:00:00.000Z",
    },
    {
      client_id: null,
      kind: "avatar",
      files: 4,
      bytes: 58 * 1024,
      last_upload_at: "2026-09-10T12:00:00.000Z",
    },
  ];
}

export function demoClientFiles(
  client: string,
  users: string[],
  contracts: string[],
): ClientFile[] {
  const MB = 1024 * 1024;
  const files: [StorageKind, string, number][] = client
    ? [
        ["drive", "Vídeo da campanha - corte 30s.mp4", 380 * MB],
        ["drive", "Fotos do produto - sessão completa.zip", 210 * MB],
        ["attachment", "Plano de mídia aprovado.pdf", 6.1 * MB],
        ["inline_image", "referencia-criativo.png", 0.9 * MB],
      ]
    : [
        ["drive", "Manual da marca da agência.pdf", 48 * MB],
        ["avatar", "Foto de perfil", 0.02 * MB],
      ];
  return files.map(([kind, name, size], i) => ({
    id: `${client || "geral"}-${i}`,
    source_id: `${client || "geral"}-file-${i}`,
    user_id: users[i % Math.max(users.length, 1)] ?? "",
    kind,
    name,
    size_bytes: Math.round(size),
    created_at: new Date(Date.UTC(2026, 8, 21 - i, 13)).toISOString(),
    contract_id: client && kind !== "avatar" ? (contracts[0] ?? null) : null,
  }));
}

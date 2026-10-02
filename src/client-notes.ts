import { rpc } from "./api";
import { supabase } from "./supabase";

/**
 * Anotações do cliente (migração 20270226090000_client_notes): aparecem em
 * todas as tarefas do cliente e no Drive › cliente › Anotações. Quem vê o
 * cliente lê e edita todas; cada Salvar grava uma versão.
 */
export type ClientNote = {
  id: string;
  company_id: string;
  client_id: string;
  title: string;
  /** O começo do texto puro (a lista). */
  excerpt: string;
  /** Quantos trechos secretos o texto tem. */
  secrets: number;
  version: number;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_by: string | null;
  updated_by_name: string | null;
  updated_at: string;
  deleted_at: string | null;
  deleted_by_name: string | null;
  /** Só ao abrir uma anotação (client_note_get / salvar). */
  body?: string;
  client_name?: string;
};
export type ClientNoteVersion = {
  version: number;
  title: string;
  /** import: uma versão do bloco de notas do MASO. */
  action: "create" | "save" | "restore" | "import";
  restored_from: number | null;
  saved_by: string | null;
  saved_by_name: string | null;
  saved_at: string;
  chars: number;
  secrets: number;
};
export type ClientNoteSecretAccess = {
  at: string;
  action: "view" | "copy";
  label: string;
  user_id: string | null;
  user_name: string | null;
};

export const listClientNotes = (
  company: string,
  client: string,
  deleted = false,
) =>
  rpc("client_notes_list", {
    p_company: company,
    p_client: client,
    p_deleted: deleted,
  }) as Promise<ClientNote[]>;
export const getClientNote = (note: string) =>
  rpc("client_note_get", { p_note: note }) as Promise<ClientNote>;
export const countClientNotes = (company: string, client: string) =>
  rpc("client_notes_count", {
    p_company: company,
    p_client: client,
  }) as Promise<number>;
export const createClientNote = (
  company: string,
  client: string,
  title: string,
  body: string,
) =>
  rpc("client_note_create", {
    p_company: company,
    p_client: client,
    p_title: title,
    p_body: body,
  }) as Promise<ClientNote>;
/** `base`: a versão aberta; se outra pessoa salvou antes, vem um NoteConflict. */
export async function saveClientNote(
  note: string,
  title: string,
  body: string,
  base: number,
) {
  try {
    return (await rpc("client_note_save", {
      p_note: note,
      p_title: title,
      p_body: body,
      p_base: base,
    })) as ClientNote;
  } catch (e) {
    throw asConflict(e);
  }
}
export async function restoreClientNote(
  note: string,
  version: number,
  base: number,
) {
  try {
    return (await rpc("client_note_restore", {
      p_note: note,
      p_version: version,
      p_base: base,
    })) as ClientNote;
  } catch (e) {
    throw asConflict(e);
  }
}
export const clientNoteVersions = (note: string) =>
  rpc("client_note_versions", { p_note: note }) as Promise<ClientNoteVersion[]>;
export const clientNoteVersion = (note: string, version: number) =>
  rpc("client_note_version", { p_note: note, p_version: version }) as Promise<{
    version: number;
    title: string;
    body: string;
    saved_at: string;
    saved_by_name: string | null;
  }>;
export const deleteClientNote = (note: string) =>
  rpc("client_note_delete", { p_note: note }) as Promise<ClientNote>;
export const undeleteClientNote = (note: string) =>
  rpc("client_note_undelete", { p_note: note }) as Promise<ClientNote>;
export const clientNoteSecretLog = (note: string) =>
  rpc("client_note_secret_log", { p_note: note }) as Promise<
    ClientNoteSecretAccess[]
  >;

/** Outra pessoa salvou uma versão nova enquanto esta editava. */
export class NoteConflict extends Error {
  constructor(
    message: string,
    readonly version: number | null,
  ) {
    super(message);
  }
}
function asConflict(e: unknown) {
  const err = e as { code?: string; message?: string; hint?: string };
  if (err?.code !== "40001") return e;
  const v = /^version:(\d+)$/.exec(err.hint ?? "");
  return new NoteConflict(err.message ?? "", v ? Number(v[1]) : null);
}

// ------------------------------------------------------------ secretos
/** O servidor cifra e decifra: o valor nunca vai para o texto nem para o banco. */
async function secretServer<T>(body: Record<string, unknown>): Promise<T> {
  if (!supabase) throw Error("Supabase não configurado");
  const call = async () => {
    const token = (await supabase!.auth.getSession()).data.session
      ?.access_token;
    return fetch("/api/client-notes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  };
  let res = await call();
  if (res.status === 401) {
    await supabase.auth.refreshSession();
    res = await call();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw Error(data.error ?? "Não foi possível falar com o servidor.");
  return data as T;
}
export const createNoteSecret = (
  company: string,
  client: string,
  label: string,
  value: string,
) =>
  secretServer<{ id: string; label: string }>({
    action: "create",
    company,
    client,
    label,
    value,
  });
/** Mostrar ou copiar: fica registrado quem abriu. */
export const openNoteSecret = (
  secret: string,
  note: string | null,
  how: "view" | "copy",
) =>
  secretServer<{ id: string; label: string; value: string }>({
    action: "open",
    secret,
    note,
    how,
  });

/** O link de uma anotação: abre no Drive do cliente. */
export function clientNotePath(note: string) {
  return `/drive?nota=${note}`;
}
export function clientNoteLink(note: string) {
  return `${window.location.origin}${clientNotePath(note)}`;
}

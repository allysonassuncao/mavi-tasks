import { supabase } from "./supabase";
import { uploadToGcs } from "./gcs";
import { validateAttachment } from "./attachments";

/**
 * MAVI · skills na tela (migração 20261214090000_mavi_skills): o catálogo, o
 * editor, as versões e a aprovação; e o formato das Skills da Claude
 * (SKILL.md com nome e descrição no cabeçalho, e arquivos de referência)
 * para importar e exportar.
 */

export type SkillState = "draft" | "pending" | "approved" | "rejected" | "superseded";
export type SkillSummary = {
  id: string;
  slug: string;
  author_id: string;
  published: number | null;
  archived: boolean;
  everyone: boolean;
  team_ids: string[];
  user_ids: string[];
  except_ids: string[];
  updated_at: string;
  available: boolean;
  mine: boolean;
  current: { version: number; name: string; description: string } | null;
  latest: {
    version: number;
    name: string;
    description: string;
    state: SkillState;
    review_note: string | null;
  } | null;
  uses_30d: number;
};
export type SkillFile = { name: string; content: string; size: number };
export type SkillVersion = {
  version: number;
  name: string;
  description: string;
  instructions: string;
  state: SkillState;
  note: string | null;
  review_note: string | null;
  created_by: string;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  files: SkillFile[];
};
export type SkillDetail = {
  id: string;
  slug: string;
  author_id: string;
  published: number | null;
  archived: boolean;
  everyone: boolean;
  team_ids: string[];
  user_ids: string[];
  except_ids: string[];
  editable: boolean;
  available: boolean;
  version: SkillVersion;
  versions: (Omit<SkillVersion, "instructions" | "files" | "description"> & {
    uses: number;
  })[];
};
export type SkillDraft = {
  slug: string;
  name: string;
  description: string;
  instructions: string;
  files: { name: string; content: string }[];
  note: string;
};

export const STATE_LABELS: Record<SkillState, string> = {
  draft: "Rascunho",
  pending: "Esperando aprovação",
  approved: "Publicada",
  rejected: "Devolvida",
  superseded: "Anterior",
};

/** Os limites do banco (ai_skill_versions e ai_skill_files). */
export const LIMITS = {
  name: 80,
  description: 600,
  instructions: 40_000,
  files: 20,
  file: 200_000,
  total: 1_000_000,
};

async function rpc<T>(name: string, args: Record<string, unknown>) {
  if (!supabase) throw Error("Supabase não configurado");
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data as T;
}
export const listSkills = (company: string) =>
  rpc<SkillSummary[]>("ai_skills_list", { p_company: company });
export const getSkill = (id: string, version?: number) =>
  rpc<SkillDetail>("ai_skill_get", { p_skill: id, p_version: version ?? null });
export const saveSkill = (
  company: string,
  id: string | null,
  draft: SkillDraft,
  submit: boolean,
) =>
  rpc<{ id: string; slug: string; version: number; state: SkillState }>(
    "ai_skill_save",
    {
      p_company: company,
      p_skill: id,
      p_slug: draft.slug,
      p_name: draft.name,
      p_description: draft.description,
      p_instructions: draft.instructions,
      p_files: draft.files,
      p_note: draft.note,
      p_submit: submit,
    },
  );
/**
 * Aprovar ou devolver. Na devolução, note é o texto rico (serializado), plain
 * o texto puro (vai no aviso) e files os anexos já enviados (uploadReviewFile).
 */
export const reviewSkill = (
  id: string,
  version: number,
  approve: boolean,
  note: string,
  plain = note,
  files: string[] = [],
) =>
  rpc("ai_skill_review", {
    p_skill: id,
    p_version: version,
    p_approve: approve,
    p_note: note,
    p_plain: plain,
    p_files: files,
  });

/** Um anexo da devolução (migração 20270607090000_skill_review_files). */
export type SkillReviewFile = { id: string; name: string; path: string; size_bytes: number };
/** Envia um anexo para a devolução da versão que espera aprovação; devolve o id. */
export async function uploadReviewFile(id: string, version: number, file: File) {
  const contentType = validateAttachment(file);
  const fileId = await rpc<string>("prepare_skill_review_file", {
    p_skill: id,
    p_version: version,
    p_name: file.name,
    p_size: file.size,
  });
  try {
    await uploadToGcs({ kind: "skill-review-file", id: fileId }, file, contentType);
  } catch (error) {
    await rpc("discard_skill_review_file", { p_file: fileId }).catch(() => {});
    throw error;
  }
  await rpc("confirm_skill_review_file", { p_file: fileId });
  return fileId;
}
export const reviewFiles = (id: string, version: number) =>
  rpc<SkillReviewFile[]>("skill_review_files", { p_skill: id, p_version: version });
export const restoreSkill = (id: string, version: number) =>
  rpc<number>("ai_skill_restore", { p_skill: id, p_version: version });
export const setSkillAudience = (
  id: string,
  a: { everyone: boolean; team_ids: string[]; user_ids: string[]; except_ids: string[] },
) =>
  rpc("ai_skill_set_audience", {
    p_skill: id,
    p_everyone: a.everyone,
    p_teams: a.team_ids,
    p_users: a.user_ids,
    p_except: a.except_ids,
  });
export const archiveSkill = (id: string, archived: boolean) =>
  rpc("ai_skill_archive", { p_skill: id, p_archived: archived });
export const deleteSkill = (id: string) => rpc("ai_skill_delete", { p_skill: id });
export const skillReviewCount = (company: string) =>
  rpc<number>("ai_skill_review_count", { p_company: company });
/** O catálogo de quem está logado (para escolher na caixa de mensagem). */
export const skillCatalog = (company: string) =>
  rpc<{ slug: string; version: number; name: string; description: string }[]>(
    "ai_skill_catalog",
    { p_company: company },
  );

// ------------------------------------------------------------ formato
/** O identificador a partir do nome: "Relatório mensal" → "relatorio-mensal". */
export function slugify(name: string) {
  return (
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63)
      .replace(/-+$/, "") || "skill"
  );
}
export const validSlug = (slug: string) => /^[a-z0-9][a-z0-9-]{1,62}$/.test(slug);
/** Um nome de arquivo que o banco aceita (pastas com "/"). */
export function cleanFileName(name: string) {
  return name
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p && p !== "." && p !== "..")
    .map((p) =>
      p
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^A-Za-z0-9._ ()-]/g, "-"),
    )
    .join("/")
    .slice(-120)
    .replace(/^\/+/, "");
}

/** O que vier entre aspas ou não, sem as aspas. */
const unquote = (v: string) => v.trim().replace(/^(["'])([\s\S]*)\1$/, "$2").trim();

/**
 * Lê um SKILL.md: o cabeçalho (--- name / description ---) e as instruções.
 * Sem cabeçalho, a primeira linha "# Título" vira o nome.
 */
export function parseSkillMd(text: string) {
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = src.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta: Record<string, string> = {};
  let body = src;
  if (m) {
    body = m[2];
    let key = "";
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (kv) {
        key = kv[1].toLowerCase();
        meta[key] = kv[2] === "|" || kv[2] === ">" ? "" : kv[2];
      } else if (key && /^\s+/.test(line)) meta[key] = `${meta[key]} ${line.trim()}`.trim();
    }
  }
  // No formato da Claude, "name" é o identificador (relatorio-mensal); o
  // nome de mostrar vem de "title", do primeiro "# Título" ou do identificador.
  const raw = unquote(meta.name ?? "");
  const slug = validSlug(raw) ? raw : "";
  const heading = body.match(/^\s*#\s+(.+)\n/)?.[1].trim() ?? "";
  const pretty = slug ? slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, " ") : "";
  const name = unquote(meta.title ?? "") || (slug ? heading || pretty : raw || heading);
  return {
    slug,
    name: name.slice(0, LIMITS.name),
    description: unquote(meta.description ?? "").slice(0, LIMITS.description),
    instructions: body.trim(),
  };
}

/** O SKILL.md de uma skill (para baixar e levar para outro lugar). */
export function skillMd(s: { slug: string; name: string; description: string; instructions: string }) {
  const yaml = (v: string) => JSON.stringify(v.replace(/\s+/g, " ").trim());
  return `---\nname: ${s.slug}\ntitle: ${yaml(s.name)}\ndescription: ${yaml(s.description)}\n---\n\n${s.instructions.trim()}\n`;
}

const TEXT_EXT = /\.(md|markdown|txt|csv|tsv|json|ya?ml|html?|xml|js|ts|py|sql|css|ini|toml)$/i;
const DOC_KIND: [RegExp, string][] = [
  [/\.pdf$/i, "pdf"],
  [/\.docx$/i, "docx"],
  [/\.pptx$/i, "pptx"],
  [/\.xlsx$/i, "xlsx"],
];
/** O tipo que o leitor de texto entende (null: não dá para ler). */
export function fileKind(name: string) {
  if (TEXT_EXT.test(name)) return "text";
  return DOC_KIND.find(([re]) => re.test(name))?.[1] ?? null;
}

/** O texto de um arquivo de referência (PDF e Office viram texto). */
export async function readReference(name: string, bytes: Uint8Array) {
  const kind = fileKind(name);
  if (!kind) throw Error(`“${name}”: use arquivos de texto, PDF, Word, PowerPoint ou Excel.`);
  if (kind === "text") return new TextDecoder().decode(bytes);
  const { extractFileText } = await import("../api/_ai-extract");
  const out = await extractFileText(kind, bytes, name);
  if (out.status !== "done") throw Error(`“${name}”: não foi possível ler o texto do arquivo.`);
  return out.pages
    .map((p) => (p.label ? `## ${p.label}\n${p.text}` : p.text))
    .join("\n\n")
    .trim();
}

/**
 * Uma skill no formato da Claude: um .zip com o SKILL.md (na raiz ou numa
 * pasta) e os arquivos ao lado, ou só o SKILL.md. Scripts entram como texto
 * de referência (a MAVI não roda código).
 */
export async function importSkill(file: File): Promise<{
  draft: Omit<SkillDraft, "note" | "slug"> & { slug: string };
  skipped: string[];
}> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (/\.(md|markdown)$/i.test(file.name)) {
    const parsed = parseSkillMd(new TextDecoder().decode(bytes));
    return {
      draft: { ...parsed, slug: parsed.slug || slugify(parsed.name || file.name), files: [] },
      skipped: [],
    };
  }
  if (!/\.zip$/i.test(file.name) && !/\.skill$/i.test(file.name))
    throw Error("Importe um SKILL.md ou um .zip com a pasta da skill.");
  const { unzipSync } = await import("fflate");
  const entries = unzipSync(bytes);
  const names = Object.keys(entries).filter((n) => !n.endsWith("/") && !/(^|\/)(__MACOSX|\.)/.test(n));
  const main = names
    .filter((n) => /(^|\/)SKILL\.md$/i.test(n))
    .sort((a, b) => a.split("/").length - b.split("/").length)[0];
  if (!main) throw Error("O .zip não tem um SKILL.md.");
  const root = main.slice(0, main.length - "SKILL.md".length);
  const parsed = parseSkillMd(new TextDecoder().decode(entries[main]));
  const files: SkillDraft["files"] = [];
  const skipped: string[] = [];
  for (const n of names) {
    if (n === main || !n.startsWith(root)) continue;
    const rel = cleanFileName(n.slice(root.length));
    if (!rel) continue;
    if (files.length >= LIMITS.files) {
      skipped.push(`${rel} (passou de ${LIMITS.files} arquivos)`);
      continue;
    }
    try {
      const content = await readReference(rel, entries[n]);
      if (content.length > LIMITS.file) skipped.push(`${rel} (texto grande demais)`);
      else files.push({ name: rel, content });
    } catch {
      skipped.push(`${rel} (não é texto)`);
    }
  }
  const folder = root.replace(/\/$/, "").split("/").pop() ?? "";
  return {
    draft: {
      ...parsed,
      slug: parsed.slug || slugify(folder || parsed.name || file.name),
      files,
    },
    skipped,
  };
}

// ------------------------------------------------------------ validador e assistente
/**
 * A MAVI revisa a qualidade da skill e ajuda a criar (ação "skill-mavi" de
 * /api/drive, api/_skill-coach.ts). Nada é gravado lá: a tela mostra, a
 * pessoa aplica e só depois salva.
 */
export type CheckKind = "include" | "fix" | "change" | "improve" | "remove";
export type CheckItem = {
  id: string;
  kind: CheckKind;
  severity: "high" | "medium" | "low";
  target: "name" | "description" | "instructions" | "file";
  file?: string;
  title: string;
  why: string;
  before?: string;
  anchor?: string;
  after?: string;
};
export type SkillCheck = {
  verdict: "great" | "good" | "needs_work";
  summary: string;
  items: CheckItem[];
  model: string;
};
export type CoachMessage = { role: "user" | "assistant"; content: string };
export type CoachReply = {
  reply: string;
  question?: { text: string; options: string[]; multiple: boolean };
  draft?: { name?: string; description?: string; instructions?: string };
  files?: { name: string; content?: string; remove?: boolean }[];
  ready: boolean;
  model: string;
};

export const CHECK_KINDS: Record<CheckKind, string> = {
  include: "Incluir",
  fix: "Corrigir",
  change: "Alterar",
  improve: "Melhorar",
  remove: "Remover",
};
export const VERDICTS: Record<SkillCheck["verdict"], string> = {
  great: "Muito boa",
  good: "Boa, com ajustes",
  needs_work: "Precisa de ajustes",
};

async function skillMavi<T>(body: Record<string, unknown>): Promise<T> {
  const token = supabase ? (await supabase.auth.getSession()).data.session?.access_token : undefined;
  const res = await fetch("/api/drive", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ action: "skill-mavi", ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(data.error ?? "A MAVI não conseguiu responder agora.");
  return data as T;
}
const skillBody = (d: SkillDraft) => ({
  slug: d.slug,
  name: d.name,
  description: d.description,
  instructions: d.instructions,
  files: d.files,
});
export const checkSkill = (company: string, draft: SkillDraft, origin: "import" | "submit" | "manual") =>
  skillMavi<SkillCheck>({ company, mode: "review", origin, skill: skillBody(draft) });
export const coachSkill = (company: string, messages: CoachMessage[], draft: SkillDraft) =>
  skillMavi<CoachReply>({ company, mode: "coach", messages, skill: skillBody(draft) });

/** O que a revisão leu: mudou isto, a revisão ficou velha. */
export const checkKey = (d: SkillDraft) =>
  JSON.stringify([d.name.trim(), d.description.trim(), d.instructions, d.files.map((f) => [f.name, f.content])]);

/** O que muda num campo ou arquivo: o valor antes (para desfazer). */
export type CheckUndo =
  | { target: "name" | "description" | "instructions"; value: string }
  | { target: "file"; name: string; content: string | null };

const insert = (text: string, anchor: string | undefined, add: string) => {
  const at = anchor ? text.indexOf(anchor) : -1;
  if (at < 0) return `${text.replace(/\s+$/, "")}\n\n${add.trim()}\n`;
  const end = at + anchor!.length;
  const rest = text.slice(end).replace(/^\s+/, "");
  return `${text.slice(0, end).replace(/\s+$/, "")}\n\n${add.trim()}\n${rest ? `\n${rest}` : ""}`;
};
function edit(text: string, item: CheckItem): string | null {
  if (item.before) {
    if (!text.includes(item.before)) return null;
    return text.replace(item.before, () => item.after ?? "").replace(/\n{3,}/g, "\n\n");
  }
  if (!item.after?.trim()) return null;
  return insert(text, item.anchor, item.after);
}

/**
 * Aplica um ponto da revisão. null: não dá (sem texto pronto, ou o trecho
 * mudou desde a revisão).
 */
export function applyCheck(draft: SkillDraft, item: CheckItem): { draft: SkillDraft; undo: CheckUndo } | null {
  if (item.target === "name" || item.target === "description") {
    if (!item.after?.trim()) return null;
    const max = item.target === "name" ? LIMITS.name : LIMITS.description;
    return {
      draft: { ...draft, [item.target]: item.after.trim().slice(0, max) },
      undo: { target: item.target, value: draft[item.target] },
    };
  }
  if (item.target === "instructions") {
    const next = edit(draft.instructions, item);
    if (next === null || next === draft.instructions) return null;
    return {
      draft: { ...draft, instructions: next.slice(0, LIMITS.instructions) },
      undo: { target: "instructions", value: draft.instructions },
    };
  }
  const name = item.file ? cleanFileName(item.file) : "";
  if (!name) return null;
  const file = draft.files.find((f) => f.name === name);
  const undo: CheckUndo = { target: "file", name, content: file?.content ?? null };
  if (item.kind === "remove" && !item.before) {
    if (!file) return null;
    return { draft: { ...draft, files: draft.files.filter((f) => f.name !== name) }, undo };
  }
  if (!file) {
    if (!item.after?.trim() || draft.files.length >= LIMITS.files) return null;
    return { draft: { ...draft, files: [...draft.files, { name, content: item.after }] }, undo };
  }
  const next = edit(file.content, item);
  if (next === null || next === file.content) return null;
  return {
    draft: { ...draft, files: draft.files.map((f) => (f.name === name ? { name, content: next } : f)) },
    undo,
  };
}
export function undoCheck(draft: SkillDraft, undo: CheckUndo): SkillDraft {
  if (undo.target !== "file") return { ...draft, [undo.target]: undo.value };
  const rest = draft.files.filter((f) => f.name !== undo.name);
  if (undo.content === null) return { ...draft, files: rest };
  const i = draft.files.findIndex((f) => f.name === undo.name);
  const files = [...rest];
  files.splice(i < 0 ? files.length : i, 0, { name: undo.name, content: undo.content });
  return { ...draft, files };
}

/** O que o assistente mudou, aplicado à skill (os campos inteiros). */
export function applyCoach(draft: SkillDraft, reply: Pick<CoachReply, "draft" | "files">, isNew: boolean): SkillDraft {
  const d = reply.draft ?? {};
  let files = draft.files;
  for (const f of reply.files ?? []) {
    const name = cleanFileName(f.name);
    if (!name) continue;
    if (f.remove) files = files.filter((x) => x.name !== name);
    else if (f.content?.trim()) {
      const content = f.content.slice(0, LIMITS.file);
      files = files.some((x) => x.name === name)
        ? files.map((x) => (x.name === name ? { name, content } : x))
        : files.length < LIMITS.files
          ? [...files, { name, content }]
          : files;
    }
  }
  const name = d.name?.trim().slice(0, LIMITS.name);
  return {
    ...draft,
    ...(name ? { name, ...(isNew ? { slug: slugify(name) } : {}) } : {}),
    ...(d.description?.trim() ? { description: d.description.trim().slice(0, LIMITS.description) } : {}),
    ...(d.instructions?.trim() ? { instructions: d.instructions.trim().slice(0, LIMITS.instructions) } : {}),
    files,
  };
}

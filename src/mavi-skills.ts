import { supabase } from "./supabase";

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
export const reviewSkill = (id: string, version: number, approve: boolean, note: string) =>
  rpc("ai_skill_review", { p_skill: id, p_version: version, p_approve: approve, p_note: note });
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

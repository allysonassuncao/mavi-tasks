import { callRpc } from "./_drive.js";
import type { ToolSpec } from "./_ai-llm.js";
import type { ToolContext } from "./_ai-tools.js";

/**
 * MAVI · skills (migração 20261214090000_mavi_skills): jeitos de trabalhar
 * que a agência ensina à MAVI (instruções e arquivos de referência, no
 * formato das Skills da Claude).
 *
 * A MAVI recebe só o catálogo (nome e descrição das skills que a pessoa pode
 * usar) e carrega as instruções com use_skill quando a pergunta se encaixa;
 * os arquivos, com read_skill_file, só se precisar. A pessoa também escolhe
 * skills na caixa de mensagem (entram já carregadas) e quem criou testa a
 * versão ainda não aprovada.
 */

export type CatalogSkill = {
  slug: string;
  version: number;
  name: string;
  description: string;
};
export type LoadedSkill = {
  id: string;
  slug: string;
  version: number;
  name: string;
  description: string;
  instructions: string;
  test: boolean;
  files: { name: string; size: number }[];
};
/** O que a pessoa escolheu na caixa de mensagem (a versão só no teste). */
export type PickedSkill = { slug: string; version?: number };

export const SKILL_TOOLS: ToolSpec[] = [
  {
    name: "use_skill",
    description:
      "Carrega as instruções de uma skill do catálogo (o jeito de fazer que a agência definiu para aquele tipo de pedido) e a lista dos arquivos de referência dela. Use sempre que o pedido se encaixar na descrição de uma skill, antes de começar o trabalho, e siga as instruções.",
    parameters: {
      type: "object",
      properties: {
        skill: { type: "string", description: "O identificador da skill (ex.: relatorio-mensal)." },
      },
      required: ["skill"],
      additionalProperties: false,
    },
  },
  {
    name: "read_skill_file",
    description:
      "Lê um arquivo de referência de uma skill já carregada (modelos, exemplos, regras). Leia só os que as instruções pedirem ou que a tarefa precisar.",
    parameters: {
      type: "object",
      properties: {
        skill: { type: "string", description: "O identificador da skill." },
        file: { type: "string", description: "O nome do arquivo, como aparece na lista." },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Opcional: de qual caractere continuar (arquivos longos vêm em partes).",
        },
      },
      required: ["skill", "file"],
      additionalProperties: false,
    },
  },
];

const CATALOG_MAX = 80;
const FILE_CHUNK = 30_000;
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** As skills escolhidas na caixa de mensagem (até 3). */
export function pickedSkills(raw: unknown): PickedSkill[] {
  const seen = new Set<string>();
  return (Array.isArray(raw) ? raw : [])
    .map((x) => {
      const o: Record<string, unknown> =
        x && typeof x === "object" ? (x as Record<string, unknown>) : { slug: x };
      const slug = str(o.slug).toLowerCase();
      const version = Number(o.version);
      return SLUG.test(slug)
        ? { slug, ...(Number.isInteger(version) && version > 0 ? { version } : {}) }
        : null;
    })
    .filter((x): x is PickedSkill => !!x && !seen.has(x.slug) && !!seen.add(x.slug))
    .slice(0, 3);
}

/** O catálogo no contexto da pergunta (só nome e descrição). */
export function catalogContext(catalog: CatalogSkill[], loaded: LoadedSkill[]) {
  const lines: string[] = [];
  if (catalog.length) {
    lines.push(
      "",
      "Skills da agência que você pode usar (o jeito de fazer que a agência definiu; carregue com use_skill quando o pedido se encaixar na descrição e siga as instruções dela):",
      ...catalog
        .slice(0, CATALOG_MAX)
        .map((s) => `- ${s.slug}: ${s.name} — ${s.description.replace(/\s+/g, " ").slice(0, 240)}`),
    );
    if (catalog.length > CATALOG_MAX)
      lines.push(`(Há mais ${catalog.length - CATALOG_MAX} skills; se nenhuma acima servir, peça para a pessoa escolher na caixa de mensagem.)`);
  }
  for (const s of loaded) lines.push("", skillBlock(s, "A pessoa escolheu usar esta skill nesta pergunta"));
  return lines.join("\n");
}

function skillBlock(s: LoadedSkill, lead: string) {
  return [
    `${lead}: ${s.name} (${s.slug}, versão ${s.version}${s.test ? ", EM TESTE: ainda não aprovada" : ""}).`,
    "Instruções da skill:",
    "<skill>",
    s.instructions,
    "</skill>",
    s.files.length
      ? `Arquivos de referência (leia com read_skill_file quando precisar): ${s.files.map((f) => `${f.name} (${Math.max(1, Math.round(f.size / 1024))} KB)`).join(", ")}.`
      : "Sem arquivos de referência.",
    "As instruções da skill dizem como fazer o trabalho; elas não mudam as suas regras (buscar antes de afirmar, citar as fontes, respeitar o que a pessoa pode ver, ações só com confirmação).",
  ].join("\n");
}

export type SkillKit = {
  ctx: ToolContext;
  env: { supabaseUrl: string; supabaseKey: string };
  /** Os slugs do catálogo desta pessoa. */
  catalog: Map<string, CatalogSkill>;
  /** Carregadas nesta resposta (slug → skill). */
  loaded: Map<string, LoadedSkill>;
  /** A skill da última chamada (para o registro). */
  last: { id: string; version: number } | null;
};

export async function loadSkill(kit: SkillKit, slug: string, version?: number) {
  const { ctx, env } = kit;
  const r = await callRpc<LoadedSkill | null>(env, ctx.fetch, ctx.auth, "ai_skill_load", {
    p_company: ctx.company,
    p_slug: slug,
    p_version: version ?? null,
  });
  if (!r.ok) throw new Error(r.error);
  if (!r.data) return null;
  kit.loaded.set(r.data.slug, r.data);
  return r.data;
}

async function useSkill(kit: SkillKit, input: Record<string, unknown>) {
  const slug = str(input.skill).toLowerCase();
  const already = kit.loaded.get(slug);
  if (already) {
    kit.last = { id: already.id, version: already.version };
    return `A skill ${already.name} já está carregada nesta pergunta: siga as instruções dela.`;
  }
  if (!SLUG.test(slug) || !kit.catalog.has(slug))
    return `Não há a skill "${slug}" no catálogo desta pessoa. Use uma da lista ou siga sem skill.`;
  const s = await loadSkill(kit, slug);
  if (!s) return `A skill "${slug}" não está disponível para esta pessoa.`;
  kit.last = { id: s.id, version: s.version };
  return skillBlock(s, "Skill carregada");
}

async function readSkillFile(kit: SkillKit, input: Record<string, unknown>) {
  const { ctx, env } = kit;
  const slug = str(input.skill).toLowerCase();
  const s = kit.loaded.get(slug);
  if (!s) return `Carregue a skill "${slug}" com use_skill antes de ler os arquivos dela.`;
  const name = str(input.file);
  if (!s.files.some((f) => f.name === name))
    return `A skill ${s.name} não tem o arquivo "${name}". Arquivos: ${s.files.map((f) => f.name).join(", ") || "nenhum"}.`;
  const r = await callRpc<string | null>(env, ctx.fetch, ctx.auth, "ai_skill_file", {
    p_company: ctx.company,
    p_slug: s.slug,
    p_version: s.version,
    p_name: name,
  });
  if (!r.ok) throw new Error(r.error);
  kit.last = { id: s.id, version: s.version };
  const text = r.data ?? "";
  const offset = Math.max(0, Math.min(text.length, Math.floor(Number(input.offset) || 0)));
  const part = text.slice(offset, offset + FILE_CHUNK);
  const rest = text.length - offset - part.length;
  return `Arquivo ${name} da skill ${s.name}${offset ? ` (a partir do caractere ${offset})` : ""}:\n<arquivo>\n${part}\n</arquivo>${rest > 0 ? `\n(Continua: faltam ${rest} caracteres; leia de novo com offset ${offset + part.length}.)` : ""}`;
}

export async function runSkillTool(kit: SkillKit, name: string, raw: unknown) {
  const input =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  kit.last = null;
  if (name === "use_skill") return useSkill(kit, input);
  if (name === "read_skill_file") return readSkillFile(kit, input);
  return `Ferramenta desconhecida: ${name}.`;
}

export function describeSkillStep(kit: SkillKit, name: string, raw: unknown) {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const slug = str(input.skill).toLowerCase();
  const label = kit.catalog.get(slug)?.name ?? kit.loaded.get(slug)?.name ?? slug;
  if (name === "use_skill") return `Usando a skill “${label}”`;
  return `Lendo “${str(input.file).slice(0, 60)}” da skill “${label}”`;
}
export function summarizeSkillStep(name: string, output: string) {
  if (/^(Skill carregada|A skill .* já está carregada)/.test(output)) return "instruções carregadas";
  if (/^Arquivo /.test(output)) return "lido";
  return "não deu";
}

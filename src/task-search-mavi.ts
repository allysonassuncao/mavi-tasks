/**
 * A MAVI na Busca avançada (ação "task-search" de /api/drive, funcionalidade
 * 'task_search' do Painel da MAVI): ela lê o pedido, preenche os filtros da
 * tela e devolve os termos e o vetor do assunto para a busca no banco
 * (public.search_task_rows_mavi). Estas são as regras que o navegador e o
 * servidor compartilham.
 */

/** Os filtros da tela que a MAVI preenche ("" limpa; ausente mantém). */
export const MAVI_FILTER_KEYS = [
  "client",
  "project",
  "assignee",
  "creator",
  "status",
  "from",
  "to",
] as const;
export type MaviFilterKey = (typeof MAVI_FILTER_KEYS)[number];
export type MaviSearchFilters = Partial<Record<MaviFilterKey, string>> & {
  priority?: boolean;
  /** Onde procurar os termos ("title", "description", "comments"). */
  fields?: string[];
};

/** O que a MAVI entendeu de um pedido. */
export type MaviSearch = {
  /** O pedido como a pessoa escreveu. */
  query: string;
  /** Palavras e expressões procuradas no texto (qualquer uma). */
  terms: string[];
  /** O vetor do assunto ("[0.1,…]"), para a busca por significado. */
  embedding: string | null;
  /** O que ela entendeu, numa frase. */
  summary: string;
  /** Os filtros que ela escolheu (os outros ficam como estavam). */
  filters: MaviSearchFilters;
  /** O modelo que respondeu. */
  model?: string;
};

export const MAVI_SEARCH_MAX_TERMS = 10;
/** Quanto a tela espera pela MAVI antes de buscar pelo termo exato. */
export const MAVI_SEARCH_WAIT_MS = 25_000;

/** Minúsculas e sem acentos (como mavi_private.fold), para comparar. */
export function termKey(text: string) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Os termos limpos: sem repetidos, de 2 a 40 caracteres, no máximo 10. */
export function cleanTerms(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const term = item.replace(/["“”*`]/g, "").replace(/\s+/g, " ").trim();
    const key = termKey(term);
    if (term.length < 2 || term.length > 40 || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= MAVI_SEARCH_MAX_TERMS) break;
  }
  return out;
}

/** O parâmetro da URL de cada filtro da Busca avançada. */
export const MAVI_PARAM: Record<MaviFilterKey, string> = {
  client: "cli",
  project: "proj",
  assignee: "resp",
  creator: "criador",
  status: "situacao",
  from: "de",
  to: "ate",
};
const SEARCH_FIELD_IDS = ["title", "description", "comments"];

/**
 * Uma busca já montada pela MAVI da conversa (bolinha e módulo MAVI, a
 * ferramenta find_tasks): a Busca avançada abre com ela sem perguntar de
 * novo; só o vetor do assunto é refeito.
 */
export type PreparedSearch = { terms: string[]; topic: string; summary: string };

/** ?termo=…&mavi=…&cli=… da Busca avançada com a busca da conversa. */
export function searchLinkQuery(input: {
  request: string;
  prepared: PreparedSearch;
  filters: MaviSearchFilters;
}) {
  const q = new URLSearchParams();
  q.set("termo", input.request.replace(/\s+/g, " ").trim().slice(0, 200));
  q.set(
    "mavi",
    JSON.stringify({
      t: cleanTerms(input.prepared.terms),
      a: input.prepared.topic.slice(0, 300),
      s: input.prepared.summary.slice(0, 300),
    }),
  );
  const f = input.filters;
  for (const k of MAVI_FILTER_KEYS) if (f[k]) q.set(MAVI_PARAM[k], f[k]!);
  if (f.priority) q.set("prioritarias", "1");
  const fields = (f.fields ?? []).filter((x) => SEARCH_FIELD_IDS.includes(x));
  if (fields.length && fields.length < SEARCH_FIELD_IDS.length) q.set("em", fields.join(","));
  return q.toString();
}

/** O "mavi" da URL lido de volta (null: ausente ou estragado). */
export function readPrepared(raw: unknown): PreparedSearch | null {
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const terms = cleanTerms(d.t ?? d.terms);
  const pick = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 300) : "");
  const topic = pick(d.a ?? d.topic);
  if (!terms.length && topic.length < 3) return null;
  return { terms, topic, summary: pick(d.s ?? d.summary) };
}

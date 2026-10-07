import type { ToolSpec } from "./_ai-llm.js";

/**
 * MAVI · roteador de modelos, fase 3: ferramentas por intenção.
 *
 * Com muitas conexões (MCP) e contas de anúncio, uma pergunta chegava a
 * levar mais de cem ferramentas, e o modelo escolhe pior entre tantas. As
 * da própria MAVI e as dos poderes vão sempre; as das conexões e das contas
 * de anúncio vão quando combinam com o pedido (palavras da pergunta e das
 * últimas mensagens, o serviço citado pelo nome) ou foram usadas há pouco
 * nesta conversa. As outras continuam ao alcance: find_tools procura entre
 * elas (e entre as skills) e use_tool chama a escolhida.
 *
 * Tudo aqui é puro (sem rede).
 */

/** Abaixo disso, todas vão (não vale a pena esconder). */
export const DEFER_FROM = 20;
/** Quantas das que combinam vão de cara. */
export const OFFER_MAX = 16;

const STOP = new Set(
  "a o as os um uma uns umas de da do das dos em no na nos nas por para pra com sem que se e ou mas como mais menos muito muita ja eu voce ela ele nos eles elas me te lhe isso isto esse essa este esta aquele aquela meu minha seu sua nosso nossa qual quais quando onde quem porque pois ate sobre entre depois antes agora hoje ontem tem ter foi ser sao esta estao fazer faca pode poderia quero preciso gostaria favor ver veja mostre mostra me traga".split(
    " ",
  ),
);

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

/** As palavras que importam (sem acento, sem as vazias), com o radical das longas. */
export function terms(text: string) {
  const out = new Set<string>();
  for (const w of fold(text.replace(/([a-z])([A-Z])/g, "$1 $2")).split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(w);
    // Campanha/campanhas, anúncio/anúncios, relatório/relatórios.
    if (w.length >= 6) out.add(w.slice(0, 5));
  }
  return out;
}

/** O quanto um texto combina com as palavras do pedido. */
export function overlap(query: Set<string>, text: string) {
  if (!query.size) return 0;
  const t = terms(text);
  let n = 0;
  for (const w of query) if (t.has(w)) n++;
  return n;
}

/** O serviço da ferramenta da conexão ("[Canva] …" na descrição). */
const serverOf = (t: ToolSpec) => /^\[([^\]]+)\]/.exec(t.description)?.[1] ?? "";

export type ToolChoice = {
  offered: ToolSpec[];
  deferred: ToolSpec[];
  /** Para o registro do roteador. */
  why: string;
};

/**
 * Escolhe as ferramentas da vez. `deferrable` diz quais podem ficar de fora
 * (conexões e contas de anúncio); `recent`, as que esta conversa usou há
 * pouco (vão sempre).
 */
export function selectTools(input: {
  tools: ToolSpec[];
  deferrable: (name: string) => boolean;
  /** A pergunta e as últimas mensagens da pessoa. */
  text: string;
  recent?: ReadonlySet<string>;
  max?: number;
  from?: number;
}): ToolChoice {
  const pool = input.tools.filter((t) => input.deferrable(t.name));
  const fixed = input.tools.filter((t) => !input.deferrable(t.name));
  if (pool.length <= (input.from ?? DEFER_FROM))
    return { offered: input.tools, deferred: [], why: "" };
  const q = terms(input.text);
  const folded = fold(input.text);
  const scored = pool.map((t) => {
    const server = serverOf(t);
    let score = overlap(q, `${t.name.replace(/^mcp_/, "")} ${t.description}`);
    // O serviço citado pelo nome: todas as dele combinam.
    if (server && fold(server).length >= 3 && folded.includes(fold(server))) score += 10;
    if (input.recent?.has(t.name)) score += 100;
    return { t, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const max = input.max ?? OFFER_MAX;
  const chosen = scored.filter((x, i) => x.score >= 100 || (x.score > 0 && i < max)).map((x) => x.t);
  const keep = new Set(chosen.map((t) => t.name));
  const deferred = pool.filter((t) => !keep.has(t.name));
  return {
    offered: [...fixed, ...chosen],
    deferred,
    why: `${chosen.length} de ${pool.length} ferramentas de conexões e anúncios pelo pedido`,
  };
}

/** Ordena pelo que combina com o pedido (as skills do catálogo, por exemplo). */
export function byRelevance<T>(items: T[], text: string, key: (x: T) => string): T[] {
  const q = terms(text);
  return items
    .map((x, i) => ({ x, i, s: overlap(q, key(x)) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((r) => r.x);
}

export const FIND_TOOLS: ToolSpec = {
  name: "find_tools",
  description:
    "Procura, entre as ferramentas das conexões (MCP) e das contas de anúncio que não vieram nesta resposta e entre as skills da agência, as que servem para o pedido. Devolve o nome, o que faz e os parâmetros; para usar uma ferramenta, chame use_tool com o nome e a entrada; para uma skill, use_skill.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "O que você precisa fazer ou o serviço (ex.: \"criar design no Canva\", \"leads do formulário\")." },
    },
    required: ["query"],
  },
};

export const USE_TOOL: ToolSpec = {
  name: "use_tool",
  description:
    "Chama uma ferramenta que find_tools encontrou, pelo nome exato, com a entrada no formato dos parâmetros que ela mostrou.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "O nome exato da ferramenta (de find_tools)." },
      input: { type: "object", description: "A entrada da ferramenta.", additionalProperties: true },
    },
    required: ["name"],
  },
};

export const TOOLSET_RULES = `
Ferramentas sob demanda: para manter o foco, só parte das ferramentas das conexões e das contas de anúncio veio nesta resposta. Se o pedido precisar de um serviço conectado ou de dados de anúncio que as ferramentas acima não cobrem, use find_tools e depois use_tool; não diga que não consegue sem procurar antes.`;

/** O resultado de find_tools: as que combinam, com os parâmetros. */
export function findTools(
  query: string,
  deferred: ToolSpec[],
  skills: { slug: string; name: string; description: string }[] = [],
) {
  const q = terms(query);
  const tools = deferred
    .map((t) => ({ t, s: overlap(q, `${t.name.replace(/^mcp_/, "")} ${t.description}`) + (fold(query).includes(fold(serverOf(t)) || "\u0000") ? 5 : 0) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 8);
  const found = skills
    .map((k) => ({ k, s: overlap(q, `${k.slug} ${k.name} ${k.description}`) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 5);
  if (!tools.length && !found.length)
    return `Nada encontrado para “${query}”. Ferramentas disponíveis sob demanda: ${deferred
      .slice(0, 40)
      .map((t) => t.name)
      .join(", ")}${deferred.length > 40 ? "…" : ""}.`;
  const parts: string[] = [];
  if (tools.length)
    parts.push(
      "Ferramentas (chame com use_tool {name, input}):",
      ...tools.map(
        ({ t }) => `- ${t.name}: ${t.description.slice(0, 400)}\n  parâmetros: ${JSON.stringify(t.parameters).slice(0, 1500)}`,
      ),
    );
  if (found.length)
    parts.push("Skills (carregue com use_skill):", ...found.map(({ k }) => `- ${k.slug}: ${k.name} — ${k.description.slice(0, 240)}`));
  return parts.join("\n");
}

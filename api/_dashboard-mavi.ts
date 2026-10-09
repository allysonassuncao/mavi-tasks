import { callRpc } from "./_drive.js";
import { llmFriendlyError, outputText, type LlmAdapter, type ToolSpec } from "./_ai-llm.js";
import { adapterFor, featureProvider } from "./_ai-providers.js";
import { routedLlm } from "./_ai-router.js";
import type { AiDeps, AiEnv } from "./_ai.js";
import type { Meter } from "./_social-leads.js";
import {
  attributionOptions,
  checkSpec,
  defaultSize,
  filterLabels,
  groupOptions,
  personNote,
  rangeOptions,
  sources,
  vizOptions,
  type Panel,
  type PanelSpec,
  type RangePreset,
  type Source,
  isCsSource,
  isCsSpec,
} from "../src/dashboard-catalog.js";
import { runCsPanel } from "../src/cs-sources.js";
import type { CsData } from "../src/cs-engine.js";

/**
 * MAVI · Dashboards (ação "dashboard-mavi" de /api/drive, funcionalidade
 * 'dashboard_builder' do Painel da MAVI). A conversa ao lado do dashboard:
 * a pessoa descreve o que quer ver e a MAVI pergunta o que falta, confere os
 * nomes (clientes, produtos, equipes, pessoas…) e roda a prévia de cada
 * painel antes de propor. Ela cria um dashboard novo, adiciona, altera ou
 * remove painéis e explica o que um painel mostra.
 *
 * Nada é gravado aqui: a proposta volta para a tela, que mostra a prévia com
 * os dados reais; a pessoa aplica e depois salva (save_dashboard confere de
 * novo). As consultas rodam com o login de quem conversa (dashboard_preview
 * e as listas respeitam o que a pessoa pode ver).
 */

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export type DashMessage = { role: "user" | "assistant"; content: string };
export type DashQuestion = { text: string; options: string[]; multiple: boolean };
export type ProposedPanel = {
  /** Só ao alterar: o painel que muda. */
  id?: string;
  title: string;
  w: number;
  h: number;
  spec: PanelSpec;
  /** Em uma frase, o que o painel mostra (aparece na proposta). */
  why: string;
};
export type DashProposal = {
  name?: string;
  description?: string;
  range?: RangePreset;
  add: ProposedPanel[];
  update: ProposedPanel[];
  remove: string[];
};
export type DashReply = {
  reply: string;
  question?: DashQuestion;
  proposal?: DashProposal;
  /** O que a MAVI propôs e não passou na conferência. */
  dropped?: string[];
  ready: boolean;
  model: string;
};
export type DashState = {
  name: string;
  description: string;
  panels: Panel[];
  range: { from: string; to: string; preset: string };
  filters: { clients?: string[]; products?: string[]; teams?: string[]; people?: string[] };
  /** O painel de onde a pessoa abriu a conversa. */
  focus: string | null;
  /** Dashboard ainda não salvo (criado pela conversa). */
  isNew: boolean;
};

export class DashError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------ o módulo
/** O que é cada fonte, em palavras: o que conta e quem é a "pessoa". */
const SOURCE_NOTES: Record<Source, string> = {
  tasks:
    "Uma linha por tarefa (não arquivada). Data pela criação, pelo prazo ou pela entrega. Pessoa: quem executou (veja atribuição). Métricas de entrega (prazo médio, no prazo, atraso médio, de primeira, retrabalho, acerto da MAVI/regra) só contam tarefas entregues: use dateField delivered_at nelas.",
  hours:
    "Os apontamentos de horas (cronômetro e lançamentos manuais). Pessoa: quem registrou. É a fonte das HORAS TRABALHADAS.",
  status_history:
    "Cada período em que uma tarefa ficou num status com alguém (Em andamento = progress, Devolvida = returned, Em validação = review, Alteração = rejected, Correção = correction). 'Tempo no status' é o tempo parado com a pessoa, NÃO horas trabalhadas. Pessoa: quem estava com a tarefa no status (as vezes em Devolvida contam para quem devolveu).",
  reviews:
    "As validações (cada vez que uma tarefa foi para Em validação). Aprovada = saiu entregue; reprovada = voltou para Alteração ou Correção. Pessoa: quem enviou para validação; agrupamento validator: quem validou.",
  social_leads:
    "Social Leads: decisões dos posts (aprovações e pedidos de ajuste), tempo até aprovar o plano e clientes por etapa (situação de hoje, sem período: agrupe por stage, client ou none).",
  notices: "Mural de avisos: uma linha por pessoa alcançada por um aviso. Pessoa: quem recebeu. Sem cliente nem produto.",
  temperature:
    "Termômetro: uma linha por cliente e dia, com a temperatura (0–100). Médias por cliente-dia; contagens são clientes distintos. A métrica indicator precisa do indicador (find_options kind temperature_indicator).",
  radar:
    "Radar do cliente: itens (assuntos de um cliente num tópico: problemas, promessas…). Pessoa: o responsável pelo item. 'Ocorrências' conta cada vez que o assunto apareceu.",
  due_changes: "Mudanças de prazo das tarefas, com motivo. Pessoa: quem mudou o prazo.",
  agent_costs:
    "Agentes MAVI · Custos: o que os agentes de WhatsApp gastam por dia (IA das conversas, mídias, conhecimento, análises, modelos aprovados do WhatsApp oficial, testes). R$ pela PTAX do dia. Agrupe por agent, inbox, cost_group (tipo de gasto), model, client ou time. Só administradores e gestores.",
  cs_finance:
    "Customer Success · Financeiro: os ciclos de cobrança de cada cliente por mês de competência. Faturamento efetivo desconta R$ 3 mil do 1º mês de trial (regra M1); meta e atingimento só por mês e squad. 'Cliente' é o cliente de CS.",
  cs_portfolio:
    "Customer Success · Carteira: ativos e pagantes são o retrato do fim de cada mês (sem agrupar: o último mês do período); entradas, reativações e churns contam pela data. Agrupe churns por cs_reason para os motivos.",
  cs_health:
    "Customer Success · Saúde: as notas mensais de Health Score (0–100, faixas Satisfeito/Alerta/Crítico) e a adimplência dos ciclos.",
  cs_trial:
    "Customer Success · Trial: clientes em trial por mês do trial (M1, M2, M3, M4+), graduados para Base, taxa de graduação (graduados do mês ÷ entradas de 3 meses antes) e churns por mês do trial.",
};

const unitWord = { number: "número", hours: "horas", days: "dias", percent: "%", money: "R$" } as const;

/** O catálogo como a MAVI lê: só os nomes que o módulo aceita. */
export function catalogGuide(allowed: Source[]) {
  return allowed
    .map((key) => {
      const s = sources[key];
      const groups = groupOptions.filter((g) => g.sources.includes(key)).map((g) => g.key);
      return [
        `### source "${key}" — ${s.label}`,
        SOURCE_NOTES[key],
        `Métricas: ${s.metrics
          .map((m) => `${m.key} (${m.label}; ${unitWord[m.unit]}${m.additive ? "" : "; não soma"})`)
          .join(" · ")}`,
        `dateField: ${s.dateFields.map((d) => `${d.key} (${d.label})`).join(", ")}`,
        `Filtros (field): ${s.filters.map((f) => `${f} (${filterLabels[f]})`).join(", ")}`,
        `groupBy: ${groups.join(", ")}`,
      ].join("\n");
    })
    .join("\n\n");
}

export const DASHBOARD_GUIDE = `Como funciona um dashboard:
- Um dashboard tem um nome, uma descrição, um período padrão e até 48 painéis numa grade de 12 colunas. Quem abre pode trocar o período e filtrar por clientes, produtos, equipes e pessoas (esses filtros valem para todos os painéis: não repita em cada painel o que vale para o dashboard inteiro).
- Cada painel tem um título, uma visualização (viz), um agrupamento (groupBy) e de 1 a 5 consultas (A a E). Cada consulta é uma fonte + uma métrica + a data que decide o período (dateField) + filtros próprios.
- Visualizações (${vizOptions.map((v) => `${v.key} = ${v.label}`).join(", ")}):
  - stat: um número grande (groupBy "none"), com comparação com o período anterior (compare). Ideal para os indicadores principais, no topo, de 3 em 3 colunas (4 por linha).
  - line / area / bar com groupBy "time": evolução no tempo (interval auto, day, week ou month).
  - hbar: ranking (por cliente, pessoa, equipe…), com limit (5, 10, 15, 20, 30 ou 50 maiores).
  - donut: partes de um todo com poucas categorias (status, prioridade, faixa).
  - table: várias métricas lado a lado por categoria (ex.: por pessoa: tarefas, atrasadas, horas).
- groupBy precisa servir para TODAS as consultas do painel (veja os groupBy de cada fonte). Valores: ${groupOptions.map((g) => g.key).join(", ")}.
- Fórmula (formula: {"expr": "(A - B) / A * 100", "label": "No prazo"}): calcula com as consultas (A–E, números, + - * / e parênteses); as consultas só usadas na conta levam hidden: true; com fórmula, unit costuma ser "percent" ou "number".
- unit (opcional): number, hours, days ou percent; decimals 0, 1 ou 2.
- Filtros de consulta: {"field": "client", "op": "in" | "not_in", "values": [ids]}. Os valores de client, product, project, team, person, creator, executor, previous, validator, topic e theme são IDs: ache com find_options, NUNCA invente. status usa as chaves progress, returned, review, rejected, correction, done; priority: low, normal, high, urgent; late: ["true"] ou ["false"]; severity: "0" a "3"; state: open, progress, closed; level: info, important, critical; entry_source: timer, manual.
- Pessoa nas Tarefas (attribution, só na fonte tasks): ${attributionOptions
  .map((a) => `"${a.key}" = ${a.label}: ${a.hint}`)
  .join(" ")} Sem o campo vale "roles" (o padrão, quase sempre o certo). Para "tarefas de uma pessoa", filtre por executor (todos que executaram) — continua contando depois que ela envia para validação. "Tarefas criadas por alguém" é o filtro creator.
- Horas: horas trabalhadas = fonte hours (cronômetro e apontamentos); horas estimadas = tasks.estimated_hours; tempo no status = status_history.hours (tempo parado, não é trabalho). Não confunda.
- Customer Success (fontes cs_*, só para administradores e gestores): os números do painel CS Make (faturamento com a regra M1, carteira, Health Score, trial), sempre por mês — o período conta cada mês em que toca. Um painel não mistura fontes cs_* com as outras. Os filtros dessas fontes: client (ID do cliente do MAVI), squad (ID do squad, ache com find_options kind cs_squad) e cs_kind ("TRIAL" ou "BASE").
- Tamanho (w de 1 a 12, h de 2 a 24 linhas de 64px): stat 3×3, gráficos de tempo 12×5 (ou 6×5 lado a lado), hbar/donut 6×6, table 12×6.

As fontes:
{catalog}`;

export const BUILDER_INSTRUCTIONS = `Você é a MAVI, a inteligência do sistema de gestão de uma agência de marketing. Seu nome é MAVI, no feminino. Aqui você monta Dashboards para uma pessoa do time que pode não entender nada de indicadores: ela conta o que quer acompanhar e você cria o dashboard e os painéis, seguindo exatamente as regras do módulo (abaixo). Você também adiciona, altera ou remove painéis de um dashboard que já existe e explica, em palavras simples, o que um painel mostra e de onde vem cada número.

{guide}

Como conduzir:
- Português do Brasil, simples, caloroso e curto. Nada de jargão técnico (não fale "query", "groupBy", "source", "spec"): diga "o número", "por cliente", "ao longo do tempo".
- Entenda o objetivo antes de montar: para quem é o dashboard e que decisão ele ajuda a tomar. Pergunte só o que muda o resultado e você não consegue deduzir: o período, quais clientes, produtos, equipes ou pessoas, se é por pessoa, por cliente ou no tempo, o que é "bom" para a pessoa. Uma pergunta por vez, com 2 a 5 opções curtas para clicar (multiple: true quando dá para escolher várias). No máximo 3 perguntas antes da primeira proposta; depois, siga melhorando com as respostas.
- Pedido claro (ex.: "inclui um painel de atrasadas por cliente"): proponha direto, sem perguntar.
- Antes de propor, CONFIRA:
  1. Nomes citados (clientes, produtos, equipes, pessoas, projetos, tópicos do Radar): use find_options e use os IDs que voltarem. Se houver mais de um parecido ou nenhum, pergunte com as opções encontradas.
  2. Cada painel novo ou alterado: rode preview_panel. Se der erro, corrija. Se vier vazio ou estranho (tudo zero, uma só categoria, número que não faz sentido), ajuste (outra data, outra métrica, menos filtros) ou conte à pessoa e pergunte. Não proponha painel que você não conferiu.
- Use o catálogo como ele é: só as fontes, métricas, filtros e agrupamentos listados. Se a pessoa pedir algo que o módulo não mede, diga com franqueza o que não dá e ofereça o mais próximo.
- Um dashboard bom: 3 a 4 números no topo (stat) com o que mais importa, depois a evolução no tempo, depois os detalhes (rankings e tabelas). Em geral de 4 a 12 painéis. Títulos curtos e claros, no tom da pessoa ("Tarefas atrasadas", "Horas por cliente").
- Ao alterar um painel que já existe, devolva o painel inteiro em update (com o mesmo id), mantendo o que a pessoa não pediu para mudar. Para tirar: o id em remove. Ao criar um dashboard novo, dê também name (e description curta).
- Explicar um painel: responda em reply, sem proposta, dizendo o que conta, de que data, para quem conta cada pessoa e o que os filtros fazem. Pode rodar preview_panel para citar o número atual.
- reply: o que você diz agora (curto). Com proposta, diga em uma ou duas frases o que montou e que a pessoa pode conferir a prévia e clicar em Aplicar (e depois Salvar). Sempre que fizer uma pergunta, ela vai em question (não repita a pergunta no reply).
- ready: true quando a proposta já atende ao pedido; aí não pergunte nada.

Responda só com um objeto JSON, sem comentários nem cercas de código:
{"reply": "...", "question": {"text": "...", "options": ["...", "..."], "multiple": false}, "proposal": {"name": "...", "description": "...", "range": "30d", "add": [{"title": "...", "why": "...", "w": 3, "h": 3, "spec": {"viz": "stat", "groupBy": "none", "compare": true, "queries": [{"ref": "A", "source": "tasks", "metric": "count", "dateField": "created_at", "filters": []}]}}], "update": [{"id": "...", "title": "...", "why": "...", "w": 6, "h": 6, "spec": {...}}], "remove": ["id"]}, "ready": false}
(Deixe de fora question e proposal quando não houver; name, description e range só quando mudam. range: ${rangeOptions.map((r) => r.key).join(", ")}.)`;

// ------------------------------------------------------------ contexto
const presetLabel = (key: string) => rangeOptions.find((r) => r.key === key)?.label ?? "Personalizado";

/** O dashboard como está agora, com os nomes dos filtros. */
export function stateText(state: DashState, names: Map<string, string>) {
  const filterLine = (label: string, ids?: string[]) =>
    ids?.length ? `${label}: ${ids.map((id) => `${names.get(id) ?? "?"} (${id})`).join(", ")}` : "";
  const filters = [
    filterLine("Clientes", state.filters.clients),
    filterLine("Produtos", state.filters.products),
    filterLine("Equipes", state.filters.teams),
    filterLine("Pessoas", state.filters.people),
  ].filter(Boolean);
  const panels = state.panels.map((p) => {
    const notes = [
      ...new Set(p.spec.queries.map((q) => personNote(q, p.spec.groupBy)).filter((n): n is string => !!n)),
    ];
    return [
      `- id ${p.id}${p.id === state.focus ? " (A PESSOA ABRIU A CONVERSA POR ESTE PAINEL)" : ""}: "${p.title}" (${p.w}×${p.h}, coluna ${p.x}, linha ${p.y})`,
      `  ${JSON.stringify(p.spec)}`,
      ...notes.map((n) => `  O que conta: ${n}`),
    ].join("\n");
  });
  return [
    state.isNew ? "Dashboard NOVO (ainda não salvo): crie-o." : "Dashboard que já existe.",
    `Nome: ${state.name || "(sem nome)"}`,
    `Descrição: ${state.description || "(sem descrição)"}`,
    `Período em uso: ${presetLabel(state.range.preset)} (${state.range.from} a ${state.range.to})`,
    filters.length ? `Filtros do dashboard:\n${filters.join("\n")}` : "Filtros do dashboard: nenhum (todos os clientes, produtos, equipes e pessoas).",
    state.panels.length ? `Painéis (${state.panels.length}):\n${panels.join("\n")}` : "Painéis: nenhum ainda.",
  ].join("\n");
}

export function builderMessages(history: DashMessage[], state: DashState, names: Map<string, string>, today: string) {
  const recent = history.slice(-30);
  const last = recent[recent.length - 1];
  const now = `\n\n---\nHoje é ${today}.\n${stateText(state, names)}`;
  if (!last || last.role !== "user")
    return [...recent, { role: "user" as const, content: `(A pessoa abriu a conversa.)${now}` }];
  return [...recent.slice(0, -1), { role: "user" as const, content: `${last.content}${now}` }];
}

// ------------------------------------------------------------ resposta
function json(text: string): Row {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Row;
  } catch {
    /* abaixo */
  }
  throw new DashError(502, "A MAVI não conseguiu montar a resposta. Tente de novo.");
}

const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min ? Math.min(n, max) : fallback;
};

/**
 * O JSON da MAVI, conferido contra o catálogo e o dashboard: painel que não
 * passa fica de fora (com o motivo), alteração e remoção só de painéis que
 * existem.
 */
export function parseBuilder(
  text: string,
  state: DashState,
  allowed: Source[],
): Omit<DashReply, "model"> {
  const r = json(text);
  const out: Omit<DashReply, "model"> = { reply: str(r.reply, 3000), ready: r.ready === true };
  const q = r.question as Row | undefined;
  if (q && typeof q === "object" && str(q.text, 500).length >= 3 && !out.ready) {
    const seen = new Set<string>();
    out.question = {
      text: str(q.text, 500),
      options: (Array.isArray(q.options) ? q.options : [])
        .map((o) => str(o, 120))
        .filter((o) => o && !seen.has(o) && !!seen.add(o))
        .slice(0, 6),
      multiple: q.multiple === true,
    };
  }
  const p = r.proposal as Row | undefined;
  if (p && typeof p === "object") {
    const dropped: string[] = [];
    const ids = new Set(state.panels.map((x) => x.id));
    const panel = (raw: unknown, existing: boolean): ProposedPanel | null => {
      const x = (raw && typeof raw === "object" ? raw : {}) as Row;
      const title = str(x.title, 120);
      const id = str(x.id, 40);
      if (existing && !ids.has(id)) {
        dropped.push(`"${title || id}": o painel a alterar não existe neste dashboard.`);
        return null;
      }
      if (title.length < 2) {
        dropped.push("Um painel sem título.");
        return null;
      }
      const checked = checkSpec(x.spec, allowed);
      if (!checked.ok) {
        dropped.push(`"${title}": ${checked.error}`);
        return null;
      }
      const size = defaultSize(checked.spec.viz);
      const w = clamp(x.w, 1, 12, size.w);
      return {
        ...(existing ? { id } : {}),
        title,
        w,
        h: clamp(x.h, 2, 24, size.h),
        spec: checked.spec,
        why: str(x.why, 300),
      };
    };
    const list = (v: unknown) => (Array.isArray(v) ? v : []);
    const room = Math.max(0, 48 - state.panels.length);
    const add = list(p.add)
      .map((x) => panel(x, false))
      .filter((x): x is ProposedPanel => !!x);
    if (add.length > room) dropped.push(`Passou do limite de 48 painéis: ${add.length - room} ficaram de fora.`);
    const proposal: DashProposal = {
      add: add.slice(0, room),
      update: list(p.update)
        .map((x) => panel(x, true))
        .filter((x): x is ProposedPanel => !!x),
      remove: [...new Set(list(p.remove).map((x) => str(x, 40)).filter((x) => ids.has(x)))],
    };
    const name = str(p.name, 120);
    const description = str(p.description, 500);
    if (name.length >= 2) proposal.name = name;
    if (description) proposal.description = description;
    if (rangeOptions.some((o) => o.key === p.range)) proposal.range = p.range as RangePreset;
    const empty =
      !proposal.add.length && !proposal.update.length && !proposal.remove.length && !proposal.name && !proposal.description && !proposal.range;
    if (!empty) out.proposal = proposal;
    if (dropped.length) out.dropped = dropped;
  }
  if (!out.reply && !out.question && !out.proposal)
    throw new DashError(502, "A MAVI não conseguiu responder agora. Tente de novo.");
  return out;
}

// ------------------------------------------------------------ ferramentas
export const BUILDER_TOOLS: ToolSpec[] = [
  {
    name: "find_options",
    description:
      "Procura os IDs de clientes, produtos, projetos, equipes, pessoas, tópicos e temas do Radar, indicadores do termômetro ou squads de Customer Success (pelo nome, parte do nome ou vazio para listar). Use antes de filtrar por qualquer um deles.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["client", "product", "project", "team", "person", "radar_topic", "radar_theme", "temperature_indicator", "cs_squad"],
        },
        search: { type: "string", description: "Parte do nome (opcional)." },
      },
      required: ["kind"],
    },
  },
  {
    name: "preview_panel",
    description:
      "Roda um painel com o período e os filtros do dashboard e devolve os números (ou o erro). Use em todo painel antes de propor; ajuste se vier vazio ou estranho.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        spec: { type: "object", description: "O painel: viz, groupBy, queries, interval, limit, formula, unit, decimals, compare." },
      },
      required: ["spec"],
    },
  },
];

type Fetcher = (path: string) => Promise<Row[]>;
const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** As opções de um tipo, filtradas pelo nome (sem acento, parte do nome). */
export async function findOptions(
  kind: string,
  search: string,
  load: { rows: Fetcher; rpc: (name: string) => Promise<unknown> },
) {
  let items: { id: string; name: string }[] = [];
  const named = (rows: Row[], id = "id", name = "name") =>
    rows.map((r) => ({ id: String(r[id]), name: String(r[name] ?? "") }));
  if (kind === "client") items = named(await load.rows("clients?select=id,name&archived=is.false&order=name"));
  else if (kind === "product") items = named(await load.rows("products?select=id,name&order=name"));
  else if (kind === "project") items = named(await load.rows("projects?select=id,name&archived=is.false&order=name"));
  else if (kind === "team") items = named(await load.rows("teams?select=id,name&order=name"));
  else if (kind === "person")
    items = named(await load.rows("memberships?select=user_id,name&active=is.true&order=name"), "user_id");
  else if (kind === "radar_topic" || kind === "radar_theme") {
    const o = ((await load.rpc("radar_theme_options")) ?? {}) as {
      topics?: { id: string; name: string }[];
      themes?: { id: string; title: string; topic?: string; product?: string | null }[];
    };
    items =
      kind === "radar_topic"
        ? (o.topics ?? []).map((t) => ({ id: t.id, name: t.name }))
        : (o.themes ?? []).map((t) => ({ id: t.id, name: `${t.title} (${t.topic ?? ""} · ${t.product ?? "Geral"})` }));
  } else if (kind === "temperature_indicator") {
    const c = ((await load.rpc("temperature_settings")) ?? {}) as {
      indicators?: { key?: string | null; name: string; kind?: string }[];
    };
    items = (c.indicators ?? [])
      .filter((i) => i.kind === "score" && i.key)
      .map((i) => ({ id: String(i.key), name: i.name }));
  } else if (kind === "cs_squad") {
    const list = ((await load.rpc("cs_squads")) ?? []) as { id: string; name: string; archived?: boolean }[];
    items = list.map((sq) => ({ id: sq.id, name: sq.archived ? `${sq.name} (arquivado)` : sq.name }));
  } else return "Tipo inválido.";
  const term = norm(search.trim());
  const hits = term ? items.filter((i) => norm(i.name).includes(term)) : items;
  if (!hits.length)
    return term
      ? `Nada com "${search}". ${items.length ? `Existem: ${items.slice(0, 15).map((i) => i.name).join(", ")}${items.length > 15 ? "…" : ""}.` : "Não há nenhum cadastrado."}`
      : "Não há nenhum cadastrado.";
  return hits
    .slice(0, 30)
    .map((i) => `${i.name} — id ${i.id}`)
    .join("\n")
    .concat(hits.length > 30 ? `\n… e mais ${hits.length - 30} (refine a busca).` : "");
}

type Series = { k: string | null; l?: string | null; v: number | null }[];
const fmt = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(Number(v))
    ? "—"
    : Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 2 });

/** O resultado de uma prévia, curto, para a MAVI conferir. */
export function previewText(spec: PanelSpec, result: { series?: Record<string, Series> }) {
  const lines = spec.queries.map((q) => {
    const rows = result.series?.[q.ref] ?? [];
    const metric = sources[q.source].metrics.find((m) => m.key === q.metric);
    const name = `${q.ref} (${q.label || metric?.label || q.metric}${metric ? `, ${unitWord[metric.unit]}` : ""})`;
    if (spec.groupBy === "none") return `${name}: ${fmt(rows[0]?.v)}`;
    const filled = rows.filter((r) => r.v !== null && Number(r.v) !== 0);
    if (!filled.length) return `${name}: vazio (nenhum valor no período).`;
    if (spec.groupBy === "time") {
      const total = metric?.additive ? rows.reduce((s, r) => s + (Number(r.v) || 0), 0) : null;
      return `${name}: ${filled.length} de ${rows.length} intervalos com valor${total !== null ? `; total ${fmt(total)}` : ""}; últimos: ${rows
        .slice(-4)
        .map((r) => `${r.k} ${fmt(r.v)}`)
        .join(", ")}`;
    }
    return `${name}: ${rows.length} categorias — ${rows
      .slice(0, 8)
      .map((r) => `${r.l ?? (r.k === null ? "(sem valor)" : r.k)}: ${fmt(r.v)}`)
      .join("; ")}${rows.length > 8 ? "; …" : ""}`;
  });
  return lines.join("\n");
}

// ------------------------------------------------------------ pedido
function stateFrom(v: unknown): DashState {
  const s = (v && typeof v === "object" ? v : {}) as Row;
  const range = (s.range && typeof s.range === "object" ? s.range : {}) as Row;
  const f = (s.filters && typeof s.filters === "object" ? s.filters : {}) as Row;
  const ids = (x: unknown) =>
    (Array.isArray(x) ? x : []).filter((i): i is string => typeof i === "string" && UUID.test(i)).slice(0, 200);
  const panels = (Array.isArray(s.panels) ? s.panels : [])
    .slice(0, 48)
    .map((p) => (p && typeof p === "object" ? (p as Row) : {}))
    .filter((p) => typeof p.id === "string" && p.spec && typeof p.spec === "object")
    .map(
      (p): Panel => ({
        id: str(p.id, 40),
        title: str(p.title, 120),
        x: clamp(p.x, 0, 11, 0),
        y: clamp(p.y, 0, 2000, 0),
        w: clamp(p.w, 1, 12, 6),
        h: clamp(p.h, 1, 24, 5),
        spec: p.spec as PanelSpec,
      }),
    );
  const from = str(range.from, 10);
  const to = str(range.to, 10);
  if (!DAY.test(from) || !DAY.test(to)) throw new DashError(400, "Período inválido.");
  return {
    name: str(s.name, 120),
    description: str(s.description, 500),
    panels,
    range: { from, to, preset: str(range.preset, 20) || "custom" },
    filters: { clients: ids(f.clients), products: ids(f.products), teams: ids(f.teams), people: ids(f.people) },
    focus: str(s.focus, 40) || null,
    isNew: s.isNew === true,
  };
}

function userIdFrom(auth: string) {
  try {
    const sub = JSON.parse(
      Buffer.from(auth.replace(/^Bearer\s+/, "").split(".")[1], "base64url").toString("utf8"),
    ).sub;
    return typeof sub === "string" && UUID.test(sub) ? sub : "";
  } catch {
    return "";
  }
}

/** Até quantas consultas por resposta (nomes + prévias). */
const MAX_TOOL_CALLS = 24;

export async function handleDashboardBuilder(
  body: unknown,
  authorization: string | null,
  env: AiEnv,
  deps: AiDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fail = (status: number, error: string) => ({ status, body: { error } });
  if (!authorization?.startsWith("Bearer ")) return fail(401, "Entre na sua conta.");
  const req = (body ?? {}) as Row;
  const company = str(req.company, 40);
  if (!UUID.test(company)) return fail(400, "Empresa inválida.");
  const history: DashMessage[] = (Array.isArray(req.messages) ? req.messages : [])
    .map((m) => (m && typeof m === "object" ? (m as Row) : {}))
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as DashMessage["role"], content: str(m.content, 6000) }))
    .filter((m) => m.content);

  let meter: Meter | undefined;
  let provider: Awaited<ReturnType<typeof featureProvider>> = null;
  try {
    const state = stateFrom(req.dashboard);
    const user = userIdFrom(authorization);
    const rows: Fetcher = async (path) => {
      const res = await deps.fetch(
        `${env.supabaseUrl}/rest/v1/${path}${path.includes("?") ? "&" : "?"}company_id=eq.${company}`,
        { headers: { apikey: env.supabaseKey, Authorization: authorization } },
      );
      if (!res.ok) throw new DashError(res.status === 401 ? 401 : 502, "Não foi possível ler os dados.");
      return (await res.json()) as Row[];
    };
    const me = await rows(`memberships?select=role,hidden_pages,active,name&user_id=eq.${user}`);
    if (!me[0]?.active) throw new DashError(403, "Sem acesso a esta empresa.");
    if (((me[0].hidden_pages as string[] | null) ?? []).includes("assistant"))
      throw new DashError(403, "A MAVI está desligada para você nesta empresa.");
    const leader = me[0].role === "admin" || me[0].role === "manager";
    // Dashboards de colaboradores ficam nos clientes deles: sem o Mural.
    // Colaboradores: sem o Mural nem as fontes de Customer Success.
    const allowed = (Object.keys(sources) as Source[]).filter((k) => leader || (k !== "notices" && k !== "agent_costs" && !isCsSource(k)));
    const [limits, route, tz] = await Promise.all([
      callRpc<{ blocked: boolean; message: string | null }>(env, deps.fetch, authorization, "ai_check_limits", {
        p_company: company,
        p_client: null,
        p_contract: null,
        p_project: null,
      }),
      featureProvider(env, deps.fetch, authorization, company, "dashboard_builder"),
      deps
        .fetch(`${env.supabaseUrl}/rest/v1/companies?select=timezone&id=eq.${company}`, {
          headers: { apikey: env.supabaseKey, Authorization: authorization },
        })
        .then((r) => (r.ok ? r.json() : []))
        .then((r: { timezone?: string }[]) => r[0]?.timezone || "America/Sao_Paulo")
        .catch(() => "America/Sao_Paulo"),
    ]);
    provider = route;
    if (limits.ok && limits.data?.blocked)
      throw new DashError(429, limits.data.message ?? "Limite de uso da MAVI atingido.");
    if (!provider && !env.anthropicKey)
      throw new DashError(
        503,
        "A MAVI não está configurada no servidor. Escolha um provedor para os Dashboards no Painel da MAVI.",
      );

    // Os nomes dos filtros do dashboard (para a MAVI ler e explicar).
    const names = new Map<string, string>();
    const want = [
      ["clients", state.filters.clients],
      ["products", state.filters.products],
      ["teams", state.filters.teams],
    ] as const;
    await Promise.all([
      ...want
        .filter(([, list]) => list?.length)
        .map(([table, list]) =>
          rows(`${table}?select=id,name&id=in.(${list!.join(",")})`).then((r) =>
            r.forEach((x) => names.set(String(x.id), String(x.name))),
          ),
        ),
      ...(state.filters.people?.length
        ? [
            rows(`memberships?select=user_id,name&user_id=in.(${state.filters.people.join(",")})`).then((r) =>
              r.forEach((x) => names.set(String(x.user_id), String(x.name))),
            ),
          ]
        : []),
    ]).catch(() => {});

    const rpcData = async (name: string) => {
      const r = await callRpc<unknown>(env, deps.fetch, authorization, name, { p_company: company });
      return r.ok ? r.data : null;
    };
    let calls = 0;
    const execute = async (name: string, input: unknown) => {
      const args = (input && typeof input === "object" ? input : {}) as Row;
      if (++calls > MAX_TOOL_CALLS)
        return "Limite de consultas desta resposta: proponha com o que já conferiu ou pergunte à pessoa.";
      if (name === "find_options")
        return findOptions(str(args.kind, 40), str(args.search, 80), { rows, rpc: rpcData }).catch(
          () => "Não consegui ler a lista agora.",
        );
      if (name === "preview_panel") {
        const checked = checkSpec(args.spec, allowed);
        if (!checked.ok) return `Painel inválido: ${checked.error}`;
        if (isCsSpec(checked.spec)) {
          // As fontes de CS são calculadas pelo motor do painel CS Make.
          if (!checked.spec.queries.every((q) => isCsSource(q.source)))
            return "Painel inválido: não misture fontes de Customer Success com as outras no mesmo painel.";
          const cs = await callRpc<CsData>(env, deps.fetch, authorization, "cs_company_data", { p_company: company });
          if (!cs.ok || !cs.data) return `Erro do banco: ${cs.ok ? "sem dados de Customer Success" : cs.error}`;
          const result = runCsPanel(cs.data, checked.spec, state.range, state.filters);
          return `Período ${state.range.from} a ${state.range.to} (Customer Success, por mês):\n${previewText(checked.spec, result as never)}`;
        }
        const res = await callRpc<{ series?: Record<string, Series> }>(
          env,
          deps.fetch,
          authorization,
          "dashboard_preview",
          {
            p_company: company,
            p_spec: checked.spec,
            p_from: state.range.from,
            p_to: state.range.to,
            p_vars: { filters: state.filters },
          },
        );
        if (!res.ok) return `Erro do banco: ${res.error}`;
        return `Período ${state.range.from} a ${state.range.to}${
          Object.values(state.filters).some((l) => l?.length) ? ", com os filtros do dashboard" : ""
        }:\n${previewText(checked.spec, res.data ?? {})}`;
      }
      return "Ferramenta desconhecida.";
    };

    const today = new Intl.DateTimeFormat("pt-BR", {
      timeZone: tz,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(new Date(deps.now?.() ?? Date.now()));
    const llm: LlmAdapter = routedLlm(
      provider
        ? (deps.providerLlm ?? ((c) => adapterFor(c, deps.fetch)))(provider.config)
        : deps.llm,
      {
        env,
        fetch: deps.fetch,
        auth: authorization,
        where: { company, surface: "dashboard", feature: "dashboard_builder" },
        used: { providerId: provider?.id ?? null, model: provider?.config.model || env.model, scope: provider?.scope, auto: provider?.auto },
        question: [...history].reverse().find((m) => m.role === "user")?.content ?? "",
        hasServerKey: !!env.anthropicKey,
        open: {
          providerKey: env.providerKey ?? null,
          anthropicKey: env.anthropicKey,
          make: (c) => (deps.providerLlm ?? ((x) => adapterFor(x, deps.fetch)))(c),
          server: { model: env.model, llm: deps.llm },
        },
        onUsed: (c, config) => {
          provider = c.providerId ? { id: c.providerId, config, scope: "router" } : null;
        },
      },
    );
    const result = await llm({
      instructions: BUILDER_INSTRUCTIONS.replace("{guide}", DASHBOARD_GUIDE.replace("{catalog}", catalogGuide(allowed))),
      context: `Quem conversa: ${String(me[0].name ?? "")}${leader ? " (administrador ou gestor)" : " (colaborador: o dashboard fica nos clientes das equipes dele)"}.`,
      messages: builderMessages(history, state, names, today),
      tools: BUILDER_TOOLS,
      execute: async (name, input) => outputText(await execute(name, input)),
      maxRounds: 12,
      effort: "medium",
      maxTokens: 16_000,
    });
    meter = result.meter;
    const model = meter?.model || provider?.config.model || env.model;
    return { status: 200, body: { ...parseBuilder(result.text, state, allowed), model } };
  } catch (err) {
    if (err instanceof DashError) return fail(err.status, err.message);
    const status =
      typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500;
    return fail(status, llmFriendlyError(err));
  } finally {
    if (meter)
      await callRpc(env, deps.fetch, authorization, "ai_log_usage", {
        p_company: company,
        p_module: "dashboards",
        p_kind: "dashboard_builder",
        p_client: null,
        p_contract: null,
        p_project: null,
        p_recording: null,
        p_model: meter.model || provider?.config.model || env.model,
        p_input: meter.input ?? 0,
        p_output: meter.output ?? 0,
        p_cache_read: meter.cacheRead ?? 0,
        p_cache_write: meter.cacheWrite ?? 0,
        p_embedding: 0,
        p_cost: Math.round((meter.cost ?? 0) * 1e6) / 1e6,
        ...(provider ? { p_provider: provider.id } : {}),
      }).catch(() => {});
  }
}

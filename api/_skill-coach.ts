import { callRpc } from "./_drive.js";
import { llmFriendlyError, type LlmAdapter } from "./_ai-llm.js";
import { adapterFor, featureProvider } from "./_ai-providers.js";
import { WEB_RESEARCH_TOOL, toolsFor } from "./_ai-powers.js";
import type { AiDeps, AiEnv } from "./_ai.js";
import type { Meter } from "./_social-leads.js";
import { POWERS } from "../src/mavi-artifacts.js";

/**
 * MAVI · validador e assistente das skills (ação "skill-mavi" de /api/drive,
 * funcionalidade 'skill_coach' do Painel da MAVI). Uma chamada ao modelo,
 * sem ferramentas, que devolve JSON:
 *
 * - "review": lê a skill (nome, quando usar, instruções e arquivos) e diz o
 *   que incluir, corrigir, alterar, melhorar ou remover — cada ponto com o
 *   texto pronto para aplicar quando dá. Skill boa volta sem pontos e com
 *   "muito boa": o validador não inventa defeito.
 * - "coach": a conversa guiada de quem cria: uma pergunta por vez (com
 *   opções) e a skill preenchida aos poucos.
 *
 * Nada é gravado aqui: a tela mostra e a pessoa aplica. Qualquer pessoa que
 * cria skills usa, com a MAVI ligada para ela e dentro dos limites de gasto.
 */

export type CheckKind = "include" | "fix" | "change" | "improve" | "remove";
export type CheckTarget = "name" | "description" | "instructions" | "file";
export type CheckItem = {
  id: string;
  kind: CheckKind;
  severity: "high" | "medium" | "low";
  target: CheckTarget;
  /** O arquivo (target "file"). */
  file?: string;
  title: string;
  why: string;
  /** O trecho exato que muda (instruções e arquivos). */
  before?: string;
  /** Onde entra o texto novo (instruções e arquivos), quando não troca nada. */
  anchor?: string;
  /** O texto pronto; sem ele, o ponto é só uma orientação. */
  after?: string;
};
export type SkillCheck = {
  verdict: "great" | "good" | "needs_work";
  summary: string;
  items: CheckItem[];
  model: string;
};
export type CoachQuestion = { text: string; options: string[]; multiple: boolean };
export type CoachReply = {
  reply: string;
  question?: CoachQuestion;
  draft?: { name?: string; description?: string; instructions?: string };
  files?: { name: string; content?: string; remove?: boolean }[];
  ready: boolean;
  model: string;
};
export type SkillInput = {
  slug: string;
  name: string;
  description: string;
  instructions: string;
  files: { name: string; content: string }[];
};

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max: number) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";
/** Sem aparar: trechos exatos das instruções (espaços contam). */
const raw = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

export class CoachError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------ o que a MAVI faz
/**
 * O que a MAVI consegue fazer (as ferramentas de todos os poderes), para o
 * validador apontar o que a skill pede e ela não faz — skills importadas da
 * Claude costumam pedir para rodar scripts ou mexer em pastas locais.
 */
export function capabilities() {
  const all = new Set(POWERS.map((p) => p.id));
  const tools = [...toolsFor(all, { webResearch: true }), WEB_RESEARCH_TOOL];
  const seen = new Set<string>();
  const lines = tools
    .filter((t) => !seen.has(t.name) && !!seen.add(t.name))
    .map((t) => `- ${t.name}: ${t.description.split(/(?<=\.)\s/)[0].slice(0, 220)}`);
  return [
    ...lines,
    "- Conexões externas (MCP) que a agência ligou no Painel da MAVI: ferramentas de outros serviços, com as ações sempre confirmadas pela pessoa.",
    "- Não faz: rodar código ou scripts, ler ou gravar arquivos no computador, abrir programas, agendar tarefas sozinha, mandar mensagens ou e-mails sem confirmação.",
  ].join("\n");
}

export const SKILL_GUIDE = `O que é uma skill: um jeito de trabalhar que a agência ensina à MAVI para um tipo de pedido. A MAVI vê só o nome e o "quando usar" de cada skill; quando o pedido se encaixa, ela carrega as instruções e segue. Os arquivos de referência ela lê quando as instruções mandam.

Como é uma skill boa:
1. Nome: curto, diz o trabalho (ex.: "Relatório mensal do cliente"). Sem "skill" nem emoji.
2. Quando usar (descrição): é o único texto que a MAVI lê para decidir. Diz o que a skill entrega E quando usar, com as palavras que as pessoas usam no pedido (ex.: "relatório do mês", "fechamento"); se houver risco de confusão com outra skill, diz quando não usar. Uma a três frases, sem o passo a passo.
3. Instruções:
   - o objetivo em uma ou duas frases;
   - o passo a passo numerado, na ordem;
   - de onde vêm os dados, com o que existe no sistema (reuniões, tarefas, campanhas, Drive, WhatsApp, marca do cliente, internet…);
   - o que perguntar à pessoa quando faltar algo essencial (a MAVI pergunta com opções), em vez de supor;
   - o formato do resultado: estrutura, tamanho, tom, com um exemplo curto ou um modelo em arquivo;
   - o que conferir antes de entregar e o que evitar;
   - regras concretas e verificáveis ("até 5 tópicos", "em tabela", "valores em R$") em vez de vagas ("capriche", "seja completo");
   - os mesmos nomes para as mesmas coisas do começo ao fim.
   Não precisa repetir as regras gerais da MAVI (buscar antes de afirmar, citar as fontes, respeitar o que a pessoa pode ver, pedir confirmação antes de criar ou mudar algo) e não pode contrariá-las (ex.: "invente se faltar", "crie a tarefa sem perguntar").
4. Arquivos de referência: modelos, bons exemplos, tabelas e regras longas. Cada um citado nas instruções pelo nome, dizendo quando ler. Nada de arquivo solto, repetido, desatualizado ou sem relação. Nada de senha, token ou dado pessoal sensível.
5. Só pede o que a MAVI faz (lista abaixo). Skills trazidas da Claude costumam mandar rodar scripts, usar bash/python, ler pastas locais ou ferramentas que não existem aqui: isso precisa virar o equivalente da MAVI (ou sair).
6. Enxuta: a partir de uns 15 mil caracteres de instruções, os detalhes vão para arquivos.
7. Não repete nem contradiz outra skill do catálogo: se já existe uma parecida, melhor ajustar aquela ou deixar claro quando usar cada uma.`;

// ------------------------------------------------------------ validador
export const REVIEW_INSTRUCTIONS = `Você é a MAVI, a inteligência do sistema de gestão de uma agência de marketing. Seu nome é MAVI, no feminino. Aqui você é a revisora de qualidade das skills que o time cria ou importa: diz, com franqueza e sem enrolar, o que incluir, corrigir, alterar, melhorar ou remover para a skill funcionar bem na MAVI.

${SKILL_GUIDE}

Como revisar:
- Leia tudo: nome, quando usar, instruções e arquivos. Julgue pelo guia acima e pelo que a MAVI faz.
- Seja calibrada. Se a skill está boa, diga que está muito boa e não liste nada: não invente ponto para parecer útil, não peça mudança de gosto pessoal, não reescreva o que já funciona. Aponte só o que muda o resultado.
- No máximo 8 pontos, do mais importante para o menos. Um problema por ponto.
- severity: "high" quando a skill falha sem isso (a MAVI não vai saber quando usar, pede algo que ela não faz, falta o essencial, contradiz as regras, tem dado sensível); "medium" quando o resultado sai pior; "low" para acabamento.
- kind: "include" (falta algo), "fix" (está errado), "change" (troca por outro jeito), "improve" (dá para ficar mais claro ou concreto), "remove" (sobra, atrapalha ou é arriscado).
- target: "name", "description", "instructions" ou "file" (com file: o nome do arquivo).
- title: o ponto em até 90 caracteres. why: em uma ou duas frases, por que muda o resultado.
- Sempre que der, traga o texto pronto em after, em português, no tom de quem escreveu:
  - name e description: after é o texto inteiro novo do campo;
  - instructions e file: before é uma cópia EXATA de um trecho contínuo do texto atual (até 600 caracteres, sem mudar nem um espaço) e after é o que entra no lugar ("" para tirar); para incluir sem trocar nada, deixe before vazio e use anchor (cópia exata do trecho depois do qual entra) ou nada (entra no fim);
  - arquivo novo: target "file", kind "include", file com o nome (ex.: modelo-relatorio.md) e after com o conteúdo;
  - tirar um arquivo inteiro: target "file", kind "remove", file com o nome, sem before nem after.
  Quando o texto depende de algo que só a pessoa sabe (um exemplo real, um número da agência), deixe after vazio e diga no why o que ela precisa trazer.
- verdict: "great" quando não há ponto; "good" quando só há pontos medium ou low; "needs_work" quando há algum high.
- summary: uma ou duas frases para a pessoa, começando pelo veredito (ex.: "Muito boa: a MAVI sabe quando usar e o passo a passo está claro.").

Responda só com um objeto JSON, sem comentários nem cercas de código:
{"verdict": "great|good|needs_work", "summary": "...", "items": [{"kind": "include|fix|change|improve|remove", "severity": "high|medium|low", "target": "name|description|instructions|file", "file": "...", "title": "...", "why": "...", "before": "...", "anchor": "...", "after": "..."}]}`;

const FILES_BUDGET = 60_000;

/** A skill como a MAVI lê, com os arquivos até o limite. */
export function skillText(skill: SkillInput) {
  let budget = FILES_BUDGET;
  const files = skill.files.map((f) => {
    const part = f.content.slice(0, Math.max(0, budget));
    budget -= part.length;
    const cut = part.length < f.content.length;
    return `<arquivo nome="${f.name}" caracteres="${f.content.length}">\n${part}${cut ? "\n… (cortado aqui para a revisão)" : ""}\n</arquivo>`;
  });
  return [
    `Nome: ${skill.name || "(vazio)"}`,
    `Identificador: ${skill.slug || "(vazio)"}`,
    `Quando usar (descrição):\n"""\n${skill.description || "(vazio)"}\n"""`,
    `Instruções (${skill.instructions.length} caracteres):\n<instrucoes>\n${skill.instructions || "(vazio)"}\n</instrucoes>`,
    skill.files.length ? `Arquivos de referência:\n${files.join("\n")}` : "Arquivos de referência: nenhum.",
  ].join("\n\n");
}

function catalogText(catalog: { slug: string; name: string; description: string }[], slug: string) {
  const others = catalog.filter((s) => s.slug !== slug).slice(0, 60);
  return others.length
    ? `Outras skills do catálogo (para ver se esta repete ou contradiz alguma):\n${others
        .map((s) => `- ${s.name} (${s.slug}): ${s.description.replace(/\s+/g, " ").slice(0, 200)}`)
        .join("\n")}`
    : "Não há outras skills no catálogo.";
}

export function reviewMessage(
  skill: SkillInput,
  catalog: { slug: string; name: string; description: string }[],
  origin: "import" | "submit" | "manual",
) {
  const why =
    origin === "import"
      ? "A skill acabou de ser importada (pode ter vindo da Claude, com ferramentas que não existem aqui)."
      : origin === "submit"
        ? "A pessoa vai enviar a skill para aprovação ou publicar agora."
        : "A pessoa pediu uma revisão.";
  return `${why}\n\nO que a MAVI faz:\n${capabilities()}\n\n${catalogText(catalog, skill.slug)}\n\nA skill:\n\n${skillText(skill)}\n\nRevise e devolva o JSON.`;
}

function json(text: string): Row {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Row;
  } catch {
    /* abaixo */
  }
  throw new CoachError(502, "A MAVI não conseguiu montar a resposta. Tente de novo.");
}

const KINDS: CheckKind[] = ["include", "fix", "change", "improve", "remove"];
const TARGETS: CheckTarget[] = ["name", "description", "instructions", "file"];
const SEVERITIES = ["high", "medium", "low"] as const;
const ORDER = { high: 0, medium: 1, low: 2 };

/**
 * O JSON da revisão, conferido: o trecho que muda precisa existir no texto
 * (senão o ponto vira só orientação) e o veredito segue os pontos.
 */
export function parseReview(text: string, skill: SkillInput): Omit<SkillCheck, "model"> {
  const r = json(text);
  const files = new Map(skill.files.map((f) => [f.name, f.content]));
  const items: CheckItem[] = (Array.isArray(r.items) ? r.items : [])
    .map((x) => (x && typeof x === "object" ? (x as Row) : {}))
    .filter(
      (x) =>
        KINDS.includes(x.kind as CheckKind) &&
        TARGETS.includes(x.target as CheckTarget) &&
        str(x.title, 200).length >= 3,
    )
    .slice(0, 8)
    .map((x, i): CheckItem => {
      const target = x.target as CheckTarget;
      const kind = x.kind as CheckKind;
      const item: CheckItem = {
        id: `c${i + 1}`,
        kind,
        severity: SEVERITIES.includes(x.severity as "high") ? (x.severity as CheckItem["severity"]) : "medium",
        target,
        title: str(x.title, 140),
        why: str(x.why, 600),
      };
      const after = raw(x.after, target === "file" ? 60_000 : 20_000);
      if (target === "name" || target === "description") {
        const v = after.trim().slice(0, target === "name" ? 80 : 600);
        if (v) item.after = v;
        return item;
      }
      let source = skill.instructions;
      if (target === "file") {
        const file = str(x.file, 120);
        // Sem o nome do arquivo, o ponto é só orientação.
        if (!file) return item;
        item.file = file;
        const content = files.get(file);
        if (kind === "remove" && !raw(x.before, 2000)) return item;
        if (content === undefined) {
          // Arquivo novo: só com conteúdo.
          if (after.trim()) item.after = after;
          return item;
        }
        source = content;
      }
      const before = raw(x.before, 4000);
      const anchor = raw(x.anchor, 4000);
      if (before) {
        if (source.includes(before)) {
          item.before = before;
          item.after = after;
        }
      } else if (after.trim()) {
        if (anchor && source.includes(anchor)) item.anchor = anchor;
        item.after = after;
      }
      return item;
    })
    .sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const verdict: SkillCheck["verdict"] = !items.length
    ? "great"
    : items.some((i) => i.severity === "high")
      ? "needs_work"
      : "good";
  const fallback =
    verdict === "great"
      ? "Muito boa: não há nada a mudar."
      : verdict === "good"
        ? "Boa: dá para usar, com alguns ajustes que melhoram o resultado."
        : "Precisa de ajustes antes de a MAVI usar bem.";
  // Um resumo que diz "muito boa" com pontos (ou o contrário) confunde.
  let summary = str(r.summary, 500) || fallback;
  if ((verdict === "great") !== (r.verdict === "great")) summary = fallback;
  return { verdict, summary, items };
}

// ------------------------------------------------------------ assistente
export const COACH_INSTRUCTIONS = `Você é a MAVI, a inteligência do sistema de gestão de uma agência de marketing. Seu nome é MAVI, no feminino. Aqui você ajuda uma pessoa do time — que pode não entender nada de IA — a criar uma skill: um jeito de trabalhar que ela quer que você siga sempre que alguém pedir aquele tipo de coisa. Você conduz a conversa e escreve a skill; ela só conta como faz o trabalho.

${SKILL_GUIDE}

Como conduzir:
- Português do Brasil, simples, caloroso e curto. Nada de jargão (evite "prompt", "tool", "frontmatter"); diga "o passo a passo", "quando usar", "arquivos de exemplo".
- Uma pergunta por vez, a mais importante que falta. Quando ajudar, dê de 2 a 5 opções curtas para clicar (a pessoa também pode escrever). multiple: true quando dá para escolher mais de uma.
- A ordem que costuma funcionar: (1) o que a skill entrega e para quem; (2) como as pessoas vão pedir (as palavras do pedido); (3) de onde vêm as informações no sistema; (4) como a pessoa faz hoje, passo a passo; (5) como deve ficar o resultado (formato, tamanho, tom; um exemplo ajuda muito); (6) o que não pode acontecer e o que conferir. Pule o que já dá para deduzir.
- Assim que der (em geral depois de 2 ou 3 respostas), escreva a primeira versão completa e continue melhorando com as próximas respostas. Nunca passe de 6 perguntas sem ter uma versão completa.
- Toda vez que mudar a skill, devolva em draft os campos que mudaram, sempre inteiros (instructions é o texto completo, em Markdown). O nome e o "quando usar" seguem o guia. Não escreva o identificador.
- Se um modelo, uma tabela ou um exemplo longo ajudar, crie um arquivo de referência em files ({"name": "modelo-relatorio.md", "content": "..."}) e cite-o nas instruções. Para tirar um arquivo: {"name": "...", "remove": true}. Se a pessoa tiver um bom exemplo real (um relatório, um post), sugira que ela suba em "Adicionar arquivos" e depois leia o que chegou.
- Nunca invente regras, números ou nomes da agência: pergunte. Só escreva o que você faz de verdade (lista abaixo).
- A pessoa pode ter editado os campos à mão: a skill atual vem em cada mensagem; parta dela, sem desfazer o que a pessoa escreveu.
- reply: o que você diz agora (curto; quando mudar a skill, diga em uma frase o que mudou). question: a próxima pergunta, se houver.
- ready: true quando a skill já está boa para usar; aí, em vez de nova pergunta, diga que ela pode revisar os campos e clicar em "Enviar para aprovação" (ou "Publicar") — a revisão de qualidade roda na hora — e que dá para continuar pedindo ajustes.

O que você (a MAVI) faz no sistema:
{capabilities}

Responda só com um objeto JSON, sem comentários nem cercas de código:
{"reply": "...", "question": {"text": "...", "options": ["...", "..."], "multiple": false}, "draft": {"name": "...", "description": "...", "instructions": "..."}, "files": [{"name": "...", "content": "..."}], "ready": false}
(Deixe de fora question, draft e files quando não houver.)`;

export type CoachMessage = { role: "user" | "assistant"; content: string };

export function coachMessages(
  history: CoachMessage[],
  skill: SkillInput,
  catalog: { slug: string; name: string; description: string }[],
): CoachMessage[] {
  const recent = history.slice(-30);
  const last = recent[recent.length - 1];
  const state = `\n\n---\nA skill como está agora (pode ter sido editada à mão):\n\n${skillText(skill)}\n\n${catalogText(catalog, skill.slug)}`;
  if (!last || last.role !== "user")
    return [...recent, { role: "user", content: `(A pessoa abriu o assistente.)${state}` }];
  return [...recent.slice(0, -1), { role: "user", content: `${last.content}${state}` }];
}

export function parseCoach(text: string): Omit<CoachReply, "model"> {
  const r = json(text);
  const reply = str(r.reply, 3000);
  const out: Omit<CoachReply, "model"> = { reply, ready: r.ready === true };
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
  const d = r.draft as Row | undefined;
  if (d && typeof d === "object") {
    const draft: NonNullable<CoachReply["draft"]> = {};
    const name = str(d.name, 80);
    const description = str(d.description, 600);
    const instructions = typeof d.instructions === "string" ? d.instructions.trim().slice(0, 40_000) : "";
    if (name.length >= 2) draft.name = name;
    if (description.length >= 10) draft.description = description;
    if (instructions.length >= 20) draft.instructions = instructions;
    if (Object.keys(draft).length) out.draft = draft;
  }
  if (Array.isArray(r.files)) {
    const files = r.files
      .map((f) => (f && typeof f === "object" ? (f as Row) : {}))
      .map((f): NonNullable<CoachReply["files"]>[number] =>
        f.remove === true
          ? { name: str(f.name, 120), remove: true }
          : { name: str(f.name, 120), content: typeof f.content === "string" ? f.content.slice(0, 200_000) : "" },
      )
      .filter((f) => f.name && (f.remove || (f.content ?? "").trim()))
      .slice(0, 5);
    if (files.length) out.files = files;
  }
  if (!out.reply && !out.question && !out.draft)
    throw new CoachError(502, "A MAVI não conseguiu responder agora. Tente de novo.");
  if (!out.reply) out.reply = out.draft ? "Atualizei a skill." : "";
  return out;
}

// ------------------------------------------------------------ pedido
function skillFrom(v: unknown): SkillInput {
  const s = (v && typeof v === "object" ? v : {}) as Row;
  let total = 0;
  const files = (Array.isArray(s.files) ? s.files : [])
    .map((f) => (f && typeof f === "object" ? (f as Row) : {}))
    .map((f) => ({ name: str(f.name, 120), content: raw(f.content, 200_000) }))
    .filter((f) => f.name && (total += f.content.length) <= 1_000_000)
    .slice(0, 20);
  return {
    slug: str(s.slug, 63),
    name: str(s.name, 80),
    description: str(s.description, 600),
    instructions: raw(s.instructions, 40_000),
    files,
  };
}

async function selectAs<T>(env: AiEnv, deps: AiDeps, auth: string, path: string): Promise<T[]> {
  const res = await deps.fetch(`${env.supabaseUrl}/rest/v1/${path}`, {
    headers: { apikey: env.supabaseKey, Authorization: auth },
  });
  if (!res.ok) throw new CoachError(res.status === 401 ? 401 : 502, "Não foi possível ler os dados.");
  return (await res.json()) as T[];
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

export async function handleSkillCoach(
  body: unknown,
  authorization: string | null,
  env: AiEnv,
  deps: AiDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fail = (status: number, error: string) => ({ status, body: { error } });
  if (!authorization?.startsWith("Bearer ")) return fail(401, "Entre na sua conta.");
  const req = (body ?? {}) as Row;
  const company = str(req.company, 40);
  const mode = req.mode;
  if (!UUID.test(company)) return fail(400, "Empresa inválida.");
  if (mode !== "review" && mode !== "coach") return fail(400, "Pedido inválido.");
  const skill = skillFrom(req.skill);
  const origin = req.origin === "import" || req.origin === "submit" ? req.origin : "manual";
  const history: CoachMessage[] = (Array.isArray(req.messages) ? req.messages : [])
    .map((m) => (m && typeof m === "object" ? (m as Row) : {}))
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as CoachMessage["role"], content: str(m.content, 4000) }))
    .filter((m) => m.content);
  if (mode === "review" && skill.instructions.trim().length < 20 && skill.description.length < 10)
    return fail(400, "Escreva a skill primeiro (ou crie com a MAVI).");

  let meter: Meter | undefined;
  let provider: Awaited<ReturnType<typeof featureProvider>> = null;
  try {
    const user = userIdFrom(authorization);
    const me = await selectAs<{ hidden_pages: string[] | null; active: boolean }>(
      env,
      deps,
      authorization,
      `memberships?select=hidden_pages,active&company_id=eq.${company}&user_id=eq.${user}`,
    );
    if (!me[0]?.active) throw new CoachError(403, "Sem acesso a esta empresa.");
    if ((me[0].hidden_pages ?? []).includes("assistant"))
      throw new CoachError(403, "A MAVI está desligada para você nesta empresa.");
    const [limits, route, catalog] = await Promise.all([
      callRpc<{ blocked: boolean; message: string | null }>(env, deps.fetch, authorization, "ai_check_limits", {
        p_company: company,
        p_client: null,
        p_contract: null,
        p_project: null,
      }),
      featureProvider(env, deps.fetch, authorization, company, "skill_coach"),
      callRpc<{ slug: string; name: string; description: string }[]>(
        env,
        deps.fetch,
        authorization,
        "ai_skill_catalog",
        { p_company: company },
      ).then((r) => (r.ok && Array.isArray(r.data) ? r.data : [])),
    ]);
    provider = route;
    if (limits.ok && limits.data?.blocked)
      throw new CoachError(429, limits.data.message ?? "Limite de uso da MAVI atingido.");
    if (!provider && !env.anthropicKey)
      throw new CoachError(
        503,
        "A MAVI não está configurada no servidor. Escolha um provedor para as skills no Painel da MAVI.",
      );
    const llm: LlmAdapter = provider
      ? (deps.providerLlm ?? ((c) => adapterFor(c, deps.fetch)))(provider.config)
      : deps.llm;
    const result = await llm({
      instructions:
        mode === "review"
          ? REVIEW_INSTRUCTIONS
          : COACH_INSTRUCTIONS.replace("{capabilities}", capabilities()),
      context: "",
      messages:
        mode === "review"
          ? [{ role: "user", content: reviewMessage(skill, catalog, origin) }]
          : coachMessages(history, skill, catalog),
      tools: [],
      execute: async () => "",
      maxRounds: 0,
      effort: "medium",
      maxTokens: mode === "review" ? 12_000 : 16_000,
    });
    meter = result.meter;
    const model = meter?.model || provider?.config.model || env.model;
    return {
      status: 200,
      body:
        mode === "review"
          ? { ...parseReview(result.text, skill), model }
          : { ...parseCoach(result.text), model },
    };
  } catch (err) {
    if (err instanceof CoachError) return fail(err.status, err.message);
    const status =
      typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500;
    return fail(status, llmFriendlyError(err));
  } finally {
    if (meter)
      await callRpc(env, deps.fetch, authorization, "ai_log_usage", {
        p_company: company,
        p_module: "skills",
        p_kind: mode === "review" ? "skill_review" : "skill_coach",
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

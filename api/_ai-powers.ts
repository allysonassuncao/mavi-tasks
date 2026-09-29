import crypto from "node:crypto";
import { callRpc, signGcsUrl, type GcsCredentials } from "./_drive.js";
import type { LlmAdapter, ToolSpec } from "./_ai-llm.js";
import { TOOLS, type ToolContext } from "./_ai-tools.js";
import { SKILL_TOOLS } from "./_ai-skills.js";
import {
  priceCost,
  resolveRoute,
  routeConfig,
  type ProviderConfig,
} from "./_ai-providers.js";
import {
  CHART_KINDS,
  IMAGE_SIZES,
  PRIORITIES,
  VISUAL_UNITS,
  SLIDE_LAYOUTS,
  SLIDE_THEMES,
  artifactSummary,
  sanitizeCanvas,
  sanitizeQuestions,
  sanitizeVisual,
  type QuestionArtifact,
  type CanvasArtifact,
  type ActionArtifact,
  type AiArtifact,
  type ImageArtifact,
  type ImageSize,
  type Power,
  type VisualArtifact,
} from "../src/mavi-artifacts.js";
import type { ProviderModel } from "../src/ai-providers.js";

/**
 * MAVI · poderes (migração 20261212090000_mavi_powers): as ferramentas que
 * vão além de consultar, liberadas por administradores e gestores para cada
 * pessoa (ai_my_powers) e só no módulo MAVI.
 *
 * - visualizações: a MAVI descreve (formato fechado de mavi-artifacts) e o
 *   app desenha; nada de código;
 * - imagens: gera ou edita pelo provedor de "Quem usa qual modelo ›
 *   Geração e edição de imagens" (ou o do servidor) e guarda no GCS;
 * - ações: só propostas. O card na conversa pede a confirmação da pessoa, e
 *   a mudança acontece pela tela de sempre, com as permissões de sempre.
 *
 * O registro diz o tipo, o poder e o tempo máximo de cada ferramenta (as de
 * consulta também), para oferecer só o que a pessoa pode usar e registrar
 * cada chamada.
 */

export type ToolKind =
  "read" | "visual" | "image" | "action" | "skill" | "canvas" | "web" | "ask";
export type ToolMeta = { kind: ToolKind; power?: Power; timeoutMs: number };

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const title = {
  type: "string",
  description: "Título curto (o que a visualização mostra, com o período).",
};
const subtitle = {
  type: "string",
  description: "Opcional: fonte ou observação curta (ex.: 'Campanhas de setembro').",
};
const unit = {
  type: "string",
  enum: VISUAL_UNITS,
  description:
    "Unidade dos números: number, money (R$), percent, hours ou days.",
};

export const POWER_TOOLS: ToolSpec[] = [
  {
    name: "show_chart",
    description:
      "Desenha um gráfico na conversa (colunas, barras horizontais, linha, área ou rosca), com dica ao passar o mouse e legenda. Use quando comparar ou mostrar evolução fica mais claro em gráfico. Só números que vieram das ferramentas. Devolve a referência (ex.: V1) para pôr na resposta como [[V1]].",
    parameters: obj(
      {
        title,
        subtitle,
        chart: {
          type: "string",
          enum: CHART_KINDS,
          description:
            "bar (colunas), hbar (barras horizontais, bom para nomes longos), line ou area (evolução no tempo), donut (partes de um todo; uma série só).",
        },
        unit,
        categories: {
          type: "array",
          items: { type: "string" },
          description: "Os rótulos do eixo (datas, clientes, pessoas…), até 60.",
        },
        series: {
          type: "array",
          items: obj(
            {
              name: { type: "string" },
              values: {
                type: "array",
                items: { type: ["number", "null"] },
                description: "Um valor por categoria, na mesma ordem.",
              },
            },
            ["name", "values"],
          ),
          description: "Até 8 séries.",
        },
      },
      ["title", "chart", "unit", "categories", "series"],
    ),
  },
  {
    name: "show_table",
    description:
      "Mostra uma tabela na conversa (a pessoa pode ordenar as colunas). Use para listas com várias colunas (tarefas com responsável e prazo, campanhas com gasto e resultado). Até 200 linhas. Devolve a referência (ex.: V2) para pôr na resposta como [[V2]].",
    parameters: obj(
      {
        title,
        subtitle,
        columns: {
          type: "array",
          items: obj(
            {
              label: { type: "string" },
              unit: {
                type: "string",
                enum: ["text", ...VISUAL_UNITS],
                description: "text (padrão) ou a unidade dos números da coluna.",
              },
            },
            ["label"],
          ),
        },
        rows: {
          type: "array",
          items: {
            type: "array",
            items: { type: ["string", "number", "null"] },
          },
          description: "Cada linha com um valor por coluna, na mesma ordem.",
        },
      },
      ["title", "columns", "rows"],
    ),
  },
  {
    name: "show_kpis",
    description:
      "Mostra números de destaque em cards (ex.: gasto do mês, leads, custo por lead, tarefas atrasadas), com a variação em relação ao período anterior quando houver. Até 8. Devolve a referência para pôr na resposta como [[V3]].",
    parameters: obj(
      {
        title: { type: "string" },
        items: {
          type: "array",
          items: obj(
            {
              label: { type: "string" },
              value: { type: ["number", "string"] },
              unit,
              delta: {
                type: "number",
                description: "Variação em % em relação ao período anterior.",
              },
              good: {
                type: "string",
                enum: ["up", "down"],
                description: "down quando subir é ruim (custo, atraso).",
              },
              note: { type: "string", description: "Linha curta de apoio." },
            },
            ["label", "value"],
          ),
        },
      },
      ["items"],
    ),
  },
  {
    name: "show_timeline",
    description:
      "Mostra uma linha do tempo (reuniões, decisões, entregas em ordem de data). Até 40 itens. Devolve a referência para pôr na resposta como [[V4]].",
    parameters: obj(
      {
        title,
        items: {
          type: "array",
          items: obj(
            {
              date: { type: "string", description: "Data (AAAA-MM-DD ou por extenso)." },
              title: { type: "string" },
              detail: { type: "string" },
            },
            ["date", "title"],
          ),
        },
      },
      ["title", "items"],
    ),
  },
  {
    name: "generate_image",
    description:
      "Gera uma imagem nova ou edita uma imagem desta conversa (edit_ref). Use quando pedirem imagem, arte, ilustração, mockup ou foto conceitual. Demora até um minuto. Devolve a referência (ex.: I1) para pôr na resposta como [[I1]].",
    parameters: obj(
      {
        prompt: {
          type: "string",
          description:
            "A descrição detalhada da imagem: assunto, composição, estilo, luz, cores. O texto que deve aparecer escrito na arte vai entre aspas, em português.",
        },
        size: {
          type: "string",
          enum: ["square", "portrait", "landscape"],
          description: "square (1:1, padrão), portrait (vertical) ou landscape (horizontal).",
        },
        edit_ref: {
          type: "string",
          description: "Para editar uma imagem desta conversa: a referência dela (ex.: I1).",
        },
      },
      ["prompt"],
    ),
  },
  {
    name: "create_document",
    description:
      "Escreve um documento no canvas ao lado da conversa (relatório, proposta, briefing, ata, plano, roteiro, e-mail longo), que a pessoa lê e baixa em Word ou PDF. Use Markdown completo: títulos (#, ##), listas, tabelas, negrito. Para ajustar um documento desta conversa, leia com read_canvas e mande a versão nova inteira com revises. Devolve a referência (ex.: D1).",
    parameters: obj(
      {
        title: { type: "string", description: "O título do documento." },
        markdown: { type: "string", description: "O documento inteiro, em Markdown." },
        revises: { type: "string", description: "Opcional: a referência do documento que esta versão ajusta (ex.: D1)." },
      },
      ["title", "markdown"],
    ),
  },
  {
    name: "create_presentation",
    description:
      "Monta uma apresentação (slides) no canvas, que a pessoa navega e baixa em PowerPoint ou PDF. Use quando pedirem apresentação, slides, deck ou pitch. Uma ideia por slide, tópicos curtos (até 6, com até 12 palavras), layouts variados e notas do apresentador com o que falar. Para ajustar, leia com read_canvas e mande a versão nova inteira com revises. Devolve a referência (ex.: D2).",
    parameters: obj(
      {
        title: { type: "string" },
        theme: { type: "string", enum: SLIDE_THEMES, description: "claro (padrão), escuro ou verde." },
        slides: {
          type: "array",
          description: "De 1 a 40 slides, na ordem.",
          items: obj(
            {
              layout: {
                type: "string",
                enum: SLIDE_LAYOUTS,
                description:
                  "title (capa), section (abertura de seção), bullets (título e tópicos), two_columns (comparação), stats (2 a 4 números em destaque), quote (citação), image (uma imagem desta conversa, ex.: I1, com tópicos opcionais), closing (encerramento).",
              },
              title: { type: "string" },
              subtitle: { type: "string" },
              bullets: { type: "array", items: { type: "string" } },
              left_title: { type: "string" },
              left: { type: "array", items: { type: "string" } },
              right_title: { type: "string" },
              right: { type: "array", items: { type: "string" } },
              stats: {
                type: "array",
                items: obj({ value: { type: "string" }, label: { type: "string" } }, ["value", "label"]),
              },
              quote: { type: "string" },
              author: { type: "string" },
              image: { type: "string", description: "A referência de uma imagem desta conversa (ex.: I1)." },
              notes: { type: "string", description: "O que falar neste slide." },
            },
            ["layout", "title"],
          ),
        },
        revises: { type: "string", description: "Opcional: a apresentação que esta versão ajusta (ex.: D2)." },
      },
      ["title", "slides"],
    ),
  },
  {
    name: "create_spreadsheet",
    description:
      "Monta uma planilha no canvas (uma ou mais abas), que a pessoa baixa em Excel ou CSV. Use quando pedirem planilha, tabela para editar, lista para importar ou controle. Números como números (sem R$ ou % no valor; diga a unidade da coluna). Até 1.000 linhas por aba. Devolve a referência (ex.: D3).",
    parameters: obj(
      {
        title: { type: "string" },
        sheets: {
          type: "array",
          items: obj(
            {
              name: { type: "string", description: "O nome da aba." },
              columns: {
                type: "array",
                items: obj(
                  {
                    label: { type: "string" },
                    unit: { type: "string", enum: ["text", ...VISUAL_UNITS] },
                  },
                  ["label"],
                ),
              },
              rows: {
                type: "array",
                items: { type: "array", items: { type: ["string", "number", "null"] } },
              },
            },
            ["name", "columns", "rows"],
          ),
        },
        revises: { type: "string", description: "Opcional: a planilha que esta versão ajusta (ex.: D3)." },
      },
      ["title", "sheets"],
    ),
  },
  {
    name: "read_canvas",
    description:
      "Lê o conteúdo atual de um documento, apresentação ou planilha desta conversa (D1, D2…), para ajustar sem perder o que já estava.",
    parameters: obj({ ref: { type: "string", description: "A referência (ex.: D1)." } }, ["ref"]),
  },
  {
    name: "propose_task",
    description:
      "Propõe criar uma tarefa. NÃO cria: aparece um card para a pessoa revisar e confirmar no formulário de sempre. Use quando a pessoa pedir para criar uma tarefa. Precisa do cliente (id, de find_clients ou do contexto) e, se ele tiver mais de um produto contratado, do produto.",
    parameters: obj(
      {
        title: { type: "string", description: "Título da tarefa (curto, com o verbo)." },
        description: {
          type: "string",
          description: "O que fazer, o contexto e o que foi combinado (texto simples).",
        },
        client_id: { type: "string", description: "Cliente (id)." },
        product: {
          type: "string",
          description: "O produto contratado do cliente (nome), quando ele tiver mais de um.",
        },
        project: { type: "string", description: "Opcional: o projeto (nome)." },
        assignee: { type: "string", description: "Opcional: nome do responsável sugerido." },
        due_date: { type: "string", description: "Opcional: prazo (AAAA-MM-DD)." },
        priority: { type: "string", enum: [...PRIORITIES] },
      },
      ["title", "client_id"],
    ),
  },
  {
    name: "propose_comment",
    description:
      "Propõe um comentário numa tarefa. NÃO comenta: aparece um card para a pessoa confirmar. A tarefa é a referência dela nas ferramentas (ex.: S3, de list_tasks ou search_knowledge).",
    parameters: obj(
      {
        task_ref: { type: "string", description: "A referência da tarefa (ex.: S3)." },
        text: { type: "string", description: "O comentário, em texto simples." },
      },
      ["task_ref", "text"],
    ),
  },
];

/** Perguntar antes de seguir: nas duas MAVIs, sem poder (é o jeito de trabalhar). */
export const ASK_TOOL: ToolSpec = {
  name: "ask_user",
  description:
    "Faz perguntas à pessoa antes de seguir, com respostas prováveis para ela escolher (ela também pode escrever outra). Use quando o pedido for ambíguo de um jeito que muda o resultado, ou antes de um trabalho grande (apresentação, documento, planilha, imagem, ação, análise longa). Depois de chamar, não use mais ferramentas: escreva uma frase curta e espere as respostas.",
  parameters: obj(
    {
      questions: {
        type: "array",
        description: "De 1 a 3 perguntas curtas.",
        items: obj(
          {
            question: { type: "string" },
            options: {
              type: "array",
              items: { type: "string" },
              description: "De 2 a 5 respostas prováveis, curtas (a pessoa também pode escrever outra).",
            },
            multiple: { type: "boolean", description: "true quando dá para escolher mais de uma." },
          },
          ["question", "options"],
        ),
      },
    },
    ["questions"],
  ),
};

/** Quando e como perguntar (nas duas MAVIs). */
export const ASK_RULES = `

Perguntar antes de seguir (ask_user):
- Pergunte quando o pedido estiver ambíguo de um jeito que muda o resultado (qual cliente, qual período, para quem é, objetivo, formato, tom, tamanho) ou antes de um trabalho grande ou caro (apresentação, documento, planilha, imagem, ação, análise longa) quando faltar algo importante.
- Até 3 perguntas curtas, cada uma com 2 a 5 respostas prováveis: as que você acha mais prováveis primeiro. Junte tudo numa chamada só.
- Não pergunte o que dá para descobrir com as ferramentas (busque antes), nem o óbvio, nem de novo o que a pessoa já disse. Consulta rápida não precisa de pergunta: responda.
- Se a pessoa disser para seguir sem responder, siga com o mais provável e diga em uma frase o que assumiu.
- Depois de ask_user, não chame mais ferramentas: escreva uma frase curta dizendo o que vai fazer com as respostas, e pare.`;

export const REGISTRY: Record<string, ToolMeta> = {
  ...Object.fromEntries(
    TOOLS.map((t) => [t.name, { kind: "read" as const, timeoutMs: 45_000 }]),
  ),
  show_chart: { kind: "visual", power: "visuals", timeoutMs: 5_000 },
  show_table: { kind: "visual", power: "visuals", timeoutMs: 5_000 },
  show_kpis: { kind: "visual", power: "visuals", timeoutMs: 5_000 },
  show_timeline: { kind: "visual", power: "visuals", timeoutMs: 5_000 },
  generate_image: { kind: "image", power: "images", timeoutMs: 170_000 },
  propose_task: { kind: "action", power: "actions", timeoutMs: 20_000 },
  propose_comment: { kind: "action", power: "actions", timeoutMs: 20_000 },
  create_document: { kind: "canvas", power: "canvas", timeoutMs: 10_000 },
  create_presentation: { kind: "canvas", power: "canvas", timeoutMs: 10_000 },
  create_spreadsheet: { kind: "canvas", power: "canvas", timeoutMs: 10_000 },
  read_canvas: { kind: "canvas", power: "canvas", timeoutMs: 5_000 },
  // A busca da Claude roda no servidor dela: só para o registro.
  web_search: { kind: "web", power: "web", timeoutMs: 0 },
  web_fetch: { kind: "web", power: "web", timeoutMs: 0 },
  ask_user: { kind: "ask", timeoutMs: 5_000 },
  web_research: { kind: "web", power: "web", timeoutMs: 150_000 },
  // Com modelo próprio, a skill roda inteira como ajudante: pode demorar.
  use_skill: { kind: "skill", power: "skills", timeoutMs: 150_000 },
  read_skill_file: { kind: "skill", power: "skills", timeoutMs: 15_000 },
};

/** A busca na internet por outro modelo (o de "Quem usa qual modelo › Busca na internet"). */
export const WEB_RESEARCH_TOOL: ToolSpec = {
  name: "web_research",
  description:
    "Pesquisa na internet (notícias, concorrentes, tendências, dados públicos, o conteúdo de um link) e devolve um resumo com as páginas citadas como fontes [S#]. Faça a pergunta completa, com o contexto que importa.",
  parameters: obj(
    { question: { type: "string", description: "O que pesquisar, com o contexto." } },
    ["question"],
  ),
};

/** No modo escritor, o canvas recebe o pedido e o material; outro modelo escreve. */
const briefTool = (name: string, what: string, extra: Record<string, unknown> = {}): ToolSpec => ({
  name,
  description: `${what} Um modelo escritor faz o conteúdo a partir do pedido e do material que você mandar: junte antes, com as ferramentas, tudo o que ele precisa (números, fatos, nomes, datas, com as referências [S#]). Para ajustar um que já existe, leia com read_canvas e diga o que muda. Devolve a referência (ex.: D1).`,
  parameters: obj(
    {
      title: { type: "string" },
      brief: {
        type: "string",
        description: "O que fazer: objetivo, público, estrutura, tom, tamanho e o que a pessoa pediu.",
      },
      material: {
        type: "string",
        description: "Os dados e fatos que o conteúdo deve usar, com as referências [S#] das fontes.",
      },
      revises: { type: "string", description: "Opcional: a referência que esta versão ajusta (ex.: D1)." },
      ...extra,
    },
    ["title", "brief", "material"],
  ),
});
export const WRITER_TOOLS: ToolSpec[] = [
  briefTool(
    "create_document",
    "Escreve um documento no canvas ao lado da conversa (relatório, proposta, briefing, ata, plano, roteiro), que a pessoa baixa em Word ou PDF.",
  ),
  briefTool(
    "create_presentation",
    "Monta uma apresentação no canvas, que a pessoa baixa em PowerPoint ou PDF.",
    { theme: { type: "string", enum: SLIDE_THEMES, description: "claro (padrão), escuro ou verde." } },
  ),
  briefTool(
    "create_spreadsheet",
    "Monta uma planilha no canvas, que a pessoa baixa em Excel ou CSV.",
  ),
];

/**
 * As ferramentas desta pergunta: as de consulta, a de perguntar e as dos
 * poderes da pessoa. Com um escritor no canvas, as de criar recebem o pedido
 * em vez do conteúdo; com um modelo para a busca, ela vira web_research.
 */
export function toolsFor(
  powers: ReadonlySet<Power>,
  options: { writer?: boolean; webResearch?: boolean } = {},
): ToolSpec[] {
  const writer = new Map(WRITER_TOOLS.map((t) => [t.name, t]));
  return [
    ...TOOLS,
    ASK_TOOL,
    ...[...POWER_TOOLS, ...SKILL_TOOLS]
      .filter((t) => {
        const power = REGISTRY[t.name]?.power;
        return !!power && powers.has(power);
      })
      .map((t) => (options.writer && writer.get(t.name)) || t),
    ...(options.webResearch && powers.has("web") ? [WEB_RESEARCH_TOOL] : []),
  ];
}

const POWER_NAMES: Record<Power, string> = {
  visuals: "visualizações (gráficos, tabelas, indicadores)",
  images: "imagens",
  actions: "ações (criar tarefa, comentar)",
  skills: "skills",
  canvas: "documentos, apresentações e planilhas",
  web: "busca na internet",
};

/** O que muda nas instruções da MAVI quando ela tem poderes. */
export function powerInstructions(powers: ReadonlySet<Power>, onPage = false) {
  // No módulo, a MAVI sabe o que está desligado (e diz, em vez de improvisar).
  const off = (Object.keys(POWER_NAMES) as Power[]).filter((p) => !powers.has(p));
  const offLine =
    onPage && off.length
      ? `\nPoderes desligados para esta pessoa: ${off.map((p) => POWER_NAMES[p]).join(", ")}. Se o pedido precisar de um deles, faça o que der e diga que um administrador ou gestor liga em Painel da MAVI › Poderes.`
      : "";
  if (!powers.size) return offLine ? `\n${offLine}` : "";
  const lines = [
    "",
    "Poderes liberados nesta conversa (além de consultar):",
  ];
  if (powers.has("visuals"))
    lines.push(
      "- Visualizações (show_chart, show_table, show_kpis, show_timeline): quando comparar, mostrar evolução, listar com várias colunas ou destacar números fica mais claro visualmente, desenhe. Use só números que vieram das ferramentas; nunca invente nem arredonde para caber. Para gráficos no tempo (dia a dia, evolução), busque antes os números de cada dia (campaign_results com by_day). Tabelas vão por show_table (não escreva tabelas em texto).",
    );
  if (powers.has("images"))
    lines.push(
      "- Imagens (generate_image): quando pedirem uma imagem, arte, ilustração, mockup ou foto conceitual. Escreva um prompt detalhado; o texto que deve aparecer na arte vai entre aspas, em português. Para ajustar uma imagem desta conversa, use edit_ref (ex.: I1). Não gere pessoas reais identificáveis nem logos e marcas de terceiros; para a marca do cliente, peça os arquivos dele.",
    );
  if (powers.has("canvas"))
    lines.push(
      "- Documentos, apresentações e planilhas (create_document, create_presentation, create_spreadsheet): quando pedirem um relatório, proposta, briefing, ata, plano, roteiro, apresentação, slides, deck, pitch, planilha ou tabela para editar, crie no canvas em vez de escrever tudo na conversa. Antes, busque os dados que o conteúdo precisa. Para ajustar um que já existe nesta conversa, leia com read_canvas e mande a versão inteira com revises. Na resposta, só [[D1]] e um resumo curto do que foi feito; não repita o conteúdo.",
    );
  if (powers.has("web"))
    lines.push(
      "- Busca na internet (web_search e web_fetch): para o que não está no sistema — notícias, concorrentes, tendências, dados públicos, referências, a página de um link. Busque antes de afirmar algo recente e diga de onde veio (as páginas citadas viram fontes). Deixe claro o que veio da internet e o que veio do sistema da agência.",
    );
  if (powers.has("actions"))
    lines.push(
      "- Ações (propose_task, propose_comment): quando a pessoa pedir para criar uma tarefa ou comentar numa. Você só propõe: a pessoa confirma no card. Nunca diga que a tarefa foi criada ou o comentário enviado; diga que está pronto para ela revisar e confirmar. Antes, confirme o cliente com find_clients quando não estiver no contexto.",
    );
  lines.push(
    "- Cada ferramenta dessas devolve uma referência (V1, I1, A1). Na resposta, escreva a referência entre colchetes duplos sozinha numa linha (ex.: [[V1]]) no ponto em que ela deve aparecer, e comente o essencial em texto, sem repetir todos os números. As citações [S#] continuam valendo no texto.",
  );
  return lines.join("\n") + offLine;
}

// ------------------------------------------------------------ execução
export type ImageEnv = {
  supabaseUrl: string;
  supabaseKey: string;
  providerKey: Buffer | null;
  openaiKey: string;
  /** O modelo de imagem do servidor (IMAGE_MODEL). */
  imageModel: string;
  credentials?: GcsCredentials | null;
  bucket?: string;
};
export type PowerKit = {
  ctx: ToolContext;
  env: ImageEnv;
  /** Os anexos desta resposta, na ordem. */
  artifacts: AiArtifact[];
  /** Imagens das respostas anteriores da conversa (ref → caminho). */
  priorImages: Map<string, string>;
  /** O próximo número de cada tipo de referência (V, I, A, D). */
  next: Record<"V" | "I" | "A" | "D" | "Q", number>;
  /** Documentos, apresentações e planilhas das respostas anteriores (ref → anexo). */
  priorCanvas: Map<string, CanvasArtifact>;
  emit: (artifact: AiArtifact) => void;
  /** Gasto com imagens nesta resposta (para o consumo). */
  imageCost: { usd: number; model: string; provider: string | null };
  /** O escritor do canvas ("Quem usa qual modelo"), quando há. */
  writer?: { llm: LlmAdapter; model: string; name: string; providerId: string } | null;
  /** A MAVI perguntou: nada mais roda nesta resposta. */
  asked?: boolean;
  /** Gasto dos outros modelos nesta resposta (escritor), para o consumo. */
  extraCost?: { usd: number };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

function add<T extends AiArtifact>(
  kit: PowerKit,
  letter: "V" | "I" | "A" | "D" | "Q",
  a: Omit<T, "id" | "ref">,
) {
  const artifact = {
    ...a,
    id: crypto.randomUUID(),
    ref: `${letter}${kit.next[letter]++}`,
  } as T;
  kit.artifacts.push(artifact);
  kit.emit(artifact);
  return artifact;
}

async function rest<T>(kit: PowerKit, path: string): Promise<T[]> {
  const { ctx } = kit;
  const res = await ctx.fetch(`${ctx.supabaseUrl}/rest/v1/${path}`, {
    headers: { apikey: ctx.supabaseKey, Authorization: ctx.auth },
  });
  if (!res.ok) throw new Error("Não foi possível consultar o banco.");
  return (await res.json()) as T[];
}

function showVisual(kit: PowerKit, name: string, input: Record<string, unknown>) {
  const kind =
    name === "show_chart"
      ? "chart"
      : name === "show_table"
        ? "table"
        : name === "show_kpis"
          ? "kpis"
          : "timeline";
  const visual = sanitizeVisual({ ...input, kind });
  if (!visual)
    return "Não deu para desenhar: faltaram dados (categorias com valores, colunas com linhas ou itens). Confira e tente de novo, ou responda em texto.";
  if (kind === "kpis" && Array.isArray(input.items) && input.items.length > 8)
    return "Use até 8 indicadores.";
  const a = add<VisualArtifact>(kit, "V", { type: "visual", visual });
  return `Mostrado para a pessoa como ${a.ref} (${artifactSummary(a)}). Na resposta, escreva [[${a.ref}]] sozinho numa linha onde ele deve aparecer.`;
}

// ------------------------------------------------------------ imagens
/** Preço de tabela por imagem (US$), quando o provedor não diz os tokens. */
const IMAGE_PRICES: [RegExp, number][] = [
  [/gpt-image-1-mini/i, 0.011],
  [/gpt-image/i, 0.042],
  [/dall-e-3/i, 0.04],
  [/dall-e-2/i, 0.02],
  [/imagen-4.*ultra/i, 0.06],
  [/imagen-4.*fast/i, 0.02],
  [/imagen/i, 0.04],
  [/grok/i, 0.07],
  [/flux/i, 0.04],
];
/** gpt-image-1 pelos preços de tabela da OpenAI (US$ por milhão de tokens). */
const GPT_IMAGE_PRICE: ProviderModel = { id: "gpt-image-1", input: 5, output: 40 };

export function imageCost(
  model: string,
  price: ProviderModel | null,
  usage: { input_tokens?: number; output_tokens?: number } | null | undefined,
) {
  const tokens = {
    input: Number(usage?.input_tokens) || 0,
    output: Number(usage?.output_tokens) || 0,
    cached: 0,
  };
  const table = price ?? (/gpt-image-1(?!-mini)/i.test(model) ? GPT_IMAGE_PRICE : null);
  if (table && (tokens.input || tokens.output)) return priceCost(table, tokens);
  return IMAGE_PRICES.find(([re]) => re.test(model))?.[1] ?? 0.04;
}

/** O tamanho que cada modelo aceita. */
export function imageSizeFor(model: string, size: ImageSize) {
  if (/dall-e-3/i.test(model))
    return { square: "1024x1024", portrait: "1024x1792", landscape: "1792x1024" }[size];
  if (/dall-e-2/i.test(model)) return "1024x1024";
  return IMAGE_SIZES[size];
}

async function imageProvider(kit: PowerKit): Promise<ProviderConfig & { providerId: string | null }> {
  const { ctx, env } = kit;
  const route = await resolveRoute(
    env,
    ctx.fetch,
    ctx.auth,
    ctx.company,
    ctx.scope,
    "image_generation",
  );
  if (route) return { ...routeConfig(env, route), providerId: route.provider_id };
  if (!env.openaiKey)
    throw new Error(
      "Nenhum modelo de imagem configurado. Um administrador escolhe em Painel da MAVI › Quem usa qual modelo › Geração e edição de imagens.",
    );
  return {
    kind: "openai",
    name: "OpenAI (servidor)",
    baseUrl: "https://api.openai.com/v1",
    apiKey: env.openaiKey,
    model: env.imageModel,
    price: null,
    providerId: null,
  };
}

async function gcsGet(env: ImageEnv, fetchImpl: typeof fetch, path: string) {
  if (!env.credentials || !env.bucket) throw new Error("Credenciais do GCS não configuradas.");
  const res = await fetchImpl(
    signGcsUrl(env.credentials, env.bucket, path, "GET", { expiresInSeconds: 300 }),
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!res.ok) throw new Error(`Não foi possível abrir a imagem (${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

type Made =
  | {
      bytes: Uint8Array;
      usage?: { input_tokens?: number; output_tokens?: number };
      cost?: number;
    }
  | string;
const refused = (why: string, code = "") =>
  /safety|policy|moderation|content/i.test(`${why} ${code}`)
    ? "O provedor recusou gerar esta imagem pelas regras de conteúdo dele. Explique à pessoa e sugira outro caminho."
    : null;

/** OpenAI e compatíveis (Google Imagen, xAI): /images/generations e /images/edits. */
async function openAiImage(
  kit: PowerKit,
  provider: ProviderConfig,
  prompt: string,
  size: ImageSize,
  source: string | undefined,
): Promise<Made> {
  const { ctx, env } = kit;
  const headers = { Authorization: `Bearer ${provider.apiKey}` };
  const gptImage = /gpt-image/i.test(provider.model);
  let res: Response;
  if (source) {
    if (!gptImage && provider.kind !== "custom")
      return `O modelo de imagem configurado (${provider.model}) não edita imagens. Gere uma nova com o prompt completo, descrevendo o que muda.`;
    const form = new FormData();
    form.append("model", provider.model);
    form.append("prompt", prompt);
    form.append("size", imageSizeFor(provider.model, size));
    form.append(
      "image",
      new Blob([await gcsGet(env, ctx.fetch, source)], { type: "image/png" }),
      "image.png",
    );
    res = await ctx.fetch(`${provider.baseUrl}/images/edits`, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(160_000),
    });
  } else {
    // O tamanho e o formato só onde a API aceita (OpenAI e endereços compatíveis).
    const openAiLike = provider.kind === "openai" || provider.kind === "custom";
    res = await ctx.fetch(`${provider.baseUrl}/images/generations`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: provider.model,
        prompt,
        n: 1,
        ...(openAiLike ? { size: imageSizeFor(provider.model, size) } : {}),
        ...(gptImage ? {} : { response_format: "b64_json" }),
      }),
      signal: AbortSignal.timeout(160_000),
    });
  }
  const body = (await res.json().catch(() => ({}))) as {
    data?: { b64_json?: string; url?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string; code?: string };
  };
  if (!res.ok) {
    const why = body.error?.message ?? `erro ${res.status}`;
    const no = refused(why, body.error?.code);
    if (no) return no;
    throw new Error(`O provedor de imagem respondeu: ${why.slice(0, 200)}`);
  }
  const first = body.data?.[0];
  if (first?.b64_json) return { bytes: Buffer.from(first.b64_json, "base64"), usage: body.usage };
  if (first?.url && /^https:\/\//.test(first.url)) {
    const img = await ctx.fetch(first.url, { signal: AbortSignal.timeout(60_000) });
    if (!img.ok) throw new Error("Não foi possível baixar a imagem gerada.");
    return { bytes: new Uint8Array(await img.arrayBuffer()), usage: body.usage };
  }
  throw new Error("O provedor não devolveu a imagem.");
}

/**
 * OpenRouter: os modelos de imagem (Gemini, GPT, Flux…) respondem pelo chat,
 * com modalities ["image", "text"]; para editar, a imagem vai junto.
 */
async function openRouterImage(
  kit: PowerKit,
  provider: ProviderConfig,
  prompt: string,
  size: ImageSize,
  source: string | undefined,
): Promise<Made> {
  const { ctx, env } = kit;
  const content: unknown[] = [{ type: "text", text: prompt }];
  if (source)
    content.push({
      type: "image_url",
      image_url: {
        url: `data:image/png;base64,${Buffer.from(await gcsGet(env, ctx.fetch, source)).toString("base64")}`,
      },
    });
  const res = await ctx.fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [{ role: "user", content }],
      modalities: ["image", "text"],
      image_config: { aspect_ratio: { square: "1:1", portrait: "2:3", landscape: "3:2" }[size] },
      usage: { include: true },
    }),
    signal: AbortSignal.timeout(160_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    choices?: {
      message?: { content?: string | null; images?: { image_url?: { url?: string } }[] };
    }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    error?: { message?: string; code?: string | number };
  };
  if (!res.ok) {
    const why = body.error?.message ?? `erro ${res.status}`;
    const no = refused(why, String(body.error?.code ?? ""));
    if (no) return no;
    throw new Error(`O OpenRouter respondeu: ${why.slice(0, 200)}`);
  }
  const url = body.choices?.[0]?.message?.images?.[0]?.image_url?.url ?? "";
  const data = url.match(/^data:image\/[a-z+]+;base64,(.+)$/i);
  let bytes: Uint8Array;
  if (data) bytes = Buffer.from(data[1], "base64");
  else if (/^https:\/\//.test(url)) {
    const img = await ctx.fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!img.ok) throw new Error("Não foi possível baixar a imagem gerada.");
    bytes = new Uint8Array(await img.arrayBuffer());
  } else {
    const said = body.choices?.[0]?.message?.content?.trim();
    return `O modelo ${provider.model} não devolveu uma imagem${said ? ` (respondeu: “${said.slice(0, 200)}”)` : ""}. Confira se ele gera imagens no OpenRouter, ou gere de novo com outro prompt.`;
  }
  const usage = {
    input_tokens: Number(body.usage?.prompt_tokens) || 0,
    output_tokens: Number(body.usage?.completion_tokens) || 0,
  };
  const cost = Number(body.usage?.cost);
  return { bytes, usage, ...(Number.isFinite(cost) && cost >= 0 ? { cost } : {}) };
}

async function generateImage(kit: PowerKit, input: Record<string, unknown>) {
  const { ctx, env } = kit;
  const prompt = str(input.prompt).slice(0, 4000);
  if (prompt.length < 3) return "Descreva a imagem no prompt.";
  const size = (["square", "portrait", "landscape"] as const).includes(input.size as ImageSize)
    ? (input.size as ImageSize)
    : "square";
  const editRef = str(input.edit_ref).toUpperCase();
  const source = editRef
    ? (kit.artifacts.find(
        (a): a is ImageArtifact => a.type === "image" && a.ref === editRef,
      )?.path ?? kit.priorImages.get(editRef))
    : undefined;
  if (editRef && !source)
    return `Não achei a imagem ${editRef} nesta conversa. Gere uma nova com o prompt completo.`;
  if (!env.credentials || !env.bucket)
    throw new Error("Credenciais do GCS não configuradas para guardar a imagem.");
  const provider = await imageProvider(kit);
  const made =
    provider.kind === "openrouter"
      ? await openRouterImage(kit, provider, prompt, size, source)
      : await openAiImage(kit, provider, prompt, size, source);
  if (typeof made === "string") return made;
  const { bytes, usage } = made;
  const path = `ai-images/${ctx.company}/${crypto.randomUUID()}.png`;
  const put = await ctx.fetch(
    signGcsUrl(env.credentials, env.bucket, path, "PUT", { contentType: "image/png" }),
    {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: bytes,
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!put.ok) throw new Error(`Não foi possível guardar a imagem (${put.status}).`);
  // O OpenRouter diz o custo; senão, pelos tokens ou pela tabela.
  const cost = made.cost ?? imageCost(provider.model, provider.price, usage);
  kit.imageCost.usd += cost;
  kit.imageCost.model = provider.model;
  kit.imageCost.provider = provider.providerId;
  await callRpc(env, ctx.fetch, ctx.auth, "ai_log_usage", {
    p_company: ctx.company,
    p_module: ctx.scope.module ?? "assistant",
    p_kind: "image",
    p_client: ctx.scope.client ?? null,
    p_contract: ctx.scope.contract ?? null,
    p_project: ctx.scope.project ?? null,
    p_recording: null,
    p_model: provider.model,
    p_input: Number(usage?.input_tokens) || 0,
    p_output: Number(usage?.output_tokens) || 0,
    p_cache_read: 0,
    p_cache_write: 0,
    p_embedding: 0,
    p_cost: Math.round(cost * 1e6) / 1e6,
    ...(provider.providerId ? { p_provider: provider.providerId } : {}),
  }).catch(() => {});
  const a = add<ImageArtifact>(kit, "I", {
    type: "image",
    path,
    prompt,
    size,
    model: provider.model,
    ...(source ? { edited_from: editRef } : {}),
    url: signGcsUrl(env.credentials, env.bucket, path, "GET", { expiresInSeconds: 3600 }),
  });
  return `Imagem pronta, mostrada para a pessoa como ${a.ref}. Na resposta, escreva [[${a.ref}]] sozinho numa linha e diga em uma frase o que foi feito (sem descrever o prompt inteiro).`;
}

// ------------------------------------------------------------ canvas
function findCanvas(kit: PowerKit, ref: string) {
  const r = ref.toUpperCase();
  return (
    [...kit.artifacts].reverse().find(
      (a): a is CanvasArtifact => a.type === "canvas" && a.ref === r,
    ) ?? kit.priorCanvas.get(r)
  );
}
const WRITER_RULES = `Você escreve para a MAVI, a inteligência de uma agência de marketing. Use só o material recebido: não invente números, nomes, datas ou citações; onde faltar dado, deixe claro (ex.: "[a confirmar]"). Mantenha as referências [S#] do material junto das informações que vieram delas. Português do Brasil, claro e profissional.`;
const WRITER_FORMAT: Record<"document" | "slides" | "sheet", string> = {
  document: `${WRITER_RULES}\nDevolva só o documento, em Markdown completo (títulos com # e ##, listas, tabelas quando ajudar, negrito no essencial). Sem comentários antes ou depois.`,
  slides: `${WRITER_RULES}\nDevolva só um JSON: {"slides": [...]} com de 6 a 15 slides. Cada slide: {"layout", "title", e os campos do layout}. Layouts: "title" (capa: title, subtitle), "section" (title, subtitle), "bullets" (title, subtitle opcional, bullets: até 6 tópicos de até 12 palavras), "two_columns" (title, left_title, left, right_title, right), "stats" (title, stats: 2 a 4 {value, label}, subtitle opcional), "quote" (quote, author), "closing" (title, subtitle). Uma ideia por slide, layouts variados, e em cada slide "notes" com o que falar. Sem nada fora do JSON.`,
  sheet: `${WRITER_RULES}\nDevolva só um JSON: {"sheets": [{"name", "columns": [{"label", "unit"}], "rows": [[...]]}]}. unit: text, number, money, percent, hours ou days. Números como números (sem R$ nem %). Até 1.000 linhas por aba. Sem nada fora do JSON.`,
};
/** O primeiro objeto JSON de um texto (o modelo às vezes cerca com ```). */
export function jsonFrom(text: string): unknown {
  const t = text.replace(/^[\s\S]*?```(?:json)?\s*/i, (m) => (/```/.test(m) ? "" : m)).replace(/```[\s\S]*$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** O escritor faz o conteúdo a partir do pedido e do material. */
async function write(
  kit: PowerKit,
  kind: "document" | "slides" | "sheet",
  input: Record<string, unknown>,
  previous?: CanvasArtifact,
) {
  const writer = kit.writer!;
  const out = await writer.llm({
    instructions: WRITER_FORMAT[kind],
    context: `Hoje: ${kit.ctx.today}.`,
    messages: [
      {
        role: "user",
        content: [
          `Título: ${str(input.title)}`,
          `Pedido: ${str(input.brief)}`,
          `Material:\n${str(input.material)}`,
          previous ? `Versão atual (ajuste a partir dela):\n${JSON.stringify(previous.canvas).slice(0, 60_000)}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
    tools: [],
    execute: async () => "",
    maxRounds: 0,
    maxTokens: 32_000,
  });
  if (kit.extraCost) kit.extraCost.usd += out.meter.cost;
  await callRpc(kit.env, kit.ctx.fetch, kit.ctx.auth, "ai_log_usage", {
    p_company: kit.ctx.company,
    p_module: kit.ctx.scope.module ?? "assistant",
    p_kind: "canvas",
    p_client: kit.ctx.scope.client ?? null,
    p_contract: kit.ctx.scope.contract ?? null,
    p_project: kit.ctx.scope.project ?? null,
    p_recording: null,
    p_model: out.meter.model || writer.model,
    p_input: out.meter.input,
    p_output: out.meter.output,
    p_cache_read: out.meter.cacheRead,
    p_cache_write: out.meter.cacheWrite,
    p_embedding: 0,
    p_cost: Math.round(out.meter.cost * 1e6) / 1e6,
    p_provider: writer.providerId,
  }).catch(() => {});
  if (kind === "document") return { title: input.title, markdown: out.text };
  const data = jsonFrom(out.text) as Record<string, unknown> | null;
  return data ? { ...data, title: input.title, theme: input.theme ?? data.theme } : null;
}

async function createCanvas(kit: PowerKit, name: string, input: Record<string, unknown>) {
  const kind =
    name === "create_document" ? "document" : name === "create_presentation" ? "slides" : "sheet";
  const revisesRef = str(input.revises).toUpperCase();
  const before = revisesRef ? findCanvas(kit, revisesRef) : undefined;
  // Com escritor: o pedido e o material vão para ele; o conteúdo volta.
  const content = kit.writer && str(input.brief) ? await write(kit, kind, input, before) : input;
  if (!content) return "O escritor não devolveu o conteúdo no formato certo. Tente de novo com um pedido mais direto.";
  const canvas = sanitizeCanvas({ ...content, kind });
  if (!canvas)
    return kind === "document"
      ? "Não deu para criar: mande o documento inteiro em markdown."
      : kind === "slides"
        ? "Não deu para criar: mande pelo menos um slide com título."
        : "Não deu para criar: cada aba precisa de colunas e linhas.";
  const previous = before;
  if (canvas.kind === "slides") {
    const missing = canvas.slides
      .map((s) => s.image)
      .filter((i): i is string => !!i)
      .filter((i) => !kit.priorImages.has(i) && !kit.artifacts.some((a) => a.type === "image" && a.ref === i));
    if (missing.length)
      return `As imagens ${missing.join(", ")} não existem nesta conversa: gere antes com generate_image ou tire dos slides.`;
  }
  const a = add<CanvasArtifact>(kit, "D", {
    type: "canvas",
    canvas,
    ...(previous ? { revision_of: previous.ref } : {}),
  });
  return `Pronto no canvas como ${a.ref} (${artifactSummary(a)}), aberto ao lado da conversa. Na resposta, escreva [[${a.ref}]] sozinho numa linha e um resumo curto (não repita o conteúdo).`;
}
function readCanvas(kit: PowerKit, input: Record<string, unknown>) {
  const a = findCanvas(kit, str(input.ref));
  if (!a) return `Não há ${str(input.ref) || "esse documento"} nesta conversa.`;
  return `${artifactSummary(a)} (${a.ref}), no formato em que foi criado:\n${JSON.stringify(a.canvas).slice(0, 80_000)}`;
}

// ------------------------------------------------------------ perguntas
function askUser(kit: PowerKit, input: Record<string, unknown>) {
  const questions = sanitizeQuestions(input.questions);
  if (!questions) return "Mande de 1 a 3 perguntas, cada uma com respostas prováveis.";
  const a = add<QuestionArtifact>(kit, "Q", { type: "question", questions });
  kit.asked = true;
  return `As perguntas (${a.ref}) estão na tela para a pessoa responder. Não chame mais ferramentas: escreva uma frase curta dizendo o que vai fazer com as respostas, e pare.`;
}

// ------------------------------------------------------------ ações
async function proposeTask(kit: PowerKit, input: Record<string, unknown>) {
  const { ctx } = kit;
  const title = str(input.title).slice(0, 200);
  if (title.length < 2) return "Dê um título à tarefa.";
  const client = ctx.scope.client ?? str(input.client_id);
  if (!UUID.test(client))
    return "Preciso do id do cliente: use find_clients primeiro.";
  const [row] = await rest<{
    id: string;
    name: string;
    contracts: {
      id: string;
      name: string;
      archived: boolean;
      products: { name: string } | null;
      projects: { id: string; name: string; archived: boolean }[];
    }[];
  }>(
    kit,
    `clients?select=id,name,contracts(id,name,archived,products(name),projects(id,name,archived))&company_id=eq.${ctx.company}&id=eq.${client}`,
  );
  if (!row) return "Cliente não encontrado entre os que a pessoa acessa.";
  const open = row.contracts.filter((k) => !k.archived);
  if (!open.length)
    return `O cliente ${row.name} não tem produto contratado ativo: não dá para criar tarefa nele.`;
  const label = (k: (typeof open)[number]) => k.products?.name ?? k.name;
  const wanted = fold(str(input.product));
  const matches = wanted
    ? open.filter((k) => fold(label(k)).includes(wanted) || fold(k.name).includes(wanted))
    : open;
  if (matches.length !== 1)
    return `Qual produto do cliente ${row.name}? ${matches.length ? "Opções" : "Não achei esse; os contratados são"}: ${(matches.length ? matches : open).map(label).join(", ")}. Pergunte à pessoa se não souber.`;
  const contract = matches[0];
  const projectName = fold(str(input.project));
  const project = projectName
    ? contract.projects.find((p) => !p.archived && fold(p.name).includes(projectName))
    : undefined;
  const who = fold(str(input.assignee));
  const assignee = who
    ? [...ctx.members].find(([, m]) => fold(m.name).includes(who))
    : undefined;
  const due = str(input.due_date);
  const priority = PRIORITIES.includes(input.priority as (typeof PRIORITIES)[number])
    ? (input.priority as (typeof PRIORITIES)[number])
    : undefined;
  const description = str(input.description).slice(0, 4000);
  const a = add<ActionArtifact>(kit, "A", {
    type: "action",
    state: "pending",
    action: {
      kind: "create_task",
      title,
      ...(description ? { description } : {}),
      client_id: row.id,
      client_name: row.name,
      contract_id: contract.id,
      contract_name: label(contract),
      ...(project ? { project_id: project.id, project_name: project.name } : {}),
      ...(assignee ? { assignee_id: assignee[0], assignee_name: assignee[1].name } : {}),
      ...(DATE.test(due) && due >= ctx.today ? { due } : {}),
      ...(priority ? { priority } : {}),
    },
  });
  const notes = [
    projectName && !project ? `o projeto “${str(input.project)}” não foi achado (fica sem projeto)` : "",
    who && !assignee ? `ninguém chamado “${str(input.assignee)}” na empresa (a pessoa escolhe no formulário)` : "",
    DATE.test(due) && due < ctx.today ? "o prazo sugerido já passou (fica o padrão)" : "",
  ].filter(Boolean);
  return `Proposta pronta como ${a.ref}: a pessoa revisa e confirma no formulário de sempre. Nada foi criado ainda.${notes.length ? ` Observações: ${notes.join("; ")}.` : ""} Na resposta, escreva [[${a.ref}]] sozinho numa linha.`;
}

async function proposeComment(kit: PowerKit, input: Record<string, unknown>) {
  const { ctx } = kit;
  const ref = str(input.task_ref).toUpperCase();
  const source = ctx.sources.find((s) => s.ref === ref && s.type === "task");
  const id = source?.id ?? (UUID.test(str(input.task_ref)) ? str(input.task_ref) : "");
  if (!id) return `Não achei a tarefa ${ref || "citada"}: busque com list_tasks e use a referência [S#] dela.`;
  if (source?.restricted) return "A pessoa não abre esta tarefa: não dá para comentar nela.";
  const text = str(input.text).slice(0, 4000);
  if (text.length < 2) return "Escreva o comentário.";
  const [task] = await rest<{ id: string; title: string }>(
    kit,
    `tasks?select=id,title&company_id=eq.${ctx.company}&id=eq.${id}`,
  );
  if (!task) return "A pessoa não abre esta tarefa: não dá para comentar nela.";
  const a = add<ActionArtifact>(kit, "A", {
    type: "action",
    state: "pending",
    action: { kind: "comment_task", task_id: task.id, task_title: task.title, text },
  });
  return `Proposta pronta como ${a.ref}: a pessoa confirma no card. Nada foi enviado ainda. Na resposta, escreva [[${a.ref}]] sozinho numa linha.`;
}

export async function runPowerTool(kit: PowerKit, name: string, raw: unknown) {
  const input =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  if (name.startsWith("show_")) return showVisual(kit, name, input);
  if (name === "read_canvas") return readCanvas(kit, input);
  if (name === "ask_user") return askUser(kit, input);
  if (name.startsWith("create_")) return createCanvas(kit, name, input);
  if (name === "generate_image") return generateImage(kit, input);
  if (name === "propose_task") return proposeTask(kit, input);
  if (name === "propose_comment") return proposeComment(kit, input);
  return `Ferramenta desconhecida: ${name}.`;
}

export function describePowerStep(name: string, raw: unknown) {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const t = str(input.title).slice(0, 60);
  if (name === "show_chart") return `Desenhando o gráfico${t ? ` “${t}”` : ""}`;
  if (name === "show_table") return `Montando a tabela${t ? ` “${t}”` : ""}`;
  if (name === "show_kpis") return "Montando os indicadores";
  if (name === "show_timeline") return `Montando a linha do tempo${t ? ` “${t}”` : ""}`;
  if (name === "generate_image")
    return str(input.edit_ref) ? `Editando a imagem ${str(input.edit_ref).toUpperCase()}` : "Gerando a imagem";
  if (name === "create_document") return `Escrevendo o documento${t ? ` “${t}”` : ""}`;
  if (name === "create_presentation") return `Montando a apresentação${t ? ` “${t}”` : ""}`;
  if (name === "create_spreadsheet") return `Montando a planilha${t ? ` “${t}”` : ""}`;
  if (name === "read_canvas") return `Lendo ${str(input.ref).toUpperCase() || "o documento"}`;
  if (name === "ask_user") return "Preparando perguntas para você";
  if (name === "propose_task") return `Preparando a tarefa${t ? ` “${t}”` : ""} para você confirmar`;
  if (name === "propose_comment") return "Preparando o comentário para você confirmar";
  return "Trabalhando";
}
export function summarizePowerStep(name: string, output: string) {
  if (/^As perguntas/.test(output)) return "esperando suas respostas";
  if (/^(Mostrado|Imagem pronta|Proposta pronta|Pronto no canvas)/.test(output))
    return name.startsWith("propose_") ? "aguardando sua confirmação" : "pronto";
  return "não deu";
}

/** Uma resposta antiga para o histórico: o texto e o que ela mostrou. */
export function historyTurn(content: string, artifacts: AiArtifact[]) {
  if (!artifacts.length) return content;
  return `${content}\n\n(Anexos desta resposta: ${artifacts.map((a) => `${a.ref} — ${artifactSummary(a)}`).join("; ")}.)`;
}

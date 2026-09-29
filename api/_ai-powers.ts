import crypto from "node:crypto";
import { callRpc, signGcsUrl, type GcsCredentials } from "./_drive.js";
import type { ToolSpec } from "./_ai-llm.js";
import { TOOLS, type ToolContext } from "./_ai-tools.js";
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
  artifactSummary,
  sanitizeVisual,
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

export type ToolKind = "read" | "visual" | "image" | "action";
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
};

/** As ferramentas desta pergunta: as de consulta e as dos poderes da pessoa. */
export function toolsFor(powers: ReadonlySet<Power>): ToolSpec[] {
  return [
    ...TOOLS,
    ...POWER_TOOLS.filter((t) => {
      const power = REGISTRY[t.name]?.power;
      return !!power && powers.has(power);
    }),
  ];
}

/** O que muda nas instruções da MAVI quando ela tem poderes. */
export function powerInstructions(powers: ReadonlySet<Power>) {
  if (!powers.size) return "";
  const lines = [
    "",
    "Poderes liberados nesta conversa (além de consultar):",
  ];
  if (powers.has("visuals"))
    lines.push(
      "- Visualizações (show_chart, show_table, show_kpis, show_timeline): quando comparar, mostrar evolução, listar com várias colunas ou destacar números fica mais claro visualmente, desenhe. Use só números que vieram das ferramentas; nunca invente nem arredonde para caber. Tabelas vão por show_table (não escreva tabelas em texto).",
    );
  if (powers.has("images"))
    lines.push(
      "- Imagens (generate_image): quando pedirem uma imagem, arte, ilustração, mockup ou foto conceitual. Escreva um prompt detalhado; o texto que deve aparecer na arte vai entre aspas, em português. Para ajustar uma imagem desta conversa, use edit_ref (ex.: I1). Não gere pessoas reais identificáveis nem logos e marcas de terceiros; para a marca do cliente, peça os arquivos dele.",
    );
  if (powers.has("actions"))
    lines.push(
      "- Ações (propose_task, propose_comment): quando a pessoa pedir para criar uma tarefa ou comentar numa. Você só propõe: a pessoa confirma no card. Nunca diga que a tarefa foi criada ou o comentário enviado; diga que está pronto para ela revisar e confirmar. Antes, confirme o cliente com find_clients quando não estiver no contexto.",
    );
  lines.push(
    "- Cada ferramenta dessas devolve uma referência (V1, I1, A1). Na resposta, escreva a referência entre colchetes duplos sozinha numa linha (ex.: [[V1]]) no ponto em que ela deve aparecer, e comente o essencial em texto, sem repetir todos os números. As citações [S#] continuam valendo no texto.",
  );
  return lines.join("\n");
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
  /** O próximo número de cada tipo de referência (V, I, A). */
  next: Record<"V" | "I" | "A", number>;
  emit: (artifact: AiArtifact) => void;
  /** Gasto com imagens nesta resposta (para o consumo). */
  imageCost: { usd: number; model: string; provider: string | null };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

function add<T extends AiArtifact>(
  kit: PowerKit,
  letter: "V" | "I" | "A",
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
    if (/safety|policy|moderation/i.test(`${why} ${body.error?.code ?? ""}`))
      return "O provedor recusou gerar esta imagem pelas regras de conteúdo dele. Explique à pessoa e sugira outro caminho.";
    throw new Error(`O provedor de imagem respondeu: ${why.slice(0, 200)}`);
  }
  const first = body.data?.[0];
  let bytes: Uint8Array;
  if (first?.b64_json) bytes = Buffer.from(first.b64_json, "base64");
  else if (first?.url && /^https:\/\//.test(first.url)) {
    const img = await ctx.fetch(first.url, { signal: AbortSignal.timeout(60_000) });
    if (!img.ok) throw new Error("Não foi possível baixar a imagem gerada.");
    bytes = new Uint8Array(await img.arrayBuffer());
  } else throw new Error("O provedor não devolveu a imagem.");
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
  const cost = imageCost(provider.model, provider.price, body.usage);
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
    p_input: Number(body.usage?.input_tokens) || 0,
    p_output: Number(body.usage?.output_tokens) || 0,
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
  if (name === "propose_task") return `Preparando a tarefa${t ? ` “${t}”` : ""} para você confirmar`;
  if (name === "propose_comment") return "Preparando o comentário para você confirmar";
  return "Trabalhando";
}
export function summarizePowerStep(name: string, output: string) {
  if (/^(Mostrado|Imagem pronta|Proposta pronta)/.test(output))
    return name.startsWith("propose_") ? "aguardando sua confirmação" : "pronto";
  return "não deu";
}

/** Uma resposta antiga para o histórico: o texto e o que ela mostrou. */
export function historyTurn(content: string, artifacts: AiArtifact[]) {
  if (!artifacts.length) return content;
  return `${content}\n\n(Anexos desta resposta: ${artifacts.map((a) => `${a.ref} — ${artifactSummary(a)}`).join("; ")}.)`;
}

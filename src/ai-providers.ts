/**
 * IA do MAVI · catálogo de provedores (usado pela tela e pelo servidor).
 *
 * Cada provedor da biblioteca é um destes modelos de catálogo com a API Key
 * da agência e os modelos liberados. "anthropic" fala a API da Claude; todos
 * os outros falam a API de chat da OpenAI (/chat/completions), que o Gemini,
 * o OpenRouter, o Groq, o DeepSeek, a Mistral e o xAI também oferecem — e
 * "custom" aceita qualquer outro endereço compatível.
 */

export type ProviderKind =
  | "anthropic"
  | "openai"
  | "google"
  | "openrouter"
  | "groq"
  | "deepseek"
  | "mistral"
  | "xai"
  | "custom";
export type ProviderApi = "anthropic" | "openai";

/** Um modelo liberado, com os preços em US$ por milhão de tokens. */
export type ProviderModel = {
  id: string;
  label?: string;
  input: number;
  output: number;
  /** Entrada lida do cache (quando o provedor cobra diferente). */
  cached?: number;
};

export type CatalogEntry = {
  kind: ProviderKind;
  label: string;
  api: ProviderApi;
  /** Endereço da API (vazio: a pessoa informa). */
  baseUrl: string;
  /** Onde criar a API Key. */
  keysUrl: string;
  /** Onde conferir os preços. */
  pricingUrl: string;
  /** Modelos sugeridos, com os preços de tabela. */
  models: ProviderModel[];
};

export const CATALOG: CatalogEntry[] = [
  {
    kind: "anthropic",
    label: "Anthropic (Claude)",
    api: "anthropic",
    baseUrl: "https://api.anthropic.com",
    keysUrl: "https://console.anthropic.com/settings/keys",
    pricingUrl: "https://docs.claude.com/en/docs/about-claude/pricing",
    models: [
      {
        id: "claude-opus-5-5",
        label: "Claude Opus 5.5",
        input: 4,
        output: 20,
        cached: 0.2,
      },
      { id: "claude-opus-5", label: "Claude Opus 5", input: 5, output: 25 },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5", input: 2, output: 10 },
      {
        id: "claude-haiku-4-5",
        label: "Claude Haiku 4.5",
        input: 1,
        output: 5,
      },
      {
        id: "claude-fable-5-1",
        label: "Claude Fable 5.1",
        input: 10,
        output: 50,
      },
    ],
  },
  {
    kind: "openai",
    label: "OpenAI",
    api: "openai",
    baseUrl: "https://api.openai.com/v1",
    keysUrl: "https://platform.openai.com/api-keys",
    pricingUrl: "https://openai.com/api/pricing",
    models: [],
  },
  {
    kind: "google",
    label: "Google (Gemini)",
    api: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keysUrl: "https://aistudio.google.com/app/apikey",
    pricingUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    models: [],
  },
  {
    kind: "openrouter",
    label: "OpenRouter",
    api: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    keysUrl: "https://openrouter.ai/settings/keys",
    pricingUrl: "https://openrouter.ai/models",
    models: [],
  },
  {
    kind: "groq",
    label: "Groq",
    api: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    keysUrl: "https://console.groq.com/keys",
    pricingUrl: "https://groq.com/pricing",
    models: [],
  },
  {
    kind: "deepseek",
    label: "DeepSeek",
    api: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    keysUrl: "https://platform.deepseek.com/api_keys",
    pricingUrl: "https://api-docs.deepseek.com/quick_start/pricing",
    models: [],
  },
  {
    kind: "mistral",
    label: "Mistral",
    api: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    keysUrl: "https://console.mistral.ai/api-keys",
    pricingUrl: "https://mistral.ai/pricing",
    models: [],
  },
  {
    kind: "xai",
    label: "xAI (Grok)",
    api: "openai",
    baseUrl: "https://api.x.ai/v1",
    keysUrl: "https://console.x.ai",
    pricingUrl: "https://docs.x.ai/docs/models",
    models: [],
  },
  {
    kind: "custom",
    label: "Outro (compatível com a API da OpenAI)",
    api: "openai",
    baseUrl: "",
    keysUrl: "",
    pricingUrl: "",
    models: [],
  },
];

export const catalogEntry = (kind: string) =>
  CATALOG.find((c) => c.kind === kind);

/** O endereço que o servidor usa: o informado ou o do catálogo, sem "/" no fim. */
export function providerBaseUrl(kind: string, baseUrl?: string | null) {
  const url = (baseUrl || catalogEntry(kind)?.baseUrl || "").trim();
  return url.replace(/\/+$/, "");
}

/**
 * Só endereços HTTPS públicos: o servidor chama esse endereço com a chave,
 * então nada de localhost, IPs internos ou nomes de rede local.
 */
export function safeBaseUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "Endereço inválido.";
  }
  if (url.protocol !== "https:") return "Use um endereço https://.";
  if (url.username || url.password)
    return "Não coloque usuário ou senha no endereço.";
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    !host.includes(".") ||
    /^(0|10|127)\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
    host.includes(":")
  )
    return "Use o endereço público da API.";
  if (value.length > 300) return "Endereço longo demais.";
  return null;
}

// ------------------------------------------------------------ funcionalidades
/** As funcionalidades com IA que escolhem o seu provedor e modelo. */
export type AiFeature =
  | "assistant"
  | "meetings_history"
  | "meetings_ask"
  | "whatsapp_task"
  | "social_leads_plan"
  | "social_leads_adjust"
  | "social_leads_briefing"
  | "social_leads_colors";

export type FeatureInfo = {
  id: AiFeature;
  group: string;
  label: string;
  /** Conversa: as regras de pessoa, cliente, produto e projeto também valem. */
  conversation: boolean;
  /** A variável da Vercel com o modelo do padrão do servidor. */
  env: string;
  /** O que muda com um provedor que não é a Claude. */
  note?: string;
};

export const FEATURES: FeatureInfo[] = [
  {
    id: "assistant",
    group: "Assistente",
    label: "Assistente da MAVI (balão em todas as telas)",
    conversation: true,
    env: "AI_MODEL",
  },
  {
    id: "meetings_history",
    group: "Gravações",
    label: "Perguntar ao histórico de reuniões",
    conversation: true,
    env: "AI_MODEL",
  },
  {
    id: "meetings_ask",
    group: "Gravações",
    label: "Perguntar a uma reunião",
    conversation: true,
    env: "MEETINGS_MODEL",
  },
  {
    id: "whatsapp_task",
    group: "WhatsApp",
    label: "Tarefa a partir das mensagens",
    conversation: false,
    env: "WHATSAPP_TASK_MODEL",
  },
  {
    id: "social_leads_plan",
    group: "Social Leads",
    label: "Gerar e refazer o plano do mês",
    conversation: false,
    env: "SOCIAL_LEADS_MODEL",
    note: "Fora da Claude, a MAVI não abre o site do cliente: segue só o briefing.",
  },
  {
    id: "social_leads_adjust",
    group: "Social Leads",
    label: "Ajuste pedido à MAVI",
    conversation: false,
    env: "SOCIAL_LEADS_MODEL",
  },
  {
    id: "social_leads_briefing",
    group: "Social Leads",
    label: "Briefing pela MAVI",
    conversation: false,
    env: "SOCIAL_LEADS_MODEL",
  },
  {
    id: "social_leads_colors",
    group: "Social Leads",
    label: "Cores da marca (lê o logo e as imagens)",
    conversation: false,
    env: "SOCIAL_LEADS_MODEL",
    note: "O modelo escolhido precisa aceitar imagens.",
  },
];

export const featureInfo = (id: string) => FEATURES.find((f) => f.id === id);

/**
 * O modelo do padrão do servidor para cada funcionalidade (as variáveis da
 * Vercel vencem o código).
 */
export function serverModel(
  feature: AiFeature,
  env: Record<string, string | undefined>,
) {
  const fallback = "claude-opus-5-5";
  switch (feature) {
    case "assistant":
    case "meetings_history":
      return env.AI_MODEL || fallback;
    case "meetings_ask":
      return env.MEETINGS_MODEL || fallback;
    case "whatsapp_task":
      return env.WHATSAPP_TASK_MODEL || env.MEETINGS_MODEL || fallback;
    default:
      return env.SOCIAL_LEADS_MODEL || fallback;
  }
}

// ------------------------------------------------------------ regras
export type RouteScope =
  "company" | "user" | "client" | "contract" | "project" | "feature";
export type AiRoute = {
  id: string;
  type: RouteScope;
  scope_id: string | null;
  /** Só nas regras de funcionalidade. */
  feature?: AiFeature | null;
  provider_id: string;
  model: string;
  updated_at?: string;
};

/** Da mais específica para a mais geral. */
export const ROUTE_ORDER: RouteScope[] = [
  "project",
  "contract",
  "client",
  "user",
  "feature",
  "company",
];

/**
 * A regra que vale para uma pessoa num lugar e numa funcionalidade (a mesma
 * ordem do banco, ai_resolve_route): projeto › produto › cliente › pessoa ›
 * funcionalidade › empresa. Pessoa, cliente, produto e projeto só valem nas
 * conversas. Só provedores ativos contam. Nulo: o padrão do servidor.
 */
export function pickRoute(
  routes: AiRoute[],
  where: {
    user?: string;
    client?: string;
    contract?: string;
    project?: string;
    /** Sem funcionalidade: o assistente. */
    feature?: AiFeature;
  },
  activeProviders: ReadonlySet<string>,
): AiRoute | null {
  const feature = where.feature ?? "assistant";
  const talk = featureInfo(feature)?.conversation ?? true;
  const id: Record<RouteScope, string | null | undefined> = {
    project: where.project,
    contract: where.contract,
    client: where.client,
    user: where.user,
    feature: null,
    company: null,
  };
  for (const type of ROUTE_ORDER) {
    const general = type === "company" || type === "feature";
    if (!general && (!talk || !id[type])) continue;
    const r = routes.find(
      (x) =>
        x.type === type &&
        (type === "company" ||
          (type === "feature"
            ? x.feature === feature
            : x.scope_id === id[type])) &&
        activeProviders.has(x.provider_id),
    );
    if (r) return r;
  }
  return null;
}

/** "sk-…wxyz": só o final da chave, para reconhecer qual está salva. */
export const keyHint = (key: string) => key.trim().slice(-4);

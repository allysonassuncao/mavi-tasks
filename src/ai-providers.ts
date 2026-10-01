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
  | "whatsapp_history"
  | "whatsapp_task"
  | "social_leads_plan"
  | "social_leads_adjust"
  | "social_leads_briefing"
  | "social_leads_colors"
  | "task_copilot"
  | "task_title"
  | "client_dossier"
  | "copilot_learning"
  | "notice_writer"
  | "notice_animation"
  | "client_temperature"
  | "client_temperature_text"
  | "task_audio"
  | "whatsapp_transcribe"
  | "task_audio_transcribe"
  | "image_generation"
  | "mavi_page"
  | "web_search"
  | "canvas_writer"
  | "mavi_rerank"
  | "conversation_summary"
  | "skill_coach"
  | "dashboard_builder"
  | "client_radar"
  | "client_radar_check"
  | "client_radar_themes"
  | "client_radar_report"
  | "mavi_learning"
  | "campaign_report"
  | "mavi_judge"
  | "mavi_judge_check";

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
  /**
   * Responde com decisões, não com texto: só aceita o Jev (TypeSafe) pelo
   * OpenRouter, e sem escolha usa o primeiro Jev cadastrado.
   */
  decisions?: boolean;
  /**
   * Transcreve áudio: só provedores com o endpoint de transcrição da OpenAI
   * e modelos de transcrição, e sem herdar o padrão da empresa.
   */
  transcription?: boolean;
  /**
   * Gera e edita imagens: só provedores com o endpoint de imagens da OpenAI
   * e modelos de imagem, e sem herdar o padrão da empresa.
   */
  images?: boolean;
  /** Busca na internet: a Claude (nativa) ou o OpenRouter (plugin web). */
  web?: boolean;
  /** Sem regra, não usa o padrão da empresa: a própria MAVI do módulo faz. */
  own?: boolean;
};

/** O Jev (TypeSafe): um modelo de decisão, que não conversa. */
export const isJevModel = (id: string) => /typesafe\/jev/i.test(id);

export const FEATURES: FeatureInfo[] = [
  {
    id: "assistant",
    group: "MAVI",
    label: "MAVI na bolinha (em todas as telas)",
    conversation: true,
    env: "AI_MODEL",
  },
  {
    id: "mavi_page",
    group: "MAVI",
    label: "MAVI no módulo (página inteira): a que orquestra os poderes",
    conversation: true,
    env: "AI_MODEL",
    note: "Sem escolha, segue o modelo da bolinha. A busca na internet nativa só funciona se este for um modelo da Claude (ou escolha um modelo para a busca abaixo).",
  },
  {
    id: "web_search",
    group: "MAVI · poderes",
    label: "Busca na internet",
    conversation: false,
    env: "",
    web: true,
    own: true,
    note: "A Claude (busca nativa, US$ 0,01 por busca) ou um modelo do OpenRouter (plugin web ou modelos online, como o perplexity/sonar). Sem escolha, a MAVI do módulo busca sozinha se for Claude.",
  },
  {
    id: "canvas_writer",
    group: "MAVI · poderes",
    label: "Documentos, apresentações e planilhas (quem escreve)",
    conversation: false,
    env: "",
    own: true,
    note: "A MAVI do módulo junta os dados e este modelo escreve o documento, os slides ou a planilha. Sem escolha, a própria MAVI do módulo escreve.",
  },
  {
    id: "mavi_rerank",
    group: "MAVI · poderes",
    label: "Reordenação da busca (RAG)",
    conversation: false,
    env: "",
    own: true,
    note: "Um modelo rápido e barato (ex.: Claude Haiku, GPT mini) escolhe, entre os trechos que a busca achou, os que mais ajudam a responder, antes de a MAVI ler. Melhora a precisão; custa uma chamada curta por busca. Sem escolha, fica a ordem da busca.",
  },
  {
    id: "conversation_summary",
    group: "MAVI · poderes",
    label: "Resumo de conversas longas",
    conversation: false,
    env: "AI_MODEL",
    note: "Quando a conversa cresce, as mensagens antigas viram um resumo (em segundo plano), para a MAVI lembrar do começo sem reler tudo. Um modelo barato funciona bem. Sem escolha, usa o padrão da empresa.",
  },
  {
    id: "mavi_learning",
    group: "MAVI · poderes",
    label: "Aprendizado da MAVI com as avaliações das respostas",
    conversation: false,
    env: "MAVI_LEARNING_MODEL",
    note: "A cada 10 minutos, a MAVI lê os 👍/👎 novos das respostas e propõe aprendizados para ela mesma seguir. Roda em segundo plano, com pouco texto. Sem escolha, usa o padrão da empresa.",
  },
  {
    id: "mavi_judge",
    group: "MAVI · poderes",
    label: "Autoavaliação: o juiz das respostas com sinal de problema",
    conversation: false,
    env: "MAVI_JUDGE_MODEL",
    note: "Só as respostas com sinal (parou no limite, erro de ferramenta, sem fonte, a pessoa reclamou ou deu 👎 sem motivo) são conferidas, em segundo plano. Sem escolha, usa o padrão da empresa.",
  },
  {
    id: "mavi_judge_check",
    group: "MAVI · poderes",
    label: "Autoavaliação: as perguntas objetivas (Jev)",
    conversation: false,
    env: "",
    decisions: true,
  },
  {
    id: "skill_coach",
    group: "MAVI · poderes",
    label: "Skills: validador de qualidade e assistente de criação",
    conversation: false,
    env: "AI_MODEL",
    note: "Revisa a skill ao importar, ao enviar para aprovação ou quando pedem, e conduz a conversa de quem cria. Um modelo forte escreve skills melhores. Sem escolha, usa o padrão da empresa.",
  },
  {
    id: "dashboard_builder",
    group: "MAVI · poderes",
    label: "Dashboards: criar e ajustar painéis com a MAVI",
    conversation: false,
    env: "AI_MODEL",
    note: "A conversa ao lado do dashboard: pergunta o que falta, confere os nomes e roda a prévia de cada painel antes de propor. Um modelo forte acerta mais os painéis. Sem escolha, usa o padrão da empresa.",
  },
  {
    id: "image_generation",
    group: "MAVI · poderes",
    label: "Geração e edição de imagens (poder Imagens)",
    conversation: false,
    env: "IMAGE_MODEL",
    images: true,
    note: "Só modelos de imagem: gpt-image-1, Imagen, grok-2-image ou os do OpenRouter (ex.: google/gemini-2.5-flash-image, openai/gpt-5-image). Editar uma imagem já gerada funciona com o gpt-image-1, o OpenRouter ou um endereço compatível.",
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
    id: "whatsapp_history",
    group: "WhatsApp",
    label: "Perguntar ao histórico dos grupos",
    conversation: true,
    env: "AI_MODEL",
  },
  {
    id: "whatsapp_task",
    group: "WhatsApp",
    label: "Tarefa a partir das mensagens",
    conversation: false,
    env: "WHATSAPP_TASK_MODEL",
  },
  {
    id: "whatsapp_transcribe",
    group: "WhatsApp",
    label: "Transcrição dos áudios dos grupos",
    conversation: false,
    env: "WHATSAPP_TRANSCRIBE_MODEL",
    transcription: true,
    note: "Todo áudio que chega nos grupos: prefira um modelo barato (ex.: Whisper no Groq).",
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
  {
    id: "task_copilot",
    group: "Tarefas",
    label: "Assistente MAVI na criação e edição de tarefas",
    conversation: false,
    env: "TASK_COPILOT_MODEL",
    note: "Roda a cada pausa na digitação: prefira um modelo rápido.",
  },
  {
    id: "task_title",
    group: "Tarefas",
    label: "Título das tarefas novas (a partir da descrição e dos áudios)",
    conversation: false,
    env: "TASK_TITLE_MODEL",
    note: "Uma chamada curta ao clicar em Criar tarefa, que espera o título antes de salvar: prefira um modelo rápido (ex.: Claude Haiku, GPT mini). Se a MAVI falhar, a tarefa salva com o começo da descrição.",
  },
  {
    id: "client_dossier",
    group: "Tarefas",
    label: "Dossiê do cliente (atualizado em segundo plano)",
    conversation: false,
    env: "CLIENT_DOSSIER_MODEL",
  },
  {
    id: "copilot_learning",
    group: "Tarefas",
    label: "Aprendizado do Assistente MAVI com o feedback do time",
    conversation: false,
    env: "COPILOT_LEARNING_MODEL",
  },
  {
    id: "task_audio_transcribe",
    group: "Tarefas",
    label: "Transcrição dos áudios das tarefas",
    conversation: false,
    env: "WHATSAPP_TRANSCRIBE_MODEL",
    transcription: true,
    note: "Na descrição e nos comentários. Quem ouve os áudios; o resumo em tópicos é a linha de baixo.",
  },
  {
    id: "task_audio",
    group: "Tarefas",
    label: "Resumo dos áudios da descrição",
    conversation: false,
    env: "TASK_AUDIO_MODEL",
    note: "Tópicos a partir da transcrição: um modelo rápido basta.",
  },
  {
    id: "notice_writer",
    group: "Mural de avisos",
    label: "A MAVI escrevendo e revisando avisos",
    conversation: false,
    env: "NOTICE_WRITER_MODEL",
    note: "Uma resposta curta por pedido: um modelo rápido basta.",
  },
  {
    id: "notice_animation",
    group: "Mural de avisos",
    label:
      "Animação do aviso (padrão, quando nenhum modelo foi liberado abaixo)",
    conversation: false,
    env: "NOTICE_ANIMATION_MODEL",
    note: "O modelo escolhido precisa aceitar imagens para ler os prints.",
  },
  {
    id: "client_temperature",
    group: "Termômetro do cliente",
    label: "Leitura das reuniões e do WhatsApp (Jev)",
    conversation: false,
    env: "",
    decisions: true,
  },
  {
    id: "client_temperature_text",
    group: "Termômetro do cliente",
    label: "Explicação da temperatura pela MAVI",
    conversation: false,
    env: "CLIENT_TEMPERATURE_TEXT_MODEL",
    note: "Um parágrafo curto por cliente, só quando a temperatura muda: um modelo rápido basta.",
  },
  {
    id: "client_radar",
    group: "Radar do cliente",
    label: "Problemas, promessas e tópicos nas reuniões e no WhatsApp",
    conversation: false,
    env: "CLIENT_RADAR_MODEL",
    note: "Lê cada reunião e as mensagens novas dos grupos a cada hora: um modelo rápido e bom em português segura o custo.",
  },
  {
    id: "client_radar_check",
    group: "Radar do cliente",
    label: "Conferência e gravidade de cada item (Jev)",
    conversation: false,
    env: "",
    decisions: true,
  },
  {
    id: "client_radar_themes",
    group: "Radar do cliente",
    label: "Temas: os itens parecidos de clientes diferentes",
    conversation: false,
    env: "CLIENT_RADAR_THEMES_MODEL",
    note: "Junta os itens novos de cada tópico e produto em temas; roda em lotes, poucas vezes por dia.",
  },
  {
    id: "client_radar_report",
    group: "Radar do cliente",
    label: "Relatório da MAVI (sob demanda e agendado)",
    conversation: false,
    env: "CLIENT_RADAR_REPORT_MODEL",
    note: "Poucas chamadas, texto para a gestão decidir: vale um modelo forte.",
  },
  {
    id: "campaign_report",
    group: "Campanhas",
    label: "Análise da MAVI nos relatórios de campanha",
    conversation: false,
    env: "CAMPAIGN_REPORT_MODEL",
    note: "Uma resposta por relatório, lida pelo cliente: um modelo bom de escrita.",
  },
];

export const featureInfo = (id: string) => FEATURES.find((f) => f.id === id);

/**
 * Transcrição: os provedores que falam o endpoint de transcrição da OpenAI
 * (/audio/transcriptions) e os modelos que transcrevem. A mesma regra de
 * mavi_private.ai_transcribe_model no banco.
 */
export const TRANSCRIBE_KINDS: ProviderKind[] = ["openai", "groq", "mistral", "custom"];
export const isTranscribeModel = (id: string) => /(whisper|transcri|voxtral)/i.test(id);
/**
 * Imagens: os provedores que falam o endpoint de imagens da OpenAI
 * (/images/generations) e os modelos que geram imagens. A mesma regra de
 * mavi_private.ai_image_model no banco.
 */
export const IMAGE_KINDS: ProviderKind[] = ["openai", "google", "xai", "openrouter", "custom"];
export const isImageModel = (id: string) => /(image|dall-e|imagen|flux)/i.test(id);
/** Busca na internet: a Claude (nativa) e o OpenRouter (plugin web). */
export const WEB_KINDS: ProviderKind[] = ["anthropic", "openrouter"];
/** Vetores, transcrição ou imagem: não servem para conversar. */
export const isNonChatModel = (id: string) =>
  isTranscribeModel(id) || /embed/i.test(id) || isImageModel(id);

/** Preço da transcrição (US$ por minuto de áudio), pelos preços de tabela. */
const TRANSCRIBE_PRICES: [RegExp, number][] = [
  [/gpt-4o-mini-transcribe/i, 0.003],
  [/gpt-4o-transcribe/i, 0.006],
  [/whisper-large-v3-turbo/i, 0.04 / 60],
  [/whisper-large-v3/i, 0.111 / 60],
  [/distil-whisper/i, 0.02 / 60],
  [/whisper-1/i, 0.006],
  [/voxtral-mini/i, 0.001],
  [/voxtral/i, 0.002],
];
export function transcribePerMinute(model: string, fallback: number) {
  return TRANSCRIBE_PRICES.find(([re]) => re.test(model))?.[1] ?? fallback;
}

/** O modelo de vetores da MAVI (busca e RAG): só para leitura no painel. */
export function embeddingModel(env: Record<string, string | undefined>) {
  return env.AI_EMBEDDING_MODEL || "text-embedding-3-small";
}

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
    case "mavi_page":
    case "meetings_history":
    case "whatsapp_history":
      return env.AI_MODEL || fallback;
    case "web_search":
      return env.AI_MODEL || fallback;
    case "canvas_writer":
    case "mavi_rerank":
    case "conversation_summary":
    case "skill_coach":
    case "dashboard_builder":
      return env.AI_MODEL || fallback;
    case "meetings_ask":
      return env.MEETINGS_MODEL || fallback;
    case "whatsapp_task":
      return env.WHATSAPP_TASK_MODEL || env.MEETINGS_MODEL || fallback;
    case "task_copilot":
      return env.TASK_COPILOT_MODEL || env.AI_MODEL || fallback;
    case "task_title":
      // Um título curto: um modelo rápido basta (o Painel da MAVI vence).
      return env.TASK_TITLE_MODEL || "claude-haiku-4-5";
    case "client_dossier":
      return env.CLIENT_DOSSIER_MODEL || env.AI_MODEL || fallback;
    case "copilot_learning":
      return env.COPILOT_LEARNING_MODEL || env.AI_MODEL || fallback;
    case "mavi_learning":
      return env.MAVI_LEARNING_MODEL || env.COPILOT_LEARNING_MODEL || env.AI_MODEL || fallback;
    case "mavi_judge":
      return env.MAVI_JUDGE_MODEL || env.AI_MODEL || fallback;
    case "mavi_judge_check":
      // Sem escolha: o Jev do termômetro (o primeiro cadastrado no OpenRouter).
      return "~typesafe/jev-latest";
    case "notice_writer":
      return env.NOTICE_WRITER_MODEL || env.AI_MODEL || fallback;
    case "notice_animation":
      return env.NOTICE_ANIMATION_MODEL || env.AI_MODEL || fallback;
    case "client_temperature":
      // Não há padrão no servidor: o Jev vem da biblioteca (OpenRouter).
      return "~typesafe/jev-latest";
    case "client_temperature_text":
      return env.CLIENT_TEMPERATURE_TEXT_MODEL || env.AI_MODEL || fallback;
    case "client_radar":
      return env.CLIENT_RADAR_MODEL || env.AI_MODEL || fallback;
    case "client_radar_report":
      return env.CLIENT_RADAR_REPORT_MODEL || env.AI_MODEL || fallback;
    case "campaign_report":
      return env.CAMPAIGN_REPORT_MODEL || env.AI_MODEL || fallback;
    case "client_radar_themes":
      return env.CLIENT_RADAR_THEMES_MODEL || env.AI_MODEL || fallback;
    case "client_radar_check":
      // Sem escolha: o Jev do termômetro (o primeiro cadastrado no OpenRouter).
      return "~typesafe/jev-latest";
    case "task_audio":
      return env.TASK_AUDIO_MODEL || env.AI_MODEL || fallback;
    case "whatsapp_transcribe":
    case "task_audio_transcribe":
      return env.WHATSAPP_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
    case "image_generation":
      return env.IMAGE_MODEL || "gpt-image-1";
    default:
      return env.SOCIAL_LEADS_MODEL || fallback;
  }
}

// ------------------------------------------------------------ regras
export type RouteScope =
  "company" | "user" | "client" | "contract" | "project" | "feature" | "skill";
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
  // Transcrição, imagens, busca e o escritor do canvas não herdam o padrão da
  // empresa (um modelo de conversa).
  const info = featureInfo(feature);
  const own = !!(info?.transcription || info?.images || info?.own);
  const id: Record<RouteScope, string | null | undefined> = {
    project: where.project,
    contract: where.contract,
    client: where.client,
    user: where.user,
    feature: null,
    company: null,
    // As regras de skill não entram aqui: valem só quando a skill roda.
    skill: null,
  };
  for (const type of ROUTE_ORDER) {
    const general = type === "company" || type === "feature";
    if (!general && (!talk || !id[type])) continue;
    if (type === "company" && own) continue;
    const match = (f: AiFeature) =>
      routes.find(
        (x) =>
          x.type === type &&
          (type === "company" ||
            (type === "feature" ? x.feature === f : x.scope_id === id[type])) &&
          activeProviders.has(x.provider_id),
      );
    // O módulo MAVI sem regra própria segue a da bolinha.
    const r =
      match(feature) ??
      (type === "feature" && feature === "mavi_page" ? match("assistant") : undefined);
    if (r) return r;
  }
  return null;
}

/** "sk-…wxyz": só o final da chave, para reconhecer qual está salva. */
export const keyHint = (key: string) => key.trim().slice(-4);

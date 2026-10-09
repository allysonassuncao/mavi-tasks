/**
 * Agentes MAVI: o catálogo dos campos do agente (perfil, instruções e
 * comportamento da especificação mavi-agent/v1 do motor). Uma fonte só para:
 * - a tela (rótulos, explicações, opções dos menus, sugestões);
 * - o servidor (api/_agent-builder-mavi.ts), que confere cada mudança que a
 *   MAVI propõe antes de mostrar (checkFieldValue) e ensina o catálogo a ela.
 * Sem React: o servidor importa este arquivo.
 */

export type FieldOption = { value: string; label: string; hint?: string };

type Base = {
  path: string;
  label: string;
  /** Explicação curta, mostrada abaixo do campo. */
  hint?: string;
  tab: "profile" | "instructions" | "behavior";
  section: string;
};

export type FieldDef = Base &
  (
    | { kind: "text"; max: number; placeholder?: string; presets?: FieldOption[]; fallback?: string }
    | { kind: "area"; max: number; placeholder?: string; templates?: FieldOption[]; append?: string[] }
    | { kind: "list"; maxItems: number; maxLen: number; placeholder?: string; suggestions: string[] }
    | { kind: "chips"; maxItems: number; maxLen: number; suggestions: string[] }
    | { kind: "enum"; options: FieldOption[]; fallback: string }
    | { kind: "number"; min: number; max: number; fallback: number; options: FieldOption[] }
    | { kind: "bool"; fallback: boolean }
    | { kind: "hours" }
    /** As opções vêm do Painel da MAVI › Agentes MAVI (modelos liberados). */
    | { kind: "model" }
  );

export const DAYS = [
  ["mon", "Segunda"],
  ["tue", "Terça"],
  ["wed", "Quarta"],
  ["thu", "Quinta"],
  ["fri", "Sexta"],
  ["sat", "Sábado"],
  ["sun", "Domingo"],
] as const;
export type DayKey = (typeof DAYS)[number][0];
export type WeeklyHours = Partial<Record<DayKey, { from: string; to: string } | null>>;

/** Horários de meia em meia hora para os menus. */
export const HALF_HOURS = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);



export const FIELDS: FieldDef[] = [
  // ------------------------------------------------------------ perfil
  {
    path: "persona.name",
    tab: "profile",
    section: "Quem é o agente",
    label: "Nome do agente",
    hint: "Como ele se apresenta ao lead. Um nome de pessoa, curto.",
    kind: "text",
    max: 60,
    placeholder: "Clara",
  },
  {
    path: "persona.role",
    tab: "profile",
    section: "Quem é o agente",
    label: "Função",
    hint: "O papel dele no atendimento.",
    kind: "text",
    max: 120,
    fallback: "assistente virtual",
    presets: [
      { value: "assistente virtual", label: "Assistente virtual", hint: "Tira dúvidas e encaminha para a equipe." },
      { value: "pré-vendas (SDR)", label: "Pré-vendas (SDR)", hint: "Qualifica o lead e marca uma reunião com o vendedor." },
      { value: "consultor de vendas", label: "Consultor de vendas", hint: "Apresenta os produtos e conduz até a compra." },
      { value: "assistente de agendamento", label: "Agendamento", hint: "Foca em marcar, remarcar e confirmar horários." },
      { value: "atendente de suporte", label: "Suporte ao cliente", hint: "Ajuda quem já é cliente com dúvidas e problemas." },
      { value: "recepcionista", label: "Recepcionista", hint: "Recebe, entende o pedido e direciona." },
    ],
  },
  {
    path: "persona.tone",
    tab: "profile",
    section: "Quem é o agente",
    label: "Tom de voz",
    kind: "text",
    max: 300,
    fallback: "cordial, natural e direto, como uma pessoa real no WhatsApp",
    presets: [
      { value: "cordial, natural e direto, como uma pessoa real no WhatsApp", label: "Cordial e natural", hint: "Simpático sem exagero. Serve para a maioria dos negócios." },
      { value: "formal, educado e profissional", label: "Formal", hint: "Para jurídico, saúde, financeiro e empresas tradicionais." },
      { value: "descontraído, leve e próximo", label: "Descontraído", hint: "Para varejo, estética e público jovem." },
      { value: "consultivo, seguro e especialista", label: "Consultivo", hint: "Para vendas mais complexas e B2B." },
      { value: "animado, positivo e entusiasmado", label: "Animado", hint: "Para eventos, promoções e lançamentos." },
    ],
  },
  {
    path: "persona.reply_size",
    tab: "profile",
    section: "Quem é o agente",
    label: "Tamanho das respostas",
    kind: "enum",
    fallback: "short",
    options: [
      { value: "short", label: "Curtas", hint: "1 a 2 frases por mensagem — o jeito do WhatsApp (recomendado)." },
      { value: "medium", label: "Médias", hint: "Até 4 frases; bom quando o assunto pede explicação." },
      { value: "long", label: "Detalhadas", hint: "Explica mais; use em suporte técnico." },
    ],
  },
  {
    path: "persona.emoji",
    tab: "profile",
    section: "Quem é o agente",
    label: "Emojis",
    kind: "enum",
    fallback: "few",
    options: [
      { value: "none", label: "Nenhum", hint: "Mais sério." },
      { value: "few", label: "Poucos", hint: "Um de vez em quando, para soar humano (recomendado)." },
      { value: "many", label: "À vontade", hint: "Mais animado e informal." },
    ],
  },
  {
    path: "persona.language",
    tab: "profile",
    section: "Quem é o agente",
    label: "Idioma",
    kind: "text",
    max: 60,
    fallback: "português do Brasil",
    presets: [
      { value: "português do Brasil", label: "Português (Brasil)" },
      { value: "espanhol", label: "Espanhol" },
      { value: "inglês", label: "Inglês" },
      { value: "o mesmo idioma do lead", label: "O mesmo idioma do lead", hint: "Responde na língua em que o lead escrever." },
    ],
  },
  {
    path: "persona.company",
    tab: "profile",
    section: "A empresa",
    label: "Nome da empresa",
    hint: "Como o cliente é chamado pelos leads.",
    kind: "text",
    max: 120,
    placeholder: "Make Vendas",
  },
  {
    path: "persona.segment",
    tab: "profile",
    section: "A empresa",
    label: "Segmento",
    kind: "text",
    max: 120,
    presets: [
      "Advocacia",
      "Clínica médica",
      "Odontologia",
      "Estética e beleza",
      "Saúde e bem-estar",
      "Educação e cursos",
      "Infoprodutos",
      "Imobiliária",
      "Construção e reformas",
      "Varejo / loja física",
      "E-commerce",
      "Restaurante e delivery",
      "Automotivo",
      "Serviços financeiros",
      "Seguros",
      "Tecnologia / software",
      "Marketing e agência",
      "Turismo e eventos",
      "Indústria",
    ].map((s) => ({ value: s, label: s })),
  },
  {
    path: "persona.address",
    tab: "profile",
    section: "A empresa",
    label: "Endereço",
    hint: "Se o lead pode ir até lá. Deixe vazio se for só online.",
    kind: "text",
    max: 400,
  },
  {
    path: "persona.company_summary",
    tab: "profile",
    section: "A empresa",
    label: "Sobre a empresa",
    hint: "O essencial que o agente precisa saber sempre, em poucas linhas. Preços, catálogo e políticas vão na base de conhecimento.",
    kind: "area",
    max: 4000,
    placeholder: "Ex.: Clínica de estética em Moema com 10 anos, especializada em harmonização facial e tratamentos a laser.",
  },

  // ------------------------------------------------------------ instruções
  {
    path: "instructions.goal",
    tab: "instructions",
    section: "Objetivo e roteiro",
    label: "Objetivo",
    hint: "O que é uma conversa bem-sucedida. Seja específico.",
    kind: "area",
    max: 4000,
    placeholder: "Ex.: Entender o que o lead procura, tirar dúvidas e agendar uma avaliação gratuita.",
    templates: [
      { value: "Entender a necessidade do lead, qualificar (interesse, orçamento e prazo) e agendar uma reunião com o time comercial.", label: "Qualificar e agendar reunião" },
      { value: "Tirar as dúvidas do lead sobre os produtos, recomendar a melhor opção e conduzir até a compra.", label: "Tirar dúvidas e vender" },
      { value: "Agendar, remarcar e confirmar consultas, informando horários disponíveis e orientações de preparo.", label: "Agendar consultas" },
      { value: "Ajudar clientes com dúvidas e problemas depois da compra e encaminhar para a equipe o que não resolver.", label: "Suporte pós-venda" },
    ],
  },
  {
    path: "instructions.conversation_guide",
    tab: "instructions",
    section: "Objetivo e roteiro",
    label: "Roteiro da conversa",
    hint: "As etapas e perguntas, na ordem. O agente segue como guia, sem copiar as frases.",
    kind: "area",
    max: 20000,
    placeholder: "1. Cumprimente e pergunte o nome.\n2. Pergunte o que a pessoa procura.\n3. ...",
  },
  {
    path: "instructions.weekly_hours",
    tab: "instructions",
    section: "Horários",
    label: "Horário de atendimento da empresa",
    hint: "O agente responde a qualquer hora, mas usa isto para falar de horários e agendamentos.",
    kind: "hours",
  },
  {
    path: "instructions.business_hours",
    tab: "instructions",
    section: "Horários",
    label: "Observações sobre horários",
    kind: "area",
    max: 2000,
    placeholder: "Ex.: Fechado em feriados nacionais. Plantão de emergência pelo (11) 9999-9999.",
  },
  {
    path: "instructions.rules",
    tab: "instructions",
    section: "Regras",
    label: "Regras que o agente segue",
    kind: "list",
    maxItems: 60,
    maxLen: 1000,
    placeholder: "Uma regra por linha",
    suggestions: [
      "Antes de falar de preço, entenda a necessidade do lead.",
      "Confirme o nome do lead no começo da conversa.",
      "Sempre termine com um próximo passo (agendar, enviar proposta).",
      "Responda só sobre assuntos da empresa.",
      "Se o lead sumir, retome de onde parou sem repetir tudo.",
    ],
  },
  {
    path: "instructions.never",
    tab: "instructions",
    section: "Regras",
    label: "O agente nunca deve",
    kind: "list",
    maxItems: 60,
    maxLen: 1000,
    placeholder: "Uma por linha",
    suggestions: [
      "Prometer descontos ou condições especiais.",
      "Dar prazos que não estejam na base de conhecimento.",
      "Falar mal de concorrentes.",
      "Dar diagnóstico, parecer jurídico ou orientação técnica individual.",
      "Pedir senha, número de cartão ou outros dados sensíveis.",
    ],
  },
  {
    path: "instructions.extra",
    tab: "instructions",
    section: "Texto livre",
    label: "Instruções adicionais",
    hint: "Para colar um prompt pronto (do n8n, por exemplo) enquanto ele não é dividido nos campos acima.",
    kind: "area",
    max: 60000,
  },

  // ------------------------------------------------------------ comportamento
  {
    path: "knowledge.enabled",
    tab: "behavior",
    section: "Conhecimento",
    label: "Usar a base de conhecimento",
    hint: "O agente consulta preços, produtos e políticas antes de responder.",
    kind: "bool",
    fallback: true,
  },
  {
    path: "knowledge.prefetch_k",
    tab: "behavior",
    section: "Conhecimento",
    label: "Quanto consultar a cada mensagem",
    kind: "number",
    min: 0,
    max: 20,
    fallback: 6,
    options: [
      { value: "0", label: "Só quando ele mesmo pesquisar", hint: "Mais barato; bom para bases pequenas." },
      { value: "3", label: "Pouco (3 trechos)", hint: "Respostas simples e base enxuta." },
      { value: "6", label: "Normal (6 trechos) — recomendado", hint: "Equilíbrio entre acerto e custo." },
      { value: "10", label: "Bastante (10 trechos)", hint: "Bases grandes, muitos produtos." },
    ],
  },
  {
    path: "knowledge.search_tool",
    tab: "behavior",
    section: "Conhecimento",
    label: "Deixar o agente pesquisar mais quando precisar",
    kind: "bool",
    fallback: true,
  },
  {
    path: "knowledge.rerank",
    tab: "behavior",
    section: "Conhecimento",
    label: "Revisar os resultados com IA antes de responder",
    hint: "Acerta mais em bases grandes; cerca de 1 segundo a mais por resposta.",
    kind: "bool",
    fallback: false,
  },
  {
    path: "memory.history_messages",
    tab: "behavior",
    section: "Memória",
    label: "Quanto da conversa ele lembra inteiro",
    kind: "number",
    min: 4,
    max: 100,
    fallback: 30,
    options: [
      { value: "15", label: "Pouco (últimas 15 mensagens)", hint: "Conversas curtas; mais barato." },
      { value: "30", label: "Normal (últimas 30) — recomendado", hint: "O resto vira um resumo automático." },
      { value: "60", label: "Muito (últimas 60)", hint: "Conversas longas e detalhadas; custa mais." },
    ],
  },
  {
    path: "memory.summary",
    tab: "behavior",
    section: "Memória",
    label: "Resumir as mensagens antigas",
    hint: "Assim ele lembra do começo da conversa mesmo semanas depois.",
    kind: "bool",
    fallback: true,
  },
  {
    path: "memory.contact_fields",
    tab: "behavior",
    section: "Memória",
    label: "Dados do contato que ele guarda",
    hint: "Quando o lead informar, o agente registra e não pergunta de novo.",
    kind: "chips",
    maxItems: 30,
    maxLen: 60,
    suggestions: ["nome", "e-mail", "telefone", "cidade", "empresa", "CPF", "interesse", "orçamento", "melhor horário para contato"],
  },
  {
    path: "buffer.seconds",
    tab: "behavior",
    section: "Mensagens do lead",
    label: "Espera antes de responder",
    hint: "Muita gente manda várias mensagens seguidas; a espera junta tudo numa resposta só.",
    kind: "number",
    min: 0,
    max: 60,
    fallback: 8,
    options: [
      { value: "0", label: "Na hora", hint: "Pode responder pedaço por pedaço." },
      { value: "3", label: "Rápido (3 s)" },
      { value: "8", label: "Normal (8 s) — recomendado" },
      { value: "15", label: "Paciente (15 s)", hint: "Para quem manda áudios e várias mensagens." },
      { value: "30", label: "Bem paciente (30 s)" },
    ],
  },
  { path: "media.audio", tab: "behavior", section: "Mensagens do lead", label: "Ouvir áudios (transcrição)", kind: "bool", fallback: true },
  { path: "media.images", tab: "behavior", section: "Mensagens do lead", label: "Ver imagens e prints", kind: "bool", fallback: true },
  { path: "media.documents", tab: "behavior", section: "Mensagens do lead", label: "Ler documentos (PDF, DOCX)", kind: "bool", fallback: true },
  {
    path: "output.max_messages",
    tab: "behavior",
    section: "Respostas",
    label: "Máximo de mensagens por resposta",
    hint: "Ele divide a resposta em mensagens curtas, como uma pessoa faz.",
    kind: "number",
    min: 1,
    max: 8,
    fallback: 4,
    options: ["1", "2", "3", "4", "5", "6"].map((n) => ({ value: n, label: n === "4" ? "4 — recomendado" : n })),
  },
  {
    path: "output.typing_delay",
    tab: "behavior",
    section: "Respostas",
    label: "Pausa de \"digitando\" entre as mensagens",
    hint: "Parece mais humano.",
    kind: "bool",
    fallback: true,
  },
  { path: "output.strip_trailing_period", tab: "behavior", section: "Respostas", label: "Tirar o ponto final das mensagens", hint: "Como se escreve no WhatsApp.", kind: "bool", fallback: true },
  { path: "output.no_em_dash", tab: "behavior", section: "Respostas", label: "Não usar travessão (—)", hint: "O travessão denuncia texto de IA.", kind: "bool", fallback: true },
  {
    path: "handoff.enabled",
    tab: "behavior",
    section: "Passar para uma pessoa",
    label: "O agente pode passar a conversa para a equipe",
    hint: "Ele desliga a IA na conversa e deixa uma nota no MakeCRM para a equipe.",
    kind: "bool",
    fallback: true,
  },
  {
    path: "handoff.when",
    tab: "behavior",
    section: "Passar para uma pessoa",
    label: "Quando passar (além de quando o lead pedir)",
    kind: "area",
    max: 2000,
    append: [
      "Quando o lead quiser negociar valores.",
      "Quando houver reclamação.",
      "Quando o lead pedir cancelamento.",
      "Quando a pergunta exigir um especialista.",
    ],
  },
  {
    path: "handoff.message",
    tab: "behavior",
    section: "Passar para uma pessoa",
    label: "O que dizer ao passar",
    hint: "Vazio: o agente escreve na hora.",
    kind: "text",
    max: 500,
    placeholder: "Vou te passar para alguém da equipe, tá? Já já te respondem por aqui.",
  },
  {
    path: "model.model",
    tab: "behavior",
    section: "Inteligência",
    label: "Modelo de IA",
    hint: "Só aparecem os modelos liberados no Painel da MAVI.",
    kind: "model",
  },
  {
    path: "model.fallback_model",
    tab: "behavior",
    section: "Inteligência",
    label: "Modelo reserva",
    hint: "Usado se o principal falhar ou estiver sem chave.",
    kind: "model",
  },
  {
    path: "model.effort",
    tab: "behavior",
    section: "Inteligência",
    label: "Quanto pensar antes de responder",
    kind: "enum",
    fallback: "",
    options: [
      { value: "", label: "Padrão do modelo (recomendado)" },
      { value: "low", label: "Pouco", hint: "Mais rápido e barato." },
      { value: "medium", label: "Médio" },
      { value: "high", label: "Muito", hint: "Mais cuidadoso, mais lento e mais caro." },
    ],
  },
];

export const FIELD_BY_PATH = new Map(FIELDS.map((f) => [f.path, f]));

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Confere (e normaliza) um valor para o campo. `undefined` no resultado =
 * voltar ao padrão (o campo sai do rascunho).
 */
export function checkFieldValue(path: string, value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const f = FIELD_BY_PATH.get(path);
  if (!f) return { ok: false, error: `campo desconhecido (${path})` };
  if (value === null || value === undefined || value === "") return { ok: true, value: undefined };
  switch (f.kind) {
    case "text":
    case "area":
    case "model": {
      if (typeof value !== "string") return { ok: false, error: `${f.label}: precisa ser texto` };
      const v = value.trim();
      const max = f.kind === "model" ? 120 : f.max;
      if (v.length > max) return { ok: false, error: `${f.label}: no máximo ${max} caracteres` };
      return { ok: true, value: v || undefined };
    }
    case "list":
    case "chips": {
      const arr = Array.isArray(value) ? value : typeof value === "string" ? value.split("\n") : null;
      if (!arr) return { ok: false, error: `${f.label}: precisa ser uma lista` };
      const items = [...new Set(arr.map((x) => String(x ?? "").replace(/^\s*[-•*]\s*/, "").trim()).filter(Boolean))];
      if (items.length > f.maxItems) return { ok: false, error: `${f.label}: no máximo ${f.maxItems} itens` };
      if (items.some((i) => i.length > f.maxLen)) return { ok: false, error: `${f.label}: item longo demais` };
      return { ok: true, value: items.length ? items : undefined };
    }
    case "enum": {
      const v = String(value);
      if (!f.options.some((o) => o.value === v)) return { ok: false, error: `${f.label}: opção inválida` };
      return { ok: true, value: v === f.fallback ? undefined : v || undefined };
    }
    case "number": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < f.min || n > f.max) return { ok: false, error: `${f.label}: entre ${f.min} e ${f.max}` };
      return { ok: true, value: n };
    }
    case "bool":
      if (typeof value !== "boolean") return { ok: false, error: `${f.label}: sim ou não` };
      return { ok: true, value };
    case "hours": {
      if (typeof value !== "object" || Array.isArray(value)) return { ok: false, error: `${f.label}: formato inválido` };
      const out: WeeklyHours = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (!DAYS.some(([d]) => d === k)) return { ok: false, error: `${f.label}: dia inválido (${k})` };
        if (v === null) {
          out[k as DayKey] = null;
          continue;
        }
        const d = v as { from?: unknown; to?: unknown };
        if (typeof d?.from !== "string" || typeof d?.to !== "string" || !TIME.test(d.from) || !TIME.test(d.to) || d.from >= d.to)
          return { ok: false, error: `${f.label}: horário inválido em ${k}` };
        out[k as DayKey] = { from: d.from, to: d.to };
      }
      return { ok: true, value: Object.keys(out).length ? out : undefined };
    }
  }
}

/** O valor em palavras (para a prévia das propostas e para a MAVI ler o rascunho). */
export function describeValue(path: string, value: unknown): string {
  const f = FIELD_BY_PATH.get(path);
  if (value === undefined || value === null || value === "") return "(padrão)";
  if (!f) return JSON.stringify(value);
  switch (f.kind) {
    case "enum":
      return f.options.find((o) => o.value === String(value))?.label ?? String(value);
    case "number":
      return f.options.find((o) => o.value === String(value))?.label ?? String(value);
    case "bool":
      return value ? "Sim" : "Não";
    case "model":
      return String(value);
    case "list":
    case "chips":
      return Array.isArray(value) ? value.join(" · ") : String(value);
    case "hours":
      return hoursText(value as WeeklyHours);
    case "text":
      return f.presets?.find((o) => o.value === value)?.label ?? String(value);
    default:
      return String(value);
  }
}

/** "Segunda a sexta: 09:00 às 18:00 · Sábado: 09:00 às 12:00 · Domingo: fechado". */
export function hoursText(h: WeeklyHours | null | undefined): string {
  if (!h || !Object.keys(h).length) return "(não informado)";
  const parts: string[] = [];
  let i = 0;
  while (i < DAYS.length) {
    const [key, name] = DAYS[i]!;
    const v = h[key];
    const same = (j: number) => {
      const o = h[DAYS[j]![0]];
      return (o === null && v === null) || (o && v && o.from === v.from && o.to === v.to) || (o === undefined && v === undefined);
    };
    let j = i;
    while (j + 1 < DAYS.length && same(j + 1)) j++;
    const label = j > i ? `${name} a ${DAYS[j]![1].toLowerCase()}` : name;
    if (v !== undefined) parts.push(`${label}: ${v ? `${v.from} às ${v.to}` : "fechado"}`);
    i = j + 1;
  }
  return parts.join(" · ") || "(não informado)";
}

/** O guia dos campos para a MAVI (caminho, tipo, opções). */
export function fieldsGuide(): string {
  return FIELDS.map((f) => {
    const type =
      f.kind === "enum" || f.kind === "number"
        ? `uma destas opções: ${f.options.map((o) => `${f.kind === "number" ? o.value : JSON.stringify(o.value)} (${o.label})`).join(", ")}${f.kind === "number" ? ` ou um inteiro de ${f.min} a ${f.max}` : ""}`
        : f.kind === "bool"
          ? "true ou false"
          : f.kind === "list" || f.kind === "chips"
            ? `lista de textos (até ${f.maxItems})`
            : f.kind === "hours"
              ? 'objeto por dia {"mon"|"tue"|"wed"|"thu"|"fri"|"sat"|"sun": {"from":"HH:MM","to":"HH:MM"} ou null = fechado}'
              : f.kind === "model"
                ? 'referência "<provedor>:<modelo>" de um modelo liberado (lista "Modelos liberados" no estado) ou null = padrão do Painel. Só mude se a pessoa pedir.'
                : `texto até ${f.max} caracteres${f.kind === "text" && f.presets ? `; opções sugeridas: ${f.presets.map((p) => JSON.stringify(p.value)).join(", ")}` : ""}`;
    return `- ${f.path} — ${f.label}${f.hint ? ` (${f.hint})` : ""}: ${type}`;
  }).join("\n");
}

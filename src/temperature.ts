import { supabase } from "./supabase";
import { navigate, routeParts } from "./router";

/**
 * Termômetro do cliente (migration 20261110090000_client_temperature): a
 * temperatura da relação com cada cliente, lida pelo Jev (TypeSafe) nas
 * reuniões gravadas e nos grupos de WhatsApp. Aqui ficam os tipos, as
 * chamadas ao banco, a demonstração e o que as telas repetem (faixa, cor,
 * tendência, links das leituras).
 */

export type TemperatureBand = {
  name: string;
  min: number;
  color: string;
  alert: boolean;
};
export type TemperatureReason = { key: string; label: string; neutral: boolean };
export type TemperatureSettings = {
  bands: TemperatureBand[];
  window_days: number;
  half_life_days: number;
  meeting_weight: number;
  whatsapp_weight: number;
  flag_threshold: number;
  flag_days: number;
  reasons: TemperatureReason[];
  reason_question: string;
  alerts: boolean;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
};
export type TemperatureSource = "meeting" | "whatsapp";
/** Um indicador como o banco guarda (Painel da MAVI › Termômetro). */
export type IndicatorConfig = {
  id?: string;
  /** Nulo: da empresa; com produto, só para os clientes dele. */
  product_id: string | null;
  key?: string;
  kind: "score" | "flag";
  name: string;
  description: string;
  /** Nota: do pior para o melhor (2 a 10). */
  levels: string[];
  weight: number;
  sources: TemperatureSource[];
  alert: boolean;
  active: boolean;
};
export type ProductRule = {
  product_id: string;
  indicator_id: string;
  active: boolean;
  weight: number | null;
};
export type TemperatureConfig = {
  settings: TemperatureSettings;
  indicators: IndicatorConfig[];
  rules: ProductRule[];
  jev: { provider: string; model: string } | null;
  stats: { done: number; pending: number; failed: number; skipped: number };
  cost_30d: number;
};

export type CurrentIndicator = {
  key: string;
  name: string;
  value: number | null;
  weight: number;
  d7: number | null;
  d30: number | null;
};
export type CurrentFlag = {
  key: string;
  name: string;
  alert: boolean;
  p: number;
  at: string | null;
};
export type TemperatureCurrent = {
  day: string;
  score: number | null;
  band: number | null;
  signals: number;
  score_d7: number | null;
  score_d30: number | null;
  indicators: CurrentIndicator[];
  flags: CurrentFlag[];
  reasons: { key: string; label: string; share: number }[];
};
export type TemperatureSignal = {
  id: string;
  type: TemperatureSource;
  source_id: string;
  group_id: string | null;
  message_id: string | null;
  title: string;
  date: string;
  day: string;
  status: "pending" | "done" | "failed";
  answers: Record<string, { v: number; c?: number; e?: number }>;
  flags: Record<string, number>;
  reason: string | null;
  excerpt: string;
  /** Quantas mensagens (ou falas) do cliente o Jev leu. */
  client_lines?: number;
  /** WhatsApp: o nome do grupo. */
  group?: string | null;
};
/** As leituras de uma fonte: lidas, na fila, com erro e sem fala do cliente. */
export type SourceCounts = {
  read: number;
  pending: number;
  failed: number;
  skipped: number;
  /** WhatsApp: os grupos ligados ao cliente. */
  groups?: number;
};
/** Uma mensagem do cliente num dia de grupo (o que o Jev leu como [cliente]). */
export type SignalMessage = {
  id: string;
  at: string;
  who: string;
  kind: string;
  text: string;
  edited: boolean;
};
export type ClientIndicator = {
  key: string;
  kind: "score" | "flag";
  name: string;
  description: string;
  levels: string[];
  weight: number;
  alert: boolean;
  product_id: string | null;
};
export type ClientTemperature = {
  settings: TemperatureSettings;
  indicators: ClientIndicator[];
  current: TemperatureCurrent | null;
  summary: { text: string; at: string; score: number | null } | null;
  refreshed_at: string | null;
  history: { day: string; score: number | null; band: number | null; flags: string[] }[] | null;
  signals: TemperatureSignal[];
  /** Ausente antes da migration 20270129090000. */
  sources?: { meeting: SourceCounts; whatsapp: SourceCounts };
  pending: number;
  failed: number;
  jev: boolean;
  can_configure: boolean;
};
export type PortfolioClient = {
  client_id: string;
  name: string;
  color: string;
  score: number | null;
  band: number | null;
  d7: number | null;
  d30: number | null;
  flags: CurrentFlag[];
  reasons: { key: string; label: string; share: number }[];
  indicators: CurrentIndicator[];
  signals: number;
  summary: string | null;
  refreshed_at: string | null;
  pending: number;
  teams: string[];
  products: string[];
};
export type Portfolio = {
  settings: TemperatureSettings;
  jev: boolean;
  can_configure: boolean;
  clients: PortfolioClient[];
};

// ------------------------------------------------------------ o que as telas repetem
/** A faixa de uma nota (índice; nulo sem nota). */
export function bandIndex(bands: TemperatureBand[], score: number | null) {
  if (score === null || score === undefined) return null;
  let found = 0;
  bands.forEach((b, i) => {
    if (score >= b.min) found = i;
  });
  return found;
}
export const bandOf = (bands: TemperatureBand[], i: number | null | undefined) =>
  i === null || i === undefined ? null : (bands[i] ?? null);
/** A nota como aparece: inteira, ou "—". */
export const scoreLabel = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : String(Math.round(Number(v)));
/** "+4", "−12" ou "" (sem comparação). */
export function trendLabel(v: number | null | undefined) {
  if (v === null || v === undefined) return "";
  const n = Math.round(Number(v));
  if (n === 0) return "estável";
  return n > 0 ? `+${n}` : `−${Math.abs(n)}`;
}
export const trendTone = (v: number | null | undefined) =>
  v === null || v === undefined || Math.round(Number(v)) === 0
    ? "flat"
    : Number(v) > 0
      ? "up"
      : "down";
export const dateBr = (iso: string | null | undefined) =>
  iso
    ? new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString(
        "pt-BR",
        { timeZone: "America/Sao_Paulo" },
      )
    : "";

/** Um lugar do app, dentro da empresa atual (/agencias/<slug>/…). */
export function appPath(path: string) {
  const company = routeParts(window.location.pathname).company;
  return (company ? `/agencias/${company}` : "") + path;
}
/** Onde uma leitura abre: a reunião ou a primeira mensagem do cliente no dia. */
export function signalPath(s: TemperatureSignal) {
  if (s.type === "meeting") return `/drive?gravacao=${s.source_id}`;
  if (s.group_id)
    return `/drive?whatsapp=${s.group_id}${s.message_id ? `&msg=${s.message_id}` : ""}`;
  return null;
}
/** O título da leitura sem o "Whatsapp · " e a data do fim, que o ícone e a
 * linha de baixo já mostram. */
export function signalTitle(s: TemperatureSignal) {
  let title = (s.title ?? "").replace(/^whatsapp\s*·\s*/i, "").trim();
  const date = ` · ${dateBr(s.date)}`;
  if (title.endsWith(date)) title = title.slice(0, -date.length).trim();
  return title || (s.type === "meeting" ? "Reunião" : "WhatsApp");
}
/** A aba Termômetro de um cliente no Drive. */
export const clientTemperaturePath = (client: string) =>
  `/drive?termometro=${client}`;
export const openInApp = (path: string) => navigate(appPath(path));

// ------------------------------------------------------------ banco
/** Sem banco ou na demonstração (empresa "demo-agency"): dados de exemplo. */
const offline = (company: string) =>
  !supabase || !/^[0-9a-f-]{36}$/i.test(company);
async function rpc<T>(name: string, args: Record<string, unknown>) {
  const { data, error } = await supabase!.rpc(name, args);
  if (error) throw Error(error.message);
  return data as T;
}

export async function loadClientTemperature(company: string, client: string) {
  if (offline(company)) return demoClient();
  return rpc<ClientTemperature>("client_temperature", {
    p_company: company,
    p_client: client,
    p_days: 180,
    p_signals: 40,
  });
}
/** As mensagens do cliente num dia de grupo (a leitura do WhatsApp aberta). */
export async function loadSignalMessages(company: string, signal: string) {
  if (offline(company)) return demoMessages(signal);
  const r = await rpc<{ messages: SignalMessage[] }>("temperature_signal_messages", {
    p_company: company,
    p_signal: signal,
  });
  return r.messages ?? [];
}
export async function loadPortfolio(company: string, clients: { id: string; name: string; color: string }[] = []) {
  if (offline(company)) return demoPortfolio(clients);
  return rpc<Portfolio>("clients_temperature", { p_company: company });
}
export async function loadTemperatureConfig(company: string) {
  if (offline(company)) return structuredClone(demoConfig);
  return rpc<TemperatureConfig>("temperature_settings", { p_company: company });
}
export async function saveTemperatureConfig(
  company: string,
  config: Pick<TemperatureConfig, "settings" | "indicators" | "rules">,
) {
  const payload = {
    ...config.settings,
    indicators: config.indicators,
    rules: config.rules,
  };
  if (offline(company)) {
    const questions = (c: Pick<TemperatureConfig, "settings" | "indicators">) =>
      JSON.stringify([
        c.indicators.map((i) => [i.name, i.kind, i.description, i.levels, i.sources, i.active, i.product_id]),
        c.settings.reasons,
        c.settings.reason_question,
      ]);
    const changed = questions(config) !== questions(demoConfig);
    demoConfig = structuredClone({
      ...demoConfig,
      ...config,
      settings: {
        ...config.settings,
        version: demoConfig.settings.version + (changed ? 1 : 0),
      },
      indicators: config.indicators.map((i, n) => ({
        ...i,
        id: i.id ?? `demo-${Date.now()}-${n}`,
        key: i.key ?? `indicador_${n + 1}`,
      })),
    });
    return structuredClone(demoConfig);
  }
  return rpc<TemperatureConfig>("save_temperature_settings", {
    p_company: company,
    p_config: payload,
  });
}
export async function loadMemberPhones(company: string, user: string) {
  if (offline(company)) return demoPhones.get(user) ?? [];
  return rpc<string[]>("member_phones", { p_company: company, p_user: user });
}
/** Grava a lista inteira (vazia apaga todos); devolve como ficou no banco. */
export async function saveMemberPhones(
  company: string,
  user: string,
  phones: string[],
) {
  if (offline(company)) {
    const full = [...new Set(phones.map(phoneDigits).filter(Boolean))];
    demoPhones.set(user, full);
    return full;
  }
  return rpc<string[]>("set_member_phones", {
    p_company: company,
    p_user: user,
    p_phones: phones,
  });
}
/** Os dígitos como o banco guarda (com 55 quando falta o país). */
export function phoneDigits(v: string) {
  const d = v.replace(/\D/g, "");
  return d.length === 10 || d.length === 11 ? `55${d}` : d;
}
/** 5511987654321 → +55 (11) 98765-4321. */
export function phoneLabel(digits: string | null | undefined) {
  if (!digits) return "";
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(digits);
  return m ? `+55 (${m[1]}) ${m[2]}-${m[3]}` : `+${digits}`;
}

// ------------------------------------------------------------ demonstração
const demoPhones = new Map<string, string[]>();
export const DEFAULT_BANDS: TemperatureBand[] = [
  { name: "Gelado", min: 0, color: "#2a78d6", alert: true },
  { name: "Frio", min: 30, color: "#7fb2ea", alert: true },
  { name: "Morno", min: 50, color: "#eda100", alert: false },
  { name: "Quente", min: 70, color: "#eb6834", alert: false },
  { name: "Fervendo", min: 85, color: "#e34948", alert: false },
];
const demoSettings: TemperatureSettings = {
  bands: DEFAULT_BANDS,
  window_days: 60,
  half_life_days: 21,
  meeting_weight: 2,
  whatsapp_weight: 1,
  flag_threshold: 0.7,
  flag_days: 14,
  reasons: [
    { key: "resultados", label: "Resultados (leads, vendas, desempenho das campanhas)", neutral: false },
    { key: "prazos", label: "Prazos e atrasos nas entregas", neutral: false },
    { key: "qualidade", label: "Qualidade das entregas (artes, textos, vídeos, páginas)", neutral: false },
    { key: "atendimento", label: "Atendimento e comunicação com o time", neutral: false },
    { key: "financeiro", label: "Preço, custo, verba ou pagamento", neutral: false },
    { key: "estrategia", label: "Estratégia, planejamento e próximos passos", neutral: false },
    { key: "elogio", label: "Elogios e reconhecimento ao trabalho", neutral: false },
    { key: "rotina", label: "Rotina: nada que mexa com o humor do cliente", neutral: true },
  ],
  reason_question: "Qual assunto mais mexe com o humor do cliente neste material?",
  alerts: true,
  version: 1,
  updated_at: null,
  updated_by: null,
};
const demoIndicators: IndicatorConfig[] = [
  {
    id: "demo-satisfacao",
    product_id: null,
    key: "satisfacao",
    kind: "score",
    name: "Satisfação com resultados",
    description:
      "Como o cliente avalia os resultados que a agência entrega: leads, vendas, campanhas, conteúdo e o retorno do investimento.",
    levels: [
      "Muito insatisfeito: reclama dos resultados e questiona o trabalho",
      "Insatisfeito: diz que os resultados estão abaixo do esperado",
      "Neutro: nem elogia nem reclama dos resultados",
      "Satisfeito: reconhece bons resultados",
      "Muito satisfeito: comemora e elogia os resultados",
    ],
    weight: 3,
    sources: ["meeting", "whatsapp"],
    alert: false,
    active: true,
  },
  {
    id: "demo-permanencia",
    product_id: null,
    key: "permanencia",
    kind: "score",
    name: "Risco de cancelamento",
    description:
      "O quanto o cliente dá sinais de que vai continuar com a agência ou de que pode sair (cancelar, pausar, reduzir o contrato, trocar de agência).",
    levels: [
      "Alto risco: fala em cancelar, pausar, reduzir o contrato ou trocar de agência",
      "Risco: compara com concorrentes, questiona o custo ou o valor do trabalho",
      "Incerto: sinais misturados",
      "Baixo risco: fala com naturalidade dos próximos meses",
      "Sem risco: fala em ampliar, renovar ou indicar a agência",
    ],
    weight: 3,
    sources: ["meeting", "whatsapp"],
    alert: false,
    active: true,
  },
  {
    id: "demo-relacao",
    product_id: null,
    key: "relacao",
    kind: "score",
    name: "Relação e comunicação",
    description:
      "O tom do cliente com o time: paciência, confiança, cordialidade, cobranças e reclamações sobre atendimento e prazos.",
    levels: [
      "Hostil: tom agressivo, cobranças duras, reclama do atendimento",
      "Tensa: impaciência, cobra prazos ou respostas",
      "Cordial: tom neutro e profissional",
      "Boa: tom amigável e colaborativo",
      "Excelente: confiança, parceria e elogios ao time",
    ],
    weight: 2,
    sources: ["meeting", "whatsapp"],
    alert: false,
    active: true,
  },
  {
    id: "demo-engajamento",
    product_id: null,
    key: "engajamento",
    kind: "score",
    name: "Engajamento",
    description:
      "O quanto o cliente participa: responde, aprova, envia material, aparece nas reuniões e puxa as próximas ações.",
    levels: [
      "Ausente: não responde e não participa",
      "Baixo: responde pouco e com atraso, trava aprovações",
      "Regular: participa quando é chamado",
      "Alto: responde, aprova e envia material com agilidade",
      "Muito alto: propõe ideias e puxa as próximas ações",
    ],
    weight: 2,
    sources: ["meeting", "whatsapp"],
    alert: false,
    active: true,
  },
  {
    id: "demo-cancelamento",
    product_id: null,
    key: "cancelamento",
    kind: "flag",
    name: "Fala em cancelar",
    description:
      "O cliente fala em cancelar, pausar, encerrar o contrato, reduzir o escopo ou trocar de agência?",
    levels: [],
    weight: 1,
    sources: ["meeting", "whatsapp"],
    alert: true,
    active: true,
  },
  {
    id: "demo-prazo",
    product_id: null,
    key: "cobranca_prazo",
    kind: "flag",
    name: "Reclama de atraso",
    description:
      "O cliente reclama de atraso, de prazo não cumprido ou de demora nas entregas ou nas respostas?",
    levels: [],
    weight: 1,
    sources: ["meeting", "whatsapp"],
    alert: false,
    active: true,
  },
  {
    id: "demo-financeiro",
    product_id: null,
    key: "financeiro",
    kind: "flag",
    name: "Questiona o custo",
    description:
      "O cliente reclama do preço, questiona o custo ou o retorno, pede desconto ou fala em cortar a verba?",
    levels: [],
    weight: 1,
    sources: ["meeting", "whatsapp"],
    alert: false,
    active: true,
  },
];
let demoConfig: TemperatureConfig = {
  settings: demoSettings,
  indicators: demoIndicators,
  rules: [],
  jev: { provider: "OpenRouter", model: "~typesafe/jev-latest" },
  stats: { done: 184, pending: 3, failed: 0, skipped: 41 },
  cost_30d: 0.03,
};

const isoDay = (offset: number) => {
  const d = new Date(Date.now() + offset * 86400000);
  return d.toISOString().slice(0, 10);
};
function demoHistory() {
  // Quente em agosto, esfriando com a queda dos leads em setembro.
  return Array.from({ length: 120 }, (_, i) => {
    const t = i / 119;
    const score = Math.round((78 - 44 * t * t + 4 * Math.sin(i / 5)) * 10) / 10;
    return { day: isoDay(i - 119), score, band: bandIndex(DEFAULT_BANDS, score), flags: i > 112 ? ["cancelamento"] : [] };
  });
}
function demoClient(): ClientTemperature {
  const history = demoHistory();
  const last = history.at(-1)!;
  const indicator = (key: string, name: string, value: number, weight: number, d30: number): CurrentIndicator => ({
    key, name, value, weight, d7: Math.round(d30 / 3), d30,
  });
  return {
    settings: demoSettings,
    indicators: demoIndicators.map(({ key, kind, name, description, levels, weight, alert, product_id }) => ({
      key: key!, kind, name, description, levels, weight, alert, product_id,
    })),
    current: {
      day: last.day,
      score: last.score,
      band: last.band,
      signals: 23,
      score_d7: -6,
      score_d30: -19,
      indicators: [
        indicator("satisfacao", "Satisfação com resultados", 28, 3, -31),
        indicator("permanencia", "Risco de cancelamento", 31, 3, -24),
        indicator("relacao", "Relação e comunicação", 52, 2, -9),
        indicator("engajamento", "Engajamento", 64, 2, 3),
      ],
      flags: [
        { key: "cancelamento", name: "Fala em cancelar", alert: true, p: 0.86, at: isoDay(-2) + "T14:10:00Z" },
      ],
      reasons: [
        { key: "resultados", label: "Resultados (leads, vendas, desempenho das campanhas)", share: 58 },
        { key: "prazos", label: "Prazos e atrasos nas entregas", share: 27 },
        { key: "atendimento", label: "Atendimento e comunicação com o time", share: 15 },
      ],
    },
    summary: {
      text: "A temperatura caiu com a queda dos leads: na reunião de alinhamento o cliente disse que vai reavaliar o contrato se setembro fechar abaixo da meta, e no WhatsApp voltou a cobrar o relatório atrasado. O tom com o time segue cordial. Vale levar à próxima reunião um plano de recuperação com números e datas.",
      at: isoDay(-1) + "T09:00:00Z",
      score: 38,
    },
    refreshed_at: new Date().toISOString(),
    history,
    signals: [
      {
        id: "s1", type: "meeting", source_id: "demo", group_id: null, message_id: null,
        title: "Alinhamento de setembro", date: isoDay(-2) + "T14:10:00Z", day: isoDay(-2), status: "done",
        answers: { satisfacao: { v: 12, e: 0.95 }, permanencia: { v: 18, e: 0.92 }, relacao: { v: 48, e: 0.7 }, engajamento: { v: 70, e: 0.6 } },
        flags: { cancelamento: 0.86 }, reason: "resultados",
        excerpt: "O cliente disse que os leads caíram pela metade e que vai reavaliar o contrato se setembro fechar abaixo da meta.",
      },
      {
        id: "s2", type: "whatsapp", source_id: "demo", group_id: null, message_id: null,
        title: "Whatsapp · 4282 - Tráfego", date: isoDay(-1) + "T13:00:00Z", day: isoDay(-1), status: "done",
        answers: { relacao: { v: 35, e: 0.8 }, engajamento: { v: 55, e: 0.5 } },
        flags: { cobranca_prazo: 0.91 }, reason: "prazos",
        excerpt: "Pessoal, o relatório da semana passada ainda não chegou.",
        client_lines: 3, group: "4282 - Tráfego",
      },
      {
        id: "s3", type: "whatsapp", source_id: "demo", group_id: null, message_id: null,
        title: "Whatsapp · 4282 - Tráfego", date: isoDay(-9) + "T10:30:00Z", day: isoDay(-9), status: "done",
        answers: { satisfacao: { v: 74, e: 0.7 }, relacao: { v: 82, e: 0.9 } },
        flags: {}, reason: "elogio",
        excerpt: "Adorei as artes novas, ficaram muito boas!",
        client_lines: 2, group: "4282 - Tráfego",
      },
    ],
    sources: {
      meeting: { read: 6, pending: 0, failed: 0, skipped: 0 },
      whatsapp: { read: 17, pending: 0, failed: 0, skipped: 4, groups: 1 },
    },
    pending: 0,
    failed: 0,
    jev: true,
    can_configure: true,
  };
}
function demoMessages(signal: string): SignalMessage[] {
  const at = (day: number, time: string) => `${isoDay(day)}T${time}:00-03:00`;
  if (signal === "s3")
    return [
      { id: "m4", at: at(-9, "10:30"), who: "Carla (cliente)", kind: "text", text: "Adorei as artes novas, ficaram muito boas!", edited: false },
      { id: "m5", at: at(-9, "10:32"), who: "Carla (cliente)", kind: "text", text: "Podem seguir nessa linha para outubro.", edited: false },
    ];
  return [
    { id: "m1", at: at(-1, "10:05"), who: "Carla (cliente)", kind: "text", text: "Pessoal, o relatório da semana passada ainda não chegou.", edited: false },
    { id: "m2", at: at(-1, "10:06"), who: "Carla (cliente)", kind: "audio", text: "[áudio 00:42] Preciso desse relatório até amanhã, porque vou apresentar para a diretoria na quinta.", edited: false },
    { id: "m3", at: at(-1, "16:40"), who: "Carla (cliente)", kind: "text", text: "Alguma novidade?", edited: false },
  ];
}
function demoPortfolio(clients: { id: string; name: string; color: string }[]): Portfolio {
  const scores = [38, 82, 64, 22, 91, 55, 47, 73];
  return {
    settings: demoSettings,
    jev: true,
    can_configure: true,
    clients: clients.slice(0, 40).map((c, i) => {
      const score = scores[i % scores.length];
      return {
        client_id: c.id,
        name: c.name,
        color: c.color,
        score,
        band: bandIndex(DEFAULT_BANDS, score),
        d7: [-6, 2, 0, -9, 1, -3, 4, 0][i % 8],
        d30: [-19, 5, -2, -25, 3, -8, 6, 1][i % 8],
        flags: score < 30 ? [{ key: "cancelamento", name: "Fala em cancelar", alert: true, p: 0.8, at: isoDay(-3) }] : [],
        reasons: [{ key: "resultados", label: "Resultados (leads, vendas, desempenho das campanhas)", share: 60 }],
        indicators: [],
        signals: 10 + i,
        summary: null,
        refreshed_at: new Date().toISOString(),
        pending: 0,
        teams: [],
        products: [],
      };
    }).sort((a, b) => (a.score ?? 999) - (b.score ?? 999)),
  };
}

import { supabase } from "./supabase";

/**
 * Campanhas › lista: a Leitura do dia da MAVI (migração
 * 20270403170000_campaign_daily_read). Toda manhã, depois da sincronização,
 * uma frase por campanha ativa e até 3 pontos de apoio; a coluna MAVI da
 * lista mostra a frase e os insights abertos. O worker é api/_campaign-daily.ts.
 */

export type DailyTone = "good" | "attention" | "bad";
export type DailyRead = {
  campaign: string;
  /** O dia da leitura (hoje; senão de até 3 dias atrás). Nulo: só na fila. */
  day: string | null;
  tone: DailyTone | null;
  headline: string | null;
  points: string[];
  at: string | null;
  money_basis: "net" | "gross" | null;
  /** rule: pelos números do MAVI, sem a MAVI (parada, sem teto, sem resposta). */
  source: "mavi" | "rule" | null;
  /** A leitura de hoje está na fila ou sendo feita. */
  pending: boolean;
  /** Até 2 insights abertos, os mais importantes primeiro. */
  insights: { title: string; priority: "high" | "medium" | "low" }[];
};
export type DailyReads = { enabled: boolean; today: string; rows: DailyRead[] };
export type DailySettings = {
  enabled: boolean;
  hour: number;
  run_cap_usd: number;
  insights_enabled: boolean;
  month: { reads: number; cost_usd: number };
};

export interface DailyBackend {
  reads(company: string, campaigns: string[]): Promise<DailyReads>;
  settings(company: string): Promise<DailySettings>;
  save(company: string, settings: Partial<Pick<DailySettings, "enabled" | "hour" | "run_cap_usd">>): Promise<DailySettings>;
}

export const TONE_LABELS: Record<DailyTone, string> = {
  good: "No caminho",
  attention: "Atenção",
  bad: "Fora da meta",
};

async function rpc<T>(name: string, args: Record<string, unknown>) {
  const { data, error } = await supabase!.rpc(name, args);
  if (error) throw Error(error.message);
  return data as T;
}
const settingsFrom = (s: DailySettings): DailySettings => ({
  ...s,
  run_cap_usd: Number(s.run_cap_usd) || 0,
  month: { reads: Number(s.month?.reads) || 0, cost_usd: Number(s.month?.cost_usd) || 0 },
});

export const serverDaily: DailyBackend = {
  async reads(company, campaigns) {
    if (!campaigns.length) return { enabled: false, today: "", rows: [] };
    const r = await rpc<DailyReads>("campaign_daily_reads", { p_company: company, p_campaigns: campaigns });
    return { ...r, rows: r.rows.map((x) => ({ ...x, points: Array.isArray(x.points) ? x.points : [] })) };
  },
  settings: async (company) => settingsFrom(await rpc<DailySettings>("campaign_daily_settings", { p_company: company })),
  save: async (company, settings) =>
    settingsFrom(await rpc<DailySettings>("save_campaign_daily_settings", { p_company: company, p_settings: settings })),
};

/** Demonstração: leituras de exemplo para as primeiras campanhas da página. */
export function demoDaily(): DailyBackend {
  let settings: DailySettings = {
    enabled: true,
    hour: 7,
    run_cap_usd: 0.1,
    insights_enabled: true,
    month: { reads: 42, cost_usd: 0.17 },
  };
  const at = new Date();
  at.setHours(7, 24, 0, 0);
  const today = at.toISOString().slice(0, 10);
  const samples: Omit<DailyRead, "campaign">[] = [
    {
      day: today,
      tone: "good",
      headline:
        "Conversas 28% mais baratas que a meta, puxadas pelo anúncio 'Café gelado em 2 min'; o ritmo de gasto está certo para fechar a verba.",
      points: [
        "O público 'Mulheres 25-34' traz 6 de cada 10 conversas a R$ 7,90 cada.",
        "A copy com a promessa de tempo ('em 2 min') tem o dobro da taxa de cliques das outras.",
        "Vale duplicar o conjunto 'Lookalike 1%' com +20% de verba.",
      ],
      at: at.toISOString(),
      money_basis: "net",
      source: "mavi",
      pending: false,
      insights: [
        { title: "O anúncio 'Café gelado em 2 min' sustenta a campanha", priority: "medium" },
        { title: "O conjunto 'Amplo' está cansando: frequência 4,1", priority: "low" },
      ],
    },
    {
      day: today,
      tone: "bad",
      headline:
        "Ontem foram R$ 96 sem nenhum lead e o ciclo está 35% acima da meta; o conjunto 'Interesses amplos' leva metade da verba sem lead.",
      points: [
        "O anúncio 'Vídeo depoimento' segue com o lead mais barato (R$ 14,20).",
        "A copy 'Últimas vagas' perdeu metade da taxa de cliques em 7 dias: o público já viu demais.",
      ],
      at: at.toISOString(),
      money_basis: "net",
      source: "mavi",
      pending: false,
      insights: [{ title: "Leads chegam ao CRM sem a UTM do anúncio", priority: "high" }],
    },
  ];
  return {
    async reads(_company, campaigns) {
      return {
        enabled: settings.enabled,
        today,
        // As últimas da página primeiro (na demonstração, a primeira tem o ciclo encerrado).
        rows: settings.enabled
          ? [...campaigns].reverse().slice(0, samples.length).map((campaign, i) => ({ campaign, ...samples[i] }))
          : [],
      };
    },
    async settings() {
      return settings;
    },
    async save(_company, s) {
      settings = { ...settings, ...s };
      return settings;
    },
  };
}

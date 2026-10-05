import { supabase } from "./supabase";

/**
 * Campanhas › lista: o orçamento configurado no Meta/Google (migração
 * 20270427090000_campaign_platform_budget). A lista só lê o banco: o leitor
 * em 2º plano lê a cada ~3 h (api/_ads-budget.ts) e o botão "Atualizar" lê
 * uma campanha (no máximo a cada 5 min). O valor é sempre o real da
 * plataforma; a comparação é com o recomendado sem M. O vitalício aparece à
 * parte e não entra na comparação.
 */

/** Uma campanha (CBO, Google) ou um conjunto (ABO) da plataforma. */
export type PlatformBudgetItem = {
  id: string;
  name: string;
  level: "campaign" | "adset";
  campaign_id: string;
  active: boolean;
  status: string;
  daily: number;
  lifetime: number;
  lifetime_left: number;
  shared?: boolean;
};

export type PlatformBudget = {
  /** A soma do diário do que está entregando. */
  daily: number;
  lifetime: number;
  lifetime_left: number;
  /** Itens entregando / encontrados na plataforma. */
  active: number;
  total: number;
  items: PlatformBudgetItem[];
  currency: string;
  previous_daily: number | null;
  changed_at: string | null;
  /** Nulo: ainda não houve leitura boa (só a tentativa). */
  read_at: string | null;
  tried_at: string;
  error: string | null;
};

type Num = number | string;
type RawItem = Omit<PlatformBudgetItem, "daily" | "lifetime" | "lifetime_left"> & {
  daily: Num;
  lifetime: Num;
  lifetime_left: Num;
};
export type RawPlatformBudget = Omit<
  PlatformBudget,
  "daily" | "lifetime" | "lifetime_left" | "previous_daily" | "items"
> & {
  daily: Num;
  lifetime: Num;
  lifetime_left: Num;
  previous_daily: Num | null;
  items?: RawItem[] | null;
};

/** A linha do banco (numeric chega como texto). */
export function platformBudgetFrom(raw: RawPlatformBudget | null | undefined): PlatformBudget | null {
  if (!raw) return null;
  return {
    ...raw,
    daily: Number(raw.daily) || 0,
    lifetime: Number(raw.lifetime) || 0,
    lifetime_left: Number(raw.lifetime_left) || 0,
    active: Number(raw.active) || 0,
    total: Number(raw.total) || 0,
    previous_daily: raw.previous_daily === null ? null : Number(raw.previous_daily),
    items: (raw.items ?? []).map((i) => ({
      ...i,
      daily: Number(i.daily) || 0,
      lifetime: Number(i.lifetime) || 0,
      lifetime_left: Number(i.lifetime_left) || 0,
    })),
  };
}

/** Até 10% de diferença: verde; até 25%: amarelo; acima: vermelho. */
export const GAP_OK = 10;
export const GAP_WARN = 25;
export type GapTone = "good" | "warn" | "bad";

export type BudgetGap = {
  /** Plataforma − recomendado (sem M), em reais. */
  diff: number;
  /** A diferença em % do recomendado (sem sinal); 100 quando não há recomendado. */
  pct: number;
  tone: GapTone;
};

/** O diário da plataforma comparado ao recomendado sem M (a regra do aviso no banco). */
export function budgetGap(platformDaily: number, recommendedNet: number): BudgetGap {
  const rec = Math.round(recommendedNet * 100) / 100;
  const diff = Math.round((platformDaily - rec) * 100) / 100;
  const pct =
    rec > 0
      ? Math.min((Math.abs(diff) * 100) / rec, 999)
      : platformDaily > 0
        ? 100
        : 0;
  const rounded = Math.round(pct * 10) / 10;
  return { diff, pct: rounded, tone: rounded <= GAP_OK ? "good" : rounded <= GAP_WARN ? "warn" : "bad" };
}

/** Como a linha "Na plataforma" se mostra. */
export type BudgetState =
  | { kind: "waiting" }
  | { kind: "error"; error: string }
  | { kind: "missing" }
  | { kind: "stopped" }
  | { kind: "lifetime" }
  | { kind: "daily"; gap: BudgetGap | null };

/**
 * O estado da leitura. Com orçamento vitalício entre os que entregam, o
 * diário não é comparado (fica à parte).
 */
export function budgetState(b: PlatformBudget | null, recommendedNet: number | null): BudgetState {
  if (!b) return { kind: "waiting" };
  if (!b.read_at) return b.error ? { kind: "error", error: b.error } : { kind: "waiting" };
  if (b.total === 0) return { kind: "missing" };
  if (b.active === 0) return { kind: "stopped" };
  if (b.daily <= 0 && b.lifetime > 0) return { kind: "lifetime" };
  return {
    kind: "daily",
    gap: recommendedNet === null || b.lifetime > 0 ? null : budgetGap(b.daily, recommendedNet),
  };
}

const STATUS: Record<string, string> = {
  ACTIVE: "entregando",
  ENABLED: "entregando",
  ELIGIBLE: "entregando",
  LIMITED: "entregando (limitada)",
  LEARNING: "entregando (aprendizado)",
  MISCONFIGURED: "entregando (configuração com problema)",
  PAUSED: "pausada",
  CAMPAIGN_PAUSED: "campanha pausada",
  ADSET_PAUSED: "conjunto pausado",
  NO_ACTIVE_ADSETS: "sem conjunto ativo",
  ARCHIVED: "arquivada",
  DELETED: "excluída",
  ENDED: "encerrada",
  PENDING: "agendada",
  NOT_ELIGIBLE: "não qualificada",
  IN_PROCESS: "em processamento",
  WITH_ISSUES: "com problemas",
};
export const itemStatus = (i: Pick<PlatformBudgetItem, "status" | "active">) =>
  i.active ? "entregando" : (STATUS[i.status] ?? (i.status ? i.status.toLowerCase().replace(/_/g, " ") : "parada"));

/** O botão "Atualizar": lê o orçamento da campanha agora (o servidor limita). */
export async function refreshPlatformBudget(campaign: string): Promise<void> {
  const token = supabase ? (await supabase.auth.getSession()).data.session?.access_token : undefined;
  if (!token) throw Error("Entre novamente para atualizar.");
  const res = await fetch("/api/ads-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ budget: campaign }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(data.error ?? "Não foi possível ler o orçamento na plataforma.");
}

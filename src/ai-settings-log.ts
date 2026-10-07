import { rpc } from "./api";

/**
 * Painel da MAVI › Quem usa qual modelo › Histórico de alterações
 * (ai_settings_log, migração 20270223090000). Cada linha é a alteração de um
 * campo: o padrão da empresa, as regras por funcionalidade, skill, pessoa,
 * cliente, produto e projeto, o esforço, as animações do Mural e os
 * provedores. Gravado por gatilhos no banco; ninguém edita nem apaga.
 */

export type LogArea =
  | "company"
  | "feature"
  | "skill"
  | "user"
  | "client"
  | "contract"
  | "project"
  | "animation"
  | "provider"
  | "router";
export type LogField =
  | "model"
  | "effort"
  | "provider"
  | "name"
  | "kind"
  | "base_url"
  | "active"
  | "key"
  | "models"
  | "knowledge"
  | "access"
  | "auto"
  | "mode"
  | "level"
  | "surface_levels"
  | "escalate"
  | "escalate_cap"
  | "providers"
  | "secret_providers"
  | "sigiloso"
  | "judge_sample"
  | "eval_enabled"
  | "eval_rate"
  | "eval_daily_cap"
  | "gate_enabled"
  | "gate_min"
  | "route_models";
export type LogChoice = {
  provider_id: string;
  /** O nome do provedor na hora. */
  provider?: string;
  model: string;
  model_label?: string;
};
export type LogModel = {
  id: string;
  label?: string;
  input: number;
  output: number;
  cached?: number;
};
export type LogCause = {
  type: "provider_deleted" | "model_removed" | "skill_deleted" | "baseline";
  label?: string;
  removed?: string[];
};
export type SettingsLogEntry = {
  id: number;
  at: string;
  /** Quem alterou (nulo: o sistema). */
  actor: string | null;
  area: LogArea;
  subject: string;
  /** O nome na hora (o que foi apagado continua legível). */
  subject_label: string;
  field: LogField;
  action: "created" | "changed" | "removed";
  old: unknown;
  new: unknown;
  /** Nulo: alteração direta. */
  cause: LogCause | null;
};
export type LogFilters = {
  area?: LogArea;
  subject?: string;
  fields?: LogField[];
  actor?: string;
  /** Datas (AAAA-MM-DD) no fuso da empresa. */
  from?: string;
  to?: string;
  /** O id do último já carregado. */
  before?: number;
};

export const LOG_PAGE = 30;

export async function settingsLog(
  company: string,
  filters: LogFilters = {},
): Promise<SettingsLogEntry[]> {
  const r = await rpc("ai_settings_log", {
    p_company: company,
    p_area: filters.area ?? null,
    p_subject: filters.subject ?? null,
    p_field: filters.fields?.length ? filters.fields.join(",") : null,
    p_actor: filters.actor || null,
    p_from: filters.from || null,
    p_to: filters.to || null,
    p_before: filters.before ?? null,
    p_limit: LOG_PAGE,
  });
  return (r?.items ?? []) as SettingsLogEntry[];
}

export const AREA_LABELS: Record<LogArea, string> = {
  company: "Padrão da empresa",
  feature: "Por funcionalidade",
  skill: "Por skill",
  user: "Pessoas",
  client: "Clientes",
  contract: "Produtos",
  project: "Projetos",
  animation: "Animações do Mural",
  provider: "Provedores e modelos",
  router: "Roteamento",
};
const FIELD_LABELS: Record<LogField, string> = {
  model: "Provedor e modelo",
  effort: "Esforço",
  provider: "Provedor",
  name: "Nome",
  kind: "Tipo",
  base_url: "Endereço da API",
  active: "Ligado ou desligado",
  key: "API Key",
  models: "Modelos e preços",
  knowledge: "Consulta à base de conhecimento",
  access: "Pessoas e equipes",
  auto: "Automático (o roteador escolhe)",
  mode: "Modo do roteador",
  level: "Nível de custo",
  surface_levels: "Nível por tela",
  escalate: "Segunda tentativa",
  escalate_cap: "Teto da segunda tentativa",
  providers: "Provedores permitidos",
  secret_providers: "Liberados para sigilosos",
  sigiloso: "Sigiloso",
  judge_sample: "Amostra para a autoavaliação",
  eval_enabled: "Testes fora do ar",
  eval_rate: "Respostas testadas fora do ar",
  eval_daily_cap: "Teto por dia dos testes",
  gate_enabled: "Só modelos aprovados no conjunto de avaliação",
  gate_min: "Nota mínima para aprovar",
  route_models: "Modelos do roteamento",
};

const LEVEL_NAMES: Record<string, string> = {
  economico: "Econômico",
  equilibrado: "Equilibrado",
  maxima: "Máxima qualidade",
};
const SURFACE_NAMES: Record<string, string> = {
  bubble: "Bolinha",
  page: "Módulo MAVI",
  campaigns: "Campanhas",
  whatsapp: "WhatsApp",
  meetings: "Reuniões",
  meeting: "Gravação",
  task_search: "Busca avançada",
  copilot: "Copiloto",
  dashboard: "Dashboards",
  tutorials: "Tutoriais",
  skill_coach: "Assistente de skills",
  personal_radar: "Radar pessoal",
};
const SERVER_PROVIDER = "00000000-0000-0000-0000-000000000000";

/** Os nomes de hoje (o nome da hora fica de reserva). */
export type LogNames = {
  person: (id: string) => string | undefined;
  team: (id: string) => string | undefined;
  feature: (id: string) => string | undefined;
  /** Pessoa, cliente, produto ou projeto. */
  scope: (area: LogArea, id: string) => string | undefined;
  kind: (kind: string) => string | undefined;
  effort: (effort: string) => string | undefined;
  /** O nome de um provedor da biblioteca (o roteador guarda os ids). */
  provider?: (id: string) => string | undefined;
};

export type LogLine = {
  /** Onde: a seção e a linha. */
  where: string;
  field: string;
  /** O de antes e o de depois (os dois numa troca). */
  from?: string;
  to?: string;
  /** Ou uma frase só (modelos que entraram e saíram, exclusões). */
  text?: string;
  /** O que muda sozinho, ou o estado inicial. */
  cause?: string;
};

export function actorName(e: SettingsLogEntry, names: LogNames) {
  if (!e.actor) return "Sistema";
  return names.person(e.actor) ?? "Pessoa removida";
}

function subjectName(e: SettingsLogEntry, names: LogNames) {
  switch (e.area) {
    case "company":
      return "Empresa toda";
    case "feature":
      return names.feature(e.subject) ?? e.subject;
    case "skill":
      return e.subject_label || "Skill removida";
    case "animation":
      return e.subject ? e.subject_label : "Base de conhecimento";
    case "provider":
      return e.subject_label;
    case "router":
      return "Empresa toda";
    default:
      return names.scope(e.area, e.subject) ?? (e.subject_label || "Removido");
  }
}

const isChoice = (v: unknown): v is LogChoice =>
  !!v && typeof v === "object" && "model" in v;
export const choiceText = (c: LogChoice) =>
  `${c.provider ?? "Provedor removido"} · ${c.model_label || c.model}`;

function emptyChoice(area: LogArea) {
  if (area === "company") return "Padrão do servidor";
  if (area === "feature" || area === "skill") return "Sem modelo próprio";
  return "Sem regra (vale a mais geral)";
}

const price = (m: LogModel) =>
  `${m.input}/${m.output}${m.cached === undefined ? "" : ` (cache ${m.cached})`}`;

/** O que mudou na lista de modelos: entrou, saiu, preço e nome. */
export function modelsDiff(before: LogModel[], after: LogModel[]) {
  const was = new Map(before.map((m) => [m.id, m]));
  const now = new Map(after.map((m) => [m.id, m]));
  const name = (m: LogModel) => m.label || m.id;
  const parts: string[] = [];
  const added = after.filter((m) => !was.has(m.id));
  const gone = before.filter((m) => !now.has(m.id));
  if (added.length)
    parts.push(
      `Entrou: ${added.map((m) => `${name(m)} (${price(m)})`).join(", ")}`,
    );
  if (gone.length) parts.push(`Saiu: ${gone.map(name).join(", ")}`);
  for (const m of after) {
    const o = was.get(m.id);
    if (!o) continue;
    if (price(o) !== price(m))
      parts.push(`Preço de ${name(m)}: ${price(o)} → ${price(m)}`);
    if ((o.label ?? "") !== (m.label ?? ""))
      parts.push(`Nome de ${m.id}: ${o.label || "—"} → ${m.label || "—"}`);
  }
  return parts.length ? `${parts.join("; ")}.` : "Ordem dos modelos.";
}

function accessText(v: unknown, names: LogNames) {
  const a = (v ?? {}) as { user_ids?: string[]; team_ids?: string[] };
  const people = (a.user_ids ?? []).map(
    (id) => names.person(id) ?? "Pessoa removida",
  );
  const teams = (a.team_ids ?? []).map(
    (id) => names.team(id) ?? "Equipe removida",
  );
  return `${people.length ? people.join(", ") : "Todos os líderes"} · ${
    teams.length ? teams.join(", ") : "qualquer equipe"
  }`;
}

function causeText(c: LogCause | null) {
  if (!c) return undefined;
  if (c.type === "baseline")
    return "Configuração que já existia quando o histórico começou";
  if (c.type === "provider_deleted")
    return `Automático: o provedor ${c.label ?? ""} foi excluído`.trim();
  if (c.type === "model_removed")
    return `Automático: o modelo saiu da lista do provedor ${c.label ?? ""}`.trim();
  if (c.type === "skill_deleted")
    return `Automático: a skill ${c.label ?? ""} foi apagada`.trim();
  return undefined;
}

/** Uma alteração em palavras. */
export function describeEntry(e: SettingsLogEntry, names: LogNames): LogLine {
  const where = `${AREA_LABELS[e.area]} › ${subjectName(e, names)}`;
  const cause = causeText(e.cause);
  // No estado inicial, o de antes não é conhecido.
  const line = (field: string, rest: Partial<LogLine>): LogLine => ({
    where,
    field,
    cause,
    ...rest,
    ...(e.cause?.type === "baseline" ? { from: undefined } : {}),
  });
  const yesNo = (v: unknown) => (v ? "Sim" : "Não");
  switch (e.field) {
    case "model": {
      if (e.area === "animation") {
        if (e.action === "created")
          return line("Modelo liberado", {
            text: `Liberado para ${accessText(e.new, names)}.`,
          });
        return line("Modelo liberado", { text: "Tirado da lista." });
      }
      return line(FIELD_LABELS.model, {
        from: isChoice(e.old) ? choiceText(e.old) : emptyChoice(e.area),
        to: isChoice(e.new) ? choiceText(e.new) : emptyChoice(e.area),
      });
    }
    case "effort": {
      const v = (x: unknown) => {
        const effort = (x as { effort?: string } | null)?.effort;
        return effort ? (names.effort(effort) ?? effort) : "Automático";
      };
      return line(FIELD_LABELS.effort, { from: v(e.old), to: v(e.new) });
    }
    case "provider": {
      const p = (e.new ?? e.old ?? {}) as {
        kind?: string;
        models?: LogModel[];
      };
      const kind = p.kind ? (names.kind(p.kind) ?? p.kind) : "";
      const n = p.models?.length ?? 0;
      return line(FIELD_LABELS.provider, {
        text:
          e.action === "removed"
            ? "Excluído da biblioteca (o consumo já registrado fica)."
            : `Cadastrado: ${kind}, ${n} ${n === 1 ? "modelo" : "modelos"}.`,
      });
    }
    case "kind":
      return line(FIELD_LABELS.kind, {
        from: names.kind(String(e.old)) ?? String(e.old),
        to: names.kind(String(e.new)) ?? String(e.new),
      });
    case "name":
    case "base_url":
      return line(FIELD_LABELS[e.field], {
        from: (e.old as string | null) || "—",
        to: (e.new as string | null) || "—",
      });
    case "active":
      return line(FIELD_LABELS.active, {
        from: e.old ? "Ligado" : "Desligado",
        to: e.new ? "Ligado" : "Desligado",
      });
    case "key": {
      const hint = (e.new as { key_hint?: string } | null)?.key_hint;
      return line(FIELD_LABELS.key, {
        text: `Trocada${hint ? ` (termina em ${hint})` : ""}. A chave nunca fica no histórico.`,
      });
    }
    case "models":
      return line(FIELD_LABELS.models, {
        text: modelsDiff(
          (e.old ?? []) as LogModel[],
          (e.new ?? []) as LogModel[],
        ),
      });
    case "knowledge":
      return line(FIELD_LABELS.knowledge, {
        from: e.action === "created" ? undefined : yesNo(e.old),
        to: yesNo(e.new),
      });
    case "access":
      return line(FIELD_LABELS.access, {
        from: accessText(e.old, names),
        to: accessText(e.new, names),
      });
    default:
      return routerLine(e, names, line);
  }
}

/** Os campos do roteador (cada valor vem como {campo: valor}). */
function routerLine(
  e: SettingsLogEntry,
  names: LogNames,
  line: (field: string, rest: Partial<LogLine>) => LogLine,
): LogLine {
  const raw = (x: unknown) => (x && typeof x === "object" ? (x as Record<string, unknown>)[e.field] : undefined);
  const provider = (id: string) =>
    id === SERVER_PROVIDER ? "Servidor" : (names.provider?.(id) ?? "Provedor removido");
  const text = (v: unknown): string => {
    switch (e.field) {
      case "auto":
      case "escalate":
      case "sigiloso":
      case "eval_enabled":
      case "gate_enabled":
        return v ? "Sim" : "Não";
      case "judge_sample":
      case "eval_rate":
      case "gate_min":
        return `${Math.round(Number(v ?? 0) * 100)}%`;
      case "mode":
        return v === "active" ? "Ativo" : "Sombra";
      case "level":
        return v ? (LEVEL_NAMES[String(v)] ?? String(v)) : "O da tela ou da empresa";
      case "escalate_cap":
      case "eval_daily_cap":
        return `US$ ${Number(v ?? 0).toLocaleString("pt-BR")}`;
      case "surface_levels": {
        const o = (v ?? {}) as Record<string, string>;
        const parts = Object.entries(o).map(([k, l]) => `${SURFACE_NAMES[k] ?? k}: ${LEVEL_NAMES[l] ?? l}`);
        return parts.length ? parts.join(", ") : "Todas as telas com o da empresa";
      }
      case "providers":
      case "secret_providers":
        return Array.isArray(v) ? v.map((id) => provider(String(id))).join(", ") : "Todos";
      case "route_models":
        return Array.isArray(v)
          ? v
              .map((k) => {
                const [pid, ...rest] = String(k).split("|");
                return `${provider(pid)} · ${rest.join("|")}`;
              })
              .join(", ")
          : "Todos os modelos de conversa";
      default:
        return v === undefined || v === null ? "—" : String(v);
    }
  };
  return line(FIELD_LABELS[e.field], {
    from: e.action === "created" ? undefined : text(raw(e.old)),
    to: e.action === "removed" ? text(undefined) : text(raw(e.new)),
  });
}

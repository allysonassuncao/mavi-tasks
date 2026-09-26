/**
 * Onboarding › Social Leads (migration 20261013090000_social_leads): the
 * rules shared by the page and the server (api/_social-leads.ts) — the
 * briefing's fields and steps, whether the AI has what it needs, the stage of
 * each client, the next actions, the check for promises in the posts and the
 * chat importer (the contract of the "social-leads" skill and of the B29
 * artifact). No imports: the server loads this file as is.
 */

// ------------------------------------------------------------ plan content
export type Pillar = "posicionar" | "autoridade" | "oferta";
export const pillars: Record<Pillar, string> = {
  posicionar: "Posicionar",
  autoridade: "Autoridade",
  oferta: "Oferta",
};
export type PostStatus = "pendente" | "aprovado" | "reprovado";
/** A post as the plan content carries it (the artifact's contract). */
export interface PlanPost {
  numero: number;
  badge: Pillar;
  gancho: string;
  direcaoCopy: string;
  direcaoVisual: string;
  formato: string;
  cta: string;
  ehAnuncio: boolean;
  status?: PostStatus;
  observacao?: string;
}
export interface PlanCampaign {
  objetivo: string;
  regiao: string;
  idadeGenero: string;
  segmentacao: string;
  posicionamentos: string;
  orcamento: string;
  perguntasFormulario: string[];
  roteamentoLead: string;
}
export interface PlanContent {
  diagnostico: { negocio: string; comoQuerSerVista: string };
  swot: {
    forcas: string;
    fraquezas: string;
    oportunidades: string;
    ameacas: string;
  };
  pilares: { titulo: string; descricao: string }[];
  publico: string;
  campanha: PlanCampaign;
  alertas: string[];
  posts: PlanPost[];
}

// ------------------------------------------------------------ database rows
export type Decision = "pending" | "approved" | "rejected";
export interface SlPost {
  plan_id: string;
  number: number;
  pillar: Pillar;
  hook: string;
  copy_direction: string;
  visual_direction: string;
  format: string;
  cta: string;
  is_ad: boolean;
  decision: Decision;
  note: string;
  decided_via: "link" | "team" | null;
  decided_by: string | null;
  decided_at: string | null;
  updated_at: string;
}
export interface SlPlan {
  id: string;
  company_id: string;
  contract_id: string;
  month_number: number;
  label: string;
  content: Omit<PlanContent, "posts">;
  summary: string;
  source: "ai" | "import" | "manual" | "artifact";
  share_enabled: boolean;
  shared_at: string | null;
  version: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}
export interface SlRevision {
  id: string;
  plan_id: string;
  number: number;
  reason: string;
  content: PlanContent & { label?: string };
  created_by: string | null;
  created_at: string;
}
export interface SlJob {
  id: string;
  kind: "new" | "current";
  status: "running" | "done" | "failed";
  error: string | null;
  created_at: string;
  finished_at: string | null;
  plan_id?: string | null;
}
export type CampaignObjective = "form_nativo" | "ctwa";
export const campaignObjectives: Record<CampaignObjective, string> = {
  form_nativo: "Formulário nativo do Meta",
  ctwa: "Conversa no WhatsApp (CTWA)",
};
export interface SlBriefing {
  fields: BriefingFields;
  campaign_objective: CampaignObjective | null;
  responsible_id: string | null;
  version: number;
  updated_at: string;
  updated_by?: string | null;
}
/** One client of the portfolio (social_leads_portfolio). */
export interface PortfolioItem {
  contract_id: string;
  contract_name: string;
  client_id: string;
  client_name: string;
  client_color: string;
  contract_created_at: string;
  can_write: boolean;
  briefing: {
    fields: BriefingFields;
    campaign_objective: CampaignObjective | null;
    responsible_id: string | null;
    updated_at: string;
  } | null;
  plan_count: number;
  plan: {
    id: string;
    month_number: number;
    label: string;
    created_at: string;
    updated_at: string;
    share_enabled: boolean;
    shared_at: string | null;
    alerts: number;
    first_alert: string | null;
    approved: number;
    rejected: number;
    last_decision_at: string | null;
  } | null;
  job: SlJob | null;
}
export interface Portfolio {
  configured: boolean;
  product_id?: string;
  team_id?: string | null;
  items: PortfolioItem[];
}

/** A post row as plan content. */
export function postContent(p: SlPost): PlanPost {
  return {
    numero: p.number,
    badge: p.pillar,
    gancho: p.hook,
    direcaoCopy: p.copy_direction,
    direcaoVisual: p.visual_direction,
    formato: p.format,
    cta: p.cta,
    ehAnuncio: p.is_ad,
    status:
      p.decision === "approved"
        ? "aprovado"
        : p.decision === "rejected"
          ? "reprovado"
          : "pendente",
    observacao: p.note,
  };
}
export function fullContent(plan: SlPlan, posts: SlPost[]): PlanContent {
  return {
    ...plan.content,
    posts: [...posts].sort((a, b) => a.number - b.number).map(postContent),
  };
}

// ------------------------------------------------------------ briefing
export type BriefingKey =
  | "clientName"
  | "segment"
  | "contactName"
  | "contactWhats"
  | "briefingDate"
  | "businessWhat"
  | "positioning"
  | "marketRegion"
  | "competitors"
  | "differentiators"
  | "swotForcas"
  | "swotFraquezas"
  | "swotOportunidades"
  | "swotAmeacas"
  | "targetAudience"
  | "socialProof"
  | "igHandle"
  | "fbHandle"
  | "websiteUrl"
  | "toneRefs"
  | "featuredOffer"
  | "averageTicket"
  | "mediaBudget"
  | "notes"
  | "brandColors"
  | "brandLogo"
  | "brandVisualElements";
export type BriefingFields = Partial<Record<BriefingKey, string>>;
export interface BriefingField {
  key: BriefingKey;
  label: string;
  /** What to write, shown under the label. */
  help?: string;
  placeholder?: string;
  long?: boolean;
  type?: "date" | "url";
}
export interface BriefingStep {
  id: string;
  title: string;
  fields: BriefingField[];
}
/** The 27 text fields, in 5 short steps (plus objective and responsible). */
export const briefingSteps: BriefingStep[] = [
  {
    id: "cliente",
    title: "Cliente e contato",
    fields: [
      {
        key: "clientName",
        label: "Nome da marca nas peças",
        help: "Como o cliente quer ser chamado nos posts.",
      },
      {
        key: "segment",
        label: "Segmento",
        placeholder: "Ex.: Escola infantil",
      },
      { key: "contactName", label: "Contato no cliente" },
      { key: "contactWhats", label: "WhatsApp do contato" },
      { key: "briefingDate", label: "Data do briefing", type: "date" },
    ],
  },
  {
    id: "negocio",
    title: "Negócio e oferta",
    fields: [
      {
        key: "businessWhat",
        label: "O que o negócio faz",
        long: true,
      },
      {
        key: "positioning",
        label: "Como quer ser visto",
        help: "Posicionamento desejado.",
        long: true,
      },
      { key: "differentiators", label: "Diferenciais", long: true },
      {
        key: "featuredOffer",
        label: "Oferta em destaque",
        help: "O que o anúncio do mês vai oferecer.",
      },
      { key: "averageTicket", label: "Ticket médio" },
    ],
  },
  {
    id: "mercado",
    title: "Mercado e público",
    fields: [
      { key: "marketRegion", label: "Região de atuação" },
      { key: "competitors", label: "Concorrentes e referências", long: true },
      { key: "targetAudience", label: "Público-alvo", long: true },
      {
        key: "socialProof",
        label: "Prova social",
        help: "Depoimentos e casos reais. Sem isso, a IA não inventa nenhum.",
        long: true,
      },
      { key: "swotForcas", label: "Forças", long: true },
      { key: "swotFraquezas", label: "Fraquezas", long: true },
      { key: "swotOportunidades", label: "Oportunidades", long: true },
      { key: "swotAmeacas", label: "Ameaças", long: true },
    ],
  },
  {
    id: "marca",
    title: "Presença e marca",
    fields: [
      { key: "igHandle", label: "Instagram", placeholder: "@perfil" },
      { key: "fbHandle", label: "Facebook", placeholder: "Página" },
      {
        key: "websiteUrl",
        label: "Site ou landing",
        type: "url",
        placeholder: "https://",
      },
      {
        key: "toneRefs",
        label: "Tom e referências",
        help: "Como a marca fala.",
        long: true,
      },
      {
        key: "brandColors",
        label: "Cores da marca",
        help: "Obrigatório quando não há Instagram, Facebook nem site.",
        placeholder: "Ex.: azul-marinho #0b1d3a, verde-água",
      },
      { key: "brandLogo", label: "Logo", placeholder: "Onde está o arquivo" },
      {
        key: "brandVisualElements",
        label: "Elementos visuais",
        placeholder: "Ex.: ícones, texturas, fotos da equipe",
      },
    ],
  },
  {
    id: "campanha",
    title: "Campanha",
    fields: [
      { key: "mediaBudget", label: "Verba de mídia por mês" },
      {
        key: "notes",
        label: "Restrições e observações",
        help: "Valem em todas as peças. Ex.: não prometer resultado, não falar de política.",
        long: true,
      },
    ],
  },
];
export const briefingKeys: BriefingKey[] = briefingSteps.flatMap((s) =>
  s.fields.map((f) => f.key),
);

const fold = (text: string) =>
  text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export function slugify(text: string) {
  return (
    fold(text)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "cliente"
  );
}

/** "Criar página", "não tem", "ainda não", "-": written, but not a channel. */
export function missingChannel(value: string | undefined) {
  const v = fold(value ?? "");
  if (!v) return true;
  return /^(-+|n\/?a|nenhum[a]?|inexistente|sem\b.*|criar\b.*|a criar\b.*|ainda (nao|sem)\b.*|nao (tem|existe|possui|ha)\b.*|nao)$/.test(
    v,
  );
}
/** No Instagram, Facebook nor site the AI could look at. */
export function hasNoDigitalPresence(f: BriefingFields) {
  return (
    missingChannel(f.igHandle) &&
    missingChannel(f.fbHandle) &&
    missingChannel(f.websiteUrl)
  );
}
const SENSITIVE =
  /afiliad|multinivel|mlm|renda extra|oportunidade de (renda|negocio)|ganhar dinheiro|investiment|financeir|credito|emprestimo|consorcio|seguro|saude|clinic|medic|emagrec|estetic|odontolog|psicolog|suplement/;
/** Verticals the Meta watches closely (risk of rejection or restriction). */
export function sensitiveVertical(f: BriefingFields) {
  return SENSITIVE.test(
    fold(
      [f.segment, f.businessWhat, f.featuredOffer, f.positioning]
        .filter(Boolean)
        .join(" "),
    ),
  );
}

export type Readiness = {
  filled: number;
  total: number;
  /** What stops the plan from being generated. */
  blockers: string[];
  /** What the plan will warn about. */
  warnings: string[];
  byStep: { id: string; filled: number; total: number }[];
};
/** How far the briefing is and what stops or weakens the plan. */
export function briefingReadiness(
  fields: BriefingFields,
  objective: CampaignObjective | null,
  clientName = "",
): Readiness {
  const has = (k: BriefingKey) => !!fields[k]?.trim();
  const byStep = briefingSteps.map((s) => ({
    id: s.id,
    filled:
      s.fields.filter((f) => has(f.key)).length +
      (s.id === "campanha" && objective ? 1 : 0),
    total: s.fields.length + (s.id === "campanha" ? 1 : 0),
  }));
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!has("clientName") && !clientName.trim())
    blockers.push("Informe o nome da marca.");
  const noPresence = hasNoDigitalPresence(fields);
  if (noPresence && !has("brandColors"))
    blockers.push(
      "Sem Instagram, Facebook ou site, informe as cores da marca: a IA não inventa identidade visual.",
    );
  if (noPresence)
    warnings.push(
      "Nenhum perfil social ou site ativo: o plano vai abrir com um alerta de bloqueio.",
    );
  if (!objective) warnings.push("Escolha o objetivo da campanha.");
  if (!has("socialProof"))
    warnings.push(
      "Sem prova social: os posts usam situações genéricas e o plano pede depoimentos.",
    );
  if (sensitiveVertical(fields))
    warnings.push(
      "Vertical sensível no Meta: a IA eleva o rigor e evita promessa de ganho.",
    );
  return {
    filled: byStep.reduce((s, x) => s + x.filled, 0),
    total: byStep.reduce((s, x) => s + x.total, 0),
    blockers,
    warnings,
    byStep,
  };
}

// ------------------------------------------------------------ stages
export const stages = [
  "Briefing",
  "Plano",
  "Aprovação",
  "Produção",
  "Campanha",
] as const;
/** 0 briefing · 1 plano (a revisar) · 2 aprovação · 3 aprovado/produção. */
export function stageOf(item: PortfolioItem) {
  if (!item.plan) return 0;
  if (item.plan.approved === 8) return 3;
  if (!item.plan.share_enabled && item.plan.approved + item.plan.rejected === 0)
    return 1;
  return 2;
}
export function stageLabel(item: PortfolioItem) {
  const p = item.plan;
  if (item.job?.status === "running") return "Gerando o plano…";
  if (!p) return item.briefing ? "Briefing em andamento" : "Sem briefing";
  const decided = p.approved + p.rejected;
  if (p.approved === 8) return "Plano aprovado";
  if (!p.share_enabled && decided === 0) return "Plano para revisar";
  return `Aprovação · ${decided}/8`;
}

export type Tone = "bad" | "warn" | "good" | "info";
export type NextAction = {
  contract: string;
  client: string;
  tone: Tone;
  title: string;
  detail: string;
  /** What the button does. */
  action: "open-plan" | "open-briefing" | "generate" | "share" | "next-month";
  label: string;
};
const DAY = 86_400_000;
export function daysSince(iso: string | null | undefined, now = Date.now()) {
  return iso ? Math.floor((now - new Date(iso).getTime()) / DAY) : 0;
}
/** The one thing each client needs now, the most urgent first. */
export function nextActions(
  items: PortfolioItem[],
  now = Date.now(),
): NextAction[] {
  const order: Record<Tone, number> = { bad: 0, warn: 1, good: 2, info: 3 };
  const out: NextAction[] = [];
  for (const i of items) {
    const base = { contract: i.contract_id, client: i.client_name };
    const p = i.plan;
    if (i.job?.status === "running") {
      out.push({
        ...base,
        tone: "info",
        title: `${i.client_name}: a IA está gerando o plano`,
        detail: "Leva de 1 a 3 minutos. A tela atualiza sozinha.",
        action: "open-plan",
        label: "Acompanhar",
      });
      continue;
    }
    if (
      i.job?.status === "failed" &&
      (!p || new Date(i.job.created_at) > new Date(p.updated_at))
    ) {
      out.push({
        ...base,
        tone: "bad",
        title: `${i.client_name}: a geração do plano falhou`,
        detail: i.job.error ?? "Tente gerar de novo.",
        action: p ? "open-plan" : "open-briefing",
        label: "Ver o motivo",
      });
      continue;
    }
    if (!i.briefing) {
      out.push({
        ...base,
        tone: "info",
        title: `${i.client_name}: preencher o briefing`,
        detail: "Contrato sem briefing ainda.",
        action: "open-briefing",
        label: "Começar briefing",
      });
      continue;
    }
    if (!p) {
      out.push({
        ...base,
        tone: "info",
        title: `${i.client_name}: gerar o plano do Mês 1`,
        detail: `Briefing salvo ${relativeDays(i.briefing.updated_at, now)}.`,
        action: "open-briefing",
        label: "Revisar e gerar",
      });
      continue;
    }
    if (p.first_alert && /^bloqueio/i.test(p.first_alert.trim())) {
      out.push({
        ...base,
        tone: "bad",
        title: `${i.client_name}: ${p.first_alert.replace(/^bloqueio\s*[:—-]\s*/i, "")}`,
        detail: `Bloqueio operacional apontado no plano do ${p.label}.`,
        action: "open-plan",
        label: "Abrir plano",
      });
      continue;
    }
    if (p.approved === 8) {
      const age = daysSince(p.created_at, now);
      out.push(
        age >= 25
          ? {
              ...base,
              tone: "warn",
              title: `${i.client_name}: hora do plano do Mês ${p.month_number + 1}`,
              detail: `O ${p.label} foi criado há ${age} dias.`,
              action: "next-month",
              label: "Gerar próximo mês",
            }
          : {
              ...base,
              tone: "good",
              title: `${i.client_name}: o cliente aprovou os 8 posts`,
              detail: "Produção das artes liberada.",
              action: "open-plan",
              label: "Abrir plano",
            },
      );
      continue;
    }
    if (p.rejected > 0) {
      out.push({
        ...base,
        tone: "warn",
        title: `${i.client_name}: ajuste pedido em ${p.rejected} ${p.rejected === 1 ? "post" : "posts"}`,
        detail: `${p.approved + p.rejected} de 8 decididos no ${p.label}.`,
        action: "open-plan",
        label: "Ver pedidos",
      });
      continue;
    }
    if (!p.share_enabled) {
      out.push({
        ...base,
        tone: "info",
        title: `${i.client_name}: revisar e enviar o ${p.label}`,
        detail: "O plano ainda não foi enviado para o cliente aprovar.",
        action: "share",
        label: "Enviar para aprovação",
      });
      continue;
    }
    const idle = daysSince(p.last_decision_at ?? p.shared_at, now);
    if (idle >= 2)
      out.push({
        ...base,
        tone: "warn",
        title: `${i.client_name}: aprovação parada há ${idle} dias`,
        detail: `${p.approved + p.rejected} de 8 decididos · link enviado ${relativeDays(p.shared_at, now)}.`,
        action: "share",
        label: "Reenviar link",
      });
  }
  return out.sort((a, b) => order[a.tone] - order[b.tone]);
}
export function relativeDays(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "";
  const d = daysSince(iso, now);
  if (d <= 0) return "hoje";
  if (d === 1) return "ontem";
  return `há ${d} dias`;
}

// ------------------------------------------------------------ compliance
export type Flag = { post: number; field: string; term: string; why: string };
const PROMISES: { re: RegExp; why: string }[] = [
  {
    re: /garantid[oa]s?|garantimos|garantia de/i,
    why: "promessa de resultado",
  },
  {
    re: /renda extra|ganhe dinheiro|ganhar dinheiro|dinheiro f[aá]cil|fique rico|enrique[cç]/i,
    why: "promessa de ganho",
  },
  {
    re: /\bR\$\s?\d[\d.,]*(\s?(mil|k))?/i,
    why: "valor em dinheiro (confira se não é promessa de ganho)",
  },
  {
    re: /\b\d{2,3}\s?%/i,
    why: "percentual (confira se não é promessa de resultado)",
  },
  {
    re: /em (apenas )?\d+ (dias|semanas|meses)/i,
    why: "prazo de resultado",
  },
  {
    re: /sem risco|risco zero|100% (seguro|garantido|eficaz)/i,
    why: "promessa de resultado",
  },
  { re: /\bcura\b|curar|elimina de vez/i, why: "promessa de saúde" },
];
/** Words of promise in any field of the posts, the text asked for the art included. */
export function complianceFlags(posts: PlanPost[]): Flag[] {
  const fields: [keyof PlanPost, string][] = [
    ["gancho", "Gancho"],
    ["direcaoCopy", "Direção de copy"],
    ["direcaoVisual", "Texto pedido para a arte"],
    ["cta", "CTA"],
  ];
  const out: Flag[] = [];
  for (const p of posts)
    for (const [key, label] of fields) {
      const text = String(p[key] ?? "");
      for (const { re, why } of PROMISES) {
        const m = text.match(re);
        if (m) out.push({ post: p.numero, field: label, term: m[0], why });
      }
    }
  return out;
}

// ------------------------------------------------------------ importer
export type ImportResult =
  | {
      ok: true;
      content: PlanContent;
      changes: string[];
      warnings: string[];
      summary: string;
      /** Posts already decided whose content changes (they go back to pending). */
      reopened: number[];
    }
  | { ok: false; error: string };

const POST_FIELDS: { key: keyof PlanPost; label: string }[] = [
  { key: "gancho", label: "gancho" },
  { key: "direcaoCopy", label: "direção de copy" },
  { key: "direcaoVisual", label: "direção visual" },
  { key: "formato", label: "formato" },
  { key: "cta", label: "CTA" },
];
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The partial update returned by the chat (or by "Pedir ajuste à IA"),
 * validated and merged into the plan: what is absent stays; diagnostico,
 * swot and campanha merge field by field; pilares and alertas are replaced;
 * a post whose content changes goes back to pending.
 */
export function parseImport(
  text: string,
  current: PlanContent,
  opened: { clientSlugs: string[]; planId: string; planLabel: string },
): ImportResult {
  const raw = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: "O texto colado não é um JSON válido." };
  }
  if (!isObject(data))
    return { ok: false, error: "O JSON precisa ser um objeto." };
  if (data.tipo !== "social-leads-atualizacao")
    return {
      ok: false,
      error: 'O campo "tipo" precisa ser "social-leads-atualizacao".',
    };
  if (
    typeof data.cliente !== "string" ||
    !opened.clientSlugs.includes(slugify(data.cliente))
  )
    return {
      ok: false,
      error: `Este JSON é de outro cliente (${String(data.cliente ?? "sem cliente")}).`,
    };
  const warnings: string[] = [];
  if (
    data.plano != null &&
    String(data.plano) !== opened.planId &&
    slugify(String(data.plano)) !== slugify(opened.planLabel)
  )
    warnings.push(
      `O JSON fala do plano "${String(data.plano)}", mas o aberto é o ${opened.planLabel}.`,
    );
  const a = data.alteracoes;
  if (!isObject(a))
    return { ok: false, error: 'Faltou o objeto "alteracoes".' };

  const next: PlanContent = JSON.parse(JSON.stringify(current));
  const changes: string[] = [];
  const reopened: number[] = [];

  if (a.posts != null) {
    if (!Array.isArray(a.posts))
      return { ok: false, error: '"posts" precisa ser uma lista.' };
    if (a.posts.length > 8)
      return { ok: false, error: "Mais de 8 posts no JSON." };
    const seen = new Set<number>();
    for (const item of a.posts) {
      if (!isObject(item))
        return { ok: false, error: "Post inválido no JSON." };
      const n = Number(item.numero);
      if (!Number.isInteger(n) || n < 1 || n > 8)
        return {
          ok: false,
          error: `Número de post fora de 1 a 8: ${String(item.numero)}.`,
        };
      if (seen.has(n))
        return { ok: false, error: `Post ${n} repetido no JSON.` };
      seen.add(n);
      const post = next.posts.find((p) => p.numero === n);
      if (!post)
        return { ok: false, error: `O post ${n} não existe neste plano.` };
      const what: string[] = [];
      if (item.badge != null) {
        if (!(String(item.badge) in pillars))
          return {
            ok: false,
            error: `Pilar do post ${n} inválido: use posicionar, autoridade ou oferta.`,
          };
        if (item.badge !== post.badge) {
          post.badge = item.badge as Pillar;
          what.push("pilar");
        }
      }
      for (const f of POST_FIELDS) {
        if (item[f.key] == null) continue;
        const value = String(item[f.key]).trim();
        if (!value)
          return {
            ok: false,
            error: `O ${f.label} do post ${n} ficaria vazio.`,
          };
        if (value !== post[f.key]) {
          (post as unknown as Record<string, unknown>)[f.key] = value;
          what.push(f.label);
        }
      }
      if (
        item.ehAnuncio != null &&
        Boolean(item.ehAnuncio) !== post.ehAnuncio
      ) {
        post.ehAnuncio = Boolean(item.ehAnuncio);
        what.push(
          post.ehAnuncio ? "passa a ser o anúncio" : "deixa de ser o anúncio",
        );
      }
      if (what.length) {
        changes.push(`Post ${n}: ${what.join(", ")}`);
        if (post.status && post.status !== "pendente") reopened.push(n);
        post.status = "pendente";
        post.observacao = "";
      }
    }
  }
  const merge = (key: "diagnostico" | "swot" | "campanha", label: string) => {
    const part = a[key];
    if (part == null) return null;
    if (!isObject(part)) return `"${key}" precisa ser um objeto.`;
    const target = next[key] as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(part)) {
      if (!(k in target)) return `Campo desconhecido em ${key}: ${k}.`;
      const value = Array.isArray(v) ? v.map(String) : String(v ?? "").trim();
      if (JSON.stringify(value) !== JSON.stringify(target[k])) {
        target[k] = value;
        changes.push(`${label}: ${k}`);
      }
    }
    return null;
  };
  for (const [key, label] of [
    ["diagnostico", "Diagnóstico"],
    ["swot", "SWOT"],
    ["campanha", "Campanha"],
  ] as const) {
    const err = merge(key, label);
    if (err) return { ok: false, error: err };
  }
  if (a.pilares != null) {
    if (!Array.isArray(a.pilares) || a.pilares.length !== 4)
      return { ok: false, error: "Os pilares precisam ser exatamente 4." };
    const list = a.pilares.map((p) => ({
      titulo: String(isObject(p) ? (p.titulo ?? "") : "").trim(),
      descricao: String(isObject(p) ? (p.descricao ?? "") : "").trim(),
    }));
    if (list.some((p) => !p.titulo || !p.descricao))
      return { ok: false, error: "Todo pilar precisa de título e descrição." };
    if (JSON.stringify(list) !== JSON.stringify(next.pilares)) {
      next.pilares = list;
      changes.push("Pilares substituídos");
    }
  }
  if (a.alertas != null) {
    if (!Array.isArray(a.alertas))
      return { ok: false, error: '"alertas" precisa ser uma lista.' };
    const list = a.alertas.map((x) => String(x).trim()).filter(Boolean);
    if (JSON.stringify(list) !== JSON.stringify(next.alertas)) {
      next.alertas = list;
      changes.push("Alertas substituídos");
    }
  }
  if (a.publico != null) {
    const v = String(a.publico).trim();
    if (!v) return { ok: false, error: "O público ficaria vazio." };
    if (v !== next.publico) {
      next.publico = v;
      changes.push("Público");
    }
  }
  const ads = next.posts.filter((p) => p.ehAnuncio).length;
  if (ads !== 1)
    return {
      ok: false,
      error: `O plano precisa terminar com exatamente um post que vira anúncio (ficaria com ${ads}).`,
    };
  if (!changes.length) warnings.push("Nada muda no plano com este JSON.");
  if (reopened.length)
    warnings.push(
      `Já avaliados que voltam a pendente: ${reopened.map((n) => `post ${n}`).join(", ")}.`,
    );
  return {
    ok: true,
    content: next,
    changes,
    warnings,
    reopened,
    summary: typeof data.resumo === "string" ? data.resumo.trim() : "",
  };
}

/** A manual edit of one post, as the importer's change list. */
export function editPost(
  current: PlanContent,
  number: number,
  patch: Partial<PlanPost>,
): PlanContent {
  const next: PlanContent = JSON.parse(JSON.stringify(current));
  for (const p of next.posts) {
    if (p.numero === number) Object.assign(p, patch);
    else if (patch.ehAnuncio) p.ehAnuncio = false;
  }
  return next;
}

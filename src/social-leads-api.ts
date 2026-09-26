import { useEffect, useRef } from "react";
import { supabase } from "./supabase";
import { invalidateLookupsCache, rpc } from "./api";
import {
  createDriveFolder,
  deleteDriveFile,
  driveViewUrl,
  uploadDriveFile,
} from "./drive";
import type { Snapshot } from "./types";
import {
  fullContent,
  type BriefingFields,
  type BriefingMedia,
  type MediaFile,
  type SlUsage,
  type CampaignObjective,
  type Decision,
  type PlanContent,
  type Portfolio,
  type PortfolioItem,
  type SlBriefing,
  type SlJob,
  type SlPlan,
  type SlPost,
  type SlRevision,
} from "./social-leads";

/**
 * Onboarding › Social Leads: the calls the page makes. Reads go straight to
 * the tables (RLS); writes go through the database functions of migration
 * 20261013090000_social_leads, and the AI through /api/social-leads. The demo
 * keeps everything in memory, with a sample plan instead of the AI.
 */
export interface PlanBundle {
  plan: SlPlan;
  posts: SlPost[];
  revisions: SlRevision[];
  /** What the AI cost on this plan (generations and adjustments). */
  usage: SlUsage[];
}
/** The palette the AI read from the site or Instagram. */
export interface BrandColorsFound {
  colors: { hex: string; name: string }[];
  note: string;
  warnings: string[];
  cost_usd: number;
}
/** The Drive folder, under the Social Leads product, that holds the briefing's files. */
export const BRIEFING_FOLDER = "Briefing Social Leads";
export interface ContractBundle {
  briefing: SlBriefing | null;
  plans: SlPlan[];
  job: SlJob | null;
}
/** A client to put in the portfolio: one already registered, or a new one. */
export type NewSocialLeadsClient =
  { client: string; name?: undefined } | { client?: undefined; name: string };
export interface SocialLeadsBackend {
  portfolio(company: string): Promise<Portfolio>;
  /** Adds the Social Leads product to a client (creating the client if new). */
  addClient(
    company: string,
    who: NewSocialLeadsClient,
    product: { id: string; name: string },
    team: string | null,
    clientName: string,
  ): Promise<string>;
  setSettings(
    company: string,
    product: string,
    team: string | null,
  ): Promise<void>;
  contract(company: string, contract: string): Promise<ContractBundle>;
  plan(plan: string): Promise<PlanBundle>;
  saveBriefing(
    company: string,
    contract: string,
    fields: BriefingFields,
    objective: CampaignObjective | null,
    responsible: string | null,
    version: number | null,
    /** Null keeps the files as they are. */
    media?: BriefingMedia | null,
  ): Promise<number>;
  /** Sends a file to the client's Drive (folder BRIEFING_FOLDER). */
  uploadMedia(
    company: string,
    contract: string,
    file: File,
    onProgress: (fraction: number) => void,
  ): Promise<MediaFile>;
  /** A short-lived address that shows the file. */
  mediaUrl(file: MediaFile): Promise<string>;
  deleteMedia(file: MediaFile): Promise<void>;
  brandColors(
    company: string,
    contract: string,
    from: { website?: string; instagram?: string },
  ): Promise<BrandColorsFound>;
  writePlan(
    company: string,
    contract: string,
    plan: string,
    content: PlanContent,
    reason: string,
    version: number,
    source: "import" | "manual" | "ai",
    summary: string,
  ): Promise<{ id: string; version: number }>;
  restore(revision: string, version: number): Promise<void>;
  decide(
    plan: string,
    number: number,
    decision: Decision,
    note: string,
  ): Promise<void>;
  share(
    plan: string,
    enabled: boolean,
    newLink?: boolean,
  ): Promise<{
    share_enabled: boolean;
    share_token: string;
    shared_at: string | null;
  }>;
  generate(
    company: string,
    contract: string,
    mode: "new" | "current",
    plan?: string,
  ): Promise<void>;
  adjust(
    company: string,
    contract: string,
    plan: string,
    instruction: string,
  ): Promise<{ update: unknown; cost_usd: number }>;
  /** The demo's stand-in for the client link (the real one needs the database). */
  link?: LinkSource;
}
/** Where the client link page reads the plan and sends the decisions. */
export type LinkSource = {
  load(token: string): Promise<SharedPlan>;
  decide(
    token: string,
    number: number,
    decision: "approved" | "rejected",
    note: string,
  ): Promise<void>;
};

async function server<T>(body: Record<string, unknown>): Promise<T> {
  const token = supabase
    ? (await supabase.auth.getSession()).data.session?.access_token
    : undefined;
  if (!token) throw new Error("Entre novamente para usar a IA.");
  const res = await fetch("/api/social-leads", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(data.error ?? "Não foi possível falar com a IA.");
  return data as T;
}
function db() {
  if (!supabase) throw new Error("Supabase não configurado");
  return supabase;
}
const PLAN_COLUMNS =
  "id,company_id,contract_id,month_number,label,content,summary,source,share_enabled,shared_at,version,created_by,updated_by,created_at,updated_at";

export const serverSocialLeads: SocialLeadsBackend = {
  async portfolio(company) {
    return (await rpc("social_leads_portfolio", {
      p_company: company,
    })) as Portfolio;
  },
  async addClient(company, who, product, team, clientName) {
    const client =
      who.client ??
      ((await rpc("create_client", {
        p_company: company,
        p_name: who.name.trim(),
        p_email: "",
        p_teams: team ? [team] : null,
      })) as string);
    const contract = (await rpc("create_contract", {
      p_company: company,
      p_client: client,
      p_product: product.id,
      p_name: `${product.name} · ${clientName.trim()}`,
      p_team: team,
    })) as string;
    // Clientes and Produtos show the new contract too.
    invalidateLookupsCache(company);
    return contract;
  },
  async setSettings(company, product, team) {
    await rpc("set_social_leads_settings", {
      p_company: company,
      p_product: product,
      p_team: team,
    });
  },
  async contract(company, contract) {
    const [b, p, j] = await Promise.all([
      db()
        .from("social_leads_briefings")
        .select("*")
        .eq("company_id", company)
        .eq("contract_id", contract)
        .maybeSingle(),
      db()
        .from("social_leads_plans")
        .select(PLAN_COLUMNS)
        .eq("company_id", company)
        .eq("contract_id", contract)
        .order("month_number"),
      db()
        .from("social_leads_jobs")
        .select("*")
        .eq("company_id", company)
        .eq("contract_id", contract)
        .order("created_at", { ascending: false })
        .limit(1),
    ]);
    for (const r of [b, p, j]) if (r.error) throw r.error;
    return {
      briefing: (b.data as SlBriefing | null) ?? null,
      plans: (p.data ?? []) as SlPlan[],
      job: ((j.data ?? [])[0] as SlJob | undefined) ?? null,
    };
  },
  async plan(plan) {
    const [p, x, r, u] = await Promise.all([
      db()
        .from("social_leads_plans")
        .select(PLAN_COLUMNS)
        .eq("id", plan)
        .single(),
      db()
        .from("social_leads_posts")
        .select("*")
        .eq("plan_id", plan)
        .order("number"),
      db()
        .from("social_leads_revisions")
        .select("*")
        .eq("plan_id", plan)
        .order("number", { ascending: false })
        .limit(50),
      db()
        .from("social_leads_ai_usage")
        .select(
          "kind,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd,created_at,created_by",
        )
        .eq("plan_id", plan)
        .order("created_at")
        .limit(500),
    ]);
    for (const q of [p, x, r]) if (q.error) throw q.error;
    return {
      plan: p.data as unknown as SlPlan,
      posts: (x.data ?? []) as SlPost[],
      revisions: (r.data ?? []) as SlRevision[],
      // The cost is a detail: without it (e.g. migration not applied yet) the plan still opens.
      usage: u.error ? [] : ((u.data ?? []) as SlUsage[]),
    };
  },
  async saveBriefing(
    company,
    contract,
    fields,
    objective,
    responsible,
    version,
    media,
  ) {
    return (await rpc("save_social_leads_briefing", {
      p_company: company,
      p_contract: contract,
      p_fields: fields,
      p_objective: objective,
      p_responsible: responsible,
      p_version: version,
      ...(media ? { p_media: media } : {}),
    })) as number;
  },
  async uploadMedia(company, contract, file, onProgress) {
    const found = await db()
      .from("drive_folders")
      .select("id")
      .eq("company_id", company)
      .eq("contract_id", contract)
      .is("parent_id", null)
      .eq("name", BRIEFING_FOLDER)
      .limit(1);
    if (found.error) throw found.error;
    const folder =
      found.data?.[0]?.id ??
      (await createDriveFolder(company, BRIEFING_FOLDER, { contract }));
    const id = await uploadDriveFile(
      company,
      { folder },
      file,
      "private",
      onProgress,
    );
    return {
      id,
      name: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
    };
  },
  mediaUrl: (file) => driveViewUrl(file.id),
  async deleteMedia(file) {
    await deleteDriveFile(file.id);
  },
  async brandColors(company, contract, from) {
    return await server<BrandColorsFound>({
      action: "colors",
      company,
      contract,
      website: from.website ?? null,
      instagram: from.instagram ?? null,
    });
  },
  async writePlan(
    company,
    contract,
    plan,
    content,
    reason,
    version,
    source,
    summary,
  ) {
    return (await rpc("social_leads_write_plan", {
      p_company: company,
      p_contract: contract,
      p_plan: plan,
      p_content: content,
      p_reason: reason,
      p_version: version,
      p_source: source,
      p_summary: summary || null,
    })) as { id: string; version: number };
  },
  async restore(revision, version) {
    await rpc("social_leads_restore", {
      p_revision: revision,
      p_version: version,
    });
  },
  async decide(plan, number, decision, note) {
    await rpc("social_leads_decide", {
      p_plan: plan,
      p_number: number,
      p_decision: decision,
      p_note: note,
    });
  },
  async share(plan, enabled, newLink = false) {
    return (await rpc("social_leads_share", {
      p_plan: plan,
      p_enabled: enabled,
      p_new_link: newLink,
    })) as {
      share_enabled: boolean;
      share_token: string;
      shared_at: string | null;
    };
  },
  async generate(company, contract, mode, plan) {
    await server({
      action: "generate",
      company,
      contract,
      mode,
      plan: plan ?? null,
    });
  },
  async adjust(company, contract, plan, instruction) {
    return await server<{ update: unknown; cost_usd: number }>({
      action: "adjust",
      company,
      contract,
      plan,
      instruction,
    });
  },
};

/** Reloads when the database announces a change of this client (or any). */
export function useLiveSocialLeads(
  contract: string | null,
  reload: () => void,
) {
  const ref = useRef(reload);
  ref.current = reload;
  useEffect(() => {
    let timer = 0;
    const on = (e: Event) => {
      const detail = (e as CustomEvent<{ contract?: string }>).detail ?? {};
      if (contract && detail.contract && detail.contract !== contract) return;
      // A write touches several rows: one reload for the burst.
      window.clearTimeout(timer);
      timer = window.setTimeout(() => ref.current(), 350);
    };
    window.addEventListener("mavi:social-leads", on);
    return () => {
      window.removeEventListener("mavi:social-leads", on);
      window.clearTimeout(timer);
    };
  }, [contract]);
}

// ------------------------------------------------------------ client link
export interface SharedPlan {
  company: string;
  company_logo: string | null;
  client: string;
  label: string;
  month_number: number;
  created_at: string;
  responsible: string | null;
  diagnostico: { negocio: string; comoQuerSerVista: string };
  pilares: { titulo: string; descricao: string }[];
  publico: string;
  campanha: { objetivo: string; regiao: string; idadeGenero: string };
  posts: {
    numero: number;
    badge: SlPost["pillar"];
    gancho: string;
    direcaoCopy: string;
    direcaoVisual: string;
    formato: string;
    cta: string;
    ehAnuncio: boolean;
    decision: Decision;
    note: string;
    decided_at: string | null;
    decided_via: "link" | "team" | null;
  }[];
}
export async function sharedPlan(token: string): Promise<SharedPlan> {
  return (await rpc("social_leads_shared_plan", {
    p_token: token,
  })) as SharedPlan;
}
export async function clientDecide(
  token: string,
  number: number,
  decision: "approved" | "rejected",
  note: string,
) {
  await rpc("social_leads_client_decide", {
    p_token: token,
    p_number: number,
    p_decision: decision,
    p_note: note,
  });
}
export const serverLink: LinkSource = {
  load: sharedPlan,
  decide: clientDecide,
};
export function shareUrl(token: string) {
  return `${window.location.origin}/aprovacao/${token}`;
}

// ------------------------------------------------------------ demo
const now = () => new Date().toISOString();
const id = () => `demo-${Math.random().toString(36).slice(2, 10)}`;
type DemoState = {
  settings: { product: string; team: string | null } | null;
  briefings: Record<string, SlBriefing>;
  plans: SlPlan[];
  posts: SlPost[];
  revisions: SlRevision[];
  jobs: Record<string, SlJob>;
  tokens: Record<string, string>;
  usage: (SlUsage & { plan_id: string })[];
  /** Files "uploaded" in the demo: object URLs in this tab. */
  files: Record<string, string>;
};
let demoState: DemoState | null = null;

/** A plausible plan for the demonstration (the real one comes from the AI). */
export function samplePlan(client: string, month: number): PlanContent {
  const hooks = [
    `Quem está por trás da ${client}`,
    "3 perguntas que todo cliente faz antes de decidir",
    "Um dia com a nossa equipe",
    `Conheça a ${client} de perto`,
    "O erro mais comum de quem está começando",
    "Como funciona o primeiro atendimento",
    "Mito ou verdade?",
    "Bastidores do mês",
  ];
  return {
    diagnostico: {
      negocio: `${client} atende o público local com atendimento próximo e quer ser lembrada como referência no bairro.`,
      comoQuerSerVista: "Próxima, confiável e especialista no que faz.",
    },
    swot: {
      forcas: "Atendimento próximo, equipe experiente.",
      fraquezas: "Pouca presença digital até agora.",
      oportunidades: "Concorrentes quase não publicam conteúdo educativo.",
      ameacas: "Preço mais alto que a média da região.",
    },
    pilares: [
      { titulo: "Bastidores", descricao: "Mostrar quem faz e como faz." },
      {
        titulo: "Educação",
        descricao: "Responder as dúvidas reais do público.",
      },
      {
        titulo: "Prova",
        descricao:
          "Situações verídicas do dia a dia, sem depoimento inventado.",
      },
      { titulo: "Convite", descricao: "Chamar para conhecer a oferta do mês." },
    ],
    publico:
      "Moradores da região, 25 a 55 anos, que valorizam atendimento próximo.",
    campanha: {
      objetivo: "Conversas no WhatsApp",
      regiao: "Raio de 5 km do endereço",
      idadeGenero: "25 a 55 anos, todos os gêneros",
      segmentacao: "Interesses ligados ao serviço, sem atributos sensíveis",
      posicionamentos: "Advantage+ (Feeds, Stories, Reels)",
      orcamento: "R$ 500/mês",
      perguntasFormulario: [],
      roteamentoLead: "WhatsApp do atendimento",
    },
    alertas: [
      "Sem depoimentos reais ainda: captar autorizações de clientes neste mês.",
    ],
    posts: hooks.map((gancho, i) => ({
      numero: i + 1,
      badge: (["posicionar", "autoridade", "oferta"] as const)[i % 3],
      gancho: month > 1 ? `${gancho} (mês ${month})` : gancho,
      direcaoCopy: "Texto curto, tom acolhedor, uma ideia por post.",
      direcaoVisual: "Foto real da equipe, cores da marca, sem texto na arte.",
      formato: i % 2 ? "Carrossel" : "Reels",
      cta: i === 3 ? "Chamar no WhatsApp" : "Seguir a página",
      ehAnuncio: i === 3,
    })),
  };
}

export function demoSocialLeads(
  data: Snapshot,
  user: string,
): SocialLeadsBackend {
  const product = data.products.find((p) => /social leads/i.test(p.name));
  if (!demoState)
    demoState = {
      settings: product
        ? { product: product.id, team: data.teams[0]?.id ?? null }
        : null,
      briefings: {},
      plans: [],
      posts: [],
      revisions: [],
      jobs: {},
      tokens: {},
      usage: [],
      files: {},
    };
  const s = demoState;
  const spend = (plan: string, kind: SlUsage["kind"], cost: number) =>
    s.usage.push({
      plan_id: plan,
      kind,
      model: "claude-opus-5",
      input_tokens: Math.round(cost * 90_000),
      output_tokens: Math.round(cost * 22_000),
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: cost,
      created_at: now(),
      created_by: user,
    });
  const emit = () =>
    window.dispatchEvent(new CustomEvent("mavi:social-leads", { detail: {} }));
  const contractOf = (k: string) => data.contracts.find((c) => c.id === k)!;
  const clientOf = (k: string) =>
    data.clients.find((c) => c.id === contractOf(k).client_id)!;
  const putPlan = (contract: string, content: PlanContent, planId?: string) => {
    const existing = planId ? s.plans.find((p) => p.id === planId) : undefined;
    const { posts, ...rest } = content;
    let plan: SlPlan;
    if (existing) {
      s.revisions.push({
        id: id(),
        plan_id: existing.id,
        number: s.revisions.filter((r) => r.plan_id === existing.id).length + 1,
        reason: "regeneração do mês",
        content: fullContent(
          existing,
          s.posts.filter((x) => x.plan_id === existing.id),
        ),
        created_by: user,
        created_at: now(),
      });
      Object.assign(existing, {
        content: rest,
        version: existing.version + 1,
        updated_at: now(),
      });
      plan = existing;
      s.posts = s.posts.filter((x) => x.plan_id !== existing.id);
    } else {
      const n = s.plans.filter((p) => p.contract_id === contract).length + 1;
      plan = {
        id: id(),
        company_id: contractOf(contract).company_id,
        contract_id: contract,
        month_number: n,
        label: `Mês ${n}`,
        content: rest,
        summary: "",
        source: "ai",
        share_enabled: false,
        shared_at: null,
        version: 1,
        created_by: user,
        updated_by: user,
        created_at: now(),
        updated_at: now(),
      };
      s.plans.push(plan);
      s.tokens[plan.id] = id();
    }
    for (const p of posts)
      s.posts.push({
        plan_id: plan.id,
        number: p.numero,
        pillar: p.badge,
        hook: p.gancho,
        copy_direction: p.direcaoCopy,
        visual_direction: p.direcaoVisual,
        format: p.formato,
        cta: p.cta,
        is_ad: p.ehAnuncio,
        decision:
          p.status === "aprovado"
            ? "approved"
            : p.status === "reprovado"
              ? "rejected"
              : "pending",
        note: p.observacao ?? "",
        decided_via: p.status && p.status !== "pendente" ? "team" : null,
        decided_by: null,
        decided_at: p.status && p.status !== "pendente" ? now() : null,
        updated_at: now(),
      });
    return plan;
  };
  return {
    async portfolio() {
      if (!s.settings) return { configured: false, items: [] };
      const items: PortfolioItem[] = data.contracts
        .filter((k) => k.product_id === s.settings!.product && !k.archived)
        .map((k) => {
          const cl = data.clients.find((c) => c.id === k.client_id)!;
          const plans = s.plans.filter((p) => p.contract_id === k.id);
          const last = plans.at(-1);
          const posts = last
            ? s.posts.filter((x) => x.plan_id === last.id)
            : [];
          const b = s.briefings[k.id];
          return {
            contract_id: k.id,
            contract_name: k.name,
            client_id: cl.id,
            client_name: cl.name,
            client_color: cl.color,
            contract_created_at: now(),
            can_write: true,
            briefing: b
              ? {
                  fields: b.fields,
                  campaign_objective: b.campaign_objective,
                  responsible_id: b.responsible_id,
                  updated_at: b.updated_at,
                }
              : null,
            plan_count: plans.length,
            plan: last
              ? {
                  id: last.id,
                  month_number: last.month_number,
                  label: last.label,
                  created_at: last.created_at,
                  updated_at: last.updated_at,
                  share_enabled: last.share_enabled,
                  shared_at: last.shared_at,
                  alerts: last.content.alertas.length,
                  first_alert: last.content.alertas[0] ?? null,
                  approved: posts.filter((x) => x.decision === "approved")
                    .length,
                  rejected: posts.filter((x) => x.decision === "rejected")
                    .length,
                  last_decision_at:
                    posts
                      .map((x) => x.decided_at)
                      .filter(Boolean)
                      .sort()
                      .at(-1) ?? null,
                }
              : null,
            job: s.jobs[k.id] ?? null,
          };
        })
        .sort((a, b) => a.client_name.localeCompare(b.client_name));
      return {
        configured: true,
        product_id: s.settings.product,
        team_id: s.settings.team,
        items,
      };
    },
    async addClient(company, who, product, _team, clientName) {
      let client = who.client;
      if (!client) {
        client = id();
        data.clients.push({
          id: client,
          company_id: company,
          name: clientName.trim(),
          email: "",
          color: "#8576cf",
          archived: false,
        });
      }
      const contract = id();
      data.contracts.push({
        id: contract,
        company_id: company,
        client_id: client,
        product_id: product.id,
        name: `${product.name} · ${clientName.trim()}`,
        archived: false,
      });
      emit();
      return contract;
    },
    async setSettings(_c, productId, team) {
      s.settings = { product: productId, team };
      emit();
    },
    async contract(_c, contract) {
      return {
        briefing: s.briefings[contract] ?? null,
        plans: s.plans.filter((p) => p.contract_id === contract),
        job: s.jobs[contract] ?? null,
      };
    },
    async plan(planId) {
      const plan = s.plans.find((p) => p.id === planId);
      if (!plan) throw new Error("Plano não encontrado.");
      return {
        plan,
        posts: s.posts
          .filter((x) => x.plan_id === planId)
          .sort((a, b) => a.number - b.number),
        revisions: s.revisions
          .filter((r) => r.plan_id === planId)
          .sort((a, b) => b.number - a.number),
        usage: s.usage.filter((u) => u.plan_id === planId),
      };
    },
    async saveBriefing(
      _c,
      contract,
      fields,
      objective,
      responsible,
      version,
      media,
    ) {
      const b = s.briefings[contract];
      if (b && version !== b.version)
        throw new Error(
          "Outra pessoa salvou este briefing antes. Recarregue para ver a versão atual.",
        );
      const next = (b?.version ?? 0) + 1;
      s.briefings[contract] = {
        fields,
        campaign_objective: objective,
        responsible_id: responsible,
        version: next,
        updated_at: now(),
        updated_by: user,
        media: media ?? b?.media ?? {},
      };
      emit();
      return next;
    },
    async uploadMedia(_c, _k, file, onProgress) {
      const fileId = id();
      for (const f of [0.3, 0.7, 1]) {
        await new Promise((r) => setTimeout(r, 150));
        onProgress(f);
      }
      s.files[fileId] = URL.createObjectURL(file);
      return { id: fileId, name: file.name, type: file.type, size: file.size };
    },
    async mediaUrl(file) {
      return s.files[file.id] ?? "";
    },
    async deleteMedia(file) {
      if (s.files[file.id]) URL.revokeObjectURL(s.files[file.id]);
      delete s.files[file.id];
    },
    async brandColors() {
      await new Promise((r) => setTimeout(r, 1200));
      return {
        colors: [
          { hex: "#1c2728", name: "Verde-escuro" },
          { hex: "#c8ed8d", name: "Verde-limão" },
          { hex: "#f6f7f8", name: "Gelo" },
        ],
        note: "Demonstração: cores de exemplo, sem ler o site.",
        warnings: [],
        cost_usd: 0.004,
      };
    },
    async writePlan(_c, contract, planId, content, _reason, version) {
      const plan = s.plans.find((p) => p.id === planId)!;
      if (plan.version !== version)
        throw new Error(
          "O plano mudou desde que você o abriu. Recarregue para ver a versão atual.",
        );
      const before = s.posts.filter((x) => x.plan_id === planId);
      const kept = content.posts.map((p) => {
        const o = before.find((x) => x.number === p.numero)!;
        const same =
          o.hook === p.gancho &&
          o.copy_direction === p.direcaoCopy &&
          o.visual_direction === p.direcaoVisual &&
          o.format === p.formato &&
          o.cta === p.cta &&
          o.pillar === p.badge &&
          o.is_ad === p.ehAnuncio;
        return same
          ? {
              ...p,
              status: (o.decision === "approved"
                ? "aprovado"
                : o.decision === "rejected"
                  ? "reprovado"
                  : "pendente") as PlanContent["posts"][number]["status"],
              observacao: o.note,
            }
          : { ...p, status: "pendente" as const, observacao: "" };
      });
      putPlan(contract, { ...content, posts: kept }, planId);
      emit();
      return { id: planId, version: plan.version };
    },
    async restore(revision) {
      const r = s.revisions.find((x) => x.id === revision)!;
      const plan = s.plans.find((p) => p.id === r.plan_id)!;
      putPlan(plan.contract_id, r.content, plan.id);
      emit();
    },
    async decide(planId, number, decision, note) {
      const p = s.posts.find(
        (x) => x.plan_id === planId && x.number === number,
      )!;
      Object.assign(p, {
        decision,
        note,
        decided_via: decision === "pending" ? null : "team",
        decided_at: decision === "pending" ? null : now(),
        decided_by: decision === "pending" ? null : user,
      });
      emit();
    },
    async share(planId, enabled, newLink) {
      const plan = s.plans.find((p) => p.id === planId)!;
      if (enabled && !plan.share_enabled) plan.shared_at = now();
      plan.share_enabled = enabled;
      if (newLink) s.tokens[planId] = id();
      emit();
      return {
        share_enabled: plan.share_enabled,
        share_token: s.tokens[planId],
        shared_at: plan.shared_at,
      };
    },
    async generate(_c, contract, mode, planId) {
      if (!s.briefings[contract])
        throw new Error("Preencha o briefing antes de gerar o plano.");
      const job: SlJob = {
        id: id(),
        kind: mode,
        status: "running",
        error: null,
        created_at: now(),
        finished_at: null,
      };
      s.jobs[contract] = job;
      emit();
      window.setTimeout(() => {
        const client =
          s.briefings[contract]?.fields.clientName || clientOf(contract).name;
        const n =
          s.plans.filter((p) => p.contract_id === contract).length +
          (mode === "new" ? 1 : 0);
        const plan = putPlan(
          contract,
          samplePlan(client, n),
          mode === "current" ? planId : undefined,
        );
        Object.assign(job, {
          status: "done",
          finished_at: now(),
          plan_id: plan.id,
        });
        spend(plan.id, "generate", 0.38);
        emit();
      }, 1800);
    },
    link: {
      async load(token) {
        const planId = Object.keys(s.tokens).find((k) => s.tokens[k] === token);
        const plan = s.plans.find((p) => p.id === planId && p.share_enabled);
        if (!plan) throw new Error("Link inválido ou desativado.");
        const b = s.briefings[plan.contract_id];
        return {
          company: data.companies[0]?.name ?? "",
          company_logo: data.companies[0]?.logo_url ?? null,
          client: b?.fields.clientName || clientOf(plan.contract_id).name,
          label: plan.label,
          month_number: plan.month_number,
          created_at: plan.created_at,
          responsible:
            data.members.find((m) => m.user_id === b?.responsible_id)?.name ??
            null,
          diagnostico: plan.content.diagnostico,
          pilares: plan.content.pilares,
          publico: plan.content.publico,
          campanha: plan.content.campanha,
          posts: s.posts
            .filter((x) => x.plan_id === plan.id)
            .sort((a, z) => a.number - z.number)
            .map((x) => ({
              numero: x.number,
              badge: x.pillar,
              gancho: x.hook,
              direcaoCopy: x.copy_direction,
              direcaoVisual: x.visual_direction,
              formato: x.format,
              cta: x.cta,
              ehAnuncio: x.is_ad,
              decision: x.decision,
              note: x.note,
              decided_at: x.decided_at,
              decided_via: x.decided_via,
            })),
        };
      },
      async decide(token, number, decision, note) {
        const planId = Object.keys(s.tokens).find((k) => s.tokens[k] === token);
        const p = s.posts.find(
          (x) => x.plan_id === planId && x.number === number,
        );
        if (!p) throw new Error("Link inválido ou desativado.");
        if (decision === "rejected" && !note.trim())
          throw new Error("Conte o que você quer ajustar neste post.");
        Object.assign(p, {
          decision,
          note: note.trim(),
          decided_via: "link",
          decided_by: null,
          decided_at: now(),
        });
        emit();
      },
    },
    async adjust(_c, contract, planId, instruction) {
      const client =
        s.briefings[contract]?.fields.clientName || clientOf(contract).name;
      const post = Number(instruction.match(/post\s*(\d)/i)?.[1] ?? 1);
      await new Promise((r) => setTimeout(r, 900));
      spend(planId, "adjust", 0.03);
      const update = {
        tipo: "social-leads-atualizacao",
        cliente: client,
        plano: planId,
        resumo: `Ajuste pedido: ${instruction}`,
        alteracoes: {
          posts: [
            {
              numero: post,
              gancho: `${s.posts.find((x) => x.plan_id === planId && x.number === post)?.hook ?? ""} (versão mais leve)`,
            },
          ],
        },
      };
      return { update, cost_usd: 0.03 };
    },
  };
}

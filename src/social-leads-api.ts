import { useEffect, useRef } from "react";
import { supabase } from "./supabase";
import { invalidateLookupsCache, rpc } from "./api";
import {
  createDriveFolder,
  deleteDriveFile,
  driveViewUrl,
  publicFolderUrl,
  uploadDriveFile,
} from "./drive";
import type { Snapshot } from "./types";
import { SL_MODULES, type SlModule } from "./social-leads-module";
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
  type SlTask,
  type SlPostEvent,
  postEventsFor,
  clampPosts,
  slidesRichText,
  POSTS_DEFAULT,
  type BriefingSuggestion,
  type SlAlertRead,
  type SmSchedule,
  type SmScheduleDraft,
  type SmDestination,
  SM_TIME_ZONE,
} from "./social-leads";

/**
 * Planejamento › Social Leads and Social Media (the same module, each with
 * its product: the calls that start from the company take the module).
 * The calls the page makes. Reads go straight to
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
  /** The art tasks of the posts (production). */
  tasks: SlTask[];
  /** Each post's history: decisions, notes, edits, arts, comments. */
  events: SlPostEvent[];
  /** The alerts marked as read (who and when). */
  alertReads: SlAlertRead[];
  /** Social Media › Agendamento: each scheduled post. */
  schedules?: SmSchedule[];
  /** Whether the client link shows the calendar (on by default). */
  linkCalendar?: boolean;
}
/** The MAVI's suggestion of dates (api/_social-leads.ts, "schedule"). */
export interface ScheduleSuggestion {
  posts: {
    numero: number;
    /** "AAAA-MM-DDTHH:MM" in the company's time zone. */
    at: string;
    destinations: SmDestination[];
    reason: string;
  }[];
  summary: string;
  timezone: string;
  cost_usd: number;
}
/** The client's social proof folder in the Drive, with its public link. */
export interface ProofFolder {
  id: string;
  name: string;
  /** The link the client opens to send files (null when off). */
  url: string | null;
  upload: boolean;
  files: MediaFile[];
}
/** Who receives each post's art task: a team (distributed) or a person. */
export type ReleaseTarget = { team: string } | { user: string };
export type ReleaseAssign = Record<number, ReleaseTarget>;
/** Who gets the client's cycle tasks (only on the release that opens it). */
export type ReleaseCycle = { followup: string; meeting: string };
/** A meeting of the client in "Gravações da MAVI". */
export interface MeetingOption {
  id: string;
  /** The recording's AI summary title, else the meeting's ('' when none). */
  title: string;
  overview?: string;
  speakers?: string[];
  recorded_at: string;
  duration_seconds: number | null;
  has_transcript: boolean;
}
/** The palette the AI read from the site or Instagram. */
export interface BrandColorsFound {
  colors: { hex: string; name: string }[];
  note: string;
  warnings: string[];
  cost_usd: number;
}
/** The Drive folder, under the Social Leads product, that holds the briefing's files. */
export const BRIEFING_FOLDER = SL_MODULES.social_leads.briefingFolder;
export interface ContractBundle {
  briefing: SlBriefing | null;
  plans: SlPlan[];
  job: SlJob | null;
}
/** A client to put in the portfolio: one already registered. */
export type NewSocialLeadsClient = { client: string };
/** A client the person may put in the portfolio (social_leads_addable_clients). */
export interface AddableClient {
  id: string;
  name: string;
  color: string;
  /** It had Social Leads before (archived): it comes back with its history. */
  archived_contract: string | null;
  /**
   * It has Social Leads already, but no team of the person serves it (so it
   * isn't in their portfolio): adding makes the squad serve it.
   */
  hidden_contract?: string | null;
}
export interface SocialLeadsBackend {
  portfolio(company: string, module?: SlModule): Promise<Portfolio>;
  /**
   * Adds the Social Leads product to a registered client (an archived one
   * comes back with its history). Anyone active may, for the clients a team
   * of theirs serves (the squad: any); the squad starts serving the client.
   */
  addClient(
    company: string,
    who: NewSocialLeadsClient,
    product: { id: string; name: string },
    team: string | null,
    clientName: string,
    module?: SlModule,
  ): Promise<string>;
  /** The clients the person may add, read fresh from the database. */
  addableClients(company: string, module?: SlModule): Promise<AddableClient[]>;
  /** Takes the client out of the portfolio (history kept), or back. */
  archive(company: string, contract: string, archived: boolean): Promise<void>;
  /** Removes for good a client added by mistake (no plan, task or file). */
  remove(company: string, contract: string): Promise<void>;
  /** Marks (or unmarks) an alert of the plan as read. */
  markAlert(
    plan: string,
    text: string,
    kind: SlAlertRead["kind"],
    read: boolean,
  ): Promise<void>;
  /** The client's social proof folder (null: none linked). */
  proofFolder(
    company: string,
    folder: string | null,
  ): Promise<ProofFolder | null>;
  /** The contracted product's folders in the Drive (to pick one). */
  contractFolders(
    company: string,
    contract: string,
  ): Promise<{ id: string; name: string }[]>;
  /**
   * Links a folder (the one given, or a new one named `name`) as the social
   * proof folder, with a public link that accepts uploads; `enabled` false
   * turns the link off and unlinks it.
   */
  setProofFolder(
    company: string,
    contract: string,
    folder: string | null,
    name: string | null,
    enabled: boolean,
  ): Promise<void>;
  setSettings(
    company: string,
    product: string,
    team: string | null,
    designTeam: string | null,
    artDays: number,
    module?: SlModule,
  ): Promise<void>;
  /**
   * One art task per approved post without one, for the team or person
   * chosen per post (none: the creative team); opens the client's cycle once,
   * for the people in `cycle` (none: whoever releases).
   */
  release(
    plan: string,
    assign: ReleaseAssign,
    cycle?: ReleaseCycle,
  ): Promise<{ created: number; cycle: boolean }>;
  setArts(
    plan: string,
    number: number,
    arts: MediaFile[],
  ): Promise<MediaFile[]>;
  /** The Meta campaign created from the plan (leaders); returns its id. */
  createCampaign(plan: string): Promise<string>;
  /** Social Media › Agendamento. */
  saveSchedule(plan: string, items: SmScheduleDraft[]): Promise<void>;
  cancelSchedule(plan: string, number: number): Promise<void>;
  setPublished(
    plan: string,
    number: number,
    published: boolean,
    url?: string | null,
  ): Promise<void>;
  setLinkCalendar(contract: string, enabled: boolean): Promise<void>;
  suggestSchedule(
    company: string,
    contract: string,
    plan: string,
    instruction: string,
  ): Promise<ScheduleSuggestion>;
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
  /** Sends a file to the client's Drive (a folder of the product, BRIEFING_FOLDER by default). */
  uploadMedia(
    company: string,
    contract: string,
    file: File,
    onProgress: (fraction: number) => void,
    folder?: string,
  ): Promise<MediaFile>;
  /** A short-lived address that shows the file. */
  mediaUrl(file: MediaFile): Promise<string>;
  deleteMedia(file: MediaFile): Promise<void>;
  brandColors(
    company: string,
    contract: string,
    from: { website?: string; instagram?: string },
  ): Promise<BrandColorsFound>;
  /** The client's recorded meetings (none when the module isn't there). */
  meetings(company: string, contract: string): Promise<MeetingOption[]>;
  /** The AI reads notes, a transcript or a meeting into briefing fields. */
  readBriefing(
    company: string,
    contract: string,
    from: { text?: string; recording?: string },
  ): Promise<BriefingSuggestion>;
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
  /** A team comment on a post's history. */
  comment(plan: string, number: number, note: string): Promise<void>;
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
    /** How many posts (8 to 16); none: the current or previous plan's. */
    posts?: number,
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
  /** Where an art of the plan is shown (an <img>/<video> source). */
  artUrl(token: string, art: { id: string }): string;
};

async function server<T>(body: Record<string, unknown>): Promise<T> {
  const token = supabase
    ? (await supabase.auth.getSession()).data.session?.access_token
    : undefined;
  if (!token) throw new Error("Entre novamente para usar a MAVI.");
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
    throw new Error(data.error ?? "Não foi possível falar com a MAVI.");
  return data as T;
}
function db() {
  if (!supabase) throw new Error("Supabase não configurado");
  return supabase;
}
const PLAN_COLUMNS =
  "id,company_id,contract_id,month_number,label,content,summary,source,share_enabled,shared_at,version,created_by,updated_by,created_at,updated_at";

export const serverSocialLeads: SocialLeadsBackend = {
  async portfolio(company, module = "social_leads") {
    return (await rpc("social_leads_portfolio", {
      p_company: company,
      p_module: module,
    })) as Portfolio;
  },
  async addClient(company, who, _product, _team, _name, module = "social_leads") {
    const contract = (await rpc("social_leads_add_client", {
      p_company: company,
      p_client: who.client,
      p_name: null,
      p_teams: null,
      p_module: module,
    })) as string;
    // Clientes and Produtos show the new client and contract too.
    invalidateLookupsCache(company);
    return contract;
  },
  async addableClients(company, module = "social_leads") {
    return ((await rpc("social_leads_addable_clients", {
      p_company: company,
      p_module: module,
    })) ?? []) as AddableClient[];
  },
  async archive(company, contract, archived) {
    await rpc("social_leads_archive", {
      p_contract: contract,
      p_archived: archived,
    });
    // Clientes and Produtos show the product archived (or back) too.
    invalidateLookupsCache(company);
  },
  async remove(company, contract) {
    await rpc("social_leads_remove", { p_contract: contract });
    invalidateLookupsCache(company);
  },
  async markAlert(plan, text, kind, read) {
    await rpc("social_leads_mark_alert", {
      p_plan: plan,
      p_text: text,
      p_kind: kind,
      p_read: read,
    });
  },
  async proofFolder(company, folder) {
    if (!folder) return null;
    const [f, files] = await Promise.all([
      db()
        .from("drive_folders")
        .select("id,name,visibility,share_token,public_upload")
        .eq("company_id", company)
        .eq("id", folder)
        .maybeSingle(),
      db()
        .from("drive_files")
        .select("id,name,content_type,size_bytes")
        .eq("company_id", company)
        .eq("folder_id", folder)
        .eq("status", "ready")
        .order("created_at", { ascending: false })
        .limit(60),
    ]);
    if (f.error) throw f.error;
    if (!f.data) return null;
    const row = f.data as {
      id: string;
      name: string;
      visibility: string;
      share_token: string;
      public_upload: boolean;
    };
    return {
      id: row.id,
      name: row.name,
      url:
        row.visibility === "public" ? publicFolderUrl(row.share_token) : null,
      upload: row.visibility === "public" && row.public_upload,
      files: (
        (files.data ?? []) as {
          id: string;
          name: string;
          content_type: string;
          size_bytes: number;
        }[]
      ).map((x) => ({
        id: x.id,
        name: x.name,
        type: x.content_type,
        size: x.size_bytes,
      })),
    };
  },
  async contractFolders(company, contract) {
    const r = await db()
      .from("drive_folders")
      .select("id,name")
      .eq("company_id", company)
      .eq("contract_id", contract)
      .order("name");
    if (r.error) throw r.error;
    return (r.data ?? []) as { id: string; name: string }[];
  },
  async setProofFolder(company, contract, folder, name, enabled) {
    await rpc("social_leads_proof_folder", {
      p_company: company,
      p_contract: contract,
      p_folder: folder,
      p_name: name,
      p_enabled: enabled,
    });
  },
  async setSettings(
    company,
    product,
    team,
    designTeam,
    artDays,
    module = "social_leads",
  ) {
    await rpc("set_social_leads_settings", {
      p_company: company,
      p_product: product,
      p_team: team,
      p_design_team: designTeam,
      p_art_days: artDays,
      p_module: module,
    });
  },
  async release(plan, assign, cycle) {
    return (await rpc("social_leads_release", {
      p_plan: plan,
      p_assign: cycle ? { ...assign, cycle } : assign,
    })) as {
      created: number;
      cycle: boolean;
    };
  },
  async setArts(plan, number, arts) {
    return (await rpc("social_leads_set_arts", {
      p_plan: plan,
      p_number: number,
      p_arts: arts,
    })) as MediaFile[];
  },
  async createCampaign(plan) {
    return (await rpc("social_leads_create_campaign", {
      p_plan: plan,
    })) as string;
  },
  async saveSchedule(plan, items) {
    await rpc("social_media_schedule_save", { p_plan: plan, p_items: items });
  },
  async cancelSchedule(plan, number) {
    await rpc("social_media_schedule_cancel", {
      p_plan: plan,
      p_number: number,
    });
  },
  async setPublished(plan, number, published, url) {
    await rpc("social_media_schedule_published", {
      p_plan: plan,
      p_number: number,
      p_published: published,
      p_url: url ?? null,
    });
  },
  async setLinkCalendar(contract, enabled) {
    await rpc("social_media_set_link_calendar", {
      p_contract: contract,
      p_enabled: enabled,
    });
  },
  async suggestSchedule(company, contract, plan, instruction) {
    return server<ScheduleSuggestion>({
      action: "schedule",
      company,
      contract,
      plan,
      instruction: instruction || null,
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
    const [p, x, r, u, e, a, sc] = await Promise.all([
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
      db()
        .from("social_leads_post_events")
        .select(
          "id,plan_id,number,kind,via,actor_id,actor_name,note,detail,created_at",
        )
        .eq("plan_id", plan)
        .order("created_at")
        .order("seq")
        .limit(2000),
      db()
        .from("social_leads_alert_reads")
        .select("alert_text,kind,read_by,read_at")
        .eq("plan_id", plan)
        .limit(200),
      db()
        .from("social_media_schedules")
        .select("*")
        .eq("plan_id", plan)
        .order("scheduled_at"),
    ]);
    for (const q of [p, x, r]) if (q.error) throw q.error;
    const contract = (p.data as unknown as SlPlan).contract_id;
    const account = await db()
      .from("social_media_accounts")
      .select("link_calendar")
      .eq("contract_id", contract)
      .maybeSingle();
    const posts = (x.data ?? []) as SlPost[];
    const ids = posts.map((y) => y.task_id).filter((v): v is string => !!v);
    const t = ids.length
      ? await db()
          .from("tasks")
          .select("id,title,status,assignee_id,due_date")
          .in("id", ids)
      : { data: [], error: null };
    return {
      plan: p.data as unknown as SlPlan,
      posts,
      revisions: (r.data ?? []) as SlRevision[],
      // The cost is a detail: without it (e.g. migration not applied yet) the plan still opens.
      usage: u.error ? [] : ((u.data ?? []) as SlUsage[]),
      tasks: t.error ? [] : ((t.data ?? []) as SlTask[]),
      // Without the history (migration not applied yet) the plan still opens.
      events: e.error ? [] : ((e.data ?? []) as SlPostEvent[]),
      // Without the reads (migration not applied yet) every alert is unread.
      alertReads: a.error ? [] : ((a.data ?? []) as SlAlertRead[]),
      // Without the schedule (migration not applied yet) nothing is scheduled.
      schedules: sc.error ? [] : ((sc.data ?? []) as SmSchedule[]),
      linkCalendar: account.error
        ? true
        : ((account.data as { link_calendar: boolean } | null)?.link_calendar ??
          true),
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
  async uploadMedia(
    company,
    contract,
    file,
    onProgress,
    name = BRIEFING_FOLDER,
  ) {
    const found = await db()
      .from("drive_folders")
      .select("id")
      .eq("company_id", company)
      .eq("contract_id", contract)
      .is("parent_id", null)
      .eq("name", name)
      .limit(1);
    if (found.error) throw found.error;
    const folder =
      found.data?.[0]?.id ??
      (await createDriveFolder(company, name, { contract }));
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
  async meetings(company, contract) {
    try {
      return ((await rpc("social_leads_meetings", {
        p_company: company,
        p_contract: contract,
      })) ?? []) as MeetingOption[];
    } catch {
      return [];
    }
  },
  async readBriefing(company, contract, from) {
    return server<BriefingSuggestion>({
      action: "briefing",
      company,
      contract,
      text: from.text ?? null,
      recording: from.recording ?? null,
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
  async comment(plan, number, note) {
    await rpc("social_leads_comment", {
      p_plan: plan,
      p_number: number,
      p_note: note,
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
  async generate(company, contract, mode, plan, posts) {
    await server({
      action: "generate",
      company,
      contract,
      mode,
      plan: plan ?? null,
      posts: posts ?? null,
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
    textoImagem?: string;
    textoVideo?: string;
    legenda?: string;
    ehAnuncio: boolean;
    decision: Decision;
    note: string;
    decided_at: string | null;
    decided_via: "link" | "team" | null;
    arts?: { id: string; name: string; type: string }[];
  }[];
  /** Social Media: when each post goes out (null when the team turned it off). */
  calendar?:
    | {
        numero: number;
        at: string;
        destinations: SmDestination[];
        published: boolean;
        url: string | null;
      }[]
    | null;
  timezone?: string;
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
  artUrl: (token, art) =>
    `/api/social-leads?arte=${encodeURIComponent(art.id)}&link=${encodeURIComponent(token)}`,
};
/** "AAAA-MM-DDTHH:MM" in São Paulo as an instant (the demo; the database uses the company's zone). */
function demoInstant(local: string) {
  const guess = new Date(`${local}:00Z`);
  const shown = new Date(
    guess.toLocaleString("en-US", { timeZone: SM_TIME_ZONE }),
  );
  const utc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(
    guess.getTime() + (utc.getTime() - shown.getTime()),
  ).toISOString();
}
/** The Drive folder of a month's arts and PDFs. */
export const monthFolder = (label: string) => `Artes · ${label}`;
export function shareUrl(token: string) {
  return `${window.location.origin}/aprovacao/${token}`;
}

// ------------------------------------------------------------ demo
const now = () => new Date().toISOString();
const id = () => `demo-${Math.random().toString(36).slice(2, 10)}`;
type DemoSettings = {
  product: string;
  team: string | null;
  designTeam?: string | null;
  artDays?: number;
};
type DemoState = {
  settings: Partial<Record<SlModule, DemoSettings>>;
  tasks: SlTask[];
  /** Contracts whose follow-up cycle was opened. */
  cycles: Record<string, boolean>;
  campaigns: Record<string, { id: string; name: string; active: boolean }>;
  briefings: Record<string, SlBriefing>;
  plans: SlPlan[];
  posts: SlPost[];
  revisions: SlRevision[];
  jobs: Record<string, SlJob>;
  tokens: Record<string, string>;
  usage: (SlUsage & { plan_id: string })[];
  /** Files "uploaded" in the demo: object URLs in this tab. */
  files: Record<string, string>;
  /** Each post's history, and the posts as last seen (to find changes). */
  events: SlPostEvent[];
  seen: Record<string, SlPost>;
  /** Why the plan is being written now (like the database's revision). */
  reason: string | null;
  alertReads: (SlAlertRead & { plan_id: string })[];
  schedules: SmSchedule[];
  /** Contracts whose client link hides the calendar. */
  hiddenCalendars: string[];
  /** Drive folders of the demo's contracts (the social proof folder). */
  folders: {
    id: string;
    contract: string;
    name: string;
    url: string | null;
    upload: boolean;
    files: MediaFile[];
  }[];
};
let demoState: DemoState | null = null;

/** A plausible plan for the demonstration (the real one comes from the AI). */
export function samplePlan(
  client: string,
  month: number,
  count = POSTS_DEFAULT,
): PlanContent {
  const hooks = [
    `Quem está por trás da ${client}`,
    "3 perguntas que todo cliente faz antes de decidir",
    "Um dia com a nossa equipe",
    `Conheça a ${client} de perto`,
    "O erro mais comum de quem está começando",
    "Como funciona o primeiro atendimento",
    "Mito ou verdade?",
    "Bastidores do mês",
    "Antes e depois de um projeto real",
    "O que ninguém conta sobre reforma",
    "Perguntas da semana",
    "Nosso processo em 4 passos",
    "Um material que a gente ama",
    "Por que começar pelo projeto",
    "Um canto pequeno, bem resolvido",
    "Como escolher a paleta de cores",
  ];
  return {
    diagnostico: {
      negocio: `${client} é um estúdio de design de interiores que atende apartamentos e pequenos comércios da região, do conceito à entrega da obra. O trabalho se apoia em projetos acolhedores e funcionais, acompanhamento próximo de cada etapa e uma equipe que resolve a obra junto com o cliente. O ticket médio é de R$ 4.500,00 e a oferta em destaque é a consultoria de 2 horas. A maior parte dos clientes chega por indicação, o que mostra confiança, mas deixa o volume de contatos dependente do boca a boca.`,
      comoQuerSerVista:
        "Quer ser vista como a referência em projetos que cabem na vida real: bonitos, práticos e dentro do orçamento combinado. A comunicação orgânica deve ensinar e mostrar bastidores de obra, sem cara de propaganda. Todo o discurso comercial fica concentrado no anúncio pago.",
    },
    swot: {
      forcas:
        "Projetos autorais e funcionais; acompanhamento de obra do começo ao fim; clientes que indicam; equipe experiente em reformas pequenas.",
      fraquezas:
        "Pouca presença digital até agora; ausência de depoimentos registrados; percepção de que projeto de interiores é caro.",
      oportunidades:
        "Não foram apontadas oportunidades no briefing. Pontos observáveis a validar com a cliente: concorrentes quase não publicam conteúdo educativo; a consultoria de 2 horas é uma porta de entrada pouco explorada na região.",
      ameacas:
        "Sensibilidade a preço na região; concorrência de lojas de móveis planejados que oferecem projeto gratuito.",
    },
    pilares: [
      {
        titulo: "Bastidores da obra",
        descricao:
          "Mostrar quem faz e como faz: medição, escolha de materiais, instalação. Traduz cada etapa em cuidado com o cliente.",
      },
      {
        titulo: "Dúvidas reais",
        descricao:
          "Responder o que o público pergunta antes de contratar: quanto custa, quanto tempo leva, o que dá para aproveitar.",
      },
      {
        titulo: "Antes e depois",
        descricao:
          "Situações verídicas do dia a dia dos projetos, sem depoimento inventado. Mostra resultado sem prometer.",
      },
      {
        titulo: "Convite",
        descricao:
          "Chamar para conhecer a consultoria do mês, só no anúncio, sem apelo comercial no feed.",
      },
    ],
    publico:
      "Casais de 28 a 45 anos reformando o primeiro apartamento ou abrindo um pequeno comércio na região. Buscam um resultado bonito sem estourar o orçamento e querem alguém que resolva a obra junto. Costumam pesquisar no Instagram antes de chamar no WhatsApp e comparam com lojas de planejados, o que exige mostrar o valor do projeto antes de falar de preço.",
    campanha: {
      objetivo:
        "Tráfego para conversas no WhatsApp (Click to WhatsApp), otimizando para início de conversa. O post 4 leva direto para o atendimento, onde acontece a qualificação e o agendamento da consultoria.",
      regiao:
        "Raio de 5 km a partir do endereço do estúdio, priorizando os bairros vizinhos. Ajustar o raio nas primeiras semanas conforme a origem dos contatos.",
      idadeGenero:
        "28 a 45 anos, todos os gêneros, com maior peso para mulheres se o custo por conversa for melhor nesse recorte.",
      segmentacao:
        "Iniciar com segmentação aberta dentro da região e da faixa etária, deixando a entrega do Meta encontrar o público. Se precisar refinar, testar interesses ligados a decoração, reforma e imóveis, sempre em conjunto amplo.",
      posicionamentos:
        "Automáticos (Advantage+), acompanhando Feed e Stories do Instagram e Feed do Facebook. Entregar criativo em 4:5 e 9:16.",
      orcamento:
        "R$ 500,00/mês, aproximadamente R$ 16,50/dia, em uma única campanha e um único conjunto para concentrar o aprendizado. Sem previsão de volume de contatos: o primeiro mês serve como referência de custo por conversa.",
      perguntasFormulario: [
        "Mensagem inicial sugerida no WhatsApp: 'Olá! Vi o anúncio e quero saber mais sobre a consultoria.'",
        "Qual é o ambiente que você quer transformar?",
        "É apartamento, casa ou comércio?",
        "Em qual bairro fica?",
        "Para quando você gostaria de começar?",
      ],
      roteamentoLead:
        "Todas as conversas caem no WhatsApp do atendimento. Responder em até 30 minutos no horário comercial. Usar as perguntas acima como roteiro de qualificação. Ter uma mensagem pronta para fora do horário. Registrar em planilha: data, nome, ambiente, bairro e se agendou a consultoria.",
    },
    alertas: [
      "Sem depoimentos reais ainda: captar autorizações de clientes neste mês.",
    ],
    posts: hooks.slice(0, clampPosts(count)).map((gancho, i) => ({
      numero: i + 1,
      badge: (["posicionar", "autoridade", "oferta"] as const)[i % 3],
      gancho: month > 1 ? `${gancho} (mês ${month})` : gancho,
      direcaoCopy: "Texto curto, tom acolhedor, uma ideia por post.",
      direcaoVisual: "Foto real da equipe, cores da marca, sem texto na arte.",
      formato: i % 2 ? "Carrossel" : "Reels",
      cta: i === 3 ? "Chamar no WhatsApp" : "Seguir a página",
      textoImagem:
        i % 2
          ? slidesRichText(
              [
                {
                  headline: gancho,
                  subheadline: "O que ninguém conta antes da obra",
                  texto: "",
                  sugestaoImagem:
                    "Foto de um ambiente já entregue pela equipe, com luz natural e espaço livre no alto para o título.",
                },
                {
                  headline: "O que a gente observa em cada projeto",
                  subheadline: "",
                  texto:
                    "Luz, circulação e o jeito que a família usa o espaço no dia a dia.",
                  sugestaoImagem:
                    "Detalhe da planta ou do esboço do projeto sobre a mesa, com as mãos da arquiteta.",
                },
                {
                  headline: "Salve para lembrar depois",
                  subheadline: "",
                  texto: "",
                  sugestaoImagem:
                    "Só tipografia sobre a cor principal da marca, com o logo no rodapé.",
                },
              ],
              false,
            )
          : "",
      textoVideo:
        i % 2
          ? ""
          : `Cena 1 (0–3 s): "${gancho}"\nCena 2 (3–12 s): a equipe mostra o detalhe na obra\nTexto na tela: ${client}`,
      legenda: `${gancho}.\n\nNo dia a dia da ${client}, cada detalhe é pensado com você.\n\n${i === 3 ? "Chame no WhatsApp e conheça a consultoria." : "Siga a página para ver mais."}\n\n#interiores #reforma`,
      ehAnuncio: i === 3,
    })),
  };
}

export function demoSocialLeads(
  data: Snapshot,
  user: string,
): SocialLeadsBackend {
  const seeded = (name: RegExp) => {
    const product = data.products.find((p) => name.test(p.name));
    return product
      ? { product: product.id, team: data.teams[0]?.id ?? null }
      : undefined;
  };
  if (!demoState)
    demoState = {
      settings: {
        social_leads: seeded(/social leads/i),
        social_media: seeded(/social media/i),
      },
      briefings: {},
      plans: [],
      posts: [],
      revisions: [],
      jobs: {},
      tokens: {},
      usage: [],
      files: {},
      tasks: [],
      cycles: {},
      campaigns: {},
      events: [],
      seen: {},
      reason: null,
      alertReads: [],
      folders: [],
      schedules: [],
      hiddenCalendars: [],
    };
  const s = demoState;
  const spend = (plan: string, kind: SlUsage["kind"], cost: number) =>
    s.usage.push({
      plan_id: plan,
      kind,
      model: "claude-opus-5-5",
      input_tokens: Math.round(cost * 90_000),
      output_tokens: Math.round(cost * 22_000),
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: cost,
      created_at: now(),
      created_by: user,
    });
  const nameOf = (u: string | null) =>
    data.members.find((m) => m.user_id === u)?.name ?? "";
  // Like the database trigger: every change to a post goes to its history.
  const emit = () => {
    for (const x of s.posts) {
      const plan = s.plans.find((p) => p.id === x.plan_id);
      if (!plan) continue;
      const key = `${x.plan_id}:${x.number}`;
      const task = x.task_id
        ? s.tasks.find((t) => t.id === x.task_id)
        : undefined;
      for (const e of postEventsFor(s.seen[key], x, {
        actor: user,
        actorName: nameOf(user),
        clientName:
          s.briefings[plan.contract_id]?.fields.clientName ||
          clientOf(plan.contract_id).name,
        source: plan.source,
        reason: s.reason,
        summary: plan.summary,
        name: nameOf,
        task: task && {
          assignee: nameOf(task.assignee_id) || undefined,
          due: task.due_date ?? undefined,
        },
      }))
        s.events.push({ ...e, id: id(), created_at: now() });
      s.seen[key] = { ...x, arts: x.arts && [...x.arts] };
    }
    s.reason = null;
    window.dispatchEvent(new CustomEvent("mavi:social-leads", { detail: {} }));
  };
  const contractOf = (k: string) => data.contracts.find((c) => c.id === k)!;
  const clientOf = (k: string) =>
    data.clients.find((c) => c.id === contractOf(k).client_id)!;
  // The module of a contract is the one of its product.
  const moduleOf = (k: string): SlModule =>
    (Object.keys(s.settings) as SlModule[]).find(
      (m) => s.settings[m]?.product === contractOf(k).product_id,
    ) ?? "social_leads";
  const settingsOf = (k: string) => s.settings[moduleOf(k)];
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
        image_text: p.textoImagem ?? "",
        video_text: p.textoVideo ?? "",
        caption: p.legenda ?? "",
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
    async portfolio(_c, module = "social_leads") {
      const settings = s.settings[module];
      if (!settings) return { configured: false, items: [] };
      const items: PortfolioItem[] = data.contracts
        .filter((k) => k.product_id === settings.product && !k.archived)
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
                  alerts_unread: last.content.alertas.filter(
                    (a) =>
                      !s.alertReads.some(
                        (r) => r.plan_id === last.id && r.alert_text === a,
                      ),
                  ).length,
                  first_alert: last.content.alertas[0] ?? null,
                  posts: posts.length,
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
                  tasks: posts.filter((x) => x.task_id).length,
                  arts: posts.filter((x) => x.arts?.length).length,
                  scheduled: s.schedules.filter((z) => z.plan_id === last.id)
                    .length,
                  published: s.schedules.filter(
                    (z) => z.plan_id === last.id && z.status === "published",
                  ).length,
                  due: s.schedules.filter(
                    (z) =>
                      z.plan_id === last.id &&
                      (z.status === "failed" ||
                        (z.status !== "published" &&
                          new Date(z.scheduled_at).getTime() <= Date.now())),
                  ).length,
                }
              : null,
            job: s.jobs[k.id] ?? null,
            campaign: s.campaigns[k.id] ?? null,
          };
        })
        .sort((a, b) => a.client_name.localeCompare(b.client_name));
      return {
        configured: true,
        product_id: settings.product,
        team_id: settings.team,
        design_team_id: settings.designTeam ?? null,
        art_days: settings.artDays ?? 5,
        items,
      };
    },
    async addableClients(_c, module = "social_leads") {
      const product = s.settings[module]?.product;
      return data.clients
        .filter(
          (c) =>
            !c.archived &&
            !data.contracts.some(
              (k) =>
                k.client_id === c.id && k.product_id === product && !k.archived,
            ),
        )
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => ({
          id: c.id,
          name: c.name,
          color: c.color,
          archived_contract:
            data.contracts.find(
              (k) =>
                k.client_id === c.id && k.product_id === product && k.archived,
            )?.id ?? null,
        }));
    },
    async archive(_c, contract, archived) {
      const k = data.contracts.find((x) => x.id === contract);
      if (!k) throw new Error("Cliente não encontrado no Social Leads.");
      k.archived = archived;
      emit();
    },
    async remove(_c, contract) {
      if (s.plans.some((p) => p.contract_id === contract))
        throw new Error(
          "Este cliente já tem histórico no Social Leads (plano, tarefa ou arquivo). Arquive em vez de excluir.",
        );
      data.contracts = data.contracts.filter((k) => k.id !== contract);
      delete s.briefings[contract];
      emit();
    },
    async addClient(
      company,
      who,
      product,
      _team,
      clientName,
      module = "social_leads",
    ) {
      if (
        data.contracts.some(
          (k) =>
            k.client_id === who.client &&
            k.product_id === product.id &&
            !k.archived,
        )
      )
        throw new Error(`Este cliente já está no ${SL_MODULES[module].name}.`);
      const archived = data.contracts.find(
        (k) =>
          k.client_id === who.client &&
          k.product_id === product.id &&
          k.archived,
      );
      if (archived) {
        archived.archived = false;
        emit();
        return archived.id;
      }
      const client = who.client;
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
    async setSettings(
      _c,
      productId,
      team,
      designTeam,
      artDays,
      module = "social_leads",
    ) {
      const other = (Object.keys(s.settings) as SlModule[]).find(
        (m) => m !== module && s.settings[m]?.product === productId,
      );
      if (other)
        throw new Error(
          `Este produto já é o do ${SL_MODULES[other].name}. Escolha outro produto.`,
        );
      s.settings[module] = { product: productId, team, designTeam, artDays };
      emit();
    },
    async release(planId, assign) {
      const plan = s.plans.find((p) => p.id === planId)!;
      const client = clientOf(plan.contract_id).name;
      const settings = settingsOf(plan.contract_id);
      const team = settings?.designTeam ?? settings?.team ?? null;
      const people = data.teamMembers
        .filter((t) => t.team_id === team)
        .map((t) => t.user_id);
      const todo = s.posts.filter(
        (x) => x.plan_id === planId && x.decision === "approved" && !x.task_id,
      );
      if (!todo.length) throw new Error("Nenhum post aprovado sem tarefa.");
      const due = new Date(Date.now() + (settings?.artDays ?? 5) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      todo.forEach((x, i) => {
        const target = assign[x.number];
        const members =
          target && "team" in target
            ? data.teamMembers
                .filter((t) => t.team_id === target.team)
                .map((t) => t.user_id)
            : people;
        const task: SlTask = {
          id: id(),
          title: [
            `Arte do post ${x.number}`,
            x.format.trim(),
            plan.label,
            client,
          ]
            .filter(Boolean)
            .join(" · "),
          status: "progress",
          assignee_id:
            target && "user" in target
              ? target.user
              : (members[i % Math.max(members.length, 1)] ?? user),
          due_date: due,
        };
        s.tasks.push(task);
        x.task_id = task.id;
      });
      const cycle = !s.cycles[plan.contract_id];
      s.cycles[plan.contract_id] = true;
      const b = s.briefings[plan.contract_id];
      // The demo only marks the cycle as open (its tasks aren't shown).
      if (cycle && b) b.cycle = { started_at: now() };
      emit();
      return { created: todo.length, cycle };
    },
    async setArts(planId, number, arts) {
      const x = s.posts.find(
        (p) => p.plan_id === planId && p.number === number,
      )!;
      x.arts = arts;
      emit();
      return arts;
    },
    async createCampaign(planId) {
      const plan = s.plans.find((p) => p.id === planId)!;
      const campaign = {
        id: id(),
        name: `${SL_MODULES[moduleOf(plan.contract_id)].name} · ${clientOf(plan.contract_id).name}`,
        active: false,
      };
      s.campaigns[plan.contract_id] = campaign;
      emit();
      return campaign.id;
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
        tasks: s.tasks.filter((t) =>
          s.posts.some((x) => x.plan_id === planId && x.task_id === t.id),
        ),
        events: s.events.filter((e) => e.plan_id === planId),
        alertReads: s.alertReads.filter((r) => r.plan_id === planId),
        schedules: s.schedules
          .filter((z) => z.plan_id === planId)
          .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at)),
        linkCalendar: !s.hiddenCalendars.includes(plan.contract_id),
      };
    },
    async saveSchedule(planId, items) {
      const event = (
        number: number,
        kind: SlPostEvent["kind"],
        detail: SlPostEvent["detail"],
      ) =>
        s.events.push({
          id: id(),
          plan_id: planId,
          number,
          kind,
          via: "team",
          actor_id: user,
          actor_name: nameOf(user),
          note: "",
          detail,
          created_at: now(),
        });
      for (const i of items) {
        const x = s.posts.find(
          (p) => p.plan_id === planId && p.number === i.number,
        );
        if (!x || x.decision !== "approved")
          throw new Error(
            `Post ${i.number}: só posts aprovados entram no agendamento.`,
          );
        if (!x.arts?.length)
          throw new Error(`Post ${i.number}: envie a arte antes de agendar.`);
        if (!i.destinations.length)
          throw new Error(`Post ${i.number}: escolha onde publicar.`);
        const at = demoInstant(i.at);
        const old = s.schedules.find(
          (z) => z.plan_id === planId && z.number === i.number,
        );
        if (old?.status === "published")
          throw new Error(`Post ${i.number} já foi publicado.`);
        const moved =
          !old || old.scheduled_at !== at || old.status === "failed";
        if (moved && new Date(at).getTime() < Date.now() + 60_000)
          throw new Error(
            `Post ${i.number}: escolha uma data e hora no futuro.`,
          );
        const row: SmSchedule = {
          plan_id: planId,
          number: i.number,
          scheduled_at: at,
          destinations: [...i.destinations].sort(),
          caption: i.caption,
          first_comment: i.first_comment.trim(),
          cover: i.cover,
          status: moved ? "scheduled" : old!.status,
          reminded_at: moved ? null : (old?.reminded_at ?? null),
          published_at: null,
          published_url: null,
          published_via: null,
          published_by: null,
          error: null,
          scheduled_by: old?.scheduled_by ?? user,
          updated_by: user,
          updated_at: now(),
        };
        s.schedules = s.schedules.filter((z) => z !== old).concat(row);
        if (!old || old.scheduled_at !== at)
          event(i.number, "scheduled", {
            at,
            previous: old?.scheduled_at ?? null,
            destinations: row.destinations,
          });
      }
      emit();
    },
    async cancelSchedule(planId, number) {
      const old = s.schedules.find(
        (z) => z.plan_id === planId && z.number === number,
      );
      if (!old || old.status === "published")
        throw new Error(
          "Agendamento não encontrado (ou o post já foi publicado).",
        );
      s.schedules = s.schedules.filter((z) => z !== old);
      s.events.push({
        id: id(),
        plan_id: planId,
        number,
        kind: "unscheduled",
        via: "team",
        actor_id: user,
        actor_name: nameOf(user),
        note: "",
        detail: { at: old.scheduled_at },
        created_at: now(),
      });
      emit();
    },
    async setPublished(planId, number, published, url) {
      const z = s.schedules.find(
        (r) => r.plan_id === planId && r.number === number,
      );
      if (!z) throw new Error("Agendamento não encontrado.");
      const u = url?.trim() || null;
      if (u && !/^https:\/\/\S+$/i.test(u))
        throw new Error("O link do post precisa começar com https://.");
      if (published)
        Object.assign(z, {
          status: "published",
          published_at: z.published_at ?? now(),
          published_url: u ?? z.published_url,
          published_via: z.published_via ?? "manual",
          published_by: z.published_by ?? user,
          error: null,
        });
      else
        Object.assign(z, {
          status:
            new Date(z.scheduled_at).getTime() <= Date.now()
              ? "due"
              : "scheduled",
          published_at: null,
          published_url: null,
          published_via: null,
          published_by: null,
        });
      s.events.push({
        id: id(),
        plan_id: planId,
        number,
        kind: "published",
        via: "team",
        actor_id: user,
        actor_name: nameOf(user),
        note: published ? "" : "desfeito",
        detail: published
          ? { url: z.published_url, via: "manual" }
          : { undone: true },
        created_at: now(),
      });
      emit();
    },
    async setLinkCalendar(contract, enabled) {
      s.hiddenCalendars = s.hiddenCalendars.filter((c) => c !== contract);
      if (!enabled) s.hiddenCalendars.push(contract);
      emit();
    },
    async suggestSchedule(_c, _contract, planId) {
      await new Promise((r) => setTimeout(r, 900));
      const open = s.posts
        .filter(
          (x) =>
            x.plan_id === planId &&
            x.decision === "approved" &&
            x.arts?.length &&
            !s.schedules.some(
              (z) => z.plan_id === planId && z.number === x.number,
            ),
        )
        .sort((a, b) => a.number - b.number);
      if (!open.length)
        throw new Error(
          "Todos os posts aprovados com arte já têm data. Para mudar uma, edite o post no calendário.",
        );
      spend(planId, "schedule", 0.01);
      const day = (n: number) => {
        const d = new Date(Date.now() + n * 86_400_000);
        return d.toLocaleDateString("en-CA", { timeZone: SM_TIME_ZONE });
      };
      return {
        posts: open.map((x, i) => ({
          numero: x.number,
          at: `${day(1 + i * 3)}T${x.arts?.some((a) => a.type.startsWith("video/")) ? "19:00" : "12:00"}`,
          destinations: x.is_ad
            ? ["facebook", "instagram", "story"]
            : ["facebook", "instagram"],
          reason: "Ritmo de dois posts por semana, alternando os pilares.",
        })),
        summary: "Dois posts por semana, vídeos à noite e o resto no almoço.",
        timezone: SM_TIME_ZONE,
        cost_usd: 0.01,
      };
    },
    async markAlert(planId, text, kind, read) {
      s.alertReads = s.alertReads.filter(
        (r) => !(r.plan_id === planId && r.alert_text === text),
      );
      if (read)
        s.alertReads.push({
          plan_id: planId,
          alert_text: text,
          kind,
          read_by: user,
          read_at: now(),
        });
      emit();
    },
    async proofFolder(_c, folder) {
      const f = s.folders.find((x) => x.id === folder);
      return f
        ? {
            id: f.id,
            name: f.name,
            url: f.url,
            upload: f.upload,
            files: f.files,
          }
        : null;
    },
    async contractFolders(_c, contract) {
      return s.folders
        .filter((f) => f.contract === contract)
        .map((f) => ({ id: f.id, name: f.name }));
    },
    async setProofFolder(_c, contract, folder, name, enabled) {
      let f = s.folders.find((x) => x.id === folder);
      if (!f && enabled) {
        f = {
          id: id(),
          contract,
          name: name?.trim() || "Prova social",
          url: null,
          upload: false,
          files: [],
        };
        s.folders.push(f);
      }
      if (!f) throw new Error("Pasta não encontrada neste produto do cliente.");
      f.url = enabled ? `${window.location.origin}/pasta/demo-${f.id}` : null;
      f.upload = enabled;
      const b = s.briefings[contract] ?? {
        fields: {},
        campaign_objective: null,
        responsible_id: null,
        version: 1,
        updated_at: now(),
        media: {},
      };
      b.proof_folder = enabled ? f.id : null;
      s.briefings[contract] = b;
      emit();
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
    async meetings() {
      return [
        {
          id: "demo-reuniao",
          title: "Onboarding com o cliente",
          overview:
            "Apresentação do estúdio, oferta do mês e o público que eles querem atingir.",
          speakers: ["Allyson Assunção", "Renata"],
          recorded_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
          duration_seconds: 2460,
          has_transcript: true,
        },
      ];
    },
    async readBriefing(_c, contract, from) {
      if (!from.recording && !from.text?.trim())
        throw new Error(
          "Cole as notas ou a transcrição, ou escolha uma reunião.",
        );
      await new Promise((r) => setTimeout(r, 1500));
      const name =
        s.briefings[contract]?.fields.clientName || clientOf(contract).name;
      return {
        fields: {
          clientName: name,
          segment: "Estúdio de design de interiores",
          contactName: "Renata",
          businessWhat:
            "Projetos de interiores residenciais e comerciais, do conceito à obra.",
          positioning: "Referência em projetos acolhedores e funcionais.",
          featuredOffer: "Consultoria de 2 horas com 20% de desconto",
          averageTicket: "R$ 4.500,00",
          targetAudience:
            "Casais de 28 a 45 anos reformando o primeiro apartamento.",
          notes: "Não prometer prazo de obra.",
        },
        objective: "ctwa",
        evidence: {
          segment: "a gente faz projeto de interiores, casa e loja",
          featuredOffer: "queria puxar a consultoria de duas horas com 20%",
          notes: "prazo de obra a gente nunca promete",
        },
        missing: ["competitors", "socialProof", "mediaBudget"],
        summary: "Demonstração: campos de exemplo, sem chamar a MAVI.",
        source: from.recording ? "Onboarding com o cliente" : "Texto colado",
        cost_usd: 0.06,
      };
    },
    async writePlan(
      _c,
      contract,
      planId,
      content,
      reason,
      version,
      _source,
      summary,
    ) {
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
          (o.image_text ?? "") === (p.textoImagem ?? "") &&
          (o.video_text ?? "") === (p.textoVideo ?? "") &&
          (o.caption ?? "") === (p.legenda ?? "") &&
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
      if (summary) plan.summary = summary;
      s.reason = reason;
      emit();
      return { id: planId, version: plan.version };
    },
    async restore(revision) {
      const r = s.revisions.find((x) => x.id === revision)!;
      const plan = s.plans.find((p) => p.id === r.plan_id)!;
      putPlan(plan.contract_id, r.content, plan.id);
      s.reason = `antes de restaurar a versão ${r.number}`;
      emit();
    },
    async comment(planId, number, note) {
      const plan = s.plans.find((p) => p.id === planId)!;
      if (!note.trim()) throw new Error("Escreva o comentário.");
      s.events.push({
        id: id(),
        plan_id: plan.id,
        number,
        kind: "comment",
        via: "team",
        actor_id: user,
        actor_name: nameOf(user),
        note: note.trim(),
        detail: {},
        created_at: now(),
      });
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
    async generate(_c, contract, mode, planId, posts) {
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
        const previous = s.posts.filter(
          (x) =>
            x.plan_id ===
            (mode === "current"
              ? planId
              : s.plans.filter((p) => p.contract_id === contract).at(-1)?.id),
        ).length;
        const plan = putPlan(
          contract,
          samplePlan(client, n, posts ?? (previous || POSTS_DEFAULT)),
          mode === "current" ? planId : undefined,
        );
        if (mode === "current") s.reason = "regeneração do mês";
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
              textoImagem: x.image_text ?? "",
              textoVideo: x.video_text ?? "",
              legenda: x.caption ?? "",
              ehAnuncio: x.is_ad,
              decision: x.decision,
              note: x.note,
              decided_at: x.decided_at,
              decided_via: x.decided_via,
              arts: (x.arts ?? []).map((a) => ({
                id: a.id,
                name: a.name,
                type: a.type,
              })),
            })),
          calendar:
            moduleOf(plan.contract_id) === "social_media" &&
            !s.hiddenCalendars.includes(plan.contract_id)
              ? s.schedules
                  .filter((z) => z.plan_id === plan.id)
                  .sort((a, z) => a.scheduled_at.localeCompare(z.scheduled_at))
                  .map((z) => ({
                    numero: z.number,
                    at: z.scheduled_at,
                    destinations: z.destinations,
                    published: z.status === "published",
                    url: z.published_url,
                  }))
              : null,
          timezone: SM_TIME_ZONE,
        };
      },
      artUrl: (_token, art) => s.files[art.id] ?? "",
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

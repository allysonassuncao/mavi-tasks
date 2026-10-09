import { rpc } from "./api";
import { supabase } from "./supabase";
import {
  campaignIdFromPath,
  pagePaths,
  resolvePage,
  routeParts,
  taskIdFromPath,
  type Page,
} from "./router";
import { ROLE_LABEL, tutorialModuleOf, type TutorialAudience } from "./tutorials";
import type { Snapshot } from "./types";
import type { TourTarget } from "./tour-target";
import type { VoteReason } from "./tutorials";
import type { WriterBlock } from "./tutorial-writer";

/**
 * Onboarding (Tutoriais › Onboarding): guided tours over the app's screens.
 * Everything goes through the database functions of migration
 * 20270623090000_tutorial_tours; the demo keeps its tours in this browser.
 * The layer that edits and plays them (TourLayer) lives above every page and
 * is driven by window events, so any screen can start one.
 */

export type TourStepKind = "next" | "click" | "input" | "auto";
export type TourPlacement = "auto" | "top" | "bottom" | "left" | "right";
export type TourStatus = "draft" | "published";

export interface TourStep {
  id: string;
  /** The page it appears on (id of the app: tasks, campaigns…). */
  page: string;
  /** The screen's address, without the company part (/tarefas?aba=…). */
  url: string;
  /** Null: the balloon in the middle of the screen. */
  target: TourTarget | null;
  title: string;
  /** Rich text (mavi:richtext:v1:…). */
  body: string;
  kind: TourStepKind;
  placement: TourPlacement;
  /**
   * Inside a record (a campaign, a table row): "any" = any of the same kind
   * (the first row instead of the recorded one); "same" = the recorded one.
   */
  record?: TourRecord;
  /** "Esperar o clique": false = the click is only shown, never sent. */
  real?: boolean;
  /** "Esperar o clique": false = no "Pular" button (the click is required). */
  skip?: boolean;
}
export type TourRecord = "any" | "same";

/** Who receives beyond roles, teams and people, and where it shows. */
export interface TourReach {
  aud_squads: string[];
  /** People who serve these clients (the clients' teams). */
  aud_clients: string[];
  /** People who serve these products (the products' teams). */
  aud_products: string[];
  /** Only on screens of these clients / products (empty: anywhere). */
  scr_clients: string[];
  scr_products: string[];
}

/** Starts by itself (once per person); the "?" and the tab always work. */
export interface TourTriggers {
  /** The first time the person opens the screen where it starts. */
  trg_visit: boolean;
  /** Right after the person enters the system. */
  trg_login: boolean;
}

export interface TourContent extends TutorialAudience, TourReach, TourTriggers {
  title: string;
  summary: string;
  steps: TourStep[];
  modules: string[];
}

export type TourProgressStatus = "started" | "completed" | "dismissed";
export interface TourProgress {
  status: TourProgressStatus;
  step: number;
  step_id: string;
  version: number;
  completed_at: string | null;
}

export interface TourRow {
  id: string;
  title: string;
  summary: string;
  modules: string[];
  start_page: string;
  step_count: number;
  status: TourStatus;
  version: number;
  has_draft: boolean;
  aud_all: boolean;
  created_by: string;
  author_name: string;
  updated_at: string;
  published_at: string | null;
  can_edit: boolean;
  my_status: TourProgressStatus | null;
  my_step: number | null;
  misses: number;
  /** Only on screens of some clients / products. */
  screen_only?: boolean;
}

export interface TourMiss {
  step_id: string;
  misses: number;
  people: number;
  last_path: string;
  last_at: string;
}

export interface TourDetail {
  id: string;
  title: string;
  summary: string;
  steps: TourStep[];
  modules: string[];
  start_page: string;
  status: TourStatus;
  version: number;
  revision: number;
  audience: (TutorialAudience & Partial<TourReach> & Partial<TourTriggers>) | null;
  created_by: string;
  author_name: string;
  updated_at: string;
  published_at: string | null;
  draft: { content: TourContent; saved_at: string; saved_by_name: string } | null;
  misses: TourMiss[] | null;
  progress: TourProgress | null;
  can_edit: boolean;
}

export type TourSaveResult = {
  id: string;
  mode: "created" | "saved" | "draft" | "published";
  status: TourStatus;
  version: number;
  revision: number;
};

export type TourProgressAction = "start" | "step" | "complete" | "dismiss";

export interface TourStepMetric {
  step_id: string;
  n: number;
  title: string;
  kind: TourStepKind;
  page: string;
  /** People who reached the step. */
  reached: number;
  /** People who closed the tour on it. */
  stopped: number;
  /** Times its element didn't show. */
  misses: number;
}
export interface TourMetrics {
  version: number;
  versions: number[];
  started: number;
  completed: number;
  dismissed: number;
  in_progress: number;
  steps: TourStepMetric[];
  up: number;
  down: number;
  feedback: { vote: "up" | "down"; reason: VoteReason | null; comment: string; name: string; at: string }[];
}
export type TourVote = { vote: "up" | "down"; reason: VoteReason | null; comment: string; version: number };
/** What the editor tells the MAVI about a step (the balloon to write). */
export type TourWriteRequest = {
  mode: "write" | "improve";
  idea?: string;
  tour: string;
  summary: string;
  n: number;
  total: number;
  screen: string;
  element: string;
  context: string;
  kind: TourStepKind;
  title: string;
  text: string;
  before: string[];
  after: string[];
};
export type TourWriteResult = { title: string; blocks: WriterBlock[]; notes: string };

/** An automatic tour that hasn't reached the person yet. */
export interface TourAuto {
  id: string;
  title: string;
  start_page: string;
  trg_visit: boolean;
  trg_login: boolean;
  screen_only: boolean;
}

export interface ToursApi {
  list(
    company: string,
    scope: "library" | "admin",
    module?: string | null,
    page?: string | null,
    context?: TourScreenContext | null,
  ): Promise<TourRow[]>;
  detail(id: string): Promise<TourDetail | null>;
  save(
    company: string,
    id: string | null,
    content: TourContent,
    publish: boolean,
    revision?: number | null,
  ): Promise<TourSaveResult>;
  discardDraft(id: string): Promise<void>;
  unpublish(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  progress(id: string, action: TourProgressAction, step: number, stepId: string): Promise<TourProgress | null>;
  miss(id: string, stepId: string, path: string): Promise<void>;
  /** The automatic tours still to reach the person (oldest first). */
  autos(company: string): Promise<TourAuto[]>;
  /** The funnel, votes and comments of a version (who edits). */
  metrics(id: string, version?: number | null): Promise<TourMetrics | null>;
  /** "Isso ajudou?" (null takes the vote back). */
  vote(id: string, vote: "up" | "down" | null, reason?: VoteReason | null, comment?: string): Promise<TourVote | null>;
  /** The MAVI suggests a step's balloon. */
  write(company: string, request: TourWriteRequest): Promise<TourWriteResult>;
}

async function server<T>(body: Record<string, unknown>): Promise<T> {
  const token = supabase ? (await supabase.auth.getSession()).data.session?.access_token : undefined;
  const res = await fetch("/api/drive", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(data.error ?? "Não foi possível falar com o servidor.");
  return data as T;
}

export const MAX_STEPS = 60;

export const emptyTour = (): TourContent => ({
  title: "",
  summary: "",
  steps: [],
  modules: [],
  aud_all: true,
  aud_roles: [],
  aud_teams: [],
  aud_users: [],
  aud_exclude: [],
  ...emptyReach(),
  trg_visit: false,
  trg_login: false,
});
export const emptyReach = (): TourReach => ({
  aud_squads: [],
  aud_clients: [],
  aud_products: [],
  scr_clients: [],
  scr_products: [],
});

/** What a tour being edited holds (its pending change, if there is one). */
export function tourContentOf(d: TourDetail): TourContent {
  if (d.draft) return { ...emptyTour(), ...d.draft.content };
  return {
    ...emptyTour(),
    ...(d.audience ?? {}),
    title: d.title,
    summary: d.summary,
    steps: d.steps,
    modules: d.modules,
  };
}

/** Who receives, in a few words (the publish confirmation). */
export function tourAudienceSummary(
  a: TourContent,
  data: Pick<Snapshot, "teams" | "members" | "clients" | "products">,
  squads: { id: string; name: string }[] = [],
) {
  const where = [
    ...a.scr_clients.map((c) => data.clients.find((x) => x.id === c)?.name ?? "Cliente"),
    ...a.scr_products.map((p) => data.products.find((x) => x.id === p)?.name ?? "Produto"),
  ];
  const only = where.length ? ` · só nas telas de ${list(where)}` : "";
  if (a.aud_all)
    return (
      (a.aud_exclude.length
        ? `Todos, menos ${a.aud_exclude.length === 1 ? "1 pessoa" : `${a.aud_exclude.length} pessoas`}`
        : "Todos") + only
    );
  const parts = [
    ...a.aud_roles.map((r) => ROLE_LABEL[r]),
    ...a.aud_teams.map((t) => data.teams.find((x) => x.id === t)?.name ?? "Equipe"),
    ...a.aud_squads.map((q) => squads.find((x) => x.id === q)?.name ?? "Squad"),
    ...a.aud_clients.map((c) => `quem atende ${data.clients.find((x) => x.id === c)?.name ?? "o cliente"}`),
    ...a.aud_products.map((p) => `quem atende ${data.products.find((x) => x.id === p)?.name ?? "o produto"}`),
    ...a.aud_users.map((u) => data.members.find((m) => m.user_id === u)?.name ?? "Pessoa"),
  ];
  return (parts.length ? list(parts) : "Ninguém escolhido ainda") + only;
}
const list = (parts: string[]) =>
  parts.length > 3 ? `${parts.slice(0, 3).join(", ")} e mais ${parts.length - 3}` : parts.join(", ");

/** A step inside a record: its screen has an id, or it points at a row. */
export const stepInRecord = (s: Pick<TourStep, "url" | "target">) =>
  screenShape(s.url).includes(":id") || /(^|\s)(tr|li)(\.|:|$|\s)/.test(s.target?.path ?? "");

/** The modules of the screens a tour goes through (the "?" of each shows it). */
export function tourModules(steps: TourStep[]) {
  const set = new Set<string>();
  for (const s of steps) {
    const m = tutorialModuleOf(s.page as Page);
    if (m) set.add(m);
  }
  return [...set].sort();
}

export const newStepId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36],
  ).join("");

export const STEP_KINDS: { id: TourStepKind; label: string; hint: string }[] = [
  { id: "next", label: "Botão “Próximo”", hint: "O balão explica e a pessoa avança pelo botão." },
  { id: "click", label: "Esperar o clique", hint: "Só avança quando a pessoa clica no elemento destacado." },
  { id: "input", label: "Esperar preencher", hint: "Só avança depois que a pessoa preenche ou escolhe algo no campo." },
  { id: "auto", label: "O tour clica sozinho", hint: "O próprio tour clica no elemento (abre o modal, a aba ou o menu) e segue." },
];
export const PLACEMENTS: { id: TourPlacement; label: string }[] = [
  { id: "auto", label: "Automática" },
  { id: "bottom", label: "Abaixo" },
  { id: "top", label: "Acima" },
  { id: "right", label: "À direita" },
  { id: "left", label: "À esquerda" },
];

// ------------------------------------------------------------ screens

/** Parameters that change what a screen shows (tabs, views). Filters don't. */
const SCREEN_PARAMS = ["aba", "visualizacao", "plataforma", "secao", "escopo", "relatorio"];

/** The screen of an address: path without the company, screen parameters and hash. */
export function screenOf(pathname: string, search: string, hash: string) {
  const path = routeParts(pathname).path;
  const params = new URLSearchParams(search);
  const kept = new URLSearchParams();
  for (const k of SCREEN_PARAMS) {
    const v = params.get(k);
    if (v) kept.set(k, v);
  }
  const q = kept.toString();
  return `${path}${q ? `?${q}` : ""}${hash && hash !== "#" ? hash : ""}`;
}
export const currentScreen = () =>
  screenOf(window.location.pathname, window.location.search, window.location.hash);
export const pageOfScreen = (url: string) => resolvePage(url.split(/[?#]/)[0]) ?? "";

/** What the screen on display says about whose it is (the database resolves the rest). */
export type TourScreenContext = {
  clients: string[];
  products: string[];
  contracts: string[];
  campaign: string | null;
  task: string | null;
};
export function screenContext(pathname: string, search: string): TourScreenContext {
  const params = new URLSearchParams(search);
  const ids = (...keys: string[]) =>
    keys
      .flatMap((k) => (params.get(k) ?? "").split(/[|,]/))
      .filter((v) => /^[0-9a-f-]{36}$/i.test(v))
      .slice(0, 20);
  return {
    clients: ids("cliente", "cli"),
    products: ids("produto"),
    contracts: ids("contrato"),
    campaign: campaignIdFromPath(pathname) ?? (ids("campanha")[0] || null),
    task: taskIdFromPath(pathname),
  };
}

const ID_SEGMENT = /[0-9a-f]{8}-[0-9a-f]{4}|\d{3,}|^demo-/i;
/**
 * The shape of an address: record ids (and what follows them, like the
 * task's title) become ":id", so /campanhas/A and /campanhas/B are the same
 * kind of screen and /tarefas (the list) is not /tarefas/<id>.
 */
export function screenShape(url: string) {
  const cut = url.search(/[?#]/);
  const path = cut < 0 ? url : url.slice(0, cut);
  const rest = cut < 0 ? "" : url.slice(cut);
  const out: string[] = [];
  for (const seg of path.split("/").filter(Boolean)) {
    if (out.includes(":id")) break;
    out.push(ID_SEGMENT.test(seg) ? ":id" : seg);
  }
  return `/${out.join("/")}${rest}`;
}
/** Whether the screen on display is the step's (or the same kind of screen). */
export function onStepScreen(current: string, stepUrl: string) {
  return current === stepUrl || screenShape(current) === screenShape(stepUrl);
}
/** The address to open a step's screen in a company. */
export function stepHref(url: string, companyPath: string) {
  return (companyPath ? `/agencias/${encodeURIComponent(companyPath)}` : "") + url;
}
export function pageLabel(page: string) {
  const p = page as Page;
  if (!(p in pagePaths)) return "Tela";
  return PAGE_LABELS[p] ?? "Tela";
}
const PAGE_LABELS: Partial<Record<Page, string>> = {
  overview: "Visão geral",
  tasks: "Tarefas",
  agenda: "Agenda",
  search: "Busca avançada",
  clients: "Clientes",
  products: "Produtos",
  contracts: "Produtos contratados",
  projects: "Projetos",
  campaigns: "Campanhas",
  financeMedia: "Financeiro › Mídia",
  financeMakeAdsRq: "Financeiro › Make Ads RQ",
  onboarding: "Planejamento › Social Leads",
  socialMedia: "Planejamento › Social Media",
  cases: "Cases de Sucesso",
  temperature: "Termômetro",
  radar: "Radar",
  personalRadar: "Radar pessoal",
  agents: "Agente Conversacional",
  notices: "Mural",
  inbox: "Caixa de entrada",
  hours: "Horas",
  reports: "Relatórios",
  drive: "Drive",
  storage: "Armazenamento",
  aiUsage: "Painel da MAVI",
  mavi: "MAVI",
  skills: "Skills",
  connections: "Conexões",
  identities: "Identidades visuais",
  dashboards: "Dashboards",
  customerSuccess: "Customer Success",
  tutorials: "Tutoriais",
  profile: "Perfil",
  person: "Perfil de pessoa",
  settings: "Configurações",
};

// ------------------------------------------------------------ balloon

export type Box = { left: number; top: number; width: number; height: number };
export type Side = "top" | "bottom" | "left" | "right" | "center";

/**
 * Where the balloon goes beside the element: the chosen side when it fits,
 * else the side with the most room; always inside the screen.
 */
export function placeBalloon(
  target: Box | null,
  size: { width: number; height: number },
  placement: TourPlacement,
  view: { width: number; height: number },
  gap = 14,
  margin = 12,
): { left: number; top: number; side: Side } {
  const clampX = (x: number) => Math.max(margin, Math.min(x, view.width - size.width - margin));
  const clampY = (y: number) => Math.max(margin, Math.min(y, view.height - size.height - margin));
  if (!target)
    return {
      left: clampX((view.width - size.width) / 2),
      top: clampY((view.height - size.height) / 2),
      side: "center",
    };
  const room = {
    bottom: view.height - (target.top + target.height) - gap,
    top: target.top - gap,
    right: view.width - (target.left + target.width) - gap,
    left: target.left - gap,
  };
  const fits = (s: Exclude<Side, "center">) =>
    s === "top" || s === "bottom" ? room[s] >= size.height : room[s] >= size.width;
  // The chosen side, then its opposite, then whatever has room.
  const opposite = { top: "bottom", bottom: "top", left: "right", right: "left" } as const;
  const order: Exclude<Side, "center">[] =
    placement === "auto"
      ? ["bottom", "top", "right", "left"]
      : [placement, opposite[placement], "bottom", "top", "right", "left"];
  let side = order.find(fits);
  if (!side) {
    // Nothing fits (a huge element): over it, at the bottom of the screen.
    return {
      left: clampX(target.left + target.width / 2 - size.width / 2),
      top: clampY(view.height - size.height - margin),
      side: "center",
    };
  }
  const cx = target.left + target.width / 2 - size.width / 2;
  const cy = target.top + target.height / 2 - size.height / 2;
  if (side === "bottom") return { left: clampX(cx), top: target.top + target.height + gap, side };
  if (side === "top") return { left: clampX(cx), top: target.top - gap - size.height, side };
  if (side === "right") return { left: target.left + target.width + gap, top: clampY(cy), side };
  side = "left";
  return { left: target.left - gap - size.width, top: clampY(cy), side };
}

// ------------------------------------------------------------ the layer's commands

export type TourCommand =
  | { action: "play"; id: string; from?: number }
  | { action: "edit"; id: string };
export const TOUR_EVENT = "mavi:tour";
export const playTour = (id: string, from = 0) =>
  window.dispatchEvent(new CustomEvent<TourCommand>(TOUR_EVENT, { detail: { action: "play", id, from } }));
export const editTour = (id: string) =>
  window.dispatchEvent(new CustomEvent<TourCommand>(TOUR_EVENT, { detail: { action: "edit", id } }));

// ------------------------------------------------------------ server

export const serverTours: ToursApi = {
  async list(company, scope, module, page, context) {
    return ((await rpc("list_tutorial_tours", {
      p_company: company,
      p_scope: scope,
      p_module: module ?? null,
      p_page: page ?? null,
      p_context: context ?? null,
    })) ?? []) as TourRow[];
  },
  async detail(id) {
    return (await rpc("tutorial_tour_detail", { p_tour: id })) as TourDetail | null;
  },
  async save(company, id, content, publish, revision) {
    return (await rpc("save_tutorial_tour", {
      p_company: company,
      p_tour: id,
      p_content: { ...content, modules: tourModules(content.steps) },
      p_publish: publish,
      p_revision: revision ?? null,
    })) as TourSaveResult;
  },
  async discardDraft(id) {
    await rpc("discard_tutorial_tour_draft", { p_tour: id });
  },
  async unpublish(id) {
    await rpc("unpublish_tutorial_tour", { p_tour: id });
  },
  async remove(id) {
    await rpc("delete_tutorial_tour", { p_tour: id });
  },
  async progress(id, action, step, stepId) {
    return (await rpc("set_tutorial_tour_progress", {
      p_tour: id,
      p_action: action,
      p_step: step,
      p_step_id: stepId,
    })) as TourProgress | null;
  },
  async miss(id, stepId, path) {
    await rpc("log_tutorial_tour_miss", { p_tour: id, p_step_id: stepId, p_path: path });
  },
  async autos(company) {
    return ((await rpc("my_auto_tutorial_tours", { p_company: company })) ?? []) as TourAuto[];
  },
  async metrics(id, version) {
    return (await rpc("tutorial_tour_metrics", { p_tour: id, p_version: version ?? null })) as TourMetrics | null;
  },
  async vote(id, vote, reason, comment) {
    return (await rpc("vote_tutorial_tour", {
      p_tour: id,
      p_vote: vote,
      p_reason: reason ?? null,
      p_comment: comment ?? null,
    })) as TourVote | null;
  },
  async write(company, request) {
    return server<TourWriteResult>({ action: "tour-write", company, ...request });
  },
};

// ------------------------------------------------------------ demo

type DemoTour = {
  id: string;
  live: TourContent;
  draft: TourContent | null;
  status: TourStatus;
  version: number;
  revision: number;
  created_by: string;
  updated_at: string;
  published_at: string | null;
  progress: TourProgress | null;
  misses: Record<string, number>;
  /** The demo's one person: steps reached and the vote. */
  reached?: string[];
  vote?: TourVote | null;
};
const DEMO_KEY = "mavi:demo:tours";
function demoRead(): DemoTour[] {
  try {
    return JSON.parse(localStorage.getItem(DEMO_KEY) ?? "[]") as DemoTour[];
  } catch {
    return [];
  }
}
function demoWrite(list: DemoTour[]) {
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(list));
  } catch {
    // Sem armazenamento: o demo vale até recarregar.
  }
  window.dispatchEvent(new CustomEvent("mavi:tutorials", { detail: { kind: "tutorials", tour: "" } }));
}
const demoFail = (message: string) => Promise.reject(Error(message));

/** The demo's tours: in this browser's storage (any page can read them). */
export function demoTours(user: string, userName = "Você"): ToursApi {
  const detailOf = (t: DemoTour): TourDetail => ({
    id: t.id,
    ...t.live,
    start_page: t.live.steps[0]?.page ?? "",
    status: t.status,
    version: t.version,
    revision: t.revision,
    audience: {
      aud_all: t.live.aud_all,
      aud_roles: t.live.aud_roles,
      aud_teams: t.live.aud_teams,
      aud_users: t.live.aud_users,
      aud_exclude: t.live.aud_exclude,
      ...emptyReach(),
      aud_squads: t.live.aud_squads ?? [],
      aud_clients: t.live.aud_clients ?? [],
      aud_products: t.live.aud_products ?? [],
      scr_clients: t.live.scr_clients ?? [],
      scr_products: t.live.scr_products ?? [],
      trg_visit: !!t.live.trg_visit,
      trg_login: !!t.live.trg_login,
    },
    created_by: t.created_by,
    author_name: userName,
    updated_at: t.updated_at,
    published_at: t.published_at,
    draft: t.draft ? { content: t.draft, saved_at: t.updated_at, saved_by_name: userName } : null,
    misses: Object.entries(t.misses).map(([step_id, misses]) => ({
      step_id,
      misses,
      people: 1,
      last_path: "",
      last_at: t.updated_at,
    })),
    progress: t.progress,
    can_edit: true,
  });
  return {
    async list(_company, scope, module, page) {
      return demoRead()
        .filter((t) => scope === "admin" || t.status === "published")
        .filter((t) =>
          !module && !page
            ? true
            : (!!module && t.live.modules.includes(module)) || (!!page && t.live.steps[0]?.page === page),
        )
        .map((t) => ({
          id: t.id,
          title: (scope === "admin" && t.draft?.title) || t.live.title,
          summary: t.live.summary,
          modules: t.live.modules,
          start_page: t.live.steps[0]?.page ?? "",
          step_count: t.live.steps.length,
          status: t.status,
          version: t.version,
          has_draft: !!t.draft,
          aud_all: t.live.aud_all,
          created_by: t.created_by,
          author_name: userName,
          updated_at: t.updated_at,
          published_at: t.published_at,
          can_edit: true,
          my_status: t.progress?.status ?? null,
          my_step: t.progress?.step ?? null,
          misses: Object.values(t.misses).reduce((a, b) => a + b, 0),
          screen_only: !!(t.live.scr_clients?.length || t.live.scr_products?.length),
        }));
    },
    async detail(id) {
      const t = demoRead().find((x) => x.id === id);
      return t ? detailOf(t) : null;
    },
    async save(_company, id, content, publish, revision) {
      if (content.title.trim().length < 3) return demoFail("Dê um nome de 3 a 160 caracteres ao onboarding.");
      if (publish && !content.steps.length) return demoFail("Adicione ao menos um passo antes de publicar.");
      const list = demoRead();
      const clean = { ...content, modules: tourModules(content.steps) };
      const now = new Date().toISOString();
      let t = id ? list.find((x) => x.id === id) : undefined;
      if (id && !t) return demoFail("Onboarding não encontrado.");
      if (t && revision != null && revision !== t.revision)
        return demoFail("Este onboarding foi alterado por outra pessoa. Abra de novo para ver a versão atual.");
      let mode: TourSaveResult["mode"];
      if (!t) {
        t = {
          id: crypto.randomUUID(),
          live: clean,
          draft: null,
          status: "draft",
          version: 0,
          revision: 1,
          created_by: user,
          updated_at: now,
          published_at: null,
          progress: null,
          misses: {},
        };
        list.unshift(t);
        mode = "created";
      } else {
        t.revision += 1;
        if (t.status === "published" && !publish) {
          t.draft = clean;
          mode = "draft";
        } else {
          t.live = clean;
          t.draft = null;
          mode = "saved";
        }
      }
      if (publish) {
        t.live = clean;
        t.draft = null;
        t.status = "published";
        t.version += 1;
        t.published_at = now;
        t.misses = {};
        mode = "published";
      }
      t.updated_at = now;
      demoWrite(list);
      return { id: t.id, mode, status: t.status, version: t.version, revision: t.revision };
    },
    async discardDraft(id) {
      const list = demoRead();
      const t = list.find((x) => x.id === id);
      if (t) {
        t.draft = null;
        t.revision += 1;
      }
      demoWrite(list);
    },
    async unpublish(id) {
      const list = demoRead();
      const t = list.find((x) => x.id === id);
      if (t) {
        if (t.draft) t.live = t.draft;
        t.draft = null;
        t.status = "draft";
        t.revision += 1;
      }
      demoWrite(list);
    },
    async remove(id) {
      demoWrite(demoRead().filter((x) => x.id !== id));
    },
    async progress(id, action, step, stepId) {
      const list = demoRead();
      const t = list.find((x) => x.id === id);
      if (!t || t.status !== "published") return null;
      const prev = t.progress;
      const at = action === "start" ? 0 : Math.max(0, Math.min(step, t.live.steps.length - 1));
      if (action !== "dismiss" && t.live.steps[at]) t.reached = [...new Set([...(t.reached ?? []), t.live.steps[at].id])];
      t.progress = {
        status:
          action === "complete"
            ? "completed"
            : action === "dismiss"
              ? "dismissed"
              : action === "step" && prev?.status === "completed"
                ? "completed"
                : "started",
        step: action === "start" ? 0 : Math.max(0, Math.min(step, t.live.steps.length - 1)),
        step_id: stepId,
        version: t.version,
        completed_at: action === "complete" ? new Date().toISOString() : (prev?.completed_at ?? null),
      };
      demoWrite(list);
      return t.progress;
    },
    async miss(id, stepId) {
      const list = demoRead();
      const t = list.find((x) => x.id === id);
      if (!t) return;
      t.misses[stepId] = (t.misses[stepId] ?? 0) + 1;
      demoWrite(list);
    },
    async metrics(id) {
      const t = demoRead().find((x) => x.id === id);
      if (!t) return null;
      const p = t.progress;
      const reached = new Set(t.reached ?? []);
      return {
        version: t.version,
        versions: Array.from({ length: t.version }, (_, i) => t.version - i),
        started: reached.size ? 1 : 0,
        completed: p?.status === "completed" ? 1 : 0,
        dismissed: p?.status === "dismissed" ? 1 : 0,
        in_progress: p?.status === "started" ? 1 : 0,
        steps: t.live.steps.map((s, i) => ({
          step_id: s.id,
          n: i + 1,
          title: s.title,
          kind: s.kind,
          page: s.page,
          reached: reached.has(s.id) ? 1 : 0,
          stopped: p?.status === "dismissed" && p.step_id === s.id ? 1 : 0,
          misses: t.misses[s.id] ?? 0,
        })),
        up: t.vote?.vote === "up" ? 1 : 0,
        down: t.vote?.vote === "down" ? 1 : 0,
        feedback:
          t.vote && (t.vote.vote === "down" || t.vote.comment)
            ? [{ vote: t.vote.vote, reason: t.vote.reason, comment: t.vote.comment, name: userName, at: t.updated_at }]
            : [],
      };
    },
    async vote(id, vote, reason, comment) {
      const list = demoRead();
      const t = list.find((x) => x.id === id);
      if (!t) return null;
      t.vote = vote
        ? { vote, reason: vote === "down" ? (reason ?? null) : null, comment: (comment ?? "").trim(), version: t.version }
        : null;
      demoWrite(list);
      return t.vote;
    },
    async write(_company, r) {
      await new Promise((ok) => setTimeout(ok, 600));
      const name = r.element.replace(/^[^“]*“|”.*$/g, "") || "este item";
      return {
        title: r.kind === "click" ? `Clique em ${name}` : r.kind === "input" ? `Preencha ${name}` : `Conheça ${name}`,
        blocks: [
          {
            type: "paragraph",
            text:
              r.kind === "click"
                ? `Aqui você começa. Clique em **${name}** para continuar.`
                : `Este é o lugar de **${name}** na tela ${r.screen}. [confirmar: o que a equipe faz aqui]`,
          },
        ],
        notes: "Texto de demonstração.",
      };
    },
    async autos() {
      return demoRead()
        .filter(
          (t) =>
            t.status === "published" && (t.live.trg_visit || t.live.trg_login) && t.live.steps.length && !t.progress,
        )
        .map((t) => ({
          id: t.id,
          title: t.live.title,
          start_page: t.live.steps[0]?.page ?? "",
          trg_visit: !!t.live.trg_visit,
          trg_login: !!t.live.trg_login,
          screen_only: !!(t.live.scr_clients?.length || t.live.scr_products?.length),
        }));
    },
  };
}

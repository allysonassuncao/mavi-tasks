import { rpc } from "./api";
import { fold } from "./domain";
import type { TutorialAudience, TutorialsApi } from "./tutorials";
import { demoTours } from "./tours";
import type { Role, Snapshot } from "./types";

/**
 * Trilhas dos Tutoriais (migração 20270424090000_tutorial_trails): listas
 * ordenadas de tutoriais, opcionais ou obrigatórias (para quem entra a partir
 * de agora e/ou um público), com prazo opcional e o progresso de cada pessoa.
 * O progresso é por tutorial: concluir um vale em todas as trilhas que o têm.
 * A demonstração guarda as trilhas em memória.
 */

export type TrailStatus = "draft" | "published";
/** Quem é obrigado (as exclusões de "quem vê" valem também aqui). */
export interface TrailRequired {
  req_newcomers: boolean;
  req_all: boolean;
  req_roles: Role[];
  req_teams: string[];
  req_users: string[];
}
export interface TrailContent extends TutorialAudience, TrailRequired {
  title: string;
  summary: string;
  sequential: boolean;
  /** Os tutoriais, na ordem. */
  tutorials: string[];
  due_days: number | null;
}
export interface TrailRow {
  id: string;
  title: string;
  summary: string;
  sequential: boolean;
  status: TrailStatus;
  aud_all: boolean;
  required: boolean;
  due_days: number | null;
  for_me: boolean;
  required_for_me: boolean;
  assigned_at: string | null;
  due_at: string | null;
  total: number;
  done: number;
  next_tutorial: string | null;
  can_edit: boolean;
  created_by: string;
  author_name: string;
  updated_at: string;
  /** Líderes: quantas pessoas têm a trilha, concluíram e estão atrasadas. */
  people: number | null;
  people_done: number | null;
  people_overdue: number | null;
}
export interface TrailItem {
  /** "tour": an onboarding (tutorial_id carries its id). Missing: a tutorial. */
  kind?: "tutorial" | "tour";
  tutorial_id: string;
  title: string;
  summary: string;
  modules: string[];
  status: "draft" | "published";
  version: number;
  aud_all: boolean;
  /** A pessoa tem este tutorial (publicado e no público dela). */
  visible: boolean;
  completed_at: string | null;
  completed_version: number | null;
  video_count: number;
  /** Onboardings: how many steps and where the person stopped. */
  step_count?: number;
  my_status?: string | null;
  my_step?: number | null;
}
export interface TrailDetail {
  id: string;
  company_id: string;
  title: string;
  summary: string;
  sequential: boolean;
  status: TrailStatus;
  revision: number;
  required: boolean;
  due_days: number | null;
  created_by: string;
  author_name: string;
  updated_at: string;
  published_at: string | null;
  for_me: boolean;
  required_for_me: boolean;
  assigned_at: string | null;
  due_at: string | null;
  total: number;
  done: number;
  /** Quem edita e os líderes: quem vê e quem é obrigado. */
  config: (TutorialAudience & TrailRequired & { req_since: string | null }) | null;
  items: TrailItem[];
  can_edit: boolean;
}
export type PersonState = "overdue" | "todo" | "progress" | "done";
export interface TrailPerson {
  user_id: string;
  name: string;
  required: boolean;
  assigned_at: string | null;
  due_at: string | null;
  total: number;
  done: number;
  last_done_at: string | null;
  done_ids: string[];
  state: PersonState;
}
export type TrailSaveResult = { id: string; status: TrailStatus; revision: number };

export const MAX_TRAIL_TUTORIALS = 50;
/** Where a trail opens inside Tutoriais (?trilha=<id>). */
export const TRAIL_PARAM = "trilha";

export const emptyTrail = (): TrailContent => ({
  title: "",
  summary: "",
  sequential: false,
  tutorials: [],
  aud_all: true,
  aud_roles: [],
  aud_teams: [],
  aud_users: [],
  aud_exclude: [],
  req_newcomers: false,
  req_all: false,
  req_roles: [],
  req_teams: [],
  req_users: [],
  due_days: null,
});

export const hasRequired = (r: TrailRequired) =>
  r.req_newcomers ||
  r.req_all ||
  r.req_roles.length + r.req_teams.length + r.req_users.length > 0;

/** What a trail being edited holds. */
export function trailContentOf(d: TrailDetail): TrailContent {
  const c = d.config;
  return {
    ...emptyTrail(),
    title: d.title,
    summary: d.summary,
    sequential: d.sequential,
    tutorials: d.items.map((i) => i.tutorial_id),
    due_days: d.due_days,
    ...(c
      ? {
          aud_all: c.aud_all,
          aud_roles: c.aud_roles,
          aud_teams: c.aud_teams,
          aud_users: c.aud_users,
          aud_exclude: c.aud_exclude,
          req_newcomers: c.req_newcomers,
          req_all: c.req_all,
          req_roles: c.req_roles,
          req_teams: c.req_teams,
          req_users: c.req_users,
        }
      : {}),
  };
}

/** The state of each tutorial in a trail, for the person reading it. */
export type ItemState = "done" | "updated" | "next" | "open" | "locked" | "hidden";
/**
 * Done (or "updated": a newer version came out after), the next one to read,
 * open to read, or locked (sequential trails: an earlier one is not done).
 * "hidden": the person doesn't have it (only who edits sees these).
 */
export function itemStates(trail: Pick<TrailDetail, "sequential">, items: TrailItem[]): ItemState[] {
  let blocked = false;
  let nextGiven = false;
  return items.map((i) => {
    if (!i.visible) return "hidden";
    if (i.completed_at)
      return i.completed_version != null && i.version > i.completed_version ? "updated" : "done";
    if (blocked) return "locked";
    if (trail.sequential) blocked = true;
    if (!nextGiven) {
      nextGiven = true;
      return "next";
    }
    return "open";
  });
}

/** The tutorial after `current` that the person has, in the trail's order. */
export function nextInTrail(items: TrailItem[], current: string) {
  const visible = items.filter((i) => i.visible);
  const at = visible.findIndex((i) => i.tutorial_id === current);
  return at < 0 ? null : (visible[at + 1] ?? null);
}

export const percent = (done: number, total: number) =>
  total > 0 ? Math.round((done / total) * 100) : 0;

const DAY = 86400_000;
/** "vence hoje", "vence em 3 dias", "atrasada há 2 dias" (dias corridos, no fuso de São Paulo). */
export function dueLabel(due: string | null, now = new Date()) {
  if (!due) return null;
  const day = (d: Date) =>
    Date.parse(d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }));
  const days = Math.round((day(new Date(due)) - day(now)) / DAY);
  const late = new Date(due).getTime() < now.getTime();
  if (late)
    return {
      late: true,
      text: days >= 0 ? "atrasada" : days === -1 ? "atrasada há 1 dia" : `atrasada há ${-days} dias`,
    };
  return {
    late: false,
    text: days <= 0 ? "vence hoje" : days === 1 ? "vence amanhã" : `vence em ${days} dias`,
  };
}

export const PERSON_STATE: Record<PersonState, string> = {
  overdue: "Atrasada",
  todo: "Não começou",
  progress: "Em andamento",
  done: "Concluída",
};

/** Who must do it, in a few words. */
export function requiredSummary(
  r: TrailRequired,
  data: Pick<Snapshot, "teams" | "members">,
) {
  const roles: Record<Role, string> = {
    admin: "administradores",
    manager: "gestores",
    member: "colaboradores",
  };
  const parts = [
    ...(r.req_newcomers ? ["quem entrar a partir de agora"] : []),
    ...(r.req_all ? ["todos da agência"] : []),
    ...r.req_roles.map((x) => roles[x]),
    ...r.req_teams.map((t) => `equipe ${data.teams.find((x) => x.id === t)?.name ?? ""}`.trim()),
    ...r.req_users.map((u) => data.members.find((m) => m.user_id === u)?.name ?? "pessoa"),
  ];
  return parts.length > 3
    ? `${parts.slice(0, 3).join(", ")} e mais ${parts.length - 3}`
    : parts.join(", ");
}

// ------------------------------------------------------------ server calls

export interface TrailsApi {
  list(company: string): Promise<TrailRow[]>;
  detail(id: string): Promise<TrailDetail | null>;
  save(
    company: string,
    id: string | null,
    content: TrailContent,
    publish: boolean,
    revision?: number | null,
  ): Promise<TrailSaveResult>;
  unpublish(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  people(id: string): Promise<TrailPerson[]>;
  pending(company: string): Promise<number>;
}

export const serverTrails: TrailsApi = {
  async list(company) {
    return ((await rpc("list_tutorial_trails", { p_company: company })) ?? []) as TrailRow[];
  },
  async detail(id) {
    return (await rpc("tutorial_trail_detail", { p_trail: id })) as TrailDetail | null;
  },
  async save(company, id, content, publish, revision) {
    return (await rpc("save_tutorial_trail", {
      p_company: company,
      p_trail: id,
      p_content: content,
      p_publish: publish,
      p_revision: revision ?? null,
    })) as TrailSaveResult;
  },
  async unpublish(id) {
    await rpc("unpublish_tutorial_trail", { p_trail: id });
  },
  async remove(id) {
    await rpc("delete_tutorial_trail", { p_trail: id });
  },
  async people(id) {
    return ((await rpc("tutorial_trail_progress", { p_trail: id })) ?? []) as TrailPerson[];
  },
  async pending(company) {
    return ((await rpc("my_tutorial_trails_pending", { p_company: company })) ?? 0) as number;
  },
};

// ------------------------------------------------------------ demo

type DemoTrail = TrailContent & {
  id: string;
  status: TrailStatus;
  revision: number;
  created_by: string;
  updated_at: string;
  published_at: string | null;
  assigned_at: string | null;
};
let demoTrailStore: DemoTrail[] | null = null;

/**
 * Trails kept in memory for the demonstration. Progress comes from the
 * demo tutorials (tutorials.progress), so only the person on screen has any.
 */
export function demoTrails(data: Snapshot, user: string, tutorials: TutorialsApi): TrailsApi {
  const me = data.members.find((m) => m.user_id === user);
  const role = me?.role ?? "member";
  const admin = role === "admin";
  const leader = admin || role === "manager";
  const name = (id: string) => data.members.find((m) => m.user_id === id)?.name ?? "Alguém";
  const now = () => new Date().toISOString();
  if (!demoTrailStore) {
    const author = data.members.find((m) => m.role === "admin")?.user_id ?? user;
    demoTrailStore = [
      {
        ...emptyTrail(),
        id: "demo-trilha-boas-vindas",
        title: "Boas-vindas à agência",
        summary: "O básico para o primeiro dia: tarefas, busca e a MAVI.",
        sequential: true,
        tutorials: ["demo-tutorial-tarefas", "demo-tutorial-busca", "demo-tutorial-mavi"],
        req_all: true,
        due_days: 7,
        status: "published",
        revision: 1,
        created_by: author,
        updated_at: now(),
        published_at: now(),
        assigned_at: new Date(Date.now() - 2 * DAY).toISOString(),
      },
    ];
  }
  const store = demoTrailStore;
  const myTeams = data.teamMembers.filter((t) => t.user_id === user).map((t) => t.team_id);
  const inAud = (all: boolean, roles: Role[], teams: string[], users: string[]) =>
    all || users.includes(user) || roles.includes(role) || teams.some((t) => myTeams.includes(t));
  const required = (t: DemoTrail) =>
    t.status === "published" &&
    !t.aud_exclude.includes(user) &&
    inAud(t.req_all, t.req_roles, t.req_teams, t.req_users);
  const forMe = (t: DemoTrail) =>
    t.status === "published" &&
    (required(t) ||
      (!t.aud_exclude.includes(user) && inAud(t.aud_all, t.aud_roles, t.aud_teams, t.aud_users)));
  const canEdit = (t: DemoTrail) => admin || (leader && t.created_by === user);
  const canSee = (t: DemoTrail) => canEdit(t) || (leader && t.status === "published") || forMe(t);
  const find = (id: string) => {
    const t = store.find((x) => x.id === id);
    if (!t || !canEdit(t)) throw Error("Sem permissão");
    return t;
  };
  const items = async (t: DemoTrail): Promise<TrailItem[]> => {
    const out: TrailItem[] = [];
    for (const id of t.tutorials) {
      const d = await tutorials.detail(id);
      if (!d) {
        // Um onboarding (os do demo ficam neste navegador).
        const o = await demoTours(user).detail(id);
        if (!o || (o.status !== "published" && !canEdit(t))) continue;
        const done = o.progress?.status === "completed";
        out.push({
          kind: "tour",
          tutorial_id: o.id,
          title: o.title,
          summary: o.summary,
          modules: o.modules,
          status: o.status,
          version: o.version,
          aud_all: o.audience?.aud_all ?? true,
          visible: o.status === "published",
          completed_at: done ? (o.progress?.completed_at ?? new Date().toISOString()) : null,
          completed_version: done ? (o.progress?.version ?? o.version) : null,
          video_count: 0,
          step_count: o.steps.length,
          my_status: o.progress?.status ?? null,
          my_step: o.progress?.step ?? null,
        });
        continue;
      }
      const visible = d.status === "published" && d.trackable !== false;
      if (!visible && !canEdit(t)) continue;
      out.push({
        tutorial_id: d.id,
        title: d.title,
        summary: d.summary,
        modules: d.modules,
        status: d.status,
        version: d.version,
        aud_all: d.audience?.aud_all ?? true,
        visible,
        completed_at: d.progress?.completed_at ?? null,
        completed_version: d.progress?.completed_version ?? null,
        video_count: d.media.length,
      });
    }
    return out;
  };
  const dueAt = (t: DemoTrail) =>
    required(t) && t.due_days && t.assigned_at
      ? new Date(new Date(t.assigned_at).getTime() + t.due_days * DAY).toISOString()
      : null;
  const counts = (list: TrailItem[]) => {
    const visible = list.filter((i) => i.visible);
    return {
      total: visible.length,
      done: visible.filter((i) => i.completed_at).length,
      next: visible.find((i) => !i.completed_at)?.tutorial_id ?? null,
    };
  };
  return {
    async list() {
      const rows: TrailRow[] = [];
      for (const t of store.filter(canSee)) {
        const c = counts(await items(t));
        const isDone = c.total > 0 && c.done === c.total;
        rows.push({
          id: t.id,
          title: t.title,
          summary: t.summary,
          sequential: t.sequential,
          status: t.status,
          aud_all: t.aud_all,
          required: hasRequired(t),
          due_days: t.due_days,
          for_me: forMe(t),
          required_for_me: required(t),
          assigned_at: required(t) ? t.assigned_at : null,
          due_at: dueAt(t),
          total: c.total,
          done: c.done,
          next_tutorial: c.next,
          can_edit: canEdit(t),
          created_by: t.created_by,
          author_name: name(t.created_by),
          updated_at: t.updated_at,
          people: leader && t.status === "published" ? 1 : null,
          people_done: leader && t.status === "published" ? (isDone ? 1 : 0) : null,
          people_overdue: null,
        });
      }
      return rows.sort(
        (a, b) =>
          Number(b.required_for_me && b.done < b.total) - Number(a.required_for_me && a.done < a.total) ||
          a.title.localeCompare(b.title, "pt-BR"),
      );
    },
    async detail(id) {
      const t = store.find((x) => x.id === id);
      if (!t || !canSee(t)) return null;
      const list = await items(t);
      const c = counts(list);
      return {
        id: t.id,
        company_id: data.companies[0]?.id ?? "",
        title: t.title,
        summary: t.summary,
        sequential: t.sequential,
        status: t.status,
        revision: t.revision,
        required: hasRequired(t),
        due_days: t.due_days,
        created_by: t.created_by,
        author_name: name(t.created_by),
        updated_at: t.updated_at,
        published_at: t.published_at,
        for_me: forMe(t),
        required_for_me: required(t),
        assigned_at: required(t) ? t.assigned_at : null,
        due_at: dueAt(t),
        total: c.total,
        done: c.done,
        config:
          canEdit(t) || leader
            ? {
                aud_all: t.aud_all,
                aud_roles: t.aud_roles,
                aud_teams: t.aud_teams,
                aud_users: t.aud_users,
                aud_exclude: t.aud_exclude,
                req_newcomers: t.req_newcomers,
                req_since: null,
                req_all: t.req_all,
                req_roles: t.req_roles,
                req_teams: t.req_teams,
                req_users: t.req_users,
              }
            : null,
        items: list,
        can_edit: canEdit(t),
      };
    },
    async save(_company, id, content, publish, revision) {
      if (!leader) throw Error("Só administradores e gestores montam trilhas.");
      const title = content.title.replace(/\s+/g, " ").trim();
      if (title.length < 3 || title.length > 120)
        throw Error("Dê um título de 3 a 120 caracteres à trilha.");
      const existing = id ? find(id) : null;
      if (existing && revision != null && revision !== existing.revision)
        throw Error("Esta trilha foi alterada por outra pessoa. Abra de novo para ver a versão atual.");
      if ((publish || existing?.status === "published") && !content.tutorials.length)
        throw Error("Escolha ao menos um tutorial para a trilha.");
      const t: DemoTrail = existing ?? {
        ...emptyTrail(),
        id: crypto.randomUUID(),
        status: "draft",
        revision: 0,
        created_by: user,
        updated_at: now(),
        published_at: null,
        assigned_at: null,
      };
      Object.assign(t, content, {
        title,
        tutorials: [...new Set(content.tutorials)].slice(0, MAX_TRAIL_TUTORIALS),
        due_days: hasRequired(content) ? content.due_days : null,
        status: publish ? "published" : t.status,
        published_at: publish ? (t.published_at ?? now()) : t.published_at,
        revision: t.revision + 1,
        updated_at: now(),
      });
      if (t.status === "published" && required(t) && !t.assigned_at) t.assigned_at = now();
      if (!existing) store.unshift(t);
      return { id: t.id, status: t.status, revision: t.revision };
    },
    async unpublish(id) {
      const t = find(id);
      t.status = "draft";
      t.revision++;
    },
    async remove(id) {
      store.splice(store.indexOf(find(id)), 1);
    },
    async people(id) {
      const t = store.find((x) => x.id === id);
      if (!t || !leader || !canSee(t) || !forMe(t)) return [];
      const list = await items(t);
      const c = counts(list);
      const due = dueAt(t);
      const state: PersonState =
        c.total > 0 && c.done === c.total
          ? "done"
          : due && Date.parse(due) < Date.now()
            ? "overdue"
            : c.done
              ? "progress"
              : "todo";
      return [
        {
          user_id: user,
          name: name(user),
          required: required(t),
          assigned_at: t.assigned_at,
          due_at: due,
          total: c.total,
          done: c.done,
          last_done_at: null,
          done_ids: list.filter((i) => i.completed_at).map((i) => i.tutorial_id),
          state,
        },
      ];
    },
    async pending() {
      let n = 0;
      for (const t of store.filter(required)) {
        const c = counts(await items(t));
        if (!(c.total > 0 && c.done === c.total)) n++;
      }
      return n;
    },
  };
}

/** Tutorials matching the words typed (to add to a trail), without accents. */
export const matchesWords = (text: string, query: string) => {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const hay = fold(text);
  return words.every((w) => hay.includes(w));
};

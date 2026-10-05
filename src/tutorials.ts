import { rpc } from "./api";
import { supabase } from "./supabase";
import { fold } from "./domain";
import { MODULES, moduleOf } from "./modules";
import type { Page } from "./router";
import { DESCRIPTION_PREFIX, richTextPlain, type RichNode } from "./rich-text";
import type { Role, Snapshot } from "./types";

/**
 * Tutoriais: the calls the page makes and the helpers around them. Everything
 * goes through the database functions of migration 20270415090000_tutorials
 * (the tables have no direct reads: each tutorial has its own audience);
 * videos go through /api/drive ("tutorial-*", api/_tutorials.ts), which
 * signs GCS URLs. The demo keeps its tutorials in memory.
 */

export type TutorialStatus = "draft" | "published";
export type TutorialScope = "library" | "admin";

export interface TutorialAudience {
  aud_all: boolean;
  aud_roles: Role[];
  aud_teams: string[];
  aud_users: string[];
  aud_exclude: string[];
}
export interface TutorialContent extends TutorialAudience {
  title: string;
  summary: string;
  /** Rich text (mavi:richtext:v1:…), with sections, images and videos. */
  body: string;
  modules: string[];
  category: string;
  tags: string[];
}
export interface TutorialRow {
  id: string;
  title: string;
  summary: string;
  modules: string[];
  category: string;
  tags: string[];
  status: TutorialStatus;
  version: number;
  has_draft: boolean;
  aud_all: boolean;
  created_by: string;
  author_name: string;
  updated_by_name: string;
  published_at: string | null;
  updated_at: string;
  video_count: number;
  can_edit: boolean;
  total: number;
}
export interface TutorialMedia {
  id: string;
  name: string;
  content_type: string;
  size_bytes: number;
}
export interface TutorialDetail {
  id: string;
  company_id: string;
  title: string;
  summary: string;
  body: string;
  modules: string[];
  category: string;
  tags: string[];
  status: TutorialStatus;
  version: number;
  revision: number;
  /** Only for who edits. */
  audience: TutorialAudience | null;
  created_by: string;
  author_name: string;
  updated_by_name: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  media: TutorialMedia[];
  /** The change of a published tutorial not yet published (who edits). */
  draft: {
    content: TutorialContent;
    saved_at: string;
    saved_by_name: string;
  } | null;
  can_edit: boolean;
}
export interface TutorialVersionRow {
  version: number;
  title: string;
  published_by_name: string;
  published_at: string;
  restored_from: number | null;
}
export type TutorialVersion = TutorialContent & {
  version: number;
  published_at: string;
  published_by_name: string;
  restored_from: number | null;
};
export type TutorialSaveResult = {
  id: string;
  mode: "created" | "saved" | "draft" | "published";
  status: TutorialStatus;
  version: number;
  revision: number;
};
export type TutorialFacet = {
  kind: "category" | "tag";
  value: string;
  tutorials: number;
};
export type TutorialQuery = {
  scope: TutorialScope;
  query: string;
  module: string;
  category: string;
  tags: string[];
  limit: number;
  offset: number;
};

export const VIDEO_MAX_BYTES = 524_288_000;
export const MAX_TAGS = 12;
export const MAX_MODULES = 12;
/** Where a tutorial opens inside the app (?tutorial=<id>#secao). */
export const TUTORIAL_PARAM = "tutorial";

export const emptyTutorial = (): TutorialContent => ({
  title: "",
  summary: "",
  body: "",
  modules: [],
  category: "",
  tags: [],
  aud_all: true,
  aud_roles: [],
  aud_teams: [],
  aud_users: [],
  aud_exclude: [],
});

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Administradores",
  manager: "Gestores",
  member: "Colaboradores",
};

/** Screens outside "Módulos visíveis" that also have tutorials. */
const EXTRA_MODULES = [
  { id: "inbox", label: "Caixa de entrada" },
  { id: "profile", label: "Meu perfil" },
  { id: "settings", label: "Equipe e configurações" },
] as const;
/** The modules a tutorial can be about (the "?" of each screen opens them). */
export const TUTORIAL_MODULES: { id: string; label: string }[] = [
  ...MODULES.map((m) =>
    m.id === "assistant" ? { id: m.id, label: "MAVI" } : { id: m.id, label: m.label },
  ),
  ...EXTRA_MODULES,
];
export const moduleLabel = (id: string) =>
  TUTORIAL_MODULES.find((m) => m.id === id)?.label ?? id;
/** The module of the page on screen, for the "?" (none: no module). */
export function tutorialModuleOf(page: Page | null | undefined): string | null {
  if (!page || page === "tutorials") return null;
  const module = moduleOf(page);
  if (module) return module;
  return EXTRA_MODULES.some((m) => m.id === page) ? page : null;
}

export const cleanLabel = (value: string) =>
  value.replace(/\s+/g, " ").trim();
/** Adds a tag once (same words without accents count as the same). */
export function addTag(list: string[], value: string, known: string[]) {
  const v = cleanLabel(value);
  if (!v || list.some((t) => fold(t) === fold(v))) return list;
  return [...list, known.find((k) => fold(k) === fold(v)) ?? v];
}

/** Who sees, in a few words (the list and the reading page). */
export function audienceSummary(
  a: TutorialAudience,
  data: Pick<Snapshot, "teams" | "members">,
) {
  if (a.aud_all)
    return a.aud_exclude.length
      ? `Todos, menos ${a.aud_exclude.length === 1 ? "1 pessoa" : `${a.aud_exclude.length} pessoas`}`
      : "Todos";
  const parts = [
    ...a.aud_roles.map((r) => ROLE_LABEL[r]),
    ...a.aud_teams.map(
      (t) => data.teams.find((x) => x.id === t)?.name ?? "Equipe",
    ),
    ...a.aud_users.map(
      (u) => data.members.find((m) => m.user_id === u)?.name ?? "Pessoa",
    ),
  ];
  return parts.length > 3
    ? `${parts.slice(0, 3).join(", ")} e mais ${parts.length - 3}`
    : parts.join(", ");
}

/** Minutes to read (200 words a minute), at least 1. */
export function readingMinutes(body: string) {
  const words = richTextPlain(body).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

/** The uploaded videos a text uses (to sign their links at once). */
export function videoIds(body: string): string[] {
  if (!body.startsWith(DESCRIPTION_PREFIX)) return [];
  const ids = new Set<string>();
  const walk = (n: RichNode) => {
    if (n.type === "tutorialVideo" && n.attrs?.mediaId) ids.add(n.attrs.mediaId);
    n.content?.forEach(walk);
  };
  try {
    walk(JSON.parse(body.slice(DESCRIPTION_PREFIX.length)) as RichNode);
  } catch {
    return [];
  }
  return [...ids];
}

/** What a tutorial being edited holds (its draft, if there is one). */
export function contentOf(d: TutorialDetail): TutorialContent {
  if (d.draft) return { ...emptyTutorial(), ...d.draft.content };
  return {
    title: d.title,
    summary: d.summary,
    body: d.body,
    modules: d.modules,
    category: d.category,
    tags: d.tags,
    ...audienceOf(d.audience ?? emptyTutorial()),
  };
}
/** Only the audience of a tutorial (or of its content). */
export const audienceOf = (a: TutorialAudience): TutorialAudience => ({
  aud_all: a.aud_all,
  aud_roles: a.aud_roles,
  aud_teams: a.aud_teams,
  aud_users: a.aud_users,
  aud_exclude: a.aud_exclude,
});

// ------------------------------------------------------------ server calls

async function server<T>(body: Record<string, unknown>): Promise<T> {
  const token = supabase
    ? (await supabase.auth.getSession()).data.session?.access_token
    : undefined;
  const res = await fetch("/api/drive", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw Error(data.error ?? "Não foi possível falar com o servidor.");
  return data as T;
}

export interface TutorialsApi {
  list(company: string, q: TutorialQuery): Promise<TutorialRow[]>;
  facets(company: string): Promise<TutorialFacet[]>;
  detail(id: string): Promise<TutorialDetail | null>;
  save(
    company: string,
    id: string | null,
    content: TutorialContent,
    publish: boolean,
    revision?: number | null,
  ): Promise<TutorialSaveResult>;
  discardDraft(id: string): Promise<void>;
  unpublish(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  versions(id: string): Promise<TutorialVersionRow[]>;
  version(id: string, version: number): Promise<TutorialVersion | null>;
  restore(id: string, version: number): Promise<TutorialSaveResult>;
  upload(
    tutorial: string,
    file: File,
    onProgress: (fraction: number) => void,
  ): Promise<string>;
  mediaUrls(ids: string[]): Promise<Record<string, string>>;
}

export const serverTutorials: TutorialsApi = {
  async list(company, q) {
    return ((await rpc("list_tutorials", {
      p_company: company,
      p_query: q.query,
      p_module: q.module || null,
      p_category: q.category || null,
      p_tags: q.tags.length ? q.tags : null,
      p_scope: q.scope,
      p_limit: q.limit,
      p_offset: q.offset,
    })) ?? []) as TutorialRow[];
  },
  async facets(company) {
    return ((await rpc("tutorial_facets", { p_company: company })) ??
      []) as TutorialFacet[];
  },
  async detail(id) {
    return (await rpc("tutorial_detail", {
      p_tutorial: id,
    })) as TutorialDetail | null;
  },
  async save(company, id, content, publish, revision) {
    return (await rpc("save_tutorial", {
      p_company: company,
      p_tutorial: id,
      p_content: content,
      p_publish: publish,
      p_revision: revision ?? null,
    })) as TutorialSaveResult;
  },
  async discardDraft(id) {
    await rpc("discard_tutorial_draft", { p_tutorial: id });
  },
  async unpublish(id) {
    await rpc("unpublish_tutorial", { p_tutorial: id });
  },
  async remove(id) {
    await server({ action: "tutorial-delete", tutorial: id });
  },
  async versions(id) {
    return ((await rpc("tutorial_version_list", { p_tutorial: id })) ??
      []) as TutorialVersionRow[];
  },
  async version(id, version) {
    return (await rpc("tutorial_version", {
      p_tutorial: id,
      p_version: version,
    })) as TutorialVersion | null;
  },
  async restore(id, version) {
    return (await rpc("restore_tutorial_version", {
      p_tutorial: id,
      p_version: version,
    })) as TutorialSaveResult;
  },
  async upload(tutorial, file, onProgress) {
    if (file.size === 0 || file.size > VIDEO_MAX_BYTES)
      throw Error(`${file.name}: envie vídeos de até 500 MB.`);
    const id: string = await rpc("prepare_tutorial_media", {
      p_tutorial: tutorial,
      p_name: file.name,
      p_size: file.size,
      p_content_type: file.type || "application/octet-stream",
    });
    const signed = await server<{
      url: string;
      headers: Record<string, string>;
    }>({ action: "tutorial-sign-upload", media: id });
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", signed.url);
      for (const [k, v] of Object.entries(signed.headers))
        xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(Error(`${file.name}: falha no envio (${xhr.status}).`));
      xhr.onerror = () =>
        reject(Error(`${file.name}: falha de conexão no envio.`));
      xhr.send(file);
    });
    await rpc("confirm_tutorial_media", { p_media: id });
    return id;
  },
  async mediaUrls(ids) {
    if (!ids.length) return {};
    const { urls } = await server<{ urls: Record<string, string> }>({
      action: "tutorial-media",
      media: ids,
    });
    return urls;
  },
};

/**
 * Asks for video links in batches: the videos of one page share a request,
 * and a link already signed is reused for 3 hours (they last 4).
 */
export function videoUrlCache(api: TutorialsApi) {
  const cache = new Map<string, { url: string; at: number }>();
  let waiting: { ids: Set<string>; done: Promise<void> } | null = null;
  return async (ids: string[]): Promise<Record<string, string>> => {
    const fresh = (id: string) => {
      const hit = cache.get(id);
      return hit && Date.now() - hit.at < 3 * 3600_000 ? hit.url : null;
    };
    const missing = ids.filter((id) => !fresh(id));
    if (missing.length) {
      if (!waiting) {
        const batch = { ids: new Set<string>(), done: Promise.resolve() };
        batch.done = new Promise<void>((resolve) => setTimeout(resolve, 30))
          .then(() => {
            waiting = null;
            return api.mediaUrls([...batch.ids]);
          })
          .then((urls) => {
            for (const [id, url] of Object.entries(urls))
              cache.set(id, { url, at: Date.now() });
          });
        waiting = batch;
      }
      const batch = waiting;
      missing.forEach((id) => batch.ids.add(id));
      await batch.done;
    }
    return Object.fromEntries(
      ids.flatMap((id) => {
        const url = fresh(id);
        return url ? [[id, url]] : [];
      }),
    );
  };
}

// ------------------------------------------------------------ demo

type DemoTutorial = TutorialDetail & {
  aud: TutorialAudience;
  versions: TutorialVersion[];
};
let demoStore: DemoTutorial[] | null = null;
const demoVideos = new Map<string, string>();

const paragraph = (text: string): RichNode => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
const heading = (text: string, level = 2): RichNode => ({
  type: "heading",
  attrs: { level },
  content: [{ type: "text", text }],
});
const doc = (...content: RichNode[]) =>
  DESCRIPTION_PREFIX + JSON.stringify({ type: "doc", content });

/** Sample tutorials kept in memory for the demonstration. */
export function demoTutorials(data: Snapshot, user: string): TutorialsApi {
  const me = data.members.find((m) => m.user_id === user);
  const role = me?.role ?? "member";
  const admin = role === "admin";
  const leader = admin || role === "manager";
  const name = (id: string) =>
    data.members.find((m) => m.user_id === id)?.name ?? "Alguém";
  const now = () => new Date().toISOString();
  const myTeams = data.teamMembers
    .filter((t) => t.user_id === user)
    .map((t) => t.team_id);
  if (!demoStore) {
    const author = data.members.find((m) => m.role === "admin")?.user_id ?? user;
    const make = (
      id: string,
      title: string,
      summary: string,
      body: string,
      modules: string[],
      category: string,
      tags: string[],
      days: number,
    ): DemoTutorial => {
      const at = new Date(Date.now() - days * 86400_000).toISOString();
      const aud = audienceOf(emptyTutorial());
      return {
        id,
        company_id: data.companies[0]?.id ?? "",
        title,
        summary,
        body,
        modules,
        category,
        tags,
        status: "published",
        version: 1,
        revision: 1,
        audience: aud,
        aud,
        created_by: author,
        author_name: name(author),
        updated_by_name: name(author),
        created_at: at,
        updated_at: at,
        published_at: at,
        media: [],
        draft: null,
        can_edit: false,
        versions: [
          {
            ...aud,
            title,
            summary,
            body,
            modules,
            category,
            tags,
            version: 1,
            published_at: at,
            published_by_name: name(author),
            restored_from: null,
          },
        ],
      };
    };
    demoStore = [
      make(
        "demo-tutorial-tarefas",
        "Como criar e entregar uma tarefa",
        "Do botão Nova tarefa até a entrega, com prazo, responsável e anexos.",
        doc(
          paragraph(
            "As tarefas são o centro do trabalho da agência. Este guia mostra o caminho completo.",
          ),
          heading("Criar a tarefa"),
          paragraph(
            "Clique em Nova tarefa no topo da lista, escolha o cliente e o produto, e descreva o pedido. A MAVI sugere o título ao salvar.",
          ),
          heading("Prazo e responsável"),
          paragraph(
            "O prazo vem da regra mais específica (projeto, cliente, produto, equipe ou pessoa) e pode ser mudado com um motivo.",
          ),
          heading("Entregar"),
          paragraph(
            "Quando terminar, mude o status para Entregue. Se houver checklist obrigatório, ele precisa estar completo.",
          ),
        ),
        ["tasks"],
        "Primeiros passos",
        ["Tarefas", "Prazos"],
        6,
      ),
      make(
        "demo-tutorial-busca",
        "Encontrar qualquer tarefa na Busca avançada",
        "Escreva como falaria: a MAVI entende e preenche os filtros.",
        doc(
          heading("Buscar com a MAVI"),
          paragraph(
            "Digite, por exemplo, \"artes atrasadas da Clínica Sorriso\" e aperte Enter. A MAVI preenche cliente, status e prazo.",
          ),
          heading("Ajustar os filtros"),
          paragraph(
            "Os filtros que a MAVI escolheu aparecem na tela e podem ser trocados ou removidos.",
          ),
        ),
        ["tasks"],
        "Primeiros passos",
        ["Busca", "MAVI"],
        3,
      ),
      make(
        "demo-tutorial-mavi",
        "Conversar com a MAVI",
        "A bolinha em todas as telas e o módulo MAVI usam as mesmas conversas.",
        doc(
          paragraph(
            "Abra a bolinha no canto da tela e pergunte. Para conversas longas, use MAVI › Conversas no menu.",
          ),
          heading("Skills"),
          paragraph(
            "Escolha uma skill na caixa de texto para a MAVI seguir um passo a passo da agência.",
          ),
        ),
        ["assistant"],
        "MAVI",
        ["MAVI"],
        1,
      ),
    ];
  }
  const store = demoStore;
  const canEdit = (t: DemoTutorial) =>
    admin || (leader && t.created_by === user);
  const forMe = (t: DemoTutorial) =>
    t.status === "published" &&
    !t.aud.aud_exclude.includes(user) &&
    (t.aud.aud_all ||
      t.aud.aud_users.includes(user) ||
      t.aud.aud_roles.includes(role) ||
      t.aud.aud_teams.some((x) => myTeams.includes(x)));
  const view = (t: DemoTutorial): TutorialDetail => {
    const edit = canEdit(t);
    return {
      ...t,
      audience: edit ? t.aud : null,
      draft: edit ? t.draft : null,
      can_edit: edit,
    };
  };
  const find = (id: string) => {
    const t = store.find((x) => x.id === id);
    if (!t || !canEdit(t)) throw Error("Sem permissão");
    return t;
  };
  const apply = (t: DemoTutorial, c: TutorialContent) => {
    t.title = cleanLabel(c.title);
    t.summary = c.summary.trim();
    t.body = c.body;
    t.modules = [...c.modules].sort();
    t.category = cleanLabel(c.category);
    t.tags = c.tags;
    t.aud = {
      aud_all: c.aud_all,
      aud_roles: c.aud_all ? [] : c.aud_roles,
      aud_teams: c.aud_all ? [] : c.aud_teams,
      aud_users: c.aud_all ? [] : c.aud_users,
      aud_exclude: c.aud_exclude,
    };
    t.updated_at = now();
    t.updated_by_name = name(user);
    t.revision++;
  };
  const publish = (t: DemoTutorial, restored: number | null = null) => {
    t.status = "published";
    t.version++;
    t.published_at = now();
    t.draft = null;
    t.versions.unshift({
      ...t.aud,
      title: t.title,
      summary: t.summary,
      body: t.body,
      modules: t.modules,
      category: t.category,
      tags: t.tags,
      version: t.version,
      published_at: t.published_at,
      published_by_name: name(user),
      restored_from: restored,
    });
  };
  const result = (t: DemoTutorial, mode: TutorialSaveResult["mode"]) => ({
    id: t.id,
    mode,
    status: t.status,
    version: t.version,
    revision: t.revision,
  });
  const check = (c: TutorialContent) => {
    const title = cleanLabel(c.title);
    if (title.length < 3 || title.length > 160)
      throw Error("Dê um título de 3 a 160 caracteres ao tutorial.");
    if (
      !c.aud_all &&
      !c.aud_roles.length &&
      !c.aud_teams.length &&
      !c.aud_users.length
    )
      throw Error("Escolha quem vê o tutorial: todos, papéis, equipes ou pessoas.");
  };
  return {
    async list(_company, q) {
      const words = fold(q.query.trim()).split(/\s+/).filter(Boolean);
      const shown = store
        .filter((t) => forMe(t) || (q.scope === "admin" && canEdit(t)))
        .filter((t) => !q.module || t.modules.includes(q.module))
        .filter((t) => !q.category || fold(t.category) === fold(q.category))
        .filter(
          (t) =>
            !q.tags.length ||
            t.tags.some((g) => q.tags.some((x) => fold(x) === fold(g))),
        )
        .filter((t) => {
          const text = fold(
            [t.title, t.summary, t.category, ...t.tags, richTextPlain(t.body)].join(" "),
          );
          return words.every((w) => text.includes(w));
        });
      const hits = (t: DemoTutorial) =>
        words.filter((w) => fold(t.title).includes(w)).length;
      shown.sort(
        (a, b) =>
          hits(b) - hits(a) ||
          (q.scope === "admin"
            ? b.updated_at.localeCompare(a.updated_at)
            : (b.published_at ?? "").localeCompare(a.published_at ?? "")),
      );
      return shown.slice(q.offset, q.offset + q.limit).map((t) => ({
        id: t.id,
        title: t.title,
        summary: t.summary,
        modules: t.modules,
        category: t.category,
        tags: t.tags,
        status: t.status,
        version: t.version,
        has_draft: canEdit(t) && !!t.draft,
        aud_all: t.aud.aud_all,
        created_by: t.created_by,
        author_name: t.author_name,
        updated_by_name: t.updated_by_name,
        published_at: t.published_at,
        updated_at: t.updated_at,
        video_count: t.media.length,
        can_edit: canEdit(t),
        total: shown.length,
      }));
    },
    async facets() {
      const map = new Map<string, TutorialFacet>();
      for (const t of store.filter((x) => forMe(x) || canEdit(x))) {
        const add = (kind: TutorialFacet["kind"], value: string) => {
          if (!value) return;
          const key = `${kind}:${fold(value)}`;
          const f = map.get(key) ?? { kind, value, tutorials: 0 };
          if (t.status === "published") f.tutorials++;
          map.set(key, f);
        };
        add("category", t.category);
        t.tags.forEach((g) => add("tag", g));
      }
      return [...map.values()].sort(
        (a, b) => b.tutorials - a.tutorials || a.value.localeCompare(b.value),
      );
    },
    async detail(id) {
      const t = store.find((x) => x.id === id);
      return t && (forMe(t) || canEdit(t)) ? view(t) : null;
    },
    async save(company, id, content, doPublish, revision) {
      if (!leader) throw Error("Só administradores e gestores escrevem tutoriais.");
      check(content);
      if (!id) {
        const aud = audienceOf(emptyTutorial());
        const t: DemoTutorial = {
          title: "",
          summary: "",
          body: "",
          modules: [],
          category: "",
          tags: [],
          id: crypto.randomUUID(),
          company_id: company,
          status: "draft",
          version: 0,
          revision: 0,
          audience: aud,
          aud,
          created_by: user,
          author_name: name(user),
          updated_by_name: name(user),
          created_at: now(),
          updated_at: now(),
          published_at: null,
          media: [],
          draft: null,
          can_edit: true,
          versions: [],
        };
        apply(t, content);
        if (doPublish) publish(t);
        store.unshift(t);
        return result(t, doPublish ? "published" : "created");
      }
      const t = find(id);
      if (revision != null && revision !== t.revision)
        throw Error("Este tutorial foi alterado por outra pessoa. Abra de novo para ver a versão atual.");
      if (t.status === "published" && !doPublish) {
        t.draft = { content, saved_at: now(), saved_by_name: name(user) };
        t.revision++;
        return result(t, "draft");
      }
      apply(t, content);
      if (doPublish) publish(t);
      return result(t, doPublish ? "published" : "saved");
    },
    async discardDraft(id) {
      const t = find(id);
      t.draft = null;
      t.revision++;
    },
    async unpublish(id) {
      const t = find(id);
      if (t.draft) apply(t, t.draft.content);
      t.draft = null;
      t.status = "draft";
    },
    async remove(id) {
      store.splice(store.indexOf(find(id)), 1);
    },
    async versions(id) {
      return find(id).versions.map((v) => ({
        version: v.version,
        title: v.title,
        published_by_name: v.published_by_name,
        published_at: v.published_at,
        restored_from: v.restored_from,
      }));
    },
    async version(id, version) {
      return find(id).versions.find((v) => v.version === version) ?? null;
    },
    async restore(id, version) {
      const t = find(id);
      const v = t.versions.find((x) => x.version === version);
      if (!v) throw Error("Versão não encontrada");
      apply(t, { ...v, ...t.aud });
      publish(t, version);
      return result(t, "published");
    },
    async upload(tutorial, file, onProgress) {
      const t = find(tutorial);
      if (!file.type.startsWith("video/"))
        throw Error("Envie um arquivo de vídeo (MP4, WebM ou MOV).");
      const id = crypto.randomUUID();
      demoVideos.set(id, URL.createObjectURL(file));
      t.media.push({
        id,
        name: file.name,
        content_type: file.type,
        size_bytes: file.size,
      });
      onProgress(1);
      return id;
    },
    async mediaUrls(ids) {
      return Object.fromEntries(
        ids.flatMap((id) =>
          demoVideos.has(id) ? [[id, demoVideos.get(id)!]] : [],
        ),
      );
    },
  };
}

import { rpc } from "./api";
import { supabase } from "./supabase";
import { fold } from "./domain";
import { moduleOf } from "./modules";
import { EXTRA_MODULES } from "./tutorial-modules";
import type { Page } from "./router";
import {
  DESCRIPTION_PREFIX,
  parseDescription,
  richTextPlain,
  slugify,
  type RichNode,
} from "./rich-text";
import type { VideoInfo } from "./TutorialVideo";
import type { WriterDraft, WriterMode } from "./tutorial-writer";
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
export interface TutorialMedia extends Partial<VideoInfo> {
  id: string;
  name: string;
  content_type: string;
  size_bytes: number;
  duration_seconds?: number | null;
}
/** A seção de um tutorial que a busca achou (public.search_tutorials). */
export interface TutorialHit {
  chunk_id: number;
  tutorial_id: string;
  title: string;
  summary: string;
  modules: string[];
  category: string;
  /** A âncora da seção ("" = a introdução). */
  anchor: string;
  section: string;
  content: string;
  score: number;
  similarity: number | null;
  words: number;
}
export type TutorialCitation = {
  n: number;
  tutorial_id: string;
  title: string;
  anchor: string;
  section: string;
};
export type TutorialAnswer = {
  answer: string;
  found: boolean;
  citations: TutorialCitation[];
};
export type TutorialSearchQuery = {
  query: string;
  module: string;
  category: string;
  tags: string[];
};
export type GapStatus = "open" | "resolved" | "dismissed";
/** Uma dúvida sem tutorial (Tutoriais › Dúvidas). */
export interface TutorialGap {
  id: string;
  question: string;
  source: "search" | "mavi";
  module: string | null;
  asks: number;
  people: number;
  asker_names: string[];
  status: GapStatus;
  tutorial_id: string | null;
  tutorial_title: string | null;
  first_asked_at: string;
  last_asked_at: string;
  handled_by_name: string | null;
  handled_at: string | null;
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
  /** A pessoa tem este tutorial (publicado e no público dela): o progresso conta. */
  trackable?: boolean;
  /** O progresso da pessoa (nulo: nunca abriu). */
  progress?: TutorialProgress | null;
  /** As trilhas que têm este tutorial (as que a pessoa vê). */
  trails?: { id: string; title: string }[];
  /** O voto da pessoa em "Isso ajudou?". */
  my_vote?: TutorialVote | null;
  /** Quem edita: a contagem dos votos (down_current: 👎 na versão no ar). */
  votes?: { up: number; down: number; down_current: number } | null;
}
export type VoteReason = "outdated" | "confusing" | "missing_step" | "not_what_i_wanted" | "other";
export interface TutorialVote {
  vote: "up" | "down";
  reason: VoteReason | null;
  comment: string;
  version: number;
  updated_at: string;
}
export const VOTE_REASONS: { id: VoteReason; label: string }[] = [
  { id: "outdated", label: "Está desatualizado" },
  { id: "confusing", label: "Ficou confuso" },
  { id: "missing_step", label: "Faltou um passo" },
  { id: "not_what_i_wanted", label: "Não era o que eu procurava" },
  { id: "other", label: "Outro motivo" },
];
export interface TutorialFeedbackRow {
  user_id: string;
  name: string;
  vote: "up" | "down";
  reason: VoteReason | null;
  comment: string;
  version: number;
  updated_at: string;
}
/** De onde a pessoa abriu o tutorial (as métricas). */
export type ViewSource = "library" | "search" | "trail" | "help" | "mavi" | "notice" | "link";
/** ?de= nos links de fora da página: o "?" do topo, os cartões da MAVI e os avisos. */
export const VIEW_FROM: Record<string, ViewSource> = { ajuda: "help", mavi: "mavi", aviso: "notice" };
export interface TutorialMetricRow {
  id: string;
  title: string;
  status: TutorialStatus;
  version: number;
  views: number;
  viewers: number;
  from_search: number;
  completions: number;
  up: number;
  down: number;
  down_current: number;
  last_view: string | null;
}
export interface SearchMetricRow {
  query_key: string;
  query: string;
  searches: number;
  people: number;
  avg_results: number;
  empty: number;
  opened: number;
  last_at: string;
}
export interface TutorialMetrics {
  from: string;
  to: string;
  totals: {
    views: number;
    viewers: number;
    searches: number;
    empty_searches: number;
    opened_searches: number;
    completions: number;
    up: number;
    down: number;
  };
  sources: Partial<Record<ViewSource, number>>;
  tutorials: TutorialMetricRow[];
  queries: SearchMetricRow[];
  empty: SearchMetricRow[];
}
export type AnnounceChannel = "none" | "inbox" | "notice";
export type WriterRequest = {
  mode: WriterMode;
  idea: string;
  title: string;
  summary: string;
  /** A transcrição (vídeo) ou o texto aberto em linhas, com [[MIDIA n]]. */
  source: string;
  media: number;
  modules: string[];
  module_ids: string[];
};
export interface TutorialProgress {
  completed_at: string | null;
  completed_version: number | null;
  completed_how: "auto" | "manual" | null;
  /** Desmarcou à mão: chegar ao fim não conclui sozinho de novo. */
  undone: boolean;
}
/** 'auto': chegou ao fim; 'complete': o botão (também "li a versão nova"). */
export type ProgressAction = "open" | "auto" | "complete" | "undo";
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

export { TUTORIAL_MODULES, moduleLabel } from "./tutorial-modules";
/** The module of the page on screen, for the "?" (none: no module). */
export function tutorialModuleOf(page: Page | null | undefined): string | null {
  if (!page || page === "tutorials") return null;
  const module = moduleOf(page);
  if (module) return module;
  return (EXTRA_MODULES as readonly string[]).includes(page) ? page : null;
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
  /** A busca com a MAVI: as seções e o vetor da pergunta (para a resposta). */
  search(
    company: string,
    q: TutorialSearchQuery,
  ): Promise<{ hits: TutorialHit[]; embedding: string | null; search_id?: number | null }>;
  /** A resposta curta da MAVI, citando as seções. */
  answer(
    company: string,
    q: TutorialSearchQuery & { embedding: string | null },
  ): Promise<TutorialAnswer>;
  setTranscript(media: string, text: string): Promise<void>;
  retryTranscript(media: string): Promise<void>;
  gaps(company: string, status: GapStatus | "all"): Promise<TutorialGap[]>;
  gapCount(company: string): Promise<number>;
  setGap(id: string, status: GapStatus, tutorial?: string | null): Promise<void>;
  /** Registra o progresso da pessoa (nulo: o tutorial não conta para ela). */
  progress(id: string, action: ProgressAction): Promise<TutorialProgress | null>;
  /** Quem concluiu volta a pendente; devolve quantas pessoas. */
  askReread(id: string): Promise<number>;
  /** "Isso ajudou?" (vote nulo tira o voto). */
  vote(id: string, vote: "up" | "down" | null, reason?: VoteReason | null, comment?: string): Promise<TutorialVote | null>;
  feedback(id: string): Promise<TutorialFeedbackRow[]>;
  logView(id: string, source: ViewSource, search?: number | null): Promise<void>;
  metrics(company: string, from: string, to: string): Promise<TutorialMetrics>;
  /** Avisa o público do tutorial publicado; devolve quantas pessoas (caixa de entrada). */
  announce(id: string, channel: "inbox" | "notice", updated: boolean): Promise<{ people: number | null }>;
  write(company: string, request: WriterRequest): Promise<WriterDraft>;
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
    await rpc("confirm_tutorial_media", {
      p_media: id,
      p_duration: await videoDuration(file),
    });
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
  async search(company, q) {
    return server({
      action: "tutorial-search",
      company,
      query: q.query,
      module: q.module || null,
      category: q.category || null,
      tags: q.tags,
    });
  },
  async answer(company, q) {
    return server({
      action: "tutorial-answer",
      company,
      query: q.query,
      module: q.module || null,
      category: q.category || null,
      tags: q.tags,
      embedding: q.embedding,
    });
  },
  async setTranscript(media, text) {
    await rpc("set_tutorial_media_transcript", { p_media: media, p_text: text });
  },
  async retryTranscript(media) {
    await rpc("retry_tutorial_media_transcript", { p_media: media });
  },
  async gaps(company, status) {
    return ((await rpc("tutorial_gaps_list", {
      p_company: company,
      p_status: status,
      p_limit: 200,
    })) ?? []) as TutorialGap[];
  },
  async gapCount(company) {
    return ((await rpc("tutorial_gap_count", { p_company: company })) ?? 0) as number;
  },
  async setGap(id, status, tutorial) {
    await rpc("set_tutorial_gap", {
      p_gap: id,
      p_status: status,
      p_tutorial: tutorial ?? null,
    });
  },
  async progress(id, action) {
    return (await rpc("set_tutorial_progress", {
      p_tutorial: id,
      p_action: action,
    })) as TutorialProgress | null;
  },
  async askReread(id) {
    return ((await rpc("ask_tutorial_reread", { p_tutorial: id })) ?? 0) as number;
  },
  async vote(id, vote, reason, comment) {
    return (await rpc("vote_tutorial", {
      p_tutorial: id,
      p_vote: vote,
      p_reason: reason ?? null,
      p_comment: comment ?? null,
    })) as TutorialVote | null;
  },
  async feedback(id) {
    return ((await rpc("tutorial_feedback_list", { p_tutorial: id })) ?? []) as TutorialFeedbackRow[];
  },
  async logView(id, source, search) {
    await rpc("log_tutorial_view", { p_tutorial: id, p_source: source, p_search: search ?? null });
  },
  async metrics(company, from, to) {
    return (await rpc("tutorial_metrics", { p_company: company, p_from: from, p_to: to })) as TutorialMetrics;
  },
  async announce(id, channel, updated) {
    return (await rpc("announce_tutorial", {
      p_tutorial: id,
      p_channel: channel,
      p_updated: updated,
    })) as { people: number | null };
  },
  async write(company, request) {
    return server<WriterDraft>({ action: "tutorial-write", company, ...request });
  },
};

/** As palavras que a busca ignora (as mesmas de public.search_tutorials). */
const STOP_WORDS = new Set(
  "que como para com uma por dos das nos nas mais onde qual quais quando faco fazer sobre tem ter meu minha seu sua isso esse essa este esta pra pelo pela nao sim ser sao estou posso consigo".split(
    " ",
  ),
);
/** As palavras que contam numa busca: sem acento, de 3 letras ou mais. */
export const tutorialQueryWords = (query: string) => [
  ...new Set(
    fold(query)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w)),
  ),
];

/** Quantos segundos o vídeo tem (o custo da transcrição); null se o navegador não souber. */
export function videoDuration(file: File): Promise<number | null> {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function")
    return Promise.resolve(null);
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (value: number | null) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => done(null), 8000);
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      clearTimeout(timer);
      done(Number.isFinite(video.duration) ? Math.round(video.duration) : null);
    };
    video.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
    video.src = url;
  });
}

/**
 * As seções de um tutorial como o cérebro da MAVI as guarda
 * (mavi_private.tutorial_index): a introdução (resumo + o que vem antes do
 * primeiro título) e uma por título, com a mesma âncora da tela.
 */
export function tutorialSections(summary: string, body: string) {
  const out: { anchor: string; title: string; text: string }[] = [];
  const used = new Map<string, number>();
  let current = { anchor: "", title: "", text: summary.trim() };
  const plain = (n: RichNode): string =>
    n.type === "text"
      ? (n.text ?? "")
      : n.type === "paragraph" || n.type === "heading"
        ? (n.content ?? []).map(plain).join("")
        : (n.content ?? []).map(plain).filter(Boolean).join("\n");
  for (const node of parseDescription(body).content ?? []) {
    if (node.type === "heading") {
      const label = plain(node).trim();
      if (label) {
        out.push(current);
        const base = slugify(label);
        const n = (used.get(base) ?? 0) + 1;
        used.set(base, n);
        current = { anchor: n > 1 ? `${base}-${n}` : base, title: label, text: "" };
        continue;
      }
    }
    const text =
      node.type === "tutorialVideo"
        ? `[Vídeo${node.attrs?.label ? `: ${node.attrs.label}` : ""}]${node.attrs?.transcript ? `\nTranscrição do vídeo: ${node.attrs.transcript}` : ""}`
        : plain(node).trim();
    if (text) current.text = [current.text, text].filter(Boolean).join("\n");
  }
  out.push(current);
  return out.filter((s) => s.text || s.title);
}

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
let demoGaps: TutorialGap[] = [];
/** O progresso de quem está na demonstração, por tutorial. */
const demoProgress = new Map<string, TutorialProgress>();
const demoVotes = new Map<string, TutorialVote>();
const demoViews: { tutorial: string; source: ViewSource; at: string }[] = [];

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
      trackable: forMe(t),
      progress: demoProgress.get(t.id) ?? null,
      trails: [],
      my_vote: demoVotes.get(t.id) ?? null,
      votes: edit
        ? {
            up: demoVotes.get(t.id)?.vote === "up" ? 1 : 0,
            down: demoVotes.get(t.id)?.vote === "down" ? 1 : 0,
            down_current:
              demoVotes.get(t.id)?.vote === "down" && demoVotes.get(t.id)?.version === t.version ? 1 : 0,
          }
        : null,
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
        transcript: null,
        transcript_status: "skipped",
        transcript_source: null,
        transcript_error: "Na demonstração os vídeos não são transcritos: escreva a transcrição.",
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
    async search(_company, q) {
      const words = tutorialQueryWords(q.query);
      const hits: TutorialHit[] = [];
      for (const t of store.filter(forMe)) {
        if (q.module && !t.modules.includes(q.module)) continue;
        if (q.category && fold(t.category) !== fold(q.category)) continue;
        if (q.tags.length && !t.tags.some((g) => q.tags.some((x) => fold(x) === fold(g)))) continue;
        for (const sec of tutorialSections(t.summary, t.body)) {
          const text = fold(`${t.title} ${sec.title} ${sec.text}`);
          const n = words.filter((w) => text.includes(w)).length;
          if (!n) continue;
          hits.push({
            chunk_id: hits.length + 1,
            tutorial_id: t.id,
            title: t.title,
            summary: t.summary,
            modules: t.modules,
            category: t.category,
            anchor: sec.anchor,
            section: sec.title,
            content: [sec.title && `Seção: ${sec.title}`, sec.text].filter(Boolean).join("\n"),
            score: n,
            similarity: null,
            words: n,
          });
        }
      }
      hits.sort((a, b) => b.score - a.score);
      if (!hits.length) logGap(q.query, "search", q.module);
      return { hits: hits.slice(0, 30), embedding: null };
    },
    async answer(company, q) {
      const { hits } = await this.search(company, q);
      if (!hits.length) return { answer: "", found: false, citations: [] };
      const first = hits[0];
      return {
        answer: `Na demonstração, a MAVI não escreve a resposta: ela leria as seções encontradas e responderia em poucas linhas, como em “${first.section || first.title}” [1].`,
        found: true,
        citations: [
          { n: 1, tutorial_id: first.tutorial_id, title: first.title, anchor: first.anchor, section: first.section },
        ],
      };
    },
    async setTranscript(media, text) {
      const m = store.flatMap((t) => (canEdit(t) ? t.media : [])).find((x) => x.id === media);
      if (!m) throw Error("Sem permissão");
      Object.assign(m, text
        ? { transcript: text, transcript_status: "ready", transcript_source: "manual", transcript_error: null }
        : { transcript: null, transcript_status: "pending", transcript_source: null });
    },
    async retryTranscript(media) {
      const m = store.flatMap((t) => (canEdit(t) ? t.media : [])).find((x) => x.id === media);
      if (!m) throw Error("Sem permissão");
      Object.assign(m, {
        transcript_status: "skipped",
        transcript_error: "Na demonstração os vídeos não são transcritos: escreva a transcrição.",
      });
    },
    async gaps(_company, status) {
      return leader ? demoGaps.filter((g) => status === "all" || g.status === status) : [];
    },
    async gapCount() {
      return leader ? demoGaps.filter((g) => g.status === "open").length : 0;
    },
    async setGap(id, status, tutorial) {
      if (!leader) throw Error("Sem permissão");
      const g = demoGaps.find((x) => x.id === id);
      if (!g) return;
      g.status = status;
      g.tutorial_id = status === "resolved" ? (tutorial ?? g.tutorial_id) : null;
      g.tutorial_title = store.find((t) => t.id === g.tutorial_id)?.title ?? null;
      g.handled_by_name = status === "open" ? null : name(user);
      g.handled_at = status === "open" ? null : now();
    },
    async progress(id, action) {
      const t = store.find((x) => x.id === id);
      if (!t || !forMe(t)) return null;
      const p = demoProgress.get(id) ?? {
        completed_at: null,
        completed_version: null,
        completed_how: null,
        undone: false,
      };
      const before = p.completed_at;
      if (action === "auto" && !p.completed_at && !p.undone)
        Object.assign(p, { completed_at: now(), completed_version: t.version, completed_how: "auto" });
      else if (action === "complete")
        Object.assign(p, { completed_at: now(), completed_version: t.version, completed_how: "manual", undone: false });
      else if (action === "undo")
        Object.assign(p, { completed_at: null, completed_version: null, completed_how: null, undone: true });
      demoProgress.set(id, p);
      if (p.completed_at !== before)
        window.dispatchEvent(
          new CustomEvent("mavi:tutorials", { detail: { kind: "tutorials", progress: true, user, tutorial: id } }),
        );
      return { ...p };
    },
    async vote(id, vote, reason, comment) {
      const t = store.find((x) => x.id === id);
      if (!t || !forMe(t)) throw Error("Este tutorial não está disponível para você.");
      if (!vote) {
        demoVotes.delete(id);
        return null;
      }
      const v: TutorialVote = {
        vote,
        reason: vote === "down" ? (reason ?? null) : null,
        comment: (comment ?? "").trim().slice(0, 500),
        version: t.version,
        updated_at: now(),
      };
      demoVotes.set(id, v);
      return v;
    },
    async feedback(id) {
      find(id);
      const v = demoVotes.get(id);
      return v ? [{ ...v, user_id: user, name: name(user) }] : [];
    },
    async logView(id, source) {
      const t = store.find((x) => x.id === id);
      if (t && forMe(t)) demoViews.push({ tutorial: id, source, at: now() });
    },
    async metrics(_company, from, to) {
      if (!leader) throw Error("Só administradores e gestores veem as métricas dos tutoriais.");
      const inside = (iso: string) => {
        const d = new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
        return d >= from && d <= to;
      };
      const views = demoViews.filter((v) => inside(v.at));
      const sources: TutorialMetrics["sources"] = {};
      views.forEach((v) => (sources[v.source] = (sources[v.source] ?? 0) + 1));
      const votes = [...demoVotes.entries()];
      return {
        from,
        to,
        totals: {
          views: views.length,
          viewers: views.length ? 1 : 0,
          searches: 0,
          empty_searches: 0,
          opened_searches: 0,
          completions: [...demoProgress.values()].filter((p) => p.completed_at && inside(p.completed_at)).length,
          up: votes.filter(([, v]) => v.vote === "up").length,
          down: votes.filter(([, v]) => v.vote === "down").length,
        },
        sources,
        tutorials: store
          .filter((t) => t.status === "published")
          .map((t) => {
            const mine = views.filter((v) => v.tutorial === t.id);
            const v = demoVotes.get(t.id);
            return {
              id: t.id,
              title: t.title,
              status: t.status,
              version: t.version,
              views: mine.length,
              viewers: mine.length ? 1 : 0,
              from_search: mine.filter((x) => x.source === "search").length,
              completions: demoProgress.get(t.id)?.completed_at ? 1 : 0,
              up: v?.vote === "up" ? 1 : 0,
              down: v?.vote === "down" ? 1 : 0,
              down_current: v?.vote === "down" && v.version === t.version ? 1 : 0,
              last_view: mine.at(-1)?.at ?? null,
            };
          })
          .sort((a, b) => b.views - a.views || a.title.localeCompare(b.title, "pt-BR")),
        queries: [],
        empty: demoGaps.map((g) => ({
          query_key: g.question,
          query: g.question,
          searches: g.asks,
          people: g.people,
          avg_results: 0,
          empty: g.asks,
          opened: 0,
          last_at: g.last_asked_at,
        })),
      };
    },
    async announce(id) {
      const t = find(id);
      if (t.status !== "published") throw Error("Publique o tutorial antes de avisar.");
      return { people: Math.max(0, data.members.filter((m) => m.active).length - 1) };
    },
    async write(_company, request) {
      if (!leader) throw Error("Só administradores e gestores pedem à MAVI para escrever tutoriais.");
      const subject = (request.idea || request.title || "o assunto").replace(/\s+/g, " ").trim().slice(0, 80);
      return {
        title: (request.title || (/^como\b/i.test(subject) ? subject.charAt(0).toUpperCase() + subject.slice(1) : `Como ${subject.charAt(0).toLowerCase()}${subject.slice(1)}`)).slice(0, 80),
        summary: "Na demonstração, a MAVI não escreve de verdade: este é um exemplo do formato.",
        blocks: [
          { type: "paragraph", text: `Este guia mostra ${subject}.` },
          { type: "heading", level: 2, text: "Passo a passo" },
          {
            type: "steps",
            items: ["Abra a tela pelo menu lateral.", "Clique em **[confirmar: nome do botão]**.", "Confira e salve."],
          },
          ...Array.from({ length: request.media }, (_, i) => ({ type: "media" as const, n: i + 1 })),
        ],
        notes: "Confira os nomes entre [confirmar].",
        references: 0,
        model: "demonstração",
      };
    },
    async askReread(id) {
      find(id);
      const p = demoProgress.get(id);
      if (!p?.completed_at) return 0;
      demoProgress.set(id, { completed_at: null, completed_version: null, completed_how: null, undone: false });
      return 1;
    },
  };
  function logGap(question: string, source: TutorialGap["source"], module: string) {
    const key = fold(question).replace(/[^a-z0-9]+/g, " ").trim();
    if (key.length < 3) return;
    const g = demoGaps.find((x) => fold(x.question).replace(/[^a-z0-9]+/g, " ").trim() === key);
    if (g) {
      g.asks++;
      g.last_asked_at = now();
      if (g.status === "resolved") g.status = "open";
      return;
    }
    demoGaps.unshift({
      id: crypto.randomUUID(),
      question: question.trim().slice(0, 300),
      source,
      module: module || null,
      asks: 1,
      people: 1,
      asker_names: [name(user)],
      status: "open",
      tutorial_id: null,
      tutorial_title: null,
      first_asked_at: now(),
      last_asked_at: now(),
      handled_by_name: null,
      handled_at: null,
    });
  }
}

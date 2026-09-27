import { rpc } from "./api";
import { supabase } from "./supabase";
import { fold } from "./domain";
import type { Snapshot } from "./types";

/**
 * Cases de Sucesso: the calls the page makes and the helpers that organise
 * what a case shows. Everything goes through the database functions of
 * migration 20261029090000_success_cases (the tables have no direct reads:
 * approved cases are for everyone, even people who don't serve the client);
 * media go through /api/drive ("case-*", api/_cases.ts), which signs GCS
 * URLs. The demo keeps its cases in memory.
 */

export type CaseStatus = "pending" | "approved" | "returned";
export type CaseScope = "library" | "mine" | "review";
export type Highlight = { value: string; label: string };
export type CaseLink = { url: string; label: string };
export type CaseText = { label: string; value: string };

/** What the form edits. */
export interface CaseContent {
  client_id: string;
  title: string;
  summary: string;
  highlights: Highlight[];
  niches: string[];
  product_ids: string[];
  links: CaseLink[];
  contacts: CaseText[];
}

/** A card of the list (search_success_cases). */
export interface CaseRow {
  id: string;
  client_id: string;
  client_name: string;
  client_archived: boolean;
  title: string;
  summary: string;
  highlights: Highlight[];
  niches: string[];
  product_ids: string[];
  status: CaseStatus;
  review_note: string | null;
  created_by: string;
  author_name: string;
  created_at: string;
  approved_at: string | null;
  updated_at: string;
  media_count: number;
  link_count: number;
  cover_id: string | null;
  cover_type: string | null;
  /** An edit waiting for approval (only for its author and the leaders). */
  draft_status: "pending" | "returned" | null;
  draft_note: string | null;
  total: number;
}

export interface CaseMedia {
  id: string;
  name: string;
  content_type: string;
  size_bytes: number;
  /** Sent in an edit that is waiting for approval. */
  pending: boolean;
  created_at: string;
}

export interface CaseShare {
  enabled: boolean;
  token: string;
  client: boolean;
  contacts: boolean;
  views: number;
}

export interface CaseDraft {
  content: CaseContent;
  removed_media: string[];
  status: "pending" | "returned";
  review_note: string | null;
  submitted_by: string;
  submitted_by_name: string;
  submitted_at: string;
  client_name: string | null;
}

export interface CaseDetail extends CaseContent {
  id: string;
  company_id: string;
  client_name: string;
  client_archived: boolean;
  status: CaseStatus;
  review_note: string | null;
  created_by: string;
  author_name: string;
  created_at: string;
  updated_at: string;
  submitted_at: string;
  approved_at: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  version: number;
  share: CaseShare | null;
  media: CaseMedia[];
  draft: CaseDraft | null;
  can_edit: boolean;
  can_review: boolean;
  can_delete: boolean;
}

/** A case opened by its public link (/cases/<token>). */
export interface SharedCase {
  title: string;
  summary: string;
  highlights: Highlight[];
  niches: string[];
  links: CaseLink[];
  contacts: CaseText[];
  products: string[];
  client: string | null;
  company: string;
  approved_at: string | null;
  media: Omit<CaseMedia, "pending" | "created_at">[];
}

export type CaseClient = {
  id: string;
  name: string;
  archived: boolean;
  product_ids: string[];
};
export type NicheCount = { niche: string; cases: number };
export type SaveResult = {
  id: string;
  mode: "created" | "saved" | "draft";
  status: CaseStatus;
};
export type CaseQuery = {
  scope: CaseScope;
  query: string;
  niches: string[];
  products: string[];
  limit: number;
  offset: number;
};

export const emptyContent = (client_id = ""): CaseContent => ({
  client_id,
  title: "",
  summary: "",
  highlights: [],
  niches: [],
  product_ids: [],
  links: [],
  contacts: [],
});

// ------------------------------------------------------------ organising

export const MAX_HIGHLIGHTS = 4;
export const MAX_NICHES = 10;
export const MEDIA_MAX_BYTES = 524_288_000;

/** "  estética   dental " → "estética dental". */
export const cleanNiche = (value: string) =>
  value.replace(/\s+/g, " ").trim().slice(0, 60);

/**
 * Adds a niche, reusing the spelling that already exists ("odontologia"
 * becomes "Odontologia" when that is how it's registered).
 */
export function addNiche(list: string[], value: string, known: string[]) {
  const niche = cleanNiche(value);
  if (!niche) return list;
  const key = fold(niche);
  if (list.some((n) => fold(n) === key)) return list;
  return [...list, known.find((k) => fold(k) === key) ?? niche];
}

/** Suggestions for what is being typed: starts-with first, then contains. */
export function nicheSuggestions(
  known: NicheCount[],
  typed: string,
  picked: string[],
  limit = 8,
) {
  const q = fold(cleanNiche(typed));
  const taken = new Set(picked.map(fold));
  const free = known.filter((n) => !taken.has(fold(n.niche)));
  if (!q) return free.slice(0, limit);
  const starts = free.filter((n) => fold(n.niche).startsWith(q));
  const contains = free.filter(
    (n) => !fold(n.niche).startsWith(q) && fold(n.niche).includes(q),
  );
  return [...starts, ...contains].slice(0, limit);
}

/** "instagram.com/x" → "https://instagram.com/x"; nothing for garbage. */
export function normalizeUrl(value: string) {
  const raw = value.trim();
  if (!raw) return "";
  const withScheme = /^https?:\/\//i.test(raw)
    ? raw
    : /^[\w-]+(\.[\w-]+)+(\/|$|\?|#|:)/.test(raw)
      ? `https://${raw}`
      : raw;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (/\s/.test(withScheme)) return "";
    return withScheme;
  } catch {
    return "";
  }
}

export type LinkKind =
  | "instagram"
  | "facebook"
  | "youtube"
  | "tiktok"
  | "linkedin"
  | "whatsapp"
  | "google"
  | "drive"
  | "site";
const LINK_KINDS: [LinkKind, RegExp, string][] = [
  ["instagram", /(^|\.)instagram\.com$|(^|\.)instagr\.am$/, "Instagram"],
  ["facebook", /(^|\.)facebook\.com$|(^|\.)fb\.(com|me)$/, "Facebook"],
  ["youtube", /(^|\.)youtube\.com$|(^|\.)youtu\.be$/, "YouTube"],
  ["tiktok", /(^|\.)tiktok\.com$/, "TikTok"],
  ["linkedin", /(^|\.)linkedin\.com$/, "LinkedIn"],
  ["whatsapp", /(^|\.)wa\.me$|(^|\.)whatsapp\.com$/, "WhatsApp"],
  ["drive", /^(drive|docs)\.google\.com$/, "Google Drive"],
  [
    "google",
    /(^|\.)google\.[a-z.]+$|(^|\.)g\.page$|^maps\.app\.goo\.gl$/,
    "Google",
  ],
];

/** What a link is (for its icon and name) and a short address to show. */
export function linkInfo(link: CaseLink) {
  let host = "";
  let path = "";
  try {
    const url = new URL(link.url);
    host = url.hostname.replace(/^www\./, "");
    path = decodeURIComponent(url.pathname).replace(/\/+$/, "");
  } catch {
    host = link.url;
  }
  const found = LINK_KINDS.find(([, re]) => re.test(host));
  const kind: LinkKind = found?.[0] ?? "site";
  // Perfis: "@clinicasorriso" diz mais que o endereço.
  const handle =
    (kind === "instagram" || kind === "tiktok") && /^\/@?[\w.]+$/.test(path)
      ? `@${path.replace(/^\/@?/, "")}`
      : "";
  const short = handle || `${host}${path.length > 1 ? path : ""}`;
  const title =
    link.label ||
    (kind === "site"
      ? /\b(lp|landing|obrigado|promo|oferta)\b/i.test(link.url)
        ? "Landing page"
        : "Site"
      : found![2]);
  return {
    kind,
    title,
    short: short.length > 60 ? `${short.slice(0, 59)}…` : short,
  };
}

export type TextKind = "phone" | "whatsapp" | "email" | "url" | "text";
/** A phone, e-mail or address in a text becomes a link (tel:, mailto:, wa.me). */
export function textInfo(text: CaseText): { kind: TextKind; href?: string } {
  const value = text.value.trim();
  const label = fold(text.label);
  if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(value))
    return { kind: "email", href: `mailto:${value}` };
  const url = normalizeUrl(value);
  if (url && !/^[\d\s()+.-]+$/.test(value)) return { kind: "url", href: url };
  const digits = value.replace(/\D/g, "");
  if (
    /^[\d\s()+.-]{8,}$/.test(value) &&
    digits.length >= 8 &&
    digits.length <= 15
  ) {
    const intl = digits.length <= 11 ? `55${digits}` : digits;
    if (
      /whats|zap|wpp/.test(label) ||
      (digits.length >= 10 && digits.replace(/^55/, "")[2] === "9")
    )
      return { kind: "whatsapp", href: `https://wa.me/${intl}` };
    return { kind: "phone", href: `tel:+${intl}` };
  }
  return { kind: "text" };
}

export type MediaKind = "image" | "video" | "audio" | "pdf" | "doc" | "other";
export function mediaKind(
  m: Pick<CaseMedia, "content_type" | "name">,
): MediaKind {
  const t = m.content_type;
  const ext = m.name.split(".").pop()?.toLowerCase() ?? "";
  if (t.startsWith("image/") && t !== "image/svg+xml") return "image";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  if (t === "application/pdf" || ext === "pdf") return "pdf";
  if (
    ["doc", "docx", "ppt", "pptx", "xls", "xlsx", "key", "csv", "txt"].includes(
      ext,
    )
  )
    return "doc";
  return "other";
}

/** Photos and videos first (the gallery), then documents and the rest. */
export function groupMedia<T extends Pick<CaseMedia, "content_type" | "name">>(
  list: T[],
) {
  const visual: T[] = [];
  const files: T[] = [];
  for (const m of list) {
    const k = mediaKind(m);
    (k === "image" || k === "video" ? visual : files).push(m);
  }
  return { visual, files };
}

export const statusLabel: Record<CaseStatus, string> = {
  pending: "Em análise",
  approved: "Aprovado",
  returned: "Devolvido",
};

export const publicCaseUrl = (token: string) =>
  `${window.location.origin}/cases/${token}`;

/** Where a case opens inside the app. */
export const caseQueryParam = "caso";

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

export interface CasesApi {
  search(company: string, q: CaseQuery): Promise<CaseRow[]>;
  detail(id: string): Promise<CaseDetail | null>;
  save(
    company: string,
    id: string | null,
    content: CaseContent,
    version?: number | null,
  ): Promise<SaveResult>;
  review(id: string, approve: boolean, note?: string): Promise<void>;
  discardDraft(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  upload(
    caseId: string,
    file: File,
    onProgress: (fraction: number) => void,
  ): Promise<string>;
  removeMedia(id: string): Promise<void>;
  mediaUrls(ids: string[], inline: boolean): Promise<Record<string, string>>;
  share(
    id: string,
    s: {
      enabled: boolean;
      client: boolean;
      contacts: boolean;
      newLink?: boolean;
    },
  ): Promise<CaseShare>;
  niches(company: string): Promise<NicheCount[]>;
  clients(company: string): Promise<CaseClient[]>;
  reviewCount(company: string): Promise<number>;
}

export const serverCases: CasesApi = {
  async search(company, q) {
    return ((await rpc("search_success_cases", {
      p_company: company,
      p_query: q.query,
      p_niches: q.niches.length ? q.niches : null,
      p_products: q.products.length ? q.products : null,
      p_scope: q.scope,
      p_limit: q.limit,
      p_offset: q.offset,
    })) ?? []) as CaseRow[];
  },
  async detail(id) {
    return (await rpc("success_case_detail", {
      p_case: id,
    })) as CaseDetail | null;
  },
  async save(company, id, content, version) {
    return (await rpc("save_success_case", {
      p_company: company,
      p_case: id,
      p_content: content,
      p_version: version ?? null,
    })) as SaveResult;
  },
  async review(id, approve, note) {
    await server({
      action: "case-review",
      case: id,
      approve,
      note: note ?? null,
    });
  },
  async discardDraft(id) {
    await server({ action: "case-discard-draft", case: id });
  },
  async remove(id) {
    await server({ action: "case-delete", case: id });
  },
  async upload(caseId, file, onProgress) {
    if (file.size === 0 || file.size > MEDIA_MAX_BYTES)
      throw Error(`${file.name}: envie arquivos não vazios de até 500 MB.`);
    const id: string = await rpc("prepare_success_case_media", {
      p_case: caseId,
      p_name: file.name,
      p_size: file.size,
      p_content_type: file.type || "application/octet-stream",
    });
    const signed = await server<{
      url: string;
      headers: Record<string, string>;
    }>({
      action: "case-sign-upload",
      media: id,
    });
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
    await rpc("confirm_success_case_media", { p_media: id });
    return id;
  },
  async removeMedia(id) {
    await server({ action: "case-delete-media", media: id });
  },
  async mediaUrls(ids, inline) {
    if (!ids.length) return {};
    const { urls } = await server<{ urls: Record<string, string> }>({
      action: "case-media",
      media: ids,
      inline,
    });
    return urls;
  },
  async share(id, s) {
    return (await rpc("set_success_case_sharing", {
      p_case: id,
      p_enabled: s.enabled,
      p_client: s.client,
      p_contacts: s.contacts,
      p_new_link: !!s.newLink,
    })) as CaseShare;
  },
  async niches(company) {
    return ((await rpc("success_case_niches", { p_company: company })) ??
      []) as NicheCount[];
  },
  async clients(company) {
    return ((await rpc("success_case_clients", { p_company: company })) ??
      []) as CaseClient[];
  },
  async reviewCount(company) {
    return ((await rpc("success_case_review_count", { p_company: company })) ??
      0) as number;
  },
};

/** The public page: the case by its token (no sign-in). */
export async function sharedCase(token: string): Promise<SharedCase | null> {
  if (!supabase) throw Error("Supabase não configurado");
  const { data, error } = await supabase.rpc("success_case_shared", {
    p_token: token,
  });
  if (error) throw error;
  return data as SharedCase | null;
}
export async function sharedCaseMedia(
  token: string,
  ids: string[],
  inline: boolean,
) {
  if (!ids.length) return {};
  const { urls } = await server<{ urls: Record<string, string> }>({
    action: "case-public-media",
    token,
    media: ids,
    inline,
  });
  return urls;
}

// ------------------------------------------------------------ demo

type DemoCase = Omit<CaseDetail, "can_edit" | "can_review" | "can_delete"> & {
  media_urls: Record<string, string>;
};
let demoStore: DemoCase[] | null = null;

/** Sample cases kept in memory for the demonstration. */
export function demoCases(data: Snapshot, user: string): CasesApi {
  const me = data.members.find((m) => m.user_id === user);
  const leader = me?.role === "admin" || me?.role === "manager";
  const clientName = (id: string) =>
    data.clients.find((c) => c.id === id)?.name ?? "Cliente";
  const now = () => new Date().toISOString();
  const nameOf = (u: string) =>
    data.members.find((m) => m.user_id === u)?.name ?? "Alguém";
  if (!demoStore) {
    const [c1, c2] = data.clients;
    const product = data.products[0]?.id;
    const other = data.members.find((m) => m.user_id !== user)?.user_id ?? user;
    const base = (i: number, extra: Partial<DemoCase>): DemoCase => ({
      id: `demo-case-${i}`,
      company_id: data.companies[0]?.id ?? "",
      client_id: c1?.id ?? "",
      client_name: c1?.name ?? "Cliente",
      client_archived: false,
      title: "",
      summary: "",
      highlights: [],
      niches: [],
      product_ids: product ? [product] : [],
      links: [],
      contacts: [],
      status: "approved",
      review_note: null,
      created_by: other,
      author_name: nameOf(other),
      created_at: now(),
      updated_at: now(),
      submitted_at: now(),
      approved_at: now(),
      reviewed_by_name: nameOf(user),
      reviewed_at: now(),
      version: 1,
      share: {
        enabled: false,
        token: "0".repeat(64),
        client: true,
        contacts: false,
        views: 0,
      },
      media: [],
      draft: null,
      media_urls: {},
      ...extra,
    });
    demoStore = [
      base(1, {
        title: "Clínica odontológica triplicou os agendamentos de implante",
        summary:
          "Campanhas de Social Leads com criativos de antes e depois e atendimento pelo WhatsApp. Em 90 dias o custo por lead caiu pela metade.",
        highlights: [
          { value: "+320", label: "leads por mês" },
          { value: "-48%", label: "custo por lead" },
          { value: "3x", label: "agendamentos" },
        ],
        niches: ["Odontologia", "Saúde"],
        links: [
          { url: "https://instagram.com/clinicasorriso", label: "" },
          { url: "https://clinicasorriso.com.br/lp-implantes", label: "" },
        ],
        contacts: [
          { label: "WhatsApp do dono", value: "(11) 99876-5432" },
          { label: "E-mail", value: "contato@clinicasorriso.com.br" },
        ],
      }),
      base(2, {
        client_id: c2?.id ?? c1?.id ?? "",
        client_name: c2?.name ?? c1?.name ?? "Cliente",
        title: "Imobiliária vendeu 14 apartamentos na planta em 60 dias",
        summary:
          "Tráfego pago com formulário instantâneo e qualificação por telefone.",
        highlights: [
          { value: "14", label: "unidades vendidas" },
          { value: "R$ 38", label: "custo por lead" },
        ],
        niches: ["Imobiliário"],
        links: [
          {
            url: "https://youtube.com/watch?v=demo",
            label: "Depoimento em vídeo",
          },
        ],
      }),
      base(3, {
        title: "Pet shop dobrou o faturamento do banho e tosa",
        summary: "Plano mensal com posts e anúncios locais num raio de 5 km.",
        highlights: [{ value: "2x", label: "faturamento do serviço" }],
        niches: ["Pet Shop", "Varejo local"],
        status: "pending",
        approved_at: null,
        created_by: user,
        author_name: nameOf(user),
      }),
    ];
  }
  const store = demoStore;
  const find = (id: string) => store.find((c) => c.id === id);
  const visible = (c: DemoCase) =>
    c.status === "approved" || c.created_by === user || leader;
  const withRights = (c: DemoCase): CaseDetail => ({
    ...c,
    media: c.media.filter((m) => !m.pending || c.created_by === user || leader),
    can_edit: c.created_by === user || leader,
    can_review: leader,
    can_delete: leader || (c.created_by === user && c.status !== "approved"),
  });
  const apply = (c: DemoCase, v: CaseContent) =>
    Object.assign(c, v, {
      client_name: clientName(v.client_id),
      updated_at: now(),
      version: c.version + 1,
    });
  return {
    async search(_company, q) {
      const words = fold(q.query).split(/\s+/).filter(Boolean);
      const niches = q.niches.map(fold);
      const list = store.filter((c) => {
        if (!visible(c)) return false;
        if (q.scope === "library" && c.status !== "approved") return false;
        if (q.scope === "mine" && c.created_by !== user) return false;
        if (
          q.scope === "review" &&
          !(leader && (c.status === "pending" || c.draft?.status === "pending"))
        )
          return false;
        if (niches.length && !c.niches.some((n) => niches.includes(fold(n))))
          return false;
        if (
          q.products.length &&
          !c.product_ids.some((p) => q.products.includes(p))
        )
          return false;
        const text = fold(
          [
            c.title,
            c.summary,
            c.client_name,
            ...c.niches,
            ...c.highlights.flatMap((h) => [h.value, h.label]),
          ].join(" "),
        );
        return words.every((w) => text.includes(w));
      });
      return list.map((c) => {
        const cover = c.media.find(
          (m) => !m.pending && ["image", "video"].includes(mediaKind(m)),
        );
        return {
          ...c,
          media_count: c.media.filter((m) => !m.pending).length,
          link_count: c.links.length,
          cover_id: cover?.id ?? null,
          cover_type: cover?.content_type ?? null,
          draft_status:
            c.created_by === user || leader ? (c.draft?.status ?? null) : null,
          draft_note: c.draft?.review_note ?? null,
          total: list.length,
        };
      });
    },
    async detail(id) {
      const c = find(id);
      return c && visible(c) ? withRights(c) : null;
    },
    async save(company, id, content) {
      if (content.title.trim().length < 3)
        throw Error("Dê um título de 3 a 160 caracteres ao case.");
      if (!content.client_id) throw Error("Escolha o cliente do case.");
      if (!id) {
        const c: DemoCase = {
          ...content,
          id: `demo-case-${Date.now()}`,
          company_id: company,
          client_name: clientName(content.client_id),
          client_archived: false,
          status: leader ? "approved" : "pending",
          review_note: null,
          created_by: user,
          author_name: nameOf(user),
          created_at: now(),
          updated_at: now(),
          submitted_at: now(),
          approved_at: leader ? now() : null,
          reviewed_by_name: leader ? nameOf(user) : null,
          reviewed_at: leader ? now() : null,
          version: 1,
          share: {
            enabled: false,
            token: "0".repeat(64),
            client: true,
            contacts: false,
            views: 0,
          },
          media: [],
          draft: null,
          media_urls: {},
        };
        store.unshift(c);
        return { id: c.id, mode: "created", status: c.status };
      }
      const c = find(id)!;
      if (leader || c.status !== "approved") {
        apply(c, content);
        if (!leader && c.status === "returned")
          Object.assign(c, { status: "pending", review_note: null });
        return { id, mode: "saved", status: c.status };
      }
      c.draft = {
        content,
        removed_media: c.draft?.removed_media ?? [],
        status: "pending",
        review_note: null,
        submitted_by: user,
        submitted_by_name: nameOf(user),
        submitted_at: now(),
        client_name: clientName(content.client_id),
      };
      return { id, mode: "draft", status: c.status };
    },
    async review(id, approve, note) {
      const c = find(id)!;
      if (c.draft?.status === "pending") {
        if (approve) {
          apply(c, c.draft.content);
          const removed = new Set(c.draft.removed_media);
          c.media = c.media
            .filter((m) => !removed.has(m.id))
            .map((m) => ({ ...m, pending: false }));
          c.draft = null;
        } else
          c.draft = { ...c.draft, status: "returned", review_note: note ?? "" };
        return;
      }
      Object.assign(
        c,
        approve
          ? { status: "approved", approved_at: now(), review_note: null }
          : { status: "returned", review_note: note ?? "" },
      );
    },
    async discardDraft(id) {
      const c = find(id)!;
      c.draft = null;
      c.media = c.media.filter((m) => !m.pending);
    },
    async remove(id) {
      store.splice(
        store.findIndex((c) => c.id === id),
        1,
      );
    },
    async upload(caseId, file, onProgress) {
      const c = find(caseId)!;
      const id = `demo-media-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      onProgress(1);
      c.media.push({
        id,
        name: file.name,
        content_type: file.type || "application/octet-stream",
        size_bytes: file.size,
        pending: c.status === "approved" && !leader,
        created_at: now(),
      });
      c.media_urls[id] = URL.createObjectURL(file);
      return id;
    },
    async removeMedia(id) {
      const c = store.find((x) => x.media.some((m) => m.id === id))!;
      const m = c.media.find((x) => x.id === id)!;
      if (c.status === "approved" && !m.pending && !leader && c.draft)
        c.draft.removed_media = [...c.draft.removed_media, id];
      else c.media = c.media.filter((x) => x.id !== id);
    },
    async mediaUrls(ids) {
      return Object.fromEntries(
        store
          .flatMap((c) => Object.entries(c.media_urls))
          .filter(([id]) => ids.includes(id)),
      );
    },
    async share(id, s) {
      const c = find(id)!;
      if (s.enabled && c.status !== "approved")
        throw Error(
          "O link para o lead fica disponível depois que o case for aprovado.",
        );
      c.share = {
        ...c.share!,
        enabled: s.enabled,
        client: s.client,
        contacts: s.contacts,
      };
      return c.share;
    },
    async niches() {
      const counts = new Map<string, NicheCount>();
      for (const c of store)
        if (c.status === "approved")
          for (const n of c.niches) {
            const k = fold(n);
            const cur = counts.get(k) ?? { niche: n, cases: 0 };
            counts.set(k, { ...cur, cases: cur.cases + 1 });
          }
      return [...counts.values()].sort(
        (a, b) => b.cases - a.cases || a.niche.localeCompare(b.niche),
      );
    },
    async clients() {
      return data.clients.map((c) => ({
        id: c.id,
        name: c.name,
        archived: c.archived,
        product_ids: data.contracts
          .filter((k) => k.client_id === c.id)
          .map((k) => k.product_id),
      }));
    },
    async reviewCount() {
      return leader
        ? store.filter(
            (c) => c.status === "pending" || c.draft?.status === "pending",
          ).length
        : 0;
    },
  };
}

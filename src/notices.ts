import { rpc } from "./api";
import { driveServer } from "./drive";
import type { Snapshot } from "./types";

/**
 * Mural de avisos (migration 20261106090000_notice_board). O banco decide
 * quem recebe e guarda o que cada pessoa fez; aqui ficam os tipos, as
 * regras que a tela usa (qual popup mostrar, quais faixas, o escopo de quem
 * cria) e as duas implementações: a do servidor e a da demonstração.
 */
export type NoticeLevel = "info" | "important" | "critical";
export type NoticeStatus = "draft" | "scheduled" | "live" | "ended";
export type NoticeRepeat =
  "daily" | "weekdays" | "weekly" | "biweekly" | "monthly";
export type TargetKind = "everyone" | "user" | "team" | "client" | "project";
/** Quem atende o cliente/projeto: as equipes, os responsáveis pelas tarefas abertas, ou os dois. */
export type TargetMode = "teams" | "assignees" | "both";
export type NoticeTarget = { kind: TargetKind; id?: string; mode?: TargetMode };
export type NoticeAction = "seen" | "ack" | "snooze" | "close_banner";

export interface NoticeFormats {
  popup: boolean;
  inbox: boolean;
  push: boolean;
  banner: boolean;
}
export interface NoticeContent extends NoticeFormats {
  title: string;
  /** Texto rico ("mavi:richtext:v1:…"), como a descrição das tarefas. */
  body: string;
  level: NoticeLevel;
  pinned: boolean;
  require_ack: boolean;
  /** ISO; vazio: agora. */
  publish_at: string;
  expires_at: string;
  repeat: NoticeRepeat | "";
  targets: NoticeTarget[];
  exclude: string[];
}
/** Um aviso no ar para a pessoa (popup, faixa, contador). */
export interface LiveNotice {
  id: string;
  title: string;
  body: string;
  level: NoticeLevel;
  popup: boolean;
  banner: boolean;
  pinned: boolean;
  require_ack: boolean;
  round: number;
  publish_at: string;
  expires_at: string | null;
  author_name: string;
  delivered_at: string;
  seen_at: string | null;
  acked_at: string | null;
  snoozed_until: string | null;
  banner_closed_at: string | null;
  attachments: number;
}
export interface FeedNotice {
  id: string;
  title: string;
  excerpt: string;
  level: NoticeLevel;
  status: NoticeStatus;
  pinned: boolean;
  require_ack: boolean;
  publish_at: string;
  expires_at: string | null;
  author_name: string;
  delivered_at: string;
  seen_at: string | null;
  acked_at: string | null;
  attachments: number;
}
export interface SentNotice extends NoticeFormats {
  id: string;
  title: string;
  excerpt: string;
  level: NoticeLevel;
  status: NoticeStatus;
  pinned: boolean;
  require_ack: boolean;
  repeat: NoticeRepeat | null;
  publish_at: string | null;
  expires_at: string | null;
  created_by: string;
  author_name: string;
  updated_at: string;
  delivered: number;
  seen: number;
  acked: number;
}
export interface NoticeAttachment {
  id: string;
  name: string;
  content_type: string;
  size_bytes: number;
  source: "upload" | "drive";
}
export interface NoticeDetail extends NoticeFormats {
  id: string;
  company_id: string;
  title: string;
  body: string;
  level: NoticeLevel;
  pinned: boolean;
  require_ack: boolean;
  publish_at: string | null;
  expires_at: string | null;
  repeat: NoticeRepeat | null;
  next_repeat: string | null;
  round: number;
  status: NoticeStatus;
  created_by: string;
  author_name: string;
  created_at: string;
  updated_at: string;
  version: number;
  can_edit: boolean;
  receipt: {
    delivered_at: string;
    seen_at: string | null;
    acked_at: string | null;
    snoozed_until: string | null;
    banner_closed_at: string | null;
  } | null;
  attachments: NoticeAttachment[];
  /** Só para quem edita. */
  targets: NoticeTarget[] | null;
  exclude: string[] | null;
}
export type NoticeSaveResult = {
  id: string;
  status: NoticeStatus;
  version: number;
};

export const NOTICE_PARAM = "aviso";
export const ATTACHMENT_MAX_BYTES = 524_288_000;
export const MAX_ATTACHMENTS = 20;

export const LEVELS: Record<
  NoticeLevel,
  { label: string; hint: string; formats: NoticeFormats; ack: boolean }
> = {
  info: {
    label: "Informativo",
    hint: "Caixa de entrada e Mural.",
    formats: { popup: false, inbox: true, push: false, banner: false },
    ack: false,
  },
  important: {
    label: "Importante",
    hint: "Também no celular (push) e numa faixa no topo.",
    formats: { popup: false, inbox: true, push: true, banner: true },
    ack: false,
  },
  critical: {
    label: "Crítico",
    hint: "Popup que pede “Li e entendi”, push e caixa de entrada.",
    formats: { popup: true, inbox: true, push: true, banner: false },
    ack: true,
  },
};
export const FORMATS: {
  key: keyof NoticeFormats;
  label: string;
  hint: string;
}[] = [
  {
    key: "popup",
    label: "Popup",
    hint: "Abre sobre a tela, na hora, para quem estiver no app.",
  },
  {
    key: "inbox",
    label: "Caixa de entrada",
    hint: "Entra na caixa de entrada, como uma menção.",
  },
  {
    key: "push",
    label: "Push",
    hint: "Notificação do navegador e do celular, mesmo com o app fechado.",
  },
  {
    key: "banner",
    label: "Faixa no topo",
    hint: "Uma faixa fixa no topo de todas as telas até a pessoa fechar.",
  },
];
export const REPEATS: { value: NoticeRepeat; label: string }[] = [
  { value: "daily", label: "Todo dia" },
  { value: "weekdays", label: "Dias úteis" },
  { value: "weekly", label: "Toda semana" },
  { value: "biweekly", label: "A cada duas semanas" },
  { value: "monthly", label: "Todo mês" },
];
export const MODES: { value: TargetMode; label: string }[] = [
  { value: "both", label: "Equipes e responsáveis" },
  { value: "teams", label: "Só as equipes" },
  { value: "assignees", label: "Só os responsáveis por tarefas abertas" },
];
export const STATUS_LABEL: Record<NoticeStatus, string> = {
  draft: "Rascunho",
  scheduled: "Agendado",
  live: "No ar",
  ended: "Encerrado",
};

export const emptyNotice = (): NoticeContent => ({
  title: "",
  body: "",
  level: "info",
  ...LEVELS.info.formats,
  pinned: false,
  require_ack: false,
  publish_at: "",
  expires_at: "",
  repeat: "",
  targets: [],
  exclude: [],
});

export function contentOf(d: NoticeDetail): NoticeContent {
  return {
    title: d.title,
    body: d.body,
    level: d.level,
    popup: d.popup,
    inbox: d.inbox,
    push: d.push,
    banner: d.banner,
    pinned: d.pinned,
    require_ack: d.require_ack,
    publish_at: d.publish_at ?? "",
    expires_at: d.expires_at ?? "",
    repeat: d.repeat ?? "",
    targets: d.targets ?? [],
    exclude: d.exclude ?? [],
  };
}

const LEVEL_ORDER: Record<NoticeLevel, number> = {
  critical: 0,
  important: 1,
  info: 2,
};

/**
 * O popup a mostrar agora (o mais urgente primeiro): pede confirmação e
 * ainda não foi confirmado nem adiado para depois de agora; ou, sem
 * confirmação, ainda não foi visto.
 */
export function nextPopup(
  live: LiveNotice[],
  now = Date.now(),
  dismissed: ReadonlySet<string> = new Set(),
) {
  return (
    [...live]
      .filter(
        (n) =>
          n.popup &&
          !dismissed.has(`${n.id}:${n.round}`) &&
          (n.require_ack
            ? !n.acked_at &&
              !(n.snoozed_until && new Date(n.snoozed_until).getTime() > now)
            : !n.seen_at),
      )
      .sort(
        (a, b) =>
          LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
          b.delivered_at.localeCompare(a.delivered_at),
      )[0] ?? null
  );
}

/** As faixas no topo que a pessoa ainda não fechou (até três). */
export function bannerNotices(live: LiveNotice[]) {
  return live
    .filter((n) => n.banner && !n.banner_closed_at)
    .sort(
      (a, b) =>
        LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
        b.delivered_at.localeCompare(a.delivered_at),
    )
    .slice(0, 3);
}

/** O contador do Mural no menu: avisos no ar que a pessoa ainda não viu. */
export const unseenCount = (live: LiveNotice[]) =>
  live.filter((n) => !n.seen_at).length;

/**
 * O que quem cria pode escolher como público. Administradores: tudo.
 * Gestores: as equipes em que estão, as pessoas dessas equipes, os clientes
 * dessas equipes e os projetos desses clientes (o banco confere de novo).
 */
export function noticeScope(data: Snapshot, user: string) {
  const me = data.members.find((m) => m.user_id === user);
  const admin = me?.role === "admin";
  const active = data.members.filter((m) => m.active !== false);
  const openClients = data.clients.filter((c) => !c.archived);
  const openProjects = data.projects.filter((p) => !p.archived);
  if (admin)
    return {
      everyone: true,
      users: active.map((m) => m.user_id),
      teams: data.teams.map((t) => t.id),
      clients: openClients.map((c) => c.id),
      projects: openProjects.map((p) => p.id),
    };
  const myTeams = new Set(
    data.teamMembers
      .filter((tm) => tm.user_id === user)
      .map((tm) => tm.team_id),
  );
  const users = new Set(
    data.teamMembers
      .filter((tm) => myTeams.has(tm.team_id))
      .map((tm) => tm.user_id),
  );
  const clients = new Set(
    data.clientTeams
      .filter((ct) => myTeams.has(ct.team_id))
      .map((ct) => ct.client_id),
  );
  const contractClient = new Map(
    data.contracts.map((k) => [k.id, k.client_id]),
  );
  return {
    everyone: false,
    users: active.filter((m) => users.has(m.user_id)).map((m) => m.user_id),
    teams: data.teams.filter((t) => myTeams.has(t.id)).map((t) => t.id),
    clients: openClients.filter((c) => clients.has(c.id)).map((c) => c.id),
    projects: openProjects
      .filter((p) => clients.has(contractClient.get(p.contract_id) ?? ""))
      .map((p) => p.id),
  };
}

/**
 * Quantas pessoas o público alcança, pelo que o app já sabe (equipes e
 * pessoas). Os responsáveis por tarefas abertas só o banco conhece: a tela
 * diz "e os responsáveis…" à parte.
 */
export function audienceEstimate(
  content: Pick<NoticeContent, "targets" | "exclude">,
  data: Snapshot,
  creator: string,
) {
  const active = new Set(
    data.members.filter((m) => m.active !== false).map((m) => m.user_id),
  );
  const people = new Set<string>();
  const teamPeople = (team: string) =>
    data.teamMembers
      .filter((tm) => tm.team_id === team)
      .forEach((tm) => people.add(tm.user_id));
  const clientTeams = (client: string) =>
    data.clientTeams
      .filter((ct) => ct.client_id === client)
      .forEach((ct) => teamPeople(ct.team_id));
  let assignees = false;
  for (const t of content.targets) {
    if (t.kind === "everyone") active.forEach((u) => people.add(u));
    else if (t.kind === "user" && t.id) people.add(t.id);
    else if (t.kind === "team" && t.id) teamPeople(t.id);
    else if (t.kind === "client" || t.kind === "project") {
      const client =
        t.kind === "client"
          ? t.id
          : data.contracts.find(
              (k) =>
                k.id === data.projects.find((p) => p.id === t.id)?.contract_id,
            )?.client_id;
      if (t.mode !== "assignees" && client) clientTeams(client);
      if (t.mode !== "teams") assignees = true;
    }
  }
  people.delete(creator);
  for (const u of content.exclude) people.delete(u);
  return {
    people: [...people].filter((u) => active.has(u)).length,
    assignees,
  };
}

/** Mesma data e hora no fuso do navegador, para o campo datetime-local. */
export function toLocalInput(iso: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(value: string) {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

export function whenLabel(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? `hoje às ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`
    : d.toLocaleString("pt-BR", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
}

// ------------------------------------------------------------ acesso
export interface NoticesApi {
  live(company: string): Promise<LiveNotice[]>;
  feed(
    company: string,
    query: string,
    limit: number,
    offset: number,
  ): Promise<FeedNotice[]>;
  sent(
    company: string,
    query: string,
    limit: number,
    offset: number,
  ): Promise<SentNotice[]>;
  detail(id: string): Promise<NoticeDetail | null>;
  save(
    company: string,
    id: string | null,
    content: NoticeContent,
    publish: boolean,
    renotify: boolean,
    version?: number | null,
  ): Promise<NoticeSaveResult>;
  end(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  mark(id: string, action: NoticeAction): Promise<void>;
  upload(
    notice: string,
    file: File,
    onProgress: (fraction: number) => void,
  ): Promise<string>;
  addDriveFile(notice: string, file: string): Promise<string>;
  removeAttachment(id: string): Promise<void>;
  attachmentUrls(
    ids: string[],
    inline: boolean,
  ): Promise<Record<string, string>>;
}

export const serverNotices: NoticesApi = {
  async live(company) {
    return ((await rpc("my_live_notices", { p_company: company })) ??
      []) as LiveNotice[];
  },
  async feed(company, query, limit, offset) {
    return ((await rpc("my_notice_feed", {
      p_company: company,
      p_query: query,
      p_limit: limit,
      p_offset: offset,
    })) ?? []) as FeedNotice[];
  },
  async sent(company, query, limit, offset) {
    return ((await rpc("sent_notices", {
      p_company: company,
      p_query: query,
      p_limit: limit,
      p_offset: offset,
    })) ?? []) as SentNotice[];
  },
  async detail(id) {
    return (await rpc("notice_detail", {
      p_notice: id,
    })) as NoticeDetail | null;
  },
  async save(company, id, content, publish, renotify, version) {
    return (await rpc("save_notice", {
      p_company: company,
      p_notice: id,
      p_content: content,
      p_publish: publish,
      p_renotify: renotify,
      p_version: version ?? null,
    })) as NoticeSaveResult;
  },
  async end(id) {
    await rpc("end_notice", { p_notice: id });
  },
  async remove(id) {
    await driveServer({ action: "notice-delete", notice: id });
  },
  async mark(id, action) {
    await rpc("mark_notice", { p_notice: id, p_action: action });
  },
  async upload(notice, file, onProgress) {
    if (file.size === 0 || file.size > ATTACHMENT_MAX_BYTES)
      throw Error(`${file.name}: envie arquivos não vazios de até 500 MB.`);
    const id: string = await rpc("prepare_notice_attachment", {
      p_notice: notice,
      p_name: file.name,
      p_size: file.size,
      p_content_type: file.type || "application/octet-stream",
    });
    const signed = await driveServer<{
      url: string;
      headers: Record<string, string>;
    }>({ action: "notice-sign-upload", attachment: id });
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
    await rpc("confirm_notice_attachment", { p_attachment: id });
    return id;
  },
  async addDriveFile(notice, file) {
    return (await rpc("add_notice_drive_file", {
      p_notice: notice,
      p_file: file,
    })) as string;
  },
  async removeAttachment(id) {
    await driveServer({ action: "notice-delete-file", attachment: id });
  },
  async attachmentUrls(ids, inline) {
    if (!ids.length) return {};
    const { urls } = await driveServer<{ urls: Record<string, string> }>({
      action: "notice-files",
      attachments: ids,
      inline,
    });
    return urls;
  },
};

// ------------------------------------------------------------ demo
type DemoNotice = Omit<NoticeDetail, "can_edit" | "receipt" | "status"> & {
  receipts: Record<string, NonNullable<NoticeDetail["receipt"]>>;
  urls: Record<string, string>;
  status_ended: boolean;
};
let demoStore: DemoNotice[] | null = null;
const demoListeners = new Set<() => void>();

function demoStatus(n: DemoNotice, now = Date.now()): NoticeStatus {
  if (!n.publish_at) return "draft";
  if (n.expires_at && new Date(n.expires_at).getTime() <= now) return "ended";
  if (n.status_ended) return "ended";
  if (new Date(n.publish_at).getTime() > now) return "scheduled";
  return "live";
}

/** Avisos de exemplo, em memória, para a demonstração. */
export function demoNotices(data: Snapshot, user: string): NoticesApi {
  const me = data.members.find((m) => m.user_id === user);
  const admin = me?.role === "admin";
  const name = (id: string) =>
    data.members.find((m) => m.user_id === id)?.name ?? "Alguém";
  const now = () => new Date().toISOString();
  const others = data.members.find((m) => m.user_id !== user)?.user_id ?? user;
  const audience = (n: DemoNotice) => {
    const people = new Set<string>();
    for (const t of n.targets ?? []) {
      if (t.kind === "everyone")
        data.members.forEach((m) => people.add(m.user_id));
      if (t.kind === "user" && t.id) people.add(t.id);
      if (t.kind === "team")
        data.teamMembers
          .filter((tm) => tm.team_id === t.id)
          .forEach((tm) => people.add(tm.user_id));
      if (t.kind === "client")
        data.clientTeams
          .filter((ct) => ct.client_id === t.id)
          .forEach((ct) =>
            data.teamMembers
              .filter((tm) => tm.team_id === ct.team_id)
              .forEach((tm) => people.add(tm.user_id)),
          );
    }
    people.delete(n.created_by);
    for (const u of n.exclude ?? []) people.delete(u);
    return people;
  };
  const deliver = (n: DemoNotice) => {
    if (demoStatus(n) !== "live") return;
    for (const u of audience(n))
      if (!n.receipts[u])
        n.receipts[u] = {
          delivered_at:
            n.publish_at && n.publish_at < now() ? n.publish_at : now(),
          seen_at: null,
          acked_at: null,
          snoozed_until: null,
          banner_closed_at: null,
        };
  };
  if (!demoStore) {
    const base = {
      company_id: data.companies[0]?.id ?? "",
      pinned: false,
      expires_at: null,
      repeat: null,
      next_repeat: null,
      round: 1,
      version: 1,
      attachments: [],
      urls: {},
      exclude: [],
      status_ended: false,
    };
    const ago = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();
    demoStore = [
      {
        ...base,
        id: "demo-notice-1",
        title: "Nova funcionalidade: Mural de avisos",
        body: "Agora os comunicados da agência chegam aqui: popup, caixa de entrada, push e faixa no topo. Tudo o que você recebeu fica no Mural.",
        level: "important",
        popup: true,
        inbox: true,
        push: true,
        banner: true,
        require_ack: false,
        pinned: true,
        publish_at: ago(2),
        created_by: others,
        author_name: name(others),
        created_at: ago(2),
        updated_at: ago(2),
        targets: [{ kind: "everyone" }],
        receipts: {},
      },
      {
        ...base,
        id: "demo-notice-2",
        title: "Sexta-feira sem expediente",
        body: "Feriado municipal na sexta. Voltamos na segunda às 9h.",
        level: "info",
        popup: false,
        inbox: true,
        push: false,
        banner: false,
        require_ack: false,
        publish_at: ago(30),
        created_by: others,
        author_name: name(others),
        created_at: ago(30),
        updated_at: ago(30),
        targets: [{ kind: "everyone" }],
        receipts: {},
      },
    ];
    demoStore.forEach(deliver);
  }
  const store = demoStore;
  const find = (id: string) => store.find((n) => n.id === id);
  const canEdit = (n: DemoNotice) =>
    admin || (n.created_by === user && me?.role === "manager");
  const changed = () => demoListeners.forEach((f) => f());
  const detailOf = (n: DemoNotice): NoticeDetail => {
    const r = n.receipts[user] ?? null;
    const edit = canEdit(n);
    const { receipts: _r, urls: _u, status_ended: _e, ...rest } = n;
    return {
      ...rest,
      status: demoStatus(n),
      can_edit: edit,
      receipt: r,
      targets: edit ? n.targets : null,
      exclude: edit ? n.exclude : null,
    };
  };
  const words = (q: string) =>
    q
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
  const matches = (n: DemoNotice, q: string) => {
    const text = `${n.title} ${n.body}`
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase();
    return words(q).every((w) => text.includes(w));
  };
  return {
    async live() {
      return store
        .filter((n) => demoStatus(n) === "live" && n.receipts[user])
        .map((n) => ({
          ...n,
          ...n.receipts[user],
          publish_at: n.publish_at!,
          attachments: n.attachments.length,
        }));
    },
    async feed(_c, query, limit, offset) {
      return store
        .filter((n) => n.receipts[user] && matches(n, query))
        .sort(
          (a, b) =>
            Number(b.pinned && demoStatus(b) === "live") -
              Number(a.pinned && demoStatus(a) === "live") ||
            b.receipts[user].delivered_at.localeCompare(
              a.receipts[user].delivered_at,
            ),
        )
        .slice(offset, offset + limit)
        .map((n) => ({
          ...n,
          ...n.receipts[user],
          excerpt: n.body.slice(0, 200),
          status: demoStatus(n),
          publish_at: n.publish_at!,
          attachments: n.attachments.length,
        }));
    },
    async sent(_c, query, limit, offset) {
      if (!admin && me?.role !== "manager") return [];
      return store
        .filter((n) => (admin || n.created_by === user) && matches(n, query))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(offset, offset + limit)
        .map((n) => {
          const r = Object.values(n.receipts);
          return {
            ...n,
            excerpt: n.body.slice(0, 200),
            status: demoStatus(n),
            delivered: r.length,
            seen: r.filter((x) => x.seen_at).length,
            acked: r.filter((x) => x.acked_at).length,
          };
        });
    },
    async detail(id) {
      const n = find(id);
      return n && (canEdit(n) || n.receipts[user]) ? detailOf(n) : null;
    },
    async save(_c, id, content, publish, renotify) {
      if (!admin && me?.role !== "manager")
        throw Error("Somente administradores e gestores criam avisos.");
      let n = id ? find(id) : undefined;
      const live = n && demoStatus(n) === "live";
      const publishAt = live
        ? n!.publish_at
        : !publish
          ? null
          : content.publish_at && content.publish_at > now()
            ? content.publish_at
            : now();
      if (!n) {
        n = {
          id: `demo-notice-${Math.random().toString(36).slice(2)}`,
          company_id: data.companies[0]?.id ?? "",
          created_by: user,
          author_name: name(user),
          created_at: now(),
          round: 1,
          version: 1,
          next_repeat: null,
          attachments: [],
          urls: {},
          receipts: {},
          status_ended: false,
        } as unknown as DemoNotice;
        store.unshift(n);
      } else n.version += 1;
      Object.assign(n, {
        ...content,
        title: content.title.trim(),
        publish_at: publishAt,
        expires_at: content.expires_at || null,
        repeat: publishAt ? content.repeat || null : null,
        updated_at: now(),
      });
      if (live && renotify) {
        n.round += 1;
        n.receipts = {};
      }
      deliver(n);
      changed();
      return { id: n.id, status: demoStatus(n), version: n.version };
    },
    async end(id) {
      const n = find(id);
      if (n) n.status_ended = true;
      changed();
    },
    async remove(id) {
      const i = store.findIndex((n) => n.id === id);
      if (i >= 0) store.splice(i, 1);
      changed();
    },
    async mark(id, action) {
      const r = find(id)?.receipts[user];
      if (!r) return;
      const at = now();
      r.seen_at ??= at;
      if (action === "ack") r.acked_at ??= at;
      if (action === "close_banner") r.banner_closed_at ??= at;
      if (action === "snooze") {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        d.setHours(0, 0, 0, 0);
        r.snoozed_until = d.toISOString();
      }
    },
    async upload(notice, file, onProgress) {
      const n = find(notice);
      if (!n) throw Error("Aviso não encontrado.");
      const id = `demo-att-${Math.random().toString(36).slice(2)}`;
      n.attachments.push({
        id,
        name: file.name,
        content_type: file.type || "application/octet-stream",
        size_bytes: file.size,
        source: "upload",
      });
      n.urls[id] = URL.createObjectURL(file);
      onProgress(1);
      return id;
    },
    async addDriveFile() {
      throw Error("Na demonstração não há arquivos no Drive para anexar.");
    },
    async removeAttachment(id) {
      for (const n of store)
        n.attachments = n.attachments.filter((a) => a.id !== id);
    },
    async attachmentUrls(ids) {
      const out: Record<string, string> = {};
      for (const n of store)
        for (const id of ids) if (n.urls[id]) out[id] = n.urls[id];
      return out;
    },
  };
}

/** A mesma implementação para a página e para o popup (a demonstração guarda em memória). */
export function noticesApi(demo: boolean, data: Snapshot, user: string) {
  return demo ? demoNotices(data, user) : serverNotices;
}

/** A demonstração avisa a tela quando um aviso muda (como o tempo real faria). */
export function onDemoNoticesChange(listener: () => void) {
  demoListeners.add(listener);
  return () => void demoListeners.delete(listener);
}

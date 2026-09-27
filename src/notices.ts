import { rpc } from "./api";
import { driveServer } from "./drive";
import { fold } from "./domain";
import {
  DESCRIPTION_PREFIX,
  parseDescription,
  type RichNode,
} from "./rich-text";
import type { Snapshot } from "./types";
import type { AnimationSpec } from "./notice-animation";

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
  /** A última cobrança: o popup adiado nesta sessão volta. */
  reminded_at?: string | null;
  /** A animação da versão escolhida (se houver). */
  animation?: AnimationSpec | null;
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
  /** Para quem edita: a última cobrança dos pendentes. */
  last_reminded_at?: string | null;
  animation_id?: string | null;
  animation?: AnimationSpec | null;
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
/** Quem recebeu a rodada atual (só para quem edita). */
export interface NoticePerson {
  user_id: string;
  name: string;
  teams: string | null;
  delivered_at: string;
  seen_at: string | null;
  acked_at: string | null;
  snoozed_until: string | null;
  reminded_at: string | null;
  reminders: number;
}
/** O que um modelo guarda: o aviso sem datas nem anexos. */
export type TemplateContent = Omit<NoticeContent, "publish_at" | "expires_at">;
export interface NoticeTemplate {
  id: string;
  name: string;
  content: Partial<TemplateContent>;
  created_by: string;
  author_name: string;
  updated_at: string;
  can_edit: boolean;
}
/** Um modelo que pode gerar animações (liberado pelo administrador). */
export type AnimationModel = {
  provider_id: string;
  provider: string;
  kind: string;
  model: string;
  price: { input: number; output: number } | null;
};
export interface AnimationOptions {
  /** O administrador permite a base de conhecimento. */
  knowledge: boolean;
  models: AnimationModel[];
  /** O modelo da funcionalidade no Painel da MAVI (nulo: o do servidor). */
  default: AnimationModel | null;
  can_manage: boolean;
}
export interface AnimationAdmin {
  knowledge: boolean;
  models: {
    provider_id: string;
    model: string;
    user_ids: string[];
    team_ids: string[];
  }[];
}
export interface AnimationVersion {
  id: string;
  version: number;
  status: "generating" | "ready" | "failed";
  source: "mavi" | "manual";
  request: string;
  spec: AnimationSpec | null;
  refs: string[];
  knowledge: boolean;
  provider_id: string | null;
  model: string | null;
  cost_usd: number | null;
  error: string | null;
  author_name: string;
  created_at: string;
  finished_at: string | null;
  current: boolean;
}
export type AnimateRequest = {
  request: string;
  provider: string | null;
  model: string | null;
  refs: string[];
  knowledge: boolean;
  /** A versão a ajustar (nulo: uma animação nova). */
  base: string | null;
};
export type WriterMode = "write" | "improve" | "suggest";
export type WriterStyle = "clear" | "short" | "formal" | "friendly";
/** O que a MAVI devolve (api/_notice-writer.ts); nada é aplicado sozinho. */
export interface WriterResult {
  title?: string;
  /** Texto simples: parágrafos e linhas "- " de lista. */
  body?: string;
  level?: NoticeLevel;
  formats?: NoticeFormats;
  require_ack?: boolean;
  audience?: { kind: TargetKind; name: string; mode?: TargetMode }[];
  why?: string;
  model?: string;
}

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

/** Uma entrega (rodada e cobrança): o que a pessoa dispensou nesta sessão. */
export const noticeKey = (
  n: Pick<LiveNotice, "id" | "round" | "reminded_at">,
) => `${n.id}:${n.round}:${n.reminded_at ?? ""}`;

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
          !dismissed.has(noticeKey(n)) &&
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

/** Pendente: ainda não viu ou, quando o aviso pede, ainda não confirmou. */
export const isPending = (p: NoticePerson, requireAck: boolean) =>
  !p.seen_at || (requireAck && !p.acked_at);

/** O conteúdo de um modelo ou de um aviso duplicado, pronto para o formulário. */
export function fromTemplate(t: Partial<TemplateContent>): NoticeContent {
  const base = emptyNotice();
  const level: NoticeLevel =
    t.level === "important" || t.level === "critical" ? t.level : "info";
  return {
    ...base,
    title: typeof t.title === "string" ? t.title : "",
    body: typeof t.body === "string" ? t.body : "",
    level,
    popup: t.popup ?? LEVELS[level].formats.popup,
    inbox: t.inbox ?? LEVELS[level].formats.inbox,
    push: t.push ?? LEVELS[level].formats.push,
    banner: t.banner ?? LEVELS[level].formats.banner,
    pinned: !!t.pinned,
    require_ack: !!t.require_ack,
    repeat: REPEATS.some((r) => r.value === t.repeat)
      ? (t.repeat as NoticeRepeat)
      : "",
    targets: Array.isArray(t.targets) ? t.targets : [],
    exclude: Array.isArray(t.exclude) ? t.exclude : [],
  };
}
export function templateOf(c: NoticeContent): TemplateContent {
  const { publish_at: _p, expires_at: _e, ...rest } = c;
  return rest;
}

/** O texto de um aviso em linhas simples (listas com "- "), para a MAVI ler. */
export function noticePlain(body: string) {
  const text = (n: RichNode): string =>
    n.type === "text"
      ? (n.text ?? "")
      : n.type === "hardBreak"
        ? "\n"
        : (n.content ?? []).map(text).join("");
  const lines: string[] = [];
  for (const block of parseDescription(body).content ?? []) {
    if (block.type === "bulletList" || block.type === "orderedList")
      (block.content ?? []).forEach((item, i) =>
        lines.push(
          `${block.type === "bulletList" ? "-" : `${i + 1}.`} ${text(item).trim()}`,
        ),
      );
    else lines.push(text(block));
  }
  return lines.join("\n").trim();
}

/** O texto simples da MAVI como texto rico: parágrafos e listas. */
export function plainToRich(text: string) {
  const content: RichNode[] = [];
  let list: RichNode | null = null;
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    const ordered = line.match(/^\d+[.)]\s+(.*)$/);
    const item = bullet?.[1] ?? ordered?.[1];
    if (item !== undefined) {
      const type = bullet ? "bulletList" : "orderedList";
      if (!list || list.type !== type) {
        list = { type, content: [] };
        content.push(list);
      }
      list.content!.push({
        type: "listItem",
        content: [
          { type: "paragraph", content: [{ type: "text", text: item }] },
        ],
      });
      continue;
    }
    list = null;
    if (line)
      content.push({
        type: "paragraph",
        content: [{ type: "text", text: line }],
      });
  }
  return content.length
    ? DESCRIPTION_PREFIX + JSON.stringify({ type: "doc", content })
    : "";
}

/**
 * O público que a MAVI sugeriu (nomes citados no texto) no que quem escreve
 * pode avisar. O que não bate com ninguém volta à parte, para a tela dizer.
 */
export function matchAudience(
  suggested: NonNullable<WriterResult["audience"]>,
  data: Snapshot,
  scope: ReturnType<typeof noticeScope>,
) {
  const targets: NoticeTarget[] = [];
  const missing: string[] = [];
  const find = <T extends { id: string }>(
    list: T[],
    name: string,
    label: (x: T) => string,
  ) => {
    const key = fold(name);
    return (
      list.find((x) => fold(label(x)) === key) ??
      list.find(
        (x) => fold(label(x)).includes(key) || key.includes(fold(label(x))),
      )
    );
  };
  for (const a of suggested) {
    if (a.kind === "everyone") {
      if (scope.everyone) targets.push({ kind: "everyone" });
      else missing.push("todos da agência");
      continue;
    }
    const hit =
      a.kind === "team"
        ? find(
            data.teams.filter((t) => scope.teams.includes(t.id)),
            a.name,
            (t) => t.name,
          )
        : a.kind === "client"
          ? find(
              data.clients.filter((c) => scope.clients.includes(c.id)),
              a.name,
              (c) => c.name,
            )
          : a.kind === "project"
            ? find(
                data.projects.filter((p) => scope.projects.includes(p.id)),
                a.name,
                (p) => p.name,
              )
            : find(
                data.members
                  .filter((m) => scope.users.includes(m.user_id))
                  .map((m) => ({ ...m, id: m.user_id })),
                a.name,
                (m) => m.name,
              );
    if (!hit) missing.push(a.name);
    else if (!targets.some((t) => t.kind === a.kind && t.id === hit.id))
      targets.push({
        kind: a.kind,
        id: hit.id,
        ...(a.kind === "client" || a.kind === "project"
          ? { mode: a.mode ?? "both" }
          : {}),
      });
  }
  return { targets, missing };
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
  people(id: string): Promise<NoticePerson[]>;
  /** Devolve quantas pessoas foram cobradas. */
  remind(id: string): Promise<number>;
  templates(company: string): Promise<NoticeTemplate[]>;
  saveTemplate(
    company: string,
    id: string | null,
    name: string,
    content: TemplateContent,
  ): Promise<string>;
  deleteTemplate(id: string): Promise<void>;
  writer(
    company: string,
    request: {
      mode: WriterMode;
      idea?: string;
      title?: string;
      text?: string;
      style?: WriterStyle;
    },
  ): Promise<WriterResult>;
  animationOptions(company: string): Promise<AnimationOptions>;
  animationAdmin(company: string): Promise<AnimationAdmin>;
  setAnimationAdmin(company: string, config: AnimationAdmin): Promise<void>;
  /** Começa a gerar; a versão fica pronta em segundo plano. */
  animate(
    company: string,
    notice: string,
    request: AnimateRequest,
  ): Promise<{ id: string; version: number }>;
  animations(notice: string): Promise<AnimationVersion[]>;
  saveAnimation(
    notice: string,
    spec: AnimationSpec,
    base: string | null,
  ): Promise<string>;
  useAnimation(notice: string, id: string | null): Promise<void>;
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
  async people(id) {
    return ((await rpc("notice_people", { p_notice: id })) ??
      []) as NoticePerson[];
  },
  async remind(id) {
    return Number(await rpc("remind_notice", { p_notice: id })) || 0;
  },
  async templates(company) {
    return ((await rpc("notice_templates", { p_company: company })) ??
      []) as NoticeTemplate[];
  },
  async saveTemplate(company, id, name, content) {
    return (await rpc("save_notice_template", {
      p_company: company,
      p_template: id,
      p_name: name,
      p_content: content,
    })) as string;
  },
  async deleteTemplate(id) {
    await rpc("delete_notice_template", { p_template: id });
  },
  async writer(company, request) {
    return driveServer<WriterResult>({
      action: "notice-mavi",
      company,
      ...request,
    });
  },
  async animationOptions(company) {
    return (await rpc("notice_animation_options", {
      p_company: company,
    })) as AnimationOptions;
  },
  async animationAdmin(company) {
    return (await rpc("notice_animation_admin", {
      p_company: company,
    })) as AnimationAdmin;
  },
  async setAnimationAdmin(company, config) {
    await rpc("set_notice_animation_admin", {
      p_company: company,
      p_knowledge: config.knowledge,
      p_models: config.models,
    });
  },
  async animate(company, notice, request) {
    return driveServer<{ id: string; version: number }>({
      action: "notice-animate",
      company,
      notice,
      ...request,
    });
  },
  async animations(notice) {
    return ((await rpc("notice_animations", { p_notice: notice })) ??
      []) as AnimationVersion[];
  },
  async saveAnimation(notice, spec, base) {
    return (await rpc("save_notice_animation", {
      p_notice: notice,
      p_spec: spec,
      p_base: base,
    })) as string;
  },
  async useAnimation(notice, id) {
    await rpc("use_notice_animation", { p_notice: notice, p_animation: id });
  },
};

// ------------------------------------------------------------ demo
type DemoNotice = Omit<NoticeDetail, "can_edit" | "receipt" | "status"> & {
  receipts: Record<string, NonNullable<NoticeDetail["receipt"]>>;
  urls: Record<string, string>;
  status_ended: boolean;
  versions?: AnimationVersion[];
};

/** A animação de exemplo da demonstração: o passo a passo do próprio Mural. */
export const DEMO_ANIMATION: AnimationSpec = {
  version: 1,
  theme: "light",
  scenes: [
    {
      layout: "title",
      duration: 3,
      heading: "Chegou o Mural de avisos",
      text: "Os comunicados da agência, num lugar só.",
      icon: "megaphone",
      transition: "zoom",
    },
    {
      layout: "mockup",
      duration: 5,
      heading: "Abra o Mural no menu",
      ui: [
        {
          kind: "menu",
          label: "Menu",
          items: ["Visão geral", "Mural", "Tarefas", "Agenda", "Drive"],
          active: 1,
        },
        { kind: "button", label: "Novo aviso", primary: true },
        {
          kind: "card",
          label: "Sexta-feira sem expediente",
          text: "Feriado municipal. Voltamos na segunda.",
        },
        { kind: "badge", label: "Importante", tone: "amber" },
      ],
      target: 1,
      cursor: { x: 60, y: 30, click: true },
      callout: "Clique em Novo aviso",
      transition: "slide",
    },
    {
      layout: "steps",
      duration: 5,
      heading: "Em três passos",
      bullets: [
        "Escreva o aviso (a MAVI ajuda)",
        "Escolha quem recebe",
        "Popup, caixa de entrada, push ou faixa",
      ],
      transition: "slide",
    },
    {
      layout: "mockup",
      duration: 4.5,
      heading: "Quem precisa confirmar, confirma",
      ui: [
        {
          kind: "card",
          label: "Nova política de férias",
          text: "Leia antes de pedir as suas férias.",
        },
        { kind: "toggle", label: "Pedir “Li e entendi”", on: true },
        { kind: "button", label: "Li e entendi", primary: true },
      ],
      target: 2,
      cursor: { x: 50, y: 70, click: true },
      transition: "fade",
    },
    {
      layout: "closing",
      duration: 3,
      heading: "Tudo fica guardado no Mural",
      text: "Menu › Mural",
      icon: "check",
      transition: "zoom",
    },
  ],
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
    demoStore[0].animation = DEMO_ANIMATION;
    demoStore[0].animation_id = "demo-animation-1";
    demoStore[0].versions = [
      {
        id: "demo-animation-1",
        version: 1,
        status: "ready",
        source: "mavi",
        request:
          "Mostre em até 30 segundos como abrir o Mural, criar um aviso e confirmar a leitura.",
        spec: DEMO_ANIMATION,
        refs: [],
        knowledge: false,
        provider_id: null,
        model: "claude-opus-5-5",
        cost_usd: 0.06,
        error: null,
        author_name: name(others),
        created_at: ago(3),
        finished_at: ago(3),
        current: true,
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
    const {
      receipts: _r,
      urls: _u,
      status_ended: _e,
      versions: _v,
      ...rest
    } = n;
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
    async people(id) {
      const n = find(id);
      if (!n || !canEdit(n)) return [];
      const teams = (u: string) =>
        data.teamMembers
          .filter((tm) => tm.user_id === u)
          .map((tm) => data.teams.find((t) => t.id === tm.team_id)?.name)
          .filter(Boolean)
          .join(", ") || null;
      return Object.entries(n.receipts)
        .map(([u, r]) => ({
          user_id: u,
          name: name(u),
          teams: teams(u),
          reminded_at: null,
          reminders: 0,
          ...r,
        }))
        .sort(
          (a, b) =>
            Number(isPending(b, n.require_ack)) -
              Number(isPending(a, n.require_ack)) ||
            a.name.localeCompare(b.name, "pt-BR"),
        );
    },
    async remind(id) {
      const n = find(id);
      if (!n || !canEdit(n))
        throw Error("Sem permissão para cobrar este aviso.");
      if (
        n.last_reminded_at &&
        Date.now() - new Date(n.last_reminded_at).getTime() < 3600e3
      )
        throw Error("Este aviso já foi cobrado há menos de uma hora.");
      const pending = Object.values(n.receipts).filter(
        (r) => !r.seen_at || (n.require_ack && !r.acked_at),
      );
      for (const r of pending) r.snoozed_until = r.banner_closed_at = null;
      if (pending.length) n.last_reminded_at = now();
      return pending.length;
    },
    async templates() {
      if (!admin && me?.role !== "manager") return [];
      return demoTemplates.map((t) => ({
        ...t,
        author_name: name(t.created_by),
        can_edit: admin || t.created_by === user,
      }));
    },
    async saveTemplate(_c, id, templateName, content) {
      const t = id ? demoTemplates.find((x) => x.id === id) : undefined;
      if (t) {
        Object.assign(t, { name: templateName, content, updated_at: now() });
        return t.id;
      }
      const nid = `demo-template-${Math.random().toString(36).slice(2)}`;
      demoTemplates.push({
        id: nid,
        name: templateName,
        content,
        created_by: user,
        updated_at: now(),
      });
      return nid;
    },
    async deleteTemplate(id) {
      const i = demoTemplates.findIndex((t) => t.id === id);
      if (i >= 0) demoTemplates.splice(i, 1);
    },
    async writer() {
      throw Error(
        "Na demonstração a MAVI não escreve avisos. Entre na sua conta para usar.",
      );
    },
    async animationOptions() {
      return {
        knowledge: true,
        models: [],
        default: null,
        can_manage: !!admin,
      };
    },
    async animationAdmin() {
      return demoAnimationAdmin;
    },
    async setAnimationAdmin(_c, config) {
      demoAnimationAdmin = config;
    },
    async animate() {
      throw Error(
        "Na demonstração a MAVI não cria animações. Entre na sua conta para usar; aqui dá para editar os textos das cenas.",
      );
    },
    async animations(id) {
      const n = find(id);
      if (!n || !canEdit(n)) return [];
      return [...(n.versions ?? [])]
        .map((v) => ({ ...v, current: v.id === n.animation_id }))
        .sort((a, b) => b.version - a.version);
    },
    async saveAnimation(id, spec, base) {
      const n = find(id);
      if (!n || !canEdit(n)) throw Error("Sem permissão");
      const versions = (n.versions ??= []);
      const v: AnimationVersion = {
        id: `demo-animation-${Math.random().toString(36).slice(2)}`,
        version: Math.max(0, ...versions.map((x) => x.version)) + 1,
        status: "ready",
        source: "manual",
        request: "",
        spec,
        refs: versions.find((x) => x.id === base)?.refs ?? [],
        knowledge: false,
        provider_id: null,
        model: null,
        cost_usd: null,
        error: null,
        author_name: name(user),
        created_at: now(),
        finished_at: now(),
        current: false,
      };
      versions.push(v);
      if (demoStatus(n) !== "live") {
        n.animation_id = v.id;
        n.animation = spec;
      }
      changed();
      return v.id;
    },
    async useAnimation(id, animation) {
      const n = find(id);
      if (!n || !canEdit(n)) throw Error("Sem permissão");
      const v = (n.versions ?? []).find((x) => x.id === animation);
      n.animation_id = v?.id ?? null;
      n.animation = v?.spec ?? null;
      changed();
    },
  };
}
let demoAnimationAdmin: AnimationAdmin = { knowledge: true, models: [] };
const demoTemplates: {
  id: string;
  name: string;
  content: Partial<TemplateContent>;
  created_by: string;
  updated_at: string;
}[] = [];

/** A mesma implementação para a página e para o popup (a demonstração guarda em memória). */
export function noticesApi(demo: boolean, data: Snapshot, user: string) {
  return demo ? demoNotices(data, user) : serverNotices;
}

/** A demonstração avisa a tela quando um aviso muda (como o tempo real faria). */
export function onDemoNoticesChange(listener: () => void) {
  demoListeners.add(listener);
  return () => void demoListeners.delete(listener);
}

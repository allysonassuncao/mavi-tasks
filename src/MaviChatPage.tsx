import { tutorialModuleOf } from "./tutorials";
import { resolvePage } from "./router";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  AlertTriangle,
  ArrowUp,
  Check,
  Copy,
  Loader2,
  Lock,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Paperclip,
  Play,
  Puzzle,
  Search,
  Share2,
  Sparkles,
  Square,
  SquarePen,
  Trash2,
} from "lucide-react";
import { Loading, Select, SelectOption } from "./ui";
import { ArtifactView, type ArtifactHost } from "./MaviArtifacts";
import { AttachButton, AttachmentTray, FileChip, useAttachmentTray } from "./MaviAttachments";
import { conversationAttachments, type Attachment } from "./mavi-attachments";
import { CanvasPanel, type CanvasSaveRequest } from "./MaviCanvas";
import { AnswerCost, ConversationCostButton, messageCost } from "./MaviCost";
import { AnswerFeedback } from "./MaviFeedback";
import { myVotes, type MyVote } from "./mavi-feedback";
import {
  ARTIFACT_LINE,
  CAPPED_DETAIL,
  type ActionArtifact,
  type CanvasArtifact,
  type ImageArtifact,
} from "./mavi-artifacts";
import type { FormPreset } from "./forms";
import { skillCatalog } from "./mavi-skills";

/** Uma skill escolhida na caixa de mensagem (com versão: em teste). */
export type Picked = { slug: string; name: string; version?: number };
import { fold } from "./task-search";
import type { Snapshot } from "./types";
import {
  AnswerText,
  Steps,
  Typed,
  entriesFrom,
  useAiTurns,
  type AiSend,
  type ChatEntry,
} from "./AiChat";
import {
  ShareDialog,
  SUGGESTIONS_ALL,
  SUGGESTIONS_CLIENT,
} from "./AiAssistant";
import {
  activeRuns,
  askAi,
  myPowers,
  cancelRun,
  conversationCost,
  conversationMessages,
  type ConversationCost,
  deleteConversation,
  getConversation,
  listConversations,
  openAiSource,
  renameConversation,
  type ActiveRun,
  type AiAnswer,
  type AiConversation,
} from "./ai";

const SIDE_KEY = "mavi:chat-side";
function readSide() {
  try {
    return localStorage.getItem(SIDE_KEY) !== "closed";
  } catch {
    return true;
  }
}
const narrow = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(max-width: 900px)").matches;

/** O título que o servidor dá a uma conversa nova (ai_save_turn). */
export function titleFrom(question: string) {
  return question.replace(/\s+/g, " ").trim().slice(0, 80) || "Nova conversa";
}

/** A resposta como texto simples, para copiar (sem [S1] nem negrito). */
export function plainAnswer(text: string) {
  return text
    .replace(/\s?\[S\d{1,3}\]/g, "")
    .replace(/\*\*/g, "")
    .trim();
}

/**
 * As conversas em grupos por data, como no ChatGPT: Hoje, Ontem, Últimos 7
 * dias, Últimos 30 dias e, antes disso, um grupo por mês.
 */
export function groupByDate<T extends { updated_at: string }>(
  items: T[],
  now = new Date(),
) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = 86_400_000;
  const groups: { label: string; items: T[] }[] = [];
  for (const item of items) {
    const at = new Date(item.updated_at);
    const ago = start.getTime() - at.getTime();
    const label =
      ago <= 0
        ? "Hoje"
        : ago <= day
          ? "Ontem"
          : ago <= 7 * day
            ? "Últimos 7 dias"
            : ago <= 30 * day
              ? "Últimos 30 dias"
              : at.toLocaleDateString("pt-BR", {
                  month: "long",
                  year: "numeric",
                });
    const group = groups.find((g) => g.label === label);
    if (group) group.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups.map((g) => ({
    ...g,
    label: g.label.charAt(0).toUpperCase() + g.label.slice(1),
  }));
}

type Thread = {
  conversation: AiConversation | null;
  entries: ChatEntry[];
  /** Muda para recomeçar o chat (outra conversa). */
  key: number;
};

/**
 * O módulo MAVI: a mesma MAVI da bolinha, em tela cheia e do jeito do
 * ChatGPT e do Claude — as conversas à esquerda, agrupadas por data e com
 * busca; a conversa no centro e a caixa de mensagem embaixo. As conversas
 * são as mesmas da bolinha (salvas no banco) e cada uma tem o seu endereço.
 */
export function MaviChatPage({
  company,
  data,
  user,
  conversationId,
  href,
  onOpen,
  onNewTask,
  onComment,
  taskHref,
  skillsHref,
  onSkills,
  startSkill,
  onStartSkill,
  notify,
}: {
  company: string;
  data: Snapshot;
  user: string;
  /** A conversa do endereço (/mavi/conversas/<id>), ou null para uma nova. */
  conversationId: string | null;
  href: (id: string | null) => string;
  onOpen: (id: string | null, replace?: boolean) => void;
  /** Ações da MAVI: a tarefa proposta abre no formulário de sempre. */
  onNewTask: (preset: FormPreset) => void;
  onComment: (task: string, text: string) => Promise<unknown>;
  taskHref: (task: string) => string;
  /** MAVI › Skills. */
  skillsHref: string;
  onSkills: () => void;
  /** Uma skill pedida pelo endereço (?skill=…&versao=…): abre uma conversa nova com ela. */
  startSkill: { slug: string; version?: number } | null;
  /** A skill do endereço já foi usada (o endereço volta ao normal). */
  onStartSkill: () => void;
  notify: (message: string) => void;
}) {
  const [list, setList] = useState<AiConversation[] | null>(null);
  const [catalog, setCatalog] = useState<
    { slug: string; version: number; name: string; description: string }[]
  >([]);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [thread, setThread] = useState<Thread>({
    conversation: null,
    entries: [],
    key: 0,
  });
  const [loadingThread, setLoadingThread] = useState(false);
  const [client, setClient] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"mine" | "shared">("mine");
  const [error, setError] = useState("");
  const [sharing, setSharing] = useState<AiConversation | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [side, setSide] = useState(readSide);
  const [drawer, setDrawer] = useState(false);
  // A conversa na tela: quando o endereço muda para ela, nada a carregar.
  const onScreen = useRef<string | null>(null);
  // Respostas em andamento de quando a pessoa saiu (as desta tela ficam de fora).
  const [runs, setRuns] = useState<ActiveRun[]>([]);
  const ownRuns = useRef(new Set<string>());
  const [reload, setReload] = useState(0);
  // Anexos: o poder da pessoa e os arquivos da conversa aberta.
  const [canAttach, setCanAttach] = useState(false);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [filesTick, setFilesTick] = useState(0);

  const clients = data.clients
    .filter((c) => !c.archived)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { numeric: true }));
  const clientName = (id?: string) =>
    data.clients.find((c) => c.id === id)?.name ?? "";
  const memberName = (id: string) =>
    data.members.find((m) => m.user_id === id)?.name ?? "Alguém";
  const firstName = memberName(user).split(/\s+/)[0];

  useEffect(() => {
    myPowers(company)
      .then((p) => setCanAttach(Array.isArray(p) && p.includes("attachments")))
      .catch(() => setCanAttach(false));
  }, [company]);
  // As skills que a pessoa pode escolher (vazio sem o poder).
  useEffect(() => {
    skillCatalog(company)
      .then((c) => setCatalog(Array.isArray(c) ? c : []))
      .catch(() => setCatalog([]));
  }, [company]);
  // O nome das escolhidas chega com o catálogo.
  useEffect(() => {
    setPicked((list) =>
      list.map((p) => ({
        ...p,
        name: catalog.find((c) => c.slug === p.slug)?.name ?? p.name,
      })),
    );
  }, [catalog]);
  // "Usar na conversa" e "Testar esta versão" nas Skills: uma conversa nova com a skill.
  useEffect(() => {
    if (!startSkill) return;
    // O endereço volta ao normal (sem ?skill) sem entrar no histórico.
    newChat(false);
    setPicked([
      {
        slug: startSkill.slug,
        version: startSkill.version,
        name:
          catalog.find((c) => c.slug === startSkill.slug)?.name ?? startSkill.slug,
      },
    ]);
    onStartSkill();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startSkill?.slug, startSkill?.version]);

  useEffect(() => {
    // Cada aba vem do banco com o seu limite: as compartilhadas não somem
    // atrás de muitas conversas da pessoa.
    Promise.all([
      listConversations(company, 300, { user, side: "mine" }),
      listConversations(company, 300, { user, side: "shared" }),
    ])
      .then(([mine, shared]) => setList([...mine, ...shared]))
      .catch((e) => {
        setList([]);
        setError((e as Error).message);
      });
  }, [company, user, reload]);
  useEffect(() => {
    activeRuns(company)
      .then((l) => setRuns(l.filter((r) => !ownRuns.current.has(r.id))))
      .catch(() => setRuns([]));
  }, [company, conversationId, reload]);
  // Uma resposta terminou (aviso pelo tópico da pessoa): a conversa aberta recarrega.
  useEffect(() => {
    const done = (e: Event) => {
      const row = (e as CustomEvent<{ id: string; conversation: string | null }>).detail;
      if (!row || ownRuns.current.has(row.id)) return;
      setRuns((l) => l.filter((r) => r.id !== row.id));
      if (row.conversation && row.conversation === onScreen.current) onScreen.current = null;
      setReload((n) => n + 1);
    };
    window.addEventListener("mavi:ai-run", done);
    return () => window.removeEventListener("mavi:ai-run", done);
  }, []);
  // Uma tarefa longa desta conversa terminou: a resposta com o documento aparece.
  useEffect(() => {
    const ended = (e: Event) => {
      const row = (e as CustomEvent<{ conversation: string; status: string }>).detail;
      if (!row || !["done", "cancelled", "error"].includes(row.status)) return;
      if (row.conversation !== onScreen.current) return;
      onScreen.current = null;
      setReload((n) => n + 1);
    };
    window.addEventListener("mavi:ai-task", ended);
    return () => window.removeEventListener("mavi:ai-task", ended);
  }, []);

  // O endereço manda: abre a conversa dele (ou uma nova).
  useEffect(() => {
    if (conversationId === onScreen.current) return;
    if (!conversationId) {
      onScreen.current = null;
      setClient("");
      setThread((t) => ({ conversation: null, entries: [], key: t.key + 1 }));
      return;
    }
    let alive = true;
    setLoadingThread(true);
    setError("");
    Promise.all([
      getConversation(company, conversationId),
      conversationMessages(conversationId),
    ])
      .then(([c, messages]) => {
        if (!alive) return;
        if (!c) throw Error("Conversa não encontrada ou sem acesso.");
        onScreen.current = c.id;
        // Uma compartilhada aberta pelo endereço aparece na aba dela.
        if (c.owner_id !== user) setTab("shared");
        setClient(c.scope?.client ?? "");
        setThread((t) => ({
          conversation: c,
          entries: entriesFrom(messages),
          key: t.key + 1,
        }));
      })
      .catch((e) => {
        if (alive) setError((e as Error).message);
      })
      .finally(() => {
        if (alive) setLoadingThread(false);
      });
    return () => {
      alive = false;
    };
  }, [company, conversationId, reload]);

  const openId = thread.conversation?.id ?? null;
  useEffect(() => {
    if (!openId) {
      setFiles([]);
      return;
    }
    let alive = true;
    conversationAttachments(openId)
      .then((l) => {
        if (alive) setFiles(l);
      })
      .catch(() => {
        if (alive) setFiles([]);
      });
    return () => {
      alive = false;
    };
  }, [openId, filesTick, reload]);
  // O custo da conversa, por modelo (quem começou e os gestores veem).
  const [costs, setCosts] = useState<ConversationCost | null>(null);
  useEffect(() => {
    if (!openId) {
      setCosts(null);
      return;
    }
    let alive = true;
    conversationCost(openId)
      .then((c) => alive && setCosts(c))
      .catch(() => alive && setCosts(null));
    return () => {
      alive = false;
    };
  }, [openId, filesTick, reload]);

  function toggleSide() {
    if (narrow()) {
      setDrawer((v) => !v);
      return;
    }
    const next = !side;
    setSide(next);
    try {
      localStorage.setItem(SIDE_KEY, next ? "open" : "closed");
    } catch {
      // Lembrar o painel aberto é só uma conveniência.
    }
  }
  function newChat(go = true) {
    onScreen.current = null;
    setPicked([]);
    setClient("");
    setError("");
    setDrawer(false);
    setTab("mine");
    setThread((t) => ({ conversation: null, entries: [], key: t.key + 1 }));
    if (go) onOpen(null);
  }
  function open(c: AiConversation) {
    setDrawer(false);
    if (c.id !== thread.conversation?.id) onOpen(c.id);
  }
  /** A resposta começou: a conversa nova já existe (aparece na lista e no endereço). */
  function started(run: { id: string; conversation: string }, question: string) {
    ownRuns.current.add(run.id);
    if (thread.conversation || onScreen.current === run.conversation) return;
    const c: AiConversation = {
      id: run.conversation,
      owner_id: user,
      title: titleFrom(question),
      scope: client ? { client } : {},
      module: "assistant",
      updated_at: new Date().toISOString(),
    };
    onScreen.current = c.id;
    setThread((t) => ({ ...t, conversation: c }));
    setList((l) => [c, ...(l ?? []).filter((x) => x.id !== c.id)]);
    onOpen(c.id, true);
  }
  function answered(a: AiAnswer, question: string) {
    setFilesTick((n) => n + 1);
    const current = thread.conversation;
    if (!current && a.conversation) {
      const c: AiConversation = {
        id: a.conversation,
        owner_id: user,
        title: titleFrom(question),
        scope: client ? { client } : {},
        module: "assistant",
        updated_at: new Date().toISOString(),
      };
      onScreen.current = c.id;
      setThread((t) => ({ ...t, conversation: c }));
      setList((l) => [c, ...(l ?? []).filter((x) => x.id !== c.id)]);
      onOpen(c.id, true);
    } else if (current) {
      const c = { ...current, updated_at: new Date().toISOString() };
      setList((l) => l && [c, ...l.filter((x) => x.id !== c.id)]);
    }
  }
  async function rename(c: AiConversation, raw: string) {
    setRenaming(null);
    const title = raw.trim();
    if (!title || title === c.title) return;
    try {
      await renameConversation(c.id, title);
      setList((l) => l?.map((x) => (x.id === c.id ? { ...x, title } : x)) ?? l);
      if (thread.conversation?.id === c.id)
        setThread((t) => ({ ...t, conversation: { ...c, title } }));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function remove(c: AiConversation) {
    if (!window.confirm(`Apagar a conversa "${c.title}"?`)) return;
    try {
      await deleteConversation(c.id);
      setList((l) => l?.filter((x) => x.id !== c.id) ?? l);
      if (thread.conversation?.id === c.id) newChat();
      notify("Conversa apagada.");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const conv = thread.conversation;
  const readOnly = !!conv && conv.owner_id !== user;
  const q = fold(query.trim());
  const found = (list ?? []).filter((c) => !q || fold(c.title).includes(q));
  const mine = found.filter((c) => c.owner_id === user);
  const shared = found.filter((c) => c.owner_id !== user);
  const groups = groupByDate(tab === "mine" ? mine : shared);
  const sharedTotal = (list ?? []).filter((c) => c.owner_id !== user).length;

  const item = (c: AiConversation) => {
    const active = conv?.id === c.id;
    return (
      <li key={c.id} className={active ? "active" : ""}>
        {renaming === c.id ? (
          <input
            className="mavi-rename"
            defaultValue={c.title}
            maxLength={200}
            aria-label="Novo nome da conversa"
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => void rename(c, e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setRenaming(null);
            }}
          />
        ) : (
          <a
            href={href(c.id)}
            className="mavi-item"
            aria-current={active ? "page" : undefined}
            title={c.title}
            onClick={(e: MouseEvent<HTMLAnchorElement>) => {
              if (
                e.button !== 0 ||
                e.metaKey ||
                e.ctrlKey ||
                e.shiftKey ||
                e.altKey
              )
                return;
              e.preventDefault();
              open(c);
            }}
          >
            <span>{c.title}</span>
            {(c.owner_id !== user || c.scope?.client) && (
              <small>
                {c.owner_id !== user && (
                  <>
                    de{" "}
                    <span data-person={c.owner_id}>{memberName(c.owner_id)}</span>
                  </>
                )}
                {c.owner_id !== user && c.scope?.client && " · "}
                {c.scope?.client ? clientName(c.scope.client) : ""}
              </small>
            )}
          </a>
        )}
        {c.owner_id === user && renaming !== c.id && (
          <ItemMenu
            title={c.title}
            onRename={() => setRenaming(c.id)}
            onShare={() => setSharing(c)}
            onDelete={() => void remove(c)}
          />
        )}
      </li>
    );
  };

  return (
    <div
      className={`mavi-chat${side ? "" : " side-closed"}${drawer ? " drawer-open" : ""}`}
    >
      <aside className="mavi-side" aria-label="Conversas com a MAVI">
        <div className="mavi-side-head">
          <button type="button" className="mavi-new" onClick={() => newChat()}>
            <SquarePen size={16} aria-hidden="true" /> Nova conversa
          </button>
          <a
            href={skillsHref}
            className="icon-btn"
            aria-label="Skills da MAVI"
            title="Skills da MAVI"
            onClick={(e: MouseEvent<HTMLAnchorElement>) => {
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
                return;
              e.preventDefault();
              onSkills();
            }}
          >
            <Puzzle size={17} />
          </a>
          <button
            type="button"
            className="icon-btn"
            aria-label="Esconder as conversas"
            title="Esconder as conversas"
            onClick={toggleSide}
          >
            <PanelLeft size={18} />
          </button>
        </div>
        <div className="mavi-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            placeholder="Buscar conversas"
            aria-label="Buscar conversas"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="mavi-tabs" role="tablist" aria-label="Conversas">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "mine"}
            onClick={() => setTab("mine")}
          >
            Minhas
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "shared"}
            onClick={() => setTab("shared")}
          >
            Compartilhadas
            {sharedTotal > 0 && <span className="mavi-tab-count">{sharedTotal}</span>}
          </button>
        </div>
        <nav
          className="mavi-list"
          aria-label={tab === "mine" ? "Minhas conversas" : "Conversas compartilhadas"}
        >
          {list === null ? (
            <Loading compact />
          ) : !groups.length ? (
            <p className="mavi-list-empty">
              {q
                ? "Nenhuma conversa com esse nome."
                : tab === "mine"
                  ? "Suas conversas com a MAVI aparecem aqui."
                  : "As conversas que compartilharem com você aparecem aqui."}
            </p>
          ) : (
            groups.map((g) => (
              <section key={g.label}>
                <h3>{g.label}</h3>
                <ul>{g.items.map(item)}</ul>
              </section>
            ))
          )}
        </nav>
      </aside>
      {drawer && (
        <button
          type="button"
          className="mavi-scrim"
          aria-label="Fechar as conversas"
          onClick={() => setDrawer(false)}
        />
      )}

      <section className="mavi-main" aria-label="Conversa com a MAVI">
        <header className="mavi-head">
          <button
            type="button"
            className="icon-btn mavi-head-toggle"
            aria-label="Mostrar as conversas"
            title="Mostrar as conversas"
            onClick={toggleSide}
          >
            <PanelLeft size={18} />
          </button>
          <button
            type="button"
            className="icon-btn mavi-head-new"
            aria-label="Nova conversa"
            title="Nova conversa"
            onClick={() => newChat()}
          >
            <SquarePen size={17} />
          </button>
          <div className="mavi-head-title">
            <strong title={conv?.title}>{conv?.title ?? "MAVI"}</strong>
            {conv && (
              <small>
                {readOnly && (
                  <>
                    Compartilhada por{" "}
                    <span data-person={conv.owner_id}>
                      {memberName(conv.owner_id)}
                    </span>
                    {" · "}
                  </>
                )}
                {conv.scope?.client
                  ? `Cliente ${clientName(conv.scope.client)}`
                  : "Todos os clientes"}
              </small>
            )}
          </div>
          {conv && costs && <ConversationCostButton costs={costs} />}
          {conv && !readOnly && (
            <button
              type="button"
              className="btn secondary mavi-share"
              onClick={() => setSharing(conv)}
            >
              <Share2 size={15} /> <span>Compartilhar</span>
            </button>
          )}
        </header>
        {loadingThread ? (
          <div className="mavi-thread">
            <Loading variant="chat" />
          </div>
        ) : (
          <ChatThread
            key={thread.key}
            initial={thread.entries}
            canAttach={canAttach && !readOnly}
            files={files}
            readOnly={readOnly}
            greeting={`Como posso ajudar, ${firstName}?`}
            intro={
              client
                ? `Pergunte sobre o cliente ${clientName(client)}: a MAVI busca nas reuniões, tarefas, arquivos e conversas dele e mostra de onde tirou cada informação.`
                : "Pergunte sobre qualquer cliente que você acessa: a MAVI busca nas reuniões, tarefas, arquivos e conversas e mostra de onde tirou cada informação."
            }
            placeholder={
              client
                ? `Pergunte sobre o cliente ${clientName(client)}`
                : "Pergunte qualquer coisa à MAVI"
            }
            suggestions={client ? SUGGESTIONS_CLIENT : SUGGESTIONS_ALL}
            error={error}
            onNew={newChat}
            scope={
              <>
              <Select
                className="mavi-scope"
                aria-label="Sobre qual cliente"
                value={client || "all"}
                disabled={!!conv}
                onValueChange={(v) => setClient(v === "all" ? "" : v)}
              >
                <SelectOption value="all">Todos os clientes</SelectOption>
                {clients.map((c) => (
                  <SelectOption key={c.id} value={c.id}>
                    Cliente {c.name}
                  </SelectOption>
                ))}
              </Select>
              <SkillPicker
                catalog={catalog}
                picked={picked}
                onChange={setPicked}
              />
              </>
            }
            send={(question, _history, handlers, extra) =>
              askAi(
                company,
                { client: client || undefined, module: "assistant" },
                question,
                conv?.id ?? null,
                handlers,
                extra?.signal,
                "page",
                picked.map(({ slug, version }) => ({ slug, version })),
                extra?.confirm,
                extra?.attachments,
              )
            }
            onAnswer={answered}
            onRun={started}
            costs={costs}
            background={runs.find((r) => r.conversation === (conv?.id ?? null)) ?? null}
            host={{
              company,
              conversation: conv?.id ?? null,
              onNewTask,
              onComment,
              taskHref,
              notify,
              drive: {
                data,
                user,
                isLeader: ["admin", "manager"].includes(data.members.find((m) => m.user_id === user)?.role ?? ""),
                ...(client ? { start: { client } } : {}),
              },
            }}
          />
        )}
      </section>
      {sharing && (
        <ShareDialog
          conversation={sharing}
          data={data}
          user={user}
          onClose={() => setSharing(null)}
          notify={notify}
        />
      )}
    </div>
  );
}

function ItemMenu({
  title,
  onRename,
  onShare,
  onDelete,
}: {
  title: string;
  onRename: () => void;
  onShare: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="icon-btn mavi-item-more"
          aria-label={`Opções de ${title}`}
        >
          <MoreHorizontal size={16} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="status-menu mavi-item-menu"
          align="start"
          sideOffset={4}
          role="menu"
        >
          <button type="button" role="menuitem" onClick={pick(onRename)}>
            <Pencil size={14} /> Renomear
          </button>
          <button type="button" role="menuitem" onClick={pick(onShare)}>
            <Share2 size={14} /> Compartilhar
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={pick(onDelete)}
          >
            <Trash2 size={14} /> Apagar
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * A conversa da bolinha: a mesma do módulo (skills, visualizações, imagens,
 * canvas, anexos, ações, custo), num painel estreito. A bolinha cuida da
 * conversa aberta e do cliente; aqui ficam os poderes da pessoa e o resto.
 */
export function BubbleThread({
  company,
  conversation,
  client,
  initial,
  readOnly,
  greeting,
  intro,
  placeholder,
  suggestions,
  onNew,
  onRun,
  onAnswer,
  onReload,
  onNewTask,
  onComment,
  taskHref,
  notify,
}: {
  company: string;
  /** A conversa aberta (null: nova, até a resposta começar). */
  conversation: string | null;
  client: string;
  initial: ChatEntry[];
  readOnly: boolean;
  greeting: string;
  intro: string;
  placeholder: string;
  suggestions: string[];
  onNew: () => void;
  onRun: (run: { id: string; conversation: string }) => void;
  onAnswer: (answer: AiAnswer) => void;
  /** Uma resposta desta conversa terminou longe daqui: recarregar. */
  onReload: () => void;
  onNewTask: (preset: FormPreset) => void;
  onComment: (task: string, text: string) => Promise<unknown>;
  taskHref: (task: string) => string;
  notify: (message: string) => void;
}) {
  const [catalog, setCatalog] = useState<{ slug: string; name: string; description: string }[]>([]);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [canAttach, setCanAttach] = useState(false);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [costs, setCosts] = useState<ConversationCost | null>(null);
  const [tick, setTick] = useState(0);
  const [runs, setRuns] = useState<ActiveRun[]>([]);
  const ownRuns = useRef(new Set<string>());
  const reload = useRef(onReload);
  reload.current = onReload;
  useEffect(() => {
    myPowers(company)
      .then((p) => setCanAttach(Array.isArray(p) && p.includes("attachments")))
      .catch(() => setCanAttach(false));
    // As skills que a pessoa pode escolher (vazio sem o poder).
    skillCatalog(company)
      .then((c) => setCatalog(Array.isArray(c) ? c : []))
      .catch(() => setCatalog([]));
  }, [company]);
  useEffect(() => {
    if (!conversation) {
      setFiles([]);
      setCosts(null);
      return;
    }
    let alive = true;
    conversationAttachments(conversation)
      .then((l) => alive && setFiles(l))
      .catch(() => alive && setFiles([]));
    conversationCost(conversation)
      .then((c) => alive && setCosts(c))
      .catch(() => alive && setCosts(null));
    return () => {
      alive = false;
    };
  }, [conversation, tick]);
  // Voltou para uma conversa que ainda está respondendo (de quando saiu).
  useEffect(() => {
    if (!conversation) {
      setRuns([]);
      return;
    }
    activeRuns(company)
      .then((l) => setRuns(l.filter((r) => !ownRuns.current.has(r.id))))
      .catch(() => setRuns([]));
  }, [company, conversation]);
  // Uma resposta (ou tarefa longa) desta conversa terminou: recarrega.
  useEffect(() => {
    const done = (e: Event) => {
      const row = (e as CustomEvent<{ id: string; conversation: string | null }>).detail;
      if (!row || ownRuns.current.has(row.id) || !row.conversation || row.conversation !== conversation) return;
      setRuns((l) => l.filter((r) => r.id !== row.id));
      reload.current();
    };
    const ended = (e: Event) => {
      const row = (e as CustomEvent<{ conversation: string; status: string }>).detail;
      if (!row || !["done", "cancelled", "error"].includes(row.status)) return;
      if (row.conversation === conversation) reload.current();
    };
    window.addEventListener("mavi:ai-run", done);
    window.addEventListener("mavi:ai-task", ended);
    return () => {
      window.removeEventListener("mavi:ai-run", done);
      window.removeEventListener("mavi:ai-task", ended);
    };
  }, [conversation]);
  return (
    <ChatThread
      initial={initial}
      canAttach={canAttach && !readOnly}
      files={files}
      readOnly={readOnly}
      greeting={greeting}
      intro={intro}
      placeholder={placeholder}
      suggestions={suggestions}
      error=""
      onNew={onNew}
      scope={<SkillPicker catalog={catalog} picked={picked} onChange={setPicked} />}
      send={(question, _history, handlers, extra) =>
        askAi(
          company,
          {
            client: client || undefined,
            module: "assistant",
            // A tela em que a pessoa está: os tutoriais dela vêm primeiro.
            screen: tutorialModuleOf(resolvePage(window.location.pathname)) ?? undefined,
          },
          question,
          conversation,
          handlers,
          extra?.signal,
          "bubble",
          picked.map(({ slug, version }) => ({ slug, version })),
          extra?.confirm,
          extra?.attachments,
        )
      }
      onAnswer={(a) => {
        setTick((n) => n + 1);
        onAnswer(a);
      }}
      onRun={(run) => {
        ownRuns.current.add(run.id);
        onRun(run);
      }}
      costs={costs}
      background={runs.find((r) => r.conversation === conversation) ?? null}
      host={{ company, conversation, onNewTask, onComment, taskHref, notify }}
    />
  );
}

/** Uma conversa: vazia, a saudação com a caixa no meio; depois, as mensagens. */
function ChatThread({
  initial,
  readOnly,
  greeting,
  intro,
  placeholder,
  suggestions,
  error: pageError,
  scope,
  send,
  onAnswer,
  onRun,
  background,
  canAttach,
  files,
  onNew,
  host,
  costs,
}: {
  initial: ChatEntry[];
  readOnly: boolean;
  greeting: string;
  intro: string;
  placeholder: string;
  suggestions: string[];
  error: string;
  scope: ReactNode;
  send: AiSend;
  onAnswer: (answer: AiAnswer, question: string) => void;
  /** A resposta começou no servidor: a conversa nova já existe. */
  onRun: (run: { id: string; conversation: string }, question: string) => void;
  /** Uma resposta desta conversa ainda em andamento (de quando a pessoa saiu). */
  background: ActiveRun | null;
  /** O poder de anexar (módulo MAVI) e os arquivos já anexados na conversa. */
  canAttach: boolean;
  files: Attachment[];
  onNew: () => void;
  /** O custo da conversa (as respostas salvas mostram o delas). */
  costs: ConversationCost | null;
  host: Omit<
    ArtifactHost,
    "readOnly" | "streaming" | "onDraft" | "onOpenCanvas" | "onReply" | "answered" | "onConfirmMcp"
  >;
}) {
  const chat = useAiTurns({ initial, send, readOnly, onAnswer, onRun });
  // As minhas avaliações das respostas desta conversa (👍/👎).
  const [votes, setVotes] = useState<Map<number, MyVote>>(new Map());
  useEffect(() => {
    if (!host.conversation) {
      setVotes(new Map());
      return;
    }
    let alive = true;
    void myVotes(host.conversation).then((l) => alive && setVotes(new Map(l.map((v) => [v.message, v]))));
    return () => {
      alive = false;
    };
  }, [host.conversation]);
  const [stoppingBackground, setStoppingBackground] = useState(false);
  const tray = useAttachmentTray(host.company, host.conversation);
  const [dragging, setDragging] = useState(false);
  const { turns, busy } = chat;
  const error = chat.error || pageError;
  const [draft, setDraft] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  // Acompanha o fim da conversa enquanto a pessoa não rolar para cima.
  useEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  // A caixa cresce com o texto, até um limite.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft]);
  useEffect(() => {
    if (!narrow()) input.current?.focus();
  }, []);

  async function submit(question: string) {
    if (busy || readOnly || background || tray.working) return;
    // Só arquivos, sem texto: a MAVI olha os anexos.
    const ready = tray.ready.map((x) => x.attachment!);
    const q =
      question.trim() || (ready.length ? (ready.length === 1 ? "Veja o arquivo anexado." : "Veja os arquivos anexados.") : "");
    if (!q) return;
    setDraft("");
    stick.current = true;
    const ok = await chat.submit(
      q,
      ready.length
        ? {
            attachments: ready.map((a) => a.id),
            files: ready.map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
          }
        : undefined,
    );
    if (!ok) setDraft(question.trim());
    else if (ready.length) tray.sent();
    input.current?.focus();
  }
  // O canvas: abre sozinho quando a MAVI cria ou ajusta um documento.
  const [canvas, setCanvas] = useState<CanvasArtifact | null>(null);
  const [saveRequest, setSaveRequest] = useState<CanvasSaveRequest | null>(null);
  const seen = useRef(
    new Set(initial.flatMap((t) => (t.artifacts ?? []).map((a) => a.id))),
  );
  useEffect(() => {
    const last = turns[turns.length - 1];
    const fresh = (last?.artifacts ?? []).filter(
      (a): a is CanvasArtifact => a.type === "canvas" && !seen.current.has(a.id),
    );
    for (const a of last?.artifacts ?? []) seen.current.add(a.id);
    if (fresh.length) setCanvas(fresh[fresh.length - 1]);
  }, [turns]);
  const images = new Map<string, ImageArtifact>();
  for (const t of turns)
    for (const a of t.artifacts ?? []) if (a.type === "image") images.set(a.ref, a);
  const artifactHost = {
    ...host,
    readOnly,
    onOpenCanvas: (a: CanvasArtifact) => {
      setSaveRequest(null);
      setCanvas(a);
    },
    onReply: (text: string) => void submit(text),
    // A MAVI propôs salvar no Drive: o documento abre com a janela pronta.
    onSaveToDrive: host.drive
      ? (a: ActionArtifact, done: (file: string) => void) => {
          if (a.action.kind !== "drive_save") return false;
          const p = a.action;
          const doc = [...turns]
            .reverse()
            .flatMap((t) => [...(t.artifacts ?? [])].reverse())
            .find((x): x is CanvasArtifact => x.type === "canvas" && x.ref === p.ref);
          if (!doc) return false;
          setSaveRequest({
            format: p.format,
            name: p.file_name,
            start: p.folder_id
              ? { client: p.client_id, contract: p.contract_id, folder: p.folder_id }
              : p.contract_id
                ? { client: p.client_id, contract: p.contract_id }
                : p.client_id
                  ? { client: p.client_id }
                  : {},
            onSaved: done,
          });
          setCanvas(doc);
          return true;
        }
      : undefined,
    // Confirmou a ação de uma conexão: a MAVI roda e continua (nova resposta).
    onConfirmMcp: (a: ActionArtifact) => {
      if (busy || readOnly || a.action.kind !== "mcp_call") return Promise.resolve(false);
      stick.current = true;
      return chat.submit(`Confirmo: ${a.action.server_name} › ${a.action.tool_title || a.action.tool}`, {
        confirm: a.id,
      });
    },
    onDraft: (text: string) => {
      setDraft(text);
      requestAnimationFrame(() => {
        const el = input.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(text.length, text.length);
      });
    },
  };
  // Os anexos que a resposta (já escrita) não colocou numa linha [[V1]].
  const unplaced = (t: ChatEntry) => {
    const placed = new Set(
      t.content
        .split("\n")
        .map((l) => l.match(ARTIFACT_LINE)?.[1])
        .filter(Boolean),
    );
    // As versões de uma arte que a própria MAVI corrigiu nesta resposta ficam
    // de fora: aparece a final.
    const revised = new Set(
      (t.artifacts ?? []).flatMap((a) => (a.type === "image" && a.art && a.edited_from ? [a.edited_from] : [])),
    );
    return (t.artifacts ?? []).filter((a) => !placed.has(a.ref) && !revised.has(a.ref));
  };

  const composer = readOnly ? (
    <div className="mavi-readonly">
      <Lock size={14} aria-hidden="true" />
      <span>
        Conversa compartilhada: só quem a começou continua. Para perguntar,
        abra uma nova conversa.
      </span>
      <button type="button" className="btn secondary" onClick={onNew}>
        Nova conversa
      </button>
    </div>
  ) : (
    <form
      className={`mavi-composer${dragging ? " dragging" : ""}`}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void submit(draft);
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) input.current?.focus();
      }}
      onDragOver={(e) => {
        if (!canAttach || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!canAttach || !e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        tray.add(e.dataTransfer.files);
      }}
    >
      {canAttach && <AttachmentTray items={tray.items} onRemove={tray.remove} />}
      <textarea
        ref={input}
        onPaste={(e) => {
          if (!canAttach || !e.clipboardData.files.length) return;
          e.preventDefault();
          tray.add(e.clipboardData.files);
        }}
        rows={1}
        value={draft}
        maxLength={2000}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit(draft);
          }
        }}
      />
      <div className="mavi-composer-bar">
        <span className="mavi-composer-left">
          {canAttach && <AttachButton onFiles={tray.add} disabled={readOnly} />}
          {scope}
        </span>
        {busy ? (
          <button
            type="button"
            className="mavi-send stop"
            disabled={chat.stopping}
            onClick={() => void chat.stop()}
            aria-label="Parar a resposta"
            title="Parar a resposta"
          >
            {chat.stopping ? <Loader2 size={17} className="spin" /> : <Square size={13} fill="currentColor" />}
          </button>
        ) : (
          <button
            type="submit"
            className="mavi-send"
            disabled={(draft.trim().length < 2 && !tray.ready.length) || !!background || tray.working}
            title={tray.working ? "Aguardando os anexos" : "Enviar (Enter)"}
            aria-label="Enviar"
          >
            <ArrowUp size={18} />
          </button>
        )}
      </div>
    </form>
  );
  const errorBox = error && (
    <p className="form-error mavi-error" role="alert">
      {error}
    </p>
  );
  // Voltou para uma conversa que ainda está respondendo (de quando saiu).
  // Com uma resposta em andamento, nada fica para preencher (perguntas e ações esperam).
  const waitingBackground = !!background && !busy;
  const backgroundBox = background && !busy && (
    <div className="mavi-background" role="status">
      <Loader2 size={16} className="spin" aria-hidden="true" />
      <p>
        <strong>A MAVI ainda está respondendo</strong>
        <span>
          “{background.question}{background.question.length >= 80 ? "…" : ""}”. A conversa
          atualiza sozinha quando terminar, e o aviso chega na sua caixa de entrada.
        </span>
      </p>
      {!background.cancel_requested && (
        <button
          type="button"
          className="btn secondary"
          disabled={stoppingBackground}
          onClick={() => {
            setStoppingBackground(true);
            void cancelRun(background.id).catch(() => setStoppingBackground(false));
          }}
        >
          {stoppingBackground ? <Loader2 size={14} className="spin" /> : <Square size={11} fill="currentColor" />}
          {stoppingBackground ? "Parando…" : "Parar"}
        </button>
      )}
    </div>
  );

  if (!turns.length)
    return (
      <div className="mavi-thread empty">
        <div className="mavi-hero">
          <span className="mavi-hero-mark" aria-hidden="true">
            <Sparkles size={22} />
          </span>
          <h2>{greeting}</h2>
          <p>{intro}</p>
          {errorBox}
          {backgroundBox}
          {composer}
          {!readOnly && (
            <div className="mavi-suggestions">
              {suggestions.map((s) => (
                <button key={s} type="button" onClick={() => void submit(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );

  return (
    <div className={`mavi-thread${canvas ? " with-canvas" : ""}`}>
      <div className="mavi-convo">
      <div
        ref={log}
        className="mavi-log"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        <div className="mavi-col">
          {files.length > 0 && (
            <div className="mavi-conv-files" aria-label="Anexos desta conversa">
              <span>
                <Paperclip size={13} aria-hidden="true" /> Anexos desta conversa
              </span>
              {files.map((f) => (
                <FileChip key={f.id} file={f} />
              ))}
            </div>
          )}
          {turns.map((t, i) =>
            t.role === "user" ? (
              <div key={i} className="mavi-msg user">
                {!!t.files?.length && (
                  <div className="mavi-msg-files">
                    {t.files.map((f) => (
                      <FileChip key={f.id} file={f} />
                    ))}
                  </div>
                )}
                <p>{t.content}</p>
              </div>
            ) : (
              <div key={i} className="mavi-msg ai">
                <span className="mavi-avatar" aria-hidden="true">
                  <Sparkles size={14} />
                </span>
                <div className="mavi-msg-body">
                  <Steps
                    steps={t.steps ?? []}
                    thinking={t.thinking}
                    streaming={!!t.streaming}
                    writing={!!t.content}
                  />
                  {t.warnings?.map((w, k) => (
                    <p key={k} className="ai-warning">
                      <AlertTriangle size={13} aria-hidden="true" /> {w}
                    </p>
                  ))}
                  {(t.content || !t.streaming) && (
                    <Typed
                      text={t.content}
                      streaming={!!t.streaming}
                      render={(text, typing) => (
                        <AnswerText
                          text={text}
                          sources={typing ? [] : (t.sources ?? [])}
                          onSource={openAiSource}
                          rich
                          renderArtifact={(ref) => {
                            const a = t.artifacts?.find((x) => x.ref === ref);
                            return a ? (
                              <ArtifactView
                                artifact={a}
                                host={{
                          ...artifactHost,
                          streaming: !!t.streaming || waitingBackground,
                          answered: i < turns.length - 1 || waitingBackground,
                        }}
                              />
                            ) : null;
                          }}
                        />
                      )}
                    />
                  )}
                  {/* O que a resposta não pôs no lugar aparece no fim. */}
                  {unplaced(t).map((a) => (
                    <div key={a.id} className="answer-artifact">
                      <ArtifactView
                        artifact={a}
                        host={{
                          ...artifactHost,
                          streaming: !!t.streaming || waitingBackground,
                          answered: i < turns.length - 1 || waitingBackground,
                        }}
                      />
                    </div>
                  ))}
                  {!t.streaming && t.content && (
                    <div className="mavi-msg-actions">
                      <CopyButton text={plainAnswer(t.content)} />
                      {/* Parou no limite de passos: continua de onde parou. */}
                      {i === turns.length - 1 &&
                        !readOnly &&
                        (t.steps ?? []).some((s) => s.detail === CAPPED_DETAIL) && (
                          <button
                            type="button"
                            className="mavi-continue"
                            disabled={busy || !!background}
                            onClick={() => void submit("Continue de onde parou.")}
                          >
                            <Play size={12} aria-hidden="true" /> Continuar de onde parou
                          </button>
                        )}
                      {typeof t.id === "number" && (
                        <AnswerFeedback
                          message={t.id}
                          mine={votes.get(t.id) ?? null}
                          onChange={(v) =>
                            setVotes((m) => {
                              const next = new Map(m);
                              if (v) next.set(t.id!, v);
                              else next.delete(t.id!);
                              return next;
                            })
                          }
                        />
                      )}
                      {(() => {
                        // O do banco tem tudo (anexos lidos e o resumo que a resposta disparou).
                        const cost = messageCost(costs, t.id) ?? t.cost;
                        const route = t.route ?? (typeof t.id === "number" ? costs?.routes?.[t.id] : undefined);
                        return cost ? <AnswerCost cost={cost} route={route} /> : null;
                      })()}
                    </div>
                  )}
                </div>
              </div>
            ),
          )}
          {errorBox}
          {backgroundBox}
        </div>
      </div>
      <div className="mavi-dock">
        {composer}
        <p className="mavi-disclaimer">
          A MAVI pode errar. Confira as fontes citadas em cada resposta.
        </p>
      </div>
      </div>
      {canvas && (
        <CanvasPanel
          key={`${canvas.id}-${saveRequest ? "salvar" : ""}`}
          artifact={canvas}
          host={{ ...artifactHost, streaming: false }}
          images={images}
          saveRequest={saveRequest}
          onClose={() => {
            setCanvas(null);
            setSaveRequest(null);
          }}
        />
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={done ? "Copiada" : "Copiar resposta"}
      title={done ? "Copiada" : "Copiar resposta"}
      onClick={() =>
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setDone(true))
          .catch(() => undefined)
      }
    >
      {done ? <Check size={15} /> : <Copy size={15} />}
    </button>
  );
}

/** As skills desta conversa: o botão para escolher e as escolhidas. */
function SkillPicker({
  catalog,
  picked,
  onChange,
}: {
  catalog: { slug: string; name: string; description: string }[];
  picked: Picked[];
  onChange: (next: Picked[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  if (!catalog.length && !picked.length) return null;
  const q = fold(query.trim());
  const shown = catalog.filter(
    (c) => !q || fold(`${c.name} ${c.slug} ${c.description}`).includes(q),
  );
  const has = (slug: string) => picked.some((p) => p.slug === slug);
  return (
    <span className="mavi-skill-pick">
      {picked.map((p) => (
        <span key={p.slug} className={`mavi-skill-chip${p.version ? " test" : ""}`}>
          <Puzzle size={12} aria-hidden="true" />
          <span>
            {p.name}
            {p.version ? ` · v${p.version} em teste` : ""}
          </span>
          <button
            type="button"
            aria-label={`Tirar a skill ${p.name}`}
            onClick={() => onChange(picked.filter((x) => x.slug !== p.slug))}
          >
            ×
          </button>
        </span>
      ))}
      {!!catalog.length && picked.length < 3 && (
        <Popover.Root open={open} onOpenChange={setOpen}>
          <Popover.Trigger asChild>
            <button
              type="button"
              className="mavi-skill-add"
              aria-label="Escolher uma skill"
              title="Escolher uma skill para esta conversa"
            >
              <Puzzle size={14} />
              {!picked.length && <span>Skills</span>}
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              className="status-menu mavi-skill-menu"
              align="start"
              side="top"
              sideOffset={6}
            >
              {catalog.length > 6 && (
                <input
                  className="mavi-skill-search"
                  type="search"
                  autoFocus
                  placeholder="Buscar skill"
                  aria-label="Buscar skill"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              )}
              <p>Skills da agência</p>
              <div className="mavi-skill-options">
                {shown.map((c) => (
                  <button
                    key={c.slug}
                    type="button"
                    disabled={has(c.slug)}
                    onClick={() => {
                      onChange([...picked, { slug: c.slug, name: c.name }]);
                      setOpen(false);
                      setQuery("");
                    }}
                  >
                    <strong>{c.name}</strong>
                    <small>{c.description}</small>
                  </button>
                ))}
                {!shown.length && <small className="mavi-skill-none">Nenhuma skill.</small>}
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}
    </span>
  );
}

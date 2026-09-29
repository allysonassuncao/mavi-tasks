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
  Search,
  Share2,
  Sparkles,
  SquarePen,
  Trash2,
} from "lucide-react";
import { Loading, Select, SelectOption } from "./ui";
import { ArtifactView, type ArtifactHost } from "./MaviArtifacts";
import { ARTIFACT_LINE } from "./mavi-artifacts";
import type { FormPreset } from "./forms";
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
  askAi,
  conversationMessages,
  deleteConversation,
  getConversation,
  listConversations,
  openAiSource,
  renameConversation,
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
  notify: (message: string) => void;
}) {
  const [list, setList] = useState<AiConversation[] | null>(null);
  const [thread, setThread] = useState<Thread>({
    conversation: null,
    entries: [],
    key: 0,
  });
  const [loadingThread, setLoadingThread] = useState(false);
  const [client, setClient] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [sharing, setSharing] = useState<AiConversation | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [side, setSide] = useState(readSide);
  const [drawer, setDrawer] = useState(false);
  // A conversa na tela: quando o endereço muda para ela, nada a carregar.
  const onScreen = useRef<string | null>(null);

  const clients = data.clients
    .filter((c) => !c.archived)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { numeric: true }));
  const clientName = (id?: string) =>
    data.clients.find((c) => c.id === id)?.name ?? "";
  const memberName = (id: string) =>
    data.members.find((m) => m.user_id === id)?.name ?? "Alguém";
  const firstName = memberName(user).split(/\s+/)[0];

  useEffect(() => {
    listConversations(company, 300)
      .then(setList)
      .catch((e) => {
        setList([]);
        setError((e as Error).message);
      });
  }, [company]);

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
  }, [company, conversationId]);

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
  function newChat() {
    onScreen.current = null;
    setClient("");
    setError("");
    setDrawer(false);
    setThread((t) => ({ conversation: null, entries: [], key: t.key + 1 }));
    onOpen(null);
  }
  function open(c: AiConversation) {
    setDrawer(false);
    if (c.id !== thread.conversation?.id) onOpen(c.id);
  }
  function answered(a: AiAnswer, question: string) {
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
  const groups = [
    ...groupByDate(mine),
    ...(shared.length
      ? [{ label: "Compartilhadas com você", items: shared }]
      : []),
  ];

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
                {[
                  c.owner_id !== user ? `de ${memberName(c.owner_id)}` : "",
                  c.scope?.client ? clientName(c.scope.client) : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
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
          <button type="button" className="mavi-new" onClick={newChat}>
            <SquarePen size={16} aria-hidden="true" /> Nova conversa
          </button>
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
        <nav className="mavi-list" aria-label="Conversas">
          {list === null ? (
            <Loading compact />
          ) : !groups.length ? (
            <p className="mavi-list-empty">
              {q
                ? "Nenhuma conversa com esse nome."
                : "Suas conversas com a MAVI aparecem aqui."}
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
            onClick={newChat}
          >
            <SquarePen size={17} />
          </button>
          <div className="mavi-head-title">
            <strong title={conv?.title}>{conv?.title ?? "MAVI"}</strong>
            {conv && (
              <small>
                {[
                  readOnly ? `Compartilhada por ${memberName(conv.owner_id)}` : "",
                  conv.scope?.client
                    ? `Cliente ${clientName(conv.scope.client)}`
                    : "Todos os clientes",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
            )}
          </div>
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
            <Loading />
          </div>
        ) : (
          <ChatThread
            key={thread.key}
            initial={thread.entries}
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
            }
            send={(question, _history, handlers) =>
              askAi(
                company,
                { client: client || undefined, module: "assistant" },
                question,
                conv?.id ?? null,
                handlers,
                undefined,
                "page",
              )
            }
            onAnswer={answered}
            host={{
              company,
              conversation: conv?.id ?? null,
              onNewTask,
              onComment,
              taskHref,
              notify,
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
  onNew,
  host,
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
  onNew: () => void;
  host: Omit<ArtifactHost, "readOnly" | "streaming" | "onDraft">;
}) {
  const chat = useAiTurns({ initial, send, readOnly, onAnswer });
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
    if (!question.trim() || busy || readOnly) return;
    setDraft("");
    stick.current = true;
    if (!(await chat.submit(question))) setDraft(question.trim());
    input.current?.focus();
  }
  const artifactHost = {
    ...host,
    readOnly,
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
    return (t.artifacts ?? []).filter((a) => !placed.has(a.ref));
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
      className="mavi-composer"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void submit(draft);
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) input.current?.focus();
      }}
    >
      <textarea
        ref={input}
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
        {scope}
        <button
          type="submit"
          className="mavi-send"
          disabled={busy || draft.trim().length < 2}
          aria-label="Enviar"
          title="Enviar (Enter)"
        >
          {busy ? (
            <Loader2 size={17} className="spin" />
          ) : (
            <ArrowUp size={18} />
          )}
        </button>
      </div>
    </form>
  );
  const errorBox = error && (
    <p className="form-error mavi-error" role="alert">
      {error}
    </p>
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
    <div className="mavi-thread">
      <div
        ref={log}
        className="mavi-log"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        <div className="mavi-col">
          {turns.map((t, i) =>
            t.role === "user" ? (
              <div key={i} className="mavi-msg user">
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
                          renderArtifact={(ref) => {
                            const a = t.artifacts?.find((x) => x.ref === ref);
                            return a ? (
                              <ArtifactView
                                artifact={a}
                                host={{ ...artifactHost, streaming: !!t.streaming }}
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
                        host={{ ...artifactHost, streaming: !!t.streaming }}
                      />
                    </div>
                  ))}
                  {!t.streaming && t.content && (
                    <div className="mavi-msg-actions">
                      <CopyButton text={plainAnswer(t.content)} />
                    </div>
                  )}
                </div>
              </div>
            ),
          )}
          {errorBox}
        </div>
      </div>
      <div className="mavi-dock">
        {composer}
        <p className="mavi-disclaimer">
          A MAVI pode errar. Confira as fontes citadas em cada resposta.
        </p>
      </div>
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

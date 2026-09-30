import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  Clock,
  BarChart3,
  CheckSquare,
  Contact,
  FileText,
  Image as ImageIcon,
  Link2,
  MapPin,
  MessageCircle,
  Mic,
  Play,
  Plus,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { Button, Input, Loading } from "./ui";
import { Empty } from "./components";
import { DateInput } from "./DateInput";
import { FileViewer, type ViewerFile } from "./FileViewer";
import { WhatsappMedia } from "./WhatsappMedia";
import { AiChat, AnswerText } from "./AiChat";
import { askAi, openAiSource } from "./ai";
import { canCreateTaskIn } from "./domain";
import type { FormPreset } from "./forms";
import type { Snapshot } from "./types";
import {
  ago,
  bytesLabel,
  clientGroups,
  dayLabel,
  dayStart,
  formatWhatsapp,
  mediaUrls,
  messagePreview,
  messagesAfter,
  messagesBefore,
  messagesTask,
  reactionsOf,
  searchClientMessages,
  secondsLabel,
  senderColor,
  senderLabel,
  shortDate,
  taskContract,
  timeLabel,
  visibleMessages,
  whatsappDay,
  whatsappMessageById,
  whatsappLink,
  viewerFile,
  draftWhatsappTask,
  type TaskDraft,
  type Reaction,
  type WhatsappGroup,
  type WhatsappMessage,
} from "./whatsapp";

const HISTORY_SUGGESTIONS = [
  "O que o cliente pediu ou cobrou nos últimos dias?",
  "Teve alguma reclamação ou sinal de insatisfação nos grupos?",
  "O que foi combinado ou aprovado com o cliente pelo Whatsapp?",
  "Quais pendências ficaram em aberto nas conversas?",
];

type Props = {
  company: string;
  client: string;
  clientName: string;
  data: Snapshot;
  user: string;
  notify: (message: string) => void;
  onNewTask?: (preset: FormPreset) => void;
  /** Link de uma mensagem: abre o grupo já nela. */
  initial?: { group: string; message?: WhatsappMessage } | null;
};

/**
 * Drive › cliente › Whatsapp: os grupos do cliente, a conversa de cada um
 * (só leitura), a busca em todos eles e a galeria de mídias.
 */
export function WhatsappFolder({
  company,
  client,
  clientName,
  data,
  user,
  notify,
  onNewTask,
  initial,
}: Props) {
  const [groups, setGroups] = useState<WhatsappGroup[] | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<"chats" | "media">("chats");
  const [open, setOpen] = useState<string | null>(initial?.group ?? null);
  const [focus, setFocus] = useState<WhatsappMessage | null>(
    initial?.message ?? null,
  );
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<WhatsappMessage[] | null>(null);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    setGroups(null);
    clientGroups(company, client)
      .then((list) => {
        setGroups(list);
        // No computador, a conversa mais recente já aparece aberta.
        setOpen(
          (current) =>
            current ??
            (window.matchMedia?.("(min-width: 900px)").matches
              ? (list[0]?.id ?? null)
              : null),
        );
      })
      .catch((e) => setError((e as Error).message));
  }, [company, client]);
  useEffect(() => {
    if (!initial) return;
    setView("chats");
    setOpen(initial.group);
    setFocus(initial.message ?? null);
  }, [initial]);

  const groupIds = useMemo(() => (groups ?? []).map((g) => g.id), [groups]);
  const text = query.trim();
  useEffect(() => {
    if (text.length < 2) {
      setHits(null);
      return;
    }
    setHits(null);
    const id = setTimeout(() => {
      searchClientMessages(company, groupIds, text)
        .then(setHits)
        .catch((e) => setError((e as Error).message));
    }, 350);
    return () => clearTimeout(id);
  }, [company, groupIds, text]);

  const byId = useMemo(
    () => new Map((groups ?? []).map((g) => [g.id, g])),
    [groups],
  );
  const current = open ? byId.get(open) : undefined;
  const lastRead = (groups ?? []).reduce<string | null>(
    (max, g) =>
      g.synced_at && (!max || g.synced_at > max) ? g.synced_at : max,
    null,
  );
  const openMessage = (m: WhatsappMessage) => {
    setView("chats");
    setOpen(m.group_id);
    setFocus(m);
  };

  if (error && !groups)
    return (
      <p className="form-error" role="alert">
        {error}
      </p>
    );
  if (!groups) return <Loading variant="list" />;
  if (!groups.length)
    return (
      <div className="panel">
        <Empty
          title="Nenhum grupo de WhatsApp"
          body="Os grupos entram sozinhos quando o título tem o código do cliente. Um administrador também pode ligar um grupo em Configurações › Grupos do Whatsapp."
        />
      </div>
    );

  return (
    <div className="wa-page">
      <div className="wa-topbar">
        <div className="drive-view" role="tablist" aria-label="Whatsapp">
          <button
            type="button"
            role="tab"
            aria-selected={view === "chats"}
            className={view === "chats" ? "selected" : ""}
            onClick={() => setView("chats")}
          >
            <MessageCircle size={15} /> Conversas
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "media"}
            className={view === "media" ? "selected" : ""}
            onClick={() => setView("media")}
          >
            <ImageIcon size={15} /> Mídias
          </button>
        </div>
        <button
          type="button"
          className={`btn ${asking ? "primary" : "secondary"}`}
          aria-expanded={asking}
          onClick={() => setAsking((v) => !v)}
        >
          <Sparkles size={15} /> Perguntar ao histórico
        </button>
      </div>
      {/* As mensagens chegam da Uazapi a cada 2 horas: quem lê precisa
          saber que a conversa pode estar atrás do WhatsApp. */}
      <p className="wa-notice" role="note">
        <Clock size={16} aria-hidden="true" />
        <span>
          <strong>Não é em tempo real.</strong> As conversas são atualizadas a
          cada 2 horas
          {lastRead ? ` (última atualização ${ago(lastRead)})` : ""}. Mensagens
          mais recentes podem ainda não aparecer aqui: para o que acabou de
          acontecer, confira o WhatsApp.
        </span>
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {asking && (
        <section
          className="panel meetings-ask"
          aria-label="Perguntar à MAVI sobre todas as conversas"
        >
          <header>
            <strong>
              <Sparkles size={15} /> Perguntar à MAVI sobre os grupos de{" "}
              {clientName}
            </strong>
            <button
              type="button"
              className="icon-btn"
              aria-label="Fechar"
              onClick={() => setAsking(false)}
            >
              <X size={15} />
            </button>
          </header>
          <HistoryChat
            company={company}
            client={client}
            onOpen={(id) =>
              whatsappMessageById(id)
                .then((m) => {
                  if (!m) throw Error("Mensagem não encontrada ou sem acesso.");
                  openMessage(m);
                })
                .catch((e) => setError((e as Error).message))
            }
          />
        </section>
      )}
      {view === "media" ? (
        <WhatsappMedia
          company={company}
          groups={groups}
          onOpenMessage={openMessage}
        />
      ) : (
        <div className={`wa-folder panel ${current ? "has-chat" : ""}`}>
          <aside className="wa-groups" aria-label="Grupos do cliente">
            <div className="wa-groups-search">
              <Input
                type="search"
                aria-label="Buscar nas conversas"
                placeholder="Buscar em todos os grupos…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                icon={Search}
              />
            </div>
            {hits || text.length >= 2 ? (
              <SearchHits
                hits={hits}
                query={text}
                groups={byId}
                onOpen={openMessage}
              />
            ) : (
              <ul className="wa-group-list">
                {groups.map((g) => (
                  <li key={g.id}>
                    <button
                      type="button"
                      className={g.id === open ? "selected" : ""}
                      aria-current={g.id === open ? "true" : undefined}
                      onClick={() => {
                        setOpen(g.id);
                        setFocus(null);
                      }}
                    >
                      <span
                        className="wa-group-avatar"
                        style={{ background: senderColor(g.jid) }}
                        aria-hidden="true"
                      >
                        <MessageCircle size={16} />
                      </span>
                      <span className="wa-group-text">
                        <strong>{g.title || "Grupo sem título"}</strong>
                        <small>
                          {g.message_count.toLocaleString("pt-BR")}{" "}
                          {g.message_count === 1 ? "mensagem" : "mensagens"}
                          {g.last_message_at && ` · ${ago(g.last_message_at)}`}
                        </small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
          {current ? (
            <Chat
              key={current.id}
              company={company}
              client={client}
              clientName={clientName}
              group={current}
              focus={focus?.group_id === current.id ? focus : null}
              data={data}
              user={user}
              notify={notify}
              onNewTask={onNewTask}
              onBack={() => setOpen(null)}
            />
          ) : (
            <div className="wa-chat wa-chat-empty">
              <MessageCircle size={28} aria-hidden="true" />
              <p>Escolha um grupo para ler a conversa.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HistoryChat({
  company,
  client,
  onOpen,
}: {
  company: string;
  client: string;
  onOpen: (message: string) => void;
}) {
  // A conversa fica salva (aparece também no histórico da MAVI).
  const conversation = useRef<string | null>(null);
  return (
    <AiChat
      intro="A MAVI busca nas mensagens de todos os grupos deste cliente (com os áudios transcritos e o texto dos documentos) e mostra de onde tirou cada informação. Clique na fonte para abrir a conversa na mensagem. Imagens e vídeos ela só sabe que foram enviados."
      placeholder="Pergunte sobre as conversas deste cliente"
      suggestions={HISTORY_SUGGESTIONS}
      send={(q, _history, handlers) =>
        askAi(
          company,
          { client, module: "whatsapp" },
          q,
          conversation.current,
          handlers,
        )
      }
      onAnswer={(a) => (conversation.current = a.conversation)}
      renderAnswer={(text, sources) => (
        <AnswerText
          text={text}
          sources={sources}
          onSource={(s) =>
            s.type === "whatsapp" ? onOpen(s.id) : openAiSource(s)
          }
        />
      )}
    />
  );
}

function SearchHits({
  hits,
  query,
  groups,
  onOpen,
}: {
  hits: WhatsappMessage[] | null;
  query: string;
  groups: Map<string, WhatsappGroup>;
  onOpen: (m: WhatsappMessage) => void;
}) {
  if (!hits) return <Loading compact />;
  if (!hits.length)
    return <p className="wa-hits-empty">Nada encontrado para “{query}”.</p>;
  return (
    <ul className="wa-hits">
      {hits.map((m) => (
        <li key={m.id}>
          <button type="button" onClick={() => onOpen(m)}>
            <small>
              {groups.get(m.group_id)?.title} · {shortDate(m.sent_at)}
            </small>
            <strong>{senderLabel(m)}</strong>
            <span>{messagePreview(m)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------ conversa
type ChatProps = {
  company: string;
  client: string;
  clientName: string;
  group: WhatsappGroup;
  focus: WhatsappMessage | null;
  data: Snapshot;
  user: string;
  notify: (message: string) => void;
  onNewTask?: (preset: FormPreset) => void;
  onBack: () => void;
};

function Chat({
  company,
  client,
  clientName,
  group,
  focus,
  data,
  user,
  notify,
  onNewTask,
  onBack,
}: ChatProps) {
  const [list, setList] = useState<WhatsappMessage[] | null>(null);
  const [older, setOlder] = useState(false);
  const [newer, setNewer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [highlight, setHighlight] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewer, setViewer] = useState<{
    files: ViewerFile[];
    start: number;
  } | null>(null);
  const [day, setDay] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  // Depois de carregar: ir para o fim, manter o ponto (anteriores) ou
  // centralizar uma mensagem.
  const pending = useRef<
    | { kind: "bottom" }
    | { kind: "top" }
    | { kind: "keep"; height: number; top: number }
    | { kind: "message"; id: string }
    | null
  >(null);

  const latest = useCallback(async () => {
    const r = await messagesBefore(company, group.id);
    pending.current = { kind: "bottom" };
    setList(r.messages);
    setOlder(r.more);
    setNewer(false);
  }, [company, group.id]);

  useEffect(() => {
    let alive = true;
    setList(null);
    setError("");
    (async () => {
      if (focus) {
        const [b, a] = await Promise.all([
          messagesBefore(company, group.id, focus, 60),
          messagesAfter(company, group.id, focus, 60),
        ]);
        if (!alive) return;
        pending.current = { kind: "message", id: focus.id };
        setList([...b.messages, focus, ...a.messages]);
        setOlder(b.more);
        setNewer(a.more);
        setHighlight(focus.id);
      } else await latest();
    })().catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [company, group.id, focus, latest]);

  useLayoutEffect(() => {
    const el = scroller.current;
    const p = pending.current;
    if (!el || !p || !list) return;
    pending.current = null;
    if (p.kind === "bottom") el.scrollTop = el.scrollHeight;
    else if (p.kind === "top") el.scrollTop = 0;
    else if (p.kind === "keep")
      el.scrollTop = p.top + (el.scrollHeight - p.height);
    else
      el.querySelector(`[data-message="${p.id}"]`)?.scrollIntoView({
        block: "center",
      });
  }, [list]);

  // Prévias das imagens e figurinhas da janela, em lote.
  useEffect(() => {
    if (!list) return;
    const ids = list
      .filter(
        (m) =>
          (m.kind === "image" || m.kind === "sticker") &&
          m.media_status === "stored" &&
          !urls[m.id],
      )
      .map((m) => m.id);
    if (!ids.length) return;
    let alive = true;
    mediaUrls(ids)
      .then((got) => alive && setUrls((u) => ({ ...u, ...got })))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [list, urls]);

  async function loadOlder() {
    if (!list?.length) return;
    setBusy(true);
    try {
      const r = await messagesBefore(company, group.id, list[0]);
      const el = scroller.current;
      pending.current = el
        ? { kind: "keep", height: el.scrollHeight, top: el.scrollTop }
        : null;
      setList((l) => [...r.messages, ...(l ?? [])]);
      setOlder(r.more);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function loadNewer() {
    if (!list?.length) return;
    setBusy(true);
    try {
      const r = await messagesAfter(company, group.id, list[list.length - 1]);
      setList((l) => [...(l ?? []), ...r.messages]);
      setNewer(r.more);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function jumpTo(value: string) {
    setDay(value);
    if (!value) return;
    setBusy(true);
    setError("");
    try {
      const r = await messagesAfter(company, group.id, {
        from: dayStart(value),
      });
      if (!r.messages.length) {
        notify("Não há mensagens guardadas a partir dessa data.");
        await latest();
      } else {
        pending.current = { kind: "top" };
        setList(r.messages);
        setOlder(true);
        setNewer(r.more);
        setHighlight("");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const byWaId = useMemo(
    () => new Map((list ?? []).map((m) => [m.wa_id, m])),
    [list],
  );
  const reactions = useMemo(() => reactionsOf(list ?? []), [list]);
  const shown = useMemo(() => visibleMessages(list ?? []), [list]);
  const images = useMemo(
    () =>
      shown.filter((m) => m.kind === "image" && m.media_status === "stored"),
    [shown],
  );

  function openMedia(m: WhatsappMessage) {
    if (m.kind === "image") {
      const start = images.findIndex((x) => x.id === m.id);
      setViewer({ files: images.map(viewerFile), start: Math.max(0, start) });
    } else setViewer({ files: [viewerFile(m)], start: 0 });
  }
  function goToQuoted(waId: string) {
    const target = byWaId.get(waId);
    if (!target) return;
    setHighlight(target.id);
    scroller.current
      ?.querySelector(`[data-message="${target.id}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  async function copyLink(m: WhatsappMessage) {
    try {
      await navigator.clipboard.writeText(whatsappLink(group.id, m.id));
      notify("Link da mensagem copiado.");
    } catch {
      notify("Não foi possível copiar o link.");
    }
  }
  const contract = taskContract(data, client, group.product_ids, (k) =>
    canCreateTaskIn(data, k, user),
  );
  const [drafting, setDrafting] = useState(false);
  // A MAVI lê as mensagens (e a conversa em volta) e propõe título, resumo,
  // o que fazer e prazo; se não der, a tarefa sai só com as mensagens.
  async function createTask() {
    const picked = shown.filter((m) => selected.has(m.id));
    if (!picked.length || !onNewTask || drafting) return;
    if (!contract) {
      notify(
        "Para criar tarefas, você precisa ter acesso a um produto contratado deste cliente.",
      );
      return;
    }
    setDrafting(true);
    let draft: TaskDraft | null = null;
    try {
      draft = await draftWhatsappTask(picked.map((m) => m.id));
    } catch (e) {
      notify(
        `A MAVI não conseguiu resumir agora (${(e as Error).message}). A tarefa foi montada com as mensagens.`,
      );
    } finally {
      setDrafting(false);
    }
    onNewTask({
      contract,
      ...messagesTask(
        picked,
        { group: group.id, groupTitle: group.title, clientName },
        draft,
      ),
    });
    setSelecting(false);
    setSelected(new Set());
  }

  let lastDay = "";
  let lastSender = "";
  let lastAt = 0;
  return (
    <section className="wa-chat" aria-label={`Conversa ${group.title}`}>
      <header className="wa-chat-head">
        <Button
          className="icon-btn wa-back"
          aria-label="Voltar aos grupos"
          onClick={onBack}
        >
          <ArrowLeft size={17} />
        </Button>
        <div className="wa-chat-title">
          <strong>{group.title || "Grupo sem título"}</strong>
          <small>
            {group.message_count.toLocaleString("pt-BR")}{" "}
            {group.message_count === 1
              ? "mensagem guardada"
              : "mensagens guardadas"}
            {group.synced_at && ` · atualizado ${ago(group.synced_at)}`}
          </small>
        </div>
        <div className="wa-chat-tools">
          <DateInput
            aria-label="Ir para a data"
            placeholder="Ir para a data"
            value={day}
            max={whatsappDay(new Date().toISOString())}
            onChange={(e) => void jumpTo(e.target.value)}
          />
          {onNewTask && (
            <Button
              className={`btn secondary ${selecting ? "active" : ""}`}
              aria-pressed={selecting}
              onClick={() => {
                setSelecting((s) => !s);
                setSelected(new Set());
              }}
            >
              <CheckSquare size={15} />{" "}
              {selecting ? "Cancelar seleção" : "Selecionar"}
            </Button>
          )}
        </div>
      </header>
      <div className="wa-messages" ref={scroller}>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {!list ? (
          <Loading variant="chat" />
        ) : (
          <>
            {older ? (
              <button
                type="button"
                className="wa-more"
                disabled={busy}
                onClick={() => void loadOlder()}
              >
                Carregar mensagens anteriores
              </button>
            ) : (
              <p className="wa-start">
                Início das mensagens guardadas no MAVI.
              </p>
            )}
            {!shown.length && (
              <p className="wa-start">Nenhuma mensagem guardada ainda.</p>
            )}
            {shown.map((m) => {
              const dayOf = whatsappDay(m.sent_at);
              const at = new Date(m.sent_at).getTime();
              const who = m.from_me ? "__me__" : m.sender || m.sender_name;
              const newDay = dayOf !== lastDay;
              const showSender =
                newDay || who !== lastSender || at - lastAt > 5 * 60_000;
              lastDay = dayOf;
              lastSender = who;
              lastAt = at;
              return (
                <Fragment key={m.id}>
                  {newDay && (
                    <div className="wa-day" role="separator">
                      <span>{dayLabel(m.sent_at)}</span>
                    </div>
                  )}
                  <Bubble
                    m={m}
                    quoted={
                      m.quoted_wa_id ? byWaId.get(m.quoted_wa_id) : undefined
                    }
                    reactions={reactions.get(m.wa_id)}
                    url={urls[m.id]}
                    showSender={showSender}
                    highlight={highlight === m.id}
                    selecting={selecting}
                    selected={selected.has(m.id)}
                    onToggle={() =>
                      setSelected((s) => {
                        const next = new Set(s);
                        if (next.has(m.id)) next.delete(m.id);
                        else next.add(m.id);
                        return next;
                      })
                    }
                    onOpenMedia={() => openMedia(m)}
                    onQuote={goToQuoted}
                    onCopyLink={() => void copyLink(m)}
                  />
                </Fragment>
              );
            })}
            {newer && (
              <button
                type="button"
                className="wa-more"
                disabled={busy}
                onClick={() => void loadNewer()}
              >
                Carregar mensagens mais recentes
              </button>
            )}
            {!newer && shown.length > 0 && (
              <p className="wa-start wa-end">
                {group.synced_at
                  ? `Conversa atualizada ${ago(group.synced_at)}.`
                  : "Conversa ainda não atualizada."}{" "}
                Mensagens novas chegam a cada 2 horas.
              </p>
            )}
          </>
        )}
      </div>
      {selecting && (
        <div
          className="wa-selection"
          role="region"
          aria-label="Mensagens selecionadas"
        >
          <span>
            {selected.size
              ? `${selected.size} ${selected.size === 1 ? "mensagem selecionada" : "mensagens selecionadas"}`
              : "Toque nas mensagens para selecionar"}
          </span>
          <Button
            className="btn"
            disabled={!selected.size || drafting}
            aria-busy={drafting}
            onClick={() => void createTask()}
          >
            {drafting ? (
              <>
                <Sparkles size={15} /> A MAVI está preparando a tarefa…
              </>
            ) : (
              <>
                <Plus size={15} /> Criar tarefa
              </>
            )}
          </Button>
        </div>
      )}
      {viewer && (
        <FileViewer
          files={viewer.files}
          start={viewer.start}
          onClose={() => setViewer(null)}
        />
      )}
    </section>
  );
}

function Formatted({ text }: { text: string }) {
  return (
    <>
      {formatWhatsapp(text).map((p, i) => {
        let node: ReactNode = p.text;
        if (p.mono) node = <code>{node}</code>;
        if (p.bold) node = <strong>{node}</strong>;
        if (p.italic) node = <em>{node}</em>;
        if (p.strike) node = <s>{node}</s>;
        if (p.href)
          node = (
            <a href={p.href} target="_blank" rel="noopener noreferrer">
              {node}
            </a>
          );
        return <Fragment key={i}>{node}</Fragment>;
      })}
    </>
  );
}

function Bubble({
  m,
  quoted,
  reactions,
  url,
  showSender,
  highlight,
  selecting,
  selected,
  onToggle,
  onOpenMedia,
  onQuote,
  onCopyLink,
}: {
  m: WhatsappMessage;
  quoted?: WhatsappMessage;
  reactions?: Reaction[];
  url?: string;
  showSender: boolean;
  highlight: boolean;
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpenMedia: () => void;
  onQuote: (waId: string) => void;
  onCopyLink: () => void;
}) {
  const name = senderLabel(m);
  const color = senderColor(m.sender || name);
  return (
    <div
      className={`wa-row ${m.from_me ? "mine" : ""} ${highlight ? "highlight" : ""} ${selected ? "selected" : ""}`}
      data-message={m.id}
      onClick={selecting ? onToggle : undefined}
    >
      {selecting && (
        <input
          type="checkbox"
          className="wa-check"
          checked={selected}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Selecionar mensagem de ${name} às ${timeLabel(m.sent_at)}`}
        />
      )}
      <div className={`wa-bubble ${m.kind === "sticker" ? "sticker" : ""}`}>
        {showSender && (
          <span className="wa-sender" style={{ color }}>
            {name}
          </span>
        )}
        {m.quoted_wa_id && (
          <button
            type="button"
            className="wa-quote"
            disabled={!quoted || selecting}
            onClick={() => onQuote(m.quoted_wa_id!)}
          >
            {quoted ? (
              <>
                <strong
                  style={{
                    color: senderColor(quoted.sender || senderLabel(quoted)),
                  }}
                >
                  {senderLabel(quoted)}
                </strong>
                <span>{messagePreview(quoted) || "Mensagem"}</span>
              </>
            ) : (
              <span>Resposta a uma mensagem anterior</span>
            )}
          </button>
        )}
        <MessageBody
          m={m}
          url={url}
          onOpenMedia={selecting ? () => {} : onOpenMedia}
        />
        <span className="wa-meta">
          {m.edited && <em>editada · </em>}
          {timeLabel(m.sent_at)}
          {!selecting && (
            <button
              type="button"
              className="wa-link"
              title="Copiar o link desta mensagem"
              aria-label="Copiar o link desta mensagem"
              onClick={onCopyLink}
            >
              <Link2 size={12} />
            </button>
          )}
        </span>
      </div>
      {reactions && (
        <div className="wa-reactions">
          {reactions.map((r) => (
            <span key={r.emoji} title={r.names.join(", ")}>
              {r.emoji}
              {r.names.length > 1 && <small>{r.names.length}</small>}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function MediaState({ m }: { m: WhatsappMessage }) {
  if (m.media_status === "pending" || m.media_status === "failed")
    return (
      <small className="wa-media-note">Copiando a mídia para o MAVI…</small>
    );
  if (m.media_status === "too_large")
    return (
      <small className="wa-media-note">
        Arquivo grande demais para guardar.
      </small>
    );
  return (
    <small className="wa-media-note">A mídia não está mais disponível.</small>
  );
}

function MessageBody({
  m,
  url,
  onOpenMedia,
}: {
  m: WhatsappMessage;
  url?: string;
  onOpenMedia: () => void;
}) {
  const stored = m.media_status === "stored";
  const thumb = m.extra.thumb ? `data:image/jpeg;base64,${m.extra.thumb}` : "";
  const caption = m.body.trim() ? (
    <p className="wa-text">
      <Formatted text={m.body} />
    </p>
  ) : null;
  switch (m.kind) {
    case "text":
    case "other":
      return caption;
    case "image":
      return (
        <>
          {stored || thumb ? (
            <button
              type="button"
              className="wa-image"
              disabled={!stored}
              onClick={onOpenMedia}
              aria-label="Abrir a imagem"
            >
              {url || thumb ? (
                <img
                  src={url || thumb}
                  alt={m.body || "Imagem"}
                  loading="lazy"
                />
              ) : (
                <ImageIcon size={28} />
              )}
            </button>
          ) : null}
          {!stored && <MediaState m={m} />}
          {caption}
        </>
      );
    case "sticker":
      return stored && url ? (
        <img className="wa-sticker" src={url} alt="Figurinha" loading="lazy" />
      ) : (
        <small className="wa-media-note">Figurinha</small>
      );
    case "video":
      return (
        <>
          <button
            type="button"
            className="wa-image wa-video"
            disabled={!stored}
            onClick={onOpenMedia}
            aria-label="Assistir ao vídeo"
          >
            {thumb ? (
              <img src={thumb} alt="" />
            ) : (
              <span className="wa-video-blank" />
            )}
            <span className="wa-play">
              <Play size={20} />
            </span>
            {m.media_seconds ? (
              <small>{secondsLabel(m.media_seconds)}</small>
            ) : null}
          </button>
          {!stored && <MediaState m={m} />}
          {caption}
        </>
      );
    case "audio":
      return (
        <>
          {stored ? <AudioMessage m={m} /> : <MediaState m={m} />}
          {m.content_status === "done" && m.content_text ? (
            <details className="wa-transcript">
              <summary>Transcrição</summary>
              <p>{m.content_text}</p>
            </details>
          ) : m.content_status === "pending" ? (
            <small className="wa-media-note">Transcrição a caminho…</small>
          ) : null}
          {caption}
        </>
      );
    case "document":
      return (
        <>
          <button
            type="button"
            className="wa-doc"
            disabled={!stored}
            onClick={onOpenMedia}
          >
            <FileText size={22} aria-hidden="true" />
            <span>
              <strong>{m.media_name || "Documento"}</strong>
              <small>
                {[
                  bytesLabel(m.media_bytes),
                  m.media_mime?.split("/")[1]?.toUpperCase(),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
            </span>
          </button>
          {!stored && <MediaState m={m} />}
          {caption}
        </>
      );
    case "poll":
      return (
        <div className="wa-poll">
          <strong>
            <BarChart3 size={14} aria-hidden="true" /> {m.body || "Enquete"}
          </strong>
          <ul>
            {(m.extra.options ?? []).map((o) => (
              <li key={o}>{o}</li>
            ))}
          </ul>
        </div>
      );
    case "location":
      return (
        <a
          className="wa-location"
          href={
            m.extra.lat !== undefined
              ? `https://www.google.com/maps?q=${m.extra.lat},${m.extra.lng}`
              : undefined
          }
          target="_blank"
          rel="noopener noreferrer"
        >
          <MapPin size={15} aria-hidden="true" /> {m.body || "Localização"}
        </a>
      );
    case "contact":
      return (
        <p className="wa-text wa-contact">
          <Contact size={15} aria-hidden="true" /> {m.body || "Contato"}
        </p>
      );
    case "unavailable":
      return (
        <p className="wa-text wa-unavailable">
          {m.extra.view_once
            ? "Mídia de visualização única: só abre no celular."
            : "Mensagem não disponível."}
        </p>
      );
    default:
      return caption;
  }
}

function AudioMessage({ m }: { m: WhatsappMessage }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (url)
    return (
      <audio className="wa-audio" controls autoPlay src={url}>
        <track kind="captions" />
      </audio>
    );
  return (
    <button
      type="button"
      className="wa-audio-play"
      disabled={busy}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try {
          const got = (await mediaUrls([m.id]))[m.id];
          if (!got) throw Error("Áudio indisponível.");
          setUrl(got);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <span className="wa-play small">
        {busy ? <Loading variant="inline" /> : <Play size={14} />}
      </span>
      <Mic size={14} aria-hidden="true" />
      <span>{secondsLabel(m.media_seconds) || "Ouvir"}</span>
      {error && <small className="wa-media-note">{error}</small>}
    </button>
  );
}

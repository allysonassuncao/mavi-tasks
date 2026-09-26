import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  ArrowLeft,
  History,
  Lock,
  Pencil,
  Plus,
  Search,
  Share2,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { Button, Checkbox, Input, Loading, Select, SelectOption } from "./ui";
import { Avatar, Modal } from "./components";
import { fold } from "./task-search";
import type { Snapshot } from "./types";
import { navigate } from "./router";
import { AiChat, AnswerText, entriesFrom, type ChatEntry } from "./AiChat";
import {
  askAi,
  conversationMessages,
  conversationShares,
  currentAiPlace,
  deleteConversation,
  listConversations,
  openAiSource,
  renameConversation,
  shareConversation,
  subscribeAiPlace,
  type AiConversation,
  type AiSource,
} from "./ai";

const SUGGESTIONS_ALL = [
  "Quais clientes tiveram reunião esta semana e o que ficou combinado?",
  "O que está atrasado e com quem?",
  "Algum cliente reclamou de algo recentemente?",
];
const SUGGESTIONS_CLIENT = [
  "Resuma a situação deste cliente: reuniões recentes e tarefas em aberto.",
  "O que já foi prometido a este cliente e ainda não foi entregue?",
  "Quais foram as últimas decisões com este cliente?",
];

type Open = {
  conversation: AiConversation | null;
  entries: ChatEntry[];
  /** Muda para recomeçar o chat (outra conversa ou outro escopo). */
  key: number;
};

/**
 * O assistente de IA em qualquer tela (botão flutuante ou Ctrl/⌘+J): pergunta
 * sobre qualquer cliente que a pessoa acessa — ou só sobre um —, guarda as
 * conversas e compartilha com colegas.
 */
export function AiAssistant({
  company,
  data,
  user,
  location,
  notify,
}: {
  company: string;
  data: Snapshot;
  user: string;
  /** Endereço atual (abre uma conversa pelo link ?conversa=…). */
  location: string;
  notify: (message: string) => void;
}) {
  const place = useSyncExternalStore(subscribeAiPlace, currentAiPlace);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"chat" | "history">("chat");
  const [client, setClient] = useState<string>("");
  const [chat, setChat] = useState<Open>({
    conversation: null,
    entries: [],
    key: 0,
  });
  const [list, setList] = useState<AiConversation[] | null>(null);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState("");

  const clients = data.clients
    .filter((c) => !c.archived)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { numeric: true }));
  const clientName = (id?: string) =>
    data.clients.find((c) => c.id === id)?.name ?? "";
  const memberName = (id: string) =>
    data.members.find((m) => m.user_id === id)?.name ?? "Alguém";

  const fresh = useCallback((scopeClient: string) => {
    setClient(scopeClient);
    setChat((c) => ({ conversation: null, entries: [], key: c.key + 1 }));
    setView("chat");
    setError("");
  }, []);
  // Abre no lugar onde a pessoa está (ex.: o cliente aberto no Drive).
  function show() {
    if (!open && !chat.conversation && !chat.entries.length)
      fresh(place?.client ?? "");
    setOpen(true);
  }

  // Ctrl/⌘+J abre e fecha.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOpen((v) => {
          if (!v && !chat.conversation && !chat.entries.length)
            fresh(currentAiPlace()?.client ?? "");
          return !v;
        });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chat.conversation, chat.entries.length, fresh]);

  const load = useCallback(async (c: AiConversation) => {
    setError("");
    try {
      const messages = await conversationMessages(c.id);
      setClient(c.scope?.client ?? "");
      setChat((prev) => ({
        conversation: c,
        entries: entriesFrom(messages),
        key: prev.key + 1,
      }));
      setView("chat");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Link de uma conversa compartilhada: ?conversa=<id>.
  useEffect(() => {
    const url = new URL(location, window.location.origin);
    const id = url.searchParams.get("conversa");
    if (!id) return;
    url.searchParams.delete("conversa");
    navigate(url.pathname + (url.search || ""), true);
    listConversations(company)
      .then((all) => {
        const c = all.find((x) => x.id === id);
        if (!c) throw Error("Conversa não encontrada ou sem acesso.");
        setOpen(true);
        return load(c);
      })
      .catch((e) => {
        setOpen(true);
        setError((e as Error).message);
      });
  }, [location, company, load]);

  useEffect(() => {
    if (view !== "history") return;
    setList(null);
    listConversations(company)
      .then(setList)
      .catch((e) => setError((e as Error).message));
  }, [view, company]);

  async function rename(c: AiConversation) {
    const title = window.prompt("Novo nome da conversa", c.title)?.trim();
    if (!title) return;
    try {
      await renameConversation(c.id, title);
      setList((l) => l?.map((x) => (x.id === c.id ? { ...x, title } : x)) ?? l);
      if (chat.conversation?.id === c.id)
        setChat((p) => ({ ...p, conversation: { ...c, title } }));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function remove(c: AiConversation) {
    if (!window.confirm(`Apagar a conversa "${c.title}"?`)) return;
    try {
      await deleteConversation(c.id);
      setList((l) => l?.filter((x) => x.id !== c.id) ?? l);
      if (chat.conversation?.id === c.id) fresh(client);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const conv = chat.conversation;
  const readOnly = !!conv && conv.owner_id !== user;
  const mine = list?.filter((c) => c.owner_id === user) ?? [];
  const shared = list?.filter((c) => c.owner_id !== user) ?? [];
  const when = (iso: string) =>
    new Date(iso).toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "short",
    });

  if (!open)
    return (
      <button
        type="button"
        className="ai-fab"
        onClick={show}
        title="IA do MAVI (Ctrl/⌘+J)"
        aria-label="Abrir a IA do MAVI"
      >
        <Sparkles size={20} />
      </button>
    );

  return (
    <aside className="ai-drawer" aria-label="IA do MAVI">
      <header className="ai-drawer-head">
        {view === "history" ? (
          <button
            type="button"
            className="icon-btn"
            aria-label="Voltar"
            onClick={() => setView("chat")}
          >
            <ArrowLeft size={17} />
          </button>
        ) : (
          <Sparkles size={17} className="ai-drawer-logo" aria-hidden="true" />
        )}
        <strong title={conv?.title}>
          {view === "history" ? "Conversas" : (conv?.title ?? "IA do MAVI")}
        </strong>
        <span className="ai-drawer-actions">
          {view === "chat" && conv && !readOnly && (
            <button
              type="button"
              className="icon-btn"
              title="Compartilhar com colegas"
              aria-label="Compartilhar conversa"
              onClick={() => setSharing(true)}
            >
              <Share2 size={16} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            title="Conversas salvas"
            aria-label="Conversas salvas"
            onClick={() => setView(view === "history" ? "chat" : "history")}
          >
            <History size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Nova conversa"
            aria-label="Nova conversa"
            onClick={() => fresh(place?.client ?? client)}
          >
            <Plus size={17} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Fechar a IA"
            onClick={() => setOpen(false)}
          >
            <X size={17} />
          </button>
        </span>
      </header>
      {error && (
        <p className="form-error ai-drawer-error" role="alert">
          {error}
        </p>
      )}

      {view === "history" ? (
        <div className="ai-history">
          {list === null ? (
            <Loading compact />
          ) : !list.length ? (
            <p className="muted centered">Nenhuma conversa ainda.</p>
          ) : (
            <>
              {[
                ["Minhas conversas", mine],
                ["Compartilhadas comigo", shared],
              ].map(([title, items]) =>
                (items as AiConversation[]).length ? (
                  <section key={title as string}>
                    <h4>{title as string}</h4>
                    <ul>
                      {(items as AiConversation[]).map((c) => (
                        <li key={c.id}>
                          <button
                            type="button"
                            className="ai-history-item"
                            onClick={() => void load(c)}
                          >
                            <span>{c.title}</span>
                            <small>
                              {when(c.updated_at)}
                              {c.scope?.client
                                ? ` · cliente ${clientName(c.scope.client)}`
                                : " · todos os clientes"}
                              {c.owner_id !== user
                                ? ` · de ${memberName(c.owner_id)}`
                                : ""}
                            </small>
                          </button>
                          {c.owner_id === user && (
                            <span className="ai-history-actions">
                              <button
                                type="button"
                                className="icon-btn"
                                aria-label={`Renomear ${c.title}`}
                                onClick={() => void rename(c)}
                              >
                                <Pencil size={13} />
                              </button>
                              <button
                                type="button"
                                className="icon-btn"
                                aria-label={`Apagar ${c.title}`}
                                onClick={() => void remove(c)}
                              >
                                <Trash2 size={13} />
                              </button>
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null,
              )}
            </>
          )}
        </div>
      ) : (
        <>
          <div className="ai-scope">
            <Select
              aria-label="Sobre qual cliente"
              value={client || "all"}
              disabled={!!conv}
              onValueChange={(v) => fresh(v === "all" ? "" : v)}
            >
              <SelectOption value="all">Todos os clientes</SelectOption>
              {clients.map((c) => (
                <SelectOption key={c.id} value={c.id}>
                  Cliente {c.name}
                </SelectOption>
              ))}
            </Select>
            {conv && (
              <small>
                {readOnly
                  ? `Compartilhada por ${memberName(conv.owner_id)}`
                  : "Conversa salva"}
              </small>
            )}
          </div>
          <AiChat
            key={chat.key}
            initial={chat.entries}
            intro={
              client
                ? `Pergunte sobre o cliente ${clientName(client)}: a IA busca nas reuniões gravadas e nas tarefas e mostra de onde tirou cada informação.`
                : "Pergunte sobre qualquer cliente que você acessa: a IA busca nas reuniões gravadas e nas tarefas e mostra de onde tirou cada informação."
            }
            placeholder={
              client
                ? `Pergunte sobre o cliente ${clientName(client)}`
                : "Pergunte sobre qualquer cliente"
            }
            suggestions={client ? SUGGESTIONS_CLIENT : SUGGESTIONS_ALL}
            readOnly={readOnly}
            readOnlyNote={
              <>
                <Lock size={13} aria-hidden="true" /> Conversa compartilhada: só
                quem a começou continua. Para perguntar, abra uma nova conversa.
              </>
            }
            send={(q, _history, handlers) =>
              askAi(
                company,
                { client: client || undefined, module: "assistant" },
                q,
                conv?.id ?? null,
                handlers,
              )
            }
            onAnswer={(a) => {
              if (!conv && a.conversation)
                setChat((p) => ({
                  ...p,
                  conversation: {
                    id: a.conversation!,
                    owner_id: user,
                    title: "Nova conversa",
                    scope: client ? { client } : {},
                    module: "assistant",
                    updated_at: new Date().toISOString(),
                  },
                }));
            }}
            renderAnswer={(text, sources) => (
              <AnswerText
                text={text}
                sources={sources}
                onSource={openAiSource}
              />
            )}
          />
        </>
      )}
      {sharing && conv && (
        <ShareDialog
          conversation={conv}
          data={data}
          user={user}
          onClose={() => setSharing(false)}
          notify={notify}
        />
      )}
    </aside>
  );
}

function ShareDialog({
  conversation,
  data,
  user,
  onClose,
  notify,
}: {
  conversation: AiConversation;
  data: Snapshot;
  user: string;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<{ user: string; reason: string }[]>(
    [],
  );
  const [error, setError] = useState("");
  const people = data.members
    .filter((m) => m.active && m.user_id !== user)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  const q = fold(query.trim());
  const shown = q
    ? people.filter((m) => fold(`${m.name} ${m.email ?? ""}`).includes(q))
    : people;
  useEffect(() => {
    conversationShares(conversation.id)
      .then((ids) => setPicked(new Set(ids)))
      .catch((e) => setError((e as Error).message));
  }, [conversation.id]);
  const name = (id: string) =>
    data.members.find((m) => m.user_id === id)?.name ?? "Alguém";
  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  async function save() {
    if (!picked) return;
    setBusy(true);
    setError("");
    try {
      const r = await shareConversation(conversation.id, [...picked]);
      setRefused(r.refused);
      if (!r.refused.length) {
        notify(
          r.shared.length
            ? `Conversa compartilhada com ${r.shared.length} ${r.shared.length === 1 ? "pessoa" : "pessoas"}.`
            : "Conversa não está mais compartilhada.",
        );
        onClose();
      } else setPicked(new Set(r.shared));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Compartilhar conversa" onClose={onClose} busy={busy}>
      <div className="entity-form share-folder">
        {picked === null && !error ? (
          <Loading compact />
        ) : (
          <section className="share-block">
            <strong className="share-title">
              <Users size={15} /> Pessoas com acesso
            </strong>
            <small>
              Quem você escolher vê a conversa com as fontes citadas, sem poder
              continuar. Só dá para compartilhar com quem já tem acesso a tudo
              que ela cita.
            </small>
            <span className="share-search">
              <Input
                type="search"
                icon={Search}
                placeholder="Buscar pessoa"
                aria-label="Buscar pessoa"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </span>
            <ul className="share-people" aria-label="Pessoas do espaço">
              {shown.map((m) => (
                <li key={m.user_id}>
                  <label>
                    <Checkbox
                      checked={!!picked?.has(m.user_id)}
                      onCheckedChange={() => toggle(m.user_id)}
                    />
                    <Avatar name={m.name} src={m.avatar_url} size="small" />
                    <span>
                      <strong>{m.name}</strong>
                      {m.email && <small>{m.email}</small>}
                    </span>
                  </label>
                </li>
              ))}
              {!shown.length && (
                <li className="share-empty">
                  {people.length
                    ? "Ninguém encontrado."
                    : "Não há outras pessoas no espaço."}
                </li>
              )}
            </ul>
            {!!picked?.size && (
              <small className="share-hint">
                {picked.size === 1
                  ? "1 pessoa selecionada"
                  : `${picked.size} pessoas selecionadas`}
              </small>
            )}
          </section>
        )}
        {refused.length > 0 && (
          <p className="form-error" role="alert">
            Não compartilhada com{" "}
            {refused.map((r) => `${name(r.user)} (${r.reason})`).join("; ")}.
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          <Button className="btn secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            className="btn primary"
            onClick={() => void save()}
            loading={busy}
            disabled={picked === null}
          >
            Salvar compartilhamento
          </Button>
        </div>
      </div>
    </Modal>
  );
}

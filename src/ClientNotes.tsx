import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import {
  ArrowLeft,
  History,
  KeyRound,
  Link2,
  NotebookPen,
  Plus,
  RotateCcw,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import RichTextEditor from "./RichTextEditor";
import { RichTextContent } from "./RichTextContent";
import { Button, Input, Loading } from "./ui";
import {
  clientNoteLink,
  clientNoteSecretLog,
  clientNoteVersion,
  clientNoteVersions,
  createClientNote,
  deleteClientNote,
  getClientNote,
  listClientNotes,
  NoteConflict,
  restoreClientNote,
  saveClientNote,
  undeleteClientNote,
  type ClientNote,
  type ClientNoteSecretAccess,
  type ClientNoteVersion,
} from "./client-notes";
import "./client-notes.css";

const when = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
const DISCARD = "Descartar as alterações que você não salvou?";

/**
 * Anotações do cliente: acessos, links úteis, combinados. Ficam no cliente
 * (todas as tarefas dele e Drive › cliente › Anotações); quem vê o cliente lê
 * e edita todas. Cada Salvar vira uma versão, com restaurar.
 */
export function ClientNotes({
  company,
  client,
  clientName,
  notify,
  initial,
  demo = false,
}: {
  company: string;
  client: string;
  clientName: string;
  notify: (message: string) => void;
  /** Abrir esta anotação assim que a lista chegar (link ?nota=). */
  initial?: string | null;
  demo?: boolean;
}) {
  const [list, setList] = useState<ClientNote[] | null>(null);
  const [deleted, setDeleted] = useState<ClientNote[] | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  // A anotação aberta ("new": uma nova, ainda sem salvar).
  const [open, setOpen] = useState<ClientNote | "new" | null>(null);
  const dirty = useRef(false);

  const load = useCallback(() => {
    if (demo) {
      setList([]);
      return;
    }
    listClientNotes(company, client)
      .then((l) => {
        setList(l);
        setError("");
      })
      .catch((e) => setError((e as Error).message));
  }, [company, client, demo]);
  const loadDeleted = useCallback(() => {
    listClientNotes(company, client, true)
      .then(setDeleted)
      .catch((e) => setError((e as Error).message));
  }, [company, client]);
  useEffect(() => {
    setList(null);
    setOpen(null);
    load();
  }, [load]);
  useEffect(() => {
    if (showDeleted) loadDeleted();
  }, [showDeleted, loadDeleted]);
  // Ao vivo: o que alguém criou, salvou ou excluiu neste cliente.
  useEffect(() => {
    const onNotice = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      if (d.client && d.client !== client) return;
      load();
      if (showDeleted) loadDeleted();
    };
    window.addEventListener("mavi:client-notes", onNotice);
    return () => window.removeEventListener("mavi:client-notes", onNotice);
  }, [client, load, loadDeleted, showDeleted]);

  // O link de uma anotação abre direto nela.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!initial || opened.current === initial) return;
    opened.current = initial;
    getClientNote(initial)
      .then(setOpen)
      .catch(() => setError("Anotação não encontrada ou sem acesso."));
  }, [initial]);

  function leave(next: ClientNote | "new" | null) {
    if (dirty.current && !window.confirm(DISCARD)) return;
    dirty.current = false;
    setOpen(next);
  }
  async function openNote(note: ClientNote) {
    try {
      leave(await getClientNote(note.id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const text = query.trim().toLocaleLowerCase("pt-BR");
  const shown = useMemo(
    () =>
      (list ?? []).filter(
        (n) =>
          !text ||
          n.title.toLocaleLowerCase("pt-BR").includes(text) ||
          n.excerpt.toLocaleLowerCase("pt-BR").includes(text),
      ),
    [list, text],
  );

  if (demo)
    return (
      <p className="muted centered">
        Anotações do cliente disponíveis após conectar ao Supabase.
      </p>
    );
  if (open)
    return (
      <NoteEditor
        key={open === "new" ? "new" : open.id}
        company={company}
        client={client}
        clientName={clientName}
        note={open === "new" ? null : open}
        notify={notify}
        dirty={dirty}
        onBack={() => leave(null)}
        onSaved={(n) => {
          setOpen(n);
          load();
        }}
        onDeleted={() => {
          dirty.current = false;
          setOpen(null);
          load();
        }}
      />
    );
  return (
    <div className="client-notes">
      <p className="client-notes-intro">
        Acessos, links úteis e combinados de <strong>{clientName}</strong>.
        Aparecem em todas as tarefas do cliente e no Drive, e a MAVI lê tudo,
        menos o valor dos secretos.
      </p>
      <div className="client-notes-toolbar">
        <Input
          type="search"
          icon={Search}
          value={query}
          placeholder="Buscar nas anotações"
          aria-label="Buscar nas anotações"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className="btn primary"
          onClick={() => leave("new")}
        >
          <Plus size={16} /> Nova anotação
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!list ? (
        <Loading compact />
      ) : !list.length ? (
        <div className="client-notes-empty">
          <NotebookPen size={26} aria-hidden="true" />
          <strong>Nenhuma anotação ainda</strong>
          <span>
            Guarde aqui logins, links e combinados com o cliente. Para senhas e
            tokens, use o botão Secreto <KeyRound size={13} /> do editor.
          </span>
        </div>
      ) : (
        <ul className="client-notes-list">
          {shown.map((n) => (
            <li key={n.id}>
              <button type="button" onClick={() => void openNote(n)}>
                <span className="client-note-title">
                  {n.title}
                  {n.secrets > 0 && (
                    <span
                      className="client-note-secrets"
                      title={`${n.secrets} ${n.secrets === 1 ? "secreto" : "secretos"}`}
                    >
                      <KeyRound size={12} /> {n.secrets}
                    </span>
                  )}
                </span>
                {n.excerpt && (
                  <span className="client-note-excerpt">{n.excerpt}</span>
                )}
                <span className="client-note-meta">
                  {n.updated_by_name ?? "Alguém"} · {when(n.updated_at)} · v
                  {n.version}
                </span>
              </button>
            </li>
          ))}
          {!shown.length && (
            <li className="muted centered">Nada encontrado para “{query}”.</li>
          )}
        </ul>
      )}
      <button
        type="button"
        className="client-notes-trash-toggle"
        aria-expanded={showDeleted}
        onClick={() => setShowDeleted((s) => !s)}
      >
        <Trash2 size={14} />{" "}
        {showDeleted ? "Ocultar excluídas" : "Ver excluídas"}
      </button>
      {showDeleted &&
        (!deleted ? (
          <Loading compact />
        ) : !deleted.length ? (
          <p className="muted">Nenhuma anotação excluída.</p>
        ) : (
          <ul className="client-notes-list deleted">
            {deleted.map((n) => (
              <li key={n.id}>
                <div>
                  <span className="client-note-title">{n.title}</span>
                  <span className="client-note-meta">
                    Excluída por {n.deleted_by_name ?? "alguém"} em{" "}
                    {n.deleted_at && when(n.deleted_at)}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() =>
                    void undeleteClientNote(n.id)
                      .then(() => {
                        notify("Anotação restaurada.");
                        load();
                        loadDeleted();
                      })
                      .catch((e) => setError((e as Error).message))
                  }
                >
                  <RotateCcw size={15} /> Restaurar
                </button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

function NoteEditor({
  company,
  client,
  clientName,
  note,
  notify,
  dirty,
  onBack,
  onSaved,
  onDeleted,
}: {
  company: string;
  client: string;
  clientName: string;
  note: ClientNote | null;
  notify: (message: string) => void;
  dirty: MutableRefObject<boolean>;
  onBack: () => void;
  onSaved: (note: ClientNote) => void;
  onDeleted: () => void;
}) {
  const [title, setTitle] = useState(note?.title ?? "");
  const [body, setBody] = useState(note?.body ?? "");
  // Muda quando o texto vem de fora (restaurar, recarregar): o editor recomeça.
  const [loaded, setLoaded] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<NoteConflict | null>(null);
  // Outra pessoa salvou enquanto esta tela estava aberta.
  const [newer, setNewer] = useState(false);
  const [history, setHistory] = useState(false);
  const changed = !note
    ? !!title.trim() || !!body
    : title !== note.title || body !== (note.body ?? "");
  dirty.current = changed;
  // Versão nova (salva aqui, restaurada ou vinda de outra pessoa): o
  // formulário passa a ser ela.
  useEffect(() => {
    if (!note) return;
    setTitle(note.title);
    setBody(note.body ?? "");
  }, [note?.id, note?.version]);

  // Ao vivo: se ninguém mexeu aqui, a versão nova entra sozinha; se mexeu, avisa.
  useEffect(() => {
    if (!note) return;
    const onNotice = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      if (d.note && d.note !== note.id) return;
      if (d.version && d.version <= note.version) return;
      if (dirty.current) {
        setNewer(true);
        return;
      }
      void getClientNote(note.id)
        .then((n) => {
          if (n.deleted_at) {
            notify("Esta anotação foi excluída por outra pessoa.");
            onDeleted();
            return;
          }
          if (n.version === note.version || dirty.current) return;
          onSaved(n);
        })
        .catch(() => {});
    };
    window.addEventListener("mavi:client-notes", onNotice);
    return () => window.removeEventListener("mavi:client-notes", onNotice);
  }, [note, notify, onSaved, onDeleted, dirty]);

  async function save(base = note?.version) {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const saved = note
        ? await saveClientNote(note.id, title, body, base!)
        : await createClientNote(company, client, title, body);
      dirty.current = false;
      setConflict(null);
      setNewer(false);
      notify(
        !note
          ? "Anotação criada."
          : saved.version === note.version
            ? "Nada mudou desde a última versão."
            : `Versão ${saved.version} salva.`,
      );
      onSaved(saved);
    } catch (e) {
      if (e instanceof NoteConflict) setConflict(e);
      else setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  // Ctrl/⌘+S salva.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty.current) void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function reloadLatest() {
    if (!note) return;
    if (dirty.current && !window.confirm(DISCARD)) return;
    try {
      const n = await getClientNote(note.id);
      dirty.current = false;
      setConflict(null);
      setNewer(false);
      onSaved(n);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function remove() {
    if (!note) return;
    if (
      !window.confirm(
        `Excluir a anotação "${note.title}"? Ela sai da lista e da MAVI, mas pode ser restaurada em "Ver excluídas".`,
      )
    )
      return;
    try {
      await deleteClientNote(note.id);
      notify("Anotação excluída.");
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (history && note)
    return (
      <NoteHistory
        note={note}
        onBack={() => setHistory(false)}
        onRestored={(n) => {
          setHistory(false);
          notify(`Versão ${n.version} criada a partir da restauração.`);
          onSaved(n);
        }}
      />
    );
  return (
    <div className="client-note-editor">
      <div className="client-note-head">
        <button
          type="button"
          className="icon-btn"
          aria-label="Voltar para as anotações"
          title="Voltar para as anotações"
          onClick={onBack}
        >
          <ArrowLeft size={18} />
        </button>
        <span className="client-note-crumb">Anotações · {clientName}</span>
        {note && (
          <span className="client-note-actions">
            <button
              type="button"
              className="icon-btn"
              aria-label="Histórico de versões"
              title="Histórico de versões e acessos aos secretos"
              onClick={() => {
                if (dirty.current && !window.confirm(DISCARD)) return;
                setTitle(note.title);
                setBody(note.body ?? "");
                setHistory(true);
              }}
            >
              <History size={17} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Copiar link da anotação"
              title="Copiar link"
              onClick={() =>
                void navigator.clipboard
                  .writeText(clientNoteLink(note.id))
                  .then(() => notify("Link copiado."))
              }
            >
              <Link2 size={17} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Excluir anotação"
              title="Excluir"
              onClick={() => void remove()}
            >
              <Trash2 size={17} />
            </button>
          </span>
        )}
      </div>
      <label className="client-note-title-field">
        Título
        <Input
          value={title}
          maxLength={200}
          placeholder="Ex.: Acessos das plataformas"
          autoFocus={!note}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      {conflict && (
        <div className="client-note-alert" role="alert">
          <p>{conflict.message}</p>
          <p className="muted">
            Nada foi perdido: a versão dela já está no histórico. Você pode ver
            a versão nova (descarta o que você mudou) ou salvar a sua como a
            próxima versão.
          </p>
          <span>
            <button
              type="button"
              className="btn secondary"
              onClick={() => void reloadLatest()}
            >
              Ver a versão nova
            </button>
            <Button
              type="button"
              className="btn primary"
              loading={saving}
              onClick={() => void save(conflict.version ?? undefined)}
            >
              Salvar a minha mesmo assim
            </Button>
          </span>
        </div>
      )}
      {newer && !conflict && (
        <div className="client-note-alert info" role="status">
          <p>Outra pessoa salvou uma versão nova desta anotação.</p>
          <button
            type="button"
            className="btn secondary"
            onClick={() => void reloadLatest()}
          >
            Carregar a versão nova
          </button>
        </div>
      )}
      <RichTextEditor
        key={`${note?.id ?? "new"}:${note?.version ?? 0}:${loaded}`}
        name="client-note-body"
        label="Texto"
        company={company}
        defaultValue={note?.body ?? body}
        secrets={{ company, client, note: note?.id ?? null }}
        onChange={setBody}
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="client-note-foot">
        <span className="client-note-meta">
          {note
            ? `Versão ${note.version} · salva por ${note.updated_by_name ?? "alguém"} em ${when(note.updated_at)}`
            : "Nova anotação: a primeira versão nasce ao salvar."}
        </span>
        {changed && note && (
          <button
            type="button"
            className="btn secondary"
            disabled={saving}
            onClick={() => {
              setTitle(note.title);
              setBody(note.body ?? "");
              setLoaded((n) => n + 1);
              dirty.current = false;
            }}
          >
            Descartar
          </button>
        )}
        <Button
          type="button"
          className="btn primary"
          loading={saving}
          disabled={!changed || !title.trim()}
          title="Salvar (Ctrl+S)"
          onClick={() => void save()}
        >
          <Save size={16} /> Salvar
        </Button>
      </div>
    </div>
  );
}

const ACTION_LABEL = {
  create: "Criada",
  save: "Salva",
  restore: "Restaurada",
  import: "Importada do MASO",
} as const;

function NoteHistory({
  note,
  onBack,
  onRestored,
}: {
  note: ClientNote;
  onBack: () => void;
  onRestored: (note: ClientNote) => void;
}) {
  const [versions, setVersions] = useState<ClientNoteVersion[] | null>(null);
  const [access, setAccess] = useState<ClientNoteSecretAccess[] | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [preview, setPreview] = useState<{
    version: number;
    title: string;
    body: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    clientNoteVersions(note.id)
      .then(setVersions)
      .catch((e) => setError((e as Error).message));
    clientNoteSecretLog(note.id)
      .then(setAccess)
      .catch(() => setAccess([]));
  }, [note.id, note.version]);
  useEffect(() => {
    if (picked === null) return;
    setPreview(null);
    clientNoteVersion(note.id, picked)
      .then(setPreview)
      .catch((e) => setError((e as Error).message));
  }, [note.id, picked]);
  async function restore(version: number) {
    if (
      !window.confirm(
        `Restaurar a versão ${version}? O conteúdo dela vira a versão ${note.version + 1}; as outras continuam no histórico.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      onRestored(await restoreClientNote(note.id, version, note.version));
    } catch (e) {
      setError(
        e instanceof NoteConflict
          ? `${e.message} Volte e abra a versão nova antes de restaurar.`
          : (e as Error).message,
      );
      setBusy(false);
    }
  }
  return (
    <div className="client-note-editor">
      <div className="client-note-head">
        <button
          type="button"
          className="icon-btn"
          aria-label="Voltar para a anotação"
          title="Voltar para a anotação"
          onClick={onBack}
        >
          <ArrowLeft size={18} />
        </button>
        <span className="client-note-crumb">Histórico · {note.title}</span>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!versions ? (
        <Loading compact />
      ) : (
        <ul className="client-note-versions">
          {versions.map((v) => (
            <li key={v.version}>
              <button
                type="button"
                aria-pressed={picked === v.version}
                onClick={() =>
                  setPicked(picked === v.version ? null : v.version)
                }
              >
                <strong>
                  v{v.version}
                  {v.version === note.version && " · atual"}
                </strong>
                <span>
                  {ACTION_LABEL[v.action]}
                  {v.restored_from ? ` da v${v.restored_from}` : ""} por{" "}
                  {v.saved_by_name ?? "alguém"} · {when(v.saved_at)}
                </span>
                <span className="client-note-meta">
                  {v.chars} caracteres
                  {v.secrets ? ` · ${v.secrets} secreto(s)` : ""}
                  {v.title !== note.title ? ` · título “${v.title}”` : ""}
                </span>
              </button>
              {picked === v.version && (
                <div className="client-note-preview">
                  {!preview ? (
                    <Loading compact />
                  ) : (
                    <>
                      <h4>{preview.title}</h4>
                      <RichTextContent value={preview.body} note={note.id} />
                      {v.version !== note.version && (
                        <Button
                          type="button"
                          className="btn primary"
                          loading={busy}
                          onClick={() => void restore(v.version)}
                        >
                          <RotateCcw size={15} /> Restaurar esta versão
                        </Button>
                      )}
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <h4 className="client-note-subhead">
        <KeyRound size={14} /> Quem mostrou ou copiou os secretos
      </h4>
      {!access ? (
        <Loading compact />
      ) : !access.length ? (
        <p className="muted">Ninguém abriu os secretos desta anotação.</p>
      ) : (
        <ul className="client-note-access">
          {access.map((a, i) => (
            <li key={i}>
              <strong>{a.user_name ?? "Alguém"}</strong>{" "}
              {a.action === "copy" ? "copiou" : "viu"} “{a.label}” ·{" "}
              {when(a.at)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

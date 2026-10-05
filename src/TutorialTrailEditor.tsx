import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  EyeOff,
  Plus,
  Search,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { Button, Checkbox, Input, Textarea } from "./ui";
import { AudiencePicker } from "./TutorialEditor";
import {
  MAX_TRAIL_TUTORIALS,
  emptyTrail,
  hasRequired,
  trailContentOf,
  type TrailContent,
  type TrailDetail,
  type TrailsApi,
} from "./tutorial-trails";
import type { TutorialRow, TutorialsApi } from "./tutorials";
import type { Snapshot } from "./types";

type Picked = { title: string; status: "draft" | "published"; aud_all: boolean };

/**
 * Montar uma trilha (administradores; gestores, as suas): título, resumo, a
 * ordem (livre ou em sequência), os tutoriais, quem vê e quem é obrigado
 * (quem entrar a partir de agora e/ou um público), com prazo opcional. Uma
 * trilha publicada salva direto no ar.
 */
export function TutorialTrailEditor({
  api,
  tutorials,
  company,
  data,
  user,
  detail,
  notify,
  onClose,
}: {
  api: TrailsApi;
  tutorials: TutorialsApi;
  company: string;
  data: Snapshot;
  user: string;
  detail: TrailDetail | null;
  notify: (message: string) => void;
  /** Leaves the editor; with an id, opens that trail. */
  onClose: (id: string | null) => void;
}) {
  const initial = useMemo(() => (detail ? trailContentOf(detail) : emptyTrail()), [detail]);
  const [form, setForm] = useState<TrailContent>(initial);
  const [required, setRequired] = useState(hasRequired(initial));
  const [known, setKnown] = useState<Record<string, Picked>>(() =>
    Object.fromEntries(
      (detail?.items ?? []).map((i) => [i.tutorial_id, { title: i.title, status: i.status, aud_all: i.aud_all }]),
    ),
  );
  const [id, setId] = useState<string | null>(detail?.id ?? null);
  const [revision, setRevision] = useState<number | null>(detail?.revision ?? null);
  const [published, setPublished] = useState(detail?.status === "published");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "publish" | "other">("");
  const [error, setError] = useState("");
  const set = (patch: Partial<TrailContent>) => {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
  };

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const leave = (target: string | null) => {
    if (dirty && !window.confirm("Sair sem salvar? As alterações desta trilha se perdem.")) return;
    onClose(target);
  };

  const content = (): TrailContent =>
    required
      ? form
      : { ...form, req_newcomers: false, req_all: false, req_roles: [], req_teams: [], req_users: [], due_days: null };

  async function save(publish: boolean) {
    setError("");
    if (required && !hasRequired(form)) {
      setError("Escolha quem é obrigado: quem entrar a partir de agora, todos, papéis, equipes ou pessoas.");
      return;
    }
    setBusy(publish ? "publish" : "save");
    try {
      const r = await api.save(company, id, content(), publish, revision);
      setId(r.id);
      setRevision(r.revision);
      setPublished(r.status === "published");
      setDirty(false);
      if (publish && !published) {
        notify(
          required
            ? "Trilha publicada. Quem é obrigado recebe o aviso na caixa de entrada."
            : "Trilha publicada. O público escolhido já pode seguir.",
        );
        onClose(r.id);
      } else if (r.status === "published") {
        notify("Trilha salva. As mudanças já valem para todos.");
        onClose(r.id);
      } else notify("Rascunho salvo. Só quem edita vê até você publicar.");
    } catch (e) {
      setError((e as Error).message || "Não foi possível salvar a trilha.");
    } finally {
      setBusy("");
    }
  }

  async function run(question: string, action: () => Promise<unknown>, done: string, target: string | null) {
    if (!window.confirm(question)) return;
    setError("");
    setBusy("other");
    try {
      await action();
      notify(done);
      setDirty(false);
      onClose(target);
    } catch (e) {
      setError((e as Error).message || "Não foi possível concluir.");
    } finally {
      setBusy("");
    }
  }

  const move = (i: number, by: number) => {
    const list = [...form.tutorials];
    const [x] = list.splice(i, 1);
    list.splice(i + by, 0, x);
    set({ tutorials: list });
  };
  const add = (row: TutorialRow) => {
    if (form.tutorials.includes(row.id) || form.tutorials.length >= MAX_TRAIL_TUTORIALS) return;
    setKnown((k) => ({ ...k, [row.id]: { title: row.title, status: row.status, aud_all: row.aud_all } }));
    set({ tutorials: [...form.tutorials, row.id] });
  };
  const locked = !!busy;
  // Quem é obrigado, no formato do seletor de público (as exclusões de "quem vê" valem).
  const req = {
    aud_all: form.req_all,
    aud_roles: form.req_roles,
    aud_teams: form.req_teams,
    aud_users: form.req_users,
    aud_exclude: form.aud_exclude,
  };

  return (
    <div className="tutorial-editor trail-editor">
      <div className="tutorial-editor-bar">
        <button type="button" className="text-btn" onClick={() => leave(id)} disabled={!!busy}>
          <ArrowLeft size={15} /> {id ? "Voltar à trilha" : "Cancelar"}
        </button>
        <span className={`tutorial-status ${published ? "published" : "draft"}`}>
          {!id ? "Nova trilha" : published ? "No ar" : "Rascunho"}
          {dirty ? " · não salvo" : ""}
        </span>
        <span className="tutorial-editor-actions">
          {published ? (
            <Button className="btn primary" onClick={() => void save(false)} loading={busy === "save"} disabled={locked}>
              <Send size={15} /> Salvar alterações
            </Button>
          ) : (
            <>
              <Button className="btn secondary" onClick={() => void save(false)} loading={busy === "save"} disabled={locked}>
                Salvar rascunho
              </Button>
              <Button className="btn primary" onClick={() => void save(true)} loading={busy === "publish"} disabled={locked}>
                <Send size={15} /> Publicar
              </Button>
            </>
          )}
        </span>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <div className="tutorial-editor-grid">
        <div className="tutorial-editor-main">
          <label className="tutorial-title-field">
            <span className="sr-only">Título</span>
            <input
              value={form.title}
              maxLength={120}
              onChange={(e) => set({ title: e.target.value })}
              placeholder="Título da trilha"
              aria-label="Título da trilha"
              disabled={locked}
              autoFocus={!detail}
            />
          </label>
          <label className="field">
            <span>Resumo</span>
            <Textarea
              value={form.summary}
              maxLength={600}
              rows={2}
              onChange={(e) => set({ summary: e.target.value })}
              placeholder="Para quem é e o que a pessoa sabe fazer ao final."
              disabled={locked}
            />
          </label>
          <fieldset className="trail-order" disabled={locked}>
            <legend>Ordem</legend>
            <label className="checkbox-label">
              <input
                type="radio"
                name="trail-order"
                checked={!form.sequential}
                onChange={() => set({ sequential: false })}
              />
              <span>
                <strong>Ordem livre</strong>
                <small>A sequência é sugerida; a pessoa abre qualquer tutorial.</small>
              </span>
            </label>
            <label className="checkbox-label">
              <input
                type="radio"
                name="trail-order"
                checked={form.sequential}
                onChange={() => set({ sequential: true })}
              />
              <span>
                <strong>Em sequência</strong>
                <small>O próximo só libera depois de concluir o anterior.</small>
              </span>
            </label>
          </fieldset>

          <div className="field">
            <span>
              Tutoriais{" "}
              <small>
                ({form.tutorials.length} de até {MAX_TRAIL_TUTORIALS})
              </small>
            </span>
            {form.tutorials.length ? (
              <ol className="trail-edit-list">
                {form.tutorials.map((t, i) => {
                  const k = known[t];
                  return (
                    <li key={t}>
                      <span className="trail-edit-n">{i + 1}</span>
                      <span className="trail-edit-title">
                        {k?.title ?? "Tutorial"}
                        {k?.status === "draft" && <small className="tutorial-status draft">Rascunho</small>}
                        {k && !k.aud_all && <small className="tutorial-restricted">Público restrito</small>}
                      </span>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`Subir ${k?.title ?? "tutorial"}`}
                        onClick={() => move(i, -1)}
                        disabled={locked || i === 0}
                      >
                        <ChevronUp size={16} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`Descer ${k?.title ?? "tutorial"}`}
                        onClick={() => move(i, 1)}
                        disabled={locked || i === form.tutorials.length - 1}
                      >
                        <ChevronDown size={16} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`Tirar ${k?.title ?? "tutorial"} da trilha`}
                        onClick={() => set({ tutorials: form.tutorials.filter((x) => x !== t) })}
                        disabled={locked}
                      >
                        <X size={16} />
                      </button>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="trail-edit-empty">Busque abaixo e adicione os tutoriais na ordem da trilha.</p>
            )}
            {(form.tutorials.some((t) => known[t]?.status === "draft") ||
              form.tutorials.some((t) => known[t] && !known[t].aud_all)) && (
              <small>
                Rascunhos não aparecem até serem publicados. Um tutorial de público restrito só conta para quem o vê.
              </small>
            )}
            <TutorialAdder
              api={tutorials}
              company={company}
              picked={form.tutorials}
              disabled={locked || form.tutorials.length >= MAX_TRAIL_TUTORIALS}
              onAdd={add}
            />
          </div>
        </div>

        <aside className="tutorial-editor-side entity-form">
          <AudiencePicker
            data={data}
            user={user}
            value={form}
            disabled={locked}
            hint="Os públicos se somam. Quem é obrigado sempre vê."
            estimate="além de quem é obrigado"
            onChange={(a) => set(a)}
          />

          <fieldset className="notice-block">
            <legend>Obrigatória</legend>
            <label className="checkbox-label">
              <Checkbox
                checked={required}
                onCheckedChange={(v) => {
                  setRequired(v === true);
                  setDirty(true);
                }}
                disabled={locked}
              />
              Esta trilha é obrigatória
            </label>
            {required && (
              <>
                <label className="checkbox-label">
                  <Checkbox
                    checked={form.req_newcomers}
                    onCheckedChange={(v) => set({ req_newcomers: v === true })}
                    disabled={locked}
                  />
                  Para quem entrar na agência a partir de agora
                </label>
                <small>
                  {detail?.config?.req_newcomers && detail.config.req_since
                    ? `Quem entrou desde ${new Date(detail.config.req_since).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}.`
                    : "Conta a partir de quando você salvar."}
                </small>
                <label className="field">
                  <span>Prazo para concluir (dias)</span>
                  <Input
                    type="number"
                    min={1}
                    max={365}
                    inputMode="numeric"
                    value={form.due_days ?? ""}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      set({ due_days: Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : null });
                    }}
                    placeholder="Sem prazo"
                    disabled={locked}
                  />
                  <small>Conta de quando a trilha chega à pessoa. Vencido, ela recebe um aviso e os líderes veem o atraso.</small>
                </label>
              </>
            )}
          </fieldset>
          {required && (
            <AudiencePicker
              data={data}
              user={user}
              value={req}
              disabled={locked}
              legend="Também obrigatória para"
              hint="Quem já está no público recebe ao publicar; quem entrar depois numa equipe escolhida recebe em até 10 minutos."
              exclude={false}
              estimate=""
              onChange={(a) =>
                set({
                  ...(a.aud_all !== undefined ? { req_all: a.aud_all } : {}),
                  ...(a.aud_roles ? { req_roles: a.aud_roles } : {}),
                  ...(a.aud_teams ? { req_teams: a.aud_teams } : {}),
                  ...(a.aud_users ? { req_users: a.aud_users } : {}),
                })
              }
            />
          )}

          {id && detail && (
            <fieldset className="notice-block tutorial-danger">
              <legend>Mais</legend>
              {published && (
                <Button
                  className="btn secondary"
                  disabled={locked}
                  onClick={() =>
                    void run(
                      "Tirar a trilha do ar? Ela volta a ser rascunho e só quem edita vê. O progresso das pessoas fica guardado.",
                      () => api.unpublish(id),
                      "Trilha fora do ar.",
                      id,
                    )
                  }
                >
                  <EyeOff size={15} /> Tirar do ar
                </Button>
              )}
              <Button
                className="btn danger"
                disabled={locked}
                onClick={() =>
                  void run(
                    "Apagar a trilha? Os tutoriais continuam; só a trilha e os prazos saem.",
                    () => api.remove(id),
                    "Trilha apagada.",
                    null,
                  )
                }
              >
                <Trash2 size={15} /> Apagar trilha
              </Button>
            </fieldset>
          )}
        </aside>
      </div>
    </div>
  );
}

/** Busca os tutoriais (os que a pessoa edita e os publicados) para adicionar. */
function TutorialAdder({
  api,
  company,
  picked,
  disabled,
  onAdd,
}: {
  api: TutorialsApi;
  company: string;
  picked: string[];
  disabled: boolean;
  onAdd: (row: TutorialRow) => void;
}) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<TutorialRow[] | null>(null);
  const request = useRef(0);
  useEffect(() => {
    const n = ++request.current;
    const timer = setTimeout(() => {
      api
        .list(company, { scope: "admin", query, module: "", category: "", tags: [], limit: 20, offset: 0 })
        .then((r) => n === request.current && setRows(r))
        .catch(() => n === request.current && setRows([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [api, company, query]);
  const shown = (rows ?? []).filter((r) => !picked.includes(r.id));
  return (
    <div className="trail-adder">
      <label className="trail-adder-search">
        <Search size={15} aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar tutoriais para adicionar"
          aria-label="Buscar tutoriais para adicionar"
          disabled={disabled}
        />
      </label>
      {rows && (
        <ul className="trail-adder-list">
          {shown.slice(0, 8).map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => onAdd(r)} disabled={disabled}>
                <Plus size={14} />
                <span>{r.title}</span>
                {r.status === "draft" && <small className="tutorial-status draft">Rascunho</small>}
              </button>
            </li>
          ))}
          {!shown.length && <li className="trail-adder-none">{query ? "Nenhum tutorial com essas palavras." : "Todos os tutoriais já estão na trilha."}</li>}
        </ul>
      )}
    </div>
  );
}

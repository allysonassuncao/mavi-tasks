import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CircleCheck,
  Compass,
  Crosshair,
  EyeOff,
  Play,
  Plus,
  RotateCcw,
  Send,
  Settings2,
  Trash2,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { Empty, Modal } from "./components";
import { Button, Loading } from "./ui";
import { AudiencePicker } from "./TutorialEditor";
import { useUrlState } from "./router";
import { audienceSummary, audienceOf } from "./tutorials";
import {
  demoTours,
  editTour,
  emptyTour,
  pageLabel,
  playTour,
  serverTours,
  tourContentOf,
  type TourContent,
  type TourRow,
  type ToursApi,
} from "./tours";
import type { Snapshot } from "./types";
import "./tours.css";

const shortDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", timeZone: "America/Sao_Paulo" })
    : "";

/**
 * Tutoriais › Onboarding: os tours guiados. Todos veem os publicados do seu
 * público (iniciar, continuar, refazer); administradores e gestores criam,
 * montam os passos no editor flutuante (por cima das telas) e publicam.
 */
export function TutorialTours({
  company,
  user,
  isLeader,
  demo,
  data,
  notify,
}: {
  company: string;
  user: string;
  isLeader: boolean;
  demo: boolean;
  data: Snapshot;
  notify: (message: string) => void;
}) {
  const api = useMemo<ToursApi>(
    () => (demo ? demoTours(user, data.members.find((m) => m.user_id === user)?.name) : serverTours),
    [demo, user], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [view, setView] = useUrlState<string>("ver", "");
  const manage = isLeader && view === "gerenciar";
  const [rows, setRows] = useState<TourRow[] | null>(null);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState<{ id: string | null } | null>(null);
  const request = useRef(0);

  const load = useCallback(() => {
    const n = ++request.current;
    api
      .list(company, manage ? "admin" : "library")
      .then((list) => {
        if (n !== request.current) return;
        setRows(list);
        setError("");
      })
      .catch((e) => n === request.current && setError((e as Error).message || "Não foi possível carregar."));
  }, [api, company, manage]);
  useEffect(() => {
    setRows(null);
    load();
  }, [load]);
  // Avisos ao vivo (os mesmos dos tutoriais), agrupados.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const on = () => {
      clearTimeout(t);
      t = setTimeout(load, 400);
    };
    window.addEventListener("mavi:tutorials", on);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mavi:tutorials", on);
    };
  }, [load]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      notify(done);
      load();
    } catch (e) {
      notify((e as Error).message || "Não foi possível concluir.");
    }
  };
  const publish = (id: string) =>
    act(async () => {
      const d = await api.detail(id);
      if (!d) throw Error("Onboarding não encontrado.");
      await api.save(company, id, tourContentOf(d), true, d.revision);
    }, "Onboarding publicado.");

  return (
    <div className="tours-tab">
      <div className="tours-head">
        <div>
          <h2>
            <Compass size={19} aria-hidden="true" /> Onboarding
          </h2>
          <p>Tours guiados pelas telas do sistema: cada passo destaca um elemento e explica o que fazer.</p>
        </div>
        {isLeader && (
          <div className="tours-head-actions">
            <div className="tours-segmented" role="group" aria-label="Mostrar">
              <button type="button" className={!manage ? "selected" : ""} aria-pressed={!manage} onClick={() => setView("")}>
                Para você
              </button>
              <button type="button" className={manage ? "selected" : ""} aria-pressed={manage} onClick={() => setView("gerenciar")}>
                Gerenciar
              </button>
            </div>
            <Button className="btn primary" onClick={() => setSettings({ id: null })}>
              <Plus size={16} /> Novo onboarding
            </Button>
          </div>
        )}
      </div>

      {error && <p className="form-error">{error}</p>}
      {rows === null && !error ? (
        <Loading variant={manage ? "list" : "grid"} />
      ) : rows && !rows.length ? (
        <div className="panel">
          {manage ? (
            <Empty
              title="Nenhum onboarding ainda"
              body="Crie um, navegue pelo sistema e escolha os elementos de cada passo. Ele só aparece para o time depois de publicado."
              action={
                <Button className="btn primary" onClick={() => setSettings({ id: null })}>
                  <Plus size={16} /> Novo onboarding
                </Button>
              }
            />
          ) : (
            <Empty
              title="Nenhum onboarding para você"
              body="Quando houver tours guiados publicados para você, eles aparecem aqui e no “?” das telas."
            />
          )}
        </div>
      ) : rows && manage ? (
        <ManageTable
          rows={rows}
          onSteps={(id) => editTour(id)}
          onSettings={(id) => setSettings({ id })}
          onTest={(id) => playTour(id)}
          onPublish={publish}
          onUnpublish={(id) => act(() => api.unpublish(id), "Onboarding tirado do ar.")}
          onDiscard={(id) => act(() => api.discardDraft(id), "Alteração descartada.")}
          onRemove={(id) => act(() => api.remove(id), "Onboarding apagado.")}
        />
      ) : rows ? (
        <div className="tours-grid">
          {rows.map((r) => (
            <TourCard key={r.id} row={r} />
          ))}
        </div>
      ) : null}

      {settings && (
        <TourSettings
          api={api}
          id={settings.id}
          company={company}
          data={data}
          user={user}
          notify={notify}
          onClose={() => setSettings(null)}
          onSaved={(id, created) => {
            setSettings(null);
            load();
            if (created) {
              notify("Vá até a tela onde o onboarding começa e clique em “Escolher elemento”.");
              editTour(id);
            }
          }}
        />
      )}
    </div>
  );
}

function TourCard({ row }: { row: TourRow }) {
  const done = row.my_status === "completed";
  const paused = !done && row.my_status !== null && (row.my_step ?? 0) > 0;
  return (
    <article className="tour-card">
      <div className="tour-card-top">
        <Compass size={18} aria-hidden="true" />
        {done ? (
          <span className="chip done">
            <CircleCheck size={13} /> Concluído
          </span>
        ) : paused ? (
          <span className="chip">
            Parou no passo {(row.my_step ?? 0) + 1} de {row.step_count}
          </span>
        ) : (
          <span className="chip new">Novo</span>
        )}
      </div>
      <h3>{row.title}</h3>
      {row.summary && <p>{row.summary}</p>}
      <small>
        {row.step_count} {row.step_count === 1 ? "passo" : "passos"} · começa em {pageLabel(row.start_page)}
      </small>
      <div className="tour-card-actions">
        {paused ? (
          <>
            <button type="button" className="btn primary" onClick={() => playTour(row.id, row.my_step ?? 0)}>
              <Play size={15} /> Continuar
            </button>
            <button type="button" className="btn secondary" onClick={() => playTour(row.id, 0)}>
              <RotateCcw size={15} /> Recomeçar
            </button>
          </>
        ) : (
          <button type="button" className={`btn ${done ? "secondary" : "primary"}`} onClick={() => playTour(row.id, 0)}>
            {done ? <RotateCcw size={15} /> : <Play size={15} />} {done ? "Refazer" : "Iniciar"}
          </button>
        )}
      </div>
    </article>
  );
}

function ManageTable({
  rows,
  onSteps,
  onSettings,
  onTest,
  onPublish,
  onUnpublish,
  onDiscard,
  onRemove,
}: {
  rows: TourRow[];
  onSteps: (id: string) => void;
  onSettings: (id: string) => void;
  onTest: (id: string) => void;
  onPublish: (id: string) => void;
  onUnpublish: (id: string) => void;
  onDiscard: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  return (
    <div className="panel table-wrap">
      <table className="tours-table stack-mobile">
        <thead>
          <tr>
            <th>Onboarding</th>
            <th>Situação</th>
            <th>Passos</th>
            <th>Público</th>
            <th>Atualizado</th>
            <th aria-label="Ações" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td data-label="Onboarding">
                <strong>{r.title}</strong>
                <small>
                  {r.author_name}
                  {r.start_page ? ` · começa em ${pageLabel(r.start_page)}` : ""}
                </small>
              </td>
              <td data-label="Situação">
                <span className={`chip ${r.status === "published" ? "done" : ""}`}>
                  {r.status === "published" ? `Publicado (v${r.version})` : "Rascunho"}
                </span>
                {r.has_draft && <small>Alteração não publicada</small>}
              </td>
              <td data-label="Passos">
                {r.step_count}
                {r.misses > 0 && (
                  <small className="tour-miss" title="Vezes em que o elemento de um passo não apareceu para quem recebe">
                    <TriangleAlert size={12} /> {r.misses} não encontrado{r.misses === 1 ? "" : "s"}
                  </small>
                )}
              </td>
              <td data-label="Público">{r.aud_all ? "Todos" : "Escolhido"}</td>
              <td data-label="Atualizado">{shortDate(r.updated_at)}</td>
              <td className="tours-row-actions">
                {r.can_edit ? (
                  confirm === r.id ? (
                    <>
                      <span>Apagar de vez?</span>
                      <button type="button" className="btn danger" onClick={() => (onRemove(r.id), setConfirm(null))}>
                        Apagar
                      </button>
                      <button type="button" className="btn secondary" onClick={() => setConfirm(null)}>
                        Cancelar
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="btn primary" onClick={() => onSteps(r.id)} title="Abre o editor por cima das telas">
                        <Crosshair size={15} /> Montar passos
                      </button>
                      <button type="button" className="icon-btn" aria-label="Configurações" title="Nome, resumo e público" onClick={() => onSettings(r.id)}>
                        <Settings2 size={16} />
                      </button>
                      <button type="button" className="icon-btn" aria-label="Testar" title="Testar" disabled={!r.step_count} onClick={() => onTest(r.id)}>
                        <Play size={16} />
                      </button>
                      {(r.status === "draft" || r.has_draft) && (
                        <button type="button" className="icon-btn" aria-label="Publicar" title={r.status === "draft" ? "Publicar" : "Publicar a alteração"} disabled={!r.step_count} onClick={() => onPublish(r.id)}>
                          <Send size={16} />
                        </button>
                      )}
                      {r.has_draft && (
                        <button type="button" className="icon-btn" aria-label="Descartar alteração" title="Descartar a alteração não publicada" onClick={() => onDiscard(r.id)}>
                          <Undo2 size={16} />
                        </button>
                      )}
                      {r.status === "published" && (
                        <button type="button" className="icon-btn" aria-label="Tirar do ar" title="Tirar do ar" onClick={() => onUnpublish(r.id)}>
                          <EyeOff size={16} />
                        </button>
                      )}
                      <button type="button" className="icon-btn" aria-label="Apagar" title="Apagar" onClick={() => setConfirm(r.id)}>
                        <Trash2 size={16} />
                      </button>
                    </>
                  )
                ) : (
                  <button type="button" className="btn secondary" onClick={() => onTest(r.id)}>
                    <Play size={15} /> Iniciar
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
/** Nome, resumo e público (criar ou alterar). */
function TourSettings({
  api,
  id,
  company,
  data,
  user,
  notify,
  onClose,
  onSaved,
}: {
  api: ToursApi;
  id: string | null;
  company: string;
  data: Snapshot;
  user: string;
  notify: (message: string) => void;
  onClose: () => void;
  onSaved: (id: string, created: boolean) => void;
}) {
  const [content, setContent] = useState<TourContent | null>(id ? null : emptyTour());
  const [meta, setMeta] = useState<{ revision: number; published: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!id) return;
    api
      .detail(id)
      .then((d) => {
        if (!d) throw Error("Onboarding não encontrado.");
        setContent(tourContentOf(d));
        setMeta({ revision: d.revision, published: d.status === "published" });
      })
      .catch((e) => setError((e as Error).message));
  }, [api, id]);
  const submit = async (publish: boolean) => {
    if (!content) return;
    setBusy(true);
    setError("");
    try {
      const r = await api.save(company, id, content, publish, meta?.revision ?? null);
      notify(
        !id
          ? "Onboarding criado."
          : publish
            ? "Onboarding publicado."
            : meta?.published
              ? "Alteração salva. Publique para valer para o time."
              : "Onboarding salvo.",
      );
      onSaved(r.id, !id);
    } catch (e) {
      setError((e as Error).message || "Não foi possível salvar.");
      setBusy(false);
    }
  };
  return (
    <Modal title={id ? "Configurações do onboarding" : "Novo onboarding"} onClose={onClose} busy={busy}>
      {!content ? (
        error ? <p className="form-error">{error}</p> : <Loading variant="list" />
      ) : (
        <form
          className="entity-form tour-settings"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(false);
          }}
        >
          <label>
            Nome
            <input
              value={content.title}
              maxLength={160}
              required
              minLength={3}
              autoFocus
              placeholder="Ex.: Primeiros passos nas Tarefas"
              onChange={(e) => setContent({ ...content, title: e.target.value })}
            />
          </label>
          <label>
            Resumo <small>(opcional)</small>
            <textarea
              value={content.summary}
              maxLength={600}
              rows={2}
              placeholder="O que a pessoa aprende neste tour."
              onChange={(e) => setContent({ ...content, summary: e.target.value })}
            />
          </label>
          <AudiencePicker
            data={data}
            user={user}
            value={audienceOf(content)}
            disabled={busy}
            legend="Quem recebe"
            hint="Os públicos se somam. Quem entrar depois numa equipe escolhida passa a receber na hora."
            onChange={(a) => setContent({ ...content, ...a })}
          />
          <p className="tour-settings-note">
            {audienceSummary(content, data)} · {content.steps.length}{" "}
            {content.steps.length === 1 ? "passo" : "passos"}
          </p>
          {error && <p className="form-error">{error}</p>}
          <div className="form-actions">
            <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>
              Cancelar
            </button>
            {meta?.published && (
              <button type="button" className="btn secondary" disabled={busy} onClick={() => void submit(true)}>
                <Send size={15} /> Salvar e publicar
              </button>
            )}
            <button type="submit" className="btn primary" disabled={busy}>
              {id ? "Salvar" : (
                <>
                  <Crosshair size={15} /> Criar e montar os passos
                </>
              )}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

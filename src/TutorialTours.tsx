import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  CalendarClock,
  CircleCheck,
  Pencil,
  X,
  ThumbsDown,
  ThumbsUp,
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
import { MultiPick } from "./MultiPick";
import { rpc } from "./api";
import { useUrlState } from "./router";
import { VOTE_REASONS, audienceOf } from "./tutorials";
import {
  demoTours,
  editTour,
  emptyTour,
  pageLabel,
  playTour,
  serverTours,
  tourAudienceSummary,
  tourContentOf,
  type TourContent,
  type TourMetrics,
  type TourReach,
  type TourRow,
  type TourSend,
  type TourSendInput,
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
  const [metrics, setMetrics] = useState<TourRow | null>(null);
  const [sends, setSends] = useState<TourRow | null>(null);
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
          onMetrics={(row) => setMetrics(row)}
          onSends={(row) => setSends(row)}
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

      {metrics && <TourMetricsDialog api={api} row={metrics} onClose={() => setMetrics(null)} />}
      {sends && (
        <TourSendsDialog
          api={api}
          row={sends}
          company={company}
          data={data}
          user={user}
          notify={notify}
          onClose={() => setSends(null)}
        />
      )}
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
  onMetrics,
  onSends,
  onTest,
  onPublish,
  onUnpublish,
  onDiscard,
  onRemove,
}: {
  rows: TourRow[];
  onSteps: (id: string) => void;
  onSettings: (id: string) => void;
  onMetrics: (row: TourRow) => void;
  onSends: (row: TourRow) => void;
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
              <td data-label="Público">
                {r.aud_all ? "Todos" : "Escolhido"}
                {r.screen_only && <small>só em algumas telas</small>}
              </td>
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
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label="Envios agendados"
                        title="Envios agendados: mandar em uma data para pessoas, equipes ou squads"
                        disabled={!r.step_count}
                        onClick={() => onSends(r)}
                      >
                        <CalendarClock size={16} />
                      </button>
                      {r.version > 0 && (
                        <button type="button" className="icon-btn" aria-label="Métricas" title="Métricas: onde as pessoas param e o que acharam" onClick={() => onMetrics(r)}>
                          <BarChart3 size={16} />
                        </button>
                      )}
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
  const [squads, setSquads] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let alive = true;
    (rpc("cs_squads", { p_company: company }) as Promise<{ id: string; name: string; archived: boolean }[] | null>)
      .then((list) => alive && setSquads((list ?? []).filter((q) => !q.archived)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [company]);
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
          <ReachPicker
            data={data}
            value={content}
            disabled={busy}
            squads={squads}
            onChange={(patch) => setContent({ ...content, ...patch })}
          />
          <fieldset className="notice-block tour-reach">
            <legend>Começa sozinho</legend>
            <small>Uma vez só para cada pessoa. Pelo “?” e pela aba Onboarding ele está sempre disponível.</small>
            <label className="tour-reach-option">
              <input
                type="checkbox"
                checked={content.trg_visit}
                disabled={busy}
                onChange={(e) => setContent({ ...content, trg_visit: e.target.checked })}
              />
              Na primeira vez que a pessoa abre a tela onde ele começa
            </label>
            <label className="tour-reach-option">
              <input
                type="checkbox"
                checked={content.trg_login}
                disabled={busy}
                onChange={(e) => setContent({ ...content, trg_login: e.target.checked })}
              />
              Logo que a pessoa entra no sistema (bom para quem acabou de chegar)
            </label>
          </fieldset>
          <p className="tour-settings-note">
            {tourAudienceSummary(content, data, squads)} · {content.steps.length}{" "}
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

/**
 * Mais público (squads e quem atende clientes ou produtos) e onde o
 * onboarding aparece (qualquer tela, ou só nas telas de clientes/produtos).
 */
function ReachPicker({
  data,
  value,
  disabled,
  squads,
  onChange,
}: {
  data: Snapshot;
  value: TourContent;
  disabled: boolean;
  squads: { id: string; name: string }[];
  onChange: (patch: Partial<TourReach>) => void;
}) {
  const clients = data.clients
    .filter((c) => !c.archived || value.aud_clients.includes(c.id) || value.scr_clients.includes(c.id))
    .map((c) => ({ value: c.id, label: c.name }))
    .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
  const products = data.products
    .map((p) => ({ value: p.id, label: p.name }))
    .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
  const screenOnly = value.scr_clients.length + value.scr_products.length > 0;
  const [restrict, setRestrict] = useState(screenOnly);
  return (
    <>
      {!value.aud_all && (
        <fieldset className="notice-block tour-reach">
          <legend>Também recebem</legend>
          <small>Somados ao público acima. Quem entra depois numa equipe ou squad passa a receber na hora.</small>
          <div className="tour-reach-grid">
            {squads.length > 0 && (
              <div className="tour-reach-pick">
                <span>Squads</span>
                <MultiPick
                  label="Squads"
                  allLabel="Nenhum squad"
                  noun="squads"
                  options={squads.map((q) => ({ value: q.id, label: q.name }))}
                  value={value.aud_squads}
                  onChange={(v) => onChange({ aud_squads: v })}
                  disabled={disabled}
                />
              </div>
            )}
            <div className="tour-reach-pick">
              <span>Quem atende os clientes</span>
              <MultiPick
                label="Clientes"
                allLabel="Nenhum cliente"
                noun="clientes"
                options={clients}
                value={value.aud_clients}
                onChange={(v) => onChange({ aud_clients: v })}
                disabled={disabled}
              />
            </div>
            <div className="tour-reach-pick">
              <span>Quem atende os produtos</span>
              <MultiPick
                label="Produtos"
                allLabel="Nenhum produto"
                noun="produtos"
                options={products}
                value={value.aud_products}
                onChange={(v) => onChange({ aud_products: v })}
                disabled={disabled}
              />
            </div>
          </div>
        </fieldset>
      )}
      <fieldset className="notice-block tour-reach">
        <legend>Onde aparece</legend>
        <label className="tour-reach-option">
          <input
            type="radio"
            name="tour-where"
            checked={!restrict}
            disabled={disabled}
            onChange={() => {
              setRestrict(false);
              onChange({ scr_clients: [], scr_products: [] });
            }}
          />
          Em qualquer tela
        </label>
        <label className="tour-reach-option">
          <input type="radio" name="tour-where" checked={restrict} disabled={disabled} onChange={() => setRestrict(true)} />
          Só nas telas de certos clientes ou produtos
        </label>
        {restrict && (
          <>
            <small>
              No “?” e nos disparos automáticos, ele só aparece quando a tela é de um deles (a campanha, a tarefa, o
              filtro de cliente…). Na aba Onboarding aparece sempre.
            </small>
            <div className="tour-reach-grid">
              <div className="tour-reach-pick">
                <span>Clientes</span>
                <MultiPick
                  label="Clientes"
                  allLabel="Nenhum cliente"
                  noun="clientes"
                  options={clients}
                  value={value.scr_clients}
                  onChange={(v) => onChange({ scr_clients: v })}
                  disabled={disabled}
                />
              </div>
              <div className="tour-reach-pick">
                <span>Produtos</span>
                <MultiPick
                  label="Produtos"
                  allLabel="Nenhum produto"
                  noun="produtos"
                  options={products}
                  value={value.scr_products}
                  onChange={(v) => onChange({ scr_products: v })}
                  disabled={disabled}
                />
              </div>
            </div>
          </>
        )}
      </fieldset>
    </>
  );
}

const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);
const REASON = Object.fromEntries(VOTE_REASONS.map((r) => [r.id, r.label]));

/**
 * Métricas de um onboarding (quem edita), por versão: quantas pessoas
 * começaram, concluíram e pararam; o funil por passo (quantas chegaram a
 * cada um, quantas pararam ali e quantas vezes o elemento não apareceu) e o
 * "Isso ajudou?".
 */
function TourMetricsDialog({ api, row, onClose }: { api: ToursApi; row: TourRow; onClose: () => void }) {
  const [version, setVersion] = useState<number | null>(null);
  const [m, setM] = useState<TourMetrics | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setM(null);
    api
      .metrics(row.id, version)
      .then((x) => {
        if (!alive) return;
        if (!x) throw Error("Sem métricas para esta versão.");
        setM(x);
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [api, row.id, version]);
  // O passo onde mais gente parou (o destaque do funil).
  const worst = m?.steps.reduce<TourMetrics["steps"][number] | null>(
    (w, s) => (s.stopped > 0 && (!w || s.stopped > w.stopped) ? s : w),
    null,
  );
  return (
    <Modal title={`Métricas: ${row.title}`} onClose={onClose} wide={false} className="tour-metrics-modal">
      <div className="tour-metrics">
        {error ? (
          <p className="form-error">{error}</p>
        ) : !m ? (
          <Loading variant="list" />
        ) : (
          <>
            {m.versions.length > 1 && (
              <label className="tour-metrics-version">
                Versão
                <select value={m.version} onChange={(e) => setVersion(Number(e.target.value))}>
                  {m.versions.map((v) => (
                    <option key={v} value={v}>
                      {v === m.versions[0] ? `v${v} (no ar)` : `v${v}`}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="tour-tiles">
              <div>
                <strong>{m.started}</strong>
                <span>começaram</span>
              </div>
              <div>
                <strong>{m.completed}</strong>
                <span>concluíram{m.started ? ` · ${pct(m.completed, m.started)}%` : ""}</span>
              </div>
              <div>
                <strong>{m.dismissed}</strong>
                <span>pararam no meio</span>
              </div>
              <div>
                <strong>{m.in_progress}</strong>
                <span>em andamento</span>
              </div>
              <div>
                <strong>
                  <ThumbsUp size={15} /> {m.up} <ThumbsDown size={15} /> {m.down}
                </strong>
                <span>isso ajudou?</span>
              </div>
            </div>

            <h3>Onde as pessoas chegam</h3>
            {!m.started ? (
              <p className="tour-empty">Ninguém fez esta versão ainda.</p>
            ) : (
              <>
                {worst && (
                  <p className="tour-metrics-note">
                    <TriangleAlert size={14} /> Mais gente parou no passo {worst.n}
                    {worst.title ? ` (${worst.title})` : ""}: {worst.stopped}{" "}
                    {worst.stopped === 1 ? "pessoa" : "pessoas"}.
                  </p>
                )}
                <ol className="tour-funnel" aria-label="Pessoas que chegaram a cada passo">
                  {m.steps.map((s) => {
                    const share = pct(s.reached, m.started);
                    const detail = `Passo ${s.n}: ${s.reached} de ${m.started} pessoas chegaram (${share}%)${
                      s.stopped ? `, ${s.stopped} pararam aqui` : ""
                    }${s.misses ? `, elemento não encontrado ${s.misses}×` : ""}`;
                    return (
                      <li key={s.step_id} title={detail}>
                        <span className="tour-funnel-label">
                          <b>{s.n}</b> {s.title || "Sem título"}
                        </span>
                        <span className="tour-funnel-bar" aria-hidden="true">
                          <span style={{ width: `${Math.max(share, s.reached ? 2 : 0)}%` }} />
                        </span>
                        <span className="tour-funnel-value">
                          {s.reached} · {share}%
                        </span>
                        {(s.stopped > 0 || s.misses > 0) && (
                          <span className="tour-funnel-flags">
                            {s.stopped > 0 && <em>parou aqui: {s.stopped}</em>}
                            {s.misses > 0 && <em className="miss">não encontrado: {s.misses}×</em>}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </>
            )}

            <h3>O que disseram</h3>
            {!m.feedback.length ? (
              <p className="tour-empty">Nenhum comentário ou 👎 nesta versão.</p>
            ) : (
              <ul className="tour-feedback-list">
                {m.feedback.map((f, i) => (
                  <li key={i}>
                    <span className={`chip ${f.vote === "up" ? "done" : ""}`}>
                      {f.vote === "up" ? <ThumbsUp size={12} /> : <ThumbsDown size={12} />}
                      {f.reason ? ` ${REASON[f.reason] ?? f.reason}` : ""}
                    </span>
                    {f.comment && <p>{f.comment}</p>}
                    <small>
                      {f.name} · {shortDate(f.at)}
                    </small>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ envios agendados

const pad2 = (n: number) => String(n).padStart(2, "0");
/** "AAAA-MM-DDTHH:mm" no fuso do navegador (o campo datetime-local). */
const localInput = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const when = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  });
const emptySend = (): TourSendInput => {
  const at = new Date(Date.now() + 60 * 60_000);
  at.setMinutes(0, 0, 0);
  return {
    starts_at: at.toISOString(),
    aud_all: false,
    aud_roles: [],
    aud_teams: [],
    aud_squads: [],
    aud_users: [],
    aud_exclude: [],
    repeat_done: false,
    notify_inbox: true,
    notify_push: true,
  };
};
const SEND_STATUS: Record<TourSend["status"], string> = {
  scheduled: "Agendado",
  sent: "Enviado",
  canceled: "Cancelado",
};

/**
 * Envios agendados de um onboarding: em uma data e hora, para pessoas,
 * equipes, squads ou papéis (ex.: uma funcionalidade nova, no dia do
 * lançamento). Na hora, ele começa sozinho para quem recebe — na hora se a
 * pessoa estiver no sistema, senão na próxima vez — com aviso na caixa de
 * entrada e/ou notificação do navegador, como quem cria escolher.
 */
function TourSendsDialog({
  api,
  row,
  company,
  data,
  user,
  notify,
  onClose,
}: {
  api: ToursApi;
  row: TourRow;
  company: string;
  data: Snapshot;
  user: string;
  notify: (message: string) => void;
  onClose: () => void;
}) {
  const [list, setList] = useState<TourSend[] | null>(null);
  const [form, setForm] = useState<{ id: string | null; input: TourSendInput } | null>(null);
  const [squads, setSquads] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    api
      .sends(row.id)
      .then(setList)
      .catch((e) => setError((e as Error).message));
  }, [api, row.id]);
  useEffect(load, [load]);
  useEffect(() => {
    let alive = true;
    (rpc("cs_squads", { p_company: company }) as Promise<{ id: string; name: string; archived: boolean }[] | null>)
      .then((l) => alive && setSquads((l ?? []).filter((q) => !q.archived)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [company]);

  const summary = (s: TourSendInput) =>
    tourAudienceSummary(
      {
        ...emptyTour(),
        aud_all: s.aud_all,
        aud_roles: s.aud_roles,
        aud_teams: s.aud_teams,
        aud_users: s.aud_users,
        aud_exclude: s.aud_exclude,
        aud_squads: s.aud_squads,
      },
      data,
      squads,
    );
  const save = async () => {
    if (!form) return;
    setBusy(true);
    setError("");
    try {
      const r = await api.saveSend(row.id, form.id, form.input);
      notify(
        r.status === "sent"
          ? r.people
            ? `Enviado para ${r.people === 1 ? "1 pessoa" : `${r.people} pessoas`}. O onboarding já começa para quem está no sistema.`
            : "Enviado, mas ninguém do público precisava receber (todos já tinham feito)."
          : r.waiting
            ? "Envio salvo. Ele sai assim que o onboarding for publicado."
            : `Envio agendado para ${when(form.input.starts_at)}.`,
      );
      setForm(null);
      load();
    } catch (e) {
      setError((e as Error).message || "Não foi possível salvar o envio.");
    } finally {
      setBusy(false);
    }
  };
  const cancel = async (id: string) => {
    try {
      await api.cancelSend(id);
      notify("Envio cancelado.");
      load();
    } catch (e) {
      notify((e as Error).message || "Não foi possível cancelar.");
    }
  };
  const set = (patch: Partial<TourSendInput>) => setForm((f) => f && { ...f, input: { ...f.input, ...patch } });
  const now = form ? new Date(form.input.starts_at).getTime() <= Date.now() + 30_000 : false;

  return (
    <Modal title={`Envios: ${row.title}`} onClose={onClose} busy={busy} className="tour-sends-modal">
      <div className="tour-sends">
        {row.status !== "published" && (
          <p className="tour-metrics-note">
            <TriangleAlert size={14} /> O onboarding ainda é rascunho: os envios saem quando ele for publicado.
          </p>
        )}
        {form ? (
          <form
            className="entity-form tour-send-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label>
              Data e hora
              <input
                type="datetime-local"
                required
                value={localInput(new Date(form.input.starts_at))}
                onChange={(e) => e.target.value && set({ starts_at: new Date(e.target.value).toISOString() })}
              />
            </label>
            <div className="tour-send-quick">
              <button type="button" className="text-btn" onClick={() => set({ starts_at: new Date().toISOString() })}>
                Agora
              </button>
            </div>
            <AudiencePicker
              data={data}
              user={user}
              value={form.input}
              disabled={busy}
              legend="Para quem"
              allLabel="Todos da agência"
              hint="Os públicos se somam. O envio dá acesso ao onboarding, mesmo para quem está fora do público dele."
              estimate="sem contar os squads"
              onChange={(a) => set(a)}
            />
            {!form.input.aud_all && squads.length > 0 && (
              <div className="tour-reach-pick">
                <span>Squads</span>
                <MultiPick
                  label="Squads"
                  allLabel="Nenhum squad"
                  noun="squads"
                  options={squads.map((q) => ({ value: q.id, label: q.name }))}
                  value={form.input.aud_squads}
                  onChange={(v) => set({ aud_squads: v })}
                  disabled={busy}
                />
              </div>
            )}
            <fieldset className="notice-block tour-reach">
              <legend>Quem já fez este onboarding</legend>
              <label className="tour-reach-option">
                <input type="radio" name="tour-send-repeat" checked={!form.input.repeat_done} onChange={() => set({ repeat_done: false })} />
                Não recebe de novo
              </label>
              <label className="tour-reach-option">
                <input type="radio" name="tour-send-repeat" checked={form.input.repeat_done} onChange={() => set({ repeat_done: true })} />
                Recebe de novo (bom para uma versão nova)
              </label>
            </fieldset>
            <fieldset className="notice-block tour-reach">
              <legend>Avisar a pessoa</legend>
              <small>O onboarding começa sozinho de qualquer jeito: na hora, se a pessoa estiver no sistema, ou na próxima vez que entrar.</small>
              <label className="tour-reach-option">
                <input type="checkbox" checked={form.input.notify_inbox} onChange={(e) => set({ notify_inbox: e.target.checked })} />
                Caixa de entrada (com o botão para fazer o onboarding)
              </label>
              <label className="tour-reach-option">
                <input type="checkbox" checked={form.input.notify_push} onChange={(e) => set({ notify_push: e.target.checked })} />
                Notificação do navegador (para quem ativou)
              </label>
            </fieldset>
            <p className="tour-settings-note">Para: {summary(form.input)}</p>
            {error && <p className="form-error">{error}</p>}
            <div className="form-actions">
              <button type="button" className="btn secondary" onClick={() => setForm(null)} disabled={busy}>
                Voltar
              </button>
              <button type="submit" className="btn primary" disabled={busy}>
                <Send size={15} /> {now ? "Enviar agora" : form.id ? "Salvar envio" : "Agendar envio"}
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="tour-sends-head">
              <p>Mande este onboarding em uma data para pessoas, equipes, squads ou papéis.</p>
              <Button className="btn primary" onClick={() => setForm({ id: null, input: emptySend() })} disabled={!row.step_count}>
                <Plus size={16} /> Novo envio
              </Button>
            </div>
            {error && <p className="form-error">{error}</p>}
            {list === null ? (
              <Loading variant="list" />
            ) : !list.length ? (
              <p className="tour-empty">Nenhum envio ainda.</p>
            ) : (
              <ul className="tour-send-list">
                {list.map((x) => (
                  <li key={x.id} className={x.status}>
                    <div>
                      <strong>
                        <CalendarClock size={14} /> {when(x.starts_at)}
                      </strong>
                      <span className={`chip ${x.status === "sent" ? "done" : x.status === "scheduled" ? "new" : ""}`}>
                        {SEND_STATUS[x.status]}
                      </span>
                    </div>
                    <small>
                      Para: {summary(x)}
                      {x.repeat_done ? " · também quem já fez" : ""}
                      {" · "}
                      {[x.notify_inbox && "caixa de entrada", x.notify_push && "notificação"].filter(Boolean).join(" e ") ||
                        "sem aviso"}
                    </small>
                    {x.status === "sent" && (
                      <small>
                        {x.people === 1 ? "1 pessoa recebeu" : `${x.people} pessoas receberam`} · {x.started}{" "}
                        {x.started === 1 ? "começou" : "começaram"} · {x.completed}{" "}
                        {x.completed === 1 ? "concluiu" : "concluíram"}
                      </small>
                    )}
                    {x.status === "scheduled" && (
                      <span className="tour-send-tools">
                        <button type="button" className="text-btn" onClick={() => setForm({ id: x.id, input: { ...x } })}>
                          <Pencil size={13} /> Editar
                        </button>
                        <button type="button" className="text-btn danger" onClick={() => void cancel(x.id)}>
                          <X size={13} /> Cancelar envio
                        </button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  CircleCheck,
  Film,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Users,
} from "lucide-react";
import { Empty } from "./components";
import { Button, Loading } from "./ui";
import {
  PERSON_STATE,
  dueLabel,
  itemStates,
  percent,
  requiredSummary,
  type ItemState,
  type PersonState,
  type TrailDetail,
  type TrailItem,
  type TrailPerson,
  type TrailRow,
  type TrailsApi,
} from "./tutorial-trails";
import { audienceSummary, moduleLabel } from "./tutorials";
import type { Snapshot } from "./types";

const shortDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "short",
        timeZone: "America/Sao_Paulo",
      })
    : "";

/** A barra de progresso com "2 de 5". */
export function TrailProgress({
  done,
  total,
  small,
}: {
  done: number;
  total: number;
  small?: boolean;
}) {
  const p = percent(done, total);
  return (
    <span className={`trail-progress ${small ? "small" : ""} ${total > 0 && done === total ? "complete" : ""}`}>
      <span
        className="trail-progress-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-label={`${done} de ${total} tutoriais concluídos`}
      >
        <span style={{ width: `${p}%` }} />
      </span>
      <span className="trail-progress-text">
        {total === 0 ? "Sem tutoriais para você" : `${done} de ${total}`}
      </span>
    </span>
  );
}

function Due({ due, done }: { due: string | null; done: boolean }) {
  const label = done ? null : dueLabel(due);
  if (!label) return null;
  return (
    <span className={`trail-due ${label.late ? "late" : ""}`} title={`Prazo: ${shortDate(due)}`}>
      <CalendarClock size={13} /> {label.text}
    </span>
  );
}

function TrailCard({ row, onOpen }: { row: TrailRow; onOpen: () => void }) {
  const complete = row.total > 0 && row.done === row.total;
  return (
    <button type="button" className={`tutorial-card trail-card ${row.required_for_me && !complete ? "required" : ""}`} onClick={onOpen}>
      <span className="tutorial-card-top">
        <Route size={18} aria-hidden="true" />
        {row.required_for_me ? (
          <span className="trail-badge required">Obrigatória</span>
        ) : row.status === "draft" ? (
          <span className="tutorial-status draft">Rascunho</span>
        ) : null}
        {row.sequential && <span className="trail-badge">Em sequência</span>}
      </span>
      <strong className="tutorial-card-title">{row.title}</strong>
      {row.summary && <span className="tutorial-card-summary">{row.summary}</span>}
      {(row.for_me || row.can_edit) && row.status === "published" && (
        <TrailProgress done={row.done} total={row.total} small />
      )}
      <span className="tutorial-card-foot">
        {row.required_for_me && <Due due={row.due_at} done={complete} />}
        {complete && row.for_me && (
          <span className="trail-done">
            <CircleCheck size={13} /> Concluída
          </span>
        )}
        {row.people != null && (
          <span className="trail-team" title="Progresso do time">
            <Users size={13} /> {row.people_done} de {row.people} concluíram
            {row.people_overdue ? <b> · {row.people_overdue} atrasada{row.people_overdue > 1 ? "s" : ""}</b> : null}
          </span>
        )}
      </span>
    </button>
  );
}

/** As trilhas obrigatórias pendentes, no topo da biblioteca. */
export function RequiredTrails({
  rows,
  onOpen,
}: {
  rows: TrailRow[];
  onOpen: (id: string) => void;
}) {
  const pending = rows.filter((r) => r.required_for_me && !(r.total > 0 && r.done === r.total));
  if (!pending.length) return null;
  return (
    <section className="trail-required" aria-label="Trilhas obrigatórias para você">
      <span className="trail-required-title">
        <Route size={16} /> {pending.length === 1 ? "Uma trilha obrigatória para você" : `${pending.length} trilhas obrigatórias para você`}
      </span>
      <div className="trail-required-list">
        {pending.map((r) => (
          <button type="button" key={r.id} className="trail-required-item" onClick={() => onOpen(r.id)}>
            <strong>{r.title}</strong>
            <TrailProgress done={r.done} total={r.total} small />
            <Due due={r.due_at} done={false} />
          </button>
        ))}
      </div>
    </section>
  );
}

/** A aba Trilhas: obrigatórias, as do público da pessoa e, para líderes, as outras e os rascunhos. */
export function TrailsTab({
  api,
  company,
  isLeader,
  tick,
  onOpen,
  onNew,
}: {
  api: TrailsApi;
  company: string;
  isLeader: boolean;
  tick: number;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const [rows, setRows] = useState<TrailRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    api
      .list(company)
      .then((r) => alive && setRows(r))
      .catch((e) => alive && setError((e as Error).message || "Não foi possível carregar as trilhas."));
    return () => {
      alive = false;
    };
  }, [api, company, tick]);

  if (error) return <p className="form-error">{error}</p>;
  if (!rows) return <Loading variant="grid" />;
  const required = rows.filter((r) => r.required_for_me);
  const mine = rows.filter((r) => r.for_me && !r.required_for_me);
  const others = rows.filter((r) => r.status === "published" && !r.for_me);
  const drafts = rows.filter((r) => r.status === "draft");
  const section = (title: string, list: TrailRow[], hint?: string): ReactNode =>
    list.length ? (
      <section className="trail-section">
        <h2>{title}</h2>
        {hint && <p className="trail-section-hint">{hint}</p>}
        <div className="tutorials-grid">
          {list.map((r) => (
            <TrailCard key={r.id} row={r} onOpen={() => onOpen(r.id)} />
          ))}
        </div>
      </section>
    ) : null;
  return (
    <div className="trails-tab">
      {isLeader && (
        <div className="trail-tab-head">
          <p>Trilhas juntam tutoriais numa ordem, com o progresso de cada pessoa. Podem ser obrigatórias, com prazo.</p>
          <Button className="btn primary" type="button" onClick={onNew}>
            <Plus size={16} /> Nova trilha
          </Button>
        </div>
      )}
      {!rows.length ? (
        <div className="panel">
          {isLeader ? (
            <Empty
              title="Ainda não há trilhas"
              body="Monte a primeira: escolha os tutoriais na ordem certa e diga se é obrigatória (por exemplo, para quem entrar na agência)."
              action={
                <Button className="btn primary" type="button" onClick={onNew}>
                  <Plus size={16} /> Nova trilha
                </Button>
              }
            />
          ) : (
            <Empty
              title="Nenhuma trilha para você"
              body="Quando os líderes montarem trilhas de tutoriais para você, elas aparecem aqui."
            />
          )}
        </div>
      ) : (
        <>
          {section("Obrigatórias para você", required)}
          {section(required.length ? "Outras trilhas para você" : "Trilhas para você", mine)}
          {isLeader &&
            section("Outras trilhas da agência", others, "Fora do seu público: você acompanha o progresso de quem tem.")}
          {section("Rascunhos", drafts, "Só quem edita vê até publicar.")}
        </>
      )}
    </div>
  );
}

const STATE_LABEL: Record<ItemState, string> = {
  done: "Concluído",
  updated: "Atualizado depois que você concluiu",
  next: "Próximo",
  open: "",
  locked: "Conclua o anterior para liberar",
  hidden: "",
};

/** Uma trilha: os tutoriais na ordem e, para os líderes, o progresso das pessoas. */
export function TrailView({
  api,
  id,
  data,
  isLeader,
  tick,
  onBack,
  onOpenTutorial,
  onEdit,
}: {
  api: TrailsApi;
  id: string;
  data: Snapshot;
  isLeader: boolean;
  tick: number;
  onBack: () => void;
  onOpenTutorial: (tutorial: string) => void;
  onEdit: (detail: TrailDetail) => void;
}) {
  const [detail, setDetail] = useState<TrailDetail | null | undefined>();
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"steps" | "people">("steps");
  useEffect(() => {
    let alive = true;
    api
      .detail(id)
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [api, id, tick]);

  if (error)
    return (
      <div className="trail-view">
        <Back onBack={onBack} />
        <p className="form-error">{error}</p>
      </div>
    );
  if (detail === undefined) return <Loading variant="page" />;
  if (detail === null)
    return (
      <div className="trail-view">
        <Back onBack={onBack} />
        <div className="panel">
          <Empty title="Trilha indisponível" body="Ela pode ter saído do ar, sido apagada ou não ser para você." />
        </div>
      </div>
    );

  const states = itemStates(detail, detail.items);
  const complete = detail.total > 0 && detail.done === detail.total;
  const nextAt = states.indexOf("next");
  const next = nextAt >= 0 ? detail.items[nextAt] : null;
  const started = detail.done > 0;
  const c = detail.config;
  return (
    <div className="trail-view">
      <Back onBack={onBack} />
      {detail.status === "draft" && (
        <p className="tutorial-banner" role="status">
          Rascunho: só quem edita vê esta trilha. Publique para ela chegar às pessoas.
        </p>
      )}
      <header className="trail-head">
        <span className="tutorial-card-top">
          <Route size={18} aria-hidden="true" />
          {detail.required_for_me && <span className="trail-badge required">Obrigatória para você</span>}
          <span className="trail-badge">{detail.sequential ? "Em sequência" : "Ordem livre"}</span>
        </span>
        <h1>{detail.title}</h1>
        {detail.summary && <p className="tutorial-lead">{detail.summary}</p>}
        <div className="tutorial-meta">
          <span>
            {detail.items.length === 1 ? "1 tutorial" : `${detail.items.length} tutoriais`}
          </span>
          <span>
            por <span data-person={detail.created_by}>{detail.author_name}</span>
          </span>
          {c && (
            <span>
              <Users size={14} /> Quem vê: {audienceSummary(c, data)}
            </span>
          )}
          {c && detail.required && (
            <span>
              Obrigatória para: {requiredSummary(c, data)}
              {detail.due_days ? ` · prazo de ${detail.due_days} dia${detail.due_days > 1 ? "s" : ""}` : ""}
            </span>
          )}
        </div>
        {(detail.for_me || detail.required_for_me) && detail.status === "published" && (
          <div className="trail-me">
            <TrailProgress done={detail.done} total={detail.total} />
            {detail.required_for_me && <Due due={detail.due_at} done={complete} />}
            {complete ? (
              <span className="trail-done">
                <CircleCheck size={15} /> Você concluiu esta trilha
              </span>
            ) : next ? (
              <Button className="btn primary" type="button" onClick={() => onOpenTutorial(next.tutorial_id)}>
                {started ? "Continuar" : "Começar"}: {next.title} <ArrowRight size={15} />
              </Button>
            ) : null}
          </div>
        )}
        {detail.can_edit && (
          <div className="tutorial-head-actions">
            <Button className="btn secondary" type="button" onClick={() => onEdit(detail)}>
              <Pencil size={15} /> Editar trilha
            </Button>
          </div>
        )}
      </header>

      {isLeader && detail.status === "published" && (
        <nav className="cases-tabs" aria-label="Trilha">
          <button type="button" className={tab === "steps" ? "active" : ""} onClick={() => setTab("steps")}>
            <Route size={16} /> Tutoriais
          </button>
          <button type="button" className={tab === "people" ? "active" : ""} onClick={() => setTab("people")}>
            <Users size={16} /> Progresso das pessoas
          </button>
        </nav>
      )}

      {tab === "people" && isLeader ? (
        <TrailPeople api={api} trail={detail} tick={tick} />
      ) : (
        <ol className="trail-steps">
          {detail.items.map((item, i) => (
            <TrailStep
              key={item.tutorial_id}
              n={i + 1}
              item={item}
              state={states[i]}
              canEdit={detail.can_edit}
              onOpen={() => onOpenTutorial(item.tutorial_id)}
            />
          ))}
          {!detail.items.length && (
            <li className="trail-steps-empty">Nenhum tutorial nesta trilha ainda.</li>
          )}
        </ol>
      )}
    </div>
  );
}

function TrailStep({
  n,
  item,
  state,
  canEdit,
  onOpen,
}: {
  n: number;
  item: TrailItem;
  state: ItemState;
  canEdit: boolean;
  onOpen: () => void;
}) {
  // Quem edita abre tudo (também o que está travado ou fora do seu público).
  const disabled = (state === "locked" || state === "hidden") && !canEdit;
  const note =
    state === "hidden"
      ? item.status === "draft"
        ? "Rascunho: ninguém vê até publicar"
        : "Fora do seu público: só conta para quem vê o tutorial"
      : STATE_LABEL[state];
  return (
    <li className={`trail-step ${state}`}>
      <button type="button" onClick={onOpen} disabled={disabled}>
        <span className="trail-step-mark" aria-hidden="true">
          {state === "done" ? (
            <CircleCheck size={20} />
          ) : state === "updated" ? (
            <RefreshCw size={18} />
          ) : state === "locked" ? (
            <Lock size={16} />
          ) : (
            n
          )}
        </span>
        <span className="trail-step-text">
          <strong>{item.title}</strong>
          {item.summary && <small>{item.summary}</small>}
          <span className="trail-step-meta">
            {note && <em>{note}</em>}
            {item.modules.slice(0, 2).map((m) => (
              <span key={m} className="tutorial-module">
                {moduleLabel(m)}
              </span>
            ))}
            {item.video_count > 0 && (
              <span title="Vídeos">
                <Film size={12} /> {item.video_count}
              </span>
            )}
          </span>
        </span>
        {!disabled && <ArrowRight size={16} className="trail-step-go" aria-hidden="true" />}
      </button>
    </li>
  );
}

const FILTERS: { id: PersonState | ""; label: string }[] = [
  { id: "", label: "Todos" },
  { id: "overdue", label: "Atrasadas" },
  { id: "todo", label: "Não começaram" },
  { id: "progress", label: "Em andamento" },
  { id: "done", label: "Concluídas" },
];

/** O progresso de quem tem a trilha (líderes). */
function TrailPeople({ api, trail, tick }: { api: TrailsApi; trail: TrailDetail; tick: number }) {
  const [people, setPeople] = useState<TrailPerson[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<PersonState | "">("");
  useEffect(() => {
    let alive = true;
    api
      .people(trail.id)
      .then((p) => alive && setPeople(p))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [api, trail.id, tick]);
  const counts = useMemo(() => {
    const out: Record<string, number> = { "": people?.length ?? 0 };
    for (const p of people ?? []) out[p.state] = (out[p.state] ?? 0) + 1;
    return out;
  }, [people]);
  const titles = new Map(trail.items.map((i) => [i.tutorial_id, i.title]));
  const published = trail.items.filter((i) => i.status === "published");

  if (error) return <p className="form-error">{error}</p>;
  if (!people) return <Loading variant="list" />;
  if (!people.length)
    return (
      <div className="panel">
        <Empty title="Ninguém tem esta trilha ainda" body="Quem estiver no público ou for obrigado aparece aqui." />
      </div>
    );
  const shown = people.filter((p) => !filter || p.state === filter);
  return (
    <div className="trail-people">
      <div className="cases-niche-row" role="group" aria-label="Filtrar pessoas">
        {FILTERS.filter((f) => !f.id || counts[f.id]).map((f) => (
          <button
            type="button"
            key={f.id || "all"}
            className={`chip ${filter === f.id ? "selected" : ""}`}
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
            <small>{counts[f.id] ?? 0}</small>
          </button>
        ))}
      </div>
      <div className="panel tutorials-admin">
        <table className="stack-mobile">
          <thead>
            <tr>
              <th>Pessoa</th>
              <th>Situação</th>
              <th>Progresso</th>
              <th>Prazo</th>
              <th>Falta</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => {
              const missing = published.find((i) => !p.done_ids.includes(i.tutorial_id));
              return (
                <tr key={p.user_id}>
                  <td data-label="Pessoa">
                    <span data-person={p.user_id}>{p.name}</span>
                    {p.required && <small className="trail-person-req"> · obrigatória</small>}
                  </td>
                  <td data-label="Situação">
                    <span className={`trail-state ${p.state}`}>{PERSON_STATE[p.state]}</span>
                  </td>
                  <td data-label="Progresso">
                    <TrailProgress done={p.done} total={p.total} small />
                  </td>
                  <td data-label="Prazo">
                    {p.state === "done"
                      ? p.last_done_at
                        ? `Concluída em ${shortDate(p.last_done_at)}`
                        : "—"
                      : p.due_at
                        ? shortDate(p.due_at)
                        : p.required
                          ? "Sem prazo"
                          : "Opcional"}
                  </td>
                  <td data-label="Falta">
                    {p.state === "done" ? "—" : missing ? titles.get(missing.tutorial_id) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * A faixa da trilha num tutorial aberto por ela: em qual trilha, a posição
 * e o caminho de volta.
 */
export function TrailBar({
  trail,
  tutorial,
  onOpenTrail,
}: {
  trail: TrailDetail;
  tutorial: string;
  onOpenTrail: () => void;
}) {
  const visible = trail.items.filter((i) => i.visible);
  const at = visible.findIndex((i) => i.tutorial_id === tutorial);
  return (
    <div className="trail-bar">
      <Route size={16} aria-hidden="true" />
      <button type="button" className="link-btn" onClick={onOpenTrail}>
        Trilha: {trail.title}
      </button>
      {at >= 0 && (
        <span className="trail-bar-pos">
          {at + 1} de {visible.length}
        </span>
      )}
      <TrailProgress done={trail.done} total={trail.total} small />
    </div>
  );
}

function Back({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" className="text-btn tutorial-back" onClick={onBack}>
      <ArrowLeft size={15} /> Todas as trilhas
    </button>
  );
}

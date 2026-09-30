import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { CalendarClock, Download, FileText, Pencil, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { Button, Checkbox, Input, Loading, Select, SelectOption } from "./ui";
import { Empty, Modal } from "./components";
import type { Snapshot } from "./types";
import {
  WEEKDAYS,
  campaignCells,
  dateBr,
  deleteReport,
  deleteSchedule,
  labelsLine,
  loadReport,
  loadReports,
  loadSchedules,
  requestReport,
  retryReport,
  saveSchedule,
  scheduleLabel,
  type RadarReport,
  type RadarReportFull,
  type ReportFilters,
  type ReportSchedule,
  type TopicCounts,
} from "./radar";

const PRIORITY_COLORS: Record<string, string> = { alta: "#e34948", média: "#eda100", baixa: "#7fb2ea" };
const SEVERITY = ["Baixa", "Média", "Alta", "Crítica"];
const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
const addDays = (key: string, n: number) => {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const STATUS: Record<RadarReport["status"], string> = {
  pending: "Na fila da MAVI",
  running: "A MAVI está escrevendo…",
  done: "Pronto",
  failed: "Não deu certo",
};

/**
 * Radar › Relatórios: os relatórios da MAVI (pedidos agora ou agendados),
 * com os números do banco e o texto da MAVI, em PDF. A lista se atualiza
 * pelo Realtime (evento "mavi:radar"), sem consultar de tempos em tempos.
 */
export function RadarReports({
  company,
  data,
  topics,
  notify,
  openReport,
  onOpened,
}: {
  company: string;
  data: Snapshot;
  topics: TopicCounts[];
  notify: (message: string) => void;
  /** Abre este relatório (o link do aviso). */
  openReport?: string | null;
  onOpened?: () => void;
}) {
  const [reports, setReports] = useState<RadarReport[] | null>(null);
  const [schedules, setSchedules] = useState<ReportSchedule[] | null>(null);
  const [error, setError] = useState("");
  const [asking, setAsking] = useState(false);
  const [editing, setEditing] = useState<ReportSchedule | null>(null);
  const [open, setOpen] = useState<string | null>(openReport ?? null);

  const load = useCallback(() => {
    loadReports(company)
      .then((r) => setReports(r.reports))
      .catch((e) => setError((e as Error).message));
  }, [company]);
  useEffect(() => {
    load();
    loadSchedules(company)
      .then(setSchedules)
      .catch((e) => setError((e as Error).message));
  }, [company, load]);
  useEffect(() => {
    if (openReport) setOpen(openReport);
  }, [openReport]);
  // Pronto, na fila ou falhou: o Realtime avisa (e a demonstração também).
  useEffect(() => {
    const on = () => load();
    window.addEventListener("mavi:radar", on);
    return () => window.removeEventListener("mavi:radar", on);
  }, [load]);

  return (
    <div className="radar-reports">
      <div className="radar-reports-head">
        <p className="radar-caption">
          A MAVI lê os números do Radar no período e escreve o que mais pesa em cada produto, com as ações
          sugeridas. Os números são os do sistema; o texto é dela.
        </p>
        <div className="thermo-filters-actions">
          <Button className="icon-btn" onClick={load} aria-label="Atualizar" title="Atualizar">
            <RefreshCw size={15} />
          </Button>
          <Button className="btn primary" onClick={() => setAsking(true)}>
            <Sparkles size={15} aria-hidden="true" /> Gerar relatório
          </Button>
        </div>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <section className="panel radar-schedules" aria-label="Meus agendamentos">
        <header>
          <strong>
            <CalendarClock size={15} aria-hidden="true" /> Meus agendamentos
          </strong>
          <Button
            className="btn secondary"
            onClick={() =>
              setEditing({
                name: "",
                frequency: "weekly",
                weekday: 1,
                month_day: 1,
                hour: 8,
                period_days: 7,
                filters: {},
                active: true,
              })
            }
          >
            <Plus size={14} aria-hidden="true" /> Agendar
          </Button>
        </header>
        {!schedules ? (
          <Loading variant="inline" />
        ) : !schedules.length ? (
          <p className="muted">
            Nenhum agendamento. Agende um relatório para chegar sozinho, por exemplo toda segunda às 8h com a
            semana anterior. Ele chega na sua caixa de entrada e no push.
          </p>
        ) : (
          <ul>
            {schedules.map((s) => (
              <li key={s.id} className={s.active ? "" : "off"}>
                <div>
                  <strong>{s.name}</strong>
                  <small>
                    {[
                      scheduleLabel(s),
                      labelsLine(s.labels),
                      s.active ? (s.next_run_at ? `próximo em ${dateBr(s.next_run_at)}` : "") : "pausado",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </div>
                <button type="button" className="icon-btn" aria-label={`Editar ${s.name}`} onClick={() => setEditing(s)}>
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Excluir ${s.name}`}
                  onClick={() =>
                    void deleteSchedule(company, s.id!)
                      .then((list) => {
                        setSchedules(list);
                        notify("Agendamento excluído.");
                      })
                      .catch((e) => setError((e as Error).message))
                  }
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {!reports ? (
        <Loading variant="list" />
      ) : !reports.length ? (
        <Empty title="Nenhum relatório ainda" body="Gere o primeiro: escolha o período e, se quiser, os tópicos e os produtos." />
      ) : (
        <ul className="radar-report-list">
          {reports.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => setOpen(r.id)}>
                <FileText size={18} aria-hidden="true" />
                <span className="radar-client-title">
                  <strong>{r.title}</strong>
                  <small>
                    {labelsLine(r.labels)} · {r.schedule_name ? `agendado (${r.schedule_name})` : `pedido por ${r.requested_by_name ?? "alguém"}`} ·{" "}
                    {dateBr(r.created_at)}
                  </small>
                  {r.headline && <span className="radar-report-headline">{r.headline}</span>}
                </span>
                <span className={`radar-report-status ${r.status}`}>{STATUS[r.status]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {asking && (
        <ReportRequest
          company={company}
          data={data}
          topics={topics}
          onClose={() => setAsking(false)}
          onDone={(r) => {
            setAsking(false);
            setReports((list) => [r, ...(list ?? []).filter((x) => x.id !== r.id)]);
            notify("A MAVI começou a escrever. Você recebe o aviso quando o relatório ficar pronto.");
          }}
        />
      )}
      {editing && (
        <ScheduleForm
          company={company}
          data={data}
          topics={topics}
          schedule={editing}
          onClose={() => setEditing(null)}
          onSaved={(list) => {
            setEditing(null);
            setSchedules(list);
            notify("Agendamento salvo.");
          }}
        />
      )}
      {open && (
        <ReportView
          company={company}
          id={open}
          notify={notify}
          onClose={() => {
            setOpen(null);
            onOpened?.();
          }}
          onChanged={load}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------ filtros
function FilterPicker({
  data,
  topics,
  value,
  onChange,
}: {
  data: Snapshot;
  topics: TopicCounts[];
  value: ReportFilters;
  onChange: (v: ReportFilters) => void;
}) {
  const toggle = (key: keyof ReportFilters, id: string, on: boolean) => {
    const list = value[key] ?? [];
    onChange({ ...value, [key]: on ? [...new Set([...list, id])] : list.filter((x) => x !== id) });
  };
  const group = (key: keyof ReportFilters, label: string, options: { id: string; name: string }[], empty: string) => (
    <fieldset className="radar-report-filter">
      <legend>
        {label} <small className="muted">({(value[key] ?? []).length ? "os marcados" : empty})</small>
      </legend>
      <div>
        {options.map((o) => (
          <label key={o.id} className="thermo-check">
            <Checkbox
              checked={(value[key] ?? []).includes(o.id)}
              onCheckedChange={(v) => toggle(key, o.id, v === true)}
            />
            {o.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
  return (
    <>
      {group("topics", "Tópicos", topics.map((t) => ({ id: t.id, name: t.name })), "todos")}
      {group(
        "products",
        "Produtos",
        [...data.products.map((p) => ({ id: p.id, name: p.name })), { id: "none", name: "Geral / Agência" }],
        "todos",
      )}
      {data.teams.length > 0 &&
        group("teams", "Equipes", data.teams.map((t) => ({ id: t.id, name: t.name })), "todas")}
    </>
  );
}

function ReportRequest({
  company,
  data,
  topics,
  onClose,
  onDone,
}: {
  company: string;
  data: Snapshot;
  topics: TopicCounts[];
  onClose: () => void;
  onDone: (r: RadarReport) => void;
}) {
  const t = today();
  const [preset, setPreset] = useState("30");
  const [from, setFrom] = useState(addDays(t, -29));
  const [to, setTo] = useState(t);
  const [filters, setFilters] = useState<ReportFilters>({});
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const choose = (v: string) => {
    setPreset(v);
    if (v === "month") {
      setFrom(`${t.slice(0, 8)}01`);
      setTo(t);
    } else if (v === "last_month") {
      const end = addDays(`${t.slice(0, 8)}01`, -1);
      setFrom(`${end.slice(0, 8)}01`);
      setTo(end);
    } else if (v !== "custom") {
      setFrom(addDays(t, -(Number(v) - 1)));
      setTo(t);
    }
  };
  return (
    <Modal title="Gerar relatório do Radar" onClose={onClose} busy={busy}>
      <form
        className="entity-form radar-report-form"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          requestReport(company, from, to, filters, title.trim() || undefined)
            .then(onDone)
            .catch((err) => setError((err as Error).message))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          <span>Período</span>
          <Select aria-label="Período" value={preset} onValueChange={choose}>
            <SelectOption value="7">Últimos 7 dias</SelectOption>
            <SelectOption value="30">Últimos 30 dias</SelectOption>
            <SelectOption value="90">Últimos 90 dias</SelectOption>
            <SelectOption value="month">Este mês</SelectOption>
            <SelectOption value="last_month">Mês passado</SelectOption>
            <SelectOption value="custom">Escolher as datas</SelectOption>
          </Select>
        </label>
        {preset === "custom" && (
          <div className="radar-report-dates">
            <label>
              <span>De</span>
              <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label>
              <span>Até</span>
              <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
        )}
        <FilterPicker data={data} topics={topics} value={filters} onChange={setFilters} />
        <label>
          <span>Título (opcional)</span>
          <Input
            value={title}
            maxLength={200}
            placeholder={`Radar do cliente · ${dateBr(from)} a ${dateBr(to)}`}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <Button className="btn primary" type="submit" loading={busy} disabled={!from || !to}>
          <Sparkles size={15} aria-hidden="true" /> Pedir para a MAVI
        </Button>
      </form>
    </Modal>
  );
}

function ScheduleForm({
  company,
  data,
  topics,
  schedule,
  onClose,
  onSaved,
}: {
  company: string;
  data: Snapshot;
  topics: TopicCounts[];
  schedule: ReportSchedule;
  onClose: () => void;
  onSaved: (list: ReportSchedule[]) => void;
}) {
  const [s, setS] = useState<ReportSchedule>(structuredClone(schedule));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (p: Partial<ReportSchedule>) => setS((v) => ({ ...v, ...p }));
  return (
    <Modal title={schedule.id ? "Editar agendamento" : "Agendar relatório"} onClose={onClose} busy={busy}>
      <form
        className="entity-form radar-report-form"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          saveSchedule(company, s)
            .then(onSaved)
            .catch((err) => setError((err as Error).message))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          <span>Nome</span>
          <Input
            value={s.name}
            maxLength={120}
            placeholder="Ex.: Semanal de Make Ads"
            onChange={(e) => set({ name: e.target.value })}
          />
        </label>
        <div className="radar-report-dates">
          <label>
            <span>Frequência</span>
            <Select
              aria-label="Frequência"
              value={s.frequency}
              onValueChange={(v) =>
                set({ frequency: v as ReportSchedule["frequency"], period_days: v === "weekly" ? 7 : 30 })
              }
            >
              <SelectOption value="weekly">Toda semana</SelectOption>
              <SelectOption value="monthly">Todo mês</SelectOption>
            </Select>
          </label>
          {s.frequency === "weekly" ? (
            <label>
              <span>Dia</span>
              <Select aria-label="Dia da semana" value={String(s.weekday)} onValueChange={(v) => set({ weekday: Number(v) })}>
                {WEEKDAYS.slice(1).map((d, i) => (
                  <SelectOption key={d} value={String(i + 1)}>
                    {d}
                  </SelectOption>
                ))}
              </Select>
            </label>
          ) : (
            <label>
              <span>Dia do mês</span>
              <Select aria-label="Dia do mês" value={String(s.month_day)} onValueChange={(v) => set({ month_day: Number(v) })}>
                {Array.from({ length: 28 }, (_, i) => (
                  <SelectOption key={i} value={String(i + 1)}>
                    {`Dia ${i + 1}`}
                  </SelectOption>
                ))}
              </Select>
            </label>
          )}
          <label>
            <span>Hora</span>
            <Select aria-label="Hora" value={String(s.hour)} onValueChange={(v) => set({ hour: Number(v) })}>
              {Array.from({ length: 24 }, (_, h) => (
                <SelectOption key={h} value={String(h)}>
                  {`${h}h`}
                </SelectOption>
              ))}
            </Select>
          </label>
          <label>
            <span>Período</span>
            <Select aria-label="Período" value={String(s.period_days)} onValueChange={(v) => set({ period_days: Number(v) })}>
              {[7, 14, 30, 90].map((d) => (
                <SelectOption key={d} value={String(d)}>
                  {`Últimos ${d} dias`}
                </SelectOption>
              ))}
            </Select>
          </label>
        </div>
        <FilterPicker data={data} topics={topics} value={s.filters} onChange={(filters) => set({ filters })} />
        <label className="thermo-check">
          <Checkbox checked={s.active} onCheckedChange={(v) => set({ active: v === true })} />
          Ligado
        </label>
        <p className="muted radar-report-note">
          {scheduleLabel(s)}, até a véspera. O relatório chega na sua caixa de entrada e no push quando ficar pronto.
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <Button className="btn primary" type="submit" loading={busy}>
          <CalendarClock size={15} aria-hidden="true" /> Salvar agendamento
        </Button>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------ o relatório
function ReportView({
  company,
  id,
  notify,
  onClose,
  onChanged,
}: {
  company: string;
  id: string;
  notify: (message: string) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [r, setR] = useState<RadarReportFull | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    loadReport(company, id)
      .then(setR)
      .catch((e) => setError((e as Error).message));
  }, [company, id]);
  useEffect(load, [load]);
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<{ report?: string }>).detail?.report === id) load();
    };
    window.addEventListener("mavi:radar", on);
    return () => window.removeEventListener("mavi:radar", on);
  }, [id, load]);

  const c = r?.content;
  const m = r?.material;
  return (
    <Modal title={r?.title ?? "Relatório do Radar"} onClose={onClose} wide busy={busy} className="radar-sheet radar-report-sheet">
      {!r ? (
        error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : (
          <Loading variant="editor" />
        )
      ) : (
        <div className="radar-detail radar-report">
          <div className="radar-detail-tags">
            <span className="radar-topic-tag" style={{ "--topic": "#4a3aa7" } as CSSProperties}>
              {dateBr(r.period_from)} a {dateBr(r.period_to)}
            </span>
            <span className="muted">{labelsLine(r.labels)}</span>
          </div>
          <div className="radar-report-actions">
            {r.status === "done" && (
              <Button
                className="btn primary"
                loading={busy}
                onClick={() => {
                  setBusy(true);
                  import("./radar-pdf")
                    .then((x) => x.downloadRadarReport(r))
                    .catch((e) => setError((e as Error).message))
                    .finally(() => setBusy(false));
                }}
              >
                <Download size={15} aria-hidden="true" /> Baixar PDF
              </Button>
            )}
            {r.status === "failed" && (
              <Button
                className="btn secondary"
                onClick={() =>
                  void retryReport(company, r.id)
                    .then(() => {
                      notify("A MAVI vai tentar de novo.");
                      load();
                      onChanged();
                    })
                    .catch((e) => setError((e as Error).message))
                }
              >
                <RefreshCw size={15} aria-hidden="true" /> Tentar de novo
              </Button>
            )}
            <Button
              className="btn secondary"
              onClick={() =>
                void deleteReport(company, r.id)
                  .then(() => {
                    notify("Relatório excluído.");
                    onChanged();
                    onClose();
                  })
                  .catch((e) => setError((e as Error).message))
              }
            >
              <Trash2 size={15} aria-hidden="true" /> Excluir
            </Button>
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {r.status !== "done" ? (
            r.status === "failed" ? (
              <p className="radar-unconfirmed">Não deu para escrever o relatório: {r.error || "erro desconhecido"}.</p>
            ) : (
              <div className="radar-report-waiting">
                <Loading variant="text" />
                <p className="muted">
                  {STATUS[r.status]} Você recebe um aviso quando ficar pronto; pode fechar esta janela.
                </p>
              </div>
            )
          ) : (
            <>
              {c && (
                <>
                  <h3 className="radar-report-title">{c.headline}</h3>
                  <p className="radar-detail-summary">{c.summary}</p>
                </>
              )}
              {m && m.topics.length > 0 && (
                <div className="radar-report-kpis">
                  {m.topics.map((t) => (
                    <div key={t.topic} className="panel">
                      <strong>{t.topic}</strong>
                      <dl>
                        <div>
                          <dt>Novos</dt>
                          <dd>{t.new}</dd>
                        </div>
                        <div>
                          <dt>Em aberto</dt>
                          <dd>{t.open}</dd>
                        </div>
                        <div>
                          <dt>Sérios</dt>
                          <dd>{t.severe}</dd>
                        </div>
                        {t.has_due && (
                          <div>
                            <dt>Vencidos</dt>
                            <dd>{t.overdue}</dd>
                          </div>
                        )}
                        <div>
                          <dt>Fechados</dt>
                          <dd>{t.closed}</dd>
                        </div>
                        <div>
                          <dt>Clientes</dt>
                          <dd>{t.clients}</dd>
                        </div>
                      </dl>
                    </div>
                  ))}
                </div>
              )}
              {c?.sections.map((s) => {
                const nums = m?.products.find((p) => p.product === s.title);
                return (
                  <section key={s.title} className="radar-report-section">
                    <h4>{s.title}</h4>
                    {s.paragraphs.map((p, i) => (
                      <p key={i}>{p}</p>
                    ))}
                    {s.bullets.length > 0 && (
                      <ul>
                        {s.bullets.map((b, i) => (
                          <li key={i}>{b}</li>
                        ))}
                      </ul>
                    )}
                    {nums && (
                      <table className="radar-report-table">
                        <thead>
                          <tr>
                            <th>Tópico</th>
                            <th className="num">Novos</th>
                            <th className="num">Em aberto</th>
                            <th className="num">Sérios</th>
                            <th className="num">Vencidos</th>
                            <th className="num">Fechados</th>
                          </tr>
                        </thead>
                        <tbody>
                          {nums.topics.map((t) => (
                            <tr key={t.topic}>
                              <td>{t.topic}</td>
                              <td className="num">{t.new}</td>
                              <td className="num">{t.open}</td>
                              <td className="num">{t.severe}</td>
                              <td className="num">{t.overdue}</td>
                              <td className="num">{t.closed}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </section>
                );
              })}
              {((c?.crossings?.length ?? 0) > 0 || (m?.campaigns?.clients.length ?? 0) > 0) && (
                <section className="radar-report-section">
                  <h4>Radar × Campanhas</h4>
                  <p className="muted radar-report-hint">
                    O que foi dito nas reuniões e no WhatsApp ao lado dos números das campanhas do mesmo cliente.
                  </p>
                  {c?.crossings?.map((x, i) => (
                    <article key={i} className="radar-cross" style={{ "--status": PRIORITY_COLORS[x.priority] } as CSSProperties}>
                      <header>
                        <strong>{x.client}</strong>
                        {x.product && <small className="muted">{x.product}</small>}
                        <span className="radar-status" style={{ "--status": PRIORITY_COLORS[x.priority] } as CSSProperties}>
                          {x.priority}
                        </span>
                      </header>
                      <dl>
                        <div>
                          <dt>O que foi dito</dt>
                          <dd>{x.problem}</dd>
                        </div>
                        {x.evidence && (
                          <div>
                            <dt>O que as campanhas mostram</dt>
                            <dd>{x.evidence}</dd>
                          </div>
                        )}
                        {x.solution && (
                          <div className="radar-cross-solution">
                            <dt>Solução</dt>
                            <dd>{x.solution}</dd>
                          </div>
                        )}
                      </dl>
                    </article>
                  ))}
                  {m?.campaigns && m.campaigns.clients.length > 0 && (
                    <div className="radar-report-scroll">
                      <table className="radar-report-table">
                        <thead>
                          <tr>
                            <th>Cliente · campanha</th>
                            <th>Ciclo</th>
                            <th>Custo × meta</th>
                            <th>Gasto do ciclo</th>
                            <th>No período</th>
                          </tr>
                        </thead>
                        <tbody>
                          {m.campaigns.clients.flatMap((k) =>
                            k.campaigns.map((x, n) => {
                              const cells = campaignCells(x);
                              return (
                                <tr key={`${k.client}-${n}`}>
                                  <td>
                                    <strong>{k.client}</strong> · {cells.name}
                                    <small className="muted">{cells.meta}</small>
                                  </td>
                                  <td>
                                    {cells.goal}
                                    <small className="muted">{cells.cycle}</small>
                                  </td>
                                  <td className={cells.status === "good" ? "radar-good" : cells.status === "bad" ? "radar-late" : undefined}>
                                    {cells.cost}
                                  </td>
                                  <td>{cells.spend}</td>
                                  <td>{cells.period}</td>
                                </tr>
                              );
                            }),
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {m?.campaigns && (
                    <p className="muted radar-report-note">
                      {m.campaigns.without.length > 0 && <>Sem campanha no período: {m.campaigns.without.join(", ")}. </>}
                      Valores como o cliente contratou.
                    </p>
                  )}
                </section>
              )}
              {c && c.actions.length > 0 && (
                <section className="radar-report-section">
                  <h4>Ações sugeridas</h4>
                  <ol className="radar-report-todo">
                    {c.actions.map((a, i) => (
                      <li key={i}>
                        <span className="radar-status" style={{ "--status": PRIORITY_COLORS[a.priority] } as CSSProperties}>
                          {a.priority}
                        </span>
                        <span>
                          {a.text}
                          {a.product && <small className="muted"> · {a.product}</small>}
                        </span>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              {m && m.themes.length > 0 && (
                <section className="radar-report-section">
                  <h4>Temas com mais clientes</h4>
                  <table className="radar-report-table">
                    <thead>
                      <tr>
                        <th>Tema</th>
                        <th>Produto</th>
                        <th className="num">Clientes</th>
                        <th className="num">Em aberto</th>
                        <th className="num">Vezes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {m.themes.map((t) => (
                        <tr key={`${t.product}-${t.title}`}>
                          <td>
                            {t.title}
                            <small className="muted"> · {t.client_names.join(", ")}</small>
                          </td>
                          <td>{t.product}</td>
                          <td className="num">{t.clients}</td>
                          <td className="num">
                            {t.open} de {t.items}
                          </td>
                          <td className="num">{t.mentions}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}
              {m && m.severe.length > 0 && (
                <section className="radar-report-section">
                  <h4>Itens sérios em aberto</h4>
                  <table className="radar-report-table">
                    <thead>
                      <tr>
                        <th>Cliente</th>
                        <th>Item</th>
                        <th>Produto</th>
                        <th>Gravidade</th>
                      </tr>
                    </thead>
                    <tbody>
                      {m.severe.map((i) => (
                        <tr key={`${i.client}-${i.title}`}>
                          <td>{i.client}</td>
                          <td>{i.title}</td>
                          <td>{i.product}</td>
                          <td>{SEVERITY[i.severity] ?? i.severity}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}
              {m && m.overdue.length > 0 && (
                <section className="radar-report-section">
                  <h4>Promessas e prazos vencidos</h4>
                  <table className="radar-report-table">
                    <thead>
                      <tr>
                        <th>Cliente</th>
                        <th>Promessa</th>
                        <th>Prazo</th>
                        <th>Responsável</th>
                      </tr>
                    </thead>
                    <tbody>
                      {m.overdue.map((o) => (
                        <tr key={`${o.client}-${o.title}`}>
                          <td>{o.client}</td>
                          <td>{o.title}</td>
                          <td className="radar-late">{dateBr(o.due_date)}</td>
                          <td>{o.assignee ?? "Sem responsável"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}
              <p className="muted radar-report-note">
                Gerado em {dateBr(r.finished_at ?? r.created_at)}
                {r.requested_by_name && ` · pedido por ${r.requested_by_name}`}
                {r.schedule_name && ` · agendamento "${r.schedule_name}"`}. Números calculados pelo sistema; texto
                escrito pela MAVI.
              </p>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

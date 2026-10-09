import { useCallback, useEffect, useState } from "react";
import { ArrowRight, CircleCheck, RefreshCw, Settings2, Sparkles, Target, TriangleAlert } from "lucide-react";
import { Modal } from "./components";
import { Button, Checkbox, Loading, Select, SelectOption } from "./ui";
import {
  agentOp,
  dayMonth,
  deltaText,
  errorOf,
  ISSUE_LABEL,
  lastDays,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  percent,
  SENTIMENT_LABEL,
  usd,
  when,
  type AgentReading,
  type AgentReport,
  type InsightConversation,
  type InsightsSettings,
  type Outcome,
} from "./agent-builder";
import { ConversationInsightModal } from "./AgentConversationModal";

/**
 * Agentes MAVI › Insights: o que está acontecendo nas conversas. Números
 * exatos dos registros do motor, a leitura das conversas da amostra
 * (resultados, motivos, objeções, falhas do agente), as lacunas do
 * treinamento e a Leitura da MAVI — sempre comparando com o período anterior.
 */

type Period = { from: string; to: string };
type Filter = { outcome?: Outcome; sentiment?: string; objection?: string; reason?: string; issue?: string; topic?: string; label: string };

const PRESETS = [7, 30, 90];

export function InsightsPanel({
  company,
  agentId,
  canEdit,
  notify,
  initial,
  onOpenGaps,
}: {
  company: string;
  agentId: string;
  canEdit: boolean;
  notify: (m: string) => void;
  /** Período vindo do link do resumo semanal (?de=&ate=). */
  initial?: Period | null;
  onOpenGaps: () => void;
}) {
  const [period, setPeriod] = useState<Period>(() => initial ?? lastDays(30));
  const [data, setData] = useState<{ report: AgentReport; reading: AgentReading | null } | null>(null);
  const [error, setError] = useState("");
  const [writing, setWriting] = useState(false);
  const [filter, setFilter] = useState<Filter | null>(null);
  const [conversation, setConversation] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);

  const load = useCallback(() => {
    setData(null);
    agentOp<{ report: AgentReport; reading: AgentReading | null }>(company, agentId, "report", period)
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((e) => setError(errorOf(e)));
  }, [company, agentId, period]);
  useEffect(load, [load]);

  const write = async () => {
    setWriting(true);
    try {
      const r = await agentOp<{ reading: AgentReading }>(company, agentId, "reading", period);
      setData((d) => (d ? { ...d, reading: r.reading } : d));
    } catch (e) {
      notify(errorOf(e));
    } finally {
      setWriting(false);
    }
  };

  const preset = PRESETS.find((n) => {
    const p = lastDays(n);
    return p.from === period.from && p.to === period.to;
  });
  const r = data?.report;

  return (
    <div className="ab-stack">
      <div className="ab-toolbar">
        <div className="ab-chips" role="group" aria-label="Período">
          {PRESETS.map((n) => (
            <button key={n} type="button" className={preset === n ? "selected" : ""} onClick={() => setPeriod(lastDays(n))}>
              {n} dias
            </button>
          ))}
          {!preset && (
            <button type="button" className="selected">
              {dayMonth(period.from)} a {dayMonth(period.to)}
            </button>
          )}
        </div>
        <span className="ab-toolbar-right">
          <button type="button" className="agent-link-btn" onClick={load}>
            Atualizar
          </button>
          <Button type="button" className="btn secondary" onClick={() => setSettings(true)}>
            <Settings2 size={15} aria-hidden="true" /> Configurar
          </Button>
        </span>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      {!data && !error && <Loading variant="page" />}
      {r && data && (
        <>
          <ReadingCard reading={data.reading} report={r} writing={writing} onWrite={() => void write()} onOpen={setConversation} />
          <Kpis r={r} />
          <Activity r={r} />

          <section className="ab-section">
            <div className="ab-toolbar">
              <h3>Como as conversas terminaram</h3>
              <span className="muted ai-small">
                {r.sample_percent
                  ? `${r.insights.analyzed} conversa(s) lida(s) pela MAVI · amostra de ${r.sample_percent}%`
                  : "Leitura das conversas desligada (Configurar)"}
              </span>
            </div>
            {!r.insights.analyzed ? (
              <p className="muted ai-small">
                A MAVI lê as conversas da amostra algumas horas depois que elas esfriam (3 h sem mensagem). Os resultados aparecem aqui.
              </p>
            ) : (
              <Bars
                rows={r.insights.outcomes.map((o) => ({
                  key: o.outcome,
                  label: OUTCOME_LABEL[o.outcome] ?? o.outcome,
                  n: o.n,
                  tone: OUTCOME_TONE[o.outcome],
                  prev: r.previous_insights.outcomes.find((p) => p.outcome === o.outcome)?.n ?? 0,
                }))}
                total={r.insights.analyzed}
                prevTotal={r.previous_insights.analyzed}
                onPick={(k) => setFilter({ outcome: k as Outcome, label: OUTCOME_LABEL[k as Outcome] })}
              />
            )}
            {r.insights.sentiment.length > 0 && (
              <p className="ai-small muted">
                Sentimento do lead:{" "}
                {r.insights.sentiment.map((s, i) => (
                  <span key={s.sentiment}>
                    {i > 0 && " · "}
                    <button type="button" className="agent-link-btn" onClick={() => setFilter({ sentiment: s.sentiment, label: `Lead ${SENTIMENT_LABEL[s.sentiment]?.toLowerCase()}` })}>
                      {SENTIMENT_LABEL[s.sentiment]} {percent(s.n / r.insights.analyzed)}
                    </button>
                  </span>
                ))}
              </p>
            )}
          </section>

          {r.insights.analyzed > 0 && (
            <div className="ai-columns">
              <Ranked
                title="Por que não avançaram"
                hint="Motivo das conversas sem interesse, que pararam de responder ou fora do perfil."
                rows={r.insights.reasons}
                onPick={(label) => setFilter({ reason: label, label: `Motivo: ${label}` })}
              />
              <Ranked title="Objeções" rows={r.insights.objections} onPick={(label) => setFilter({ objection: label, label: `Objeção: ${label}` })} />
              <Ranked title="Assuntos" rows={r.insights.topics} onPick={(label) => setFilter({ topic: label, label: `Assunto: ${label}` })} />
            </div>
          )}

          {r.insights.issues.length > 0 && (
            <section className="ab-section">
              <h3>Falhas do agente</h3>
              <ul className="ai-plain">
                {r.insights.issues.map((x) => (
                  <li key={x.type} className="ai-issue">
                    <button type="button" className="agent-link-btn" onClick={() => setFilter({ issue: x.type, label: ISSUE_LABEL[x.type] ?? x.type })}>
                      <strong>{ISSUE_LABEL[x.type] ?? x.type}</strong> · {x.n}x
                    </button>
                    <ul className="ai-plain ai-sub">
                      {x.examples.slice(0, 2).map((e, i) => (
                        <li key={i}>
                          <button type="button" className="agent-link-btn" onClick={() => setConversation(e.conversation_id)}>
                            {e.detail}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {r.look_at.length > 0 && (
            <section className="ab-section">
              <h3>Conversas para olhar</h3>
              <p className="muted ai-small">Lead insatisfeito, falha do agente ou conversa passada para a equipe.</p>
              <ul className="ab-list">
                {r.look_at.map((c) => (
                  <li key={c.conversation_id} className="ab-row">
                    <button type="button" className="ab-row-main ab-row-button" onClick={() => setConversation(c.conversation_id)}>
                      <span className="ab-row-title">
                        <strong>{c.contact_name || c.phone || "Contato"}</strong>
                        <span className="muted">{when(c.activity_at)}</span>
                      </span>
                      <span className="muted ab-clamp">{c.summary}</span>
                    </button>
                    <span className="ab-badges">
                      {c.agent_issues.length > 0 && <span className="ab-badge danger">{ISSUE_LABEL[c.agent_issues[0]!.type] ?? "Falha"}</span>}
                      {c.sentiment === "negative" && <span className="ab-badge warn">Insatisfeito</span>}
                      <span className="ab-badge">{OUTCOME_LABEL[c.outcome]}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="ab-section">
            <div className="ab-toolbar">
              <h3>Lacunas do treinamento</h3>
              <button type="button" className="agent-link-btn" onClick={onOpenGaps}>
                Ver lacunas <ArrowRight size={14} aria-hidden="true" />
              </button>
            </div>
            <p className="ai-small">
              Cobertura de <strong>{percent(r.gaps.coverage)}</strong>
              {r.previous_gaps.coverage != null && r.gaps.coverage != null && ` (antes ${percent(r.previous_gaps.coverage)})`}: {r.gaps.gaps} lacuna(s), {r.gaps.new_topics}{" "}
              tema(s) novo(s).
            </p>
            {r.gaps.top.length > 0 && (
              <ul className="ai-plain">
                {r.gaps.top.map((t) => (
                  <li key={t.id}>
                    <span className="ab-badge">{t.kind === "objection" ? "Objeção" : "Pergunta"}</span> {t.title} <span className="muted">· {t.in_period}x</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {filter && (
        <ConversationList
          company={company}
          agentId={agentId}
          period={period}
          filter={filter}
          onClose={() => setFilter(null)}
          onOpen={setConversation}
        />
      )}
      {conversation && (
        <ConversationInsightModal company={company} agentId={agentId} conversationId={conversation} canReset={canEdit} notify={notify} onClose={() => setConversation(null)} />
      )}
      {settings && (
        <SettingsModal
          company={company}
          agentId={agentId}
          canEdit={canEdit}
          report={r ?? null}
          notify={notify}
          onClose={() => setSettings(false)}
          onSaved={load}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------ Leitura da MAVI
const POINT_ICON = { good: CircleCheck, attention: TriangleAlert, action: Target };

function ReadingCard({
  reading,
  report,
  writing,
  onWrite,
  onOpen,
}: {
  reading: AgentReading | null;
  report: AgentReport;
  writing: boolean;
  onWrite: () => void;
  onOpen: (conversation: string) => void;
}) {
  const empty = !report.metrics.conversations && !report.insights.analyzed;
  return (
    <section className="ab-section ai-reading">
      <div className="ab-toolbar">
        <h3>
          <Sparkles size={15} aria-hidden="true" /> Leitura da MAVI
        </h3>
        {!empty && (
          <Button type="button" className="btn secondary ab-mavi-btn" loading={writing} onClick={onWrite}>
            {reading ? <RefreshCw size={14} aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />} {reading ? "Ler de novo" : "Escrever leitura"}
          </Button>
        )}
      </div>
      {empty && <p className="muted ai-small">Sem conversas no período.</p>}
      {!empty && !reading && (
        <p className="muted ai-small">
          A MAVI lê os números e as conversas do período e diz o que aconteceu, o que mudou, o que preocupa e o que fazer, com as conversas que sustentam
          cada ponto.
        </p>
      )}
      {reading && (
        <>
          <p className="ai-lead">{reading.reading.summary}</p>
          <ul className="ai-points">
            {reading.reading.points.map((p, i) => {
              const Icon = POINT_ICON[p.kind] ?? TriangleAlert;
              return (
                <li key={i} className={`ai-point ${p.kind}`}>
                  <Icon size={16} aria-hidden="true" />
                  <div>
                    <strong>{p.title}</strong>
                    <p>{p.text}</p>
                    {p.conversations.length > 0 && (
                      <span className="ai-evidence">
                        {p.conversations.map((c, k) => (
                          <button key={c} type="button" onClick={() => onOpen(c)}>
                            Conversa {k + 1}
                          </button>
                        ))}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <span className="muted ai-small">
            Escrita em {when(reading.created_at)}
            {reading.created_by ? ` · pedida por ${reading.created_by}` : ""}
          </span>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------ números
function Kpis({ r }: { r: AgentReport }) {
  const m = r.metrics;
  const p = r.previous_metrics;
  const items: { label: string; value: string; delta?: string; hint?: string; good?: "up" | "down" }[] = [
    { label: "Conversas", value: m.conversations.toLocaleString("pt-BR"), delta: deltaText(m.conversations, p.conversations), hint: "Conversas com mensagem do lead no período." },
    { label: "Novos contatos", value: m.new_conversations.toLocaleString("pt-BR"), delta: deltaText(m.new_conversations, p.new_conversations) },
    { label: "Reuniões marcadas", value: m.meetings.toLocaleString("pt-BR"), delta: deltaText(m.meetings, p.meetings), good: "up" },
    { label: "Passou para a equipe", value: m.handoffs.toLocaleString("pt-BR"), delta: deltaText(m.handoffs, p.handoffs) },
    {
      label: "Voltaram pelo follow-up",
      value: m.followup_recovered.toLocaleString("pt-BR"),
      delta: deltaText(m.followup_recovered, p.followup_recovered),
      hint: `${m.followup_messages} follow-up(s) enviados no período.`,
      good: "up",
    },
    { label: "Tempo de resposta", value: m.reply_ms_p50 == null ? "—" : `${Math.round(m.reply_ms_p50 / 1000)} s`, hint: "Tempo típico, já contando a espera por novas mensagens." },
    { label: "Erros", value: m.errors.toLocaleString("pt-BR"), hint: `${m.turns} resposta(s) no período.`, good: "down" },
    { label: "Custo", value: usd(m.cost_usd + m.insights_cost_usd), hint: `Conversas ${usd(m.cost_usd)} · leitura da MAVI ${usd(m.insights_cost_usd)}` },
  ];
  return (
    <div className="ab-kpis">
      {items.map((k) => (
        <div key={k.label} title={k.hint}>
          <span className="muted">{k.label}</span>
          <strong>
            {k.value}{" "}
            {k.delta && k.delta !== "=" && (
              <small className={`ai-delta ${k.good && k.delta.startsWith(k.good === "up" ? "+" : "−") ? "up" : k.good ? "down" : ""}`}>{k.delta}</small>
            )}
          </strong>
        </div>
      ))}
    </div>
  );
}

function Activity({ r }: { r: AgentReport }) {
  const days = r.series.days;
  const max = Math.max(1, ...days.map((d) => d.conversations));
  const hours = Array.from({ length: 24 }, (_, h) => r.series.hours.find((x) => x.hour === h)?.lead_messages ?? 0);
  const maxH = Math.max(1, ...hours);
  const peak = hours.indexOf(maxH);
  if (!days.some((d) => d.conversations)) return null;
  return (
    <section className="ab-section">
      <div className="ab-toolbar">
        <h3>Conversas por dia</h3>
        <span className="muted ai-small">
          Pico de mensagens às {peak}h · comparação com {dayMonth(r.previous.from)} a {dayMonth(r.previous.to)}
        </span>
      </div>
      <div className="ai-bars-days" role="img" aria-label="Conversas por dia">
        {days.map((d) => (
          <span key={d.day} title={`${dayMonth(d.day)}: ${d.conversations} conversa(s), ${d.meetings} reunião(ões), ${d.handoffs} para a equipe`}>
            <i style={{ height: `${(d.conversations / max) * 100}%` }} />
          </span>
        ))}
      </div>
      <div className="ai-axis muted">
        <span>{dayMonth(days[0]!.day)}</span>
        <span>{dayMonth(days[days.length - 1]!.day)}</span>
      </div>
      <div className="ai-hours" role="img" aria-label="Mensagens dos leads por hora do dia">
        {hours.map((n, h) => (
          <span key={h} title={`${h}h: ${n} mensagem(ns)`} style={{ opacity: 0.12 + (n / maxH) * 0.88 }} />
        ))}
      </div>
      <div className="ai-axis muted">
        <span>0h</span>
        <span>12h</span>
        <span>23h</span>
      </div>
    </section>
  );
}

function Bars({
  rows,
  total,
  prevTotal,
  onPick,
}: {
  rows: { key: string; label: string; n: number; prev: number; tone: "good" | "neutral" | "bad" }[];
  total: number;
  prevTotal: number;
  onPick: (key: string) => void;
}) {
  return (
    <ul className="ai-plain ai-bars">
      {rows.map((x) => {
        const share = total ? x.n / total : 0;
        const before = prevTotal ? x.prev / prevTotal : null;
        const diff = before == null ? null : Math.round((share - before) * 100);
        return (
          <li key={x.key}>
            <button type="button" onClick={() => onPick(x.key)}>
              <span className="ai-bar-label">{x.label}</span>
              <span className="ai-bar">
                <i className={x.tone} style={{ width: `${share * 100}%` }} />
              </span>
              <span className="ai-bar-n">
                {Math.round(share * 100)}% <span className="muted">({x.n})</span>
                {diff != null && diff !== 0 && <small className="ai-delta">{`${diff > 0 ? "+" : "−"}${Math.abs(diff)} p.p.`}</small>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Ranked({ title, hint, rows, onPick }: { title: string; hint?: string; rows: { label: string; n: number }[]; onPick: (label: string) => void }) {
  return (
    <section className="ab-section">
      <h3>{title}</h3>
      {hint && <p className="muted ai-small">{hint}</p>}
      {!rows.length ? (
        <p className="muted ai-small">Nada no período.</p>
      ) : (
        <ol className="ai-ranked">
          {rows.map((x) => (
            <li key={x.label}>
              <button type="button" className="agent-link-btn" onClick={() => onPick(x.label)}>
                {x.label}
              </button>
              <span className="muted">{x.n}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// ------------------------------------------------------------ conversas de um número
function ConversationList({
  company,
  agentId,
  period,
  filter,
  onClose,
  onOpen,
}: {
  company: string;
  agentId: string;
  period: Period;
  filter: Filter;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const [rows, setRows] = useState<InsightConversation[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const { label, ...params } = filter;
  const fetchPage = (offset: number) =>
    agentOp<{ conversations: InsightConversation[]; total: number }>(company, agentId, "insight-conversations", { ...period, ...params, limit: 50, offset });
  useEffect(() => {
    fetchPage(0)
      .then((r) => {
        setRows(r.conversations);
        setTotal(r.total);
      })
      .catch((e) => setError(errorOf(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company, agentId, period.from, period.to, label]);
  return (
    <Modal title={label} onClose={onClose} wide>
      <div className="ab-stack">
        {error && <p className="form-error" role="alert">{error}</p>}
        {!rows && !error && <Loading variant="list" />}
        {rows && <span className="muted ai-small">{total} conversa(s) lida(s) pela MAVI no período</span>}
        <ul className="ab-list">
          {(rows ?? []).map((c) => (
            <li key={c.conversation_id} className="ab-row">
              <button type="button" className="ab-row-main ab-row-button" onClick={() => onOpen(c.conversation_id)}>
                <span className="ab-row-title">
                  <strong>{c.contact_name || c.phone || "Contato"}</strong>
                  <span className="muted">{when(c.activity_at)}</span>
                </span>
                <span className="muted ab-clamp">{c.summary}</span>
              </button>
              <span className="ab-badges">
                <span className={`ab-badge ${OUTCOME_TONE[c.outcome] === "good" ? "on" : OUTCOME_TONE[c.outcome] === "bad" ? "danger" : ""}`}>{OUTCOME_LABEL[c.outcome]}</span>
              </span>
            </li>
          ))}
        </ul>
        {rows && rows.length < total && (
          <Button
            type="button"
            className="btn secondary"
            loading={loadingMore}
            onClick={() => {
              setLoadingMore(true);
              fetchPage(rows.length)
                .then((r) => setRows([...rows, ...r.conversations]))
                .catch((e) => setError(errorOf(e)))
                .finally(() => setLoadingMore(false));
            }}
          >
            Carregar mais
          </Button>
        )}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ configurar
const SAMPLES = [0, 5, 10, 20, 30, 50, 100];

function SettingsModal({
  company,
  agentId,
  canEdit,
  report,
  notify,
  onClose,
  onSaved,
}: {
  company: string;
  agentId: string;
  canEdit: boolean;
  report: AgentReport | null;
  notify: (m: string) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [s, setS] = useState<InsightsSettings | null>(null);
  const [sample, setSample] = useState(20);
  const [weekly, setWeekly] = useState(true);
  const [people, setPeople] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    agentOp<InsightsSettings>(company, agentId, "insights-settings")
      .then((r) => {
        setS(r);
        setSample(r.sample_percent);
        setWeekly(r.weekly.weekly);
        setPeople(r.weekly.recipients);
      })
      .catch((e) => setError(errorOf(e)));
  }, [company, agentId]);

  // Custo por conversa lida: o que a amostra custou no período (ou uma estimativa).
  const perConversation = report && report.insights.analyzed ? report.metrics.insights_cost_usd / report.insights.analyzed : 0.002;
  const conversations = report?.metrics.conversations ?? 0;
  const days = report?.days ?? 30;
  const monthly = conversations ? ((conversations * sample) / 100) * perConversation * (30 / days) : null;
  const editable = canEdit && !!s?.can_edit;

  const save = async () => {
    setSaving(true);
    try {
      await agentOp(company, agentId, "insights-settings-set", { sample_percent: sample, weekly, recipients: people });
      notify("Configuração salva.");
      onSaved();
      onClose();
    } catch (e) {
      notify(errorOf(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Configurar insights" onClose={onClose} busy={saving}>
      <div className="ab-form">
        {error && <p className="form-error" role="alert">{error}</p>}
        {!s && !error && <Loading variant="list" />}
        {s && (
          <>
            <label className="ab-field">
              <span className="ab-label">Quanto das conversas a MAVI lê</span>
              <Select value={String(sample)} aria-label="Amostra" disabled={!editable} onValueChange={(v) => setSample(Number(v))}>
                {[...new Set([...SAMPLES, s.sample_percent])]
                  .sort((a, b) => a - b)
                  .map((n) => (
                    <SelectOption key={n} value={String(n)}>
                      {n === 0 ? "Nenhuma (desligado)" : n === 100 ? "Todas" : `${n}% das conversas`}
                    </SelectOption>
                  ))}
              </Select>
              <small className="muted">
                A MAVI lê cada conversa da amostra quando ela esfria (3 h sem mensagem) para tirar resultados, motivos, objeções e falhas.
                {monthly != null && sample > 0 && ` Neste ritmo, cerca de ${usd(monthly)} por mês.`} As lacunas do treinamento valem para todas as conversas,
                sem custo a mais.
              </small>
            </label>
            <div className="ab-field">
              <span className="ab-check">
                <Checkbox id="ai-weekly" checked={weekly} disabled={!editable} onCheckedChange={(c) => setWeekly(c === true)} />
                <label htmlFor="ai-weekly">Resumo semanal na Caixa de entrada</label>
              </span>
              <small className="muted">
                Toda segunda de manhã: os números da semana anterior e a Leitura da MAVI.
                {s.weekly.last_sent && ` Último enviado: semana de ${dayMonth(s.weekly.last_sent)}.`}
              </small>
            </div>
            {weekly && (
              <fieldset className="ab-field ai-people" disabled={!editable}>
                <legend className="ab-label">Quem recebe</legend>
                {!s.weekly.custom && <small className="muted">Padrão: quem editou o agente por último. Marque outras pessoas que veem o cliente.</small>}
                <div className="ai-people-list">
                  {s.weekly.candidates.map((p) => (
                    <span key={p.id} className="ab-check compact">
                      <Checkbox
                        id={`ai-p-${p.id}`}
                        checked={people.includes(p.id)}
                        onCheckedChange={(c) => setPeople((list) => (c === true ? [...list, p.id] : list.filter((x) => x !== p.id)))}
                      />
                      <label htmlFor={`ai-p-${p.id}`}>{p.name}</label>
                    </span>
                  ))}
                </div>
                {!people.length && <small className="ab-error">Ninguém marcado: o resumo não vai para ninguém.</small>}
              </fieldset>
            )}
            {!editable && <p className="ab-notice">Só quem edita este produto do cliente no Drive muda estas opções.</p>}
            <div className="ab-toolbar">
              <span />
              {editable && (
                <Button type="button" className="btn primary" loading={saving} onClick={() => void save()}>
                  Salvar
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheck, FlaskConical, Play, Square, Target, TriangleAlert, UsersRound } from "lucide-react";
import { Modal } from "./components";
import { Button, Checkbox, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import {
  agentOp,
  errorOf,
  money,
  OUTCOME_LABEL,
  percent,
  TEST_ISSUE_LABEL,
  TEST_KIND_LABEL,
  TEST_STATUS_LABEL,
  testSettings,
  when,
  type ChatMessage,
  type TestConversation,
  type TestLimits,
  type TestRun,
  type TestRunsResult,
} from "./agent-builder";

/**
 * Agentes MAVI › Leads simulados: baterias de conversas entre o agente e
 * leads criados pela MAVI pelo contexto do agente (interessados,
 * desinteressados, céticos, preço, fora do perfil…), para achar o que o
 * treinamento não cobre antes da produção. Nada vai ao WhatsApp; cada
 * conversa é avaliada; as lacunas vão para as Lacunas (origem: teste).
 */

const RUNNING = new Set<TestRun["status"]>(["queued", "running"]);
/** Enquanto alguma bateria roda, a tela confere de 10 em 10 segundos (até 15 minutos). */
const REFRESH_MS = 10_000;
const REFRESH_MAX = 90;

function usePolling(active: boolean, tick: () => void) {
  const count = useRef(0);
  useEffect(() => {
    if (!active) {
      count.current = 0;
      return;
    }
    const t = window.setInterval(() => {
      if (++count.current > REFRESH_MAX) return window.clearInterval(t);
      tick();
    }, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [active, tick]);
}

const score = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("pt-BR", { maximumFractionDigits: 1 }));
const problems = (r: TestRun) => Object.values(r.summary?.issues ?? {}).reduce((n, x) => n + x.n, 0);

export function TestRunsPanel({
  company,
  agentId,
  canEdit,
  published,
  notify,
  openRun,
}: {
  company: string;
  agentId: string;
  canEdit: boolean;
  published: number | null;
  notify: (m: string) => void;
  /** Bateria aberta pelo link (?bateria=). */
  openRun?: string | null;
}) {
  const [data, setData] = useState<TestRunsResult | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(openRun ?? null);
  const [count, setCount] = useState(6);
  const [profiles, setProfiles] = useState<string[]>([]);
  const [focus, setFocus] = useState("");
  const [use, setUse] = useState<"draft" | "published">("draft");
  const [starting, setStarting] = useState(false);

  const load = useCallback(() => {
    agentOp<TestRunsResult>(company, agentId, "test-runs", { limit: 30 })
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((e) => setError(errorOf(e)));
  }, [company, agentId]);
  useEffect(load, [load]);
  usePolling(!!data?.runs.some((r) => RUNNING.has(r.status)), load);

  const limits = data?.limits;
  const left = limits ? Math.max(0, limits.monthly_cap_usd - (data?.month_cost_usd ?? 0)) : 0;
  const start = async () => {
    setStarting(true);
    try {
      const r = await agentOp<{ runs: string[] }>(company, agentId, "test-run-start", { kind: "manual", use, conversations: count, profiles, focus });
      notify("Bateria começou: os leads simulados estão conversando com o agente.");
      load();
      if (r.runs[0]) setOpen(r.runs[0]);
    } catch (e) {
      notify(errorOf(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="ab-stack">
      <p className="ab-section-intro muted">
        A MAVI cria leads pelo contexto do agente (interessados, desinteressados, céticos, com objeção de preço, fora do perfil…) e eles conversam com o
        agente. Nada vai ao WhatsApp. Cada conversa é avaliada e o que o treinamento não cobre vai para as Lacunas.
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!data && !error && <Loading variant="list" />}
      {data && limits && (
        <>
          {canEdit && (
            <section className="ab-section">
              <h3>
                <FlaskConical size={15} aria-hidden="true" /> Nova bateria
              </h3>
              <div className="ab-grid">
                <label className="ab-field">
                  <span className="ab-label">Quantas conversas</span>
                  <Select value={String(Math.min(count, limits.max_conversations))} aria-label="Quantas conversas" onValueChange={(v) => setCount(Number(v))}>
                    {Array.from({ length: limits.max_conversations }, (_, i) => i + 1).map((n) => (
                      <SelectOption key={n} value={String(n)}>
                        {n} {n === 1 ? "conversa" : "conversas"}
                      </SelectOption>
                    ))}
                  </Select>
                  <small className="muted">
                    Até {limits.max_turns} trocas cada · teto de {money(limits.run_cap_usd, "usd")} por bateria · {money(left, "usd")} livres no mês.
                  </small>
                </label>
                <label className="ab-field">
                  <span className="ab-label">Qual versão</span>
                  <Select value={use} aria-label="Versão" onValueChange={(v) => setUse(v as "draft" | "published")}>
                    <SelectOption value="draft">Rascunho salvo</SelectOption>
                    {published && <SelectOption value="published">{`Publicada (v${published})`}</SelectOption>}
                  </Select>
                  <small className="muted">O rascunho testa o que você está mudando, antes de publicar.</small>
                </label>
              </div>
              <div className="ab-field">
                <span className="ab-label">Perfis dos leads</span>
                <div className="ab-chips" role="group" aria-label="Perfis">
                  <button type="button" className={!profiles.length ? "selected" : ""} onClick={() => setProfiles([])}>
                    A MAVI escolhe
                  </button>
                  {data.profiles.map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      title={p.hint}
                      className={profiles.includes(p.key) ? "selected" : ""}
                      onClick={() => setProfiles((cur) => (cur.includes(p.key) ? cur.filter((x) => x !== p.key) : [...cur, p.key]))}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <label className="ab-field wide">
                <span className="ab-label">Foco (opcional)</span>
                <Textarea
                  rows={2}
                  value={focus}
                  maxLength={1000}
                  placeholder="Ex.: leads que perguntam sobre integrações e pagamento parcelado"
                  onChange={(e) => setFocus(e.target.value)}
                />
              </label>
              <div className="ab-toolbar">
                <span className="muted ai-small">Custa por volta de {money(0.02 * Math.min(count, limits.max_conversations), "usd")} (cerca de US$ 0,02 por conversa).</span>
                <Button type="button" className="btn primary" loading={starting} disabled={left <= 0.01} onClick={() => void start()}>
                  <Play size={15} aria-hidden="true" /> Rodar bateria
                </Button>
              </div>
              {left <= 0.01 && <p className="ab-notice warn">O teto de testes do mês deste agente já foi usado (Painel da MAVI › Agentes MAVI).</p>}
            </section>
          )}

          <div className="ab-toolbar">
            <span className="muted ai-small">
              Gasto com testes no mês: {money(data.month_cost_usd, "usd")} de {money(limits.monthly_cap_usd, "usd")}
              {limits.scheduled_enabled ? ` · bateria periódica a cada ${limits.scheduled_every_days} dia(s) na versão publicada` : " · bateria periódica desligada"}
            </span>
            <button type="button" className="agent-link-btn" onClick={load}>
              Atualizar
            </button>
          </div>
          {!data.runs.length && <p className="muted">Nenhuma bateria ainda.</p>}
          <ul className="ab-list">
            {data.runs.map((r) => (
              <li key={r.id} className="ab-row">
                <button type="button" className="ab-row-main ab-row-button" onClick={() => setOpen(r.id)}>
                  <span className="ab-row-title">
                    <strong>
                      {TEST_KIND_LABEL[r.kind]} · {r.agent_version ? `v${r.agent_version}` : "rascunho"}
                    </strong>
                    <span className="muted">
                      {when(r.created_at)} · {r.created_by}
                    </span>
                  </span>
                  <span className="muted">
                    {RUNNING.has(r.status)
                      ? `${r.finished ?? 0} de ${r.conversations} conversa(s) prontas…`
                      : r.summary
                        ? `Nota ${score(r.summary.score)} · objetivo em ${percent(r.summary.goal_rate)} · ${problems(r)} problema(s) · ${r.summary.gaps} lacuna(s) · ${money(r.cost_usd, "usd")}`
                        : r.error || r.stop_reason || ""}
                  </span>
                </button>
                <span className="ab-badges">
                  <span className={`ab-badge ${r.status === "done" ? "on" : r.status === "error" ? "danger" : r.status === "stopped" ? "warn" : ""}`}>
                    {TEST_STATUS_LABEL[r.status]}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {open && <RunModal company={company} agentId={agentId} runId={open} canEdit={canEdit} notify={notify} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

// ------------------------------------------------------------ uma bateria
function RunModal({
  company,
  agentId,
  runId,
  canEdit,
  notify,
  onClose,
  onChanged,
}: {
  company: string;
  agentId: string;
  runId: string;
  canEdit: boolean;
  notify: (m: string) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<{ run: TestRun; conversations: TestConversation[] } | null>(null);
  const [error, setError] = useState("");
  const [conv, setConv] = useState<TestConversation | null>(null);
  const load = useCallback(() => {
    agentOp<{ run: TestRun; conversations: TestConversation[] }>(company, agentId, "test-run", { run: runId })
      .then(setData)
      .catch((e) => setError(errorOf(e)));
  }, [company, agentId, runId]);
  useEffect(load, [load]);
  usePolling(!!data && RUNNING.has(data.run.status), load);
  const r = data?.run;
  const s = r?.summary;
  return (
    <Modal title={r ? `Bateria ${TEST_KIND_LABEL[r.kind].toLowerCase()} · ${r.agent_version ? `v${r.agent_version}` : "rascunho"}` : "Bateria"} onClose={onClose} wide>
      <div className="ab-stack">
        {error && <p className="form-error" role="alert">{error}</p>}
        {!data && !error && <Loading variant="list" />}
        {r && data && (
          <>
            <div className="ab-toolbar">
              <span className="muted ai-small">
                {when(r.created_at)} · {r.created_by} · {r.conversations} conversa(s), até {r.max_turns} trocas · teto {money(r.cost_cap_usd, "usd")} · gasto{" "}
                {money(r.cost_usd || data.conversations.reduce((t, c) => t + Number(c.cost_usd), 0), "usd")}
                {r.focus ? ` · foco: ${r.focus}` : ""}
              </span>
              {canEdit && RUNNING.has(r.status) && (
                <Button
                  type="button"
                  className="btn secondary"
                  onClick={() =>
                    agentOp(company, agentId, "test-run-stop", { run: r.id })
                      .then(() => {
                        notify("Bateria parada.");
                        load();
                        onChanged();
                      })
                      .catch((e) => notify(errorOf(e)))
                  }
                >
                  <Square size={14} aria-hidden="true" /> Parar
                </Button>
              )}
            </div>
            {r.status === "error" && <p className="ab-notice warn">A bateria falhou: {r.error}</p>}
            {r.stop_reason && <p className="ab-notice warn">Parada: {r.stop_reason}.</p>}
            {s && !s.concluding && (
              <>
                <div className="ab-kpis">
                  <div>
                    <span className="muted">Nota média</span>
                    <strong>{score(s.score)} / 10</strong>
                  </div>
                  <div>
                    <span className="muted">Objetivo atingido</span>
                    <strong>{percent(s.goal_rate)}</strong>
                  </div>
                  <div>
                    <span className="muted">Problemas</span>
                    <strong>{problems(r)}</strong>
                    {s.severe > 0 && <small className="ab-error">{s.severe} grave(s)</small>}
                  </div>
                  <div>
                    <span className="muted">Lacunas achadas</span>
                    <strong>{s.gaps}</strong>
                  </div>
                </div>
                {(s.conclusion || s.actions?.length) && (
                  <section className="ab-section ai-reading">
                    <h3>O que a MAVI recomenda</h3>
                    {s.conclusion && <p className="ai-lead">{s.conclusion}</p>}
                    <ul className="ai-points">
                      {(s.actions ?? []).map((a, i) => (
                        <li key={i} className="ai-point action">
                          <Target size={16} aria-hidden="true" />
                          <div>
                            <strong>{a.title}</strong>
                            <p>{a.text}</p>
                            {a.where && <span className="muted ai-small">Onde: {WHERE[a.where] ?? a.where}</span>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </>
            )}
            <ul className="ab-list">
              {data.conversations.map((c) => (
                <li key={c.id} className="ab-row">
                  <button type="button" className="ab-row-main ab-row-button" disabled={!c.conversation_id} onClick={() => setConv(c)}>
                    <span className="ab-row-title">
                      <UsersRound size={14} aria-hidden="true" />
                      <strong>{c.persona.nome}</strong>
                      <span className="muted">{c.persona.descricao.slice(0, 90)}</span>
                    </span>
                    <span className="muted">
                      {c.verdict
                        ? `Nota ${c.verdict.score} · ${OUTCOME_LABEL[c.verdict.outcome] ?? c.verdict.outcome} · ${c.verdict.summary}`
                        : c.status === "error"
                          ? `Falhou: ${c.error}`
                          : c.status === "skipped"
                            ? "Não rodou (bateria parada)"
                            : c.status === "running"
                              ? "Conversando…"
                              : "Na fila"}
                    </span>
                  </button>
                  <span className="ab-badges">
                    {c.verdict && c.verdict.issues.length > 0 && <span className="ab-badge danger">{c.verdict.issues.length} problema(s)</span>}
                    {c.verdict && c.verdict.gaps.length > 0 && <span className="ab-badge warn">{c.verdict.gaps.length} lacuna(s)</span>}
                    {c.verdict?.goal_reached && <span className="ab-badge on">Objetivo</span>}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {conv && <TestConversationModal company={company} agentId={agentId} conv={conv} onClose={() => setConv(null)} />}
    </Modal>
  );
}

const WHERE: Record<string, string> = { instrucoes: "Instruções", conhecimento: "Conhecimento", comportamento: "Comportamento", integracoes: "Integrações" };

function TestConversationModal({ company, agentId, conv, onClose }: { company: string; agentId: string; conv: TestConversation; onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!conv.conversation_id) return;
    agentOp<{ messages: ChatMessage[] }>(company, agentId, "conversation-messages", { conversation: conv.conversation_id })
      .then((r) => setMessages(r.messages))
      .catch((e) => setError(errorOf(e)));
  }, [company, agentId, conv.conversation_id]);
  const v = conv.verdict;
  const p = conv.persona;
  return (
    <Modal title={`Lead simulado: ${p.nome}`} onClose={onClose} wide>
      <div className="ab-stack">
        <section className="ab-section">
          <dl className="ai-facts">
            <dt>Quem é</dt>
            <dd>{p.descricao}</dd>
            <dt>O que queria</dt>
            <dd>{p.objetivo}</dd>
            {p.objecoes.length > 0 && (
              <>
                <dt>Objeções</dt>
                <dd>{p.objecoes.join(" · ")}</dd>
              </>
            )}
          </dl>
        </section>
        {v && (
          <section className="ab-section ai-conv-reading">
            <div className="ab-badges">
              <span className={`ab-badge ${v.score >= 8 ? "on" : v.score <= 5 ? "danger" : "warn"}`}>Nota {v.score}</span>
              <span className={`ab-badge ${v.goal_reached ? "on" : ""}`}>{v.goal_reached ? "Objetivo atingido" : "Objetivo não atingido"}</span>
              <span className="ab-badge">{OUTCOME_LABEL[v.outcome] ?? v.outcome}</span>
            </div>
            <p className="ai-lead">{v.summary}</p>
            {v.issues.length > 0 && (
              <ul className="ai-plain">
                {v.issues.map((x, i) => (
                  <li key={i}>
                    <TriangleAlert size={13} aria-hidden="true" className={x.severity >= 3 ? "ab-error" : ""} />{" "}
                    <strong>{TEST_ISSUE_LABEL[x.type] ?? x.type}:</strong> {x.detail}
                    {x.quote && <span className="muted"> — “{x.quote}”</span>}
                  </li>
                ))}
              </ul>
            )}
            {v.gaps.length > 0 && (
              <p className="ai-small">
                <strong>Lacunas (já nas Lacunas, origem teste):</strong> {v.gaps.map((g) => g.text).join(" · ")}
              </p>
            )}
            {v.strengths.length > 0 && (
              <p className="ai-small muted">
                <CircleCheck size={13} aria-hidden="true" /> {v.strengths.join(" · ")}
              </p>
            )}
          </section>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        {!messages && !error && <Loading variant="list" />}
        <div className="ab-chat static">
          {(messages ?? []).map((m) => (
            <div key={m.id} className={`ab-bubble ${m.role === "user" ? "user" : m.role === "assistant" ? "agent" : "note"}`}>
              {m.content}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ antes de publicar
/** Na janela de publicar: a mesma bateria rápida no rascunho e na publicada, lado a lado. */
export function PublishTestBox({ company, agentId, published, saveFirst }: { company: string; agentId: string; published: number | null; saveFirst: () => Promise<boolean> }) {
  const [runs, setRuns] = useState<TestRun[] | null>(null);
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    if (!ids.length) return;
    Promise.all(ids.map((id) => agentOp<{ run: TestRun }>(company, agentId, "test-run", { run: id })))
      .then((r) => setRuns(r.map((x) => x.run)))
      .catch((e) => setError(errorOf(e)));
  }, [company, agentId, ids]);
  useEffect(load, [load]);
  usePolling(!!runs?.some((r) => RUNNING.has(r.status)) || (ids.length > 0 && !runs), load);
  const start = async () => {
    setBusy(true);
    setError("");
    try {
      if (!(await saveFirst())) return;
      const r = await agentOp<{ runs: string[] }>(company, agentId, "test-run-start", { kind: "publish" });
      setIds(r.runs);
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setBusy(false);
    }
  };
  const col = (r: TestRun | undefined, label: string) => (
    <div className="pt-col">
      <strong>{label}</strong>
      {!r ? (
        <span className="muted">—</span>
      ) : RUNNING.has(r.status) || r.summary?.concluding ? (
        <span className="muted">
          {r.finished ?? 0} de {r.conversations} conversa(s)…
        </span>
      ) : r.summary ? (
        <span>
          Nota {score(r.summary.score)} · objetivo {percent(r.summary.goal_rate)}
          <br />
          {problems(r)} problema(s) · {r.summary.gaps} lacuna(s)
        </span>
      ) : (
        <span className="muted">{TEST_STATUS_LABEL[r.status]}</span>
      )}
    </div>
  );
  const draft = runs?.find((r) => !r.agent_version);
  const pub = runs?.find((r) => r.agent_version);
  return (
    <div className="ab-notice pt-box">
      <span>
        <FlaskConical size={15} aria-hidden="true" /> Teste antes: os mesmos leads simulados conversam com o rascunho
        {published ? ` e com a versão publicada (v${published})` : ""} para comparar.
      </span>
      {!ids.length ? (
        <Button type="button" className="btn secondary" loading={busy} onClick={() => void start()}>
          Rodar bateria rápida
        </Button>
      ) : (
        <div className="pt-compare">
          {col(draft, "Rascunho")}
          {published ? col(pub, `Publicada (v${published})`) : null}
        </div>
      )}
      {error && <span className="ab-error">{error}</span>}
    </div>
  );
}

// ------------------------------------------------------------ Painel da MAVI: tetos
export function TestLimitsSection({ company, notify }: { company: string; notify: (m: string) => void }) {
  const [s, setS] = useState<TestLimits | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    testSettings(company)
      .then(setS)
      .catch((e) => setError(errorOf(e)));
  }, [company]);
  const edit = !!s?.can_edit;
  const num = (k: keyof TestLimits, label: string, hint: string, opts: { min: number; max: number; step?: number }) => (
    <label className="ab-field">
      <span className="ab-label">{label}</span>
      <Input
        type="number"
        min={opts.min}
        max={opts.max}
        step={opts.step ?? 1}
        value={String(s?.[k] ?? "")}
        disabled={!edit}
        onChange={(e) => setS((cur) => (cur ? { ...cur, [k]: Number(e.target.value) } : cur))}
      />
      <small className="muted">{hint}</small>
    </label>
  );
  const save = async () => {
    if (!s) return;
    setSaving(true);
    try {
      const { can_edit: _c, updated_at: _u, ...settings } = s;
      setS(await testSettings(company, settings));
      notify("Tetos dos testes salvos.");
    } catch (e) {
      notify(errorOf(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="ab-section">
      <h3>Testes com leads simulados</h3>
      <p className="muted ai-small">
        Os tetos valem para todos os agentes da empresa: cada bateria para quando chega no teto dela, e um agente não passa do teto do mês. Uma conversa de teste
        custa por volta de US$ 0,02.
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!s && !error && <Loading variant="list" />}
      {s && (
        <>
          <div className="ab-grid">
            {num("max_conversations", "Conversas por bateria (máx.)", "O máximo que alguém pode pedir numa bateria.", { min: 1, max: 50 })}
            {num("max_turns", "Trocas por conversa", "Quantas vezes o lead e o agente falam, no máximo.", { min: 2, max: 20 })}
            {num("run_cap_usd", "Teto por bateria (US$)", "A bateria para quando gastar isto.", { min: 0.1, max: 100, step: 0.1 })}
            {num("monthly_cap_usd", "Teto por agente no mês (US$)", "Somando todas as baterias do agente.", { min: 1, max: 1000, step: 1 })}
            {num("publish_conversations", "Bateria antes de publicar", "Conversas no rascunho e na publicada, cada.", { min: 1, max: 20 })}
          </div>
          <div className="ab-field">
            <span className="ab-check">
              <Checkbox id="tl-scheduled" checked={s.scheduled_enabled} disabled={!edit} onCheckedChange={(c) => setS({ ...s, scheduled_enabled: c === true })} />
              <label htmlFor="tl-scheduled">Bateria periódica na versão publicada (avisa na Caixa de entrada se achar problema)</label>
            </span>
          </div>
          {s.scheduled_enabled && (
            <div className="ab-grid">
              {num("scheduled_every_days", "A cada quantos dias", "Para cada agente publicado com caixa ligada.", { min: 1, max: 60 })}
              {num("scheduled_conversations", "Conversas da periódica", "Dentro do máximo por bateria.", { min: 1, max: 30 })}
            </div>
          )}
          {edit ? (
            <div className="ab-toolbar">
              <span />
              <Button type="button" className="btn primary" loading={saving} onClick={() => void save()}>
                Salvar tetos
              </Button>
            </div>
          ) : (
            <p className="muted ai-small">Só administradores e gestores mudam os tetos.</p>
          )}
        </>
      )}
    </section>
  );
}

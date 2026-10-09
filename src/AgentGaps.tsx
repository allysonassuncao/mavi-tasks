import { useCallback, useEffect, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Ban, BookPlus, Combine, MessageCircleQuestion, RotateCcw, ShieldAlert, Sparkles } from "lucide-react";
import { Modal } from "./components";
import { Button, Input, Loading, Textarea } from "./ui";
import {
  agentOp,
  deltaText,
  errorOf,
  lastDays,
  OBJECTION_CATEGORY_LABEL,
  percent,
  when,
  type GapDetail,
  type GapsResult,
  type GapSuggestion,
  type GapTopic,
} from "./agent-builder";
import { ConversationInsightModal } from "./AgentConversationModal";

/**
 * Agentes MAVI › Lacunas: o que os leads perguntaram ou objetaram e o
 * treinamento não cobria. O próprio agente avisa na hora de responder;
 * perguntas parecidas viram um tema; a MAVI sugere a resposta e, aplicada,
 * ela entra no Conhecimento como pergunta frequente.
 */

const PERIODS = [
  { days: 7, label: "7 dias" },
  { days: 30, label: "30 dias" },
  { days: 90, label: "90 dias" },
];
const STATUSES: { id: GapTopic["status"] | "all"; label: string }[] = [
  { id: "open", label: "Abertas" },
  { id: "trained", label: "No treinamento" },
  { id: "ignored", label: "Ignoradas" },
  { id: "all", label: "Todas" },
];
const KINDS: { id: GapTopic["kind"] | "all"; label: string }[] = [
  { id: "all", label: "Perguntas e objeções" },
  { id: "question", label: "Perguntas" },
  { id: "objection", label: "Objeções" },
];

export function GapsPanel({
  company,
  agentId,
  canEdit,
  notify,
  onTrained,
}: {
  company: string;
  agentId: string;
  canEdit: boolean;
  notify: (m: string) => void;
  /** Uma resposta entrou no Conhecimento (a aba recarrega). */
  onTrained: () => void;
}) {
  const [days, setDays] = useState(30);
  const [status, setStatus] = useState<(typeof STATUSES)[number]["id"]>("open");
  const [kind, setKind] = useState<(typeof KINDS)[number]["id"]>("all");
  const [data, setData] = useState<GapsResult | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    const p = lastDays(days);
    agentOp<GapsResult>(company, agentId, "gaps", { ...p, status: status === "all" ? undefined : status, kind: kind === "all" ? undefined : kind })
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((e) => setError(errorOf(e)));
  }, [company, agentId, days, status, kind]);
  useEffect(load, [load]);

  const s = data?.stats;
  const ps = data?.previous_stats;
  const coverageDelta = s?.coverage != null && ps?.coverage != null ? Math.round((s.coverage - ps.coverage) * 100) : null;

  return (
    <div className="ab-stack">
      <p className="ab-section-intro muted">
        Quando o lead pergunta algo ou faz uma objeção que o treinamento não cobre, o próprio agente avisa. Perguntas parecidas viram um tema: a MAVI
        sugere a resposta e você inclui no treinamento com um clique.
      </p>
      <div className="ab-toolbar">
        <div className="ab-chips" role="group" aria-label="Período">
          {PERIODS.map((p) => (
            <button key={p.days} type="button" className={days === p.days ? "selected" : ""} onClick={() => setDays(p.days)}>
              {p.label}
            </button>
          ))}
        </div>
        <button type="button" className="agent-link-btn" onClick={load}>
          Atualizar
        </button>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      {!data && !error && <Loading variant="table" />}
      {data && s && (
        <>
          <div className="ab-kpis">
            <div title="Das respostas do agente no período, quantas não tiveram nenhuma lacuna.">
              <span className="muted">Cobertura do treinamento</span>
              <strong>
                {percent(s.coverage)}
                {coverageDelta != null && coverageDelta !== 0 && (
                  <small className={`ai-delta ${coverageDelta > 0 ? "up" : "down"}`}>
                    {coverageDelta > 0 ? "+" : "−"}
                    {Math.abs(coverageDelta)} p.p.
                  </small>
                )}
              </strong>
            </div>
            <div>
              <span className="muted">Lacunas no período</span>
              <strong>
                {s.gaps.toLocaleString("pt-BR")} <small className="ai-delta">{deltaText(s.gaps, ps?.gaps ?? 0)}</small>
              </strong>
            </div>
            <div>
              <span className="muted">Temas novos</span>
              <strong>{s.new_topics.toLocaleString("pt-BR")}</strong>
            </div>
            <div>
              <span className="muted">Respostas no período</span>
              <strong>{s.turns.toLocaleString("pt-BR")}</strong>
            </div>
          </div>

          <div className="ab-toolbar">
            <div className="ab-chips" role="group" aria-label="Situação">
              {STATUSES.map((x) => (
                <button key={x.id} type="button" className={status === x.id ? "selected" : ""} onClick={() => setStatus(x.id)}>
                  {x.label}
                </button>
              ))}
            </div>
            <div className="ab-chips" role="group" aria-label="Tipo">
              {KINDS.map((x) => (
                <button key={x.id} type="button" className={kind === x.id ? "selected" : ""} onClick={() => setKind(x.id)}>
                  {x.label}
                </button>
              ))}
            </div>
          </div>

          {data.pending > 0 && <p className="muted ai-small">{data.pending} lacuna(s) recentes ainda sendo agrupadas (leva até 2 minutos).</p>}
          {!data.topics.length && (
            <p className="muted">
              {status === "open"
                ? "Nenhuma lacuna aberta. Quando o agente encontrar algo que o treinamento não cobre, aparece aqui."
                : "Nada por aqui neste filtro."}
            </p>
          )}
          <ul className="ab-list">
            {data.topics.map((t) => (
              <li key={t.id} className={`ab-row ${t.status === "ignored" ? "off" : ""}`}>
                <button type="button" className="ab-row-main ab-row-button" onClick={() => setOpen(t.id)}>
                  <span className="ab-row-title">
                    {t.kind === "objection" ? <ShieldAlert size={15} aria-hidden="true" /> : <MessageCircleQuestion size={15} aria-hidden="true" />}
                    <strong>{t.title}</strong>
                  </span>
                  <span className="muted">
                    {t.kind === "objection" ? `Objeção${t.category ? ` · ${OBJECTION_CATEGORY_LABEL[t.category] ?? t.category}` : ""}` : "Pergunta"} ·{" "}
                    {t.conversations_in_period || t.conversations} conversa(s) · última em {when(t.last_seen_at)}
                    {t.status === "trained" && t.after_trained > 0 && ` · voltou ${t.after_trained}x depois do treinamento`}
                  </span>
                </button>
                <span className="ab-badges">
                  <Trend cur={t.in_period} prev={t.in_previous} />
                  {t.status === "trained" && <span className={`ab-badge ${t.after_trained ? "warn" : "on"}`}>No treinamento</span>}
                  {t.status === "ignored" && <span className="ab-badge">Ignorada</span>}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {open && (
        <TopicModal
          company={company}
          agentId={agentId}
          topicId={open}
          canEdit={canEdit}
          notify={notify}
          onClose={() => setOpen(null)}
          onChanged={(trained) => {
            load();
            if (trained) onTrained();
          }}
          onOpenTopic={setOpen}
        />
      )}
    </div>
  );
}

function Trend({ cur, prev }: { cur: number; prev: number }) {
  const up = cur > prev;
  return (
    <span className="ai-trend" title={`${cur} no período · ${prev} no período anterior`}>
      <strong>{cur}x</strong>
      {cur !== prev &&
        (up ? <ArrowUpRight size={14} className="ai-up" aria-label="subindo" /> : <ArrowDownRight size={14} className="ai-down" aria-label="caindo" />)}
    </span>
  );
}

function TopicModal({
  company,
  agentId,
  topicId,
  canEdit,
  notify,
  onClose,
  onChanged,
  onOpenTopic,
}: {
  company: string;
  agentId: string;
  topicId: string;
  canEdit: boolean;
  notify: (m: string) => void;
  onClose: () => void;
  onChanged: (trained?: boolean) => void;
  onOpenTopic: (id: string) => void;
}) {
  const [d, setD] = useState<GapDetail | null>(null);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [suggestion, setSuggestion] = useState<GapSuggestion | null>(null);
  const [busy, setBusy] = useState<"" | "suggest" | "apply" | "status" | "title" | "merge">("");
  const [conversation, setConversation] = useState<string | null>(null);

  const load = useCallback(() => {
    agentOp<GapDetail>(company, agentId, "gap", { topic: topicId })
      .then((r) => {
        setD(r);
        setTitle(r.topic.title);
        const s = r.topic.suggestion;
        setSuggestion(s);
        setQuestion(s?.question ?? r.topic.title);
        setAnswer(s?.answer ?? "");
      })
      .catch((e) => setError(errorOf(e)));
  }, [company, agentId, topicId]);
  useEffect(load, [load]);

  const act = async (what: typeof busy, run: () => Promise<unknown>, done?: string, trained = false) => {
    setBusy(what);
    try {
      await run();
      if (done) notify(done);
      onChanged(trained);
      return true;
    } catch (e) {
      notify(errorOf(e));
      return false;
    } finally {
      setBusy("");
    }
  };

  const suggest = () =>
    act("suggest", async () => {
      const r = await agentOp<{ suggestion: GapSuggestion }>(company, agentId, "gap-suggest", { topic: topicId });
      setSuggestion(r.suggestion);
      setQuestion(r.suggestion.question);
      setAnswer(r.suggestion.answer);
    });
  const missing = /\[PREENCHER/i.test(answer);
  const t = d?.topic;

  return (
    <Modal title={t ? (t.kind === "objection" ? "Objeção sem orientação" : "Pergunta sem resposta") : "Lacuna"} onClose={onClose} wide busy={!!busy}>
      <div className="ab-stack">
        {error && <p className="form-error" role="alert">{error}</p>}
        {!d && !error && <Loading variant="list" />}
        {d && t && (
          <>
            <div className="ab-head">
              <div className="ab-stack ai-tight">
                {canEdit ? (
                  <span className="ai-title-edit">
                    <Input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Título do tema" maxLength={300} />
                    {title.trim() && title.trim() !== t.title && (
                      <Button
                        type="button"
                        className="btn secondary"
                        loading={busy === "title"}
                        onClick={() => void act("title", () => agentOp(company, agentId, "gap-update", { topic: topicId, title }), "Título salvo.").then(load)}
                      >
                        Salvar título
                      </Button>
                    )}
                  </span>
                ) : (
                  <h3 className="ab-title">{t.title}</h3>
                )}
                <span className="muted ai-small">
                  {t.occurrences} vez(es) em {t.conversations} conversa(s) · desde {when(t.first_seen_at)}
                  {t.title_source === "mavi" && " · título dado pela MAVI"}
                </span>
              </div>
              {canEdit && (
                <span className="ab-row-actions">
                  {t.status === "open" ? (
                    <Button
                      type="button"
                      className="btn secondary"
                      loading={busy === "status"}
                      onClick={() => void act("status", () => agentOp(company, agentId, "gap-update", { topic: topicId, status: "ignored" }), "Lacuna ignorada.").then(onClose)}
                    >
                      <Ban size={15} aria-hidden="true" /> Ignorar
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      className="btn secondary"
                      loading={busy === "status"}
                      onClick={() => void act("status", () => agentOp(company, agentId, "gap-update", { topic: topicId, status: "open" }), "Lacuna reaberta.").then(load)}
                    >
                      <RotateCcw size={15} aria-hidden="true" /> Reabrir
                    </Button>
                  )}
                </span>
              )}
            </div>

            {t.status === "trained" && (
              <p className={`ab-notice ${t.after_trained ? "warn" : ""}`}>
                Incluída no treinamento em {when(t.trained_at)}
                {t.trained_by ? ` por ${t.trained_by}` : ""}.
                {t.after_trained
                  ? ` Apareceu de novo ${t.after_trained} vez(es) depois: vale revisar a resposta no Conhecimento.`
                  : " Não apareceu de novo desde então."}
              </p>
            )}

            <section className="ab-section">
              <h3>Como os leads disseram</h3>
              <ul className="ai-plain ai-examples">
                {d.examples.map((x) => (
                  <li key={x.id}>
                    <span className="ai-quote">“{x.lead_text || x.text}”</span>
                    <span className="muted ai-small">
                      {x.contact_name || x.phone || "Contato"} · {when(x.created_at)} ·{" "}
                      <button type="button" className="agent-link-btn" onClick={() => setConversation(x.conversation_id)}>
                        Ver conversa
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            {canEdit && t.status !== "trained" && (
              <section className="ab-section">
                <div className="ab-toolbar">
                  <h3>Resposta para o treinamento</h3>
                  <Button type="button" className="btn secondary ab-mavi-btn" loading={busy === "suggest"} onClick={() => void suggest()}>
                    <Sparkles size={15} aria-hidden="true" /> {suggestion ? "Sugerir de novo" : "Sugerir com a MAVI"}
                  </Button>
                </div>
                {!suggestion && (
                  <p className="muted ai-small">
                    A MAVI escreve a resposta a partir do Conhecimento do agente, do perfil da empresa e de como a equipe respondeu nessas conversas. Você
                    revisa antes de incluir.
                  </p>
                )}
                {suggestion?.note && (
                  <p className="ab-notice warn">
                    <span>
                      <strong>A conferir:</strong> {suggestion.note}
                    </span>
                  </p>
                )}
                <label className="ab-field wide">
                  <span className="ab-label">{t.kind === "objection" ? "Quando o lead diz" : "Pergunta"}</span>
                  <Input value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={300} />
                </label>
                <label className="ab-field wide">
                  <span className="ab-label">{t.kind === "objection" ? "Como o agente deve contornar" : "Resposta"}</span>
                  <Textarea rows={6} value={answer} onChange={(e) => setAnswer(e.target.value)} maxLength={8000} />
                  <small className={missing ? "ab-error" : "muted"}>
                    {missing
                      ? "Complete os trechos [PREENCHER: …] antes de incluir."
                      : suggestion?.sources.length
                        ? `Fontes: ${suggestion.sources.join(", ")}.`
                        : "Escreva como o agente deve responder."}
                  </small>
                </label>
                <div className="ab-toolbar">
                  <span />
                  <Button
                    type="button"
                    className="btn primary"
                    loading={busy === "apply"}
                    disabled={missing || question.trim().length < 3 || answer.trim().length < 3}
                    onClick={() =>
                      void act(
                        "apply",
                        () => agentOp(company, agentId, "gap-apply", { topic: topicId, question, answer }),
                        "Incluída no Conhecimento: o agente já usa na próxima conversa.",
                        true,
                      ).then((ok) => ok && onClose())
                    }
                  >
                    <BookPlus size={15} aria-hidden="true" /> Incluir no treinamento
                  </Button>
                </div>
              </section>
            )}

            {d.similar.filter((x) => (x.similarity ?? 0) >= 0.6).length > 0 && (
              <section className="ab-section">
                <h3>Temas parecidos</h3>
                <p className="muted ai-small">Se for a mesma coisa, junte aqui: as ocorrências passam a contar juntas.</p>
                <ul className="ai-plain">
                  {d.similar
                    .filter((x) => (x.similarity ?? 0) >= 0.6)
                    .map((x) => (
                      <li key={x.id} className="ai-similar">
                        <button type="button" className="agent-link-btn" onClick={() => onOpenTopic(x.id)}>
                          {x.title}
                        </button>
                        <span className="muted ai-small">
                          {x.occurrences}x · {Math.round((x.similarity ?? 0) * 100)}% parecido
                        </span>
                        {canEdit && (
                          <Button
                            type="button"
                            className="btn secondary ai-small-btn"
                            loading={busy === "merge"}
                            onClick={() => void act("merge", () => agentOp(company, agentId, "gap-merge", { topic: x.id, into: topicId }), "Temas juntados.").then(load)}
                          >
                            <Combine size={14} aria-hidden="true" /> Juntar aqui
                          </Button>
                        )}
                      </li>
                    ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
      {conversation && (
        <ConversationInsightModal company={company} agentId={agentId} conversationId={conversation} canReset={canEdit} notify={notify} onClose={() => setConversation(null)} />
      )}
    </Modal>
  );
}

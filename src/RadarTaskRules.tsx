import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Check, Pause, Pencil, Play, Plus, Power, Sparkles, Trash2, User, X } from "lucide-react";
import { Button, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import type { Snapshot } from "./types";
import {
  RULE_FILTERS,
  SEVERITY_LABELS,
  estimateRules,
  loadRules,
  ruleDraft,
  ruleOutcome,
  ruleScope,
  rulesCost,
  saveRule,
  setLearning,
  setRuleStatus,
  type RuleDraft,
  type RuleFilter,
  type RulesData,
  type RulesEstimate,
  type TaskRule,
} from "./radar-task-learning";

const STATUS_LABELS: Record<TaskRule["status"], string> = {
  checking: "Em conferência pelo Jev",
  suggested: "Sugestão da MAVI",
  active: "Em uso",
  paused: "Pausada",
  refused: "Recusada pelo Jev",
  dismissed: "Recusada",
};
const usd = (n: number) => `US$ ${n < 1 ? n.toFixed(2) : n.toFixed(n < 10 ? 1 : 0)}`.replace(".", ",");
const when = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });

/**
 * As regras das tarefas do Radar (migration 20270606090000): a MAVI propõe
 * a partir dos registros, o Jev confere e os líderes aprovam, editam, pausam
 * ou recusam — e escrevem as suas. O aprendizado começa desligado; quem liga
 * vê antes o custo estimado do histórico.
 */
export function RadarTaskRules({
  company,
  data,
  notify,
}: {
  company: string;
  data: Snapshot;
  notify: (message: string) => void;
}) {
  const [rules, setRules] = useState<RulesData | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<RuleFilter>("new");
  const [editing, setEditing] = useState<{ id: string | null; draft: RuleDraft } | null>(null);
  const [busy, setBusy] = useState("");
  const [estimate, setEstimate] = useState<RulesEstimate | null>(null);

  const reload = useCallback(
    () =>
      loadRules(company)
        .then(setRules)
        .catch((e) => setError((e as Error).message)),
    [company],
  );
  useEffect(() => {
    void reload();
    // Regras novas da MAVI ou conferidas pelo Jev (Realtime, sem consultas periódicas).
    const on = () => void reload();
    window.addEventListener("mavi:radar-task-rules", on);
    return () => window.removeEventListener("mavi:radar-task-rules", on);
  }, [reload]);

  const counts = useMemo(() => {
    const c = Object.fromEntries(RULE_FILTERS.map((f) => [f.id, 0])) as Record<RuleFilter, number>;
    for (const r of rules?.rules ?? []) {
      const f = RULE_FILTERS.find((x) => (x.statuses as readonly string[]).includes(r.status));
      if (f) c[f.id]++;
    }
    return c;
  }, [rules]);
  const shown = useMemo(() => {
    const f = RULE_FILTERS.find((x) => x.id === filter)!;
    return (rules?.rules ?? []).filter((r) => (f.statuses as readonly string[]).includes(r.status));
  }, [rules, filter]);
  const people = useMemo(
    () => data.members.filter((m) => m.active).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    [data.members],
  );
  const teams = useMemo(() => [...data.teams].sort((a, b) => a.name.localeCompare(b.name, "pt-BR")), [data.teams]);
  const products = useMemo(
    () => [...data.products].sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    [data.products],
  );

  async function run(key: string, fn: () => Promise<unknown>, message: string) {
    setBusy(key);
    setError("");
    try {
      await fn();
      await reload();
      notify(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function askEstimate() {
    setBusy("estimate");
    setError("");
    try {
      setEstimate(await estimateRules(company));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const editingId = editing.id;
    await run(
      "save",
      async () => {
        await saveRule(company, editingId, editing.draft);
        setEditing(null);
      },
      editingId ? "Regra salva." : "Regra criada. Já vale para a MAVI.",
    );
  }

  if (!rules)
    return (
      <section className="panel learning-lessons">
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : (
          <Loading variant="detail" />
        )}
      </section>
    );

  const s = rules.settings;
  const cost = estimate ? rulesCost(estimate) : null;
  const d = editing?.draft;
  const set = (patch: Partial<RuleDraft>) => editing && setEditing({ ...editing, draft: { ...editing.draft, ...patch } });
  const editor = editing && d && (
    <form className="learning-editor rtl-editor" onSubmit={submit}>
      <div className="learning-editor-row">
        <label>
          Tópico
          <Select value={d.topic_id} onValueChange={(v) => set({ topic_id: v })} aria-label="Tópico">
            <SelectOption value="">Escolha o tópico</SelectOption>
            {rules.topics.map((t) => (
              <SelectOption key={t.id} value={t.id}>
                {t.name}
              </SelectOption>
            ))}
          </Select>
        </label>
        <label>
          Produto
          <Select value={d.product || "__general__"} onValueChange={(v) => set({ product: v === "__general__" ? "" : v })} aria-label="Produto">
            <SelectOption value="all">Todos os produtos</SelectOption>
            <SelectOption value="__general__">Geral / Agência</SelectOption>
            {products.map((p) => (
              <SelectOption key={p.id} value={p.id}>
                {p.name}
              </SelectOption>
            ))}
          </Select>
        </label>
        <label>
          O que fazer
          <Select value={d.action} onValueChange={(v) => set({ action: v as RuleDraft["action"] })} aria-label="O que fazer">
            <SelectOption value="task">Abrir tarefa</SelectOption>
            <SelectOption value="no_task">Não abrir tarefa</SelectOption>
          </Select>
        </label>
        <label>
          Gravidade mínima
          <Select value={d.min_severity || "__any__"} onValueChange={(v) => set({ min_severity: v === "__any__" ? "" : v })} aria-label="Gravidade mínima">
            <SelectOption value="__any__">Qualquer gravidade</SelectOption>
            {SEVERITY_LABELS.map((label, i) => (
              <SelectOption key={label} value={String(i)}>
                {label} ou mais
              </SelectOption>
            ))}
          </Select>
        </label>
      </div>
      <label>
        Quando a regra vale
        <Textarea
          value={d.condition}
          maxLength={400}
          rows={2}
          placeholder="Ex.: Problema que trava a entrada de leads: formulário, pixel ou página fora do ar"
          onChange={(e) => set({ condition: e.target.value })}
        />
      </label>
      {d.action === "task" && (
        <div className="learning-editor-row">
          <label>
            Equipe
            <Select value={d.team_id || "__none__"} onValueChange={(v) => set({ team_id: v === "__none__" ? "" : v })} aria-label="Equipe">
              <SelectOption value="__none__">Quem atende o cliente</SelectOption>
              {teams.map((t) => (
                <SelectOption key={t.id} value={t.id}>
                  {t.name}
                </SelectOption>
              ))}
            </Select>
          </label>
          <label>
            Pessoa (opcional)
            <Select value={d.assignee_id || "__none__"} onValueChange={(v) => set({ assignee_id: v === "__none__" ? "" : v })} aria-label="Pessoa">
              <SelectOption value="__none__">Quem tem menos tarefas na equipe</SelectOption>
              {people.map((m) => (
                <SelectOption key={m.user_id} value={m.user_id}>
                  {m.name}
                </SelectOption>
              ))}
            </Select>
          </label>
          <label>
            Prazo (dias úteis)
            <Input
              type="number"
              min={0}
              max={60}
              value={d.due_days}
              placeholder="Regra de prazo de sempre"
              onChange={(e) => set({ due_days: e.target.value })}
            />
          </label>
          <label>
            Prioridade
            <Select value={d.priority || "__none__"} onValueChange={(v) => set({ priority: v === "__none__" ? "" : v })} aria-label="Prioridade">
              <SelectOption value="__none__">Normal</SelectOption>
              <SelectOption value="low">Baixa</SelectOption>
              <SelectOption value="high">Alta</SelectOption>
              <SelectOption value="urgent">Urgente</SelectOption>
            </Select>
          </label>
        </div>
      )}
      {d.action === "task" && (
        <label>
          Como escrever o título (opcional)
          <Input
            value={d.title_hint}
            maxLength={200}
            placeholder="Ex.: Corrigir <o que quebrou> — <cliente>"
            onChange={(e) => set({ title_hint: e.target.value })}
          />
        </label>
      )}
      <div className="learning-editor-actions">
        <small>
          {editing.id
            ? "Editar uma sugestão não a aprova: para usar, clique em Aprovar."
            : "A regra escrita por você vale na hora."}
        </small>
        <Button type="button" className="btn secondary" onClick={() => setEditing(null)}>
          Cancelar
        </Button>
        <Button
          type="submit"
          className="btn primary"
          loading={busy === "save"}
          disabled={!d.topic_id || d.condition.trim().length < 5}
        >
          Salvar
        </Button>
      </div>
    </form>
  );

  return (
    <section className="panel learning-lessons rtl-rules">
      <header>
        <div>
          <h2>
            <Sparkles size={17} aria-hidden="true" /> Regras das tarefas
          </h2>
          <p>
            Quando um item do Radar pede tarefa (ou não), para quem e com que prazo. A MAVI propõe, o Jev confere e
            vocês aprovam. Só as regras <strong>em uso</strong> valem quando a MAVI sugerir tarefas nos itens.
          </p>
        </div>
        <Button
          className="btn primary"
          onClick={() => setEditing({ id: null, draft: ruleDraft(undefined, rules.topics[0]?.id ?? "") })}
          disabled={!!editing}
        >
          <Plus size={15} /> Nova regra
        </Button>
      </header>

      <div className={`rtl-learning${s.learning ? " on" : ""}`}>
        <Power size={16} aria-hidden="true" />
        {s.learning ? (
          <div>
            <strong>Aprendizado ligado</strong>
            <small>
              {s.learning_by_name ? `Ligado por ${s.learning_by_name}${s.learning_at ? ` em ${when(s.learning_at)}` : ""}. ` : ""}
              A MAVI revisa as regras quando um tópico × produto junta 5 registros novos (ou 1 parado há 24 h).
              {rules.queue.due ? ` ${rules.queue.due} grupo(s) na fila agora.` : ""}
              {rules.queue.learned_at ? ` Última rodada em ${when(rules.queue.learned_at)}.` : ""}
            </small>
            {rules.queue.error && <small className="rtl-error">Última falha: {rules.queue.error}</small>}
          </div>
        ) : (
          <div>
            <strong>Aprendizado desligado</strong>
            <small>
              Ligado, a MAVI lê os registros abaixo (o histórico primeiro) e propõe regras para vocês aprovarem.
            </small>
            {estimate && cost && (
              <small className="rtl-estimate">
                {estimate.groups
                  ? `Histórico: ${estimate.groups} tópico(s) × produto com ${estimate.signals} registros. Custo estimado: ${usd(cost.low)} a ${usd(cost.high)}${cost.measured ? " (pela média já medida)" : ""}, mais as revisões quando chegarem registros novos.`
                  : "Ainda não há tópico × produto com 3 registros: ligar não custa nada agora."}
              </small>
            )}
          </div>
        )}
        {s.learning ? (
          <Button
            className="btn secondary"
            loading={busy === "learning"}
            onClick={() => run("learning", () => setLearning(company, false), "Aprendizado desligado.")}
          >
            Desligar
          </Button>
        ) : estimate ? (
          <span className="rtl-learning-actions">
            <Button className="btn secondary" onClick={() => setEstimate(null)}>
              Cancelar
            </Button>
            <Button
              className="btn primary"
              loading={busy === "learning"}
              onClick={() =>
                run(
                  "learning",
                  async () => {
                    await setLearning(company, true);
                    setEstimate(null);
                  },
                  "Aprendizado ligado. As sugestões aparecem aqui quando a MAVI terminar.",
                )
              }
            >
              Ligar
            </Button>
          </span>
        ) : (
          <Button className="btn primary" loading={busy === "estimate"} onClick={askEstimate}>
            Ligar o aprendizado…
          </Button>
        )}
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {editing && !editing.id && editor}

      <div className="drive-view" role="tablist">
        {RULE_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            className={filter === f.id ? "selected" : ""}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
            {counts[f.id] > 0 && <span> {counts[f.id]}</span>}
          </button>
        ))}
      </div>

      {!shown.length ? (
        <p className="learning-empty">
          {filter === "new"
            ? s.learning
              ? "Nenhuma sugestão para conferir agora."
              : "Ligue o aprendizado para a MAVI propor regras, ou escreva as suas em Nova regra."
            : "Nenhuma regra aqui."}
        </p>
      ) : (
        <ul className="learning-list rtl-rule-list">
          {shown.map((r) =>
            editing?.id === r.id ? (
              <li key={r.id}>{editor}</li>
            ) : (
              <li key={r.id} className={`rtl-rule ${r.status}`}>
                <div className="learning-item-head">
                  <span className="rtl-topic" style={{ background: r.topic_color }} aria-hidden="true" />
                  <span className="learning-scope">
                    {r.topic_name} · {ruleScope(r)}
                  </span>
                  <span className={`learning-status ${r.status === "active" ? "active" : r.status === "suggested" ? "candidate" : ""}`}>
                    {STATUS_LABELS[r.status]}
                  </span>
                </div>
                <p className="rtl-rule-when">
                  <span>Quando</span> {r.condition}
                  {r.min_severity !== undefined && r.min_severity !== null && (
                    <em> · gravidade {SEVERITY_LABELS[r.min_severity]?.toLowerCase()} ou mais</em>
                  )}
                </p>
                <p className={`rtl-rule-then ${r.action}`}>
                  <span>→</span> {ruleOutcome(r)}
                  {r.title_hint && <em> · título: {r.title_hint}</em>}
                </p>
                {r.why && <p className="rtl-rule-why">{r.why}</p>}
                {r.replaces_condition && (
                  <p className="rtl-rule-why">Substitui a regra em uso: “{r.replaces_condition}”</p>
                )}
                <div className="learning-meta">
                  {r.origin === "mavi" ? (
                    <span>
                      <Sparkles size={12} aria-hidden="true" /> Proposta pela MAVI
                      {r.support ? ` · ${r.support} registro(s)` : ""}
                    </span>
                  ) : (
                    <span>
                      <User size={12} aria-hidden="true" /> Escrita por {r.updated_by_name ?? r.approved_by_name ?? "um líder"}
                    </span>
                  )}
                  {r.check_note && <span>{r.check_note}</span>}
                  {r.approved_by_name && r.origin === "mavi" && (
                    <span>Aprovada por {r.approved_by_name}{r.approved_at ? ` em ${when(r.approved_at)}` : ""}</span>
                  )}
                  <span>{when(r.updated_at)}</span>
                </div>
                <div className="learning-actions">
                  {(r.status === "suggested" || r.status === "refused" || r.status === "checking") && (
                    <Button
                      className="btn secondary"
                      loading={busy === `a${r.id}`}
                      onClick={() =>
                        run(`a${r.id}`, () => setRuleStatus(company, r.id, "active"), "Regra aprovada. Já vale para a MAVI.")
                      }
                    >
                      <Check size={14} /> Aprovar
                    </Button>
                  )}
                  <button
                    type="button"
                    title="Editar"
                    aria-label="Editar"
                    disabled={!!editing}
                    onClick={() => setEditing({ id: r.id, draft: ruleDraft(r) })}
                  >
                    <Pencil size={14} />
                  </button>
                  {r.status === "active" && (
                    <button
                      type="button"
                      title="Pausar"
                      aria-label="Pausar"
                      disabled={busy === `p${r.id}`}
                      onClick={() => run(`p${r.id}`, () => setRuleStatus(company, r.id, "paused"), "Regra pausada.")}
                    >
                      <Pause size={14} />
                    </button>
                  )}
                  {(r.status === "paused" || r.status === "dismissed") && (
                    <button
                      type="button"
                      title="Voltar a usar"
                      aria-label="Voltar a usar"
                      disabled={busy === `a${r.id}`}
                      onClick={() => run(`a${r.id}`, () => setRuleStatus(company, r.id, "active"), "Regra em uso de novo.")}
                    >
                      <Play size={14} />
                    </button>
                  )}
                  {r.status !== "dismissed" && (
                    <button
                      type="button"
                      title={r.origin === "mavi" && r.status !== "active" ? "Recusar" : "Excluir"}
                      aria-label={r.origin === "mavi" && r.status !== "active" ? "Recusar" : "Excluir"}
                      disabled={busy === `d${r.id}`}
                      onClick={() =>
                        run(
                          `d${r.id}`,
                          () => setRuleStatus(company, r.id, "dismissed"),
                          "Regra recusada. A MAVI não volta a propor a mesma.",
                        )
                      }
                    >
                      {r.origin === "mavi" && r.status !== "active" ? <X size={14} /> : <Trash2 size={14} />}
                    </button>
                  )}
                </div>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button, Checkbox, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import { Modal } from "./components";
import type { Snapshot } from "./types";
import type { AiLibrary, ServerDefaults } from "./ai";
import { CATALOG, isJevModel, isLinkTranscriber, isNonChatModel } from "./ai-providers";
import { FieldHistory } from "./AiSettingsLog";
import { TASK_TYPES, ms, pct, usd, type RouterApi, type RouterSettings } from "./ai-router";
import type { CaseDraft, EvalApi, EvalCase, EvalOverview, EvalResult, EvalRun } from "./ai-eval-set";
import "./campaign-insights.css";
import "./ai-router.css";

const SERVER = "server";
const STATUS: Record<EvalRun["status"], string> = { running: "Em andamento", done: "Concluído", cancelled: "Cancelado" };

/**
 * Painel da MAVI › Avaliação: o conjunto de avaliação da empresa. Perguntas
 * reais com a resposta de referência (de respostas aprovadas, com o
 * material congelado, ou à mão); um líder testa um modelo antes de liberar e
 * vê a nota caso a caso. Com a liberação ligada, o roteador só usa sozinho
 * os modelos aprovados.
 */
export function EvalSetPanel({
  api,
  router,
  data,
  library,
  defaults,
  notify,
}: {
  api: EvalApi;
  router: RouterApi;
  data: Snapshot;
  library: AiLibrary | null;
  defaults: ServerDefaults | null;
  notify: (message: string) => void;
}) {
  const [o, setO] = useState<EvalOverview | null>(null);
  const [s, setS] = useState<RouterSettings | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<EvalCase | "new" | null>(null);
  const [choice, setChoice] = useState("");
  const [cap, setCap] = useState("1");
  const [open, setOpen] = useState<string | null>(null);
  const [minScore, setMinScore] = useState("80");

  const load = useCallback(
    () =>
      Promise.all([api.overview(), router.get()])
        .then(([ov, st]) => {
          setO(ov);
          setS(st);
          setMinScore(String(Math.round(Number(st.gate_min) * 100)));
          setError("");
        })
        .catch((e: Error) => setError(e.message)),
    [api, router],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (work: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError("");
    try {
      await work();
      await load();
      notify(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Os modelos que dá para testar: os de conversa da biblioteca e os da Claude do servidor.
  const models = useMemo(() => {
    const list: { value: string; label: string; provider: string | null; model: string }[] = [];
    for (const p of library?.providers ?? []) {
      if (!p.active || isLinkTranscriber(p.kind)) continue;
      for (const m of p.models)
        if (!isJevModel(m.id) && !isNonChatModel(m.id))
          list.push({ value: `${p.id}|${m.id}`, label: `${p.name} · ${m.label || m.id}`, provider: p.id, model: m.id });
    }
    if (defaults?.claudeKey !== false)
      for (const m of CATALOG.find((c) => c.kind === "anthropic")?.models ?? [])
        list.push({ value: `${SERVER}|${m.id}`, label: `Servidor · ${m.label || m.id}`, provider: null, model: m.id });
    return list;
  }, [library, defaults]);
  const clientName = (id: string | null) => (id ? (data.clients.find((c) => c.id === id)?.name ?? "Cliente removido") : "—");

  if (!o || !s)
    return error ? (
      <p className="form-error" role="alert">
        Não foi possível carregar o conjunto de avaliação: {error}
      </p>
    ) : (
      <Loading variant="field" />
    );
  const active = o.cases.filter((c) => c.active).length;
  const picked = models.find((m) => m.value === choice);
  return (
    <div className="thermo-settings cins-settings rtr" aria-busy={busy}>
      <section className="panel cins-block">
        <h3>Conjunto de avaliação</h3>
        <p className="cins-help">
          Perguntas reais da agência com a resposta certa, para testar um modelo antes de liberar. Cada caso guarda o
          material que a resposta usou (os trechos das fontes e o dossiê do cliente, congelados), então o teste se repete
          igual com qualquer modelo. O modelo responde com esse material, sem ferramentas, e a autoavaliação dá a nota
          comparando com a referência. A busca com ferramentas aparece no ranking real, em Roteamento.
        </p>
      </section>

      <section className="panel cins-block">
        <div className="rtr-head">
          <h3>
            Casos <small className="muted">· {active} ativos de {o.cases.length}</small>
          </h3>
          <Button className="btn" type="button" onClick={() => setEditing("new")} disabled={busy}>
            <Plus size={14} /> Novo caso
          </Button>
        </div>
        {o.cases.length ? (
          <div className="drive-table-wrap">
            <table className="drive-table ai-usage-table stack-mobile">
              <thead>
                <tr>
                  <th>Pergunta</th>
                  <th>Pedido</th>
                  <th>Cliente</th>
                  <th>Origem</th>
                  <th>Ativo</th>
                  <th aria-label="Ações" />
                </tr>
              </thead>
              <tbody>
                {o.cases.map((c) => (
                  <tr key={c.id}>
                    <td data-label="Pergunta" className="rtr-reason">
                      {c.question}
                    </td>
                    <td data-label="Pedido">{c.task_type ? (TASK_TYPES[c.task_type] ?? c.task_type) : "—"}</td>
                    <td data-label="Cliente">{clientName(c.client_id)}</td>
                    <td data-label="Origem">
                      {c.origin === "answer" ? `Resposta aprovada${c.sources ? ` · ${c.sources} fontes` : ""}` : "À mão"}
                    </td>
                    <td data-label="Ativo">
                      <Checkbox
                        checked={c.active}
                        aria-label={`Caso ativo: ${c.question.slice(0, 60)}`}
                        onCheckedChange={(v) =>
                          void act(
                            () =>
                              api.saveCase({
                                id: c.id,
                                question: c.question,
                                reference: c.reference,
                                client_id: c.client_id,
                                context: c.context ?? "",
                                active: v === true,
                              }),
                            v === true ? "Caso ativado." : "Caso desativado.",
                          )
                        }
                      />
                    </td>
                    <td className="num ai-log-actions">
                      <button type="button" className="icon-btn" title="Editar" aria-label="Editar o caso" onClick={() => setEditing(c)}>
                        <Pencil size={15} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Excluir"
                        aria-label="Excluir o caso"
                        onClick={() => void act(() => api.deleteCase(c.id), "Caso excluído.")}
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="cins-help">Nenhum caso ainda. Comece pelas respostas aprovadas abaixo ou escreva um.</p>
        )}
        {!!o.suggestions.length && (
          <>
            <h4 className="rtr-sub">Respostas aprovadas (👍) que podem virar caso</h4>
            <ul className="evs-suggestions">
              {o.suggestions.map((x) => (
                <li key={x.message}>
                  <span>
                    <strong>{x.question}</strong>
                    <small className="muted">{x.answer}</small>
                  </span>
                  <Button
                    className="btn"
                    type="button"
                    disabled={busy}
                    onClick={() => void act(() => api.fromMessage(x.message), "Caso criado a partir da resposta.")}
                  >
                    <Plus size={14} /> Adicionar
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="panel cins-block">
        <div className="rtr-head">
          <h3>Testar um modelo</h3>
          <button type="button" className="icon-btn" title="Atualizar" aria-label="Atualizar os testes" onClick={() => void load()}>
            <RefreshCw size={15} />
          </button>
        </div>
        <div className="cins-row">
          <label>
            <span>Modelo</span>
            <Select value={choice || "none"} aria-label="Modelo para testar" onValueChange={(v) => setChoice(v === "none" ? "" : v)}>
              <SelectOption value="none">Escolha…</SelectOption>
              {models.map((m) => (
                <SelectOption key={m.value} value={m.value}>
                  {m.label}
                </SelectOption>
              ))}
            </Select>
          </label>
          <label>
            <span>Teto do teste (US$)</span>
            <Input type="number" min={0.05} max={50} step="0.05" value={cap} onChange={(e) => setCap(e.target.value)} />
          </label>
          <Button
            className="btn primary"
            type="button"
            disabled={busy || !picked || !active}
            onClick={() =>
              picked &&
              void act(
                () => api.start(picked.provider, picked.model, Math.min(Math.max(Number(cap) || 1, 0.05), 50)),
                "Teste começou: a MAVI responde os casos em segundo plano.",
              )
            }
          >
            Testar com {Math.min(active, 100)} {active === 1 ? "caso" : "casos"}
          </Button>
        </div>
        <p className="cins-help">
          Roda em segundo plano, alguns casos por vez; passou do teto, o teste fecha com os que deu tempo. Aprovado com nota
          de 70% ou mais em cada caso.
        </p>
        {o.runs.length ? (
          <div className="drive-table-wrap">
            <table className="drive-table ai-usage-table stack-mobile">
              <thead>
                <tr>
                  <th aria-label="Abrir" />
                  <th>Modelo</th>
                  <th>Situação</th>
                  <th className="num">Nota</th>
                  <th className="num">Aprovados</th>
                  <th className="num">Espera média</th>
                  <th className="num">Custo / teto</th>
                  <th aria-label="Ações" />
                </tr>
              </thead>
              <tbody>
                {o.runs.map((r) => (
                  <Fragment key={r.id}>
                    <tr>
                      <td>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={open === r.id ? "Fechar o resultado" : "Ver o resultado caso a caso"}
                          onClick={() => setOpen(open === r.id ? null : r.id)}
                        >
                          {open === r.id ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        </button>
                      </td>
                      <td data-label="Modelo" className="rtr-model">
                        {r.provider} · {r.model}
                      </td>
                      <td data-label="Situação">
                        {STATUS[r.status]}
                        {r.status === "running" && ` · ${r.cases_done} de ${r.cases_total}`}
                        {r.cases_failed > 0 && <small className="muted"> · {r.cases_failed} sem nota</small>}
                      </td>
                      <td data-label="Nota" className="num">
                        <strong>{pct(r.score)}</strong>
                      </td>
                      <td data-label="Aprovados" className="num">
                        {r.cases_done ? `${r.passed} de ${r.cases_done}` : "—"}
                      </td>
                      <td data-label="Espera média" className="num">{ms(r.avg_ms)}</td>
                      <td data-label="Custo / teto" className="num">
                        {usd(r.cost_usd)} / {usd(r.cap_usd)}
                      </td>
                      <td className="num">
                        {r.status === "running" && (
                          <Button className="btn" type="button" disabled={busy} onClick={() => void act(() => api.cancel(r.id), "Teste cancelado.")}>
                            Cancelar
                          </Button>
                        )}
                      </td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="cins-help">Nenhum teste ainda.</p>
        )}
        {open && o.runs.some((r) => r.id === open) && (
          <>
            <h4 className="rtr-sub">
              Resultado caso a caso · {(() => {
                const r = o.runs.find((x) => x.id === open)!;
                return `${r.provider} · ${r.model}`;
              })()}
            </h4>
            <RunDetail api={api} run={open} />
          </>
        )}
      </section>

      <section className="panel cins-block">
        <h3>Liberação</h3>
        <label className="cins-check">
          <Checkbox
            checked={s.gate_enabled}
            disabled={busy}
            onCheckedChange={(v) =>
              void act(
                () => router.save({ gate_enabled: v === true }),
                v === true ? "Só modelos aprovados no automático." : "Liberação desligada.",
              )
            }
          />
          <span>
            <strong>No automático, só modelos aprovados no conjunto de avaliação</strong>
            <small>
              O roteador escolhe entre os modelos cuja nota mais recente aqui chegou à nota mínima. Regras travadas em Quem
              usa qual modelo continuam valendo. Sem nenhum aprovado, ele segue com todos e avisa no motivo.
            </small>
          </span>
          <FieldHistory title="Liberação pelo conjunto de avaliação" area="router" fields={["gate_enabled", "gate_min"]} />
        </label>
        <div className="cins-row" aria-disabled={!s.gate_enabled}>
          <label>
            <span>Nota mínima (%)</span>
            <Input
              type="number"
              min={30}
              max={100}
              step="1"
              value={minScore}
              disabled={busy || !s.gate_enabled}
              onChange={(e) => setMinScore(e.target.value)}
              onBlur={() => {
                const v = Math.min(Math.max(Math.round(Number(minScore) || 80), 30), 100) / 100;
                if (v !== Number(s.gate_min)) void act(() => router.save({ gate_min: v }), "Nota mínima salva.");
              }}
            />
          </label>
        </div>
        {!!o.latest.length && (
          <div className="drive-table-wrap">
            <table className="drive-table ai-usage-table stack-mobile">
              <thead>
                <tr>
                  <th>Modelo</th>
                  <th className="num">Nota mais recente</th>
                  <th>Situação</th>
                </tr>
              </thead>
              <tbody>
                {[...o.latest]
                  .sort((a, b) => Number(b.score) - Number(a.score))
                  .map((l) => (
                    <tr key={`${l.provider_id ?? ""}|${l.model}`}>
                      <td data-label="Modelo" className="rtr-model">
                        {l.provider_id ? (library?.providers.find((p) => p.id === l.provider_id)?.name ?? "Provedor") : "Servidor"} · {l.model}
                      </td>
                      <td data-label="Nota" className="num">
                        <strong>{pct(l.score)}</strong>
                      </td>
                      <td data-label="Situação">{Number(l.score) >= Number(s.gate_min) ? "Aprovado" : "Abaixo da nota mínima"}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {editing && (
        <CaseEditor
          data={data}
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (d) => {
            await api.saveCase(d);
            await load();
            notify("Caso salvo.");
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

/** O resultado de um teste, caso a caso (os que não passaram primeiro). */
function RunDetail({ api, run }: { api: EvalApi; run: string }) {
  const [rows, setRows] = useState<EvalResult[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api
      .detail(run)
      .then(setRows)
      .catch((e: Error) => setError(e.message));
  }, [api, run]);
  if (error)
    return (
      <p className="form-error" role="alert">
        {error}
      </p>
    );
  if (!rows) return <Loading variant="field" />;
  return (
    <div className="evs-detail">
      {rows.map((r) => (
        <article key={r.id} className={r.status === "done" ? (r.passed ? "ok" : "bad") : "pending"}>
          <header>
            <strong>{r.question ?? "Caso excluído"}</strong>
            <span>
              {r.status === "done"
                ? `${pct(r.score)} · ${r.passed ? "aprovado" : "não passou"}`
                : r.status === "pending"
                  ? "na fila"
                  : r.status === "skipped"
                    ? "pulado"
                    : `não deu: ${r.error ?? ""}`}
              {r.task_type && ` · ${TASK_TYPES[r.task_type] ?? r.task_type}`}
              {r.ms !== null && ` · ${ms(r.ms)}`}
            </span>
          </header>
          {r.explanation && <p className="evs-why">{r.explanation}</p>}
          {r.status === "done" && (
            <div className="evs-compare">
              <div>
                <small>Referência</small>
                <p>{r.reference}</p>
              </div>
              <div>
                <small>Resposta do modelo</small>
                <p>{r.answer}</p>
              </div>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

function CaseEditor({
  data,
  initial,
  onClose,
  onSave,
}: {
  data: Snapshot;
  initial: EvalCase | null;
  onClose: () => void;
  onSave: (d: CaseDraft) => Promise<void>;
}) {
  const [d, setD] = useState<CaseDraft>(() => ({
    id: initial?.id,
    question: initial?.question ?? "",
    reference: initial?.reference ?? "",
    client_id: initial?.client_id ?? null,
    context: initial?.context ?? "",
    active: initial?.active ?? true,
  }));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const clients = useMemo(
    () => data.clients.filter((c) => !c.archived).sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { numeric: true })),
    [data],
  );
  return (
    <Modal title={initial ? "Editar caso" : "Novo caso"} onClose={onClose} busy={busy}>
      <form
        className="entity-form rtr-editor"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setProblem("");
          onSave(d)
            .catch((err: Error) => setProblem(err.message))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          <span>Pergunta</span>
          <Textarea value={d.question} rows={3} required onChange={(e) => setD({ ...d, question: e.target.value })} />
        </label>
        <label>
          <span>Resposta de referência</span>
          <Textarea value={d.reference} rows={5} required onChange={(e) => setD({ ...d, reference: e.target.value })} />
          <small className="muted">A resposta certa, ou a lista do que ela precisa ter.</small>
        </label>
        {initial?.origin !== "answer" && (
          <label>
            <span>Material de apoio (opcional)</span>
            <Textarea value={d.context} rows={4} onChange={(e) => setD({ ...d, context: e.target.value })} />
            <small className="muted">O que o modelo pode consultar: trechos de briefing, combinados, dados.</small>
          </label>
        )}
        <div className="cins-row">
          <label>
            <span>Cliente (opcional)</span>
            <Select value={d.client_id ?? "none"} aria-label="Cliente do caso" onValueChange={(v) => setD({ ...d, client_id: v === "none" ? null : v })}>
              <SelectOption value="none">Sem cliente</SelectOption>
              {clients.map((c) => (
                <SelectOption key={c.id} value={c.id}>
                  {c.name}
                </SelectOption>
              ))}
            </Select>
          </label>
        </div>
        <label className="cins-check">
          <Checkbox checked={d.active} onCheckedChange={(v) => setD({ ...d, active: v === true })} />
          <span>
            <strong>Ativo</strong>
            <small>Entra nos próximos testes.</small>
          </span>
        </label>
        {problem && (
          <p className="form-error" role="alert">
            {problem}
          </p>
        )}
        <div className="rtr-editor-actions">
          <Button className="btn" type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button className="btn primary" type="submit" disabled={busy || d.question.trim().length < 3 || d.reference.trim().length < 3}>
            Salvar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

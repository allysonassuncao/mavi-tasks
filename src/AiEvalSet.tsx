import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { Button, Checkbox, Input, Loading, Select, SelectOption } from "./ui";
import type { Snapshot } from "./types";
import type { AiLibrary, ServerDefaults } from "./ai";
import { CATALOG, isJevModel, isLinkTranscriber, isNonChatModel } from "./ai-providers";
import { FieldHistory } from "./AiSettingsLog";
import { ms, pct, usd, type RouterApi, type RouterSettings } from "./ai-router";
import { featureLabel, type EvalApi, type EvalOverview, type EvalResult, type EvalRun, type EvalSample } from "./ai-eval-set";
import "./campaign-insights.css";
import "./ai-router.css";

const SERVER = "server";
const STATUS: Record<EvalRun["status"], string> = { running: "Em andamento", done: "Concluído", cancelled: "Cancelado" };
const OUTCOME: Record<NonNullable<EvalResult["outcome"]>, string> = {
  win: "melhor que a original",
  tie: "igual à original",
  loss: "pior que a original",
};
const when = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/**
 * Painel da MAVI › Avaliação: a avaliação dinâmica. Cada módulo que usa a
 * MAVI grava os 10 registros mais recentes; um líder escolhe um modelo e os
 * módulos, e o modelo repete esses registros com a mesma entrada (as
 * consultas devolvem o que foi gravado). O juiz compara às cegas com a
 * resposta original. Toda segunda, o teste semanal testa sozinho os modelos
 * do roteador. Com a liberação ligada, o roteador só usa sozinho os modelos
 * aprovados.
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
  const [choice, setChoice] = useState("");
  const [cap, setCap] = useState("1");
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [minScore, setMinScore] = useState("80");
  const [weeklyCap, setWeeklyCap] = useState("1");

  const load = useCallback(
    () =>
      Promise.all([api.overview(), router.get()])
        .then(([ov, st]) => {
          setO(ov);
          setS(st);
          setMinScore(String(Math.round(Number(st.gate_min) * 100)));
          setWeeklyCap(String(Number(ov.settings.weekly_cap)));
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

  // Os registros agrupados por módulo (os mais recentes primeiro).
  const modules = useMemo(() => {
    const by = new Map<string, EvalSample[]>();
    for (const x of o?.samples ?? []) by.set(x.feature, [...(by.get(x.feature) ?? []), x]);
    return [...by.entries()]
      .map(([feature, list]) => ({ feature, label: featureLabel(feature), list }))
      .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
  }, [o]);
  const clientName = (id: string | null) => (id ? (data.clients.find((c) => c.id === id)?.name ?? "Cliente removido") : "");

  if (!o || !s)
    return error ? (
      <p className="form-error" role="alert">
        Não foi possível carregar a avaliação: {error}
      </p>
    ) : (
      <Loading variant="field" />
    );
  const chosen = models.find((m) => m.value === choice);
  const features = modules.filter((m) => picked.has(m.feature));
  const total = features.reduce((n, m) => n + Math.min(m.list.length, 10), 0);
  const toggle = (feature: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(feature);
      else next.delete(feature);
      return next;
    });
  return (
    <div className="thermo-settings cins-settings rtr" aria-busy={busy}>
      <section className="panel cins-block">
        <h3>Avaliação dinâmica</h3>
        <p className="cins-help">
          Cada módulo que usa a MAVI guarda os 10 registros mais recentes: a entrada inteira (instruções, contexto, a
          conversa e o que cada consulta ao sistema devolveu) e a resposta. Para testar um modelo, ele recebe a mesma
          entrada de cada registro, e as consultas devolvem o que foi gravado — nada é executado de verdade. Um juiz
          compara às cegas com a resposta original: o modelo vence, empata ou perde. A nota é a parte dos registros em que
          ele foi igual ou melhor que o modelo de hoje.
        </p>
      </section>

      <section className="panel cins-block">
        <div className="rtr-head">
          <h3>
            Registros por módulo <small className="muted">· {o.samples.length} registros</small>
          </h3>
          {!!modules.length && (
            <span className="evs-links">
              <Button className="btn" type="button" onClick={() => setPicked(new Set(modules.map((m) => m.feature)))}>
                Marcar todos
              </Button>
              <Button className="btn" type="button" disabled={!picked.size} onClick={() => setPicked(new Set())}>
                Limpar
              </Button>
            </span>
          )}
        </div>
        {modules.length ? (
          <div className="drive-table-wrap">
            <table className="drive-table ai-usage-table stack-mobile">
              <thead>
                <tr>
                  <th>Módulo</th>
                  <th className="num">Registros</th>
                  <th className="num">Consultas</th>
                  <th>Respondeu</th>
                  <th>Último</th>
                  <th aria-label="Ver os registros" />
                </tr>
              </thead>
              <tbody>
                {modules.map((m) => (
                  <Fragment key={m.feature}>
                    <tr>
                      <td data-label="Módulo">
                        <label className="evs-module">
                          <Checkbox
                            checked={picked.has(m.feature)}
                            aria-label={`Testar o módulo ${m.label}`}
                            onCheckedChange={(v) => toggle(m.feature, v === true)}
                          />
                          <span>{m.label}</span>
                        </label>
                      </td>
                      <td data-label="Registros" className="num">
                        {m.list.length} de 10
                      </td>
                      <td data-label="Consultas" className="num">
                        {m.list.reduce((n, x) => n + x.tools, 0)}
                      </td>
                      <td data-label="Respondeu" className="rtr-model">
                        {[...new Set(m.list.map((x) => x.model))].join(", ")}
                      </td>
                      <td data-label="Último">{when(m.list[0].created_at)}</td>
                      <td className="num">
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={shown === m.feature ? "Fechar os registros" : "Ver os registros"}
                          onClick={() => setShown(shown === m.feature ? null : m.feature)}
                        >
                          {shown === m.feature ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        </button>
                      </td>
                    </tr>
                    {shown === m.feature && (
                      <tr className="evs-samples-row">
                        <td colSpan={6}>
                          <ul className="evs-suggestions">
                            {m.list.map((x) => (
                              <li key={x.id}>
                                <span>
                                  <strong>{x.question || "(sem pergunta: pedido do próprio módulo)"}</strong>
                                  <small className="muted">
                                    {[
                                      when(x.created_at),
                                      clientName(x.client_id),
                                      `${x.provider} · ${x.model}`,
                                      x.tools ? `${x.tools} ${x.tools === 1 ? "consulta" : "consultas"}` : "",
                                      x.sigiloso ? "cliente sigiloso" : "",
                                    ]
                                      .filter(Boolean)
                                      .join(" · ")}
                                  </small>
                                </span>
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="cins-help">
            Ainda não há registros. Eles aparecem conforme a equipe usa a MAVI: no máximo um a cada 5 minutos por módulo, e
            ficam os 10 mais recentes (até 2 da mesma pessoa).
          </p>
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
            disabled={busy || !chosen || !total}
            onClick={() =>
              chosen &&
              void act(
                () =>
                  api.start(
                    chosen.provider,
                    chosen.model,
                    Math.min(Math.max(Number(cap) || 1, 0.05), 50),
                    features.map((m) => m.feature),
                  ),
                "Teste começou: o modelo repete os registros em segundo plano.",
              )
            }
          >
            {total ? `Testar com ${total} ${total === 1 ? "registro" : "registros"}` : "Marque os módulos acima"}
          </Button>
        </div>
        <p className="cins-help">
          Roda em segundo plano, alguns registros por vez; passou do teto, o teste fecha com os que deu tempo. Os registros
          de clientes sigilosos só entram nos provedores de dados sigilosos do Roteamento. A espera da original inclui as
          consultas de verdade; no teste elas voltam na hora, então compare a espera com cuidado. O gasto das respostas
          não conta o juiz.
        </p>
        {o.runs.length ? (
          <div className="drive-table-wrap">
            <table className="drive-table ai-usage-table stack-mobile">
              <thead>
                <tr>
                  <th aria-label="Abrir" />
                  <th>Modelo</th>
                  <th>Situação</th>
                  <th className="num">Igual ou melhor</th>
                  <th className="num">Vence · Empata · Perde</th>
                  <th className="num">Espera média</th>
                  <th className="num">Gasto das respostas</th>
                  <th className="num">Custo / teto</th>
                  <th aria-label="Ações" />
                </tr>
              </thead>
              <tbody>
                {o.runs.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={open === r.id ? "Fechar o resultado" : "Ver o resultado registro a registro"}
                        onClick={() => setOpen(open === r.id ? null : r.id)}
                      >
                        {open === r.id ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                      </button>
                    </td>
                    <td data-label="Modelo" className="rtr-model">
                      {r.provider} · {r.model}
                      <small className="muted">
                        {" "}
                        · {r.features?.length ?? 0} {r.features?.length === 1 ? "módulo" : "módulos"}
                        {r.auto && " · semanal"}
                      </small>
                    </td>
                    <td data-label="Situação">
                      {STATUS[r.status]}
                      {r.status === "running" && ` · ${r.cases_done} de ${r.cases_total}`}
                      {r.cases_failed > 0 && <small className="muted"> · {r.cases_failed} sem resultado</small>}
                    </td>
                    <td data-label="Igual ou melhor" className="num">
                      <strong>{pct(r.score)}</strong>
                    </td>
                    <td data-label="Vence · Empata · Perde" className="num">
                      {r.status === "running" || r.cases_done ? `${r.wins} · ${r.ties} · ${r.losses}` : "—"}
                    </td>
                    <td data-label="Espera média" className="num">
                      {ms(r.avg_ms)}
                      {r.base_ms !== null && <small className="muted"> (original {ms(r.base_ms)})</small>}
                    </td>
                    <td data-label="Gasto das respostas" className="num">
                      {r.answer_cost !== null ? usd(r.answer_cost) : "—"}
                      {r.base_cost !== null && <small className="muted"> (original {usd(r.base_cost)})</small>}
                    </td>
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
              Resultado registro a registro · {(() => {
                const r = o.runs.find((x) => x.id === open)!;
                return `${r.provider} · ${r.model}`;
              })()}
            </h4>
            <RunDetail api={api} run={open} />
          </>
        )}
      </section>

      <section className="panel cins-block">
        <h3>Teste semanal</h3>
        <label className="cins-check">
          <Checkbox
            checked={o.settings.weekly}
            disabled={busy}
            onCheckedChange={(v) =>
              void act(
                () => api.saveSettings(v === true, Number(o.settings.weekly_cap)),
                v === true ? "Teste semanal ligado." : "Teste semanal desligado.",
              )
            }
          />
          <span>
            <strong>Toda segunda, testar sozinho os modelos do roteador</strong>
            <small>
              Até 3 modelos por semana entre os que o roteador pode escolher (os testados há mais tempo primeiro), com todos
              os módulos que têm registros. Sem a lista do roteador, os modelos de conversa dos provedores ligados.
            </small>
          </span>
        </label>
        <div className="cins-row" aria-disabled={!o.settings.weekly}>
          <label>
            <span>Teto por modelo (US$)</span>
            <Input
              type="number"
              min={0.05}
              max={20}
              step="0.05"
              value={weeklyCap}
              disabled={busy || !o.settings.weekly}
              onChange={(e) => setWeeklyCap(e.target.value)}
              onBlur={() => {
                const v = Math.min(Math.max(Number(weeklyCap) || 1, 0.05), 20);
                if (v !== Number(o.settings.weekly_cap))
                  void act(() => api.saveSettings(o.settings.weekly, v), "Teto do teste semanal salvo.");
              }}
            />
          </label>
        </div>
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
            <strong>No automático, só modelos aprovados na avaliação</strong>
            <small>
              O roteador escolhe entre os modelos cujo teste mais recente aqui chegou à nota mínima (a parte dos registros em
              que foram iguais ou melhores que a original). Regras travadas em Quem usa qual modelo continuam valendo. Sem
              nenhum aprovado, ele segue com todos e avisa no motivo.
            </small>
          </span>
          <FieldHistory title="Liberação pela avaliação" area="router" fields={["gate_enabled", "gate_min"]} />
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
    </div>
  );
}

/** O resultado de um teste, módulo a módulo (as derrotas primeiro). */
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
  const groups = new Map<string, EvalResult[]>();
  for (const r of rows) groups.set(r.feature ?? "", [...(groups.get(r.feature ?? "") ?? []), r]);
  return (
    <div className="evs-detail">
      {[...groups.entries()].map(([feature, list]) => {
        const done = list.filter((r) => r.status === "done");
        const good = done.filter((r) => r.outcome !== "loss").length;
        return (
          <Fragment key={feature}>
            <h5 className="evs-feature">
              {featureLabel(feature)}
              <small className="muted">
                {done.length ? ` · ${good} de ${done.length} iguais ou melhores` : " · sem resultado ainda"}
              </small>
            </h5>
            {list.map((r) => (
              <article
                key={r.id}
                className={r.status !== "done" ? "pending" : r.outcome === "loss" ? "bad" : r.outcome === "tie" ? "tie" : "ok"}
              >
                <header>
                  <strong>{r.question || "(pedido do próprio módulo)"}</strong>
                  <span>
                    {r.status === "done" && r.outcome
                      ? OUTCOME[r.outcome]
                      : r.status === "pending"
                        ? "na fila"
                        : r.status === "skipped"
                          ? `pulado${r.error ? `: ${r.error}` : ""}`
                          : `não deu: ${r.error ?? ""}`}
                    {r.ms !== null && ` · ${ms(r.ms)} (original ${ms(r.base_ms)})`}
                    {r.status === "done" && r.answer_cost !== null && ` · ${usd(r.answer_cost)} (original ${usd(r.base_cost ?? 0)})`}
                  </span>
                </header>
                {r.explanation && <p className="evs-why">{r.explanation}</p>}
                {r.status === "done" && (
                  <div className="evs-compare">
                    <div>
                      <small>Original{r.base_model ? ` · ${r.base_model}` : ""}</small>
                      <p>{r.reference}</p>
                    </div>
                    <div>
                      <small>Resposta do modelo testado</small>
                      <p>{r.answer}</p>
                    </div>
                  </div>
                )}
              </article>
            ))}
          </Fragment>
        );
      })}
    </div>
  );
}

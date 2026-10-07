import { useCallback, useEffect, useState } from "react";
import { Bot, Lightbulb } from "lucide-react";
import { Button, Input, Loading } from "./ui";
import {
  SUGGESTION_REASONS,
  autonomyLine,
  estimateSuggest,
  saveAutonomySettings,
  setAutonomy,
  loadSuggestionStats,
  setSuggest,
  suggestCost,
  suggestionHitRate,
  type SuggestEstimate,
  type SuggestionStats,
} from "./radar-task-learning";

const usd = (n: number) => `US$ ${n < 1 ? n.toFixed(2) : n.toFixed(n < 10 ? 1 : 0)}`.replace(".", ",");
const when = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
const reasonLabel = (r: string) => SUGGESTION_REASONS.find((x) => x.value === r)?.label.toLowerCase() ?? r;

/**
 * Painel da MAVI › Tarefas do Radar › Tarefas sugeridas nos itens
 * (migration 20270608090000): ligar ou desligar (com o custo estimado antes)
 * e como as sugestões se saíram por tópico × produto — aceitas como vieram
 * (o acerto que a Fase 4 usa para liberar a MAVI a abrir sozinha), aceitas
 * com mudança, recusadas e por quê.
 */
export function RadarTaskSuggestStats({
  company,
  days,
  notify,
}: {
  company: string;
  days: number;
  notify: (message: string) => void;
}) {
  const [stats, setStats] = useState<SuggestionStats | null>(null);
  const [error, setError] = useState("");
  const [estimate, setEstimate] = useState<SuggestEstimate | null>(null);
  const [busy, setBusy] = useState("");
  // Os limites da autonomia em edição (null: fechado).
  const [limits, setLimits] = useState<{ rate: string; min: string; days: string; cap: string } | null>(null);

  const reload = useCallback(
    () =>
      loadSuggestionStats(company, days)
        .then(setStats)
        .catch((e) => setError((e as Error).message)),
    [company, days],
  );
  useEffect(() => {
    void reload();
    window.addEventListener("mavi:radar-task-suggestion", reload);
    return () => window.removeEventListener("mavi:radar-task-suggestion", reload);
  }, [reload]);

  async function toggle(on: boolean) {
    setBusy("toggle");
    setError("");
    try {
      const r = await setSuggest(company, on);
      setEstimate(null);
      await reload();
      notify(
        on
          ? r.queued
            ? `Sugestões ligadas. A MAVI vai revisar ${r.queued} item(ns) abertos agora.`
            : "Sugestões ligadas. Valem para os itens novos com regra em uso."
          : "Sugestões desligadas.",
      );
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
      setEstimate(await estimateSuggest(company));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function act(key: string, fn: () => Promise<unknown>, message: string) {
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

  if (!stats)
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
  const s = stats.settings;
  const cost = estimate ? suggestCost(estimate) : null;

  return (
    <section className="panel learning-lessons rtl-suggest">
      <header>
        <div>
          <h2>
            <Lightbulb size={17} aria-hidden="true" /> Tarefas sugeridas nos itens
          </h2>
          <p>
            Com as regras em uso, a MAVI sugere a tarefa no item do Radar (ou vincular uma que já existe). A pessoa
            cria pelo formulário preenchido ou recusa com o motivo. Sem regra que se aplique, ela fica quieta.
          </p>
        </div>
      </header>

      <div className={`rtl-learning${s.suggest ? " on" : ""}`}>
        <Lightbulb size={16} aria-hidden="true" />
        {s.suggest ? (
          <div>
            <strong>Sugestões ligadas</strong>
            <small>
              {s.suggest_by_name ? `Ligadas por ${s.suggest_by_name}${s.suggest_at ? ` em ${when(s.suggest_at)}` : ""}. ` : ""}
              Cada item novo ou reaberto, sem tarefa e com regra em uso, passa pela MAVI.
              {stats.pending ? ` ${stats.pending} item(ns) na fila agora.` : ""}
            </small>
          </div>
        ) : (
          <div>
            <strong>Sugestões desligadas</strong>
            <small>Ligadas, valem só nos tópicos × produtos com regra em uso.</small>
            {estimate && cost && (
              <small className="rtl-estimate">
                {estimate.items
                  ? `Agora: ${estimate.items} item(ns) aberto(s) dos últimos 30 dias, cerca de ${usd(cost.now)}. `
                  : "Nenhum item aberto para revisar agora. "}
                {`Depois, uns ${estimate.per_month} itens por mês: cerca de ${usd(cost.month)} por mês${
                  cost.measured ? " (pela média já medida)" : ""
                }.`}
              </small>
            )}
          </div>
        )}
        {s.suggest ? (
          <Button className="btn secondary" loading={busy === "toggle"} onClick={() => toggle(false)}>
            Desligar
          </Button>
        ) : estimate ? (
          <span className="rtl-learning-actions">
            <Button className="btn secondary" onClick={() => setEstimate(null)}>
              Cancelar
            </Button>
            <Button className="btn primary" loading={busy === "toggle"} onClick={() => toggle(true)}>
              Ligar
            </Button>
          </span>
        ) : (
          <Button className="btn primary" loading={busy === "estimate"} onClick={askEstimate}>
            Ligar as sugestões…
          </Button>
        )}
      </div>

      <div className={`rtl-learning rtl-autonomy${s.mavi_name ? " on" : ""}`}>
        <Bot size={16} aria-hidden="true" />
        <div>
          <strong>A MAVI abrindo sozinha</strong>
          <small>
            Libere por tópico × produto na tabela. Com a autonomia liberada, a sugestão vira tarefa na hora,{" "}
            {s.mavi_name ? (
              <>
                criada por <b>{s.mavi_name}</b>
              </>
            ) : (
              "criada pela MAVI"
            )}
            , enquanto o acerto dos últimos {s.autonomy_days ?? 30} dias for de pelo menos {s.autonomy_rate ?? 90}% (com{" "}
            {s.autonomy_min ?? 10} sugestões decididas ou mais), até {s.autonomy_cap ?? 3} por cliente por dia. O
            responsável do item é avisado e pode desfazer em 24 h.
          </small>
          {!s.mavi_name && (
            <small className="rtl-error">
              A MAVI ainda não é membro ativo da empresa: convide o e-mail mcc@makevendas.com.br para ela poder criar
              tarefas.
            </small>
          )}
          {limits && (
            <div className="rtl-limits">
              <label>
                Acerto mínimo (%)
                <Input type="number" min={50} max={100} value={limits.rate} onChange={(e) => setLimits({ ...limits, rate: e.target.value })} />
              </label>
              <label>
                Mínimo de sugestões decididas
                <Input type="number" min={3} max={200} value={limits.min} onChange={(e) => setLimits({ ...limits, min: e.target.value })} />
              </label>
              <label>
                Janela (dias)
                <Input type="number" min={7} max={180} value={limits.days} onChange={(e) => setLimits({ ...limits, days: e.target.value })} />
              </label>
              <label>
                Teto por cliente por dia
                <Input type="number" min={1} max={50} value={limits.cap} onChange={(e) => setLimits({ ...limits, cap: e.target.value })} />
              </label>
            </div>
          )}
        </div>
        {limits ? (
          <span className="rtl-learning-actions">
            <Button className="btn secondary" onClick={() => setLimits(null)}>
              Cancelar
            </Button>
            <Button
              className="btn primary"
              loading={busy === "limits"}
              onClick={() =>
                act(
                  "limits",
                  async () => {
                    await saveAutonomySettings(company, {
                      rate: Number(limits.rate),
                      min: Number(limits.min),
                      days: Number(limits.days),
                      cap: Number(limits.cap),
                    });
                    setLimits(null);
                  },
                  "Limites da autonomia salvos.",
                )
              }
            >
              Salvar
            </Button>
          </span>
        ) : (
          <Button
            className="btn secondary"
            onClick={() =>
              setLimits({
                rate: String(s.autonomy_rate ?? 90),
                min: String(s.autonomy_min ?? 10),
                days: String(s.autonomy_days ?? 30),
                cap: String(s.autonomy_cap ?? 3),
              })
            }
          >
            Limites
          </Button>
        )}
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {stats.groups.length ? (
        <div className="learning-kinds rtl-suggest-table">
          <table className="stack-mobile stack-3 rtl-groups">
            <thead>
              <tr>
                <th>Tópico · produto</th>
                <th title="Aceitas como vieram (mesma equipe ou pessoa, prazo, prioridade e produto) ÷ sugestões já decididas">Acerto</th>
                <th>Aceitas</th>
                <th>Recusadas</th>
                <th title="Tarefa por outro caminho, ou o item fechou com a sugestão em aberto">Ignoradas</th>
                <th title="Itens em que nenhuma regra se aplicava">Ficou quieta</th>
                <th title="Tarefas que a MAVI criou sozinha e as que foram desfeitas">Sozinha</th>
                <th>Autonomia</th>
              </tr>
            </thead>
            <tbody>
              {stats.groups.map((g) => {
                const rate = suggestionHitRate(g);
                const reasons = Object.entries(g.reasons)
                  .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                  .map(([r, n]) => `${reasonLabel(r)} (${n})`)
                  .join(", ");
                return (
                  <tr key={`${g.topic_id}:${g.product_id ?? ""}`}>
                    <td>
                      <span className="rtl-topic" style={{ background: g.topic_color }} aria-hidden="true" />
                      {g.topic_name}
                      <small>{g.product_name ?? "Geral / Agência"}</small>
                    </td>
                    <td data-label="Acerto">
                      <span className="learning-rate">
                        <span style={{ width: `${rate ?? 0}%` }} />
                      </span>
                      {rate === null ? "—" : `${rate}%`}
                      {g.open > 0 && <small>{g.open} em aberto</small>}
                    </td>
                    <td data-label="Aceitas">
                      {g.accepted}
                      <small>
                        {g.as_is} como vieram · {g.accepted - g.as_is} com mudança
                      </small>
                    </td>
                    <td data-label="Recusadas">
                      {g.dismissed}
                      {reasons && <small>{reasons}</small>}
                    </td>
                    <td data-label="Ignoradas">
                      {g.replaced + g.expired}
                      {g.replaced + g.expired > 0 && (
                        <small>
                          {g.replaced} por outro caminho · {g.expired} fechadas
                        </small>
                      )}
                    </td>
                    <td data-label="Ficou quieta">{g.quiet}</td>
                    <td data-label="Sozinha">
                      {g.auto ?? 0}
                      {(g.undone ?? 0) > 0 && <small>{g.undone} desfeita(s)</small>}
                    </td>
                    <td data-label="Autonomia">
                      <Button
                        className={`btn compact ${g.autonomy?.enabled ? "secondary" : "primary"}`}
                        loading={busy === `a${g.topic_id}:${g.product_id ?? ""}`}
                        onClick={() =>
                          act(
                            `a${g.topic_id}:${g.product_id ?? ""}`,
                            () => setAutonomy(company, g.topic_id, g.product_id, !g.autonomy?.enabled),
                            g.autonomy?.enabled
                              ? "Autonomia desligada: a MAVI volta a só sugerir neste grupo."
                              : "Autonomia liberada: a MAVI abre sozinha enquanto o acerto estiver no limite.",
                          )
                        }
                      >
                        {g.autonomy?.enabled ? "Desligar" : "Liberar"}
                      </Button>
                      <small className={g.autonomy?.active ? "rtl-ok" : undefined}>{autonomyLine(g, s)}</small>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="learning-empty">
          {s.suggest ? "Nenhuma sugestão neste período ainda." : "Ligue as sugestões para acompanhar o acerto da MAVI aqui."}
        </p>
      )}
    </section>
  );
}

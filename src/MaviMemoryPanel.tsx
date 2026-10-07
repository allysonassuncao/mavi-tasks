import { useCallback, useEffect, useState } from "react";
import { BookMarked, Brain, CheckCircle2, Coins, Flag, ShieldCheck, ThumbsUp } from "lucide-react";
import { Loading } from "./ui";
import { DOSSIER_KINDS } from "./ClientDossier";
import { driveUrl, navigate } from "./router";
import type { Snapshot } from "./types";
import { memoryStats, saveMemorySettings, share, type MemorySettings, type MemoryStats } from "./dossier-memory";
import "./dossier-memory.css";

/**
 * Painel da MAVI › Memória (administradores e gestores; migração
 * 20270614090000_mavi_memory_review): se a memória (a ficha de cada pessoa e
 * o dossiê de cada cliente) está ajudando — 👍/👎 e a conferência do Jev com e
 * sem memória —, o que a MAVI anotou e o que o time fez com as sugestões, a
 * autonomia por tipo de item, os mais contestados, o custo e a configuração
 * (autonomia, revisão do histórico, resumo da semana).
 */
const PERIODS = [30, 90, 180];
const STATUS_LABELS: Record<string, string> = {
  suggested: "esperando",
  confirmed: "confirmadas",
  refused: "recusadas",
  expired: "vencidas",
  rejected: "recusadas pelo Jev",
  auto: "entraram sozinhas",
  contested: "contestados (aguardando)",
  restored: "restaurados",
  discarded: "descartados",
};
const money = (n: number | undefined) =>
  `US$ ${(n ?? 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;

export function MaviMemoryPanel({
  company,
  data,
  demo,
  notify,
}: {
  company: string;
  data: Snapshot;
  demo: boolean;
  notify: (message: string) => void;
}) {
  return demo ? (
    <p className="panel ai-route-empty">
      No ambiente demonstrativo não há memória da MAVI para medir. Ela aparece com as conversas e os dossiês reais.
    </p>
  ) : (
    <MemoryReport company={company} data={data} notify={notify} />
  );
}

export function MemoryReport({
  company,
  data,
  notify,
  initial = null,
}: {
  company: string;
  data: Snapshot;
  notify: (message: string) => void;
  initial?: MemoryStats | null;
}) {
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<MemoryStats | null>(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setError("");
    memoryStats(company, days)
      .then(setStats)
      .catch((e) => setError((e as Error).message));
  }, [company, days]);
  useEffect(() => {
    if (!initial) load();
  }, [load, initial]);

  async function save(patch: Partial<MemorySettings>, done: string) {
    setBusy(true);
    try {
      const settings = await saveMemorySettings(company, patch);
      setStats((s) => (s ? { ...s, settings } : s));
      notify(done);
      load();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!stats)
    return error ? (
      <p className="form-error" role="alert">
        {error}
      </p>
    ) : (
      <Loading variant="chart" />
    );
  const w = stats.answers?.with ?? { answers: 0, up: 0, down: 0, judged: 0, judged_ok: 0 };
  const wo = stats.answers?.without ?? { answers: 0, up: 0, down: 0, judged: 0, judged_ok: 0 };
  const p = stats.proposals;
  const decided = (p.confirmed ?? 0) + (p.refused ?? 0);
  const s = stats.settings;
  const who = (id: string | null) => (id ? data.members.find((m) => m.user_id === id)?.name : undefined) ?? "alguém";
  const kindLabel = (k: string) => DOSSIER_KINDS.find((x) => x.id === k)?.label ?? k;

  return (
    <div className="learning memory-panel">
      <div className="ai-usage-toolbar">
        <div className="drive-view" role="group" aria-label="Período">
          {PERIODS.map((d) => (
            <button key={d} type="button" className={d === days ? "selected" : ""} onClick={() => setDays(d)}>
              {d} dias
            </button>
          ))}
        </div>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <section className="stats-grid" aria-label="Com e sem memória">
        <article className="stat-card green">
          <div>
            👍 com memória <ThumbsUp size={17} />
          </div>
          <strong>{share(w.up, w.up + w.down)}</strong>
          <footer>
            sem memória: {share(wo.up, wo.up + wo.down)} · {w.up + w.down} e {wo.up + wo.down} avaliadas
          </footer>
        </article>
        <article className="stat-card blue">
          <div>
            Aprovadas pelo Jev com memória <CheckCircle2 size={17} />
          </div>
          <strong>{share(w.judged_ok, w.judged)}</strong>
          <footer>
            sem memória: {share(wo.judged_ok, wo.judged)} · {w.judged} e {wo.judged} conferidas
          </footer>
        </article>
        <article className="stat-card purple">
          <div>
            Respostas que usaram memória <Brain size={17} />
          </div>
          <strong>{share(w.answers, w.answers + wo.answers)}</strong>
          <footer>
            {w.answers} de {w.answers + wo.answers} respostas · {stats.person.people} pessoa(s) com ficha
          </footer>
        </article>
        <article className="stat-card">
          <div>
            Custo da memória <Coins size={17} />
          </div>
          <strong>{money((stats.cost.dossier ?? 0) + (stats.cost.dossier_check ?? 0) + (stats.cost.profile ?? 0))}</strong>
          <footer>
            conferência do Jev: {money(stats.cost.dossier_check)} · dossiês: {money(stats.cost.dossier)} · fichas:{" "}
            {money(stats.cost.profile)}
          </footer>
        </article>
      </section>

      <section className="panel memory-section">
        <h2>
          <BookMarked size={17} aria-hidden="true" /> Dossiês: o que a MAVI propôs
        </h2>
        <p className="memory-lead">
          {stats.applied} item(ns) entraram direto (risco baixo ou médio) · {decided} sugestão(ões) decidida(s) pelo time,{" "}
          {share(p.confirmed ?? 0, decided)} confirmadas.
        </p>
        <ul className="memory-chips">
          {Object.entries(STATUS_LABELS).map(([k, label]) =>
            p[k] ? (
              <li key={k}>
                <strong>{p[k]}</strong> {label}
              </li>
            ) : null,
          )}
        </ul>
        <p className="memory-lead">
          Fichas das pessoas: {stats.person.noted} anotação(ões) na conversa · {stats.person.learned} aprendida(s) pela
          rotina · {stats.person.undone} tirada(s) pelas pessoas · {stats.person.expired} item(ns) de situação vencido(s).
        </p>
      </section>

      <section className="panel memory-section">
        <h2>
          <ShieldCheck size={17} aria-hidden="true" /> Autonomia por tipo de item
        </h2>
        <p className="memory-lead">
          Quando o time confirma quase tudo que a MAVI sugere num tipo, as sugestões desse tipo passam a entrar direto
          (continuam contestáveis). Condição comercial e contradição sempre pedem confirmação.
        </p>
        <table className="memory-table">
          <thead>
            <tr>
              <th>Tipo</th>
              <th>Decididas</th>
              <th>Confirmadas</th>
              <th>Contestados (30 dias)</th>
              <th>Agora</th>
            </tr>
          </thead>
          <tbody>
            {stats.autonomy.map((a) => (
              <tr key={a.kind}>
                <td>{kindLabel(a.kind)}</td>
                <td>
                  {a.decided} de {a.window}
                </td>
                <td>{a.rate === null ? "—" : `${Math.round(a.rate * 100)}%`}</td>
                <td>{a.contests}</td>
                <td>
                  <span className={a.auto ? "memory-auto on" : "memory-auto"}>{a.auto ? "Entra direto" : "Pede confirmação"}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel memory-section">
        <h2>
          <Flag size={17} aria-hidden="true" /> Contestados no período
        </h2>
        {!stats.contested.length ? (
          <p className="memory-lead">Ninguém contestou um item do dossiê no período.</p>
        ) : (
          <ul className="memory-contested">
            {stats.contested.map((c) => (
              <li key={c.id}>
                <div>
                  <small>
                    {c.client} · {kindLabel(c.kind)} · {who(c.by)} · {STATUS_LABELS[c.status] ?? c.status}
                  </small>
                  <p>{c.text}</p>
                  {c.reason && <p className="dossier-review-why">“{c.reason}”</p>}
                </div>
                <a
                  href={driveUrl({ client: c.client_id, dossier: true })}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    navigate(driveUrl({ client: c.client_id, dossier: true }));
                  }}
                >
                  Abrir o dossiê
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel memory-section">
        <h2>Configuração</h2>
        <div className="memory-settings">
          <label className="mavi-judge-toggle">
            <input
              type="checkbox"
              checked={s.dossier_autonomy}
              disabled={busy}
              onChange={(e) =>
                void save(
                  { dossier_autonomy: e.target.checked },
                  e.target.checked ? "Autonomia ligada." : "Autonomia desligada: tudo de risco alto pede confirmação.",
                )
              }
            />
            Autonomia por tipo {s.dossier_autonomy ? "ligada" : "desligada"}
          </label>
          <NumberSetting
            label="Entra direto com"
            suffix={`% de acerto nas últimas ${s.autonomy_window}`}
            value={Math.round(s.autonomy_rate * 100)}
            min={70}
            max={100}
            disabled={busy}
            onSave={(n) => void save({ autonomy_rate: n / 100 }, "Acerto mínimo salvo.")}
          />
          <NumberSetting
            label="Olha as últimas"
            suffix="sugestões decididas de cada tipo"
            value={s.autonomy_window}
            min={10}
            max={50}
            disabled={busy}
            onSave={(n) => void save({ autonomy_window: n }, "Janela salva.")}
          />
          <NumberSetting
            label="Perde a autonomia com"
            suffix="contestados em 30 dias"
            value={s.contest_limit}
            min={1}
            max={20}
            disabled={busy}
            onSave={(n) => void save({ contest_limit: n }, "Limite de contestados salvo.")}
          />
          <NumberSetting
            label="Pergunta “Ainda vale?” do histórico com"
            suffix="dias sem evidência nova"
            value={s.history_days}
            min={30}
            max={365}
            disabled={busy}
            onSave={(n) => void save({ history_days: n }, "Revisão do histórico salva.")}
          />
          <label className="mavi-judge-toggle">
            <input
              type="checkbox"
              checked={s.summary_leaders}
              disabled={busy}
              onChange={(e) =>
                void save(
                  { summary_leaders: e.target.checked },
                  e.target.checked ? "Líderes recebem os contestados no resumo." : "Resumo só para quem atende o cliente.",
                )
              }
            />
            Administradores e gestores recebem os contestados no resumo da semana
          </label>
          <small>
            Toda segunda, às 8h: a revisão das fichas grandes, o “Ainda vale?” do histórico antigo e o resumo da semana
            na caixa de entrada de quem atende cada cliente.
          </small>
        </div>
      </section>
    </div>
  );
}

function NumberSetting({
  label,
  suffix,
  value,
  min,
  max,
  disabled,
  onSave,
}: {
  label: string;
  suffix: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onSave: (n: number) => void;
}) {
  return (
    <label className="memory-number">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        defaultValue={value}
        key={value}
        disabled={disabled}
        aria-label={`${label} ${suffix}`}
        onBlur={(e) => {
          const n = Number(e.target.value);
          if (Number.isInteger(n) && n >= min && n <= max && n !== value) onSave(n);
        }}
      />
      {suffix}
    </label>
  );
}

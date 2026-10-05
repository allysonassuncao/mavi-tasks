import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Plus, ThumbsDown, ThumbsUp } from "lucide-react";
import { Empty } from "./components";
import { Button, Loading, Select, SelectOption } from "./ui";
import type { TutorialMetrics as Metrics, TutorialsApi, ViewSource } from "./tutorials";

const PERIODS = [
  { id: "7", label: "Últimos 7 dias", days: 7 },
  { id: "30", label: "Últimos 30 dias", days: 30 },
  { id: "90", label: "Últimos 90 dias", days: 90 },
  { id: "365", label: "Últimos 12 meses", days: 365 },
] as const;
const SOURCE_LABEL: Record<ViewSource, string> = {
  library: "Biblioteca",
  search: "Busca",
  trail: "Trilhas",
  help: "Botão “?”",
  mavi: "MAVI",
  notice: "Avisos",
  link: "Link direto",
};
const n = (v: number) => (Number(v) || 0).toLocaleString("pt-BR");
const pct = (part: number, total: number) => (total > 0 ? `${Math.round((part / total) * 100)}%` : "—");
/** "AAAA-MM-DD" de hoje menos `days - 1`, no fuso de São Paulo (o período inclui hoje). */
export function periodDates(days: number, now = new Date()) {
  const day = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const to = day(now);
  const start = new Date(`${to}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { from: start.toISOString().slice(0, 10), to };
}

/**
 * Métricas dos tutoriais (administradores e gestores): visualizações,
 * pessoas, vindas da busca, conclusões e votos de cada tutorial, de onde as
 * pessoas abrem, o que o time busca e as buscas sem resultado (com "Criar
 * tutorial").
 */
export function TutorialMetrics({
  api,
  company,
  tick,
  onOpen,
  onCreate,
}: {
  api: TutorialsApi;
  company: string;
  tick: number;
  onOpen: (id: string) => void;
  onCreate: (question: string) => void;
}) {
  const [period, setPeriod] = useState<string>("30");
  const [data, setData] = useState<Metrics | null>(null);
  const [error, setError] = useState("");
  const range = useMemo(() => periodDates(PERIODS.find((p) => p.id === period)?.days ?? 30), [period]);
  useEffect(() => {
    let alive = true;
    setError("");
    api
      .metrics(company, range.from, range.to)
      .then((m) => alive && setData(m))
      .catch((e) => alive && setError((e as Error).message || "Não foi possível carregar as métricas."));
    return () => {
      alive = false;
    };
  }, [api, company, range, tick]);

  const t = data?.totals;
  const sources = data
    ? (Object.entries(data.sources) as [ViewSource, number][]).sort((a, b) => b[1] - a[1])
    : [];
  return (
    <div className="tutorial-metrics">
      <div className="tutorial-metrics-head">
        <Select value={period} onValueChange={setPeriod} aria-label="Período">
          {PERIODS.map((p) => (
            <SelectOption key={p.id} value={p.id}>
              {p.label}
            </SelectOption>
          ))}
        </Select>
      </div>
      {error && <p className="form-error">{error}</p>}
      {!data || !t ? (
        !error && <Loading variant="list" />
      ) : (
        <>
          <div className="tutorial-metric-cards">
            <Card label="Visualizações" value={n(t.views)} hint={`${n(t.viewers)} pessoa${t.viewers === 1 ? "" : "s"}`} />
            <Card label="Buscas" value={n(t.searches)} hint={`${pct(t.opened_searches, t.searches)} abriram um tutorial`} />
            <Card
              label="Buscas sem resultado"
              value={n(t.empty_searches)}
              hint={pct(t.empty_searches, t.searches) + " das buscas"}
              warn={t.empty_searches > 0}
            />
            <Card label="Conclusões" value={n(t.completions)} />
            <Card
              label="Isso ajudou?"
              value={
                <>
                  <ThumbsUp size={16} /> {n(t.up)} <ThumbsDown size={16} /> {n(t.down)}
                </>
              }
              hint="votos no período"
            />
          </div>
          {!!sources.length && (
            <p className="tutorial-metric-sources">
              De onde abrem:{" "}
              {sources.map(([s, v], i) => (
                <span key={s}>
                  {i > 0 && " · "}
                  {SOURCE_LABEL[s] ?? s} <b>{pct(v, t.views)}</b>
                </span>
              ))}
            </p>
          )}

          <section className="trail-section">
            <h2>Por tutorial</h2>
            {data.tutorials.length ? (
              <div className="panel tutorials-admin">
                <table className="stack-mobile">
                  <thead>
                    <tr>
                      <th>Tutorial</th>
                      <th>Visualizações</th>
                      <th>Pessoas</th>
                      <th>Pela busca</th>
                      <th>Conclusões</th>
                      <th>Votos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.tutorials.map((r) => (
                      <tr key={r.id}>
                        <td data-label="Tutorial">
                          <button type="button" className="link-btn tutorials-admin-title" onClick={() => onOpen(r.id)}>
                            {r.title}
                          </button>
                          {r.status === "draft" && <small className="tutorial-readonly"> · fora do ar</small>}
                        </td>
                        <td data-label="Visualizações">{n(r.views)}</td>
                        <td data-label="Pessoas">{n(r.viewers)}</td>
                        <td data-label="Pela busca">{n(r.from_search)}</td>
                        <td data-label="Conclusões">{n(r.completions)}</td>
                        <td data-label="Votos">
                          <span className="tutorial-metric-votes">
                            <ThumbsUp size={13} /> {r.up} <ThumbsDown size={13} /> {r.down}
                            {r.down_current > 0 && (
                              <small title="👎 na versão que está no ar"> ({r.down_current} na versão atual)</small>
                            )}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="panel">
                <Empty title="Nenhum tutorial publicado" body="Quando houver tutoriais no ar, os números de cada um aparecem aqui." />
              </div>
            )}
          </section>

          <div className="tutorial-metric-split">
            <section className="trail-section">
              <h2>O que o time busca</h2>
              {data.queries.length ? (
                <ol className="tutorial-metric-queries">
                  {data.queries.map((q) => (
                    <li key={q.query_key}>
                      <span>{q.query}</span>
                      <small>
                        {n(q.searches)}× · {n(q.people)} pessoa{q.people === 1 ? "" : "s"}
                        {q.empty ? ` · ${n(q.empty)} sem resultado` : ""}
                        {q.opened ? ` · ${n(q.opened)} abriram` : ""}
                      </small>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="trail-section-hint">Nenhuma busca no período.</p>
              )}
            </section>
            <section className="trail-section">
              <h2>Buscas sem resultado</h2>
              {data.empty.length ? (
                <ol className="tutorial-metric-queries">
                  {data.empty.map((q) => (
                    <li key={q.query_key}>
                      <span>{q.query}</span>
                      <small>
                        {n(q.empty)}× · {n(q.people)} pessoa{q.people === 1 ? "" : "s"}
                      </small>
                      <Button className="btn secondary small" onClick={() => onCreate(q.query)}>
                        <Plus size={14} /> Criar tutorial
                      </Button>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="trail-section-hint">Toda busca do período encontrou algum tutorial.</p>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function Card({ label, value, hint, warn }: { label: string; value: ReactNode; hint?: string; warn?: boolean }) {
  return (
    <div className={`tutorial-metric-card ${warn ? "warn" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}

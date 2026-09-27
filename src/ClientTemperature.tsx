import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  AlertTriangle,
  ExternalLink,
  MessageCircle,
  RefreshCw,
  Settings2,
  Sparkles,
  Thermometer,
  Video,
} from "lucide-react";
import { Button, Loading } from "./ui";
import { Empty } from "./components";
import {
  appPath,
  bandIndex,
  bandOf,
  dateBr,
  loadClientTemperature,
  openInApp,
  scoreLabel,
  signalPath,
  trendLabel,
  trendTone,
  type ClientTemperature as Data,
  type TemperatureBand,
} from "./temperature";

/**
 * Drive › cliente › Termômetro: a temperatura da relação com o cliente, que
 * o Jev lê nas reuniões gravadas e nos grupos de WhatsApp — a nota de hoje
 * na escala da agência, a explicação da MAVI, os indicadores, o histórico e
 * as leituras que entraram no cálculo (cada uma abre a reunião ou a
 * conversa). Quem vê é quem vê o cliente no Drive.
 */
export function ClientTemperature({
  company,
  client,
  clientName,
}: {
  company: string;
  client: string;
  clientName: string;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setError("");
    setBusy(true);
    loadClientTemperature(company, client)
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  }, [company, client]);
  useEffect(load, [load]);

  if (!data)
    return error ? (
      <p className="form-error" role="alert">
        {error}
      </p>
    ) : (
      <Loading />
    );
  const bands = data.settings.bands;
  const c = data.current;
  const band = bandOf(bands, c?.band);
  const names = new Map(data.indicators.map((i) => [i.key, i.name]));
  const reasonLabel = new Map(data.settings.reasons.map((r) => [r.key, r.label]));

  return (
    <section className="thermo" aria-label={`Termômetro de ${clientName}`}>
      <header className="thermo-head">
        <div>
          <h2>
            <Thermometer size={18} aria-hidden="true" /> Termômetro
          </h2>
          <p>
            A temperatura da relação com {clientName}, lida pela MAVI nas
            reuniões gravadas e nos grupos de WhatsApp.
          </p>
          <small className="thermo-meta">
            {c
              ? `${c.signals} ${c.signals === 1 ? "leitura" : "leituras"} nos últimos ${data.settings.window_days} dias`
              : ""}
            {data.refreshed_at ? ` · calculado em ${dateBr(data.refreshed_at)}` : ""}
            {data.pending > 0
              ? ` · ${data.pending} ${data.pending === 1 ? "leitura na fila" : "leituras na fila"}`
              : ""}
          </small>
        </div>
        <div className="thermo-head-actions">
          <Button
            className="icon-btn"
            onClick={load}
            loading={busy}
            aria-label="Atualizar"
            title="Atualizar"
          >
            <RefreshCw size={15} />
          </Button>
          {data.can_configure && (
            <a
              className="btn secondary"
              href={appPath("/mavi#termometro")}
              onClick={(e) => {
                e.preventDefault();
                openInApp("/mavi#termometro");
              }}
            >
              <Settings2 size={15} aria-hidden="true" /> Configurar
            </a>
          )}
        </div>
      </header>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!data.jev && (
        <p className="panel thermo-warning" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          O termômetro ainda não está ligado: um administrador precisa cadastrar
          o Jev (TypeSafe) num provedor OpenRouter em Painel da MAVI › Provedores
          e modelos.
        </p>
      )}

      {!c || c.score === null ? (
        <Empty
          title="Ainda sem temperatura"
          body={
            data.pending > 0
              ? "A MAVI está lendo as reuniões e as conversas do cliente. A temperatura aparece em alguns minutos."
              : `Nenhuma reunião gravada ou conversa de WhatsApp com fala do cliente nos últimos ${data.settings.window_days} dias.`
          }
        />
      ) : (
        <>
          <div className="thermo-top">
            <div className="thermo-now">
              <Gauge score={c.score} bands={bands} />
              <div className="thermo-reading">
                <span className="thermo-score">
                  {scoreLabel(c.score)}
                  <small>/100</small>
                </span>
                {band && (
                  <span
                    className="thermo-band"
                    style={{ "--band": band.color } as CSSProperties}
                  >
                    {band.name}
                  </span>
                )}
                <span className="thermo-trends">
                  <Trend label="7 dias" value={c.score_d7} />
                  <Trend label="30 dias" value={c.score_d30} />
                </span>
              </div>
            </div>
            <div className="thermo-story">
              {c.flags.length > 0 && (
                <ul className="thermo-flags" aria-label="Sinais de alerta">
                  {c.flags.map((f) => (
                    <li key={f.key} className={f.alert ? "alert" : ""}>
                      <AlertTriangle size={13} aria-hidden="true" />
                      {f.name}
                      {f.at && <small>{dateBr(f.at)}</small>}
                    </li>
                  ))}
                </ul>
              )}
              {data.summary ? (
                <div className="thermo-summary">
                  <span className="thermo-summary-label">
                    <Sparkles size={13} aria-hidden="true" /> Explicação da MAVI
                    {data.summary.at && <small>{dateBr(data.summary.at)}</small>}
                  </span>
                  <p>{data.summary.text}</p>
                </div>
              ) : (
                <p className="thermo-summary muted">
                  A MAVI escreve a explicação quando a temperatura muda.
                </p>
              )}
              {c.reasons.length > 0 && (
                <div className="thermo-reasons">
                  <span>O que mais mexe com o cliente</span>
                  <ul>
                    {c.reasons.map((r) => (
                      <li key={r.key}>
                        <span className="thermo-reason-bar" style={{ width: `${r.share}%` }} />
                        <span>{r.label}</span>
                        <strong>{r.share}%</strong>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>

          <section className="thermo-block" aria-label="Indicadores">
            <h3>Indicadores</h3>
            <ul className="thermo-indicators">
              {c.indicators.map((i) => {
                const b = bandOf(bands, bandIndex(bands, i.value));
                return (
                  <li key={i.key}>
                    <span className="thermo-ind-name">
                      {i.name}
                      <small>peso {Number(i.weight).toLocaleString("pt-BR")}</small>
                    </span>
                    <span className="thermo-ind-bar" aria-hidden="true">
                      {i.value !== null && (
                        <span
                          style={{
                            width: `${Math.max(2, i.value)}%`,
                            background: b?.color,
                          }}
                        />
                      )}
                    </span>
                    <span className="thermo-ind-value">
                      {i.value === null ? "sem dados" : scoreLabel(i.value)}
                    </span>
                    <Trend label="30 dias" value={i.d30} compact />
                  </li>
                );
              })}
            </ul>
          </section>

          {data.history && data.history.length > 1 && (
            <section className="thermo-block" aria-label="Histórico">
              <h3>Histórico</h3>
              <History history={data.history} bands={bands} />
            </section>
          )}
        </>
      )}

      {data.signals.length > 0 && (
        <section className="thermo-block" aria-label="Leituras">
          <h3>
            Leituras recentes <small>cada reunião ou dia de grupo que o Jev leu</small>
          </h3>
          <ul className="thermo-signals">
            {data.signals.map((s) => {
              const path = signalPath(s);
              const notes = Object.entries(s.answers).filter(([, a]) => (a.e ?? 1) >= 0.3);
              const flags = Object.entries(s.flags).filter(([, p]) => p >= data.settings.flag_threshold);
              return (
                <li key={s.id}>
                  <span className={`thermo-signal-icon ${s.type}`} aria-hidden="true">
                    {s.type === "meeting" ? <Video size={15} /> : <MessageCircle size={15} />}
                  </span>
                  <div>
                    <div className="thermo-signal-head">
                      <strong>{s.title || (s.type === "meeting" ? "Reunião" : "WhatsApp")}</strong>
                      <time dateTime={s.date}>{dateBr(s.date)}</time>
                      {s.status === "pending" && <small className="thermo-pending">na fila</small>}
                      {path && (
                        <a
                          href={appPath(path)}
                          onClick={(e) => {
                            e.preventDefault();
                            openInApp(path);
                          }}
                          className="thermo-open"
                        >
                          Abrir <ExternalLink size={12} aria-hidden="true" />
                        </a>
                      )}
                    </div>
                    {(notes.length > 0 || flags.length > 0 || s.reason) && (
                      <div className="thermo-chips">
                        {notes.map(([k, a]) => {
                          const b = bandOf(bands, bandIndex(bands, a.v));
                          return (
                            <span
                              key={k}
                              className="thermo-chip"
                              style={{ "--band": b?.color ?? "#a3acab" } as CSSProperties}
                            >
                              {names.get(k) ?? k} <strong>{scoreLabel(a.v)}</strong>
                            </span>
                          );
                        })}
                        {flags.map(([k]) => (
                          <span key={k} className="thermo-chip flag">
                            <AlertTriangle size={11} aria-hidden="true" /> {names.get(k) ?? k}
                          </span>
                        ))}
                        {s.reason && (
                          <span className="thermo-chip reason">
                            {reasonLabel.get(s.reason)?.split(" (")[0] ?? s.reason}
                          </span>
                        )}
                      </div>
                    )}
                    {s.excerpt && <p className="thermo-excerpt">{s.excerpt}</p>}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </section>
  );
}

function Trend({
  label,
  value,
  compact = false,
}: {
  label: string;
  value: number | null;
  compact?: boolean;
}) {
  const text = trendLabel(value);
  if (!text) return compact ? <span className="thermo-trend flat" /> : null;
  return (
    <span
      className={`thermo-trend ${trendTone(value)}`}
      title={`Diferença em ${label}`}
    >
      {text}
      {!compact && <small> em {label}</small>}
    </span>
  );
}

/** O termômetro: as faixas no tubo e o mercúrio até a nota. */
function Gauge({ score, bands }: { score: number; bands: TemperatureBand[] }) {
  const top = 12;
  const bottom = 150;
  const y = (v: number) => bottom - ((bottom - top) * Math.min(100, Math.max(0, v))) / 100;
  const band = bandOf(bands, bandIndex(bands, score));
  return (
    <svg
      className="thermo-gauge"
      viewBox="0 0 60 190"
      role="img"
      aria-label={`${scoreLabel(score)} de 100${band ? `, ${band.name}` : ""}`}
    >
      {bands.map((b, i) => {
        const from = y(b.min);
        const to = y(bands[i + 1]?.min ?? 100);
        return (
          <rect key={b.name} x="22" y={to} width="16" height={from - to} fill={b.color} opacity="0.22" />
        );
      })}
      <rect x="22" y={top} width="16" height={bottom - top} rx="8" fill="none" stroke="#d5dcdc" strokeWidth="1.5" />
      <rect x="25" y={y(score)} width="10" height={bottom - y(score) + 14} rx="5" fill={band?.color ?? "#84908f"} />
      <circle cx="30" cy="166" r="15" fill={band?.color ?? "#84908f"} stroke="#fff" strokeWidth="3" />
      {bands.map((b) => (
        <line key={b.name} x1="40" x2="46" y1={y(b.min)} y2={y(b.min)} stroke="#b8c2c2" strokeWidth="1" />
      ))}
    </svg>
  );
}

/** A nota dia a dia, sobre as faixas da escala. */
function History({
  history,
  bands,
}: {
  history: NonNullable<Data["history"]>;
  bands: TemperatureBand[];
}) {
  const W = 600;
  const H = 150;
  const points = useMemo(
    () =>
      history.map((d, i) => ({
        x: history.length > 1 ? (i / (history.length - 1)) * W : W / 2,
        y: d.score === null ? null : H - (H * d.score) / 100,
        d,
      })),
    [history],
  );
  // Um traço por trecho com nota (dias sem nota interrompem a linha).
  const paths: string[] = [];
  let current = "";
  for (const p of points) {
    if (p.y === null) {
      if (current) paths.push(current);
      current = "";
      continue;
    }
    current += `${current ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  }
  if (current) paths.push(current);
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover !== null ? points[hover] : points[points.length - 1];
  const label = (i: number) => dateBr(history[i]?.day);
  return (
    <div className="thermo-history">
      <div className="thermo-history-hover" aria-live="polite">
        {shown && (
          <>
            <strong>{scoreLabel(shown.d.score)}</strong>
            {shown.d.band !== null && <span>{bands[shown.d.band]?.name}</span>}
            <small>{dateBr(shown.d.day)}</small>
          </>
        )}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Temperatura de ${label(0)} a ${label(history.length - 1)}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const i = Math.round(((e.clientX - r.left) / r.width) * (history.length - 1));
          setHover(Math.min(history.length - 1, Math.max(0, i)));
        }}
      >
        {bands.map((b, i) => {
          const from = H - (H * b.min) / 100;
          const to = H - (H * (bands[i + 1]?.min ?? 100)) / 100;
          return <rect key={b.name} x="0" y={to} width={W} height={from - to} fill={b.color} opacity="0.1" />;
        })}
        {paths.map((d, i) => (
          <path
            key={i}
            d={d}
            fill="none"
            stroke="#263334"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
          />
        ))}
        {hover !== null && points[hover].y !== null && (
          <line
            x1={points[hover].x}
            x2={points[hover].x}
            y1="0"
            y2={H}
            stroke="#84908f"
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <div className="thermo-history-axis" aria-hidden="true">
        <span>{label(0)}</span>
        <span>{label(Math.floor((history.length - 1) / 2))}</span>
        <span>{label(history.length - 1)}</span>
      </div>
    </div>
  );
}

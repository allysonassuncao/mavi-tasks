import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  EyeOff,
  ExternalLink,
  MessageCircle,
  Pencil,
  RefreshCw,
  RotateCcw,
  Settings2,
  Sparkles,
  Thermometer,
  Video,
  X,
} from "lucide-react";
import { Button, Checkbox, Loading, Select, SelectOption, Textarea } from "./ui";
import { Empty } from "./components";
import { TemperatureTimeline } from "./TemperatureTimeline";
import {
  appPath,
  bandIndex,
  bandOf,
  clearClientFlag,
  correctSignal,
  dateBr,
  levelPercent,
  loadClientTemperature,
  loadSignalMessages,
  nearestLevel,
  openInApp,
  removeSignal,
  restoreSignal,
  scoreLabel,
  signalPath,
  signalTitle,
  trendLabel,
  trendTone,
  type ClientTemperature as Data,
  type SignalChanges,
  type SignalMessage,
  type TemperatureBand,
  type TemperatureSignal,
  type TemperatureSource,
} from "./temperature";

/**
 * Drive › cliente › Termômetro: a temperatura da relação com o cliente, que
 * o Jev lê nas reuniões gravadas e nos grupos de WhatsApp — a nota de hoje
 * na escala da agência, a explicação da MAVI, os indicadores, o histórico, a
 * linha do tempo (TemperatureTimeline) e as leituras que entraram no cálculo (cada uma abre a reunião ou a
 * conversa). Quem vê é quem vê o cliente no Drive. Líderes e supervisores
 * das equipes do cliente corrigem as leituras, retiram a que não conta e
 * tiram um sinal de alerta; a MAVI aprende com as correções.
 */
export function ClientTemperature({
  company,
  client,
  clientName,
  onChanged,
}: {
  company: string;
  client: string;
  clientName: string;
  /** Uma correção mudou a temperatura (a carteira recarrega). */
  onChanged?: () => void;
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
  const changed = useCallback(() => {
    load();
    onChanged?.();
  }, [load, onChanged]);

  if (!data)
    return error ? (
      <p className="form-error" role="alert">
        {error}
      </p>
    ) : (
      <Loading variant="chart" />
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
            {[
              c &&
                `${c.signals} ${c.signals === 1 ? "leitura" : "leituras"} nos últimos ${data.settings.window_days} dias`,
              data.refreshed_at && `calculado em ${dateBr(data.refreshed_at)}`,
              data.pending > 0 &&
                `${data.pending} ${data.pending === 1 ? "leitura na fila" : "leituras na fila"}`,
            ]
              .filter(Boolean)
              .join(" · ")}
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
                <ClientFlags company={company} client={client} data={data} onChanged={changed} />
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

      {(data.history?.length ?? 0) > 0 && (
        <TemperatureTimeline company={company} client={client} data={data} />
      )}

      {data.signals.length > 0 && (
        <Signals
          company={company}
          data={data}
          names={names}
          reasonLabel={reasonLabel}
          onChanged={changed}
        />
      )}
    </section>
  );
}

/**
 * Os sinais de alerta de hoje. Quem corrige tira um sinal do cliente (sai de
 * todas as leituras da janela), contando o motivo.
 */
function ClientFlags({
  company,
  client,
  data,
  onChanged,
}: {
  company: string;
  client: string;
  data: Data;
  onChanged: () => void;
}) {
  const [clearing, setClearing] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const flags = data.current?.flags ?? [];
  const flag = flags.find((f) => f.key === clearing);
  async function clear() {
    if (!flag) return;
    setBusy(true);
    setError("");
    try {
      await clearClientFlag(company, client, flag.key, note);
      setClearing(null);
      setNote("");
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <ul className="thermo-flags" aria-label="Sinais de alerta">
        {flags.map((f) => (
          <li key={f.key} className={f.alert ? "alert" : ""}>
            <AlertTriangle size={13} aria-hidden="true" />
            {f.name}
            {f.at && <small>{dateBr(f.at)}</small>}
            {data.can_correct && (
              <button
                type="button"
                className="thermo-flag-remove"
                aria-label={`Tirar o sinal "${f.name}" do cliente`}
                title="Identificado errado? Tirar o sinal"
                onClick={() => {
                  setClearing(f.key);
                  setError("");
                }}
              >
                <X size={12} aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {flag && (
        <div className="thermo-fix" role="group" aria-label={`Tirar o sinal ${flag.name}`}>
          <p>
            Tirar <strong>{flag.name}</strong> do cliente? O sinal sai de todas as
            leituras dos últimos {data.settings.flag_days} dias em que apareceu.
          </p>
          <label className="thermo-fix-note">
            <span>Por que o sinal não vale? A MAVI aprende com o motivo.</span>
            <Textarea
              value={note}
              rows={2}
              maxLength={500}
              autoFocus
              placeholder="Ex.: era brincadeira sobre as férias, ninguém falou em sair."
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="thermo-fix-actions">
            <Button className="btn secondary compact" onClick={() => setClearing(null)} disabled={busy}>
              Cancelar
            </Button>
            <Button
              className="btn primary compact"
              onClick={clear}
              loading={busy}
              disabled={note.trim().length < 3}
            >
              Tirar o sinal
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

type SourceFilter = "all" | TemperatureSource | "removed";

/**
 * As leituras que entraram no cálculo, com o filtro por fonte. Cada dia de
 * grupo abre as mensagens do cliente que o Jev leu (as do time ficam de fora).
 */
function Signals({
  company,
  data,
  names,
  reasonLabel,
  onChanged,
}: {
  company: string;
  data: Data;
  names: Map<string, string>;
  reasonLabel: Map<string, string>;
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState<SourceFilter>("all");
  const live = data.signals.filter((s) => !s.removed);
  const removed = data.signals.filter((s) => s.removed);
  const count = (t: TemperatureSource) => live.filter((s) => s.type === t).length;
  const shown =
    filter === "removed" ? removed : filter === "all" ? live : live.filter((s) => s.type === filter);
  const wa = data.sources?.whatsapp;
  const tabs: { id: SourceFilter; label: string; n: number }[] = [
    { id: "all", label: "Todas", n: live.length },
    { id: "meeting", label: "Reuniões", n: count("meeting") },
    { id: "whatsapp", label: "WhatsApp", n: count("whatsapp") },
    ...(removed.length || filter === "removed"
      ? [{ id: "removed" as const, label: "Retiradas", n: removed.length }]
      : []),
  ];
  return (
    <section className="thermo-block" aria-label="Leituras">
      <div className="thermo-signals-head">
        <h3>
          Leituras recentes <small>cada reunião ou dia de grupo que o Jev leu</small>
        </h3>
        <div className="drive-view" role="tablist" aria-label="Fonte das leituras">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={filter === t.id}
              className={filter === t.id ? "selected" : ""}
              onClick={() => setFilter(t.id)}
            >
              {t.id === "meeting" && <Video size={13} aria-hidden="true" />}
              {t.id === "whatsapp" && <MessageCircle size={13} aria-hidden="true" />}
              {t.id === "removed" && <EyeOff size={13} aria-hidden="true" />}
              {t.label} <small>{t.n}</small>
            </button>
          ))}
        </div>
      </div>
      {filter === "whatsapp" && wa && (
        <p className="thermo-source-note">
          {wa.groups === 0
            ? "Nenhum grupo de WhatsApp está ligado a este cliente. Um administrador liga o grupo no Painel da MAVI › Grupos do Whatsapp."
            : [
                `${wa.groups} ${wa.groups === 1 ? "grupo ligado" : "grupos ligados"}`,
                `${wa.read} ${wa.read === 1 ? "dia lido" : "dias lidos"}`,
                wa.pending > 0 && `${wa.pending} na fila`,
                wa.failed > 0 && `${wa.failed} com erro`,
                wa.skipped > 0 &&
                  `${wa.skipped} ${wa.skipped === 1 ? "dia" : "dias"} só com mensagens do time (fora do cálculo)`,
              ]
                .filter(Boolean)
                .join(" · ")}
        </p>
      )}
      {filter === "removed" && (
        <p className="thermo-source-note">
          Leituras que não contam para a temperatura (retiradas pelo time ou pela
          MAVI, pelas regras que o time ensinou). Devolva a que deve contar.
        </p>
      )}
      {shown.length === 0 ? (
        <p className="thermo-source-note">
          {filter === "removed"
            ? "Nenhuma leitura retirada."
            : filter === "whatsapp"
              ? "Nenhum dia de grupo com mensagem do cliente ainda."
              : "Nenhuma reunião gravada com o cliente ainda."}
        </p>
      ) : (
        <ul className="thermo-signals">
          {shown.map((s) => (
            <SignalItem
              key={s.id}
              company={company}
              signal={s}
              data={data}
              names={names}
              reasonLabel={reasonLabel}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function SignalItem({
  company,
  signal: s,
  data,
  names,
  reasonLabel,
  onChanged,
}: {
  company: string;
  signal: TemperatureSignal;
  data: Data;
  names: Map<string, string>;
  reasonLabel: Map<string, string>;
  onChanged: () => void;
}) {
  const bands = data.settings.bands;
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"fix" | "remove" | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [actionError, setActionError] = useState("");
  const ov = s.corrected?.overrides;
  const jev = s.corrected?.jev;
  const canFix = !!data.can_correct && !s.removed && s.status !== "failed";
  async function restore() {
    setRestoring(true);
    setActionError("");
    try {
      await restoreSignal(company, s.id);
      onChanged();
    } catch (e) {
      setActionError((e as Error).message);
      setRestoring(false);
    }
  }
  const [messages, setMessages] = useState<SignalMessage[] | null>(null);
  const [error, setError] = useState("");
  const path = signalPath(s);
  const notes = Object.entries(s.answers).filter(([, a]) => (a.e ?? 1) >= 0.3);
  const flags = Object.entries(s.flags).filter(([, p]) => p >= data.settings.flag_threshold);
  const whatsapp = s.type === "whatsapp";
  const lines = s.client_lines ?? 0;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !messages) {
      setError("");
      loadSignalMessages(company, s.id)
        .then(setMessages)
        .catch((e) => setError((e as Error).message));
    }
  };
  const messagePath = (m: SignalMessage) =>
    s.group_id ? `/drive?whatsapp=${s.group_id}&msg=${m.id}` : null;
  // O que a MAVI tinha lido, no título do que o time corrigiu.
  const was = (what: string) => `Corrigido pelo time. A MAVI tinha lido: ${what}`;
  const jevFlag = (k: string) => (jev?.flags[k] ?? 0) >= data.settings.flag_threshold;
  return (
    <li className={s.removed ? "thermo-signal-removed" : undefined}>
      <span className={`thermo-signal-icon ${s.type}`} aria-hidden="true">
        {whatsapp ? <MessageCircle size={15} /> : <Video size={15} />}
      </span>
      <div>
        <div className="thermo-signal-head">
          <strong>{whatsapp && s.group ? s.group : signalTitle(s)}</strong>
          <span className="thermo-signal-meta">
            <time dateTime={s.date}>{whatsapp ? dateBr(s.day) : dateBr(s.date)}</time>
            {whatsapp && lines > 0 && (
              <span>
                {lines} {lines === 1 ? "mensagem do cliente" : "mensagens do cliente"}
              </span>
            )}
            {s.status === "pending" && <small className="thermo-pending">na fila</small>}
          </span>
        </div>
        {(notes.length > 0 || flags.length > 0 || s.reason) && (
          <div className="thermo-chips">
            {notes.map(([k, a]) => {
              const b = bandOf(bands, bandIndex(bands, a.v));
              const fixed = ov?.answers?.[k];
              const before = jev?.answers[k];
              return (
                <span
                  key={k}
                  className={`thermo-chip${fixed ? " corrected" : ""}`}
                  style={{ "--band": b?.color ?? "#a3acab" } as CSSProperties}
                  title={
                    fixed
                      ? was(before && (before.e ?? 1) >= 0.3 ? scoreLabel(before.v) : "não fala disso")
                      : undefined
                  }
                >
                  {names.get(k) ?? k} <strong>{scoreLabel(a.v)}</strong>
                  {fixed && <Pencil size={10} aria-label="corrigido" />}
                </span>
              );
            })}
            {flags.map(([k]) => (
              <span
                key={k}
                className={`thermo-chip flag${ov?.flags?.[k] !== undefined ? " corrected" : ""}`}
                title={ov?.flags?.[k] !== undefined ? was("sem este sinal") : undefined}
              >
                <AlertTriangle size={11} aria-hidden="true" /> {names.get(k) ?? k}
                {ov?.flags?.[k] !== undefined && <Pencil size={10} aria-label="corrigido" />}
              </span>
            ))}
            {s.reason && (
              <span
                className={`thermo-chip reason${ov?.reason ? " corrected" : ""}`}
                title={
                  ov?.reason
                    ? was(`assunto "${reasonLabel.get(jev?.reason ?? "")?.split(" (")[0] ?? "nenhum"}"`)
                    : undefined
                }
              >
                {reasonLabel.get(s.reason)?.split(" (")[0] ?? s.reason}
                {ov?.reason && <Pencil size={10} aria-label="corrigido" />}
              </span>
            )}
          </div>
        )}
        {ov && Object.entries(ov.flags ?? {}).some(([k, v]) => !v && jevFlag(k)) && (
          <div className="thermo-chips">
            {Object.entries(ov.flags ?? {})
              .filter(([k, v]) => !v && jevFlag(k))
              .map(([k]) => (
                <span key={k} className="thermo-chip flag removed" title={was("com este sinal")}>
                  <AlertTriangle size={11} aria-hidden="true" /> {names.get(k) ?? k}
                </span>
              ))}
          </div>
        )}
        {s.corrected && (
          <small className="thermo-fixed-by">
            <Pencil size={11} aria-hidden="true" /> Corrigida
            {s.corrected.by ? ` por ${s.corrected.by}` : ""}
            {s.corrected.at ? ` em ${dateBr(s.corrected.at)}` : ""}
          </small>
        )}
        {s.removed && (
          <p className="thermo-removed-note">
            <EyeOff size={12} aria-hidden="true" />
            <span>
              {s.removed.auto
                ? "Retirada pela MAVI"
                : `Retirada${s.removed.by ? ` por ${s.removed.by}` : ""}`}{" "}
              em {dateBr(s.removed.at)}
              {s.removed.reason && <>: {s.removed.reason}</>}
            </span>
          </p>
        )}
        {!open && s.excerpt && <p className="thermo-excerpt">{s.excerpt}</p>}
        {whatsapp && (
          <button
            type="button"
            className="thermo-messages-toggle"
            aria-expanded={open}
            onClick={toggle}
          >
            {open ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
            {open ? "Esconder as mensagens" : "Ver as mensagens do cliente"}
          </button>
        )}
        {open && (
          <div className="thermo-messages" aria-live="polite">
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : !messages ? (
              <Loading compact label="Carregando as mensagens" />
            ) : messages.length === 0 ? (
              <p className="thermo-source-note">Nenhuma mensagem do cliente neste dia.</p>
            ) : (
              <ol>
                {messages.map((m) => {
                  const to = messagePath(m);
                  return (
                    <li key={m.id}>
                      <span className="thermo-message-meta">
                        <time dateTime={m.at}>{timeBr(m.at)}</time>
                        <strong>{m.who}</strong>
                        {m.edited && <small>editada</small>}
                      </span>
                      <p>{m.text}</p>
                      {to && (
                        <a
                          href={appPath(to)}
                          onClick={(e) => {
                            e.preventDefault();
                            openInApp(to);
                          }}
                          className="thermo-open"
                        >
                          Ver na conversa <ExternalLink size={11} aria-hidden="true" />
                        </a>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        )}
        {(canFix || (s.removed && data.can_correct)) && !mode && (
          <div className="thermo-signal-actions">
            {canFix && (
              <>
                <button type="button" className="text-btn" onClick={() => setMode("fix")}>
                  <Pencil size={12} aria-hidden="true" /> Corrigir
                </button>
                <button type="button" className="text-btn" onClick={() => setMode("remove")}>
                  <EyeOff size={12} aria-hidden="true" /> Retirar
                </button>
              </>
            )}
            {s.removed && data.can_correct && (
              <Button className="text-btn" onClick={restore} loading={restoring}>
                <RotateCcw size={12} aria-hidden="true" /> Devolver ao cálculo
              </Button>
            )}
          </div>
        )}
        {actionError && (
          <p className="form-error" role="alert">
            {actionError}
          </p>
        )}
        {mode === "fix" && (
          <SignalCorrection
            company={company}
            signal={s}
            data={data}
            onClose={() => setMode(null)}
            onSaved={() => {
              setMode(null);
              onChanged();
            }}
          />
        )}
        {mode === "remove" && (
          <SignalRemoval
            company={company}
            signal={s}
            onClose={() => setMode(null)}
            onSaved={() => {
              setMode(null);
              onChanged();
            }}
          />
        )}
      </div>
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
    </li>
  );
}

/** O valor de uma nota no seletor: como a MAVI leu, um nível ou "não fala disso". */
type ScoreChoice = "auto" | "none" | `lvl:${number}`;

/**
 * Corrigir uma leitura: o assunto, os sinais e as notas. Só vai ao banco o
 * que mudou; o motivo ensina a MAVI.
 */
function SignalCorrection({
  company,
  signal: s,
  data,
  onClose,
  onSaved,
}: {
  company: string;
  signal: TemperatureSignal;
  data: Data;
  onClose: () => void;
  onSaved: () => void;
}) {
  const threshold = data.settings.flag_threshold;
  const ov = s.corrected?.overrides ?? {};
  const jev = s.corrected?.jev ?? { answers: s.answers, flags: s.flags, reason: s.reason };
  const scores = data.indicators.filter((i) => i.kind === "score");
  const flagList = data.indicators.filter((i) => i.kind === "flag");
  const initial = useMemo(() => {
    const answers: Record<string, ScoreChoice> = {};
    for (const i of scores) {
      const o = ov.answers?.[i.key];
      answers[i.key] = !o
        ? "auto"
        : o.e === 0
          ? "none"
          : `lvl:${nearestLevel(o.v, i.levels.length)}`;
    }
    const flags: Record<string, boolean> = {};
    for (const f of flagList) flags[f.key] = (s.flags[f.key] ?? 0) >= threshold;
    return { reason: s.reason ?? "", flags, answers };
  }, [s]); // eslint-disable-line react-hooks/exhaustive-deps
  const [reason, setReason] = useState(initial.reason);
  const [flags, setFlags] = useState(initial.flags);
  const [answers, setAnswers] = useState(initial.answers);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const changes = (): SignalChanges => {
    const out: SignalChanges = {};
    if (reason && reason !== initial.reason) out.reason = reason;
    const f = Object.fromEntries(
      Object.entries(flags).filter(([k, v]) => v !== initial.flags[k]),
    );
    if (Object.keys(f).length) out.flags = f;
    const a: NonNullable<SignalChanges["answers"]> = {};
    for (const i of scores) {
      const v = answers[i.key];
      if (v === initial.answers[i.key]) continue;
      a[i.key] =
        v === "auto"
          ? null
          : v === "none"
            ? { e: 0 }
            : { v: levelPercent(Number(v.slice(4)), i.levels.length) };
    }
    if (Object.keys(a).length) out.answers = a;
    return out;
  };
  const pending = changes();
  const dirty = Object.keys(pending).length > 0;

  async function save(c: SignalChanges) {
    setBusy(true);
    setError("");
    try {
      await correctSignal(company, s.id, c, note);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  // Desfazer: tudo volta ao que o Jev disse.
  const undo = (): SignalChanges => ({
    ...(ov.reason ? { reason: null } : {}),
    ...(ov.flags ? { flags: Object.fromEntries(Object.keys(ov.flags).map((k) => [k, null])) } : {}),
    ...(ov.answers ? { answers: Object.fromEntries(Object.keys(ov.answers).map((k) => [k, null])) } : {}),
  });
  const jevScore = (key: string, levels: string[]) => {
    const a = jev.answers[key];
    if (!a || (a.e ?? 1) < 0.3) return "não fala disso";
    return `${levels[nearestLevel(a.v, levels.length)]?.split(":")[0] ?? ""} (${scoreLabel(a.v)})`;
  };

  return (
    <div className="thermo-fix" role="group" aria-label="Corrigir a leitura">
      <p className="thermo-fix-intro">
        Corrija o que a MAVI leu errado. A temperatura é refeita na hora e a MAVI
        usa a correção nas próximas leituras.
      </p>
      {data.settings.reasons.length > 0 && (
        <label className="thermo-fix-field">
          <span>Assunto que mais mexe com o cliente</span>
          <Select aria-label="Assunto" value={reason} onValueChange={setReason}>
            {data.settings.reasons.map((r) => (
              <SelectOption key={r.key} value={r.key}>
                {r.label.split(" (")[0]}
                {r.key === jev.reason ? " · como a MAVI leu" : ""}
              </SelectOption>
            ))}
          </Select>
        </label>
      )}
      {flagList.length > 0 && (
        <fieldset className="thermo-fix-field">
          <legend>Sinais de alerta nesta leitura</legend>
          <div className="thermo-fix-flags">
            {flagList.map((f) => (
              <label key={f.key} className="thermo-check">
                <Checkbox
                  checked={flags[f.key]}
                  onCheckedChange={(v) => setFlags((x) => ({ ...x, [f.key]: v === true }))}
                />
                {f.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {scores.length > 0 && (
        <fieldset className="thermo-fix-field">
          <legend>Notas</legend>
          <div className="thermo-fix-scores">
            {scores.map((i) => (
              <label key={i.key}>
                <span>{i.name}</span>
                <Select
                  aria-label={i.name}
                  value={answers[i.key]}
                  onValueChange={(v) => setAnswers((x) => ({ ...x, [i.key]: v as ScoreChoice }))}
                >
                  <SelectOption value="auto">Como a MAVI leu: {jevScore(i.key, i.levels)}</SelectOption>
                  {i.levels.map((l, n) => (
                    <SelectOption key={n} value={`lvl:${n}`}>
                      {l} ({scoreLabel(levelPercent(n, i.levels.length))})
                    </SelectOption>
                  ))}
                  <SelectOption value="none">A leitura não fala disso</SelectOption>
                </Select>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <label className="thermo-fix-note">
        <span>Por quê? A MAVI aprende com o motivo.</span>
        <Textarea
          value={note}
          rows={2}
          maxLength={500}
          placeholder="Ex.: o cliente estava brincando sobre as férias; a reclamação era sobre a verba."
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="thermo-fix-actions">
        {s.corrected && (
          <Button className="btn secondary compact thermo-fix-undo" onClick={() => save(undo())} disabled={busy}>
            <RotateCcw size={13} aria-hidden="true" /> Voltar ao que a MAVI leu
          </Button>
        )}
        <Button className="btn secondary compact" onClick={onClose} disabled={busy}>
          Cancelar
        </Button>
        <Button className="btn primary compact" onClick={() => save(pending)} loading={busy} disabled={!dirty}>
          Salvar correção
        </Button>
      </div>
    </div>
  );
}

/** Retirar a leitura do cálculo (o motivo é obrigatório: ensina a MAVI). */
function SignalRemoval({
  company,
  signal: s,
  onClose,
  onSaved,
}: {
  company: string;
  signal: TemperatureSignal;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      await removeSignal(company, s.id, reason);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className="thermo-fix" role="group" aria-label="Retirar a leitura">
      <p className="thermo-fix-intro">
        A {s.type === "meeting" ? "reunião" : "conversa do dia"} sai do cálculo da
        temperatura. Você pode devolver depois, na aba Retiradas.
      </p>
      <label className="thermo-fix-note">
        <span>Por que esta leitura não conta? A MAVI aprende com o motivo.</span>
        <Textarea
          value={reason}
          rows={2}
          maxLength={500}
          autoFocus
          placeholder="Ex.: reunião interna do time, sem o cliente; grupo de outro cliente."
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="thermo-fix-actions">
        <Button className="btn secondary compact" onClick={onClose} disabled={busy}>
          Cancelar
        </Button>
        <Button
          className="btn danger compact"
          onClick={save}
          loading={busy}
          disabled={reason.trim().length < 3}
        >
          Retirar leitura
        </Button>
      </div>
    </div>
  );
}

const timeBr = (iso: string) =>
  new Date(iso).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  });

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

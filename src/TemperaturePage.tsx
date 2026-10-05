import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AlertTriangle, ExternalLink, RefreshCw, Settings2, Thermometer } from "lucide-react";
import { Button, Checkbox, Input, Loading, Select, SelectOption } from "./ui";
import { Empty, Modal } from "./components";
import type { Snapshot } from "./types";
import {
  appPath,
  bandOf,
  clientTemperaturePath,
  dateBr,
  loadPortfolio,
  openInApp,
  scoreLabel,
  trendLabel,
  trendTone,
  type Portfolio,
} from "./temperature";

const ALL = "__all__";
// A aba do cliente, a mesma do Drive, no painel lateral.
const ClientTemperature = lazy(() =>
  import("./ClientTemperature").then((m) => ({ default: m.ClientTemperature })),
);

/**
 * Termômetro dos clientes: a carteira do cliente mais frio ao mais quente,
 * com a tendência, os sinais de alerta e o assunto que mais mexe com cada
 * um. Cada pessoa vê os clientes que vê no Drive; a linha abre o
 * termômetro do cliente num painel lateral (sem sair da carteira), com o
 * atalho para a aba no Drive.
 */
export function TemperaturePage({
  company,
  data,
}: {
  company: string;
  data: Snapshot;
}) {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [team, setTeam] = useState(ALL);
  const [product, setProduct] = useState(ALL);
  const [bandsOn, setBandsOn] = useState<number[]>([]);
  const [alertsOnly, setAlertsOnly] = useState(false);
  const [withoutScore, setWithoutScore] = useState(false);
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null);
  // Uma correção no painel: a carteira recarrega ao fechar.
  const changed = useRef(false);

  function load() {
    setBusy(true);
    setError("");
    loadPortfolio(company, data.clients.filter((c) => !c.archived))
      .then(setPortfolio)
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  }
  useEffect(load, [company]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => {
    setOpen(null);
    if (changed.current) {
      changed.current = false;
      load();
    }
  };

  const bands = portfolio?.settings.bands ?? [];
  const rows = useMemo(() => {
    if (!portfolio) return [];
    const q = query.trim().toLowerCase();
    return portfolio.clients.filter(
      (c) =>
        (withoutScore || c.score !== null) &&
        (!q || c.name.toLowerCase().includes(q)) &&
        (team === ALL || c.teams.includes(team)) &&
        (product === ALL || c.products.includes(product)) &&
        (!bandsOn.length || (c.band !== null && bandsOn.includes(c.band))) &&
        (!alertsOnly || c.flags.some((f) => f.alert)),
    );
  }, [portfolio, query, team, product, bandsOn, alertsOnly, withoutScore]);

  if (!portfolio)
    return error ? (
      <p className="form-error" role="alert">
        {error}
      </p>
    ) : (
      <Loading variant="chart" />
    );
  const scored = portfolio.clients.filter((c) => c.score !== null);
  const counts = bands.map((_, i) => scored.filter((c) => c.band === i).length);
  const alerts = scored.filter((c) => c.flags.some((f) => f.alert)).length;
  const toggleBand = (i: number) =>
    setBandsOn((list) => (list.includes(i) ? list.filter((x) => x !== i) : [...list, i]));

  return (
    <div className="thermo-page">
      {!portfolio.jev && (
        <p className="panel thermo-warning" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          O termômetro ainda não está ligado: um administrador precisa cadastrar
          o Jev (TypeSafe) num provedor OpenRouter em Painel da MAVI › Provedores
          e modelos.
        </p>
      )}
      <section className="thermo-bands" aria-label="Clientes por faixa">
        {bands
          .map((b, i) => ({ b, i }))
          .reverse()
          .map(({ b, i }) => (
            <button
              key={b.name}
              type="button"
              className={`thermo-band-card${bandsOn.includes(i) ? " selected" : ""}`}
              style={{ "--band": b.color } as CSSProperties}
              aria-pressed={bandsOn.includes(i)}
              onClick={() => toggleBand(i)}
            >
              <strong>{counts[i]}</strong>
              <span>{b.name}</span>
              <small>a partir de {b.min}</small>
            </button>
          ))}
        <button
          type="button"
          className={`thermo-band-card alert${alertsOnly ? " selected" : ""}`}
          aria-pressed={alertsOnly}
          onClick={() => setAlertsOnly((v) => !v)}
        >
          <strong>{alerts}</strong>
          <span>
            <AlertTriangle size={13} aria-hidden="true" /> Com sinal de alerta
          </span>
          <small>nos últimos {portfolio.settings.flag_days} dias</small>
        </button>
      </section>

      <div className="thermo-filters">
        <span className="thermo-search">
          <Input
            type="search"
            aria-label="Buscar cliente"
            placeholder="Buscar cliente"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </span>
        <span className="thermo-filter">
          <Select aria-label="Equipe" value={team} onValueChange={setTeam}>
            <SelectOption value={ALL}>Todas as equipes</SelectOption>
            {data.teams.map((t) => (
              <SelectOption key={t.id} value={t.id}>
                {t.name}
              </SelectOption>
            ))}
          </Select>
        </span>
        <span className="thermo-filter">
          <Select aria-label="Produto" value={product} onValueChange={setProduct}>
            <SelectOption value={ALL}>Todos os produtos</SelectOption>
            {data.products.map((p) => (
              <SelectOption key={p.id} value={p.id}>
                {p.name}
              </SelectOption>
            ))}
          </Select>
        </span>
        <label className="thermo-check">
          <Checkbox checked={withoutScore} onCheckedChange={(v) => setWithoutScore(v === true)} />
          Mostrar clientes sem temperatura
        </label>
        <div className="thermo-filters-actions">
          <Button className="icon-btn" onClick={load} loading={busy} aria-label="Atualizar" title="Atualizar">
            <RefreshCw size={15} />
          </Button>
          {portfolio.can_configure && (
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
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {!rows.length ? (
        <Empty
          title={scored.length ? "Nenhum cliente com esses filtros" : "Ainda sem temperaturas"}
          body={
            scored.length
              ? "Mude os filtros ou a faixa escolhida."
              : "A MAVI lê as reuniões gravadas e os grupos de WhatsApp de cada cliente; as temperaturas aparecem aos poucos."
          }
        />
      ) : (
        <div className="drive-table-wrap">
          <table className="drive-table thermo-table stack-mobile stack-3">
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Temperatura</th>
                <th>7 dias</th>
                <th>30 dias</th>
                <th>Sinais de alerta</th>
                <th>O que mais mexe</th>
                <th>Leituras</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const b = bandOf(bands, c.band);
                return (
                  <tr
                    key={c.client_id}
                    className={`thermo-row${open?.id === c.client_id ? " selected" : ""}`}
                    onClick={() => setOpen({ id: c.client_id, name: c.name })}
                  >
                    <td>
                      <a
                        href={appPath(clientTemperaturePath(c.client_id))}
                        onClick={(e) => {
                          // Ctrl/⌘ + clique abre a aba do Drive em outra guia.
                          if (e.metaKey || e.ctrlKey || e.shiftKey) {
                            e.stopPropagation();
                            return;
                          }
                          e.preventDefault();
                          e.stopPropagation();
                          setOpen({ id: c.client_id, name: c.name });
                        }}
                        className="thermo-client"
                      >
                        <span className="thermo-dot" style={{ background: c.color }} aria-hidden="true" />
                        {c.name}
                      </a>
                      {c.summary && <small className="thermo-row-summary">{c.summary}</small>}
                    </td>
                    <td data-label="Temperatura">
                      {c.score === null ? (
                        <span className="muted">{c.pending ? "lendo…" : "sem dados"}</span>
                      ) : (
                        <span
                          className="thermo-pill"
                          style={{ "--band": b?.color ?? "#a3acab" } as CSSProperties}
                        >
                          <Thermometer size={13} aria-hidden="true" />
                          <strong>{scoreLabel(c.score)}</strong>
                          {b?.name}
                        </span>
                      )}
                    </td>
                    <td data-label="7 dias">
                      <span className={`thermo-trend ${trendTone(c.d7)}`}>{trendLabel(c.d7) || "—"}</span>
                    </td>
                    <td data-label="30 dias">
                      <span className={`thermo-trend ${trendTone(c.d30)}`}>{trendLabel(c.d30) || "—"}</span>
                    </td>
                    <td data-label="Sinais de alerta" className="stack-full">
                      {c.flags.length ? (
                        <span className="thermo-row-flags">
                          {c.flags.map((f) => (
                            <span key={f.key} className={`thermo-chip flag${f.alert ? " alert" : ""}`}>
                              <AlertTriangle size={11} aria-hidden="true" /> {f.name}
                              {f.at && <small> {dateBr(f.at)}</small>}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td data-label="O que mais mexe" className="stack-span-2">{c.reasons[0] ? c.reasons[0].label.split(" (")[0] : <span className="muted">—</span>}</td>
                    <td className="num" data-label="Leituras">{c.signals}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <Modal
          title={`Termômetro · ${open.name}`}
          onClose={close}
          wide
          className="thermo-sheet"
          actions={
            <a
              className="btn secondary compact"
              href={appPath(clientTemperaturePath(open.id))}
              onClick={(e) => {
                e.preventDefault();
                openInApp(clientTemperaturePath(open.id));
              }}
            >
              <ExternalLink size={14} aria-hidden="true" /> Abrir no Drive
            </a>
          }
        >
          <div className="thermo-sheet-body">
            <Suspense fallback={<Loading variant="chart" />}>
              <ClientTemperature
                key={open.id}
                company={company}
                client={open.id}
                clientName={open.name}
                onChanged={() => {
                  changed.current = true;
                }}
              />
            </Suspense>
          </div>
        </Modal>
      )}
    </div>
  );
}

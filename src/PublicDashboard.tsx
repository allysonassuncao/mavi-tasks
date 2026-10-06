import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Lock, RefreshCw } from "lucide-react";
import { Button, Input, Loading } from "./ui";
import { DashboardCanvas, type PanelLoader } from "./DashboardCanvas";
import { ComparePicker, PeriodPicker } from "./DashboardPeriod";
import type { RecordsLoader } from "./DashboardRecords";
import {
  datesLabel,
  isCsSpec,
  panelData,
  panelRecords,
  resolveCompare,
  resolveRange,
  sharedDashboard,
  type DashboardCompare,
  type DashboardRange,
  type SharedDashboard,
} from "./dashboards";
import { csPanelData, csPanelRecords, type CsSource } from "./cs-dashboard";

// O painel pronto de Customer Success (tipo 'cs', migração 20270522090000).
const CsDashboard = lazy(() =>
  import("./CsDashboard").then((m) => ({ default: m.CsDashboard })),
);

/**
 * A dashboard opened by its share link (/painel/<token>), without the app
 * and without signing in: asks the password when the link has one, then
 * shows the panels with the saved filters. The period can change (ready
 * periods or dates of one's own), and the comparison when the dashboard
 * lets viewers change it.
 */
export function PublicDashboard({ token }: { token: string }) {
  const [state, setState] = useState<SharedDashboard | null>(null);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [accepted, setAccepted] = useState<string | undefined>();
  const [checking, setChecking] = useState(false);
  const [range, setRange] = useState<DashboardRange | undefined>();
  const [compareSetting, setCompare] = useState<DashboardCompare | null>();
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    sharedDashboard(token)
      .then((s) => {
        setState(s);
        if (s.status === "ok") {
          setRange(s.variables.range);
          setCompare(s.variables.compare);
          document.title = `${s.name} · Dashboards`;
        }
      })
      // Invalid, disabled or deleted link: the same answer, without details.
      .catch(() => setError("Link inválido ou dashboard indisponível."));
  }, [token]);

  const dates = useMemo(
    () => (state?.status === "ok" ? resolveRange(range, state.timezone) : null),
    [state, range],
  );
  const compare = useMemo(
    () => (dates ? resolveCompare(compareSetting, dates) : null),
    [dates, compareSetting],
  );
  // Painéis com fontes de Customer Success: calculados na tela com a base
  // de CS do dashboard (migração 20270523090000).
  const csSource = useMemo<CsSource>(
    () => ({ kind: "link", token, password: accepted }),
    [token, accepted],
  );
  const savedFilters =
    state?.status === "ok" ? (state.variables.filters ?? {}) : {};
  const loader: PanelLoader = useCallback(
    (panel, fresh) =>
      isCsSpec(panel.spec)
        ? csPanelData(
            csSource,
            panel.spec,
            dates!,
            savedFilters,
            compare,
            fresh,
          )
        : panelData(
            { kind: "link", token, password: accepted },
            panel.id,
            dates!,
            null,
            fresh,
            compare,
          ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token, accepted, dates, compare, csSource, state],
  );
  // The records below each panel, when the dashboard shows them on the link.
  const recordsLoader: RecordsLoader = useCallback(
    (panel, ref, selection, fresh) =>
      isCsSpec(panel.spec)
        ? csPanelRecords(
            csSource,
            panel.spec,
            ref,
            dates!,
            savedFilters,
            selection,
            fresh,
          )
        : panelRecords(
            { kind: "link", token, password: accepted },
            panel.id,
            ref,
            dates!,
            null,
            selection,
            fresh,
          ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token, accepted, dates, csSource, state],
  );

  if (error)
    return (
      <main className="public-dashboard centered-page">
        <div className="panel public-dashboard-message">
          <h1>Dashboard indisponível</h1>
          <p>{error}</p>
        </div>
      </main>
    );
  if (!state) return <Loading variant="chart" />;
  if (state.status === "locked")
    return (
      <main className="public-dashboard centered-page">
        <div className="panel public-dashboard-message">
          <Lock size={22} aria-hidden="true" />
          <h1>Muitas tentativas</h1>
          <p>
            Por segurança, este link ficou bloqueado por alguns minutos. Tente
            novamente mais tarde.
          </p>
        </div>
      </main>
    );
  if (state.status === "password")
    return (
      <main className="public-dashboard centered-page">
        <form
          className="panel public-dashboard-message"
          onSubmit={async (e) => {
            e.preventDefault();
            setChecking(true);
            try {
              const s = await sharedDashboard(token, password);
              setState(s);
              if (s.status === "ok") {
                setAccepted(password);
                setRange(s.variables.range);
                setCompare(s.variables.compare);
                document.title = `${s.name} · Dashboards`;
              }
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setChecking(false);
            }
          }}
        >
          <Lock size={22} aria-hidden="true" />
          <h1>Dashboard protegido</h1>
          <p>Digite a senha que recebeu junto com o link.</p>
          <label>
            Senha
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
            />
          </label>
          {state.wrong && (
            <p className="form-error" role="alert">
              Senha incorreta.
            </p>
          )}
          <Button className="btn primary" type="submit" loading={checking}>
            Abrir dashboard
          </Button>
        </form>
      </main>
    );

  if (state.kind === "cs")
    return (
      <main className="public-dashboard">
        <Suspense fallback={<Loading variant="chart" />}>
          <CsDashboard
            source={{ kind: "link", token, password: accepted }}
            head={
              <header className="public-dashboard-head">
                <div>
                  <small>{state.company}</small>
                  <h1>{state.name}</h1>
                  {state.description && <p>{state.description}</p>}
                </div>
              </header>
            }
          />
        </Suspense>
      </main>
    );

  return (
    <main className="public-dashboard">
      <header className="public-dashboard-head">
        <div>
          <small>{state.company}</small>
          <h1>{state.name}</h1>
          {state.description && <p>{state.description}</p>}
        </div>
        <div className="dash-vars">
          <PeriodPicker range={range} tz={state.timezone} onChange={setRange} />
          {dates && (
            <ComparePicker
              compare={compareSetting}
              range={dates}
              onChange={setCompare}
              open={!!state.variables.compareOpen}
            />
          )}
          <Button
            className="icon-btn"
            aria-label="Atualizar"
            title="Atualizar"
            onClick={() => setRefresh((v) => v + 1)}
          >
            <RefreshCw size={15} />
          </Button>
        </div>
      </header>
      {dates && (
        <DashboardCanvas
          panels={state.panels}
          loader={loader}
          recordsLoader={state.records ? recordsLoader : undefined}
          tz={state.timezone}
          loadKey={`${dates.from}|${dates.to}|${compare?.from}|${compare?.to}`}
          refresh={refresh}
        />
      )}
      <footer className="public-dashboard-foot">
        Dados de {dates?.from.split("-").reverse().join("/")} a{" "}
        {dates?.to.split("-").reverse().join("/")}
        {compare && ` comparados com ${datesLabel(compare)}`} · atualizados a
        cada minuto
      </footer>
    </main>
  );
}

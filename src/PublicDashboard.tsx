import { useCallback, useEffect, useMemo, useState } from "react";
import { Lock, RefreshCw } from "lucide-react";
import { Button, Input, Loading, Select, SelectOption } from "./ui";
import { DashboardCanvas, type PanelLoader } from "./DashboardCanvas";
import {
  panelData,
  rangeOptions,
  resolveRange,
  sharedDashboard,
  type DashboardRange,
  type SharedDashboard,
} from "./dashboards";

/**
 * A dashboard opened by its share link (/painel/<token>), without the app
 * and without signing in: asks the password when the link has one, then
 * shows the panels with the saved filters; only the period can change.
 */
export function PublicDashboard({ token }: { token: string }) {
  const [state, setState] = useState<SharedDashboard | null>(null);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [accepted, setAccepted] = useState<string | undefined>();
  const [checking, setChecking] = useState(false);
  const [range, setRange] = useState<DashboardRange | undefined>();
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    sharedDashboard(token)
      .then((s) => {
        setState(s);
        if (s.status === "ok") {
          setRange(s.variables.range);
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
  const loader: PanelLoader = useCallback(
    (panel, fresh) =>
      panelData(
        { kind: "link", token, password: accepted },
        panel.id,
        dates!,
        null,
        fresh,
      ),
    [token, accepted, dates],
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
  if (!state) return <Loading />;
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

  const preset = range && "from" in range ? "custom" : (range?.preset ?? "30d");
  return (
    <main className="public-dashboard">
      <header className="public-dashboard-head">
        <div>
          <small>{state.company}</small>
          <h1>{state.name}</h1>
          {state.description && <p>{state.description}</p>}
        </div>
        <div className="dash-vars">
          <Select
            aria-label="Período"
            value={preset}
            onValueChange={(v) =>
              v !== "custom" && setRange({ preset: v as never })
            }
          >
            {rangeOptions.map((r) => (
              <SelectOption key={r.key} value={r.key}>
                {r.label}
              </SelectOption>
            ))}
            {preset === "custom" && (
              <SelectOption value="custom">Período salvo</SelectOption>
            )}
          </Select>
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
          loadKey={`${dates.from}|${dates.to}`}
          refresh={refresh}
        />
      )}
      <footer className="public-dashboard-foot">
        Dados de {dates?.from.split("-").reverse().join("/")} a{" "}
        {dates?.to.split("-").reverse().join("/")} · atualizados a cada minuto
      </footer>
    </main>
  );
}

import { useEffect, useState, type FormEvent } from "react";
import { CalendarX, FileX, Lock } from "lucide-react";
import { Button, Input, Loading } from "./ui";
import { configFrom, publicReport, type PublicReport } from "./campaign-reports";
import { CampaignReportView } from "./CampaignReportView";

/**
 * A campaign report opened by its public link (/relatorio/<token>), without
 * the app and without signing in: the database sends only what the report
 * shows (no M, no author), asks for the password when there is one and says
 * when the link expired.
 */
export function PublicCampaignReport({ token }: { token: string }) {
  const [state, setState] = useState<PublicReport | null | undefined>(undefined);
  const [password, setPassword] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    publicReport(token, null)
      .then(setState)
      .catch(() => setState(null));
  }, [token]);
  useEffect(() => {
    if (state?.status === "ok") document.title = `${state.title} · ${state.company}`;
  }, [state]);

  async function unlock(e: FormEvent) {
    e.preventDefault();
    setChecking(true);
    setError("");
    try {
      setState(await publicReport(token, password));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  }

  if (state === undefined)
    return (
      <main className="public-meeting centered-page">
        <Loading variant="detail" />
      </main>
    );
  if (!state || state.status === "expired" || state.status === "locked")
    return (
      <main className="public-meeting centered-page">
        <div className="panel public-meeting-message">
          {state?.status === "expired" ? (
            <CalendarX size={26} aria-hidden="true" />
          ) : state?.status === "locked" ? (
            <Lock size={26} aria-hidden="true" />
          ) : (
            <FileX size={26} aria-hidden="true" />
          )}
          <h1>
            {state?.status === "expired"
              ? "Link vencido"
              : state?.status === "locked"
                ? "Muitas tentativas"
                : "Relatório indisponível"}
          </h1>
          <p>
            {state?.status === "expired"
              ? "A validade deste link terminou. Peça um novo link a quem o enviou."
              : state?.status === "locked"
                ? "Por segurança, este link ficou bloqueado por alguns minutos. Tente novamente mais tarde."
                : "Este link não existe mais ou foi desativado por quem o enviou."}
          </p>
        </div>
      </main>
    );
  if (state.status !== "ok")
    return (
      <main className="public-meeting centered-page">
        <form className="panel public-meeting-message" onSubmit={unlock}>
          <Lock size={24} aria-hidden="true" />
          <h1>Relatório protegido</h1>
          <p>Digite a senha que você recebeu junto com o link.</p>
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
          {state.status === "wrong" && (
            <p className="form-error" role="alert">
              Senha incorreta.
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <Button className="btn primary" type="submit" loading={checking}>
            Abrir relatório
          </Button>
        </form>
      </main>
    );
  return (
    <main className="creport-public">
      <CampaignReportView
        company={state.company}
        title={state.title}
        view={state.view}
        config={configFrom({ ...state.config, with_m: true })}
        analysis={state.analysis}
        periodStart={state.period_start}
        periodEnd={state.period_end}
        compareStart={state.compare_start}
        compareEnd={state.compare_end}
      />
    </main>
  );
}

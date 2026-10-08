import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { rpc } from "./api";
import { useUrlState } from "./router";
import { Button } from "./ui";
import "./campaign-job-failures.css";

/**
 * Campanhas › detalhe (migration 20270619120000_campaign_job_failures): as
 * rotinas desta campanha que estão falhando — o mesmo "Ainda falhando" de
 * Avisos de falhas, para todos que veem a campanha. Recarrega quando o banco
 * avisa (Realtime "campaign_jobs", sem polling).
 */

export type CampaignJobFailure = {
  job: string;
  label: string;
  since: string | null;
  streak: number;
  error: string | null;
  error_at: string | null;
};

/** Os nomes no contexto da campanha (o catálogo diz "… nas campanhas"). */
const LABELS: Record<string, string> = {
  ads_sync: "A sincronização diária",
  ads_today: "A leitura dos resultados de hoje",
  campaign_insights: "A análise dos Insights da MAVI",
  campaign_daily: "A Leitura do dia da MAVI",
};

/** Uma dica para os erros que têm saída conhecida. */
function hint(error: string | null) {
  if (!error) return "";
  if (/Nenhuma campanha vinculada/i.test(error))
    return "Confira no ciclo atual se as campanhas vinculadas ainda existem na conta de anúncio conectada.";
  return "";
}

/** "07/10 às 08:35", no fuso da empresa. */
function sinceText(at: string, timezone?: string) {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone || undefined,
  }).formatToParts(new Date(at));
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${p("day")}/${p("month")} às ${p("hour")}:${p("minute")}`;
}

export function CampaignJobFailures({
  company,
  campaign,
  demo,
  timezone,
  insightsTab,
}: {
  company: string;
  campaign: string;
  demo: boolean;
  timezone?: string;
  /** A aba Insights está ligada ("Ver o histórico"). */
  insightsTab: boolean;
}) {
  const [list, setList] = useState<CampaignJobFailure[]>([]);
  const [tick, setTick] = useState(0);
  const [, setTab] = useUrlState<string>("aba", "dia");
  useEffect(() => {
    if (demo) return;
    let live = true;
    (
      rpc("campaign_job_failures", {
        p_company: company,
        p_campaign: campaign,
      }) as Promise<CampaignJobFailure[]>
    )
      .then((r) => live && setList(r ?? []))
      .catch(() => live && setList([]));
    return () => {
      live = false;
    };
  }, [company, campaign, demo, tick]);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ campaign?: string }>).detail;
      if (!d?.campaign || d.campaign === campaign) setTick((t) => t + 1);
    };
    window.addEventListener("mavi:campaign-jobs", on);
    return () => window.removeEventListener("mavi:campaign-jobs", on);
  }, [campaign]);
  if (!list.length) return null;
  return (
    <>
      {list.map((f) => {
        const tip = hint(f.error);
        return (
          <div
            key={f.job}
            className="campaign-alert danger campaign-job-failure"
            role="status"
          >
            <TriangleAlert size={18} aria-hidden="true" />
            <span>
              <strong>{LABELS[f.job] ?? f.label} está falhando</strong>
              {f.since ? ` desde ${sinceText(f.since, timezone)}` : ""} ·{" "}
              {f.streak} {f.streak === 1 ? "falha seguida" : "falhas seguidas"}.
              {f.error && (
                <small>
                  Último erro
                  {f.error_at ? ` (${sinceText(f.error_at, timezone)})` : ""}:{" "}
                  {f.error}
                </small>
              )}
              {tip && <small>{tip}</small>}
            </span>
            {f.job === "campaign_insights" && insightsTab && (
              <span className="campaign-alert-actions">
                <Button
                  className="btn secondary"
                  onClick={() => setTab("insights")}
                >
                  Ver o histórico
                </Button>
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}

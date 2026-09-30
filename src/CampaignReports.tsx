import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Copy,
  ExternalLink,
  FileBarChart,
  Globe,
  KeyRound,
  Lock,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Modal } from "./components";
import { Button, Checkbox, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import { DateInput } from "./DateInput";
import { useUrlState } from "./router";
import { shortDate, type AdCampaign, type AdCycle } from "./campaigns";
import {
  chartsFor,
  configFrom,
  defaultConfig,
  metricsFor,
  numbersForMavi,
  reportPeriods,
  reportUrl,
  type CampaignReport,
  type ReportConfig,
  type ReportsBackend,
} from "./campaign-reports";
import { AnalysisText, CampaignReportView } from "./CampaignReportView";

/**
 * Campanhas › Relatórios: the campaign's reports (kept for later), a new
 * one (period, what it shows, with or without M, link), each report as the
 * client sees it, its public link and the MAVI's analysis.
 */
export function CampaignReports({
  company,
  campaign,
  cycles,
  current,
  today,
  backend,
  memberName,
  clientName,
  notify,
}: {
  company: string;
  campaign: AdCampaign;
  cycles: AdCycle[];
  current: AdCycle | null;
  today: string;
  backend: ReportsBackend;
  memberName: (id: string) => string;
  clientName: string;
  notify: (message: string) => void;
}) {
  const [list, setList] = useState<CampaignReport[] | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [openId, setOpenId] = useUrlState<string>("relatorio", "");
  const [creating, setCreating] = useState(false);
  const [autoWrite, setAutoWrite] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    backend
      .list(company, campaign.id)
      .then((l) => {
        if (!live) return;
        setList(l);
        setError("");
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [backend, company, campaign.id, tick]);

  if (openId)
    return (
      <ReportDetail
        key={openId}
        id={openId}
        company={company}
        campaign={campaign}
        cycles={cycles}
        backend={backend}
        clientName={clientName}
        memberName={memberName}
        autoWrite={autoWrite === openId}
        onWritten={() => setAutoWrite(null)}
        onBack={() => {
          setOpenId("");
          setTick((t) => t + 1);
        }}
        onDeleted={() => {
          setOpenId("");
          setTick((t) => t + 1);
          notify("Relatório excluído.");
        }}
        notify={notify}
      />
    );

  return (
    <div className="creports">
      <div className="panel-heading creports-heading">
        <div>
          <h2>Relatórios</h2>
          <p>
            Cada relatório guarda os números de um período e pode ter um link
            público para o cliente. Os números não mudam depois de criado.
          </p>
        </div>
        <Button className="btn primary" onClick={() => setCreating(true)}>
          <Plus size={15} /> Novo relatório
        </Button>
      </div>
      {error ? (
        <p className="form-error campaign-tab-body" role="alert">
          Não foi possível carregar os relatórios: {error}
        </p>
      ) : !list ? (
        <Loading variant="table" />
      ) : !list.length ? (
        <div className="creports-empty">
          <FileBarChart size={28} aria-hidden="true" />
          <strong>Nenhum relatório ainda</strong>
          <p>
            Crie o primeiro: escolha o período, o que mostrar e envie o link ao
            cliente.
          </p>
          <Button className="btn secondary" onClick={() => setCreating(true)}>
            <Plus size={15} /> Novo relatório
          </Button>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="campaign-table creports-table">
            <thead>
              <tr>
                <th>Relatório</th>
                <th>Período</th>
                <th>Valores</th>
                <th>Link público</th>
                <th>Criado por</th>
                <th>Criado em</th>
                <th aria-label="Ações" />
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr
                  key={r.id}
                  className="campaign-row"
                  tabIndex={0}
                  onClick={() => setOpenId(r.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setOpenId(r.id);
                  }}
                >
                  <td>
                    <strong>{r.title}</strong>
                  </td>
                  <td>
                    {shortDate(r.period_start)} a {shortDate(r.period_end)}
                  </td>
                  <td>{r.config.with_m ? "Com M" : "Sem M"}</td>
                  <td>
                    <LinkChip report={r} />
                  </td>
                  <td>{memberName(r.created_by)}</td>
                  <td>{new Date(r.created_at).toLocaleDateString("pt-BR")}</td>
                  <td className="creports-actions" onClick={(e) => e.stopPropagation()}>
                    {r.link && !r.link.expired && (
                      <Button
                        className="icon-btn"
                        title="Copiar link público"
                        aria-label={`Copiar link de ${r.title}`}
                        onClick={() => void copyLink(r.link!.token, notify)}
                      >
                        <Copy size={15} />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <ReportForm
          mode="create"
          campaign={campaign}
          cycles={cycles}
          current={current}
          today={today}
          clientName={clientName}
          onClose={() => setCreating(false)}
          onSubmit={async (values) => {
            const created = await backend.create(company, {
              campaign: campaign.id,
              title: values.title,
              start: values.start,
              end: values.end,
              config: values.config,
              link: values.link,
              expires_at: values.expiresAt,
              password: values.password || null,
            });
            setCreating(false);
            if (created.link)
              await navigator.clipboard.writeText(reportUrl(created.link.token)).catch(() => {});
            notify(
              created.link
                ? "Relatório criado e link copiado."
                : "Relatório criado.",
            );
            if (values.config.sections.analysis) setAutoWrite(created.id);
            setOpenId(created.id);
          }}
        />
      )}
    </div>
  );
}

async function copyLink(token: string, notify: (m: string) => void) {
  const url = reportUrl(token);
  try {
    await navigator.clipboard.writeText(url);
    notify("Link público copiado.");
  } catch {
    notify(`Copie o link: ${url}`);
  }
}

function LinkChip({ report }: { report: CampaignReport }) {
  const l = report.link;
  if (!l) return <span className="campaign-chip muted">Sem link</span>;
  if (l.expired) return <span className="campaign-chip danger">Vencido</span>;
  return (
    <span className="campaign-chip current">
      {l.has_password && <Lock size={11} />} Ativo
      {l.expires_at &&
        ` até ${new Date(l.expires_at).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}`}
    </span>
  );
}

// ------------------------------------------------------------ one report
function ReportDetail({
  id,
  company,
  campaign,
  cycles,
  backend,
  clientName,
  memberName,
  autoWrite,
  onWritten,
  onBack,
  onDeleted,
  notify,
}: {
  id: string;
  company: string;
  campaign: AdCampaign;
  cycles: AdCycle[];
  backend: ReportsBackend;
  clientName: string;
  memberName: (id: string) => string;
  autoWrite: boolean;
  onWritten: () => void;
  onBack: () => void;
  onDeleted: () => void;
  notify: (message: string) => void;
}) {
  const [report, setReport] = useState<CampaignReport | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    backend
      .get(id)
      .then((r) => live && setReport(r))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [backend, id, tick]);

  if (error)
    return (
      <div className="campaign-tab-body">
        <Button className="text-btn" onClick={onBack}>
          <ArrowLeft size={16} /> Todos os relatórios
        </Button>
        <p className="form-error" role="alert">
          {error}
        </p>
      </div>
    );
  if (!report || !report.view) return <Loading variant="detail" />;
  const view = report.view;
  const config = report.config;
  const link = report.link ? reportUrl(report.link.token) : "";

  return (
    <div className="creport-detail">
      <div className="creport-bar-top">
        <Button className="text-btn" onClick={onBack}>
          <ArrowLeft size={16} /> Todos os relatórios
        </Button>
        <span className="creport-bar-actions">
          {report.link && !report.link.expired && (
            <>
              <Button className="btn secondary" onClick={() => void copyLink(report.link!.token, notify)}>
                <Copy size={15} /> Copiar link
              </Button>
              <a className="btn secondary" href={link} target="_blank" rel="noreferrer">
                <ExternalLink size={15} /> Abrir como o cliente
              </a>
            </>
          )}
          {report.can_manage && (
            <>
              <Button className="btn secondary" onClick={() => setSharing(true)}>
                <Globe size={15} /> {report.link ? "Link público" : "Criar link"}
              </Button>
              <Button className="btn secondary" onClick={() => setEditing(true)}>
                <Pencil size={15} /> Editar
              </Button>
              {confirmDelete ? (
                <Button
                  className="btn danger"
                  loading={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await backend.remove(report.id);
                      onDeleted();
                    } catch (e) {
                      notify((e as Error).message);
                      setBusy(false);
                    }
                  }}
                >
                  <Trash2 size={15} /> Confirmar exclusão
                </Button>
              ) : (
                <Button className="btn secondary" onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={15} /> Excluir
                </Button>
              )}
            </>
          )}
        </span>
      </div>
      <p className="creport-meta muted">
        Criado por {memberName(report.created_by)} em{" "}
        {new Date(report.created_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}
        {" · "}
        {config.with_m ? "Valores com M" : "Valores sem M"}
        {" · "}
        <LinkChip report={report} />
      </p>
      {view.meta_error && (
        <div className="campaign-alert warn" role="status">
          <TriangleAlert size={18} />
          <span>
            Os anúncios não entraram neste relatório: {view.meta_error}
          </span>
        </div>
      )}
      <div className="creport-frame">
        <CampaignReportView
          title={report.title}
          view={view}
          config={config}
          analysis={report.analysis}
          periodStart={report.period_start}
          periodEnd={report.period_end}
          analysisSlot={
            config.sections.analysis ? (
              <AnalysisEditor
                report={report}
                company={company}
                campaign={campaign}
                backend={backend}
                clientName={clientName}
                autoWrite={autoWrite}
                onWritten={onWritten}
                onSaved={(r) => setReport((old) => ({ ...r, view: r.view ?? old?.view ?? null }))}
                notify={notify}
              />
            ) : undefined
          }
        />
      </div>
      {editing && (
        <ReportForm
          mode="edit"
          campaign={campaign}
          cycles={cycles}
          current={null}
          today={report.period_end}
          clientName={clientName}
          report={report}
          onClose={() => setEditing(false)}
          onSubmit={async (values) => {
            const saved = await backend.update(report.id, values.title, values.config, report.analysis);
            setReport(saved);
            setEditing(false);
            notify("Relatório atualizado.");
          }}
        />
      )}
      {sharing && (
        <LinkDialog
          report={report}
          backend={backend}
          onClose={() => setSharing(false)}
          onSaved={(r) => {
            setReport((old) => (old ? { ...old, ...r, view: old.view } : old));
            setTick((t) => t + 1);
          }}
          notify={notify}
        />
      )}
    </div>
  );
}

function AnalysisEditor({
  report,
  company,
  campaign,
  backend,
  clientName,
  autoWrite,
  onWritten,
  onSaved,
  notify,
}: {
  report: CampaignReport;
  company: string;
  campaign: AdCampaign;
  backend: ReportsBackend;
  clientName: string;
  autoWrite: boolean;
  onWritten: () => void;
  onSaved: (r: CampaignReport) => void;
  notify: (message: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [focus, setFocus] = useState("");
  const [writing, setWriting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const write = useCallback(
    async (save: boolean) => {
      if (!report.view) return;
      setWriting(true);
      setError("");
      try {
        const text = await backend.writeAnalysis(company, {
          campaign: campaign.id,
          title: report.title,
          period: `${shortDate(report.period_start)} a ${shortDate(report.period_end)}`,
          client: clientName,
          focus,
          numbers: numbersForMavi(report.view, report.config, report.period_start, report.period_end),
        });
        if (save) {
          const saved = await backend.update(report.id, report.title, report.config, text);
          onSaved(saved);
          notify("A MAVI escreveu a análise. Revise antes de enviar o link.");
        } else setDraft(text);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setWriting(false);
      }
    },
    [backend, company, campaign.id, report, clientName, focus, onSaved, notify],
  );
  useEffect(() => {
    if (!autoWrite) return;
    onWritten();
    if (!report.analysis.trim()) void write(true);
    // Once, right after creating the report.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoWrite]);

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    setError("");
    try {
      const saved = await backend.update(report.id, report.title, report.config, draft);
      onSaved(saved);
      setDraft(null);
      notify("Análise salva.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!report.can_manage)
    return report.analysis.trim() ? (
      <AnalysisText text={report.analysis} />
    ) : (
      <p className="muted">Sem análise.</p>
    );
  return (
    <div className="creport-analysis-editor">
      {writing ? (
        <div className="creport-writing" role="status">
          <Sparkles size={16} aria-hidden="true" /> A MAVI está escrevendo a
          análise com os números do relatório…
          <Loading variant="text" />
        </div>
      ) : draft !== null ? (
        <>
          <Textarea
            aria-label="Análise"
            value={draft}
            rows={12}
            maxLength={20000}
            onChange={(e) => setDraft(e.target.value)}
          />
          <small className="share-hint">
            Use "- " no começo da linha para listas e **texto** para negrito.
          </small>
        </>
      ) : report.analysis.trim() ? (
        <AnalysisText text={report.analysis} />
      ) : (
        <p className="muted">
          Ainda sem análise. A MAVI escreve a partir dos números do relatório, e
          você revisa antes de salvar.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="creport-analysis-actions">
        {draft !== null ? (
          <>
            <Button className="btn secondary" onClick={() => setDraft(null)} disabled={saving}>
              Cancelar
            </Button>
            <Button className="btn primary" onClick={() => void save()} loading={saving}>
              Salvar análise
            </Button>
          </>
        ) : (
          <>
            <Input
              placeholder="O que destacar? (opcional)"
              aria-label="O que a MAVI deve destacar"
              value={focus}
              maxLength={500}
              onChange={(e) => setFocus(e.target.value)}
              icon={Sparkles}
            />
            <Button className="btn secondary" onClick={() => void write(false)} disabled={writing}>
              <Sparkles size={15} />{" "}
              {report.analysis.trim() ? "Reescrever com a MAVI" : "Escrever com a MAVI"}
            </Button>
            <Button className="btn secondary" onClick={() => setDraft(report.analysis)} disabled={writing}>
              <Pencil size={15} /> Editar texto
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ the form
type FormValues = {
  title: string;
  start: string;
  end: string;
  config: ReportConfig;
  link: boolean;
  expiresAt: string | null;
  password: string;
};
function ReportForm({
  mode,
  campaign,
  cycles,
  current,
  today,
  clientName,
  report,
  onClose,
  onSubmit,
}: {
  mode: "create" | "edit";
  campaign: AdCampaign;
  cycles: AdCycle[];
  current: AdCycle | null;
  today: string;
  clientName: string;
  report?: CampaignReport;
  onClose: () => void;
  onSubmit: (values: FormValues) => Promise<void>;
}) {
  const periods = useMemo(() => reportPeriods(cycles, current, today), [cycles, current, today]);
  const [period, setPeriod] = useState(periods[0]?.id ?? "custom");
  const [custom, setCustom] = useState({
    start: periods[0]?.start ?? today,
    end: periods[0]?.end ?? today,
  });
  const chosen =
    period === "custom" ? custom : (periods.find((p) => p.id === period) ?? custom);
  const objective =
    report?.view?.cycles.at(-1)?.objective ?? current?.objective ?? cycles.at(-1)?.objective ?? null;
  const [config, setConfig] = useState<ReportConfig>(() =>
    report ? configFrom(report.config) : defaultConfig(objective),
  );
  const defaultTitle = `Relatório ${clientName ? `${clientName} · ` : ""}${shortDate(chosen.start).slice(0, 5)} a ${shortDate(chosen.end).slice(0, 5)}`;
  const [title, setTitle] = useState(report?.title ?? "");
  const [link, setLink] = useState(true);
  const [validity, setValidity] = useState<"never" | "7d" | "30d" | "90d" | "custom">("never");
  const [until, setUntil] = useState("");
  const [password, setPassword] = useState("");
  const [usePassword, setUsePassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toggle = <T extends string>(list: T[], id: T, on: boolean) =>
    on ? [...list.filter((x) => x !== id), id] : list.filter((x) => x !== id);
  const expiresAt = () => {
    if (validity === "never") return null;
    if (validity === "custom") return until ? new Date(`${until}T23:59:00`).toISOString() : null;
    const days = { "7d": 7, "30d": 30, "90d": 90 }[validity];
    return new Date(Date.now() + days * 86_400_000).toISOString();
  };
  const submit = async () => {
    setError("");
    if (mode === "create" && (!chosen.start || !chosen.end || chosen.end < chosen.start)) {
      setError("Escolha o período do relatório.");
      return;
    }
    if (usePassword && password.length < 4) {
      setError("A senha precisa ter pelo menos 4 caracteres.");
      return;
    }
    if (!config.metrics.length && !config.charts.length && !config.sections.ads) {
      setError("Escolha pelo menos uma métrica, um gráfico ou os anúncios.");
      return;
    }
    setBusy(true);
    try {
      await onSubmit({
        title: (title.trim() || defaultTitle).slice(0, 160),
        start: chosen.start,
        end: chosen.end,
        config,
        link,
        expiresAt: link ? expiresAt() : null,
        password: link && usePassword ? password : "",
      });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const metricChoices = metricsFor(report?.view ?? null, objective);
  const chartChoices = chartsFor(objective);
  const meta = campaign.platform === "meta";
  return (
    <Modal
      title={mode === "create" ? "Novo relatório" : "Editar relatório"}
      onClose={onClose}
      busy={busy}
      wide
    >
      <form
        className="entity-form creport-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label>
          Nome do relatório
          <Input
            value={title}
            placeholder={defaultTitle}
            maxLength={160}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        {mode === "create" ? (
          <fieldset className="share-block">
            <strong className="share-title">Período</strong>
            <div className="creport-form-row">
              <Select aria-label="Período" value={period} onValueChange={setPeriod}>
                {periods.map((p) => (
                  <SelectOption key={p.id} value={p.id}>
                    {`${p.label} (${shortDate(p.start).slice(0, 5)} a ${shortDate(p.end).slice(0, 5)})`}
                  </SelectOption>
                ))}
                <SelectOption value="custom">Personalizado</SelectOption>
              </Select>
              {period === "custom" && (
                <>
                  <DateInput
                    type="date"
                    aria-label="De"
                    value={custom.start}
                    max={custom.end}
                    onChange={(e) => setCustom((c) => ({ ...c, start: e.target.value }))}
                  />
                  <DateInput
                    type="date"
                    aria-label="Até"
                    value={custom.end}
                    min={custom.start}
                    max={today}
                    onChange={(e) => setCustom((c) => ({ ...c, end: e.target.value }))}
                  />
                </>
              )}
            </div>
            <small className="share-hint">
              Os números do período ficam guardados no relatório e não mudam
              depois{meta ? ", nem os anúncios, lidos agora do Meta" : ""}.
            </small>
          </fieldset>
        ) : (
          <p className="share-hint">
            Período: {shortDate(report!.period_start)} a {shortDate(report!.period_end)}.
            Os números não mudam; crie outro relatório para outro período.
          </p>
        )}
        <fieldset className="share-block">
          <strong className="share-title">Valores</strong>
          <div className="creport-radio">
            {(
              [
                [true, "Com M", "O valor que o cliente contratou (o investimento vezes o M)."],
                [false, "Sem M", "O valor investido na plataforma."],
              ] as const
            ).map(([value, label, hint]) => (
              <label key={label} className="share-toggle">
                <input
                  type="radio"
                  name="with_m"
                  checked={config.with_m === value}
                  onChange={() => setConfig((c) => ({ ...c, with_m: value }))}
                />
                <span>
                  <strong>{label}</strong>
                  <small>{hint}</small>
                </span>
              </label>
            ))}
          </div>
          <small className="share-hint">O M nunca aparece no relatório.</small>
        </fieldset>
        <fieldset className="share-block">
          <strong className="share-title">Métricas</strong>
          <div className="creport-grid">
            {metricChoices.map((m) => (
              <label key={m.id} className="mplat-check" title={m.hint}>
                <Checkbox
                  checked={config.metrics.includes(m.id)}
                  onCheckedChange={(v) =>
                    setConfig((c) => ({ ...c, metrics: toggle(c.metrics, m.id, v === true) }))
                  }
                />
                {m.label}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="share-block">
          <strong className="share-title">Gráficos</strong>
          <div className="creport-grid">
            {chartChoices.map((ch) => (
              <label key={ch.id} className="mplat-check">
                <Checkbox
                  checked={config.charts.includes(ch.id)}
                  onCheckedChange={(v) =>
                    setConfig((c) => ({ ...c, charts: toggle(c.charts, ch.id, v === true) }))
                  }
                />
                {ch.label}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="share-block">
          <strong className="share-title">O que mais entra</strong>
          {meta && (
            <label className="share-toggle">
              <Checkbox
                checked={config.sections.ads}
                onCheckedChange={(v) =>
                  setConfig((c) => ({ ...c, sections: { ...c.sections, ads: v === true } }))
                }
              />
              <span>
                <strong>Anúncios com o criativo</strong>
                <small>
                  Os anúncios que mais trouxeram resultado, com a imagem e os
                  números.
                </small>
              </span>
            </label>
          )}
          {meta && config.sections.ads && (
            <div className="creport-form-row creport-indent">
              <Select
                aria-label="Quantos anúncios"
                value={String(config.ads_limit)}
                onValueChange={(v) => setConfig((c) => ({ ...c, ads_limit: Number(v) }))}
                disabled={mode === "edit"}
              >
                {[3, 5, 10, 20, 30].map((n) => (
                  <SelectOption key={n} value={String(n)}>
                    {`Até ${n} anúncios`}
                  </SelectOption>
                ))}
              </Select>
              {mode === "edit" && (
                <small className="share-hint">As imagens foram guardadas na criação.</small>
              )}
            </div>
          )}
          {meta && (
            <label className="share-toggle">
              <Checkbox
                checked={config.sections.adsets}
                onCheckedChange={(v) =>
                  setConfig((c) => ({ ...c, sections: { ...c.sections, adsets: v === true } }))
                }
              />
              <span>
                <strong>Conjuntos de anúncios</strong>
                <small>Uma tabela com os números de cada conjunto.</small>
              </span>
            </label>
          )}
          <label className="share-toggle">
            <Checkbox
              checked={config.sections.goal}
              onCheckedChange={(v) =>
                setConfig((c) => ({ ...c, sections: { ...c.sections, goal: v === true } }))
              }
            />
            <span>
              <strong>Meta e verba do ciclo</strong>
              <small>Quanto do esperado o período já entregou.</small>
            </span>
          </label>
          <label className="share-toggle">
            <Checkbox
              checked={config.sections.analysis}
              onCheckedChange={(v) =>
                setConfig((c) => ({ ...c, sections: { ...c.sections, analysis: v === true } }))
              }
            />
            <span>
              <strong>
                <Sparkles size={14} /> Análise da MAVI
              </strong>
              <small>
                A MAVI escreve um resumo para o cliente com os números do
                relatório; você revisa e edita antes de enviar.
              </small>
            </span>
          </label>
          <label className="share-toggle">
            <Checkbox
              checked={config.allow_filter}
              onCheckedChange={(v) => setConfig((c) => ({ ...c, allow_filter: v === true }))}
            />
            <span>
              <strong>O cliente escolhe o período</strong>
              <small>
                No link, o cliente pode ver só uma parte do período do
                relatório (por ciclo, últimos dias ou datas).
              </small>
            </span>
          </label>
        </fieldset>
        {mode === "create" && (
          <fieldset className="share-block">
            <label className="share-toggle">
              <Checkbox checked={link} onCheckedChange={(v) => setLink(v === true)} />
              <span>
                <strong>
                  <Globe size={14} /> Criar o link público agora
                </strong>
                <small>Quem tiver o link abre o relatório sem entrar no sistema.</small>
              </span>
            </label>
            {link && (
              <>
                <div className="creport-form-row creport-indent">
                  <Select
                    aria-label="Validade do link"
                    value={validity}
                    onValueChange={(v) => setValidity(v as typeof validity)}
                  >
                    <SelectOption value="never">Sem validade</SelectOption>
                    <SelectOption value="7d">7 dias</SelectOption>
                    <SelectOption value="30d">30 dias</SelectOption>
                    <SelectOption value="90d">90 dias</SelectOption>
                    <SelectOption value="custom">Até uma data</SelectOption>
                  </Select>
                  {validity === "custom" && (
                    <DateInput
                      type="date"
                      aria-label="Link vale até"
                      value={until}
                      onChange={(e) => setUntil(e.target.value)}
                    />
                  )}
                </div>
                <label className="share-toggle creport-indent">
                  <Checkbox
                    checked={usePassword}
                    onCheckedChange={(v) => {
                      setUsePassword(v === true);
                      setPassword("");
                    }}
                  />
                  <span>
                    <strong>
                      <KeyRound size={14} /> Pedir senha
                    </strong>
                    <small>Envie a senha separada do link.</small>
                  </span>
                </label>
                {usePassword && (
                  <div className="creport-indent">
                    <Input
                      type="password"
                      autoComplete="new-password"
                      aria-label="Senha do link"
                      placeholder="Pelo menos 4 caracteres"
                      value={password}
                      maxLength={72}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>
                )}
              </>
            )}
          </fieldset>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          <Button type="button" className="btn secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" className="btn primary" loading={busy}>
            {mode === "create"
              ? meta && config.sections.ads
                ? "Criar relatório (lê os anúncios no Meta)"
                : "Criar relatório"
              : "Salvar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------ link
function LinkDialog({
  report,
  backend,
  onClose,
  onSaved,
  notify,
}: {
  report: CampaignReport;
  backend: ReportsBackend;
  onClose: () => void;
  onSaved: (r: CampaignReport) => void;
  notify: (message: string) => void;
}) {
  const l = report.link;
  const [validity, setValidity] = useState<"keep" | "never" | "7d" | "30d" | "90d" | "custom">(
    l?.expires_at && !l.expired ? "keep" : "never",
  );
  const [until, setUntil] = useState("");
  const [usePassword, setUsePassword] = useState(!!l?.has_password);
  const [changePassword, setChangePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [error, setError] = useState("");
  const askPassword = usePassword && (!l?.has_password || changePassword);
  const expiresAt = () => {
    if (validity === "keep") return l?.expires_at ?? null;
    if (validity === "never") return null;
    if (validity === "custom") return until ? new Date(`${until}T23:59:00`).toISOString() : null;
    const days = { "7d": 7, "30d": 30, "90d": 90 }[validity];
    return new Date(Date.now() + days * 86_400_000).toISOString();
  };
  const save = async () => {
    setError("");
    if (askPassword && password.length < 4) {
      setError("A senha precisa ter pelo menos 4 caracteres.");
      return;
    }
    setBusy(true);
    try {
      const saved = await backend.setLink(
        report.id,
        true,
        expiresAt(),
        !usePassword ? "" : askPassword ? password : null,
        usePassword && !askPassword,
      );
      onSaved(saved);
      if (!l && saved.link)
        await navigator.clipboard.writeText(reportUrl(saved.link.token)).catch(() => {});
      notify(l ? "Link público atualizado." : "Link público criado e copiado.");
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const off = async () => {
    setBusy(true);
    try {
      const saved = await backend.setLink(report.id, false, null, null, false);
      onSaved(saved);
      notify("Link público desativado. O endereço antigo não abre mais.");
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Link público do relatório" onClose={onClose} busy={busy}>
      <div className="entity-form share-folder share-meeting">
        <p className="share-meeting-intro">
          <Globe size={15} aria-hidden="true" />
          <span>
            Quem tiver o link abre <strong>{report.title}</strong> sem entrar no
            sistema. O M e quem criou o relatório não aparecem.
          </span>
        </p>
        {l && (
          <section className="share-block">
            {l.expired && (
              <p className="share-warning" role="note">
                <Lock size={14} /> Este link venceu e não abre mais. Escolha uma
                nova validade para reativá-lo com o mesmo endereço.
              </p>
            )}
            <div className="share-link">
              <Input readOnly value={reportUrl(l.token)} aria-label="Link público" />
              <Button type="button" className="btn secondary" onClick={() => void copyLink(l.token, notify)}>
                <Copy size={15} /> Copiar
              </Button>
            </div>
          </section>
        )}
        <fieldset className="share-block">
          <strong className="share-title">Validade</strong>
          <div className="share-meeting-validity">
            <Select
              aria-label="Validade do link"
              value={validity}
              onValueChange={(v) => setValidity(v as typeof validity)}
            >
              {l?.expires_at && !l.expired && (
                <SelectOption value="keep">
                  {`Até ${new Date(l.expires_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}`}
                </SelectOption>
              )}
              <SelectOption value="never">Sem validade</SelectOption>
              <SelectOption value="7d">7 dias</SelectOption>
              <SelectOption value="30d">30 dias</SelectOption>
              <SelectOption value="90d">90 dias</SelectOption>
              <SelectOption value="custom">Até uma data</SelectOption>
            </Select>
            {validity === "custom" && (
              <DateInput
                type="date"
                aria-label="Link vale até"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
              />
            )}
          </div>
        </fieldset>
        <fieldset className="share-block">
          <label className="share-toggle">
            <Checkbox
              checked={usePassword}
              onCheckedChange={(v) => {
                setUsePassword(v === true);
                setPassword("");
              }}
            />
            <span>
              <strong>
                <KeyRound size={15} /> Pedir senha
              </strong>
              <small>
                Envie a senha separada do link. Dez tentativas erradas bloqueiam
                o link por 15 minutos.
              </small>
            </span>
          </label>
          {usePassword && l?.has_password && !changePassword ? (
            <small className="share-hint">
              Este link já tem senha.{" "}
              <button type="button" className="text-btn" onClick={() => setChangePassword(true)}>
                Trocar senha
              </button>
            </small>
          ) : askPassword ? (
            <Input
              type="password"
              autoComplete="new-password"
              aria-label="Senha do link"
              placeholder="Pelo menos 4 caracteres"
              value={password}
              maxLength={72}
              onChange={(e) => setPassword(e.target.value)}
            />
          ) : null}
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          {l &&
            (confirmOff ? (
              <Button type="button" className="btn danger" onClick={() => void off()} loading={busy}>
                <Trash2 size={15} /> Confirmar: desativar para sempre
              </Button>
            ) : (
              <Button
                type="button"
                className="btn secondary share-meeting-off"
                onClick={() => setConfirmOff(true)}
                disabled={busy}
              >
                <Trash2 size={15} /> Desativar link
              </Button>
            ))}
          <Button type="button" className="btn secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="button" className="btn primary" onClick={() => void save()} loading={busy && !confirmOff}>
            {l ? "Salvar alterações" : "Criar link público"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

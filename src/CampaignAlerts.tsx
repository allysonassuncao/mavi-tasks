import { useEffect, useMemo, useState } from "react";
import {
  BellRing,
  History,
  Info,
  Wand2,
  Loader2,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Button, Checkbox, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import { Modal } from "./components";
import type { Snapshot } from "./types";
import {
  ALERT_METRICS,
  ALERT_OBJECTIVES,
  ALERT_OBJECTIVE_LABELS,
  ALERT_PLATFORMS,
  ALERT_PLATFORM_LABELS,
  CONDITION_LABELS,
  METRIC_HELP,
  METRIC_INFO,
  blankRule,
  channelText,
  conditionText,
  conditionsFor,
  describeRule,
  isMoney,
  normalizeRule,
  repeatText,
  ruleProblem,
  scopeText,
  suggestedName,
  type AlertCondition,
  type AlertMetric,
  type CampaignAlertRule,
} from "./campaign-alerts";
import {
  deleteCampaignAlert,
  draftCampaignAlert,
  loadAlertHistory,
  loadCampaignAlerts,
  previewCampaignAlert,
  saveCampaignAlert,
  type AlertHit,
  type AlertPreview,
} from "./campaign-alerts-api";
import "./campaign-alerts.css";

/** Uma campanha para escolher (a busca é a da lista de Campanhas). */
export type AlertCampaignOption = { id: string; name: string; client: string };

const MAVI_EXAMPLES = [
  "Me avise se o consumo ficar igual por 3 dias",
  "3 dias sem conversão",
  "Custo por resultado do ciclo passou de R$ 30",
  "O consumo caiu 40% na comparação com os 3 dias anteriores",
];

/**
 * Campanhas › Meus avisos: as regras de aviso de cada pessoa, para uma
 * campanha ou para todas (com filtros). A MAVI monta a regra a partir de uma
 * descrição; "Conferir agora" mostra o que dispararia hoje; "Disparos" é o
 * histórico. Os avisos chegam pela caixa de entrada e pelo push (as
 * preferências de notificação valem) ou no resumo das 11h.
 */
export function CampaignAlerts({
  company,
  data,
  campaign,
  view,
  onView,
  onClose,
  onOpenCampaign,
  searchCampaigns,
  notify,
}: {
  company: string;
  data: Snapshot;
  /** Aberto de uma campanha: os avisos que valem para ela primeiro. */
  campaign: AlertCampaignOption | null;
  /** lista, historico ou novo (fica na URL: ?avisos=). */
  view: string;
  onView: (view: string) => void;
  onClose: () => void;
  onOpenCampaign: (id: string) => void;
  searchCampaigns: (term: string) => Promise<AlertCampaignOption[]>;
  notify: (message: string) => void;
}) {
  const [rules, setRules] = useState<CampaignAlertRule[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<CampaignAlertRule | null>(
    view === "novo" ? blankRule(campaign?.id ?? null) : null,
  );
  const [onlyThis, setOnlyThis] = useState(!!campaign);
  // A campanha chega depois (aberto pelo link): os dela primeiro.
  useEffect(() => setOnlyThis(!!campaign), [campaign?.id]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const tab = view === "historico" ? "historico" : "lista";

  useEffect(() => {
    let live = true;
    loadCampaignAlerts(company, campaign?.id ?? null)
      .then((list) => live && setRules(list))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [company, campaign?.id, tick]);

  const shown = useMemo(
    () => (rules ?? []).filter((r) => !campaign || !onlyThis || r.applies),
    [rules, campaign, onlyThis],
  );

  async function toggle(rule: CampaignAlertRule) {
    try {
      await saveCampaignAlert(company, { ...rule, active: !rule.active });
      setTick((t) => t + 1);
      notify(rule.active ? "Aviso desligado." : "Aviso ligado.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function remove(rule: CampaignAlertRule) {
    try {
      await deleteCampaignAlert(company, rule.id!);
      setConfirmDelete(null);
      setTick((t) => t + 1);
      notify("Aviso excluído.");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (editing)
    return (
      <AlertForm
        company={company}
        data={data}
        campaign={campaign}
        initial={editing}
        searchCampaigns={searchCampaigns}
        onClose={() => {
          setEditing(null);
          if (view === "novo") onView("lista");
        }}
        onSaved={(saved, created) => {
          setEditing(null);
          if (view === "novo") onView("lista");
          setTick((t) => t + 1);
          notify(created ? `Aviso “${saved.name}” criado.` : "Aviso salvo.");
        }}
      />
    );

  return (
    <Modal title="Meus avisos" onClose={onClose} className="calert-modal">
      <div className="calert">
        <div className="calert-tabs" role="tablist" aria-label="Meus avisos">
          <button type="button" role="tab" aria-selected={tab === "lista"} onClick={() => onView("lista")}>
            <BellRing size={15} aria-hidden="true" /> Avisos
          </button>
          <button type="button" role="tab" aria-selected={tab === "historico"} onClick={() => onView("historico")}>
            <History size={15} aria-hidden="true" /> Disparos
          </button>
        </div>
        {tab === "historico" ? (
          <AlertHistory company={company} onOpenCampaign={onOpenCampaign} />
        ) : (
          <>
            <p className="calert-note">
              Monte avisos sobre os números do Dia a Dia: de uma campanha ou de todas. Eles são só seus e chegam na
              caixa de entrada e como notificação (ou num resumo às 11h). Os números chegam uma vez por dia, de
              manhã: cada aviso é conferido logo depois da sincronização, com os dias até ontem.
            </p>
            <div className="calert-toolbar">
              {campaign && (
                <span className="calert-filter" role="group" aria-label="Quais avisos">
                  <button type="button" aria-pressed={onlyThis} onClick={() => setOnlyThis(true)}>
                    Valem para {campaign.name}
                  </button>
                  <button type="button" aria-pressed={!onlyThis} onClick={() => setOnlyThis(false)}>
                    Todos
                  </button>
                </span>
              )}
              <span className="calert-toolbar-actions">
                {campaign && (
                  <Button
                    className="btn secondary"
                    onClick={() => setEditing(blankRule(campaign.id))}
                    disabled={(rules?.length ?? 0) >= 50}
                  >
                    <Plus size={15} aria-hidden="true" /> Aviso para esta campanha
                  </Button>
                )}
                <Button
                  className="btn primary"
                  onClick={() => setEditing(blankRule(null))}
                  disabled={(rules?.length ?? 0) >= 50}
                >
                  <Plus size={15} aria-hidden="true" /> Novo aviso
                </Button>
              </span>
            </div>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            {!rules ? (
              <Loading variant="list" />
            ) : !shown.length ? (
              <div className="calert-empty">
                <BellRing size={22} aria-hidden="true" />
                <strong>{rules.length ? "Nenhum aviso vale para esta campanha." : "Você ainda não tem avisos."}</strong>
                <span>
                  Clique em “Novo aviso” e descreva o que quer saber — a MAVI monta a regra para você revisar. Ex.:
                  “me avise se o consumo ficar igual por 3 dias”.
                </span>
              </div>
            ) : (
              <ul className="calert-list">
                {shown.map((r) => (
                  <li key={r.id} className={r.active ? "" : "off"}>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={r.active}
                      aria-label={`${r.active ? "Desligar" : "Ligar"} ${r.name}`}
                      title={r.active ? "Ligado: clique para desligar" : "Desligado: clique para ligar"}
                      className={`template-switch${r.active ? " on" : ""}`}
                      onClick={() => void toggle(r)}
                    >
                      <span aria-hidden="true" />
                    </button>
                    <div className="calert-item">
                      <strong>
                        {r.name}
                        {r.origin === "mavi" && (
                          <span className="calert-mavi" title="Montado pela MAVI">
                            <Sparkles size={11} aria-hidden="true" /> MAVI
                          </span>
                        )}
                      </strong>
                      <span>{conditionText(r)}</span>
                      <small>
                        {scopeText(r)} · {repeatText(r)} · {channelText(r.channel)}
                        {!r.active && " · desligado"}
                      </small>
                      <small className="calert-last">
                        {r.last_hit
                          ? `Último disparo em ${shortDay(r.last_hit.day)}${r.last_hit.campaign && !r.campaign_id ? ` (${r.last_hit.campaign})` : ""}: ${r.last_hit.detail}`
                          : "Ainda não disparou."}
                        {(r.hits_30d ?? 0) > 1 && ` · ${r.hits_30d} disparos em 30 dias`}
                      </small>
                    </div>
                    <span className="calert-item-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`Editar ${r.name}`}
                        title="Editar"
                        onClick={() => setEditing(r)}
                      >
                        <Pencil size={14} />
                      </button>
                      {confirmDelete === r.id ? (
                        <>
                          <Button className="btn danger" onClick={() => void remove(r)}>
                            Excluir
                          </Button>
                          <button
                            type="button"
                            className="icon-btn"
                            aria-label="Não excluir"
                            onClick={() => setConfirmDelete(null)}
                          >
                            <X size={14} />
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={`Excluir ${r.name}`}
                          title="Excluir"
                          onClick={() => setConfirmDelete(r.id!)}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

const shortDay = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

// ------------------------------------------------------------ disparos
function AlertHistory({ company, onOpenCampaign }: { company: string; onOpenCampaign: (id: string) => void }) {
  const [hits, setHits] = useState<AlertHit[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    loadAlertHistory(company)
      .then((list) => live && setHits(list))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [company]);
  if (error)
    return (
      <p className="form-error" role="alert">
        {error}
      </p>
    );
  if (!hits) return <Loading variant="list" />;
  if (!hits.length)
    return (
      <div className="calert-empty">
        <History size={22} aria-hidden="true" />
        <strong>Nenhum disparo ainda.</strong>
        <span>Quando um aviso seu disparar, ele aparece aqui, com o valor que o fez disparar.</span>
      </div>
    );
  return (
    <ul className="calert-hits">
      {hits.map((h) => (
        <li key={h.id}>
          <span className="calert-hit-day">{shortDay(h.day)}</span>
          <div>
            <strong>{h.rule}</strong>
            <span>{h.detail}</span>
            <small>
              <button type="button" className="text-btn" onClick={() => onOpenCampaign(h.campaign_id)}>
                {h.campaign}
              </button>{" "}
              · {h.client} · {h.channel === "now" ? "avisado na hora" : "no resumo do dia"}
            </small>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------ formulário
function AlertForm({
  company,
  data,
  campaign,
  initial,
  searchCampaigns,
  onClose,
  onSaved,
}: {
  company: string;
  data: Snapshot;
  campaign: AlertCampaignOption | null;
  initial: CampaignAlertRule;
  searchCampaigns: (term: string) => Promise<AlertCampaignOption[]>;
  onClose: () => void;
  onSaved: (rule: CampaignAlertRule, created: boolean) => void;
}) {
  const [rule, setRule] = useState<CampaignAlertRule>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<AlertPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [ask, setAsk] = useState("");
  const [asking, setAsking] = useState(false);
  const [maviNote, setMaviNote] = useState<{ text: string; problem?: string } | null>(null);
  const [picked, setPicked] = useState<AlertCampaignOption | null>(
    initial.campaign_id
      ? campaign?.id === initial.campaign_id
        ? campaign
        : { id: initial.campaign_id, name: initial.labels?.campaign ?? "Campanha", client: initial.labels?.campaign_client ?? "" }
      : null,
  );
  const [scope, setScope] = useState<"one" | "many">(initial.campaign_id ? "one" : "many");

  const set = (patch: Partial<CampaignAlertRule>) => {
    setPreview(null);
    setRule((r) => normalizeRule({ ...r, ...patch }));
  };
  const effective = normalizeRule({
    ...rule,
    campaign_id: scope === "one" ? (picked?.id ?? null) : null,
    name: rule.name.trim() || suggestedName(rule),
    labels: {
      campaign: scope === "one" ? (picked?.name ?? null) : null,
      campaign_client: scope === "one" ? (picked?.client ?? null) : null,
      clients: data.clients.filter((c) => rule.client_ids.includes(c.id)).map((c) => c.name),
      products: data.products.filter((p) => rule.product_ids.includes(p.id)).map((p) => p.name),
      teams: data.teams.filter((t) => rule.team_ids.includes(t.id)).map((t) => t.name),
    },
  });
  const problem =
    scope === "one" && !picked ? "Escolha a campanha (ou troque para várias campanhas)." : ruleProblem(effective);
  const info = METRIC_INFO[rule.metric];
  const conditions = conditionsFor(rule.metric);
  const unit = info.unit === "money" ? "R$" : info.unit === "percent" ? "%" : "";

  function pickMetric(metric: AlertMetric) {
    const next = conditionsFor(metric);
    // A mídia restante preocupa quando acaba: "ficar em ou abaixo de".
    const condition =
      metric === "media_left" ? "below" : next.includes(rule.condition) ? rule.condition : next[0];
    set({
      metric,
      condition,
      ...(condition === "above" || condition === "below"
        ? { period: METRIC_INFO[metric].cycle ? "cycle" : rule.period === "days" && rule.condition !== condition ? "day" : rule.period }
        : {}),
    });
  }
  function pickCondition(condition: AlertCondition) {
    set({
      condition,
      ...(condition === "unchanged" || condition === "zero" || condition === "rise" || condition === "drop"
        ? { days: Math.max(rule.days, condition === "unchanged" ? 2 : 1), period: "days" }
        : { period: info.cycle ? "cycle" : "day", days: 1 }),
    });
  }

  async function askMavi() {
    if (ask.trim().length < 3) return;
    setAsking(true);
    setError("");
    try {
      const draft = await draftCampaignAlert(company, {
        text: ask.trim(),
        campaign: campaign?.id ?? (scope === "one" ? (picked?.id ?? null) : null),
        current: rule.id ? effective : null,
      });
      const next = draft.rule;
      setRule({ ...next, id: rule.id, active: rule.id ? rule.active : next.active });
      if (next.campaign_id) {
        setScope("one");
        setPicked({
          id: next.campaign_id,
          name: next.labels?.campaign ?? (campaign?.id === next.campaign_id ? campaign.name : "Campanha"),
          client: next.labels?.campaign_client ?? "",
        });
      } else setScope("many");
      setPreview(null);
      setMaviNote({ text: draft.note, problem: ruleProblem(next) ?? undefined });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAsking(false);
    }
  }

  async function check() {
    if (problem) return;
    setChecking(true);
    setError("");
    try {
      setPreview(await previewCampaignAlert(company, effective));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  async function save() {
    if (problem) return;
    setBusy(true);
    setError("");
    try {
      const saved = await saveCampaignAlert(company, effective);
      onSaved(saved, !rule.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={rule.id ? "Editar aviso" : "Novo aviso"} onClose={onClose} busy={busy} className="calert-modal">
      <div className="calert calert-form entity-form">
        <section className="calert-mavi-box" aria-label="Descrever o aviso para a MAVI">
          <label htmlFor="calert-ask">
            <Sparkles size={14} aria-hidden="true" /> Descreva o aviso e a MAVI monta para você
          </label>
          <div className="calert-mavi-row">
            <Textarea
              id="calert-ask"
              rows={2}
              value={ask}
              maxLength={1500}
              placeholder={rule.id ? "Ex.: troque para 5 dias e me avise todo dia" : "Ex.: me avise se a campanha ficar 3 dias sem conversão"}
              onChange={(e) => setAsk(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void askMavi();
              }}
            />
            <Button className="btn primary" onClick={() => void askMavi()} disabled={asking || ask.trim().length < 3}>
              {asking ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}
              {rule.id ? "Ajustar" : "Montar"}
            </Button>
          </div>
          {!ask && !rule.id && (
            <div className="calert-examples">
              {MAVI_EXAMPLES.map((x) => (
                <button key={x} type="button" className="chip" onClick={() => setAsk(x)}>
                  {x}
                </button>
              ))}
            </div>
          )}
          {maviNote && (
            <p className="calert-mavi-note" role="status">
              {maviNote.text}
              {maviNote.problem && <strong> Falta: {maviNote.problem}</strong>} Revise abaixo antes de salvar.
            </p>
          )}
        </section>

        <label>
          <span>Nome</span>
          <Input
            value={rule.name}
            maxLength={120}
            placeholder={`Sem nome: “${suggestedName(rule)}”`}
            onChange={(e) => setRule((r) => ({ ...r, name: e.target.value }))}
          />
        </label>

        <fieldset className="calert-fieldset">
          <legend>Onde</legend>
          <div className="calert-scope" role="radiogroup" aria-label="Onde">
            <button type="button" role="radio" aria-checked={scope === "one"} onClick={() => { setScope("one"); setPreview(null); }}>
              Uma campanha
            </button>
            <button type="button" role="radio" aria-checked={scope === "many"} onClick={() => { setScope("many"); setPreview(null); }}>
              Várias campanhas
            </button>
          </div>
          {scope === "one" ? (
            <CampaignPicker
              value={picked}
              suggestion={campaign}
              search={searchCampaigns}
              onChange={(c) => {
                setPicked(c);
                setPreview(null);
              }}
            />
          ) : (
            <div className="calert-filters">
              <p className="calert-hint">Vale para todas as campanhas ativas que passam pelos filtros (vazio: todas).</p>
              <PickMany
                label="Clientes"
                all="Todos os clientes"
                options={data.clients.filter((c) => !c.archived).map((c) => ({ value: c.id, label: c.name }))}
                value={rule.client_ids}
                onChange={(client_ids) => set({ client_ids })}
              />
              <PickMany
                label="Produtos"
                all="Todos os produtos"
                options={data.products.map((p) => ({ value: p.id, label: p.name }))}
                value={rule.product_ids}
                onChange={(product_ids) => set({ product_ids })}
              />
              <PickMany
                label="Equipes"
                all="Todas as equipes"
                options={data.teams.map((t) => ({ value: t.id, label: t.name }))}
                value={rule.team_ids}
                onChange={(team_ids) => set({ team_ids })}
              />
              <div className="calert-checks" role="group" aria-label="Plataformas">
                <span>Plataformas</span>
                {ALERT_PLATFORMS.map((p) => (
                  <label key={p} className="thermo-check">
                    <Checkbox
                      checked={rule.platforms.includes(p)}
                      onCheckedChange={(v) =>
                        set({ platforms: v === true ? [...rule.platforms, p] : rule.platforms.filter((x) => x !== p) })
                      }
                    />
                    {ALERT_PLATFORM_LABELS[p]}
                  </label>
                ))}
              </div>
              <div className="calert-checks" role="group" aria-label="Objetivos do ciclo">
                <span>Objetivo do ciclo</span>
                {ALERT_OBJECTIVES.map((o) => (
                  <label key={o} className="thermo-check">
                    <Checkbox
                      checked={rule.objectives.includes(o)}
                      onCheckedChange={(v) =>
                        set({ objectives: v === true ? [...rule.objectives, o] : rule.objectives.filter((x) => x !== o) })
                      }
                    />
                    {ALERT_OBJECTIVE_LABELS[o]}
                  </label>
                ))}
              </div>
            </div>
          )}
        </fieldset>

        <fieldset className="calert-fieldset">
          <legend>Quando avisar</legend>
          <div className="calert-grid">
            <label>
              <span>Métrica</span>
              <Select aria-label="Métrica" value={rule.metric} onValueChange={(v) => pickMetric(v as AlertMetric)}>
                {ALERT_METRICS.map((m) => (
                  <SelectOption key={m} value={m}>
                    {`${METRIC_INFO[m].label}${METRIC_INFO[m].cycle ? " (ciclo)" : ""}`}
                  </SelectOption>
                ))}
              </Select>
            </label>
            <label>
              <span>Condição</span>
              <Select aria-label="Condição" value={rule.condition} onValueChange={(v) => pickCondition(v as AlertCondition)}>
                {conditions.map((c) => (
                  <SelectOption key={c} value={c}>
                    {CONDITION_LABELS[c]}
                  </SelectOption>
                ))}
              </Select>
            </label>
            {(rule.condition === "above" || rule.condition === "below") && !info.cycle && (
              <label>
                <span>Em qual período</span>
                <Select
                  aria-label="Período"
                  value={rule.period}
                  onValueChange={(v) =>
                    set({ period: v as CampaignAlertRule["period"], days: v === "days" ? Math.max(rule.days, 7) : 1 })
                  }
                >
                  <SelectOption value="day">Ontem (o último dia)</SelectOption>
                  <SelectOption value="days">Soma dos últimos dias</SelectOption>
                  <SelectOption value="cycle">No ciclo até ontem</SelectOption>
                </Select>
              </label>
            )}
            {(rule.condition === "unchanged" ||
              rule.condition === "zero" ||
              rule.condition === "rise" ||
              rule.condition === "drop" ||
              rule.period === "days") && (
              <label>
                <span>
                  {rule.condition === "rise" || rule.condition === "drop"
                    ? "Dias comparados"
                    : rule.condition === "unchanged" || rule.condition === "zero"
                      ? "Por quantos dias seguidos"
                      : "Últimos dias"}
                </span>
                <Input
                  type="number"
                  min={rule.condition === "unchanged" || rule.period === "days" && (rule.condition === "above" || rule.condition === "below") ? 2 : 1}
                  max={30}
                  value={String(rule.days)}
                  onChange={(e) => set({ days: Number(e.target.value) || 1 })}
                />
              </label>
            )}
            {(rule.condition === "above" ||
              rule.condition === "below" ||
              rule.condition === "rise" ||
              rule.condition === "drop") && (
              <label>
                <span>
                  {rule.condition === "rise" || rule.condition === "drop" ? "Variação mínima (%)" : `Valor${unit ? ` (${unit})` : ""}`}
                </span>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  value={rule.value === null ? "" : String(rule.value)}
                  placeholder={rule.condition === "rise" || rule.condition === "drop" ? "Ex.: 30" : "Ex.: 25"}
                  onChange={(e) => set({ value: e.target.value === "" ? null : Number(e.target.value) })}
                />
              </label>
            )}
            {rule.condition === "unchanged" && (
              <label>
                <span title="Diferença aceita entre os dias (% do maior). 0: exatamente igual.">Tolerância (%)</span>
                <Input
                  type="number"
                  min={0}
                  max={50}
                  step="0.5"
                  value={String(rule.tolerance)}
                  onChange={(e) => set({ tolerance: Number(e.target.value) || 0 })}
                />
              </label>
            )}
          </div>
          <MetricHelp
            metric={rule.metric}
            onUse={(sample) => set(sample)}
            onPick={(m) => pickMetric(m)}
          />
          {isMoney(rule.metric) && (
            <button
              type="button"
              role="switch"
              aria-checked={rule.with_m}
              className={`template-switch calert-m${rule.with_m ? " on" : ""}`}
              onClick={() => set({ with_m: !rule.with_m })}
              title="Com M: os valores como o cliente contratou e vê. Sem M: o que a plataforma gasta."
            >
              <span aria-hidden="true" />
              {rule.with_m ? "Valores com M aplicado" : "Valores sem M (o que a plataforma gasta)"}
            </button>
          )}
        </fieldset>

        <fieldset className="calert-fieldset">
          <legend>Como avisar</legend>
          <div className="calert-grid">
            <label>
              <span>Repetição</span>
              <Select
                aria-label="Repetição"
                value={rule.repeat}
                onValueChange={(v) => set({ repeat: v as CampaignAlertRule["repeat"] })}
              >
                <SelectOption value="once">Uma vez</SelectOption>
                <SelectOption value="daily">Todo dia enquanto valer</SelectOption>
                <SelectOption value="every">A cada N dias</SelectOption>
              </Select>
            </label>
            {rule.repeat === "every" && (
              <label>
                <span>A cada quantos dias</span>
                <Input
                  type="number"
                  min={2}
                  max={30}
                  value={String(rule.repeat_days)}
                  onChange={(e) => set({ repeat_days: Number(e.target.value) || 2 })}
                />
              </label>
            )}
            <label>
              <span>Entrega</span>
              <Select
                aria-label="Entrega"
                value={rule.channel}
                onValueChange={(v) => set({ channel: v as CampaignAlertRule["channel"] })}
              >
                <SelectOption value="now">Na hora</SelectOption>
                <SelectOption value="digest">Resumo do dia (11h)</SelectOption>
              </Select>
            </label>
          </div>
          <p className="calert-hint">
            {rule.repeat === "once"
              ? "Uma vez: avisa quando acontecer e só de novo depois que a situação normalizar e voltar a acontecer."
              : rule.repeat === "daily"
                ? "Todo dia: avisa em cada conferência (uma por dia) enquanto a situação continuar."
                : `A cada ${rule.repeat_days} dias enquanto a situação continuar.`}{" "}
            {rule.channel === "now"
              ? "Na hora: chega na caixa de entrada e como notificação, logo depois da sincronização da manhã."
              : "Resumo: um aviso só às 11h com todos os disparos do dia."}
          </p>
          <label className="thermo-check">
            <Checkbox checked={rule.active} onCheckedChange={(v) => set({ active: v === true })} />
            Ligado
          </label>
        </fieldset>

        <p className="calert-summary">
          <BellRing size={14} aria-hidden="true" /> {describeRule(effective)}
        </p>

        {preview && <PreviewResult preview={preview} />}

        {(error || problem) && (
          <p className="form-error" role="alert">
            {error || problem}
          </p>
        )}
        <div className="calert-actions">
          <Button className="btn primary" onClick={() => void save()} loading={busy} disabled={!!problem}>
            <BellRing size={15} aria-hidden="true" /> {rule.id ? "Salvar aviso" : "Criar aviso"}
          </Button>
          <Button className="btn secondary" onClick={() => void check()} disabled={!!problem || checking}>
            {checking ? <Loader2 size={15} className="spin" /> : <Search size={15} />} Conferir agora
          </Button>
          <Button className="btn secondary" onClick={onClose}>
            Voltar
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function PreviewResult({ preview }: { preview: AlertPreview }) {
  const waiting = preview.campaigns.filter((c) => !c.ok).length;
  return (
    <section className="calert-preview" aria-label="Resultado de hoje">
      <strong>
        {preview.checked === 0
          ? "Nenhuma campanha ativa que você enxerga passa por esta regra."
          : `Hoje, ${preview.met} de ${preview.checked} ${preview.checked === 1 ? "campanha dispararia" : "campanhas disparariam"}.`}
      </strong>
      {waiting > 0 && (
        <small>
          {waiting} {waiting === 1 ? "não dá" : "não dão"} para conferir agora (sem números suficientes ou sem ciclo em
          andamento).
        </small>
      )}
      {preview.campaigns.length > 0 && (
        <ul>
          {preview.campaigns.slice(0, 30).map((c) => (
            <li key={c.id} className={c.met ? "met" : c.ok ? "" : "na"}>
              <span className="calert-dot" aria-hidden="true" />
              <span>
                <b>{c.name}</b> <small>{c.client}</small>
              </span>
              <small>{c.text}</small>
            </li>
          ))}
        </ul>
      )}
      <small>Nada foi enviado: os avisos de verdade chegam depois da sincronização de cada manhã.</small>
    </section>
  );
}

// ------------------------------------------------------------ explicação das métricas
const UNIT_LABEL = { money: "em R$", percent: "em %", number: "em quantidade" } as const;

/**
 * O que a métrica escolhida mede, como a conta é feita, um exemplo com
 * números e quando vale a pena vigiar — com um aviso de exemplo que preenche
 * a condição e a lista de todas as métricas para comparar.
 */
function MetricHelp({
  metric,
  onUse,
  onPick,
}: {
  metric: AlertMetric;
  onUse: (sample: (typeof METRIC_HELP)[AlertMetric]["sample"]) => void;
  onPick: (metric: AlertMetric) => void;
}) {
  const [all, setAll] = useState(false);
  const info = METRIC_INFO[metric];
  const help = METRIC_HELP[metric];
  const sample = normalizeRule({ ...blankRule(), metric, ...help.sample });
  return (
    <section className="calert-help" aria-label={`Sobre a métrica ${info.label}`}>
      <header>
        <Info size={15} aria-hidden="true" />
        <strong>{info.label}</strong>
        <span className="calert-help-tag">
          {info.cycle ? "do ciclo atual" : "do dia a dia"} · {UNIT_LABEL[info.unit]}
        </span>
      </header>
      <p className="calert-help-what">{help.what}</p>
      <dl>
        <div>
          <dt>Como é calculado</dt>
          <dd>{help.calc}</dd>
        </div>
        <div>
          <dt>Exemplo</dt>
          <dd>{help.example}</dd>
        </div>
        <div>
          <dt>Quando usar</dt>
          <dd>{help.tip}</dd>
        </div>
      </dl>
      <footer>
        <button type="button" className="calert-help-use" onClick={() => onUse(help.sample)}>
          <Wand2 size={14} aria-hidden="true" /> Usar o exemplo: {conditionText(sample).replace(/, (com|sem) M$/, "")}
        </button>
        <button type="button" className="text-btn" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "Fechar a lista" : "Comparar todas as métricas"}
        </button>
      </footer>
      {all && (
        <ul className="calert-help-all">
          {ALERT_METRICS.map((m) => (
            <li key={m}>
              <button
                type="button"
                aria-current={m === metric}
                onClick={() => {
                  onPick(m);
                  setAll(false);
                }}
              >
                <b>
                  {METRIC_INFO[m].label}
                  <small>{METRIC_INFO[m].cycle ? " · ciclo" : " · dia a dia"}</small>
                </b>
                <span>{METRIC_HELP[m].what}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ------------------------------------------------------------ escolhas
function PickMany({
  label,
  all,
  options,
  value,
  onChange,
}: {
  label: string;
  /** O que vale sem nada escolhido ("Todos os clientes"). */
  all: string;
  options: { value: string; label: string }[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const left = options.filter((o) => !value.includes(o.value));
  return (
    <div className="calert-pick">
      <span>{label}</span>
      <div>
        {value.map((v) => (
          <span key={v} className="chip selected calert-chip">
            {options.find((o) => o.value === v)?.label ?? "—"}
            <button type="button" aria-label={`Tirar ${options.find((o) => o.value === v)?.label ?? ""}`} onClick={() => onChange(value.filter((x) => x !== v))}>
              <X size={12} />
            </button>
          </span>
        ))}
        {left.length > 0 && (
          <Select aria-label={`Adicionar ${label.toLowerCase()}`} value="" onValueChange={(v) => v && onChange([...value, v])}>
            <SelectOption value="">{value.length ? "Adicionar…" : all}</SelectOption>
            {left.map((o) => (
              <SelectOption key={o.value} value={o.value}>
                {o.label}
              </SelectOption>
            ))}
          </Select>
        )}
      </div>
    </div>
  );
}

function CampaignPicker({
  value,
  suggestion,
  search,
  onChange,
}: {
  value: AlertCampaignOption | null;
  suggestion: AlertCampaignOption | null;
  search: (term: string) => Promise<AlertCampaignOption[]>;
  onChange: (c: AlertCampaignOption | null) => void;
}) {
  const [term, setTerm] = useState("");
  const [found, setFound] = useState<AlertCampaignOption[] | null>(null);
  useEffect(() => {
    if (value) return;
    let live = true;
    const t = setTimeout(() => {
      search(term.trim())
        .then((list) => live && setFound(list))
        .catch(() => live && setFound([]));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [term, value, search]);
  if (value)
    return (
      <div className="calert-picked">
        <span>
          <b>{value.name}</b>
          {value.client && <small> · {value.client}</small>}
        </span>
        <button type="button" className="text-btn" onClick={() => onChange(null)}>
          Trocar
        </button>
      </div>
    );
  return (
    <div className="calert-picker">
      {suggestion && (
        <button type="button" className="chip" onClick={() => onChange(suggestion)}>
          Esta campanha: {suggestion.name}
        </button>
      )}
      <Input
        type="search"
        icon={Search}
        aria-label="Buscar campanha"
        placeholder="Buscar campanha ativa ou cliente"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
      />
      {found === null ? (
        <small className="calert-hint">Buscando…</small>
      ) : found.length ? (
        <ul>
          {found.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => onChange(c)}>
                <b>{c.name}</b> <small>{c.client}</small>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <small className="calert-hint">Nenhuma campanha ativa encontrada.</small>
      )}
    </div>
  );
}


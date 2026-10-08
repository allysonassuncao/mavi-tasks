import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  BellRing,
  CalendarClock,
  CirclePause,
  CirclePlay,
  History,
  Link2,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  TriangleAlert,
} from "lucide-react";
import {
  Button,
  Checkbox,
  Input,
  Select,
  SelectOption,
  Textarea,
  Loading,
} from "./ui";
import { Empty, Modal } from "./components";
import type { FormPreset } from "./forms";
import {
  CampaignInsightsAside,
  PlatformInsights,
  CampaignInsightsTab,
  CrmGoalControl,
  useCampaignInsights,
} from "./CampaignInsights";
import { CampaignMaviCell } from "./CampaignMaviCell";
import { RqCampaignButton } from "./RqBilling";
import { isRqProduct } from "./rq-billing";
import { demoDaily, serverDaily, type DailyRead } from "./campaign-daily";
import {
  demoInsights,
  serverInsights,
  type InsightBadge,
  type InsightsBackend,
} from "./campaign-insights";
import { Pagination } from "./Pagination";
import { ContractPicker } from "./ContractPicker";
import { contractParts, dateKey } from "./domain";
import {
  campaignIdFromPath,
  campaignUrl,
  navigate,
  pageUrl,
  routeParts,
  useLocation,
  useUrlState,
} from "./router";
import type { CalendarDay, Snapshot } from "./types";
import {
  addDays,
  businessDaysAround,
  campaignStatuses,
  connectionResult,
  currentCycle,
  cycleAlert,
  cycleDays,
  cycleDraft,
  cycleInput,
  cycleState,
  cycleStates,
  cyclesOf,
  dayOffReason,
  daysLeft,
  destinations,
  goalCost,
  monthLabel,
  monthlyEnd,
  money,
  parseAmount,
  nextCycleDraft,
  objectives,
  platforms,
  sharedDayLabels,
  shortDate,
  splitList,
  supabaseCampaigns,
  turnover,
  weekdayDate,
  type AdCampaign,
  type AdCampaignEvent,
  type AdCampaignStatus,
  type AdCycle,
  type AdCycleLink,
  type AdDestination,
  type AdObjective,
  type AdPlatform,
  type CampaignData,
  type CampaignPage,
  type CampaignRow,
  type RowResults,
  type CampaignScope,
  type CampaignsBackend,
  type CycleAlert,
  type CycleDraft,
  type CycleInput,
  type SharedDayChoice,
} from "./campaigns";
import { demoCampaigns } from "./campaigns-demo";
import {
  AdConnections,
  ClientMetaConnection,
  CycleLinks,
  MetaAccountChooser,
  accountLabel,
} from "./CampaignLinks";
import { CampaignDayToDay, useWithM } from "./CampaignDayToDay";
import {
  MultiplierChangeFields,
  MultiplierLog,
  useMultiplierImpact,
} from "./CampaignMultiplier";
import { sameMultiplier, type MultiplierApply } from "./campaign-multiplier";
import { dailyBudget, daysRemaining } from "./campaign-metrics";
import {
  GAP_OK,
  GAP_WARN,
  budgetState,
  itemStatus,
  refreshPlatformBudget,
  type PlatformBudget,
} from "./campaign-platform-budget";
import { CampaignPlatform } from "./CampaignPlatform";
import { CampaignReports } from "./CampaignReports";
import { GooglePlatform } from "./GooglePlatform";
import {
  demoGooglePlatform,
  serverGooglePlatform,
  type GooglePlatformBackend,
} from "./google-platform";
import {
  cached,
  demoPlatform,
  serverPlatform,
  type PlatformBackend,
} from "./campaign-platform";
import type { PlatformCrm } from "./platform-crm";
import {
  demoReports,
  supabaseReports,
  type ReportsBackend,
} from "./campaign-reports";
import { GoogleConversions, MetaConversions } from "./CampaignConversions";
import { CampaignAlerts, type AlertCampaignOption } from "./CampaignAlerts";
import { CampaignMavi } from "./CampaignMavi";
import {
  CrmConnections,
  demoCrm,
  OpenInCrm,
  openCrmTab,
  serverCrm,
  type CrmBackend,
} from "./CampaignCrm";
import {
  CampaignMediaBalance,
  CycleMediaFit,
  cycleMediaBlocked,
  useMediaRoom,
} from "./CampaignMediaBalance";
import { CampaignJobFailures } from "./CampaignJobFailures";

type Props = {
  demo: boolean;
  /** Already limited to the clients the person may see. */
  data: Snapshot;
  company: string;
  user: string;
  notify: (message: string) => void;
  /** False: read-only (kept for callers that only show the numbers). */
  canEdit?: boolean;
  /**
   * Leaders: the agency's connections too (Google Ads). A collaborator with
   * the module on works on the clients of their teams (the database checks).
   */
  agency?: boolean;
  /** Insights da MAVI › Criar tarefa: o formulário de tarefa do App. */
  onNewTask?: (preset: FormPreset) => void;
};
type CampaignFormState = { campaign?: AdCampaign } | null;
type CycleFormState = {
  campaign: AdCampaign;
  cycle?: AdCycle;
  /** Right after creating the campaign: the first cycle. */
  first?: boolean;
} | null;
type StatusFormState = { campaign: AdCampaign; to: AdCampaignStatus } | null;

const emptyData: CampaignData = { campaigns: [], cycles: [] };
/**
 * The list's last address (filters, search): "Todas as campanhas" goes back
 * to it. Kept for the visit, like the browser's Back.
 */
let lastList = "";

/**
 * Campanhas: cadastro de campanhas (por produto contratado) e de seus ciclos.
 * Administradores e gestores usam tudo; um colaborador com o módulo ligado
 * (Módulos visíveis) usa tudo nas campanhas dos clientes das equipes dele,
 * menos a conexão do Google da agência (o banco repete a regra).
 * A troca do ciclo atual é sempre manual; a tela só aponta quando o ciclo
 * atual terminou ou quando o próximo investimento precisa entrar.
 */
export function CampaignsPage({
  demo,
  data,
  company,
  user,
  notify,
  canEdit = true,
  agency = true,
  onNewTask,
}: Props) {
  const dataRef = useRef(data);
  dataRef.current = data;
  const backend: CampaignsBackend = useMemo(
    () =>
      demo ? demoCampaigns(() => dataRef.current, user) : supabaseCampaigns,
    [demo, user],
  );
  const timezone = data.companies.find((c) => c.id === company)?.timezone;
  const today = dateKey(new Date(), timezone);
  // Only the open campaign (with its cycles) is loaded; the list comes a
  // page at a time from the server.
  const [state, setState] = useState<CampaignData>(emptyData);
  const [loaded, setLoaded] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  // Meta: the ad account's view and the reports (live or in memory).
  const platform: PlatformBackend = useMemo(
    () => (demo ? demoPlatform(["23850001"]) : serverPlatform),
    [demo],
  );
  // Google: the same, with the Google Ads interface's views.
  const googlePlatform: GooglePlatformBackend = useMemo(
    () => (demo ? demoGooglePlatform(["21000001"]) : serverGooglePlatform),
    [demo],
  );
  // Insights da MAVI: o painel, a aba e o selo da lista.
  const insights: InsightsBackend = useMemo(
    () => (demo ? demoInsights() : serverInsights),
    [demo],
  );
  const reports: ReportsBackend = useMemo(
    () =>
      demo
        ? demoReports({
            metrics: backend.metrics,
            cycles: (id) => cyclesOf(stateRef.current, id),
            names: (id) => {
              const c = stateRef.current.campaigns.find((x) => x.id === id);
              const parts = c ? contractParts(dataRef.current, c.contract_id) : null;
              return {
                campaign: c?.name ?? "",
                client: parts?.client?.name ?? "",
                product: parts?.product?.name ?? "",
                platform: c?.platform,
              };
            },
            user,
          })
        : supabaseReports,
    [demo, backend, user],
  );
  const [loadError, setLoadError] = useState("");
  const [listTick, setListTick] = useState(0);
  // Each campaign has its own address, /campanhas/<id>: it opens in a new
  // tab, is shared and survives a reload. The old ?campanha=<id> becomes it.
  const location = useLocation();
  const [locationPath, locationQuery = ""] = location.split("?");
  const agencyPath = routeParts(locationPath).company;
  const [legacy] = useUrlState<string>("campanha", "");
  const selected = campaignIdFromPath(locationPath) ?? legacy;
  const href = useCallback(
    (id: string) => campaignUrl(id, agencyPath),
    [agencyPath],
  );
  useEffect(() => {
    if (!campaignIdFromPath(href(legacy))) return;
    const q = new URLSearchParams(locationQuery);
    q.delete("campanha");
    const rest = q.toString();
    navigate(href(legacy) + (rest ? `?${rest}` : ""), true);
  }, [legacy, locationQuery, href]);
  const openCampaign = (id: string) => navigate(href(id));
  // Meus avisos (lista, historico ou novo): aberto da lista ou de uma campanha.
  const [alertsView, setAlertsView] = useUrlState<string>("avisos", "");
  // Conversar com a MAVI sobre a campanha aberta (?mavi=1).
  const [maviOpen, setMaviOpen] = useUrlState<string>("mavi", "");
  const searchCampaigns = useCallback(
    (term: string): Promise<AlertCampaignOption[]> =>
      backend
        .page(company, { scope: "active", search: term, platform: "", attention: false, limit: 20, offset: 0 })
        .then((r) => r.rows.map((row) => ({ id: row.campaign.id, name: row.campaign.name, client: row.client_name }))),
    [backend, company],
  );
  const [campaignForm, setCampaignForm] = useState<CampaignFormState>(null);
  const [cycleForm, setCycleForm] = useState<CycleFormState>(null);
  const [statusForm, setStatusForm] = useState<StatusFormState>(null);
  const [connections, setConnections] = useState(false);
  // Alterações do M (administrators and managers).
  const [multiplierLog, setMultiplierLog] = useState(false);
  const [eventsTick, setEventsTick] = useState(0);
  // Abrir no CRM: os clientes ligados ao MakeCRM que a pessoa vê.
  const crm: CrmBackend = useMemo(
    () => (demo ? demoCrm(() => dataRef.current.clients) : serverCrm),
    [demo],
  );
  const [crmLinks, setCrmLinks] = useState<Record<string, string>>({});
  const [crmTick, setCrmTick] = useState(0);
  const [crmSummary, setCrmSummary] = useState<{
    total: number;
    unlinked: number;
  } | null>(null);
  useEffect(() => {
    let live = true;
    crm
      .links(company)
      .then((links) => live && setCrmLinks(links))
      .catch(() => live && setCrmLinks({}));
    return () => {
      live = false;
    };
  }, [crm, company, crmTick]);
  // The button for a campaign's client, when it is linked to the MakeCRM.
  const crmButton = (contract: string, compact = false) => {
    const client = contractParts(data, contract).client;
    return client && client.id in crmLinks ? (
      <OpenInCrm
        backend={crm}
        company={company}
        client={client.id}
        clientName={client.name}
        notify={notify}
        compact={compact}
      />
    ) : null;
  };
  // The same, as a function (the campaign's "Abrir no CRM ▾" with the stages that matter).
  const crmOpener = (contract: string) => {
    const client = contractParts(data, contract).client;
    return client && client.id in crmLinks
      ? () => openCrmTab({ backend: crm, company, client: client.id, clientName: client.name, notify })
      : null;
  };
  // Plataforma: the CRM's deals per UTM of the campaign's client.
  const platformCrm = (contract: string): PlatformCrm | null => {
    const client = contractParts(data, contract).client;
    if (!client) return null;
    return {
      linked: client.id in crmLinks,
      clientName: client.name,
      load: (since, until, fresh) =>
        cached(
          JSON.stringify(["crm-utm", company, client.id, since, until]),
          () => crm.utm(company, client.id, since, until),
          fresh,
        ),
      open: (next) =>
        void openCrmTab({
          backend: crm,
          company,
          client: client.id,
          clientName: client.name,
          notify,
          next,
        }),
    };
  };
  // Back from Facebook or Google (api/ads-callback): say how it went.
  const [connection, setConnection] = useUrlState<string>("conexao", "");
  // A Facebook login waiting for the client's accounts to be ticked.
  const [pending, setPending] = useUrlState<string>("pendente", "");
  // Bumped when a connection changed: whoever shows accounts reads again.
  const [connectionTick, setConnectionTick] = useState(0);
  useEffect(() => {
    if (!connection) return;
    setConnection("");
    // The chooser (pendente) says the rest.
    if (connection === "meta-escolher") return;
    notify(connectionResult(connection));
    setConnections(true);
  }, [connection, setConnection, notify]);

  const reload = useCallback(async () => {
    if (!selected) return;
    try {
      setState(await backend.campaign(company, selected));
      setLoadError("");
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, [backend, company, selected]);
  useEffect(() => {
    setLoaded(false);
    setState(emptyData);
    void reload();
  }, [reload]);
  const afterChange = async (message: string) => {
    await reload();
    setListTick((t) => t + 1);
    setEventsTick((t) => t + 1);
    notify(message);
  };

  const canCreate = canEdit && data.contracts.some((k) => !k.archived);
  const campaign = state.campaigns.find((c) => c.id === selected);

  return (
    <>
      {selected && !loaded ? (
        <Loading variant="detail" />
      ) : selected && loadError ? (
        <div className="error-banner" role="alert">
          <TriangleAlert size={18} />
          <span>Não foi possível carregar as campanhas: {loadError}</span>
          <Button className="btn secondary" onClick={() => void reload()}>
            Tentar de novo
          </Button>
        </div>
      ) : campaign ? (
        <CampaignDetail
          key={campaign.id}
          campaign={campaign}
          state={state}
          data={data}
          company={company}
          backend={backend}
          platform={platform}
          googlePlatform={googlePlatform}
          reports={reports}
          insights={insights}
          user={user}
          onNewTask={onNewTask}
          today={today}
          eventsTick={eventsTick}
          notify={notify}
          connectionTick={connectionTick}
          onPending={setPending}
          canEdit={canEdit}
          demo={demo}
          maviOpen={maviOpen === "1"}
          onMavi={(open) => setMaviOpen(open ? "1" : "")}
          onAlerts={() => setAlertsView("lista")}
          crm={crmButton(campaign.contract_id)}
          crmOpen={crmOpener(campaign.contract_id)}
          platformCrm={platformCrm(campaign.contract_id)}
          link={window.location.origin + href(campaign.id)}
          onBack={() =>
            navigate(
              routeParts(lastList.split("?")[0]).company === agencyPath &&
                lastList
                ? lastList
                : pageUrl("campaigns", agencyPath),
            )
          }
          onEdit={() => setCampaignForm({ campaign })}
          onStatus={(to) => setStatusForm({ campaign, to })}
          onNewCycle={() => setCycleForm({ campaign })}
          onEditCycle={(cycle) => setCycleForm({ campaign, cycle })}
          onMakeCurrent={async (cycle) => {
            try {
              await backend.setCurrentCycle(campaign, cycle.id);
              await afterChange(
                `Ciclo atual: ${shortDate(cycle.start_date)} a ${shortDate(cycle.end_date)}`,
              );
            } catch (e) {
              notify((e as Error).message);
            }
          }}
        />
      ) : (
        <CampaignList
          backend={backend}
          company={company}
          today={today}
          canCreate={canCreate}
          missing={!!selected}
          tick={listTick}
          href={href}
          onOpen={openCampaign}
          onNew={() => setCampaignForm({})}
          onConnections={canEdit ? () => setConnections(true) : undefined}
          onAlerts={() => setAlertsView("lista")}
          onMultiplierLog={agency ? () => setMultiplierLog(true) : undefined}
          crm={(c) => crmButton(c.contract_id, true)}
          insights={insights}
          demo={demo}
        />
      )}
      {agency && multiplierLog && (
        <MultiplierLog
          backend={backend.multiplier}
          company={company}
          href={href}
          onClose={() => setMultiplierLog(false)}
        />
      )}
      {alertsView && (
        <CampaignAlerts
          company={company}
          data={data}
          campaign={
            campaign
              ? {
                  id: campaign.id,
                  name: campaign.name,
                  client: contractParts(data, campaign.contract_id).client?.name ?? "",
                }
              : null
          }
          view={alertsView}
          onView={setAlertsView}
          onClose={() => setAlertsView("")}
          onOpenCampaign={(id) => {
            setAlertsView("");
            openCampaign(id);
          }}
          searchCampaigns={searchCampaigns}
          notify={notify}
        />
      )}
      {canEdit && campaignForm && (
        <CampaignForm
          campaign={campaignForm.campaign}
          data={data}
          cycleCount={
            campaignForm.campaign
              ? cyclesOf(state, campaignForm.campaign.id).length
              : 0
          }
          onClose={() => setCampaignForm(null)}
          onSave={async (input) => {
            const editing = campaignForm.campaign;
            if (editing) {
              await backend.updateCampaign(editing, input);
              setCampaignForm(null);
              await afterChange("Campanha atualizada");
              return;
            }
            const id = await backend.createCampaign(company, input);
            setCampaignForm(null);
            await afterChange(
              "Campanha cadastrada. Agora cadastre o primeiro ciclo.",
            );
            openCampaign(id);
            const [created] = (await backend.campaign(company, id)).campaigns;
            if (created) setCycleForm({ campaign: created, first: true });
          }}
        />
      )}
      {canEdit && cycleForm && (
        <CycleForm
          campaign={cycleForm.campaign}
          cycle={cycleForm.cycle}
          first={cycleForm.first}
          state={state}
          today={today}
          company={company}
          ads={backend.ads}
          client={
            contractParts(data, cycleForm.campaign.contract_id).client ?? null
          }
          connectionTick={connectionTick}
          onPending={setPending}
          onClose={() => setCycleForm(null)}
          backend={backend}
          calendar={data.calendarDays}
          onSave={async (input, makeCurrent, override) => {
            if (cycleForm.cycle) {
              await backend.updateCycle(cycleForm.cycle, input, override);
              setCycleForm(null);
              await afterChange("Ciclo atualizado");
            } else {
              await backend.createCycle(
                cycleForm.campaign,
                input,
                makeCurrent,
                override,
              );
              setCycleForm(null);
              await afterChange(
                makeCurrent
                  ? "Ciclo cadastrado e definido como atual"
                  : "Ciclo cadastrado",
              );
            }
          }}
        />
      )}
      {canEdit && connections && (
        <AdConnections
          company={company}
          ads={backend.ads}
          onClose={() => setConnections(false)}
          notify={notify}
          onOpenCampaign={(id) => {
            setConnections(false);
            openCampaign(id);
          }}
          onPending={setPending}
          refresh={connectionTick}
          agency={agency}
          crm={
            agency
              ? {
                  panel: (
                    <CrmConnections
                      backend={crm}
                      company={company}
                      notify={notify}
                      onChange={() => setCrmTick((t) => t + 1)}
                      onSummary={setCrmSummary}
                    />
                  ),
                  summary: crmSummary,
                }
              : undefined
          }
        />
      )}
      {canEdit && pending && (
        <MetaAccountChooser
          key={pending}
          ads={backend.ads}
          pending={pending}
          onClose={() => setPending("")}
          onDone={(message) => {
            setPending("");
            setConnectionTick((t) => t + 1);
            notify(message);
          }}
        />
      )}
      {canEdit && statusForm && (
        <StatusForm
          campaign={statusForm.campaign}
          to={statusForm.to}
          onClose={() => setStatusForm(null)}
          onSave={async (reason) => {
            await backend.setStatus(statusForm.campaign, statusForm.to, reason);
            setStatusForm(null);
            await afterChange(
              statusForm.to === "active"
                ? "Campanha ativada"
                : "Campanha inativada",
            );
          }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */

function AlertChip({
  alert,
  today,
  cycle,
}: {
  alert: CycleAlert;
  today: string;
  cycle: AdCycle | null;
}) {
  switch (alert.kind) {
    case "no_cycle":
      return <span className="campaign-chip warn">Sem ciclo cadastrado</span>;
    case "no_current":
      return <span className="campaign-chip warn">Defina o ciclo atual</span>;
    case "ended":
      return (
        <span
          className="campaign-chip danger"
          title="O ciclo atual terminou e não foi trocado"
        >
          Encerrado há {alert.days} {alert.days === 1 ? "dia" : "dias"} · trocar
          ciclo
        </span>
      );
    case "ends_today":
      return <span className="campaign-chip warn">Termina hoje</span>;
    case "ending":
      return (
        <span
          className="campaign-chip warn"
          title="Nenhum próximo ciclo cadastrado"
        >
          {alert.days} {alert.days === 1 ? "dia" : "dias"} · cobrar investimento
        </span>
      );
    default:
      if (!cycle) return null;
      if (cycleState(cycle, today) === "planned")
        return (
          <span className="campaign-chip">
            Começa em {shortDate(cycle.start_date)}
          </span>
        );
      return (
        <span className="campaign-chip muted">
          {daysLeft(cycle, today)} dias restantes
        </span>
      );
  }
}

function PlatformLabel({ platform }: { platform: AdPlatform }) {
  return (
    <span className={`campaign-platform ${platform}`}>
      {platforms[platform]}
    </span>
  );
}

function StatusChip({ status }: { status: AdCampaignStatus }) {
  return (
    <span className={`campaign-status ${status}`}>
      {campaignStatuses[status]}
    </span>
  );
}

const PAGE_SIZE = 25;

/** The Status filter: the URL's word for each scope (active: none). */
const statusFilters: { value: string; scope: CampaignScope; label: string }[] =
  [
    { value: "", scope: "active", label: "Ativas" },
    { value: "aguardando", scope: "pending", label: "Aguardando ativação" },
    { value: "inativas", scope: "inactive", label: "Inativas" },
    { value: "todos", scope: "all", label: "Todos os status" },
  ];

/** The list's "Orçamento diário": what the cycle should spend a day now. */
function DailyBudget({
  cycle,
  spent,
  today,
  withM,
}: {
  cycle: AdCycle | null;
  spent: CampaignRow["spent"];
  today: string;
  withM: boolean;
}) {
  // An ended cycle has no day left to spend on.
  if (!cycle || !spent || today > cycle.end_date) return <>—</>;
  const days = daysRemaining(cycle, today);
  return (
    <>
      {money(dailyBudget(cycle, spent.gross, today, withM))}
      <small className="cell-note">
        {days} {days === 1 ? "dia restante" : "dias restantes"}
      </small>
    </>
  );
}

/** "às 14:10" hoje; "em 04/10 às 21:30" de outro dia. */
function readAt(at: string, today: string) {
  const d = new Date(at);
  return dateKey(d) === today
    ? `às ${clock(at)}`
    : `em ${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} às ${clock(at)}`;
}
const signedMoney = (v: number) => `${v >= 0 ? "+" : "−"}${money(Math.abs(v))}`;

/**
 * Embaixo do "Orçamento diário": o orçamento configurado no Meta/Google
 * (sempre o valor real) comparado ao recomendado sem M — verde até 10% de
 * diferença, amarelo até 25%, vermelho acima; parada na plataforma em
 * vermelho; o vitalício à parte. O botão lê a campanha agora (o servidor
 * deixa uma vez a cada 5 min); a lista se relê pelo aviso de sempre.
 */
function PlatformBudgetLine({
  campaign,
  cycle,
  spent,
  budget,
  today,
  demo,
}: {
  campaign: AdCampaign;
  cycle: AdCycle | null;
  spent: CampaignRow["spent"];
  budget: PlatformBudget | null;
  today: string;
  demo: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  if (campaign.platform !== "meta" && campaign.platform !== "google")
    return null;
  if (campaign.status !== "active" || !cycle) return null;
  if (today < cycle.start_date || today > cycle.end_date) return null;
  const rec = spent ? dailyBudget(cycle, spent.gross, today, false) : null;
  const state = budgetState(budget, rec);
  const where = campaign.platform === "meta" ? "no Meta" : "no Google";
  const refresh = async (e: ReactMouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    setProblem("");
    try {
      if (demo) await new Promise((r) => setTimeout(r, 600));
      else await refreshPlatformBudget(campaign.id);
      window.dispatchEvent(new CustomEvent("mavi:campaign-today"));
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const lines: string[] = [
    `Orçamento configurado ${where} (valor real, sem M).`,
  ];
  if (state.kind === "daily" && state.gap && rec !== null)
    lines.push(
      `Recomendado sem M: ${money(rec)}/dia → ${signedMoney(state.gap.diff)} (${Math.round(state.gap.pct)}%). Verde até ${GAP_OK}%, amarelo até ${GAP_WARN}%, vermelho acima.`,
    );
  if (budget?.lifetime)
    lines.push(
      `Vitalício: ${money(budget.lifetime)}${budget.lifetime_left ? ` (restam ${money(budget.lifetime_left)})` : ""}; não entra na comparação com o diário.`,
    );
  if (budget?.items.length) {
    lines.push("");
    for (const i of budget.items.slice(0, 12)) {
      const value = i.daily
        ? `${money(i.daily)}/dia`
        : i.lifetime
          ? `${money(i.lifetime)} vitalício`
          : "—";
      lines.push(
        `• ${i.name}: ${value} (${itemStatus(i)}${i.shared ? ", orçamento compartilhado" : ""})`,
      );
    }
    if (budget.total > 12) lines.push(`… e mais ${budget.total - 12}`);
  }
  if (budget?.changed_at && budget.previous_daily !== null)
    lines.push(
      "",
      `Mudou de ${money(budget.previous_daily)} para ${money(budget.daily)} ${readAt(budget.changed_at, today)}.`,
    );
  if (budget?.read_at)
    lines.push(`Lido ${readAt(budget.read_at, today)}. O MAVI lê a cada ~3 h.`);
  if (budget?.error) lines.push(`Última tentativa: ${budget.error}`);
  const tone =
    state.kind === "daily"
      ? (state.gap?.tone ?? "")
      : state.kind === "stopped" || state.kind === "missing"
        ? "bad"
        : state.kind === "error"
          ? "warn"
          : "";
  return (
    <div className={`platform-budget ${tone}`} title={lines.join("\n")}>
      <span className="platform-budget-value">
        {state.kind === "waiting" ? (
          <span className="muted">Na plataforma: aguardando leitura</span>
        ) : state.kind === "error" ? (
          <>Na plataforma: não foi possível ler</>
        ) : state.kind === "missing" ? (
          <>Não encontrada {where}</>
        ) : state.kind === "stopped" ? (
          <>Pausada {where}</>
        ) : state.kind === "lifetime" ? (
          <span className="muted">
            Vitalício {where}: <strong>{money(budget!.lifetime)}</strong>
          </span>
        ) : (
          <>
            Na plataforma: <strong>{money(budget!.daily)}</strong>
            {state.gap && state.gap.tone !== "good" && (
              <span className="platform-budget-diff">
                {" "}
                {signedMoney(state.gap.diff)}
              </span>
            )}
          </>
        )}
      </span>
      {state.kind === "daily" && budget!.lifetime > 0 && (
        <small className="platform-budget-extra">
          Vitalício: {money(budget!.lifetime)}
        </small>
      )}
      <small className="platform-budget-meta">
        {problem ? (
          <span className="platform-budget-problem">{problem}</span>
        ) : budget?.read_at ? (
          <>
            {budget.error && (
              <TriangleAlert size={11} aria-label="A última tentativa falhou" />
            )}
            lido {readAt(budget.read_at, today)}
          </>
        ) : null}
        <button
          type="button"
          className="platform-budget-refresh"
          onClick={refresh}
          disabled={busy}
          aria-label={`Atualizar o orçamento ${where}`}
          title={`Ler o orçamento ${where} agora`}
        >
          <RefreshCw size={11} className={busy ? "spin" : undefined} />
        </button>
      </small>
    </div>
  );
}

/** A leitura de hoje mais velha que isso aparece como desatualizada. */
const STALE_TODAY_MS = 3 * 60 * 60_000;
const count = (n: number) =>
  n.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
const clock = (at: string) =>
  new Date(at).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
type ResultLine = {
  key: "today" | "yesterday" | "cycle";
  label: string;
  spend: number;
  conversions: number;
  multiplier: number;
} | null;
/** Hoje, ontem e o ciclo de uma linha da lista (gasto sem M e o M de cada um). */
function resultLines(cycle: AdCycle | null, r: RowResults) {
  const lines: Record<"today" | "yesterday" | "cycle", ResultLine> = {
    today: r.today && { key: "today", label: "Hoje", ...r.today },
    yesterday: r.yesterday && {
      key: "yesterday",
      label: "Ontem",
      ...r.yesterday,
    },
    cycle:
      r.cycle && cycle
        ? {
            key: "cycle",
            label: "Ciclo",
            ...r.cycle,
            multiplier: cycle.multiplier,
          }
        : null,
  };
  return lines;
}
/** Por que a linha de hoje está vazia ou o que ela mostra (a dica do "Hoje"). */
function todayHint(r: RowResults, now: number) {
  if (!r.today)
    return "Ainda sem a leitura de hoje: o MAVI lê o Meta a cada hora e o Google a cada duas, a partir das 7h.";
  const stale = now - Date.parse(r.today.read_at) > STALE_TODAY_MS;
  return `Hoje até ${clock(r.today.read_at)} (parcial${stale ? "; a leitura está atrasada" : ""}). O MAVI lê o Meta a cada hora e o Google a cada duas.`;
}
/** O dia da linha; o "Hoje" com leitura ganha o ponto ao vivo (cinza se atrasada). */
function DayLabel({ line, hint, live, stale }: { line: string; hint?: string; live?: boolean; stale?: boolean }) {
  return (
    <dt title={hint}>
      {live && <span className={`results-live${stale ? " stale" : ""}`} aria-hidden="true" />}
      {line}
    </dt>
  );
}

/** "Resultados": hoje (ao vivo), ontem e o ciclo, um embaixo do outro. */
function ResultsCell({
  cycle,
  results,
  now,
}: {
  cycle: AdCycle | null;
  results: RowResults;
  now: number;
}) {
  if (!cycle) return <>—</>;
  const lines = resultLines(cycle, results);
  const unit = objectives[cycle.objective].result;
  const stale =
    !!results.today &&
    now - Date.parse(results.today.read_at) > STALE_TODAY_MS;
  return (
    <dl className="campaign-results" aria-label={`Resultados (${unit})`}>
      {(["today", "yesterday", "cycle"] as const).map((key) => {
        const l = lines[key];
        const label = { today: "Hoje", yesterday: "Ontem", cycle: "Ciclo" }[key];
        return (
          <div key={key}>
            <DayLabel
              line={label}
              live={key === "today" && !!l}
              stale={stale}
              hint={
                key === "today"
                  ? todayHint(results, now)
                  : key === "yesterday"
                    ? l
                      ? "O dia de ontem, como a sincronização da manhã gravou"
                      : "Ontem ainda não foi sincronizado (a sincronização roda de manhã)"
                    : "O ciclo até ontem (o último acumulado, como no cabeçalho da campanha)"
              }
            />
            <dd>
              {l ? (
                <strong>{count(l.conversions)}</strong>
              ) : (
                "—"
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * "Custo por resultado" de hoje, ontem e do ciclo, com a cor da meta do
 * ciclo (verba ÷ meta de resultados): verde na meta ou abaixo, vermelho
 * acima; gasto sem resultado também é vermelho. Com M ou sem M, como o resto.
 */
function CostCell({
  cycle,
  results,
  withM,
}: {
  cycle: AdCycle | null;
  results: RowResults;
  withM: boolean;
}) {
  if (!cycle) return <>—</>;
  const lines = resultLines(cycle, results);
  const goal = goalCost(cycle);
  // A meta sem M: a comparação não muda com o switch.
  const goalNet = goal === null ? null : goal / cycle.multiplier;
  const basis = withM ? "com M" : "sem M";
  return (
    <dl className="campaign-results cost">
      {(["today", "yesterday", "cycle"] as const).map((key) => {
        const l = lines[key];
        const label = { today: "Hoje", yesterday: "Ontem", cycle: "Ciclo" }[key];
        if (!l || (l.spend <= 0 && l.conversions <= 0))
          return (
            <div key={key}>
              <dt>{label}</dt>
              <dd>—</dd>
            </div>
          );
        if (l.conversions <= 0)
          return (
            <div key={key}>
              <dt>{label}</dt>
              <dd
                className="bad"
                title={`Gastou ${money(withM ? l.spend * l.multiplier : l.spend)} (${basis}) sem nenhum resultado`}
              >
                Sem resultado
              </dd>
            </div>
          );
        const net = l.spend / l.conversions;
        const shown = withM ? net * l.multiplier : net;
        const diff = goalNet ? (net / goalNet - 1) * 100 : null;
        const tone = diff === null ? "" : diff <= 0 ? "good" : "bad";
        const hint =
          diff === null || goal === null
            ? `${money(shown)} por resultado (${basis}); o ciclo não tem meta de resultados`
            : `${money(shown)} por resultado (${basis}) · ${Math.abs(Math.round(diff))}% ${diff <= 0 ? "abaixo" : "acima"} da meta de ${money(withM ? goal : goalNet!)}`;
        return (
          <div key={key}>
            <dt>{label}</dt>
            <dd className={tone} title={hint}>
              {tone && (
                <span className="results-arrow" aria-hidden="true">
                  {tone === "good" ? "▼" : "▲"}
                </span>
              )}
              {money(shown)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * The list, a page at a time from the server (ad_campaign_page): by default
 * only active campaigns; the Status filter shows the new ones waiting for
 * their first activation, the inactive ones or all. Search, platform and
 * "precisam de atenção" are applied there too.
 */
function CampaignList({
  backend,
  company,
  today,
  canCreate,
  missing,
  tick,
  href,
  onOpen,
  onNew,
  onConnections,
  onAlerts,
  onMultiplierLog,
  crm,
  insights,
  demo,
}: {
  backend: CampaignsBackend;
  company: string;
  today: string;
  canCreate: boolean;
  missing: boolean;
  /** Changes after an edit elsewhere: read the page again. */
  tick: number;
  /** A campaign's own address (the row is a link: new tab, copy). */
  href: (id: string) => string;
  onOpen: (id: string) => void;
  onNew: () => void;
  /** Absent: read-only (no "Conexões"). */
  onConnections?: () => void;
  /** Meus avisos. */
  onAlerts: () => void;
  /** Alterações do M (administrators and managers). */
  onMultiplierLog?: () => void;
  /** Abrir no CRM, when the campaign's client is linked to the MakeCRM. */
  crm: (campaign: AdCampaign) => ReactNode;
  /** Insights da MAVI: o selo de cada campanha da página. */
  insights: InsightsBackend;
  demo: boolean;
}) {
  const [query, setQuery] = useUrlState<string>("busca", "");
  const [platform, setPlatform] = useUrlState<string>("plataforma", "");
  const [attention, setAttention] = useUrlState<boolean>("atencao", false);
  const [status, setStatus] = useUrlState<string>("status", "");
  const [withM, setWithM] = useWithM();
  // "Todas as campanhas" comes back to these filters.
  const location = useLocation();
  useEffect(() => {
    const [path, search = ""] = location.split("?");
    if (campaignIdFromPath(path)) return;
    const q = new URLSearchParams(search);
    q.delete("avisos");
    lastList = path + (q.toString() ? `?${q}` : "");
  }, [location]);
  // Money as the client contracted it (com M) or what the platform spends.
  const shown = (value: number, m: number) => money(withM ? value : value / m);
  const scope =
    statusFilters.find((f) => f.value === status)?.scope ?? "active";
  const pendingOnly = scope === "pending";
  const [typed, setTyped] = useState(query);
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<CampaignPage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const top = useRef<HTMLDivElement>(null);
  // Search after a pause in typing, not at every key.
  useEffect(() => {
    const t = setTimeout(() => setQuery(typed.trim()), 300);
    return () => clearTimeout(t);
  }, [typed, setQuery]);
  const filters = `${query}|${platform}|${attention}|${scope}`;
  useEffect(() => setPage(0), [filters]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    backend
      .page(company, {
        scope,
        search: query,
        platform,
        attention: attention && scope === "active",
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      })
      .then((r) => {
        if (!live) return;
        setResult(r);
        setError("");
      })
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [backend, company, query, platform, attention, scope, page, tick]);
  // Uma leitura nova de hoje (o leitor em 2º plano grava e avisa pelo
  // Realtime): a página se relê sem piscar. Várias contas de uma vez viram
  // uma releitura só.
  const silent = useRef({ scope, query, platform, attention, page });
  silent.current = { scope, query, platform, attention, page };
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reload = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const q = silent.current;
        backend
          .page(company, {
            scope: q.scope,
            search: q.query,
            platform: q.platform,
            attention: q.attention && q.scope === "active",
            limit: PAGE_SIZE,
            offset: q.page * PAGE_SIZE,
          })
          .then((r) => {
            // Os filtros mudaram enquanto relia: a releitura não vale mais.
            const now = silent.current;
            const same = (Object.keys(q) as (keyof typeof q)[]).every(
              (k) => now[k] === q[k],
            );
            if (same) setResult(r);
          })
          .catch(() => {});
      }, 1500);
    };
    window.addEventListener("mavi:campaign-today", reload);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mavi:campaign-today", reload);
    };
  }, [backend, company]);
  const now = Date.now();

  const rows = result?.rows ?? [];
  const total = result?.total ?? 0;
  // Os selos dos insights da página (desligados no Painel da MAVI: sem coluna).
  const [badges, setBadges] = useState<Map<string, InsightBadge> | null>(null);
  const pageIds = rows.map((r) => r.campaign.id).join(",");
  useEffect(() => {
    let live = true;
    const ids = pageIds ? pageIds.split(",") : [];
    insights
      .badges(company, ids)
      .then((b) => live && setBadges(b.badge ? new Map(b.rows.map((r) => [r.campaign, r])) : null))
      .catch(() => live && setBadges(null));
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ campaign?: string; status?: string }>).detail;
      if (d?.campaign && ids.includes(d.campaign) && d.status !== "queued")
        insights
          .badges(company, ids)
          .then((b) => live && setBadges(b.badge ? new Map(b.rows.map((r) => [r.campaign, r])) : null))
          .catch(() => {});
    };
    window.addEventListener("mavi:campaign-insights", on);
    return () => {
      live = false;
      window.removeEventListener("mavi:campaign-insights", on);
    };
  }, [insights, company, pageIds]);
  // A Leitura do dia da MAVI de cada campanha da página (desligada: sem nada).
  const daily = useMemo(() => (demo ? demoDaily() : serverDaily), [demo]);
  const [reads, setReads] = useState<{
    today: string;
    rows: Map<string, DailyRead>;
  } | null>(null);
  useEffect(() => {
    let live = true;
    const ids = pageIds ? pageIds.split(",") : [];
    const load = () =>
      daily
        .reads(company, ids)
        .then(
          (r) =>
            live &&
            setReads(
              r.enabled
                ? { today: r.today, rows: new Map(r.rows.map((x) => [x.campaign, x])) }
                : null,
            ),
        )
        .catch(() => live && setReads(null));
    void load();
    // Uma leitura nova (a MAVI gravou) chega pelo mesmo aviso dos insights.
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ campaign?: string; status?: string }>).detail;
      if (d?.status === "daily" && d.campaign && ids.includes(d.campaign)) void load();
    };
    window.addEventListener("mavi:campaign-insights", on);
    return () => {
      live = false;
      window.removeEventListener("mavi:campaign-insights", on);
    };
  }, [daily, company, pageIds]);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = !!(query || platform || (attention && scope === "active"));

  return (
    <>
      {demo && (
        <p className="campaign-demo-note">
          Demonstração: as campanhas ficam só na memória do navegador e somem ao
          recarregar.
        </p>
      )}
      {missing && (
        <div className="error-banner" role="alert">
          <TriangleAlert size={18} />
          <span>Campanha não encontrada ou sem acesso.</span>
        </div>
      )}
      <div className="section-top campaign-toolbar" ref={top}>
        <span>
          {result ? (
            <>
              {result.all} {scopeCount(scope, result.all)}
              {scope === "active" && result.attention > 0 && (
                <>
                  {" · "}
                  <button
                    type="button"
                    className={`campaign-attention ${attention ? "on" : ""}`}
                    aria-pressed={attention}
                    onClick={() => setAttention(!attention)}
                  >
                    <TriangleAlert size={13} /> {result.attention}{" "}
                    {result.attention === 1 ? "precisa" : "precisam"} de atenção
                  </button>
                </>
              )}
              {(pendingOnly || (scope === "active" && result.pending > 0)) && (
                <>
                  {" · "}
                  <button
                    type="button"
                    className={`campaign-attention pending ${pendingOnly ? "on" : ""}`}
                    aria-pressed={pendingOnly}
                    title="Campanhas criadas nos últimos 60 dias que ainda não foram ativadas"
                    onClick={() => setStatus(pendingOnly ? "" : "aguardando")}
                  >
                    {pendingOnly
                      ? "Voltar às ativas"
                      : `${result.pending} ${result.pending === 1 ? "aguardando" : "aguardando"} ativação`}
                  </button>
                </>
              )}
            </>
          ) : (
            "Campanhas"
          )}
        </span>
        <div className="campaign-filters">
          <span className="portfolio-search">
            <Input
              type="search"
              aria-label="Buscar campanha ou cliente"
              placeholder="Buscar campanha ou cliente"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              icon={Search}
            />
          </span>
          <Select value={status} onValueChange={setStatus} aria-label="Status">
            {statusFilters.map((f) => (
              <SelectOption key={f.value} value={f.value}>
                {f.label}
              </SelectOption>
            ))}
          </Select>
          <Select
            value={platform}
            onValueChange={setPlatform}
            aria-label="Plataforma"
          >
            <SelectOption value="">Todas as plataformas</SelectOption>
            {(Object.keys(platforms) as AdPlatform[]).map((p) => (
              <SelectOption key={p} value={p}>
                {platforms[p]}
              </SelectOption>
            ))}
          </Select>
          <button
            type="button"
            role="switch"
            aria-checked={withM}
            aria-label="Valores com M aplicado"
            className={`template-switch campaign-m-switch${withM ? " on" : ""}`}
            title={
              withM
                ? "Valores com M, como o cliente contratou e vê. Clique para ver sem M."
                : "Valores sem M: o que a plataforma gasta. Clique para ver com M."
            }
            onClick={() => setWithM(!withM)}
          >
            <span aria-hidden="true" />
            {withM ? "Com M aplicado" : "Sem M"}
          </button>
          <Button
            className="btn secondary"
            onClick={onAlerts}
            title="Avisos que você configura sobre os números das campanhas"
          >
            <BellRing size={16} /> Meus avisos
          </Button>
          {onMultiplierLog && (
            <Button
              className="btn secondary"
              onClick={onMultiplierLog}
              title="Todas as alterações do índice de performance (M), com quem, quando, de/para e o motivo"
            >
              <History size={16} /> Alterações do M
            </Button>
          )}
          {onConnections && (
            <Button
              className="btn secondary"
              onClick={onConnections}
              title="Conexões com o Facebook, o Google Ads e o MakeCRM"
            >
              <Plug size={16} /> Conexões
            </Button>
          )}
          {canCreate && (
            <Button className="btn primary" onClick={onNew}>
              <Plus size={17} /> Nova campanha
            </Button>
          )}
        </div>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          <TriangleAlert size={18} />
          <span>Não foi possível carregar as campanhas: {error}</span>
        </div>
      )}
      {!result && !error ? (
        <Loading variant="table" />
      ) : rows.length ? (
        <section
          className={`panel ${loading ? "campaign-loading" : ""}`}
          aria-busy={loading}
        >
          <div className="table-scroll">
            <table className="campaign-table campaign-list-table stack-mobile">
              <thead>
                <tr>
                  <th>Campanha</th>
                  <th>Plataforma</th>
                  <th>Status</th>
                  <th>Ciclo atual</th>
                  <th className="wrap">Verba do ciclo</th>
                  <th
                    className="wrap"
                    title="Mídia restante do ciclo ÷ dias restantes (hoje incluído): quanto a campanha deve gastar por dia para fechar a verba"
                  >
                    Orçamento diário
                  </th>
                  <th
                    className="wrap"
                    title="Hoje (ao vivo, parcial), ontem e o ciclo até ontem, pelas Conversões que contam de cada ciclo"
                  >
                    Resultados
                  </th>
                  <th
                    className="wrap"
                    title="Gasto ÷ resultados de hoje, ontem e do ciclo. Verde: na meta do ciclo ou abaixo; vermelho: acima"
                  >
                    Custo por resultado
                  </th>
                  <th className="wrap">Meta do ciclo</th>
                  <th title="Índice de performance">M</th>
                  {(badges || reads) && (
                    <th title="A Leitura do dia da MAVI (passe o mouse no ícone) e os insights abertos">
                      MAVI
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map(
                  ({
                    campaign,
                    client_name,
                    product_name,
                    current: cycle,
                    alert,
                    waiting,
                    spent,
                    results,
                    platform_budget,
                  }) => (
                    <tr
                      key={campaign.id}
                      className="campaign-row"
                      tabIndex={0}
                      onClick={(e) => {
                        // Ctrl/⌘ or Shift: another tab, as a link does.
                        if (e.metaKey || e.ctrlKey || e.shiftKey)
                          window.open(href(campaign.id), "_blank", "noopener");
                        else onOpen(campaign.id);
                      }}
                      onAuxClick={(e) => {
                        if (e.button === 1)
                          window.open(href(campaign.id), "_blank", "noopener");
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") onOpen(campaign.id);
                      }}
                    >
                      <td>
                        {/* A real link: "Abrir em nova aba", copy the link. */}
                        <a
                          className="campaign-name"
                          href={href(campaign.id)}
                          tabIndex={-1}
                          onClick={(e) => {
                            if (e.metaKey || e.ctrlKey || e.shiftKey)
                              e.stopPropagation();
                            else e.preventDefault();
                          }}
                          onAuxClick={(e) => e.stopPropagation()}
                        >
                          <strong>{campaign.name}</strong>
                        </a>
                        <small className="cell-note">
                          {client_name || "Cliente"} ·{" "}
                          {product_name || "Produto"}
                        </small>
                        {crm(campaign)}
                      </td>
                      <td data-label="Plataforma">
                        <PlatformLabel platform={campaign.platform} />
                      </td>
                      <td data-label="Status">
                        <StatusChip status={campaign.status} />
                      </td>
                      <td data-label="Ciclo atual" className="stack-full">
                        {cycle && (
                          <span className="campaign-period">
                            {shortDate(cycle.start_date)} a{" "}
                            {shortDate(cycle.end_date)}
                          </span>
                        )}
                        {/* An inactive one has no cycle alert. */}
                        {(campaign.status === "active" || waiting) && (
                          <AlertChip
                            alert={alert}
                            today={today}
                            cycle={cycle}
                          />
                        )}
                      </td>
                      <td data-label="Verba do ciclo">
                        {cycle ? shown(cycle.budget, cycle.multiplier) : "—"}
                      </td>
                      <td data-label="Orçamento diário">
                        <DailyBudget
                          cycle={cycle}
                          spent={spent}
                          today={today}
                          withM={withM}
                        />
                        <PlatformBudgetLine
                          campaign={campaign}
                          cycle={cycle}
                          spent={spent}
                          budget={platform_budget}
                          today={today}
                          demo={demo}
                        />
                      </td>
                      <td data-label="Resultados">
                        <ResultsCell cycle={cycle} results={results} now={now} />
                      </td>
                      <td data-label="Custo por resultado">
                        <CostCell cycle={cycle} results={results} withM={withM} />
                      </td>
                      <td data-label="Meta do ciclo">
                        {cycle ? (
                          <>
                            {cycle.goal_results}{" "}
                            {objectives[cycle.objective].result}
                            {goalCost(cycle) !== null && (
                              <small className="cell-note">
                                {shown(goalCost(cycle)!, cycle.multiplier)} por
                                resultado
                              </small>
                            )}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td data-label="M">
                        {cycle ? cycle.multiplier.toLocaleString("pt-BR") : "—"}
                      </td>
                      {(badges || reads) && (
                        <td data-label="MAVI">
                          <CampaignMaviCell
                            read={reads?.rows.get(campaign.id)}
                            badge={badges?.get(campaign.id)}
                            today={reads?.today || today}
                            onOpen={(insights) =>
                              navigate(
                                insights
                                  ? `${href(campaign.id)}?aba=insights`
                                  : href(campaign.id),
                              )
                            }
                          />
                        </td>
                      )}
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        !error && (
          <Empty
            title={
              filtered
                ? "Nenhuma campanha encontrada"
                : {
                    active: "Nenhuma campanha ativa",
                    pending: "Nenhuma campanha aguardando ativação",
                    inactive: "Nenhuma campanha inativa",
                    all: "Nenhuma campanha",
                  }[scope]
            }
            body={
              filtered
                ? "Confira a busca e os filtros."
                : pendingOnly
                  ? "Campanhas novas aparecem aqui até a primeira ativação."
                  : scope === "inactive"
                    ? "Campanhas inativadas aparecem aqui."
                    : canCreate
                      ? "Cadastre uma campanha de tráfego pago e o ciclo de verba dela; ao ativá-la, ela aparece aqui."
                      : "Aqui aparecem as campanhas ativas."
            }
            action={
              !filtered &&
              (scope === "active" || scope === "all") &&
              canCreate ? (
                <Button className="btn primary" onClick={onNew}>
                  <Plus size={17} /> Nova campanha
                </Button>
              ) : undefined
            }
          />
        )
      )}
      <Pagination
        page={Math.min(page, pageCount - 1)}
        pageCount={pageCount}
        pageSize={PAGE_SIZE}
        total={total}
        noun={total === 1 ? "campanha" : "campanhas"}
        onPage={setPage}
        disabled={loading}
        anchor={top}
      />
    </>
  );
}

/** "12 campanhas ativas", in the words of the Status filter. */
function scopeCount(scope: CampaignScope, n: number) {
  const one = n === 1;
  switch (scope) {
    case "pending":
      return one
        ? "campanha aguardando ativação"
        : "campanhas aguardando ativação";
    case "inactive":
      return one ? "campanha inativa" : "campanhas inativas";
    case "all":
      return one ? "campanha" : "campanhas";
    default:
      return one ? "campanha ativa" : "campanhas ativas";
  }
}

/* ------------------------------------------------------------------ */

function CampaignDetail({
  campaign,
  state,
  data,
  company,
  backend,
  platform,
  googlePlatform,
  reports,
  insights,
  user,
  onNewTask,
  today,
  eventsTick,
  notify,
  connectionTick,
  onPending,
  canEdit,
  demo,
  maviOpen,
  onMavi,
  onAlerts,
  crm,
  crmOpen,
  platformCrm,
  link,
  onBack,
  onEdit,
  onStatus,
  onNewCycle,
  onEditCycle,
  onMakeCurrent,
}: {
  campaign: AdCampaign;
  state: CampaignData;
  data: Snapshot;
  company: string;
  backend: CampaignsBackend;
  platform: PlatformBackend;
  googlePlatform: GooglePlatformBackend;
  reports: ReportsBackend;
  insights: InsightsBackend;
  user: string;
  onNewTask?: (preset: FormPreset) => void;
  today: string;
  eventsTick: number;
  notify: (message: string) => void;
  connectionTick: number;
  onPending: (id: string) => void;
  /** False: a collaborator's read-only view. */
  canEdit: boolean;
  demo: boolean;
  /** Conversar com a MAVI sobre esta campanha (painel à direita). */
  maviOpen: boolean;
  onMavi: (open: boolean) => void;
  /** Meus avisos, com os desta campanha primeiro. */
  onAlerts: () => void;
  /** Abrir no CRM (null: the client isn't linked to the MakeCRM). */
  crm: ReactNode;
  /** The same, as a function: "Abrir no CRM ▾" with the stages that matter (Insights da MAVI). */
  crmOpen: (() => Promise<void>) | null;
  /** Plataforma: the client's MakeCRM numbers (null: no client). */
  platformCrm: PlatformCrm | null;
  /** The campaign's own address, to share. */
  link: string;
  onBack: () => void;
  onEdit: () => void;
  onStatus: (to: AdCampaignStatus) => void;
  onNewCycle: () => void;
  onEditCycle: (cycle: AdCycle) => void;
  onMakeCurrent: (cycle: AdCycle) => void;
}) {
  const parts = contractParts(data, campaign.contract_id);
  const cycles = cyclesOf(state, campaign.id);
  // Insights da MAVI (Meta e Google): um carregamento para o painel e a aba.
  const insightsState = useCampaignInsights(insights, company, campaign.id);
  const insightsView = insightsState.view;
  const withInsights =
    (campaign.platform === "meta" || campaign.platform === "google") &&
    !!insightsView?.enabled;
  const insightsCtx = {
    campaign: { id: campaign.id, name: campaign.name, contract_id: campaign.contract_id },
    data,
    user,
    onNewTask,
    demo,
  };
  const current = currentCycle(state, campaign);
  const alert = cycleAlert(state, campaign, today);
  const [events, setEvents] = useState<AdCampaignEvent[] | null>(null);
  // Editing a record of the Linha do tempo adds to the history.
  const [editsTick, setEditsTick] = useState(0);
  // "Conversões do Google que contam" of a cycle, and the numbers' reload.
  const [conversions, setConversions] = useState<AdCycle | null>(null);
  const [metricsTick, setMetricsTick] = useState(0);
  useEffect(() => {
    let live = true;
    backend
      .events(company, campaign.id)
      .then((list) => live && setEvents(list))
      .catch(() => live && setEvents([]));
    return () => {
      live = false;
    };
  }, [backend, company, campaign.id, eventsTick, editsTick]);
  const suggestion =
    alert.kind === "ended" ||
    alert.kind === "ends_today" ||
    alert.kind === "ending"
      ? alert.next
      : alert.kind === "no_current"
        ? alert.suggestion
        : null;

  const alertsButton = (
    <>
      <Button
        className={`btn ${maviOpen ? "primary" : "secondary"}`}
        onClick={() => onMavi(!maviOpen)}
        title="Perguntar à MAVI sobre esta campanha (com a conta de anúncio ao vivo)"
      >
        <Sparkles size={15} /> Conversar com a MAVI
      </Button>
      <Button className="btn secondary" onClick={onAlerts} title="Avisos desta campanha (Meus avisos)">
        <BellRing size={15} /> Avisos
      </Button>
      <Button
        className="btn secondary"
        onClick={() =>
          void navigator.clipboard
            .writeText(link)
            .then(() => notify("Link da campanha copiado"))
            .catch(() => notify("Não foi possível copiar o link"))
        }
        title="Copiar o endereço desta campanha para abrir em outra aba ou compartilhar (abre para quem tem acesso a ela)"
      >
        <Link2 size={15} /> Copiar link
      </Button>
      {crmOpen && insightsView?.enabled ? (
        <CrmGoalControl
          openCrm={crmOpen}
          state={insightsState}
          backend={insights}
          company={company}
          campaign={campaign.id}
          notify={notify}
          ctx={insightsCtx}
        />
      ) : (
        crm
      )}
      {parts.client &&
        data.contracts.some(
          (k) =>
            k.client_id === parts.client!.id &&
            !k.archived &&
            isRqProduct(data.products.find((p) => p.id === k.product_id)?.name),
        ) && (
          <RqCampaignButton
            company={company}
            client={parts.client.id}
            clientName={parts.client.name}
            demo={demo}
            notify={notify}
          />
        )}
    </>
  );
  const actions = !canEdit ? (
    alertsButton
  ) : (
    <>
      {alertsButton}
      <Button className="btn secondary" onClick={onEdit}>
        <Pencil size={15} /> Editar
      </Button>
      {campaign.status === "active" ? (
        <Button className="btn secondary" onClick={() => onStatus("inactive")}>
          <CirclePause size={15} /> Inativar
        </Button>
      ) : (
        <Button
          className="btn primary"
          onClick={() => onStatus("active")}
          disabled={!current}
          title={current ? undefined : "Defina o ciclo atual antes de ativar"}
        >
          <CirclePlay size={15} /> Ativar
        </Button>
      )}
    </>
  );
  const alertBanner =
    alert.kind !== "none" ? (
      <div
        className={`campaign-alert ${alert.kind === "ended" ? "danger" : "warn"}`}
        role="status"
      >
        <CalendarClock size={18} />
        <span>
          {alert.kind === "no_cycle" &&
            "Esta campanha ainda não tem ciclo. Cadastre o primeiro para registrar a verba e a meta."}
          {alert.kind === "no_current" &&
            "Nenhum ciclo está marcado como atual. Escolha qual ciclo está valendo."}
          {alert.kind === "ended" &&
            `O ciclo atual terminou em ${shortDate(current!.end_date)} e não foi trocado. A troca é manual: ${
              suggestion
                ? "defina o próximo ciclo como atual."
                : "cadastre o próximo ciclo."
            }`}
          {alert.kind === "ends_today" &&
            (suggestion
              ? "O ciclo atual termina hoje. O próximo já está cadastrado; troque quando ele começar."
              : "O ciclo atual termina hoje e não há próximo ciclo cadastrado.")}
          {alert.kind === "ending" &&
            `O ciclo atual termina em ${alert.days} ${alert.days === 1 ? "dia" : "dias"} e não há próximo ciclo: é hora de cobrar o próximo investimento.`}
        </span>
        {canEdit && (
        <span className="campaign-alert-actions">
          {suggestion && suggestion.id !== current?.id && (
            <Button
              className="btn secondary"
              onClick={() => onMakeCurrent(suggestion)}
            >
              <Star size={15} /> Tornar atual:{" "}
              {shortDate(suggestion.start_date)} a{" "}
              {shortDate(suggestion.end_date)}
            </Button>
          )}
          {!suggestion && (
            <Button className="btn primary" onClick={onNewCycle}>
              <Plus size={15} /> Cadastrar{" "}
              {cycles.length ? "próximo" : "primeiro"} ciclo
            </Button>
          )}
        </span>
        )}
      </div>
    ) : null;
  // The client's media balance (Financeiro › Mídia), over the cycle's alert.
  const banner = (
    <>
      <CampaignMediaBalance
        backend={backend}
        campaign={campaign}
        current={current}
        today={today}
        refresh={`${eventsTick}:${cycles.map((y) => `${y.id}.${y.version}`).join()}`}
      />
      {/* As rotinas desta campanha que estão falhando (o mesmo de Avisos de falhas). */}
      <CampaignJobFailures
        company={company}
        campaign={campaign.id}
        demo={demo}
        timezone={insightsView?.timezone}
        insightsTab={withInsights && !!insightsView?.places.tab}
      />
      {alertBanner}
    </>
  );

  return (
    <div className={`campaign-detail${maviOpen ? " with-mavi" : ""}`}>
      {maviOpen && (
        <CampaignMavi
          company={company}
          campaign={campaign}
          client={parts.client?.id ?? null}
          clientName={parts.client?.name ?? ""}
          demo={demo}
          notify={notify}
          onClose={() => onMavi(false)}
        />
      )}
      <CampaignDayToDay
        back={
          <Button className="text-btn campaign-back" onClick={onBack}>
            <ArrowLeft size={16} /> Todas as campanhas
          </Button>
        }
        campaign={campaign}
        cycles={cycles}
        current={current}
        company={company}
        data={data}
        tags={
          <>
            <PlatformLabel platform={campaign.platform} />
            <StatusChip status={campaign.status} />
          </>
        }
        actions={actions}
        banner={banner}
        connection={
          canEdit &&
          campaign.platform === "meta" &&
          parts.client && (
            <ClientMetaConnection
              ads={backend.ads}
              company={company}
              client={parts.client}
              campaign={campaign.id}
              refresh={connectionTick}
              onPending={onPending}
              notify={notify}
            />
          )
        }
        metricsBackend={backend.metrics}
        reportsTab={
          (campaign.platform === "meta" || campaign.platform === "google") && (
            <CampaignReports
              company={company}
              campaign={campaign}
              cycles={cycles}
              current={current}
              today={today}
              backend={reports}
              clientName={parts.client?.name ?? ""}
              memberName={(id) =>
                data.members.find((m) => m.user_id === id)?.name ?? "—"
              }
              notify={notify}
            />
          )
        }
        platformTab={
          campaign.platform === "meta" || campaign.platform === "google" ? (
            // Os insights da MAVI na linha de cada item (sem eles, a Plataforma fica igual).
            <PlatformInsights
              state={insightsState}
              backend={insights}
              company={company}
              ctx={insightsCtx}
              notify={notify}
              platform={campaign.platform}
            >
              {campaign.platform === "meta" ? (
                <CampaignPlatform
                  company={company}
                  cycles={cycles}
                  current={current}
                  backend={platform}
                  today={today}
                  crm={platformCrm}
                />
              ) : (
                <GooglePlatform
                  company={company}
                  cycles={cycles}
                  current={current}
                  backend={googlePlatform}
                  today={today}
                  crm={platformCrm}
                />
              )}
            </PlatformInsights>
          ) : null
        }
        insightsTab={
          withInsights && insightsView?.places.tab ? (
            <CampaignInsightsTab
              state={insightsState}
              backend={insights}
              company={company}
              campaign={campaign.id}
              notify={notify}
              ctx={insightsCtx}
            />
          ) : undefined
        }
        insightsCount={insightsView?.current.length ?? 0}
        aside={
          withInsights ? (
            <CampaignInsightsAside
              state={insightsState}
              backend={insights}
              company={company}
              campaign={campaign.id}
              notify={notify}
              showTab={!!insightsView?.places.tab}
              ctx={insightsCtx}
            />
          ) : undefined
        }
        today={today}
        events={events}
        describeEvent={(e) => describeEvent(e, state)}
        notify={notify}
        onRecordEdited={() => setEditsTick((t) => t + 1)}
        onConversions={canEdit ? setConversions : undefined}
        readOnly={!canEdit}
        metricsTick={metricsTick}
        cyclesTab={
          <>
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Ciclos</h2>
                  <p>
                    Períodos de verba da campanha. O ciclo atual só muda quando
                    alguém troca.
                  </p>
                </div>
                {canEdit && (
                  <Button className="btn secondary" onClick={onNewCycle}>
                    <Plus size={15} /> Novo ciclo
                  </Button>
                )}
              </div>
              {cycles.length ? (
                <div className="table-scroll">
                  <table className="campaign-table stack-mobile">
                    <thead>
                      <tr>
                        <th>Período</th>
                        <th>Competência</th>
                        <th>Objetivo</th>
                        <th>Meta</th>
                        <th>Verba</th>
                        <th title="Índice de performance">M</th>
                        <th>Destino e vínculos</th>
                        <th>Situação</th>
                        <th aria-label="Ações" />
                      </tr>
                    </thead>
                    <tbody>
                      {[...cycles].reverse().map((y) => {
                        const isCurrent = y.id === campaign.current_cycle_id;
                        const s = cycleState(y, today);
                        return (
                          <tr
                            key={y.id}
                            className={isCurrent ? "campaign-current" : ""}
                          >
                            <td>
                              <strong>
                                {shortDate(y.start_date)} a{" "}
                                {shortDate(y.end_date)}
                              </strong>
                              <small className="cell-note">
                                {cycleDays(y)} dias
                              </small>
                              {turnover(cycles, y.start_date, y.end_date, y.id)
                                .before && (
                                <small
                                  className="cell-note"
                                  title="O ciclo começa no dia em que o anterior termina: o dia de virada, nas campanhas que estão nos dois ciclos, conta onde foi escolhido."
                                >
                                  {`Dia de virada ${shortDate(y.start_date).slice(0, 5)}: ${y.shared_day ? sharedDayLabels[y.shared_day] : "nos dois ciclos (sem escolha)"}`}
                                </small>
                              )}
                            </td>
                            <td data-label="Competência">
                              {monthLabel(y.competence_month)}
                            </td>
                            <td data-label="Objetivo">
                              {objectives[y.objective].label}
                            </td>
                            <td data-label="Meta">
                              {y.goal_results} {objectives[y.objective].result}
                              {goalCost(y) !== null && (
                                <small className="cell-note">
                                  {money(goalCost(y)!)} por resultado
                                </small>
                              )}
                            </td>
                            <td data-label="Verba">{money(y.budget)}</td>
                            <td data-label="M">
                              {y.multiplier.toLocaleString("pt-BR")}
                            </td>
                            <td
                              data-label="Destino e vínculos"
                              className="stack-full"
                            >
                              {destinations[y.destination]}
                              <small
                                className="cell-note"
                                title={y.links
                                  .map((l) => linkName(campaign.platform, l))
                                  .join("\n")}
                              >
                                <Link2 size={12} />{" "}
                                {y.links.length
                                  ? `${linkName(campaign.platform, y.links[0])}${y.links.length > 1 ? ` +${y.links.length - 1}` : ""}`
                                  : "Sem vínculo na plataforma"}
                                {y.landing_pages.length > 0 &&
                                  ` · LPs: ${y.landing_pages.join(", ")}`}
                              </small>
                            </td>
                            <td data-label="Situação">
                              {isCurrent && (
                                <span className="campaign-chip current">
                                  Atual
                                </span>
                              )}
                              <span
                                className={`campaign-chip ${s === "ended" ? "muted" : ""}`}
                              >
                                {cycleStates[s]}
                              </span>
                            </td>
                            <td className="campaign-row-actions">
                              {canEdit && !isCurrent && (
                                <Button
                                  className="text-btn"
                                  onClick={() => onMakeCurrent(y)}
                                  title="Definir como o ciclo que está valendo"
                                >
                                  <Star size={14} /> Tornar atual
                                </Button>
                              )}
                              {canEdit && (
                                <Button
                                  className="icon-btn"
                                  aria-label={`Editar ciclo de ${shortDate(y.start_date)} a ${shortDate(y.end_date)}`}
                                  title="Editar ciclo"
                                  onClick={() => onEditCycle(y)}
                                >
                                  <Pencil size={14} />
                                </Button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title="Nenhum ciclo"
                  body="O ciclo registra o período, a verba, o objetivo e a quantidade de resultados esperada."
                />
              )}
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>
                    <History size={17} /> Histórico
                  </h2>
                  <p>Quem cadastrou e alterou o quê, com antes e depois.</p>
                </div>
              </div>
              {events === null ? (
                <Loading compact />
              ) : events.length ? (
                <ol className="campaign-history">
                  {events.map((e) => (
                    <li key={e.id}>
                      <span className="campaign-history-when">
                        {new Date(e.created_at).toLocaleString("pt-BR", {
                          day: "2-digit",
                          month: "2-digit",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <span>
                        <strong>
                          {data.members.find((m) => m.user_id === e.actor_id)
                            ?.name ?? "Alguém"}
                        </strong>{" "}
                        {describeEvent(e, state)}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="muted campaign-history-empty">
                  Sem registros ainda.
                </p>
              )}
            </section>
          </>
        }
      />
      {conversions && campaign.platform === "meta" && (
        <MetaConversions
          ads={backend.ads}
          backend={backend}
          company={company}
          cycle={conversions}
          onClose={() => setConversions(null)}
          onSaved={async (message) => {
            // The cycle again, with the new choice (and its cumulatives).
            const result = await backend.metrics.sync(company, campaign.id);
            setConversions(null);
            setMetricsTick((t) => t + 1);
            setEditsTick((t) => t + 1);
            notify(
              result.errors.length
                ? `Escolha salva, mas a sincronização deu erro: ${result.errors[0].message}`
                : message,
            );
          }}
        />
      )}
      {conversions && campaign.platform === "google" && (
        <GoogleConversions
          ads={backend.ads}
          backend={backend}
          company={company}
          cycle={conversions}
          onClose={() => setConversions(null)}
          onSaved={async (message) => {
            // The whole cycle again, with the new choice.
            const result = await backend.metrics.sync(company, campaign.id);
            setConversions(null);
            setMetricsTick((t) => t + 1);
            setEditsTick((t) => t + 1);
            notify(
              result.errors.length
                ? `Escolha salva, mas a sincronização deu erro: ${result.errors[0].message}`
                : message,
            );
          }}
        />
      )}
    </div>
  );
}

const fieldLabels: Record<string, string> = {
  name: "nome",
  platform: "plataforma",
  briefing_url: "link do briefing",
  media_plan_url: "link do plano de mídia",
  notes: "observações",
  competence_month: "competência",
  start_date: "início",
  end_date: "término",
  objective: "objetivo",
  goal_results: "meta de resultados",
  budget: "verba",
  multiplier: "índice de performance (M)",
  destination: "destino",
  landing_pages: "páginas de captura",
  niche: "nicho",
  links: "vínculos na plataforma",
};
function show(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "vazio";
  if (field === "budget") return money(Number(value));
  if (field === "platform")
    return platforms[value as AdPlatform] ?? String(value);
  if (field === "objective")
    return objectives[value as AdObjective]?.label ?? String(value);
  if (field === "destination")
    return destinations[value as AdDestination] ?? String(value);
  if (field === "start_date" || field === "end_date")
    return shortDate(String(value));
  if (field === "competence_month") return monthLabel(String(value));
  if (field === "links") return `${(value as unknown[]).length} vínculo(s)`;
  if (Array.isArray(value)) return value.join(", ") || "vazio";
  if (field === "notes") return "texto alterado";
  if (field === "multiplier")
    return Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 3 });
  return String(value);
}
function describeEvent(e: AdCampaignEvent, state: CampaignData) {
  const d = e.detail as Record<string, unknown>;
  const period = (id: unknown) => {
    const y = state.cycles.find((c) => c.id === id);
    return y
      ? `${shortDate(y.start_date)} a ${shortDate(y.end_date)}`
      : "removido";
  };
  switch (e.action) {
    case "created":
      return "cadastrou a campanha.";
    case "status":
      return `${d.to === "active" ? "ativou" : "inativou"} a campanha. Motivo: ${String(d.reason ?? "")}`;
    case "current_cycle":
      return `definiu como atual o ciclo de ${period(d.to)}.`;
    case "media_override":
      return `liberou ${money(Number(d.shortfall))} acima do saldo de mídia no ciclo de ${period(e.cycle_id)} (disponível ${money(Number(d.available))}, o ciclo precisava de ${money(Number(d.need))}). Motivo: ${String(d.reason ?? "")}`;
    case "cycle_created":
      return `cadastrou o ciclo de ${shortDate(String(d.start_date))} a ${shortDate(String(d.end_date))} (${money(Number(d.budget))}, meta de ${d.goal_results}).`;
    case "shared_day": {
      const span = (y: unknown) => {
        const c = y as { start_date?: string; end_date?: string } | null;
        return c?.start_date && c.end_date
          ? `${shortDate(c.start_date)} a ${shortDate(c.end_date)}`
          : "removido";
      };
      const where = (v: unknown) =>
        sharedDayLabels[v as SharedDayChoice] ?? "nos dois ciclos";
      return `escolheu onde conta o dia de virada ${shortDate(String(d.day))}, entre o ciclo de ${span(d.earlier)} e o de ${span(d.later)}: ${where(d.to)}${d.from ? ` (antes: ${where(d.from)})` : ""}.`;
    }
    case "updated":
    case "cycle_updated": {
      const changes = Object.entries(
        d as Record<string, { from: unknown; to: unknown }>,
      )
        .map(
          ([f, c]) =>
            `${fieldLabels[f] ?? f}: ${show(f, c.from)} → ${show(f, c.to)}`,
        )
        .join("; ");
      return `${e.action === "updated" ? "alterou a campanha" : `alterou o ciclo de ${period(e.cycle_id)}`}${changes ? ` — ${changes}` : ""}.`;
    }
    case "multiplier_changed": {
      const n = Number(d.days ?? 0);
      const reached =
        d.kind === "new_cycle"
          ? ""
          : d.apply === "forward"
            ? `, de ${shortDate(String(d.since))} em diante`
            : d.apply === "range"
              ? `, nos dias de ${shortDate(String(d.apply_from))} a ${shortDate(String(d.apply_to))}`
              : ", em todos os dias do ciclo";
      const days =
        d.kind === "new_cycle"
          ? ""
          : ` (${n ? `${n} ${n === 1 ? "dia registrado mudou" : "dias registrados mudaram"}` : "nenhum dia registrado mudou"})`;
      const what =
        d.kind === "new_cycle"
          ? `cadastrou o ciclo de ${period(e.cycle_id)} com M diferente do anterior`
          : `alterou o M do ciclo de ${period(e.cycle_id)}`;
      return `${what}: ${show("multiplier", d.from)} → ${show("multiplier", d.to)}${reached}${days}. Motivo: ${String(d.reason ?? "")}`;
    }
    case "conversion_actions":
      return d.to
        ? `escolheu as conversões do Google que contam no ciclo de ${period(e.cycle_id)} (${(d.to as string[]).length} ${(d.to as string[]).length === 1 ? "ação" : "ações"}).`
        : `voltou as conversões do Google do ciclo de ${period(e.cycle_id)} para as categorias do objetivo.`;
    case "meta_conversions": {
      const actions = d.actions as string[] | null;
      const what = actions
        ? `escolheu as conversões do Meta que contam no ciclo de ${period(e.cycle_id)} (${actions.length} ${actions.length === 1 ? "tipo" : "tipos"})`
        : `voltou as conversões do Meta do ciclo de ${period(e.cycle_id)} para a regra do objetivo`;
      return d.mode === "forward"
        ? `${what}, a partir de ${shortDate(String(d.since))}; os dias anteriores ficaram como estavam.`
        : `${what}, recalculando o ciclo inteiro.`;
    }
    case "daily_edited":
    case "snapshot_edited": {
      const changes = Object.entries(
        (d.changes ?? {}) as Record<string, { from: unknown; to: unknown }>,
      )
        .map(
          ([f, c]) =>
            `${recordLabels[f] ?? f}: ${showRecord(f, c.from)} → ${showRecord(f, c.to)}`,
        )
        .join("; ");
      return `editou o registro ${e.action === "daily_edited" ? `diário de ${shortDate(String(d.day))}` : `de ${shortDate(String(d.taken_on))}`}${changes ? ` — ${changes}` : ""}.${d.reason ? ` Motivo do M: ${String(d.reason)}` : ""}`;
    }
    case "report_created":
      return `criou o relatório "${String(d.title ?? "")}" (${shortDate(String(d.start))} a ${shortDate(String(d.end))})${d.link ? ", com link público" : ""}.`;
    case "report_shared":
      return `${d.expires_at ? `ligou o link público do relatório "${String(d.title ?? "")}" até ${shortDate(String(d.expires_at))}` : `ligou o link público do relatório "${String(d.title ?? "")}"`}${d.password ? ", com senha" : ""}.`;
    case "report_unshared":
      return `desativou o link público do relatório "${String(d.title ?? "")}".`;
    case "report_deleted":
      return `excluiu o relatório "${String(d.title ?? "")}" (${shortDate(String(d.start))} a ${shortDate(String(d.end))}).`;
    default:
      return e.action;
  }
}
const recordLabels: Record<string, string> = {
  multiplier: "M",
  spend: "investimento (sem M)",
  impressions: "impressões",
  reach: "alcance",
  clicks: "cliques",
  conversions: "conversões",
  view_content: "vis. produto",
  add_to_cart: "add. carrinho",
  initiate_checkout: "fin. compra",
  period_end: "data final",
  goal_status: "status",
};
function showRecord(field: string, value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (field === "spend") return money(Number(value));
  if (field === "period_end") return shortDate(String(value));
  if (field === "goal_status")
    return value === "good" ? "Bom" : value === "bad" ? "Ruim" : String(value);
  return Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 3 });
}

/** A link as people read it: the campaign's name, or the account's. */
function linkName(platform: AdPlatform, l: AdCycleLink) {
  if (l.campaign_id) return l.campaign_name || `Campanha ${l.campaign_id}`;
  return `Conta ${l.account_name || accountLabel(platform, l.account_id)} (inteira)`;
}

/* ------------------------------------------------------------------ */

function CampaignForm({
  campaign,
  data,
  cycleCount,
  onClose,
  onSave,
}: {
  campaign?: AdCampaign;
  data: Snapshot;
  cycleCount: number;
  onClose: () => void;
  onSave: (input: {
    contract_id: string;
    name: string;
    platform: AdPlatform;
    briefing_url: string;
    media_plan_url: string;
    notes: string;
  }) => Promise<void>;
}) {
  const [contract, setContract] = useState(campaign?.contract_id ?? "");
  const [name, setName] = useState(campaign?.name ?? "");
  const [platform, setPlatform] = useState<AdPlatform>(
    campaign?.platform ?? "meta",
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (!contract) return setError("Escolha o cliente e o produto contratado.");
    if (name.trim().length < 2) return setError("Dê um nome à campanha.");
    setError("");
    setSaving(true);
    try {
      await onSave({
        contract_id: contract,
        name: name.trim(),
        platform,
        // No longer in the form: what a campaign had (the MASO's links) stays.
        briefing_url: campaign?.briefing_url ?? "",
        media_plan_url: campaign?.media_plan_url ?? "",
        notes: campaign?.notes ?? "",
      });
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }
  const platformLocked = !!campaign && cycleCount > 1;
  return (
    <Modal
      title={campaign ? "Editar campanha" : "Nova campanha"}
      onClose={() => !saving && onClose()}
      busy={saving}
    >
      <form className="entity-form" onSubmit={submit}>
        <fieldset className="create-fields" disabled={saving}>
          {campaign ? (
            <p className="campaign-form-context">
              {contractParts(data, campaign.contract_id).client?.name} ·{" "}
              {contractParts(data, campaign.contract_id).product?.name}
            </p>
          ) : (
            <ContractPicker
              data={data}
              contract={contract}
              onContractChange={setContract}
            />
          )}
          <label>
            Nome da campanha
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              minLength={2}
              maxLength={160}
              placeholder="Ex.: Motion · Meta · Mensagem"
            />
          </label>
          <label>
            Plataforma
            <Select
              value={platform}
              onValueChange={(v) => setPlatform(v as AdPlatform)}
              disabled={platformLocked}
            >
              {(Object.keys(platforms) as AdPlatform[]).map((p) => (
                <SelectOption key={p} value={p}>
                  {platforms[p]}
                </SelectOption>
              ))}
            </Select>
            {platformLocked && (
              <small>
                Com mais de um ciclo a plataforma não muda: cadastre uma nova
                campanha.
              </small>
            )}
          </label>
          {!campaign && (
            <small>
              A campanha nasce inativa. Depois dela você cadastra o ciclo
              (período, verba e meta) e ativa.
            </small>
          )}
          {error && <p className="form-error">{error}</p>}
        </fieldset>
        <div className="form-footer">
          <Button
            type="button"
            className="btn secondary"
            onClick={onClose}
            disabled={saving}
          >
            Cancelar
          </Button>
          <Button type="submit" className="btn primary" loading={saving}>
            {campaign ? "Salvar" : "Cadastrar campanha"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function CycleForm({
  campaign,
  cycle,
  first,
  state,
  today,
  company,
  ads,
  client,
  connectionTick,
  onPending,
  backend,
  calendar,
  onClose,
  onSave,
}: {
  campaign: AdCampaign;
  cycle?: AdCycle;
  first?: boolean;
  state: CampaignData;
  today: string;
  company: string;
  ads: CampaignsBackend["ads"];
  client: { id: string; name: string } | null;
  connectionTick: number;
  onPending: (id: string) => void;
  /** The client's media balance: the budget must fit it. */
  backend: CampaignsBackend;
  /** The company's days off: a cycle date off business days is warned. */
  calendar?: CalendarDay[];
  onClose: () => void;
  onSave: (
    input: CycleInput,
    makeCurrent: boolean,
    /** The reason to release a budget above the media balance. */
    override: string | null,
  ) => Promise<void>;
}) {
  const cycles = cyclesOf(state, campaign.id);
  const last = cycles[cycles.length - 1] ?? null;
  // A new cycle's links come from the latest cycle that has any.
  const linked = [...cycles].reverse().find((y) => y.links.length) ?? null;
  // Editing: the next cycle's choice, when this one ends on its first day.
  const after = cycle
    ? turnover(cycles, cycle.start_date, cycle.end_date, cycle.id).after
    : null;
  const [draft, setDraft] = useState<CycleDraft>(() =>
    cycle
      ? { ...cycleDraft(cycle), shared_end: after?.shared_day ?? "" }
      : nextCycleDraft(last, today, linked),
  );
  // The turnover days of the period: asked when the shared day is new (an
  // imported cycle that already shared it keeps counting in both).
  const shared = turnover(cycles, draft.start_date, draft.end_date, cycle?.id);
  const askStart =
    !!shared.before && (!cycle || draft.start_date !== cycle.start_date);
  const askEnd =
    !!shared.after && (!cycle || draft.end_date !== cycle.end_date);
  const setStart = (start: string) =>
    setDraft((d) => ({
      ...d,
      start_date: start,
      competence: d.competence || start.slice(0, 7),
      // Another turnover day: chosen again.
      shared_start:
        cycle && start === cycle.start_date ? (cycle.shared_day ?? "") : "",
    }));
  const setEnd = (end: string) =>
    setDraft((d) => ({
      ...d,
      end_date: end,
      shared_end:
        cycle && end === cycle.end_date ? (after?.shared_day ?? "") : "",
    }));
  const [makeCurrent, setMakeCurrent] = useState(
    !cycle && !campaign.current_cycle_id,
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // Read fresh on opening: the budget must fit the media available.
  const media = useMediaRoom(backend, campaign, null);
  const [release, setRelease] = useState("");
  const set = <K extends keyof CycleDraft>(key: K, value: CycleDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  // The M changed (from the cycle's or, in a new one, the previous cycle's):
  // a reason and, editing, which registered days take it.
  const baseM = cycle ? cycle.multiplier : (last?.multiplier ?? null);
  const typedM = parseAmount(draft.multiplier);
  const mChanged =
    baseM !== null && Number.isFinite(typedM) && !sameMultiplier(typedM, baseM);
  const [mReason, setMReason] = useState("");
  const [mReasonMissing, setMReasonMissing] = useState(false);
  // "Só daqui para frente" comes chosen: it is the recommended one.
  const [mApply, setMApply] = useState<MultiplierApply | null>("forward");
  const [mRange, setMRange] = useState({ from: "", to: "" });
  const impact = useMultiplierImpact(
    backend.multiplier,
    cycle?.id ?? null,
    typedM,
    mApply === "range" ? mRange.from : "",
    mApply === "range" ? mRange.to : "",
    !!cycle && mChanged,
  );
  const budget = parseAmount(draft.budget),
    goal = Number(draft.goal_results);
  const days =
    draft.start_date && draft.end_date && draft.end_date >= draft.start_date
      ? cycleDays({ start_date: draft.start_date, end_date: draft.end_date })
      : null;
  const cost =
    Number.isFinite(budget) && Number.isInteger(goal) && draft.goal_results
      ? goalCost({ budget, goal_results: goal })
      : null;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    const result = cycleInput(draft, cycle ? cycle.multiplier : null);
    if ("error" in result) return setError(result.error);
    const registered = impact.impact?.registered ?? 0;
    if (mChanged) {
      if (!mReason.trim()) {
        setMReasonMissing(true);
        document.getElementById("multiplier-reason")?.focus();
        return setError("Informe o motivo da alteração do M (obrigatório).");
      }
      if (cycle && impact.loading)
        return setError("Aguarde: conferindo os dias já registrados do ciclo.");
      if (cycle && registered && !mApply)
        return setError("Escolha a quais dias já registrados o novo M se aplica.");
      if (
        cycle &&
        registered &&
        mApply === "range" &&
        (!mRange.from || !mRange.to || mRange.from > mRange.to)
      )
        return setError("Informe o período em que o novo M se aplica.");
    }
    if ((askStart && !draft.shared_start) || (askEnd && !draft.shared_end))
      return setError(
        `Escolha em qual ciclo conta o dia de virada (${shortDate(askStart && !draft.shared_start ? draft.start_date : draft.end_date)}).`,
      );
    const input: CycleInput = {
      ...result.input,
      shared_start: shared.before ? result.input.shared_start : null,
      shared_end: shared.after ? result.input.shared_end : null,
      multiplier_change: mChanged
        ? {
            reason: mReason.trim(),
            apply: cycle ? (registered ? mApply : "all") : null,
            from: mRange.from || null,
            to: mRange.to || null,
          }
        : null,
    };
    const blocked = cycleMediaBlocked(
      media.room,
      cycle ?? null,
      input.end_date,
      input.budget,
      today,
      release,
    );
    if (blocked)
      return setError(
        "A verba não cabe no saldo de mídia do cliente. Veja o que falta logo abaixo da verba.",
      );
    setError("");
    setSaving(true);
    try {
      await onSave(input, makeCurrent, release.trim() || null);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }
  const result = objectives[draft.objective].result;
  const mediaBlocked = cycleMediaBlocked(
    media.room,
    cycle ?? null,
    draft.end_date,
    budget,
    today,
    release,
  );
  return (
    <Modal
      title={
        cycle
          ? "Editar ciclo"
          : first
            ? "Primeiro ciclo da campanha"
            : "Novo ciclo"
      }
      onClose={() => !saving && onClose()}
      busy={saving}
      wide
    >
      <form className="entity-form campaign-cycle-form" onSubmit={submit}>
        <p className="campaign-form-context">
          {campaign.name} · {platforms[campaign.platform]}
          {!cycle &&
            last &&
            ` · continua o ciclo de ${shortDate(last.start_date)} a ${shortDate(last.end_date)}`}
        </p>
        {!cycle && last && (
          <p className="campaign-copied" role="status">
            Objetivo, meta, verba, M, destino
            {draft.links.length ? ", contas e campanhas marcadas" : ""} vieram
            do ciclo anterior
            {linked && linked !== last && draft.links.length
              ? ` (os vínculos, do ciclo de ${shortDate(linked.start_date)} a ${shortDate(linked.end_date)})`
              : ""}
            .
            {campaign.platform === "meta" &&
              " Os formulários do Facebook integrados ao cliente continuam valendo."}{" "}
            Confira e ajuste o que mudou.
          </p>
        )}
        <fieldset className="create-fields" disabled={saving}>
          <div className="form-columns campaign-three">
            <label>
              Início
              <Input
                type="date"
                value={draft.start_date}
                onChange={(e) => setStart(e.target.value)}
                required
              />
            </label>
            <label>
              Término
              <Input
                type="date"
                value={draft.end_date}
                min={draft.start_date}
                onChange={(e) => setEnd(e.target.value)}
                required
              />
            </label>
            <label>
              Competência
              <Input
                type="month"
                value={draft.competence}
                onChange={(e) => set("competence", e.target.value)}
                required
              />
            </label>
          </div>
          <small>
            {days !== null ? `${days} dias de ciclo. ` : ""}O fim do ciclo é
            quando o próximo investimento precisa entrar.
          </small>
          <CycleDaysOff
            calendar={calendar}
            start={draft.start_date}
            end={draft.end_date}
            onStart={setStart}
            onEnd={setEnd}
          />
          {!cycle && last && draft.start_date === addDays(last.end_date, 1) && (
            <Button
              type="button"
              className="text-btn campaign-same-day"
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  start_date: last.end_date,
                  end_date: monthlyEnd(last.end_date),
                  shared_start: "",
                }))
              }
            >
              <CalendarClock size={14} /> Começar em{" "}
              {shortDate(last.end_date)}, no dia em que o ciclo anterior
              termina
            </Button>
          )}
          {shared.before && (
            <SharedDayPicker
              day={draft.start_date}
              earlier={shared.before}
              later={{ start_date: draft.start_date, end_date: draft.end_date }}
              own="later"
              value={draft.shared_start}
              asked={askStart}
              onChange={(v) => set("shared_start", v)}
            />
          )}
          {shared.after && (
            <SharedDayPicker
              day={draft.end_date}
              earlier={{ start_date: draft.start_date, end_date: draft.end_date }}
              later={shared.after}
              own="earlier"
              value={draft.shared_end}
              asked={askEnd}
              onChange={(v) => set("shared_end", v)}
            />
          )}
          <div className="form-columns campaign-three">
            <label>
              Objetivo
              <Select
                value={draft.objective}
                onValueChange={(v) => set("objective", v as AdObjective)}
              >
                {(Object.keys(objectives) as AdObjective[]).map((o) => (
                  <SelectOption key={o} value={o}>
                    {objectives[o].label}
                  </SelectOption>
                ))}
              </Select>
            </label>
            <label>
              Meta de resultados ({result})
              <Input
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                value={draft.goal_results}
                onChange={(e) => set("goal_results", e.target.value)}
                placeholder="Ex.: 100"
                required
              />
            </label>
            <label>
              Verba do ciclo (R$)
              <Input
                inputMode="decimal"
                value={draft.budget}
                onChange={(e) => set("budget", e.target.value)}
                placeholder="Ex.: 3000,00"
                required
              />
            </label>
          </div>
          <small>
            {cost !== null
              ? `Meta de custo por resultado: ${money(cost)} (verba ÷ quantidade esperada).`
              : "Com a verba e a meta, calculamos o custo esperado por resultado."}
          </small>
          <CycleMediaFit
            room={media.room}
            error={media.error}
            cycle={cycle ?? null}
            endDate={draft.end_date}
            budget={budget}
            today={today}
            reason={release}
            onReason={setRelease}
            onUseAvailable={(value) =>
              set(
                "budget",
                value.toLocaleString("pt-BR", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                }),
              )
            }
          />
          <label className="campaign-narrow">
            Índice de performance (M)
            <Input
              inputMode="decimal"
              value={draft.multiplier}
              onChange={(e) => set("multiplier", e.target.value)}
            />
            <small>
              No mínimo 1. Vem do ciclo anterior; altere quando o índice da
              operação mudar (pede o motivo).
            </small>
          </label>
          {mChanged && baseM !== null && (
            <MultiplierChangeFields
              previous={baseM}
              next={typedM}
              newCycle={!cycle}
              cycleStart={draft.start_date}
              cycleEnd={draft.end_date}
              reason={mReason}
              onReason={setMReason}
              reasonMissing={mReasonMissing}
              apply={mApply}
              onApply={setMApply}
              from={mRange.from}
              to={mRange.to}
              onRange={(from, to) => setMRange({ from, to })}
              impact={impact}
            />
          )}
          <div className="form-columns">
            <label>
              Destino dos anúncios
              <Select
                value={draft.destination}
                onValueChange={(v) => set("destination", v as AdDestination)}
              >
                {(Object.keys(destinations) as AdDestination[]).map((d) => (
                  <SelectOption key={d} value={d}>
                    {destinations[d]}
                  </SelectOption>
                ))}
              </Select>
            </label>
            <label>
              Nicho de mercado
              <Input
                value={draft.niche}
                onChange={(e) => set("niche", e.target.value)}
                maxLength={120}
                placeholder="Ex.: Suplementos"
              />
            </label>
          </div>
          {draft.destination === "make_landing_page" && (
            <label>
              Páginas de captura da Make
              <Input
                value={draft.landing_pages}
                onChange={(e) => set("landing_pages", e.target.value)}
                placeholder="IDs separados por vírgula"
                required
              />
            </label>
          )}
          <CycleLinks
            platform={campaign.platform}
            company={company}
            ads={ads}
            client={client}
            campaign={campaign.id}
            refresh={connectionTick}
            onPending={onPending}
            landingPages={
              draft.destination === "make_landing_page"
                ? splitList(draft.landing_pages)
                : []
            }
            links={draft.links}
            onChange={(links) => set("links", links)}
          />
          {!cycle && (
            <label className="checkbox-label">
              <Checkbox
                checked={makeCurrent}
                onCheckedChange={(v) => setMakeCurrent(v === true)}
              />
              <span>
                Tornar este o ciclo atual
                {campaign.current_cycle_id && (
                  <small>
                    {" "}
                    — substitui o ciclo atual agora; deixe desmarcado para
                    trocar depois
                  </small>
                )}
              </span>
            </label>
          )}
          {error && <p className="form-error">{error}</p>}
        </fieldset>
        <div className="form-footer">
          <Button
            type="button"
            className="btn secondary"
            onClick={onClose}
            disabled={saving}
          >
            {first ? "Depois" : "Cancelar"}
          </Button>
          <Button
            type="submit"
            className="btn primary"
            loading={saving}
            disabled={mediaBlocked}
            title={
              mediaBlocked
                ? "A verba precisa caber no saldo de mídia do cliente"
                : undefined
            }
          >
            {cycle ? "Salvar ciclo" : "Cadastrar ciclo"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * A cycle date on a weekend, holiday or company day off: a highlighted
 * recommendation (it doesn't block) to move it to the business day before
 * or after, so the budget's consumption is followed when the cycle turns.
 */
function CycleDaysOff({
  calendar,
  start,
  end,
  onStart,
  onEnd,
}: {
  calendar?: CalendarDay[];
  start: string;
  end: string;
  onStart: (day: string) => void;
  onEnd: (day: string) => void;
}) {
  const dates = (
    [
      ["O início", start, onStart],
      ["O término", end, onEnd],
    ] as const
  ).flatMap(([label, day, change]) => {
    const why = dayOffReason(calendar, day);
    return why ? [{ label, day, change, why }] : [];
  });
  if (!dates.length) return null;
  return (
    <div className="campaign-days-off" role="alert">
      <TriangleAlert size={18} />
      <div>
        <strong>
          {dates.length > 1
            ? "O início e o término caem fora de dia útil"
            : `${dates[0].label} cai fora de dia útil`}
        </strong>
        <p>
          É recomendado mudar para um dia de semana (dia útil) para não termos
          problema de consumo: na virada do ciclo, alguém precisa acompanhar a
          verba entrando e o orçamento na plataforma.
        </p>
        {dates.map(({ label, day, change, why }) => {
          const around = businessDaysAround(calendar, day);
          return (
            <div key={label} className="campaign-days-off-row">
              <span>
                {label}: {weekdayDate(day)} — {why}.
              </span>
              <Button
                type="button"
                className="btn secondary"
                onClick={() => change(around.before)}
              >
                Usar {weekdayDate(around.before)}
              </Button>
              <Button
                type="button"
                className="btn secondary"
                onClick={() => change(around.after)}
              >
                Usar {weekdayDate(around.after)}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Where a turnover day counts (migration 20270301090000): explained with an
 * example, the recommended choice first, saved in the campaign's history.
 */
function SharedDayPicker({
  day,
  earlier,
  later,
  own,
  value,
  asked,
  onChange,
}: {
  day: string;
  earlier: Pick<AdCycle, "start_date" | "end_date">;
  later: Pick<AdCycle, "start_date" | "end_date">;
  /** Which of the two is the cycle in the form. */
  own: "earlier" | "later";
  value: SharedDayChoice | "";
  /** The shared day is new: a choice is needed to save. */
  asked: boolean;
  onChange: (value: SharedDayChoice) => void;
}) {
  const span = (y: Pick<AdCycle, "start_date" | "end_date">, mine: boolean) =>
    `${mine ? "este ciclo" : "o ciclo"} (${shortDate(y.start_date).slice(0, 5)} a ${shortDate(y.end_date).slice(0, 5)})`;
  const ending = span(earlier, own === "earlier"),
    starting = span(later, own === "later");
  const d = shortDate(day).slice(0, 5);
  const next = shortDate(addDays(day, 1)).slice(0, 5);
  const options: [SharedDayChoice, string, string][] = [
    [
      "later",
      "No ciclo novo (recomendado)",
      `Os R$ 200 e os 10 resultados entram em ${starting}. ${ending.charAt(0).toUpperCase()}${ending.slice(1)} deixa de contar esse dia só nas campanhas que estão nos dois; as que estão só nele continuam contando lá.`,
    ],
    [
      "earlier",
      "No ciclo que termina",
      `Os R$ 200 e os 10 resultados ficam em ${ending}. ${starting.charAt(0).toUpperCase()}${starting.slice(1)} começa a contar essas campanhas em ${next}.`,
    ],
    [
      "both",
      "Nos dois ciclos",
      `Cada ciclo mostra os R$ 200 e os 10 resultados: a campanha soma R$ 400 nesse dia, e o saldo de mídia (Financeiro › Mídia) é debitado duas vezes.`,
    ],
  ];
  return (
    <fieldset
      className={`campaign-shared-day${asked && !value ? " warn" : ""}`}
    >
      <legend>
        <CalendarClock size={15} /> Dia de virada: {shortDate(day)}
      </legend>
      <p>
        {d} é o último dia de {ending} e o primeiro de {starting}. Nas
        campanhas da plataforma marcadas nos dois ciclos, o gasto e os
        resultados desse dia contariam duas vezes — nos números do ciclo, nos
        relatórios e no saldo de mídia. Escolha onde o dia conta.
      </p>
      <p className="campaign-shared-example">
        Exemplo: uma campanha que está nos dois ciclos gastou R$ 200 e trouxe
        10 resultados em {d}.
      </p>
      <div
        className="campaign-shared-options"
        role="radiogroup"
        aria-label={`Onde conta ${d}`}
      >
        {options.map(([choice, label, hint]) => (
          <label key={choice} className="share-toggle">
            <input
              type="radio"
              name={`shared-${day}`}
              checked={value === choice}
              onChange={() => onChange(choice)}
            />
            <span>
              <strong>{label}</strong>
              <small>{hint}</small>
            </span>
          </label>
        ))}
      </div>
      <small>
        {!asked && !value
          ? "Sem escolha (ciclos importados do MASO): o dia conta nos dois. Escolha para corrigir. "
          : ""}
        Boa prática: contar no ciclo novo — o dia de virada costuma ser quando
        a verba nova entra, e assim nada conta duas vezes. A escolha fica no
        histórico da campanha e pode ser trocada editando o ciclo.
      </small>
    </fieldset>
  );
}

function StatusForm({
  campaign,
  to,
  onClose,
  onSave,
}: {
  campaign: AdCampaign;
  to: AdCampaignStatus;
  onClose: () => void;
  onSave: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (reason.trim().length < 3) return setError("Informe o motivo.");
    setError("");
    setSaving(true);
    try {
      await onSave(reason.trim());
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }
  return (
    <Modal
      title={to === "active" ? "Ativar campanha" : "Inativar campanha"}
      onClose={() => !saving && onClose()}
      busy={saving}
    >
      <form className="entity-form" onSubmit={submit}>
        <p className="campaign-form-context">{campaign.name}</p>
        <label>
          Motivo
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            required
            placeholder={
              to === "active"
                ? "Ex.: ciclo de setembro aprovado"
                : "Ex.: cliente pausou o investimento"
            }
          />
          <small>Fica registrado no histórico da campanha.</small>
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="form-footer">
          <Button
            type="button"
            className="btn secondary"
            onClick={onClose}
            disabled={saving}
          >
            Cancelar
          </Button>
          <Button type="submit" className="btn primary" loading={saving}>
            {to === "active" ? "Ativar" : "Inativar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

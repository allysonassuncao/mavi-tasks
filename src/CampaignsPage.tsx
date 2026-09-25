import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowLeft,
  CalendarClock,
  CirclePause,
  CirclePlay,
  History,
  Link2,
  Pencil,
  Plug,
  Plus,
  Search,
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
import { Pagination } from "./Pagination";
import { ContractPicker } from "./ContractPicker";
import { contractParts, dateKey } from "./domain";
import { useUrlState } from "./router";
import type { Snapshot } from "./types";
import {
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
  daysLeft,
  destinations,
  goalCost,
  monthLabel,
  money,
  parseAmount,
  nextCycleDraft,
  objectives,
  platforms,
  shortDate,
  supabaseCampaigns,
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
  type CampaignsBackend,
  type CycleAlert,
  type CycleDraft,
  type CycleInput,
} from "./campaigns";
import { demoCampaigns } from "./campaigns-demo";
import {
  AdConnections,
  ClientMetaConnection,
  CycleLinks,
  MetaAccountChooser,
  accountLabel,
} from "./CampaignLinks";
import { CampaignDayToDay } from "./CampaignDayToDay";

type Props = {
  demo: boolean;
  /** Already limited to the clients the person may see. */
  data: Snapshot;
  company: string;
  user: string;
  notify: (message: string) => void;
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
 * Campanhas: cadastro de campanhas (por produto contratado) e de seus ciclos.
 * Módulo de administradores e gestores (App só o abre para eles, e o banco
 * repete a regra).
 * A troca do ciclo atual é sempre manual; a tela só aponta quando o ciclo
 * atual terminou ou quando o próximo investimento precisa entrar.
 */
export function CampaignsPage({ demo, data, company, user, notify }: Props) {
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
  const [loadError, setLoadError] = useState("");
  const [listTick, setListTick] = useState(0);
  const [selected, setSelected] = useUrlState<string>("campanha", "");
  // The detail's own state (CampaignDayToDay), dropped on leaving it.
  const [, setTab] = useUrlState<string>("aba", "");
  const [, setViewedCycle] = useUrlState<string>("ciclo", "");
  const [, setTimelineTab] = useUrlState<string>("linha", "");
  const [campaignForm, setCampaignForm] = useState<CampaignFormState>(null);
  const [cycleForm, setCycleForm] = useState<CycleFormState>(null);
  const [statusForm, setStatusForm] = useState<StatusFormState>(null);
  const [connections, setConnections] = useState(false);
  const [eventsTick, setEventsTick] = useState(0);
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

  const canCreate = data.contracts.some((k) => !k.archived);
  const campaign = state.campaigns.find((c) => c.id === selected);

  return (
    <>
      {selected && !loaded ? (
        <Loading compact />
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
          today={today}
          eventsTick={eventsTick}
          notify={notify}
          connectionTick={connectionTick}
          onPending={setPending}
          onBack={() => {
            setTab("");
            setViewedCycle("");
            setTimelineTab("");
            setSelected("");
          }}
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
          onOpen={(id) => setSelected(id)}
          onNew={() => setCampaignForm({})}
          onConnections={() => setConnections(true)}
          demo={demo}
        />
      )}
      {campaignForm && (
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
            setSelected(id);
            const [created] = (await backend.campaign(company, id)).campaigns;
            if (created) setCycleForm({ campaign: created, first: true });
          }}
        />
      )}
      {cycleForm && (
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
          onSave={async (input, makeCurrent) => {
            if (cycleForm.cycle) {
              await backend.updateCycle(cycleForm.cycle, input);
              setCycleForm(null);
              await afterChange("Ciclo atualizado");
            } else {
              await backend.createCycle(cycleForm.campaign, input, makeCurrent);
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
      {connections && (
        <AdConnections
          company={company}
          ads={backend.ads}
          onClose={() => setConnections(false)}
          notify={notify}
          onOpenCampaign={(id) => {
            setConnections(false);
            setSelected(id);
          }}
          onPending={setPending}
          refresh={connectionTick}
        />
      )}
      {pending && (
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
      {statusForm && (
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

/**
 * The list, a page at a time from the server (ad_campaign_page): only active
 * campaigns, or the new ones waiting for their first activation. Search,
 * platform and "precisam de atenção" are applied there too.
 */
function CampaignList({
  backend,
  company,
  today,
  canCreate,
  missing,
  tick,
  onOpen,
  onNew,
  onConnections,
  demo,
}: {
  backend: CampaignsBackend;
  company: string;
  today: string;
  canCreate: boolean;
  missing: boolean;
  /** Changes after an edit elsewhere: read the page again. */
  tick: number;
  onOpen: (id: string) => void;
  onNew: () => void;
  onConnections: () => void;
  demo: boolean;
}) {
  const [query, setQuery] = useUrlState<string>("busca", "");
  const [platform, setPlatform] = useUrlState<string>("plataforma", "");
  const [attention, setAttention] = useUrlState<boolean>("atencao", false);
  const [pendingOnly, setPendingOnly] = useUrlState<boolean>(
    "aguardando",
    false,
  );
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
  const filters = `${query}|${platform}|${attention}|${pendingOnly}`;
  useEffect(() => setPage(0), [filters]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    backend
      .page(company, {
        scope: pendingOnly ? "pending" : "active",
        search: query,
        platform,
        attention: attention && !pendingOnly,
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
  }, [backend, company, query, platform, attention, pendingOnly, page, tick]);

  const rows = result?.rows ?? [];
  const total = result?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = !!(query || platform || attention);

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
              {pendingOnly ? (
                <>
                  {result.all}{" "}
                  {result.all === 1
                    ? "campanha aguardando ativação"
                    : "campanhas aguardando ativação"}
                </>
              ) : (
                <>
                  {result.all}{" "}
                  {result.all === 1 ? "campanha ativa" : "campanhas ativas"}
                </>
              )}
              {!pendingOnly && result.attention > 0 && (
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
              {(pendingOnly || result.pending > 0) && (
                <>
                  {" · "}
                  <button
                    type="button"
                    className={`campaign-attention pending ${pendingOnly ? "on" : ""}`}
                    aria-pressed={pendingOnly}
                    title="Campanhas criadas nos últimos 60 dias que ainda não foram ativadas"
                    onClick={() => setPendingOnly(!pendingOnly)}
                  >
                    {pendingOnly
                      ? "Voltar às ativas"
                      : `${result.pending} ${result.pending === 1 ? "aguardando" : "aguardando"} ativação`}
                  </button>
                </>
              )}
            </>
          ) : (
            "Campanhas ativas"
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
          <Button
            className="btn secondary"
            onClick={onConnections}
            title="Conexões com o Facebook e o Google Ads"
          >
            <Plug size={16} /> Conexões
          </Button>
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
        <Loading compact />
      ) : rows.length ? (
        <section
          className={`panel ${loading ? "campaign-loading" : ""}`}
          aria-busy={loading}
        >
          <div className="table-scroll">
            <table className="campaign-table">
              <thead>
                <tr>
                  <th>Campanha</th>
                  <th>Plataforma</th>
                  <th>Status</th>
                  <th>Ciclo atual</th>
                  <th>Verba do ciclo</th>
                  <th>Meta do ciclo</th>
                  <th title="Índice de performance">M</th>
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
                  }) => (
                    <tr
                      key={campaign.id}
                      className="campaign-row"
                      tabIndex={0}
                      onClick={() => onOpen(campaign.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") onOpen(campaign.id);
                      }}
                    >
                      <td>
                        <strong className="campaign-name">
                          {campaign.name}
                        </strong>
                        <small className="cell-note">
                          {client_name || "Cliente"} ·{" "}
                          {product_name || "Produto"}
                        </small>
                      </td>
                      <td>
                        <PlatformLabel platform={campaign.platform} />
                      </td>
                      <td>
                        <StatusChip status={campaign.status} />
                      </td>
                      <td>
                        {cycle && (
                          <span className="campaign-period">
                            {shortDate(cycle.start_date)} a{" "}
                            {shortDate(cycle.end_date)}
                          </span>
                        )}
                        <AlertChip alert={alert} today={today} cycle={cycle} />
                      </td>
                      <td>{cycle ? money(cycle.budget) : "—"}</td>
                      <td>
                        {cycle ? (
                          <>
                            {cycle.goal_results}{" "}
                            {objectives[cycle.objective].result}
                            {goalCost(cycle) !== null && (
                              <small className="cell-note">
                                {money(goalCost(cycle)!)} por resultado
                              </small>
                            )}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        {cycle ? cycle.multiplier.toLocaleString("pt-BR") : "—"}
                      </td>
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
                : pendingOnly
                  ? "Nenhuma campanha aguardando ativação"
                  : "Nenhuma campanha ativa"
            }
            body={
              filtered
                ? "Confira a busca e os filtros."
                : pendingOnly
                  ? "Campanhas novas aparecem aqui até a primeira ativação."
                  : canCreate
                    ? "Cadastre uma campanha de tráfego pago e o ciclo de verba dela; ao ativá-la, ela aparece aqui."
                    : "Aqui aparecem as campanhas ativas."
            }
            action={
              !filtered && !pendingOnly && canCreate ? (
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

/* ------------------------------------------------------------------ */

function CampaignDetail({
  campaign,
  state,
  data,
  company,
  backend,
  today,
  eventsTick,
  notify,
  connectionTick,
  onPending,
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
  today: string;
  eventsTick: number;
  notify: (message: string) => void;
  connectionTick: number;
  onPending: (id: string) => void;
  onBack: () => void;
  onEdit: () => void;
  onStatus: (to: AdCampaignStatus) => void;
  onNewCycle: () => void;
  onEditCycle: (cycle: AdCycle) => void;
  onMakeCurrent: (cycle: AdCycle) => void;
}) {
  const parts = contractParts(data, campaign.contract_id);
  const cycles = cyclesOf(state, campaign.id);
  const current = currentCycle(state, campaign);
  const alert = cycleAlert(state, campaign, today);
  const [events, setEvents] = useState<AdCampaignEvent[] | null>(null);
  // Editing a record of the Linha do tempo adds to the history.
  const [editsTick, setEditsTick] = useState(0);
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

  const actions = (
    <>
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
  const banner =
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
      </div>
    ) : null;

  return (
    <div className="campaign-detail">
      <Button className="text-btn campaign-back" onClick={onBack}>
        <ArrowLeft size={16} /> Todas as campanhas
      </Button>
      <CampaignDayToDay
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
        today={today}
        events={events}
        describeEvent={(e) => describeEvent(e, state)}
        notify={notify}
        onRecordEdited={() => setEditsTick((t) => t + 1)}
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
                <Button className="btn secondary" onClick={onNewCycle}>
                  <Plus size={15} /> Novo ciclo
                </Button>
              </div>
              {cycles.length ? (
                <div className="table-scroll">
                  <table className="campaign-table">
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
                            </td>
                            <td>{monthLabel(y.competence_month)}</td>
                            <td>{objectives[y.objective].label}</td>
                            <td>
                              {y.goal_results} {objectives[y.objective].result}
                              {goalCost(y) !== null && (
                                <small className="cell-note">
                                  {money(goalCost(y)!)} por resultado
                                </small>
                              )}
                            </td>
                            <td>{money(y.budget)}</td>
                            <td>{y.multiplier.toLocaleString("pt-BR")}</td>
                            <td>
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
                            <td>
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
                              {!isCurrent && (
                                <Button
                                  className="text-btn"
                                  onClick={() => onMakeCurrent(y)}
                                  title="Definir como o ciclo que está valendo"
                                >
                                  <Star size={14} /> Tornar atual
                                </Button>
                              )}
                              <Button
                                className="icon-btn"
                                aria-label={`Editar ciclo de ${shortDate(y.start_date)} a ${shortDate(y.end_date)}`}
                                title="Editar ciclo"
                                onClick={() => onEditCycle(y)}
                              >
                                <Pencil size={14} />
                              </Button>
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
    case "cycle_created":
      return `cadastrou o ciclo de ${shortDate(String(d.start_date))} a ${shortDate(String(d.end_date))} (${money(Number(d.budget))}, meta de ${d.goal_results}).`;
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
      return `editou o registro ${e.action === "daily_edited" ? `diário de ${shortDate(String(d.day))}` : `de ${shortDate(String(d.taken_on))}`}${changes ? ` — ${changes}` : ""}.`;
    }
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
  onClose: () => void;
  onSave: (input: CycleInput, makeCurrent: boolean) => Promise<void>;
}) {
  const cycles = cyclesOf(state, campaign.id);
  const last = cycles[cycles.length - 1] ?? null;
  const [draft, setDraft] = useState<CycleDraft>(() =>
    cycle ? cycleDraft(cycle) : nextCycleDraft(last, today),
  );
  const [makeCurrent, setMakeCurrent] = useState(
    !cycle && !campaign.current_cycle_id,
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof CycleDraft>(key: K, value: CycleDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
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
    const result = cycleInput(draft);
    if ("error" in result) return setError(result.error);
    setError("");
    setSaving(true);
    try {
      await onSave(result.input, makeCurrent);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }
  const result = objectives[draft.objective].result;
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
        <fieldset className="create-fields" disabled={saving}>
          <div className="form-columns campaign-three">
            <label>
              Início
              <Input
                type="date"
                value={draft.start_date}
                onChange={(e) => {
                  const start = e.target.value;
                  setDraft((d) => ({
                    ...d,
                    start_date: start,
                    competence: d.competence || start.slice(0, 7),
                  }));
                }}
                required
              />
            </label>
            <label>
              Término
              <Input
                type="date"
                value={draft.end_date}
                min={draft.start_date}
                onChange={(e) => set("end_date", e.target.value)}
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
          <label className="campaign-narrow">
            Índice de performance (M)
            <Input
              inputMode="decimal"
              value={draft.multiplier}
              onChange={(e) => set("multiplier", e.target.value)}
            />
            <small>
              Vem do ciclo anterior; altere quando o índice da operação mudar.
            </small>
          </label>
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
          <Button type="submit" className="btn primary" loading={saving}>
            {cycle ? "Salvar ciclo" : "Cadastrar ciclo"}
          </Button>
        </div>
      </form>
    </Modal>
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

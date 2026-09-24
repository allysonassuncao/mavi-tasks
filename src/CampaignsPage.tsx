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
  ExternalLink,
  History,
  Link2,
  Megaphone,
  Pencil,
  Plus,
  Search,
  Star,
  Trash2,
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
import { Pagination, usePagination } from "./Pagination";
import { ContractPicker } from "./ContractPicker";
import { contractParts, dateKey, fold } from "./domain";
import { useUrlState } from "./router";
import type { Snapshot } from "./types";
import {
  campaignStatuses,
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
  type AdDestination,
  type AdObjective,
  type AdPlatform,
  type CampaignData,
  type CampaignsBackend,
  type CycleAlert,
  type CycleDraft,
  type CycleInput,
} from "./campaigns";
import { demoCampaigns } from "./campaigns-demo";

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
 * Módulo exclusivo de administradores (App só o abre para eles, e o banco
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
  const [state, setState] = useState<CampaignData>(emptyData);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useUrlState<string>("campanha", "");
  const [campaignForm, setCampaignForm] = useState<CampaignFormState>(null);
  const [cycleForm, setCycleForm] = useState<CycleFormState>(null);
  const [statusForm, setStatusForm] = useState<StatusFormState>(null);
  const [eventsTick, setEventsTick] = useState(0);

  const reload = useCallback(async () => {
    try {
      setState(await backend.load(company));
      setLoadError("");
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, [backend, company]);
  useEffect(() => {
    setLoaded(false);
    void reload();
  }, [reload]);
  const afterChange = async (message: string) => {
    await reload();
    setEventsTick((t) => t + 1);
    notify(message);
  };

  const canCreate = data.contracts.some((k) => !k.archived);
  const campaign = state.campaigns.find((c) => c.id === selected);

  return (
    <>
      {!loaded ? (
        <Loading compact />
      ) : loadError ? (
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
          onBack={() => setSelected("")}
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
          state={state}
          data={data}
          today={today}
          canCreate={canCreate}
          missing={!!selected}
          onOpen={(id) => setSelected(id)}
          onNew={() => setCampaignForm({})}
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
            const created = (await backend.load(company)).campaigns.find(
              (c) => c.id === id,
            );
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

function CampaignList({
  state,
  data,
  today,
  canCreate,
  missing,
  onOpen,
  onNew,
  demo,
}: {
  state: CampaignData;
  data: Snapshot;
  today: string;
  canCreate: boolean;
  missing: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
  demo: boolean;
}) {
  const [query, setQuery] = useUrlState<string>("busca", "");
  const [status, setStatus] = useUrlState<string>("status", "");
  const [platform, setPlatform] = useUrlState<string>("plataforma", "");
  const [attention, setAttention] = useUrlState<boolean>("atencao", false);
  const top = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => {
    const q = fold(query.trim());
    return state.campaigns
      .filter((c) => !c.archived)
      .map((c) => {
        const parts = contractParts(data, c.contract_id);
        const cycle = currentCycle(state, c);
        return {
          campaign: c,
          parts,
          cycle,
          alert: cycleAlert(state, c, today),
        };
      })
      .filter(
        (r) =>
          (!status || r.campaign.status === status) &&
          (!platform || r.campaign.platform === platform) &&
          (!attention || r.alert.kind !== "none") &&
          (!q ||
            fold(r.campaign.name).includes(q) ||
            fold(r.parts.client?.name ?? "").includes(q)),
      )
      .sort(
        (a, b) =>
          (a.parts.client?.name ?? "").localeCompare(
            b.parts.client?.name ?? "",
            "pt-BR",
          ) || a.campaign.name.localeCompare(b.campaign.name, "pt-BR"),
      );
  }, [state, data, today, query, status, platform, attention]);
  const pages = usePagination(
    rows,
    25,
    `${query}|${status}|${platform}|${attention}`,
  );
  const total = state.campaigns.filter((c) => !c.archived).length;
  const needing = state.campaigns.filter(
    (c) => !c.archived && cycleAlert(state, c, today).kind !== "none",
  ).length;

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
          {total} {total === 1 ? "campanha" : "campanhas"}
          {needing > 0 && (
            <>
              {" · "}
              <button
                type="button"
                className={`campaign-attention ${attention ? "on" : ""}`}
                aria-pressed={attention}
                onClick={() => setAttention(!attention)}
              >
                <TriangleAlert size={13} /> {needing}{" "}
                {needing === 1 ? "precisa" : "precisam"} de atenção
              </button>
            </>
          )}
        </span>
        <div className="campaign-filters">
          <span className="portfolio-search">
            <Input
              type="search"
              aria-label="Buscar campanha ou cliente"
              placeholder="Buscar campanha ou cliente"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              icon={Search}
            />
          </span>
          <Select value={status} onValueChange={setStatus} aria-label="Status">
            <SelectOption value="">Todos os status</SelectOption>
            <SelectOption value="active">Ativas</SelectOption>
            <SelectOption value="inactive">Inativas</SelectOption>
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
          {canCreate && (
            <Button className="btn primary" onClick={onNew}>
              <Plus size={17} /> Nova campanha
            </Button>
          )}
        </div>
      </div>
      {rows.length ? (
        <section className="panel">
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
                {pages.pageItems.map(({ campaign, parts, cycle, alert }) => (
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
                      <strong className="campaign-name">{campaign.name}</strong>
                      <small className="cell-note">
                        {parts.client?.name ?? "Cliente"} ·{" "}
                        {parts.product?.name ?? "Produto"}
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
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <Empty
          title={
            total ? "Nenhuma campanha encontrada" : "Nenhuma campanha ainda"
          }
          body={
            total
              ? "Confira a busca e os filtros."
              : canCreate
                ? "Cadastre a primeira campanha de tráfego pago de um cliente e, em seguida, o ciclo de verba dela."
                : "Aqui aparecem as campanhas dos clientes atendidos pelas suas equipes."
          }
          action={
            !total && canCreate ? (
              <Button className="btn primary" onClick={onNew}>
                <Plus size={17} /> Nova campanha
              </Button>
            ) : undefined
          }
        />
      )}
      <Pagination
        page={pages.page}
        pageCount={pages.pageCount}
        pageSize={pages.pageSize}
        total={rows.length}
        noun={rows.length === 1 ? "campanha" : "campanhas"}
        onPage={pages.setPage}
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
  useEffect(() => {
    let live = true;
    backend
      .events(company, campaign.id)
      .then((list) => live && setEvents(list))
      .catch(() => live && setEvents([]));
    return () => {
      live = false;
    };
  }, [backend, company, campaign.id, eventsTick]);
  const suggestion =
    alert.kind === "ended" ||
    alert.kind === "ends_today" ||
    alert.kind === "ending"
      ? alert.next
      : alert.kind === "no_current"
        ? alert.suggestion
        : null;

  return (
    <div className="campaign-detail">
      <Button className="text-btn campaign-back" onClick={onBack}>
        <ArrowLeft size={16} /> Todas as campanhas
      </Button>
      <section className="panel campaign-head">
        <div>
          <span className="campaign-eyebrow">
            <Megaphone size={14} /> {parts.client?.name} · {parts.product?.name}
            {parts.detail && ` (${parts.detail})`}
          </span>
          <h2>{campaign.name}</h2>
          <div className="campaign-tags">
            <PlatformLabel platform={campaign.platform} />
            <StatusChip status={campaign.status} />
          </div>
          <dl className="campaign-facts">
            {campaign.briefing_url && (
              <div>
                <dt>Briefing</dt>
                <dd>
                  <a
                    href={campaign.briefing_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Abrir <ExternalLink size={12} />
                  </a>
                </dd>
              </div>
            )}
            {campaign.media_plan_url && (
              <div>
                <dt>Plano de mídia</dt>
                <dd>
                  <a
                    href={campaign.media_plan_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Abrir <ExternalLink size={12} />
                  </a>
                </dd>
              </div>
            )}
            {campaign.notes && (
              <div className="wide">
                <dt>Observações</dt>
                <dd className="campaign-notes">{campaign.notes}</dd>
              </div>
            )}
          </dl>
        </div>
        <div className="campaign-actions">
          <Button className="btn secondary" onClick={onEdit}>
            <Pencil size={15} /> Editar
          </Button>
          {campaign.status === "active" ? (
            <Button
              className="btn secondary"
              onClick={() => onStatus("inactive")}
            >
              <CirclePause size={15} /> Inativar
            </Button>
          ) : (
            <Button
              className="btn primary"
              onClick={() => onStatus("active")}
              disabled={!current}
              title={
                current ? undefined : "Defina o ciclo atual antes de ativar"
              }
            >
              <CirclePlay size={15} /> Ativar
            </Button>
          )}
        </div>
      </section>

      {alert.kind !== "none" && (
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
      )}

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Ciclos</h2>
            <p>
              Períodos de verba da campanha. O ciclo atual só muda quando alguém
              troca.
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
                          {shortDate(y.start_date)} a {shortDate(y.end_date)}
                        </strong>
                        <small className="cell-note">{cycleDays(y)} dias</small>
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
                        <small className="cell-note">
                          <Link2 size={12} /> {y.links.length}{" "}
                          {y.links.length === 1 ? "vínculo" : "vínculos"} na
                          plataforma
                          {y.landing_pages.length > 0 &&
                            ` · LPs: ${y.landing_pages.join(", ")}`}
                        </small>
                      </td>
                      <td>
                        {isCurrent && (
                          <span className="campaign-chip current">Atual</span>
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
                    {data.members.find((m) => m.user_id === e.actor_id)?.name ??
                      "Alguém"}
                  </strong>{" "}
                  {describeEvent(e, state)}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted campaign-history-empty">Sem registros ainda.</p>
        )}
      </section>
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
    default:
      return e.action;
  }
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
  const [briefing, setBriefing] = useState(campaign?.briefing_url ?? "");
  const [plan, setPlan] = useState(campaign?.media_plan_url ?? "");
  const [notes, setNotes] = useState(campaign?.notes ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const url = (v: string) => !v.trim() || /^https?:\/\//i.test(v.trim());
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (!contract) return setError("Escolha o cliente e o produto contratado.");
    if (name.trim().length < 2) return setError("Dê um nome à campanha.");
    if (!url(briefing) || !url(plan))
      return setError("Os links precisam começar com http:// ou https://.");
    setError("");
    setSaving(true);
    try {
      await onSave({
        contract_id: contract,
        name: name.trim(),
        platform,
        briefing_url: briefing.trim(),
        media_plan_url: plan.trim(),
        notes,
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
          <div className="form-columns">
            <label>
              Link do briefing
              <Input
                type="url"
                value={briefing}
                onChange={(e) => setBriefing(e.target.value)}
                placeholder="https://"
              />
            </label>
            <label>
              Link do plano de mídia
              <Input
                type="url"
                value={plan}
                onChange={(e) => setPlan(e.target.value)}
                placeholder="https://"
              />
            </label>
          </div>
          <label>
            Observações
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={4000}
              rows={3}
            />
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
  onClose,
  onSave,
}: {
  campaign: AdCampaign;
  cycle?: AdCycle;
  first?: boolean;
  state: CampaignData;
  today: string;
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
          <fieldset className="campaign-links">
            <legend>Vínculos na plataforma</legend>
            <small>
              Contas de anúncio e campanhas de {platforms[campaign.platform]} de
              onde vêm os resultados deste ciclo. Opcional por enquanto; será
              usado pela sincronização automática.
            </small>
            {draft.links.map((l, i) => (
              <div className="campaign-link-row" key={i}>
                <Input
                  aria-label={`Conta de anúncio ${i + 1}`}
                  placeholder="Conta de anúncio"
                  value={l.account_id}
                  onChange={(e) =>
                    set(
                      "links",
                      draft.links.map((x, j) =>
                        j === i ? { ...x, account_id: e.target.value } : x,
                      ),
                    )
                  }
                />
                <Input
                  aria-label={`Campanha na plataforma ${i + 1}`}
                  placeholder="ID da campanha (opcional)"
                  value={l.campaign_id}
                  onChange={(e) =>
                    set(
                      "links",
                      draft.links.map((x, j) =>
                        j === i ? { ...x, campaign_id: e.target.value } : x,
                      ),
                    )
                  }
                />
                <Button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remover vínculo ${i + 1}`}
                  onClick={() =>
                    set(
                      "links",
                      draft.links.filter((_, j) => j !== i),
                    )
                  }
                >
                  <Trash2 size={15} />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              className="text-btn"
              onClick={() =>
                set("links", [
                  ...draft.links,
                  { account_id: "", campaign_id: "" },
                ])
              }
            >
              <Plus size={14} /> Adicionar vínculo
            </Button>
          </fieldset>
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

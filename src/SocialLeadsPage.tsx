import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CircleCheck,
  Plus,
  ClipboardList,
  Clock3,
  Rocket,
  Search,
  Send,
  Sparkles,
  Users,
} from "lucide-react";
import { Avatar, Empty, Modal } from "./components";
import { Button, Input, Loading, Select, SelectOption } from "./ui";
import { useUrlState } from "./router";
import type { Snapshot } from "./types";
import {
  demoSocialLeads,
  serverSocialLeads,
  useLiveSocialLeads,
  type ContractBundle,
  type SocialLeadsBackend,
} from "./social-leads-api";
import {
  nextActions,
  relativeDays,
  stageLabel,
  stageOf,
  stages,
  type NextAction,
  type Portfolio,
  type PortfolioItem,
} from "./social-leads";
import { BriefingWizard } from "./SocialLeadsBriefing";
import { PlanView, type PlanIntent, type Production } from "./SocialLeadsPlan";

/**
 * Onboarding › Social Leads. The portfolio (clients with the Social Leads
 * product, the next action of each) and, for one client, the briefing and
 * the plan of each month. The URL keeps the client (contrato), the tab (aba)
 * and the month (mes). Changes arrive live: App relays the company's
 * "social_leads" notices as the "mavi:social-leads" window event.
 */
export function SocialLeadsPage({
  data,
  company,
  user,
  isLeader,
  demo,
  notify,
}: {
  data: Snapshot;
  company: string;
  user: string;
  isLeader: boolean;
  demo: boolean;
  notify: (message: string) => void;
}) {
  const backend = useMemo<SocialLeadsBackend>(
    () => (demo ? demoSocialLeads(data, user) : serverSocialLeads),
    // The demo store is created once per session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demo],
  );
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [error, setError] = useState("");
  const [contract, setContract] = useUrlState<string>("contrato", "");
  const [tab, setTab] = useUrlState<string>("aba", "plano");
  const [intent, setIntent] = useState<PlanIntent>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    backend
      .portfolio(company)
      .then((p) => {
        setPortfolio(p);
        setError("");
      })
      .catch((e) => setError((e as Error).message));
  }, [backend, company]);
  useEffect(load, [load]);
  useLiveSocialLeads(null, load);

  const open = (
    item: PortfolioItem,
    next: "plano" | "briefing",
    why: PlanIntent = null,
  ) => {
    setIntent(why);
    setTab(next);
    setContract(item.contract_id);
  };

  if (error && !portfolio)
    return <Empty title="Não foi possível abrir o Social Leads" body={error} />;
  if (!portfolio) return <Loading />;
  if (!portfolio.configured)
    return (
      <Setup
        data={data}
        company={company}
        isLeader={isLeader}
        backend={backend}
        current={
          portfolio.product_id
            ? {
                product: portfolio.product_id,
                team: portfolio.team_id ?? null,
                designTeam: portfolio.design_team_id ?? null,
                artDays: portfolio.art_days ?? 5,
              }
            : null
        }
        onDone={load}
        notify={notify}
      />
    );

  const item = portfolio.items.find((i) => i.contract_id === contract);
  if (contract && item)
    return (
      <ClientView
        key={item.contract_id}
        item={item}
        data={data}
        company={company}
        user={user}
        isLeader={isLeader}
        teamId={portfolio.team_id ?? null}
        production={{
          teamId: portfolio.design_team_id ?? portfolio.team_id ?? null,
          teamName:
            data.teams.find(
              (t) => t.id === (portfolio.design_team_id ?? portfolio.team_id),
            )?.name ?? null,
          artDays: portfolio.art_days ?? 5,
        }}
        backend={backend}
        tab={tab === "briefing" ? "briefing" : "plano"}
        setTab={(t) => setTab(t)}
        intent={intent}
        clearIntent={() => setIntent(null)}
        onBack={() => {
          setContract("");
          setTab("plano");
        }}
        onChanged={load}
        notify={notify}
      />
    );
  return (
    <>
      <PortfolioView
        portfolio={portfolio}
        data={data}
        user={user}
        isLeader={isLeader}
        onOpen={open}
        onAdd={isLeader ? () => setAdding(true) : undefined}
        onSettings={
          isLeader
            ? () => setPortfolio({ ...portfolio, configured: false })
            : undefined
        }
      />
      {adding && (
        <AddClient
          data={data}
          company={company}
          portfolio={portfolio}
          backend={backend}
          onClose={() => setAdding(false)}
          onAdded={(id) => {
            setAdding(false);
            notify("Cliente adicionado ao Social Leads. Comece pelo briefing.");
            load();
            setIntent(null);
            setTab("briefing");
            setContract(id);
          }}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------ add a client
/**
 * Puts a client in the portfolio: adds the Social Leads product to a client
 * already registered (the ones without it) or registers a new client with it.
 * The squad team, when there is one, starts serving the client.
 */
function AddClient({
  data,
  company,
  portfolio,
  backend,
  onClose,
  onAdded,
}: {
  data: Snapshot;
  company: string;
  portfolio: Portfolio;
  backend: SocialLeadsBackend;
  onClose: () => void;
  onAdded: (contract: string) => void;
}) {
  const product = data.products.find((p) => p.id === portfolio.product_id);
  const inPortfolio = new Set(portfolio.items.map((i) => i.client_id));
  const candidates = data.clients
    .filter((c) => !c.archived && !inPortfolio.has(c.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const [mode, setMode] = useState<"existing" | "new">(
    candidates.length ? "existing" : "new",
  );
  const [client, setClient] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const picked = candidates.find((c) => c.id === client);
  const ready = mode === "existing" ? !!picked : name.trim().length >= 2;
  return (
    <Modal
      title="Adicionar cliente ao Social Leads"
      onClose={onClose}
      busy={busy}
    >
      <form
        className="entity-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!product || !ready) return;
          setBusy(true);
          setError("");
          backend
            .addClient(
              company,
              mode === "existing" ? { client } : { name },
              product,
              portfolio.team_id ?? null,
              mode === "existing" ? picked!.name : name,
            )
            .then(onAdded)
            .catch((err) => setError((err as Error).message))
            .finally(() => setBusy(false));
        }}
      >
        <div className="view-switch" role="tablist" aria-label="Qual cliente">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "existing"}
            className={mode === "existing" ? "selected" : ""}
            onClick={() => setMode("existing")}
            disabled={!candidates.length}
          >
            Cliente já cadastrado
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "new"}
            className={mode === "new" ? "selected" : ""}
            onClick={() => setMode("new")}
          >
            Cliente novo
          </button>
        </div>
        {mode === "existing" ? (
          <label>
            Cliente
            <Select value={client} onValueChange={setClient} required>
              <SelectOption value="">Escolha o cliente</SelectOption>
              {candidates.map((c) => (
                <SelectOption key={c.id} value={c.id}>
                  {c.name}
                </SelectOption>
              ))}
            </Select>
          </label>
        ) : (
          <label>
            Nome do cliente
            <Input
              value={name}
              maxLength={160}
              placeholder="Ex.: Agente Stravitta"
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>
        )}
        <p className="sl-muted">
          O cliente recebe o produto {product?.name ?? "Social Leads"}
          {portfolio.team_id
            ? ` e passa a ser atendido pela equipe ${data.teams.find((t) => t.id === portfolio.team_id)?.name ?? "do squad"}`
            : ""}
          . Depois é só preencher o briefing.
        </p>
        {error && <p className="sl-alert bad">{error}</p>}
        <div className="form-footer">
          <Button type="button" className="btn secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="submit"
            className="btn primary"
            disabled={!ready || !product}
            loading={busy}
          >
            Adicionar e abrir o briefing
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------ setup
function Setup({
  data,
  company,
  isLeader,
  backend,
  current,
  onDone,
  notify,
}: {
  data: Snapshot;
  company: string;
  isLeader: boolean;
  backend: SocialLeadsBackend;
  /** What is configured now, when changing it. */
  current: {
    product: string;
    team: string | null;
    designTeam: string | null;
    artDays: number;
  } | null;
  onDone: () => void;
  notify: (m: string) => void;
}) {
  const guess = data.products.find((p) => /social\s*leads/i.test(p.name));
  const [product, setProduct] = useState(current?.product ?? guess?.id ?? "");
  const squad = data.teams.find((t) => /social/i.test(t.name));
  const [team, setTeam] = useState(
    current ? (current.team ?? "") : (squad?.id ?? ""),
  );
  const creation = data.teams.find((t) => /cria|design|arte/i.test(t.name));
  const [designTeam, setDesignTeam] = useState(
    current ? (current.designTeam ?? "") : (creation?.id ?? ""),
  );
  const [artDays, setArtDays] = useState(String(current?.artDays ?? 5));
  const [busy, setBusy] = useState(false);
  if (!isLeader)
    return (
      <Empty
        title="Social Leads ainda não configurado"
        body="Um administrador ou gestor precisa escolher qual produto do catálogo é o Social Leads."
      />
    );
  return (
    <section className="panel sl-setup">
      <div className="panel-heading">
        <div>
          <h2>Configurar o Social Leads</h2>
          <p>
            A carteira reúne os clientes com este produto contratado. O squad é
            a equipe de onde saem os responsáveis.
          </p>
        </div>
      </div>
      <form
        className="entity-form"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          backend
            .setSettings(
              company,
              product,
              team || null,
              designTeam || null,
              Math.min(60, Math.max(1, Number(artDays) || 5)),
            )
            .then(() => {
              notify("Social Leads configurado.");
              onDone();
            })
            .catch((err) => notify((err as Error).message))
            .finally(() => setBusy(false));
        }}
      >
        <div className="form-columns">
          <label>
            Produto do catálogo
            <Select value={product} onValueChange={setProduct} required>
              <SelectOption value="">Escolha o produto</SelectOption>
              {data.products.map((p) => (
                <SelectOption key={p.id} value={p.id}>
                  {p.name}
                </SelectOption>
              ))}
            </Select>
          </label>
          <label>
            Equipe do squad
            <Select value={team} onValueChange={setTeam}>
              <SelectOption value="">Sem equipe (qualquer pessoa)</SelectOption>
              {data.teams.map((t) => (
                <SelectOption key={t.id} value={t.id}>
                  {t.name}
                </SelectOption>
              ))}
            </Select>
          </label>
        </div>
        <div className="form-columns">
          <label>
            <span className="sl-label">
              Equipe de criação
              <em>
                Recebe as tarefas de arte (quem tem menos tarefas em aberto).
              </em>
            </span>
            <Select value={designTeam} onValueChange={setDesignTeam}>
              <SelectOption value="">A mesma do squad</SelectOption>
              {data.teams.map((t) => (
                <SelectOption key={t.id} value={t.id}>
                  {t.name}
                </SelectOption>
              ))}
            </Select>
          </label>
          <label>
            <span className="sl-label">
              Prazo da arte
              <em>Dias a partir de quando a produção é liberada.</em>
            </span>
            <Input
              type="number"
              min={1}
              max={60}
              value={artDays}
              onChange={(e) => setArtDays(e.target.value)}
            />
          </label>
        </div>
        <div className="form-footer">
          {current && (
            <Button type="button" className="btn secondary" onClick={onDone}>
              Cancelar
            </Button>
          )}
          <Button
            className="btn primary"
            type="submit"
            disabled={!product}
            loading={busy}
          >
            Salvar
          </Button>
        </div>
      </form>
    </section>
  );
}

// ------------------------------------------------------------ portfolio
const TONE_COLOR = {
  bad: "#cf4f5f",
  warn: "#c28a1e",
  good: "#4f9879",
  info: "#598bda",
};
function PortfolioView({
  portfolio,
  data,
  user,
  isLeader,
  onOpen,
  onAdd,
  onSettings,
}: {
  portfolio: Portfolio;
  data: Snapshot;
  user: string;
  isLeader: boolean;
  onOpen: (
    item: PortfolioItem,
    tab: "plano" | "briefing",
    intent?: PlanIntent,
  ) => void;
  onAdd?: () => void;
  onSettings?: () => void;
}) {
  const items = portfolio.items;
  const mineCount = items.filter(
    (i) => i.briefing?.responsible_id === user,
  ).length;
  const [scope, setScope] = useUrlState<string>(
    "carteira",
    mineCount && !isLeader ? "minha" : "todos",
  );
  const [stage, setStage] = useUrlState<string>("etapa", "");
  const [query, setQuery] = useState("");
  const [allActions, setAllActions] = useState(false);
  const member = (id: string | null | undefined) =>
    data.members.find((m) => m.user_id === id);

  const scoped = items.filter(
    (i) => scope !== "minha" || i.briefing?.responsible_id === user,
  );
  const counts = [0, 1, 2, 3].map(
    (s) => scoped.filter((i) => stageOf(i) === s).length,
  );
  const fold = (t: string) =>
    t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const shown = scoped.filter((i) => {
    if (stage !== "" && String(stageOf(i)) !== stage) return false;
    if (!query.trim()) return true;
    const hay = fold(
      [
        i.client_name,
        i.contract_name,
        i.briefing?.fields.segment,
        i.briefing?.fields.clientName,
        member(i.briefing?.responsible_id)?.name,
      ]
        .filter(Boolean)
        .join(" "),
    );
    return hay.includes(fold(query.trim()));
  });
  const actions = nextActions(scoped);
  const act = (a: NextAction) => {
    const item = items.find((i) => i.contract_id === a.contract)!;
    if (a.action === "open-briefing") onOpen(item, "briefing");
    else if (a.action === "share") onOpen(item, "plano", "share");
    else if (a.action === "next-month") onOpen(item, "plano", "next-month");
    else if (a.action === "release") onOpen(item, "plano", "release");
    else if (a.action === "campaign") onOpen(item, "plano", "campaign");
    else onOpen(item, "plano");
  };

  if (!items.length)
    return (
      <Empty
        title="Nenhum cliente no Social Leads ainda"
        body={
          onAdd
            ? "Adicione o primeiro cliente: um já cadastrado ou um novo. Em seguida vem o briefing."
            : "Quando um administrador ou gestor adicionar um cliente ao Social Leads, ele aparece aqui."
        }
        action={
          onAdd && (
            <div className="sl-empty-actions">
              <Button className="btn primary" onClick={onAdd}>
                <Plus size={16} /> Adicionar cliente
              </Button>
              {onSettings && (
                <Button className="btn secondary" onClick={onSettings}>
                  Trocar o produto
                </Button>
              )}
            </div>
          )
        }
      />
    );

  const kpis = [
    { label: "Em briefing", icon: ClipboardList, tone: "blue", stage: 0 },
    { label: "Plano para revisar", icon: Sparkles, tone: "purple", stage: 1 },
    { label: "Aguardando o cliente", icon: Clock3, tone: "orange", stage: 2 },
    { label: "Plano aprovado", icon: CircleCheck, tone: "green", stage: 3 },
  ];
  return (
    <div className="sl-portfolio">
      <div className="stats-grid">
        {kpis.map((k) => (
          <Button
            key={k.label}
            className={`stat-card ${k.tone}${stage === String(k.stage) ? " sl-stat-on" : ""}`}
            onClick={() =>
              setStage(stage === String(k.stage) ? "" : String(k.stage))
            }
            aria-pressed={stage === String(k.stage)}
          >
            <div>
              {k.label}
              <k.icon size={17} />
            </div>
            <strong>{counts[k.stage]}</strong>
            <footer>
              {stage === String(k.stage) ? "Filtrando a lista" : "Ver na lista"}
            </footer>
          </Button>
        ))}
      </div>

      {!!actions.length && (
        <section className="panel sl-actions">
          <div className="panel-heading">
            <div>
              <h2>Próximas ações</h2>
              <p>
                {scope === "minha" ? "Da sua carteira" : "De todos os clientes"}
                , da mais urgente para a menos
              </p>
            </div>
          </div>
          <ul>
            {(allActions ? actions : actions.slice(0, 6)).map((a) => (
              <li key={a.contract}>
                <span
                  className="sl-dot"
                  style={{ background: TONE_COLOR[a.tone] }}
                />
                <div>
                  <strong>{a.title}</strong>
                  <small>{a.detail}</small>
                </div>
                <Button
                  className={`btn ${a.tone === "good" || a.action === "share" ? "primary" : "secondary"}`}
                  onClick={() => act(a)}
                >
                  {a.action === "share" && <Send size={15} />}
                  {a.label}
                </Button>
              </li>
            ))}
          </ul>
          {actions.length > 6 && (
            <button
              type="button"
              className="sl-more"
              onClick={() => setAllActions(!allActions)}
            >
              {allActions ? "Mostrar menos" : `Ver as ${actions.length} ações`}
            </button>
          )}
        </section>
      )}

      <section className="panel sl-list">
        <div className="sl-filters">
          <div
            className="view-switch"
            role="tablist"
            aria-label="De quem são os clientes"
          >
            <button
              type="button"
              role="tab"
              aria-selected={scope === "minha"}
              className={scope === "minha" ? "selected" : ""}
              onClick={() => setScope("minha")}
            >
              Minha carteira <span>{mineCount}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={scope !== "minha"}
              className={scope !== "minha" ? "selected" : ""}
              onClick={() => setScope("todos")}
            >
              Todos <span>{items.length}</span>
            </button>
          </div>
          <div className="sl-search">
            <Input
              type="search"
              icon={Search}
              placeholder="Buscar cliente, segmento ou responsável"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Buscar cliente"
            />
          </div>
          {onSettings && (
            <Button
              className="btn secondary"
              onClick={onSettings}
              title="Produto e equipe do Social Leads"
            >
              <Users size={15} /> Configurar
            </Button>
          )}
          {onAdd && (
            <Button className="btn primary" onClick={onAdd}>
              <Plus size={16} /> Adicionar cliente
            </Button>
          )}
        </div>
        {!shown.length ? (
          <Empty
            title="Nenhum cliente aqui"
            body={
              scope === "minha"
                ? "Você ainda não é responsável por nenhum cliente. Veja todos."
                : "Nenhum cliente com esses filtros."
            }
          />
        ) : (
          <div className="sl-table-wrap">
            <table className="sl-table">
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>Etapa</th>
                  <th>Mês</th>
                  <th>Próximo passo</th>
                  <th>Responsável</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((i) => {
                  const s = stageOf(i);
                  const next = actions.find(
                    (a) => a.contract === i.contract_id,
                  );
                  const who = member(i.briefing?.responsible_id);
                  return (
                    <tr
                      key={i.contract_id}
                      tabIndex={0}
                      onClick={() => onOpen(i, i.plan ? "plano" : "briefing")}
                      onKeyDown={(e) => {
                        if (e.key === "Enter")
                          onOpen(i, i.plan ? "plano" : "briefing");
                      }}
                    >
                      <td>
                        <div className="sl-client">
                          <span
                            className="sl-initials"
                            style={{
                              background: `${i.client_color}33`,
                              color: i.client_color,
                            }}
                          >
                            {i.client_name.slice(0, 2).toUpperCase()}
                          </span>
                          <div>
                            <strong>
                              {i.briefing?.fields.clientName || i.client_name}
                            </strong>
                            <small>
                              {i.briefing?.fields.segment || i.contract_name}
                            </small>
                          </div>
                        </div>
                      </td>
                      <td>
                        <StageBar stage={s} />
                        <small className="sl-stage-label">
                          {stageLabel(i)}
                        </small>
                      </td>
                      <td>{i.plan ? i.plan.label : "—"}</td>
                      <td className={`sl-next ${next?.tone ?? ""}`}>
                        {next
                          ? next.title.replace(/^[^:]+:\s*/, "")
                          : s === 2
                            ? `Aguardando o cliente · link enviado ${relativeDays(i.plan?.shared_at)}`
                            : `Atualizado ${relativeDays(i.plan?.updated_at ?? i.briefing?.updated_at)}`}
                      </td>
                      <td>
                        {who ? (
                          <span className="sl-person">
                            <Avatar
                              name={who.name}
                              src={who.avatar_url}
                              size="small"
                            />
                            <span>{who.name.split(" ")[0]}</span>
                          </span>
                        ) : (
                          <span className="sl-muted">Sem responsável</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export function StageBar({ stage }: { stage: number }) {
  return (
    <span className="sl-stage" aria-label={`Etapa: ${stages[stage]}`}>
      {stages.map((label, i) => (
        <i
          key={label}
          className={i < stage ? "done" : i === stage ? "current" : ""}
        />
      ))}
    </span>
  );
}

// ------------------------------------------------------------ one client
function ClientView({
  item,
  data,
  company,
  user,
  isLeader,
  teamId,
  production,
  backend,
  tab,
  setTab,
  intent,
  clearIntent,
  onBack,
  onChanged,
  notify,
}: {
  item: PortfolioItem;
  data: Snapshot;
  company: string;
  user: string;
  isLeader: boolean;
  teamId: string | null;
  production: Production;
  backend: SocialLeadsBackend;
  tab: "plano" | "briefing";
  setTab: (t: "plano" | "briefing") => void;
  intent: PlanIntent;
  clearIntent: () => void;
  onBack: () => void;
  onChanged: () => void;
  notify: (m: string) => void;
}) {
  const [bundle, setBundle] = useState<ContractBundle | null>(null);
  const [error, setError] = useState("");
  const [month, setMonth] = useUrlState<number>("mes", 0);
  const load = useCallback(() => {
    backend
      .contract(company, item.contract_id)
      .then((b) => {
        setBundle(b);
        setError("");
      })
      .catch((e) => setError((e as Error).message));
  }, [backend, company, item.contract_id]);
  useEffect(load, [load]);
  useLiveSocialLeads(item.contract_id, () => {
    load();
    onChanged();
  });

  // Squad first, then everyone else active.
  const people = useMemo(() => {
    const squad = new Set(
      data.teamMembers
        .filter((t) => t.team_id === teamId)
        .map((t) => t.user_id),
    );
    return data.members
      .filter((m) => m.active)
      .map((m) => ({ ...m, squad: squad.has(m.user_id) }))
      .sort(
        (a, b) =>
          Number(b.squad) - Number(a.squad) || a.name.localeCompare(b.name),
      );
  }, [data.members, data.teamMembers, teamId]);

  const name = bundle?.briefing?.fields.clientName || item.client_name;
  const plans = bundle?.plans ?? [];
  const plan =
    plans.find((p) => p.month_number === month) ?? plans.at(-1) ?? null;
  const job = bundle?.job ?? null;

  return (
    <div className="sl-client-view">
      <div className="sl-client-head">
        <Button className="btn secondary sl-back" onClick={onBack}>
          <ArrowLeft size={16} /> Carteira
        </Button>
        <div className="sl-client-title">
          <h2>{name}</h2>
          <p>
            {[item.briefing?.fields.segment, item.contract_name]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        {plans.length > 0 && (
          <div className="sl-months" role="tablist" aria-label="Mês do plano">
            {plans.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={plan?.id === p.id && tab === "plano"}
                className={
                  plan?.id === p.id && tab === "plano" ? "selected" : ""
                }
                onClick={() => {
                  setMonth(
                    p.month_number === plans.at(-1)?.month_number
                      ? 0
                      : p.month_number,
                  );
                  setTab("plano");
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div
        className="scope-tabs sl-tabs"
        role="tablist"
        aria-label="Seções do cliente"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "plano"}
          className={tab === "plano" ? "selected" : ""}
          onClick={() => setTab("plano")}
        >
          <Rocket size={15} /> Plano do mês
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "briefing"}
          className={tab === "briefing" ? "selected" : ""}
          onClick={() => setTab("briefing")}
        >
          <ClipboardList size={15} /> Briefing
        </button>
      </div>
      {error && !bundle ? (
        <Empty title="Não foi possível abrir o cliente" body={error} />
      ) : !bundle ? (
        <Loading compact />
      ) : tab === "briefing" ? (
        <BriefingWizard
          item={item}
          briefing={bundle.briefing}
          people={people}
          company={company}
          backend={backend}
          hasPlan={plans.length > 0}
          job={job}
          canWrite={item.can_write}
          onSaved={load}
          onGenerated={() => {
            load();
            setTab("plano");
          }}
          notify={notify}
        />
      ) : (
        <PlanView
          item={item}
          isLeader={isLeader}
          production={production}
          clientName={name}
          briefing={bundle.briefing}
          plans={plans}
          plan={plan}
          job={job}
          company={company}
          user={user}
          data={data}
          backend={backend}
          intent={intent}
          clearIntent={clearIntent}
          onOpenBriefing={() => setTab("briefing")}
          onChanged={load}
          onMonth={(n) => setMonth(n)}
          notify={notify}
        />
      )}
    </div>
  );
}

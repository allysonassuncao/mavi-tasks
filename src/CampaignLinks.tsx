import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ClipboardList,
  Keyboard,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import { Button, Checkbox, Input, Loading, Select, SelectOption } from "./ui";
import { Modal } from "./components";
import { fold } from "./domain";
import { LeadFormAsk, LeadFormIntegration } from "./CampaignLeadForms";
import {
  AdsApiError,
  isLeadObjective,
  platforms,
  searchablePlatform,
  shortDate,
  type AdCycleLink,
  type AdPlatform,
  type AdsBackend,
  type AdsConnection,
  type AdsProvider,
  type AdsStatus,
  type LinkedLeadForm,
  type MetaClient,
  type PendingConnection,
  type PlatformAccount,
  type SyncOverview,
  type PlatformCampaign,
} from "./campaigns";

const providerName = (p: AdsProvider) =>
  p === "meta" ? "Facebook" : "Google Ads";
/** 1234567890 → 123-456-7890 on Google; Meta ids as they are. */
export const accountLabel = (platform: AdPlatform, id: string) =>
  platform === "google" && /^\d{10}$/.test(id)
    ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}`
    : id;

type Failure = { message: string; code?: string };
const failure = (e: unknown): Failure => ({
  message: (e as Error).message,
  code: e instanceof AdsApiError ? e.code : undefined,
});

/**
 * Starts a connection (Meta: for a client, from a campaign to come back to).
 * Inside a form the platform opens in a new tab so the draft isn't lost
 * (the tab is opened before the request, or browsers would block it);
 * elsewhere the page itself goes there. In the demonstration there is no
 * platform: the pending choice comes back at once.
 */
export async function startConnection(
  ads: AdsBackend,
  company: string,
  provider: AdsProvider,
  newTab: boolean,
  context?: { client?: string; campaign?: string },
): Promise<{ redirected: boolean; pending?: string }> {
  const tab = newTab ? window.open("", "_blank") : null;
  try {
    const start = await ads.connect(company, provider, context);
    if (!("url" in start)) {
      tab?.close();
      return { redirected: false, pending: start.pending || undefined };
    }
    if (tab) tab.location.href = start.url;
    else window.location.assign(start.url);
    return { redirected: true };
  } catch (e) {
    tab?.close();
    throw e;
  }
}

/**
 * The cycle's links to the platform. On Meta and Google, as in the MASO:
 * pick an ad account the connection reaches and tick its campaigns (read
 * live). Other platforms, or accounts nobody connected, are typed in.
 */
export function CycleLinks({
  platform,
  company,
  ads,
  client,
  campaign,
  refresh = 0,
  onPending,
  landingPages = [],
  links,
  onChange,
}: {
  platform: AdPlatform;
  company: string;
  ads: AdsBackend;
  /** The campaign's client: on Meta, only its accounts are listed. */
  client: { id: string; name: string } | null;
  /** The cycle's Make capture pages (for the Facebook lead forms). */
  landingPages?: string[];
  campaign?: string;
  /** Changes after a connection is completed: read the accounts again. */
  refresh?: number;
  /** A connection waiting for its accounts to be chosen (demonstration). */
  onPending?: (id: string) => void;
  links: AdCycleLink[];
  onChange: (links: AdCycleLink[]) => void;
}) {
  const provider = searchablePlatform(platform) ? platform : null;
  const [manual, setManual] = useState(!provider);
  const [accounts, setAccounts] = useState<PlatformAccount[] | null>(null);
  const [problem, setProblem] = useState<Failure | null>(null);
  const [tick, setTick] = useState(0);
  const [connecting, setConnecting] = useState(false);
  useEffect(() => {
    if (!provider) return;
    let live = true;
    setAccounts(null);
    setProblem(null);
    ads
      .accounts(company, provider, provider === "meta" ? client?.id : undefined)
      .then((list) => live && setAccounts(list))
      .catch((e) => {
        if (!live) return;
        setAccounts([]);
        setProblem(failure(e));
      });
    return () => {
      live = false;
    };
  }, [ads, company, provider, client?.id, tick, refresh]);

  const reload = () => setTick((t) => t + 1);
  // Facebook lead forms of the client (campaigns that collect leads).
  const [leadForms, setLeadForms] = useState<LinkedLeadForm[] | null>(null);
  const [leadTick, setLeadTick] = useState(0);
  const [asking, setAsking] = useState<string | null>(null);
  const [integrating, setIntegrating] = useState<string | null>(null);
  const [leadMessage, setLeadMessage] = useState("");
  useEffect(() => {
    if (provider !== "meta") return;
    let live = true;
    ads
      .leadForms(company, client?.id ?? null)
      .then((list) => live && setLeadForms(list))
      .catch(() => live && setLeadForms([]));
    return () => {
      live = false;
    };
  }, [ads, company, provider, client?.id, leadTick]);
  // Connected in another tab: read the accounts again on coming back.
  const [awaiting, setAwaiting] = useState(false);
  useEffect(() => {
    if (!awaiting) return;
    const back = () => {
      if (document.visibilityState !== "visible") return;
      setAwaiting(false);
      setTick((t) => t + 1);
    };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, [awaiting]);
  // Accounts linked, in order, each with its links.
  const groups = useMemo(() => {
    const order: string[] = [];
    for (const l of links)
      if (l.account_id && !order.includes(l.account_id))
        order.push(l.account_id);
    return order.map((id) => ({
      id,
      links: links.filter((l) => l.account_id === id),
    }));
  }, [links]);
  const available = (accounts ?? []).filter(
    (a) => !groups.some((g) => g.id === a.id),
  );

  if (!provider || manual)
    return (
      <fieldset className="campaign-links">
        <legend>Vínculos na plataforma</legend>
        <small>
          Contas de anúncio e campanhas de {platforms[platform]} de onde vêm os
          resultados deste ciclo.
          {provider && " Digite os IDs quando a conta não aparecer na busca."}
        </small>
        <ManualLinks links={links} onChange={onChange} />
        {provider && (
          <Button
            type="button"
            className="text-btn"
            onClick={() => setManual(false)}
          >
            <Search size={14} /> Buscar na plataforma
          </Button>
        )}
      </fieldset>
    );

  const connect = async () => {
    setConnecting(true);
    try {
      const started = await startConnection(ads, company, provider, true, {
        client: provider === "meta" ? client?.id : undefined,
        campaign,
      });
      if (started.pending) onPending?.(started.pending);
      else if (started.redirected) setAwaiting(true);
      else reload();
    } catch (e) {
      setProblem(failure(e));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <fieldset className="campaign-links">
      <legend>Vínculos na plataforma</legend>
      <small>
        Escolha a conta de anúncio e marque as campanhas de{" "}
        {platforms[platform]} deste ciclo. A lista vem da plataforma, na hora.
      </small>
      {problem && (
        <div className="campaign-links-problem" role="alert">
          <TriangleAlert size={16} />
          <span>
            {problem.message}
            {problem.code === "not_configured" &&
              " Até lá, digite os IDs manualmente."}
          </span>
          {(problem.code === "not_connected" || problem.code === "expired") && (
            <Button
              type="button"
              className="btn secondary"
              onClick={() => void connect()}
              disabled={connecting}
            >
              <Plug size={15} />{" "}
              {problem.code === "expired" ? "Reconectar" : "Conectar"}{" "}
              {providerName(provider)}
            </Button>
          )}
          {problem.code !== "not_configured" && (
            <Button
              type="button"
              className="icon-btn"
              aria-label="Tentar de novo"
              title="Tentar de novo (depois de conectar em outra aba)"
              onClick={reload}
            >
              <RefreshCw size={15} />
            </Button>
          )}
        </div>
      )}
      {provider === "meta" &&
        accounts !== null &&
        !accounts.length &&
        !problem && (
          <div className="campaign-links-problem" role="status">
            <TriangleAlert size={16} />
            <span>
              O Facebook de {client?.name ?? "este cliente"} ainda não está
              conectado. Entre no Facebook com o perfil do cliente e conecte: as
              contas dele aparecem aqui.
            </span>
            <Button
              type="button"
              className="btn secondary"
              onClick={() => void connect()}
              disabled={connecting || !client}
            >
              <Plug size={15} /> Conectar o Facebook do cliente
            </Button>
            <Button
              type="button"
              className="icon-btn"
              aria-label="Tentar de novo"
              title="Tentar de novo (depois de conectar em outra aba)"
              onClick={reload}
            >
              <RefreshCw size={15} />
            </Button>
          </div>
        )}
      {groups.map((g) => (
        <AccountLinks
          key={g.id}
          platform={platform}
          provider={provider}
          company={company}
          ads={ads}
          accountId={g.id}
          account={accounts?.find((a) => a.id === g.id)}
          links={g.links}
          quiet={!!problem}
          refresh={tick}
          lead={
            provider === "meta"
              ? {
                  linked: leadForms,
                  // Like the MASO: a campaign that collects leads asks for
                  // its form (when the client has none linked yet).
                  onTick: () => leadForms?.length === 0 && setAsking(g.id),
                  onIntegrate: () => setIntegrating(g.id),
                }
              : undefined
          }
          onChange={(next) =>
            onChange(groups.flatMap((x) => (x.id === g.id ? next : x.links)))
          }
          onRemove={() =>
            onChange(groups.flatMap((x) => (x.id === g.id ? [] : x.links)))
          }
        />
      ))}
      {accounts === null ? (
        <Loading compact />
      ) : (
        available.length > 0 && (
          <label className="campaign-account-pick">
            {groups.length ? "Adicionar outra conta" : "Conta de anúncio"}
            <Select
              value=""
              aria-label="Conta de anúncio"
              onValueChange={(id) => {
                const a = accounts.find((x) => x.id === id);
                if (!a) return;
                onChange([
                  ...links,
                  {
                    account_id: a.id,
                    campaign_id: "",
                    manager_id: a.manager_id,
                    account_name: a.name,
                    campaign_name: "",
                  },
                ]);
              }}
            >
              <SelectOption value="">
                Selecione a conta ({available.length})
              </SelectOption>
              {available.map((a) => (
                <SelectOption key={a.id} value={a.id}>
                  {a.name} · {accountLabel(platform, a.id)}
                  {a.status && !a.active ? ` (${a.status})` : ""}
                  {a.manager_name ? ` · ${a.manager_name}` : ""}
                </SelectOption>
              ))}
            </Select>
          </label>
        )
      )}
      <Button
        type="button"
        className="text-btn"
        onClick={() => setManual(true)}
      >
        <Keyboard size={14} /> Digitar IDs manualmente
      </Button>
      {leadMessage && (
        <p className="cell-note" role="status">
          {leadMessage}
        </p>
      )}
      {asking && (
        <LeadFormAsk
          onClose={() => setAsking(null)}
          onStart={() => {
            setIntegrating(asking);
            setAsking(null);
          }}
        />
      )}
      {integrating && (
        <LeadFormIntegration
          ads={ads}
          company={company}
          account={integrating}
          client={client}
          landingPages={landingPages}
          linked={leadForms ?? []}
          onClose={() => setIntegrating(null)}
          onChanged={(message, done) => {
            setLeadMessage(message);
            setLeadTick((t) => t + 1);
            if (done) setIntegrating(null);
          }}
        />
      )}
    </fieldset>
  );
}

/** One linked account and its campaigns, ticked from the platform's list. */
function AccountLinks({
  platform,
  provider,
  company,
  ads,
  accountId,
  account,
  links,
  quiet,
  refresh,
  lead,
  onChange,
  onRemove,
}: {
  platform: AdPlatform;
  provider: AdsProvider;
  company: string;
  ads: AdsBackend;
  accountId: string;
  account?: PlatformAccount;
  links: AdCycleLink[];
  /** The connection's problem is already shown above. */
  quiet: boolean;
  /** Changes after a new connection: read the campaigns again. */
  refresh: number;
  /** Meta: the client's Facebook lead forms, for campaigns that collect leads. */
  lead?: {
    linked: LinkedLeadForm[] | null;
    onTick: () => void;
    onIntegrate: () => void;
  };
  onChange: (links: AdCycleLink[]) => void;
  onRemove: () => void;
}) {
  const manager = account?.manager_id ?? links[0]?.manager_id ?? "";
  const name = account?.name || links[0]?.account_name || "";
  const [campaigns, setCampaigns] = useState<PlatformCampaign[] | null>(null);
  const [problem, setProblem] = useState<Failure | null>(null);
  const [query, setQuery] = useState("");
  const [onlyActive, setOnlyActive] = useState(false);
  const load = useCallback(() => {
    setCampaigns(null);
    setProblem(null);
    ads
      .campaigns(company, provider, accountId, manager)
      .then(setCampaigns)
      .catch((e) => {
        setCampaigns([]);
        setProblem(failure(e));
      });
  }, [ads, company, provider, accountId, manager]);
  useEffect(load, [load, refresh]);

  const picked = new Set(links.map((l) => l.campaign_id).filter(Boolean));
  // Linked before but gone from the platform (deleted, or no access now).
  const missing = links.filter(
    (l) => l.campaign_id && !campaigns?.some((c) => c.id === l.campaign_id),
  );
  const q = fold(query.trim());
  // Ticked campaigns stay visible under "Só ativas".
  const shown = (campaigns ?? []).filter(
    (c) =>
      (!onlyActive || c.active || picked.has(c.id)) &&
      (fold(c.name).includes(q) || c.id.includes(q)),
  );
  const base = {
    account_id: accountId,
    manager_id: manager,
    account_name: name,
  };
  const collectsLeads = (campaigns ?? []).some(
    (c) => picked.has(c.id) && isLeadObjective(c.kind),
  );
  const toggle = (c: PlatformCampaign, on: boolean) => {
    if (on && isLeadObjective(c.kind)) lead?.onTick();
    const rest = links.filter((l) => l.campaign_id && l.campaign_id !== c.id);
    const next = on
      ? [...rest, { ...base, campaign_id: c.id, campaign_name: c.name }]
      : rest;
    // No campaign ticked: the account stays, as a whole.
    onChange(
      next.length ? next : [{ ...base, campaign_id: "", campaign_name: "" }],
    );
  };

  return (
    <div className="campaign-account">
      <div className="campaign-account-head">
        <div>
          <strong>{name || "Conta de anúncio"}</strong>
          <small className="cell-note">
            {accountLabel(platform, accountId)}
            {account?.manager_name && ` · via ${account.manager_name}`}
            {account && !account.active && account.status
              ? ` · ${account.status}`
              : ""}
            {account?.expires_at &&
              ` · acesso até ${shortDate(account.expires_at)}`}
          </small>
        </div>
        <Button
          type="button"
          className="icon-btn"
          aria-label="Atualizar campanhas"
          title="Atualizar campanhas"
          onClick={load}
        >
          <RefreshCw size={14} />
        </Button>
        <Button
          type="button"
          className="icon-btn"
          aria-label={`Remover a conta ${accountLabel(platform, accountId)}`}
          title="Remover a conta deste ciclo"
          onClick={onRemove}
        >
          <Trash2 size={14} />
        </Button>
      </div>
      {lead && collectsLeads && (
        <div
          className={`campaign-lead-notice${lead.linked?.length === 0 ? " warn" : ""}`}
          role="status"
        >
          <ClipboardList size={16} />
          <span>
            <strong>Campanha de cadastros (formulário do Facebook).</strong>{" "}
            {lead.linked === null
              ? "Conferindo os formulários integrados…"
              : lead.linked.length
                ? `Integrados: ${lead.linked
                    .map(
                      (f) =>
                        `${f.form_name || f.form_id} → ${f.landing_page_id}`,
                    )
                    .join("; ")}.`
                : "Nenhum formulário integrado: os cadastros não chegam à página de captura da Make."}
          </span>
          <Button
            type="button"
            className="btn secondary"
            onClick={lead.onIntegrate}
          >
            Integrar formulário
          </Button>
        </div>
      )}
      {problem && !quiet && (
        <p className="campaign-links-problem" role="alert">
          <TriangleAlert size={15} /> <span>{problem.message}</span>
        </p>
      )}
      {campaigns === null ? (
        <Loading compact />
      ) : (
        campaigns.length > 0 && (
          <>
            <div className="campaign-account-tools">
              <span className="portfolio-search">
                <Input
                  type="search"
                  placeholder="Buscar campanha por nome ou ID"
                  aria-label="Buscar campanha"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </span>
              <label className="checkbox-label">
                <Checkbox
                  checked={onlyActive}
                  onCheckedChange={(v) => setOnlyActive(v === true)}
                />
                <span>Só ativas</span>
              </label>
            </div>
            <ul className="campaign-pick-list" aria-label="Campanhas da conta">
              {shown.map((c) => (
                <li key={c.id}>
                  <label className="checkbox-label">
                    <Checkbox
                      checked={picked.has(c.id)}
                      onCheckedChange={(v) => toggle(c, v === true)}
                    />
                    <span>
                      {c.name}
                      <small className="cell-note">
                        {c.id}
                        {c.kind && ` · ${c.kind}`}
                      </small>
                    </span>
                  </label>
                  <span className={`campaign-chip ${c.active ? "" : "muted"}`}>
                    {c.status}
                  </span>
                </li>
              ))}
              {!shown.length && (
                <li className="cell-note">Nenhuma campanha encontrada.</li>
              )}
            </ul>
          </>
        )
      )}
      {campaigns !== null && !campaigns.length && !problem && (
        <p className="cell-note">Esta conta não tem campanhas.</p>
      )}
      {missing.map((l) => (
        <p className="campaign-links-missing" key={l.campaign_id}>
          <Checkbox
            checked
            aria-label={`Desvincular ${l.campaign_name || l.campaign_id}`}
            onCheckedChange={() =>
              toggle(
                {
                  id: l.campaign_id,
                  name: l.campaign_name ?? "",
                  status: "",
                  active: false,
                  kind: "",
                },
                false,
              )
            }
          />
          <span>
            {l.campaign_name || l.campaign_id}{" "}
            <small className="cell-note">
              {l.campaign_id} ·{" "}
              {problem
                ? "vinculada neste ciclo"
                : "não aparece mais na plataforma"}
            </small>
          </span>
        </p>
      ))}
      {!picked.size && campaigns !== null && (
        <small className="cell-note">
          Nenhuma campanha marcada: o ciclo usa a conta inteira.
        </small>
      )}
    </div>
  );
}

/** Account and campaign ids typed in (any platform). */
function ManualLinks({
  links,
  onChange,
}: {
  links: AdCycleLink[];
  onChange: (links: AdCycleLink[]) => void;
}) {
  return (
    <>
      {links.map((l, i) => (
        <div className="campaign-link-row" key={i}>
          <Input
            aria-label={`Conta de anúncio ${i + 1}`}
            placeholder="Conta de anúncio"
            value={l.account_id}
            onChange={(e) =>
              onChange(
                links.map((x, j) =>
                  j === i
                    ? { ...x, account_id: e.target.value, account_name: "" }
                    : x,
                ),
              )
            }
          />
          <Input
            aria-label={`Campanha na plataforma ${i + 1}`}
            placeholder="ID da campanha (opcional)"
            value={l.campaign_id}
            onChange={(e) =>
              onChange(
                links.map((x, j) =>
                  j === i
                    ? { ...x, campaign_id: e.target.value, campaign_name: "" }
                    : x,
                ),
              )
            }
          />
          <Button
            type="button"
            className="icon-btn"
            aria-label={`Remover vínculo ${i + 1}`}
            onClick={() => onChange(links.filter((_, j) => j !== i))}
          >
            <Trash2 size={15} />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        className="text-btn"
        onClick={() =>
          onChange([...links, { account_id: "", campaign_id: "" }])
        }
      >
        <Plus size={14} /> Adicionar vínculo
      </Button>
    </>
  );
}

/** Days until an access expires (negative: expired), or null. */
const daysUntil = (value: string | null | undefined) =>
  value ? Math.ceil((Date.parse(value) - Date.now()) / 86_400_000) : null;
function ExpiryChip({
  expires,
  none,
}: {
  expires: string | null;
  none?: boolean;
}) {
  if (none) return <span className="campaign-chip warn">Sem conexão</span>;
  const days = daysUntil(expires);
  if (days === null)
    return <span className="campaign-chip current">Conectado</span>;
  return (
    <span
      className={`campaign-chip ${days <= 0 ? "danger" : days <= 7 ? "warn" : "current"}`}
      title={`Acesso até ${shortDate(expires!.slice(0, 10))}`}
    >
      {days <= 0
        ? "Acesso vencido"
        : days <= 7
          ? `Vence em ${days} ${days === 1 ? "dia" : "dias"}`
          : "Conectado"}
    </span>
  );
}

/**
 * The Facebook connection of the campaign's client, in its header: the
 * status and "Conectar o Facebook do cliente" / "Renovar".
 */
export function ClientMetaConnection({
  ads,
  company,
  client,
  campaign,
  refresh,
  onPending,
  notify,
}: {
  ads: AdsBackend;
  company: string;
  client: { id: string; name: string };
  campaign: string;
  refresh: number;
  onPending: (id: string) => void;
  notify: (message: string) => void;
}) {
  const [accounts, setAccounts] = useState<PlatformAccount[] | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    ads
      .accounts(company, "meta", client.id)
      .then((list) => {
        if (!live) return;
        setAccounts(list);
        setProblem("");
      })
      .catch((e) => {
        if (!live) return;
        setAccounts([]);
        setProblem((e as Error).message);
      });
    return () => {
      live = false;
    };
  }, [ads, company, client.id, refresh]);
  const connect = async () => {
    setBusy(true);
    try {
      const started = await startConnection(ads, company, "meta", false, {
        client: client.id,
        campaign,
      });
      if (started.pending) onPending(started.pending);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (accounts === null) return <span className="muted">…</span>;
  const soonest =
    accounts
      .map((a) => a.expires_at ?? "")
      .filter(Boolean)
      .sort()[0] ?? null;
  return (
    <span
      className="campaign-client-connection"
      title={
        problem ||
        accounts
          .map(
            (a) =>
              `${a.name} (${a.id})${a.connected_by ? ` · perfil ${a.connected_by}` : ""}`,
          )
          .join("\n")
      }
    >
      <ExpiryChip expires={soonest} none={!accounts.length} />
      <span>
        {accounts.length
          ? `Facebook do cliente: ${accounts.length} ${accounts.length === 1 ? "conta" : "contas"}`
          : problem || "Facebook do cliente não conectado"}
      </span>
      <Button
        className="text-btn"
        onClick={() => void connect()}
        disabled={busy}
        title="Entre no Facebook com o perfil deste cliente antes"
      >
        <Plug size={13} /> {accounts.length ? "Renovar" : "Conectar"}
      </Button>
    </span>
  );
}

/**
 * After the client's Facebook login: the accounts the profile sees, to tick
 * the client's (the only one comes marked). An account that already belongs
 * to another client can't be taken — one account, one client.
 */
export function MetaAccountChooser({
  ads,
  pending,
  onDone,
  onClose,
}: {
  ads: AdsBackend;
  pending: string;
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const [offer, setOffer] = useState<PendingConnection | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    ads
      .pending(pending)
      .then((p) => {
        if (!live) return;
        setOffer(p);
        const free = p.accounts.filter(
          (a) => !a.client_id || a.client_id === p.client_id,
        );
        setPicked(
          free.length === 1
            ? [free[0].account_id]
            : free
                .filter((a) => a.client_id === p.client_id)
                .map((a) => a.account_id),
        );
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [ads, pending]);
  const save = async () => {
    if (!offer) return;
    setBusy(true);
    try {
      const n = await ads.confirm(offer.id, picked);
      onDone(
        `${n} ${n === 1 ? "conta ligada" : "contas ligadas"} a ${offer.client}.`,
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Contas de anúncio do cliente"
      onClose={() => !busy && onClose()}
      busy={busy}
    >
      <div className="entity-form campaign-chooser">
        {!offer && !error && <Loading compact />}
        {offer && (
          <>
            <p className="cell-note">
              O perfil <strong>{offer.profile || "do Facebook"}</strong> enxerga{" "}
              {offer.accounts.length === 1 ? "esta conta" : "estas contas"}.
              Marque as de <strong>{offer.client}</strong>: o MAVI guarda o
              acesso delas com este perfil e usa nas campanhas do cliente.
            </p>
            <ul className="campaign-pick-list" aria-label="Contas do perfil">
              {offer.accounts.map((a) => {
                const taken = !!a.client_id && a.client_id !== offer.client_id;
                return (
                  <li key={a.account_id} className={taken ? "taken" : ""}>
                    <label className="checkbox-label">
                      <Checkbox
                        checked={picked.includes(a.account_id)}
                        disabled={taken || busy}
                        onCheckedChange={(v) =>
                          setPicked((list) =>
                            v === true
                              ? [...list, a.account_id]
                              : list.filter((x) => x !== a.account_id),
                          )
                        }
                      />
                      <span>
                        {a.name || a.account_id}
                        <small className="cell-note">
                          {a.account_id}
                          {a.currency ? ` · ${a.currency}` : ""}
                          {taken ? ` · já é do cliente ${a.client}` : ""}
                        </small>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <Button
            type="button"
            className="btn secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            className="btn primary"
            onClick={() => void save()}
            disabled={busy || !offer || !picked.length}
          >
            Ligar ao cliente
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Connections of the company with Facebook and Google Ads (admins). */
export function AdConnections({
  company,
  ads,
  onClose,
  notify,
  onOpenCampaign,
  onPending,
  refresh = 0,
}: {
  company: string;
  ads: AdsBackend;
  onClose: () => void;
  notify: (message: string) => void;
  /** Opens a campaign from the sync's error list. */
  onOpenCampaign?: (id: string) => void;
  /** A connection waiting for the client's accounts to be chosen. */
  onPending?: (id: string) => void;
  /** Bumped when a connection changed elsewhere (the chooser). */
  refresh?: number;
}) {
  const [status, setStatus] = useState<AdsStatus | null>(null);
  const [clients, setClients] = useState<MetaClient[] | null>(null);
  const [overview, setOverview] = useState<SyncOverview | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    ads
      .status(company)
      .then((s) => {
        setStatus(s);
        setError("");
        if (s.meta.configured)
          ads
            .clients(company)
            .then(setClients)
            .catch(() => setClients([]));
        else setClients([]);
      })
      .catch((e) => setError((e as Error).message));
    ads
      .overview(company)
      .then(setOverview)
      .catch(() => setOverview(null));
  }, [ads, company]);
  useEffect(load, [load, refresh]);
  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await action();
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const connect = (provider: AdsProvider, client?: string) =>
    run(`connect-${provider}-${client ?? ""}`, async () => {
      const started = await startConnection(ads, company, provider, false, {
        client,
      });
      if (started.pending) onPending?.(started.pending);
      else if (!started.redirected)
        notify(`${providerName(provider)} conectado.`);
    });
  const missing = (c: AdsConnection) =>
    c.missing?.length
      ? `Falta na Vercel (Production): ${c.missing.join(", ")}. Depois de salvar, faça um Redeploy.`
      : "Credenciais do app ainda não configuradas na Vercel.";
  const google = status?.google;
  const googleConnected = !!(google?.email || google?.connected_at);
  // Problems first: no connection, then expired or expiring within 7 days.
  const rank = (c: MetaClient) => {
    if (!c.accounts.length) return 0;
    const d = daysUntil(c.expires_at);
    return d !== null && d <= 7 ? 1 : 2;
  };
  const q = fold(query.trim());
  const listed = useMemo(
    () =>
      (clients ?? [])
        .filter(
          (c) =>
            !q ||
            fold(
              `${c.client} ${c.accounts.map((a) => `${a.name} ${a.account_id} ${a.profile}`).join(" ")}`,
            ).includes(q),
        )
        .sort(
          (a, b) =>
            rank(a) - rank(b) || a.client.localeCompare(b.client, "pt-BR"),
        ),
    [clients, q],
  );
  const unconnected = (clients ?? []).filter((c) => !c.accounts.length).length;

  return (
    <Modal
      title="Conexões e sincronização"
      onClose={onClose}
      busy={!!busy}
      wide
    >
      <div className="campaign-connections">
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        {!status && !error && <Loading compact />}
        {status && (
          <>
            <section className="campaign-connection-block">
              <header>
                <h3>Facebook (Meta Ads) — por cliente</h3>
                <p className="cell-note">
                  Cada cliente tem a sua conta de anúncio, acessada pelo perfil
                  do Facebook dele. Para conectar um cliente, entre no
                  facebook.com com o perfil dele neste navegador e clique em
                  Conectar: depois do login você marca as contas do cliente, e o
                  MAVI guarda esse acesso para as buscas e a sincronização das
                  campanhas dele. O acesso vale cerca de 60 dias; depois,
                  renove.
                </p>
              </header>
              {!status.meta.configured ? (
                <p className="campaign-links-problem">
                  <TriangleAlert size={15} />{" "}
                  <span>{missing(status.meta)}</span>
                </p>
              ) : clients === null ? (
                <Loading compact />
              ) : (
                <>
                  <div className="campaign-clients-tools">
                    <span className="portfolio-search">
                      <Input
                        type="search"
                        placeholder="Buscar cliente, conta ou perfil"
                        aria-label="Buscar cliente, conta ou perfil"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </span>
                    <small className="cell-note">
                      {clients.length}{" "}
                      {clients.length === 1 ? "cliente" : "clientes"}
                      {unconnected ? ` · ${unconnected} sem conexão` : ""}
                    </small>
                  </div>
                  {listed.length ? (
                    <ul className="campaign-profiles">
                      {listed.map((c) => (
                        <li key={c.client_id}>
                          <div className="campaign-profile-head">
                            <div>
                              <strong>{c.client}</strong>
                              <small className="cell-note">
                                {c.campaigns}{" "}
                                {c.campaigns === 1
                                  ? "campanha ativa"
                                  : "campanhas ativas"}{" "}
                                no Meta
                              </small>
                            </div>
                            <ExpiryChip
                              expires={c.expires_at}
                              none={!c.accounts.length}
                            />
                            <span className="campaign-row-actions">
                              <Button
                                type="button"
                                className={
                                  c.accounts.length
                                    ? "btn secondary"
                                    : "btn primary"
                                }
                                disabled={!!busy}
                                title="Entre no Facebook com o perfil deste cliente antes"
                                onClick={() =>
                                  void connect("meta", c.client_id)
                                }
                              >
                                {c.accounts.length ? (
                                  <RefreshCw size={14} />
                                ) : (
                                  <Plug size={14} />
                                )}{" "}
                                {c.accounts.length ? "Renovar" : "Conectar"}
                              </Button>
                              {c.accounts.length > 0 && (
                                <Button
                                  type="button"
                                  className="btn secondary"
                                  disabled={!!busy}
                                  onClick={() =>
                                    void run(
                                      `remove-${c.client_id}`,
                                      async () => {
                                        await ads.disconnect(company, "meta", {
                                          client: c.client_id,
                                        });
                                        notify(
                                          `Conexão de ${c.client} removida.`,
                                        );
                                      },
                                    )
                                  }
                                >
                                  <Unplug size={14} /> Remover
                                </Button>
                              )}
                            </span>
                          </div>
                          {c.accounts.length > 0 && (
                            <ul className="campaign-profile-accounts">
                              {c.accounts.map((a) => (
                                <li key={a.account_id}>
                                  {a.name || a.account_id}{" "}
                                  <small className="cell-note">
                                    {a.account_id}
                                    {a.profile ? ` · perfil ${a.profile}` : ""}
                                  </small>
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">
                      {q
                        ? "Nenhum cliente encontrado."
                        : "Nenhum cliente com campanha ativa no Meta ainda."}
                    </p>
                  )}
                </>
              )}
            </section>

            <section className="campaign-connection-block">
              <header>
                <h3>Google Ads</h3>
                <p className="cell-note">
                  Uma conexão só, da agência: a conta Google com acesso à MCC
                  enxerga as contas de todos os clientes. O acesso se renova
                  sozinho.
                </p>
              </header>
              {!google?.configured ? (
                <p className="campaign-links-problem">
                  <TriangleAlert size={15} /> <span>{missing(google!)}</span>
                </p>
              ) : (
                <div className="campaign-profile-head">
                  <div>
                    <strong>
                      {googleConnected
                        ? google.email || "Conectado"
                        : "Não conectado"}
                    </strong>
                    {google.connected_at && (
                      <small className="cell-note">
                        desde {shortDate(google.connected_at.slice(0, 10))}
                      </small>
                    )}
                  </div>
                  <span className="campaign-row-actions">
                    <Button
                      type="button"
                      className={
                        googleConnected ? "btn secondary" : "btn primary"
                      }
                      disabled={!!busy}
                      onClick={() => void connect("google")}
                    >
                      <Plug size={14} />{" "}
                      {googleConnected ? "Reconectar" : "Conectar"}
                    </Button>
                    {googleConnected && (
                      <Button
                        type="button"
                        className="btn secondary"
                        disabled={!!busy}
                        onClick={() =>
                          void run("disconnect-google", async () => {
                            await ads.disconnect(company, "google");
                            notify("Google Ads desconectado.");
                          })
                        }
                      >
                        <Unplug size={14} /> Desconectar
                      </Button>
                    )}
                  </span>
                </div>
              )}
            </section>
          </>
        )}

        <section className="campaign-connection-block">
          <header>
            <h3>Sincronização diária</h3>
            <p className="cell-note">
              Todos os dias, das 06:00 às 09:40, o MAVI busca no Meta e no
              Google os números de ontem (e refaz os últimos 7 dias) dos ciclos
              em andamento com contas vinculadas.
            </p>
          </header>
          {!overview ? (
            <Loading compact />
          ) : (
            <SyncSummary overview={overview} onOpenCampaign={onOpenCampaign} />
          )}
        </section>
      </div>
    </Modal>
  );
}

function SyncSummary({
  overview: o,
  onOpenCampaign,
}: {
  overview: SyncOverview;
  onOpenCampaign?: (id: string) => void;
}) {
  const when = (value: string) =>
    new Date(value).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  const scheduled = o.configured && (o.job ? o.job.active : true);
  return (
    <div className="campaign-sync-summary">
      <dl className="campaign-kpi-row">
        <div
          className="campaign-kpi"
          title={o.job ? `pg_cron: ${o.job.schedule}` : undefined}
        >
          <dt>Agendamento</dt>
          <dd className={scheduled ? "good-text" : "danger-text"}>
            {!o.configured
              ? "Não configurado"
              : o.job && !o.job.active
                ? "Pausado"
                : "Ativo"}
          </dd>
          {o.job?.last_run && (
            <small className="campaign-kpi-sub">
              Rodou {when(o.job.last_run.start_time)}
              {o.job.last_run.status !== "succeeded"
                ? ` · ${o.job.last_run.status}`
                : ""}
            </small>
          )}
        </div>
        <div className="campaign-kpi">
          <dt>Última sincronização automática</dt>
          <dd>{o.last_schedule ? when(o.last_schedule) : "Nunca"}</dd>
        </div>
        <div
          className="campaign-kpi"
          title="Ciclos em andamento (ou encerrados há até 7 dias) com contas vinculadas"
        >
          <dt>Ciclos hoje</dt>
          <dd>
            {o.synced} de {o.due}
          </dd>
          <small className="campaign-kpi-sub">
            {o.failed ? `${o.failed} com erro` : "nenhum erro"}
            {o.pending ? ` · ${o.pending} pendentes` : ""}
          </small>
        </div>
        <div
          className="campaign-kpi"
          title="Ciclos com números até ontem (ou até o fim do ciclo)"
        >
          <dt>Números em dia</dt>
          <dd className={o.up_to_date === o.due ? "good-text" : "danger-text"}>
            {o.up_to_date} de {o.due}
          </dd>
        </div>
      </dl>
      {!o.configured && (
        <p className="campaign-links-problem">
          <TriangleAlert size={15} />{" "}
          <span>
            O agendamento não está configurado: grave a URL e o segredo em
            mavi_private.ad_sync_config e rode
            supabase/operations/schedule-ads-sync.sql.
          </span>
        </p>
      )}
      {o.errors.length > 0 && (
        <div>
          <strong className="campaign-foot-label">Erros de hoje</strong>
          <ul className="campaign-sync-errors">
            {o.errors.map((e) => (
              <li key={e.campaign_id}>
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => onOpenCampaign?.(e.campaign_id)}
                >
                  {e.campaign}
                </button>
                <small className="danger-text">{e.message}</small>
              </li>
            ))}
          </ul>
        </div>
      )}
      {o.stale.length > 0 && (
        <div>
          <strong className="campaign-foot-label">
            Sem os números de ontem
          </strong>
          <ul className="campaign-sync-errors">
            {o.stale.map((e) => (
              <li key={e.campaign_id}>
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => onOpenCampaign?.(e.campaign_id)}
                >
                  {e.campaign}
                </button>
                <small className="cell-note">
                  {e.last_day
                    ? `último dia: ${shortDate(e.last_day)}`
                    : "nunca sincronizado"}
                </small>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import {
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
import {
  AdsApiError,
  platforms,
  searchablePlatform,
  shortDate,
  type AdCycleLink,
  type AdPlatform,
  type AdsBackend,
  type AdsConnection,
  type AdsProvider,
  type AdsStatus,
  type PlatformAccount,
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
 * Starts a connection. Inside a form the platform opens in a new tab so the
 * draft isn't lost (the tab is opened before the request, or browsers would
 * block it); elsewhere the page itself goes there. In the demonstration the
 * backend connects on the spot and returns no address.
 */
export async function startConnection(
  ads: AdsBackend,
  company: string,
  provider: AdsProvider,
  newTab: boolean,
) {
  const tab = newTab ? window.open("", "_blank") : null;
  try {
    const url = await ads.connect(company, provider);
    if (!url) {
      tab?.close();
      return false;
    }
    if (tab) tab.location.href = url;
    else window.location.assign(url);
    return true;
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
  links,
  onChange,
}: {
  platform: AdPlatform;
  company: string;
  ads: AdsBackend;
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
      .accounts(company, provider)
      .then((list) => live && setAccounts(list))
      .catch((e) => {
        if (!live) return;
        setAccounts([]);
        setProblem(failure(e));
      });
    return () => {
      live = false;
    };
  }, [ads, company, provider, tick]);

  const reload = () => setTick((t) => t + 1);
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
      const redirected = await startConnection(ads, company, provider, true);
      if (!redirected) reload();
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
  const toggle = (c: PlatformCampaign, on: boolean) => {
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

/** Connections of the company with Facebook and Google Ads (admins). */
export function AdConnections({
  company,
  ads,
  onClose,
  notify,
}: {
  company: string;
  ads: AdsBackend;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const [status, setStatus] = useState<AdsStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<AdsProvider | null>(null);
  const load = useCallback(() => {
    ads
      .status(company)
      .then((s) => {
        setStatus(s);
        setError("");
      })
      .catch((e) => setError((e as Error).message));
  }, [ads, company]);
  useEffect(load, [load]);
  const act = async (provider: AdsProvider, what: "connect" | "disconnect") => {
    setBusy(provider);
    try {
      if (what === "connect") {
        if (await startConnection(ads, company, provider, false)) return;
        notify(`${providerName(provider)} conectado.`);
      } else {
        await ads.disconnect(company, provider);
        notify(`${providerName(provider)} desconectado.`);
      }
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const describe = (provider: AdsProvider, c: AdsConnection) => {
    if (!c.configured)
      return c.missing?.length
        ? `Não configurado no servidor. Falta na Vercel (Production): ${c.missing.join(", ")}. Depois de salvar, faça um Redeploy.`
        : "Ainda não configurado no servidor (credenciais do app na Vercel).";
    if (provider === "meta")
      return c.accounts
        ? `${c.accounts} ${c.accounts === 1 ? "conta de anúncio" : "contas de anúncio"}, por ${(c.people ?? []).join(", ") || "—"}${c.expires_at ? `. O primeiro acesso vence em ${shortDate(c.expires_at)}` : ""}.`
        : "Não conectado.";
    return c.email
      ? `Conta da agência: ${c.email}.`
      : c.connected_at
        ? "Conectado."
        : "Não conectado.";
  };
  const connected = (provider: AdsProvider, c: AdsConnection) =>
    provider === "meta" ? !!c.accounts : !!(c.email || c.connected_at);
  return (
    <Modal title="Conexões com as plataformas" onClose={onClose} busy={!!busy}>
      <div className="campaign-connections">
        <p className="cell-note">
          Como no MASO: no Facebook, cada administrador que conecta dá acesso às
          contas de anúncio que ele enxerga (o acesso vale cerca de 60 dias); no
          Google Ads, uma conta da agência com acesso à MCC. Os tokens ficam
          cifrados no servidor.
        </p>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        {!status && !error && <Loading compact />}
        {status &&
          (["meta", "google"] as AdsProvider[]).map((p) => (
            <div className="campaign-connection" key={p}>
              <div>
                <strong>{providerName(p)}</strong>
                <small className="cell-note">{describe(p, status[p])}</small>
              </div>
              {status[p].configured && (
                <span className="campaign-row-actions">
                  <Button
                    type="button"
                    className={
                      connected(p, status[p]) ? "btn secondary" : "btn primary"
                    }
                    disabled={!!busy}
                    onClick={() => void act(p, "connect")}
                  >
                    <Plug size={15} />{" "}
                    {connected(p, status[p]) ? "Reconectar" : "Conectar"}
                  </Button>
                  {connected(p, status[p]) && (
                    <Button
                      type="button"
                      className="btn secondary"
                      disabled={!!busy}
                      onClick={() => void act(p, "disconnect")}
                    >
                      <Unplug size={15} /> Desconectar
                    </Button>
                  )}
                </span>
              )}
            </div>
          ))}
      </div>
    </Modal>
  );
}

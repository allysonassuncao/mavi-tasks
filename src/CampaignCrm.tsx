import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Link2, TriangleAlert, Unlink } from "lucide-react";
import { Button, Input, Loading } from "./ui";
import { fold } from "./domain";
import { rpc } from "./api";
import { supabase } from "./supabase";
import type { Client } from "./types";
import { ConnectionFilter, ConnectionHeader } from "./CampaignLinks";
import { demoCrmUtm, type CrmUtm } from "./platform-crm";

/**
 * Campanhas › Abrir no CRM (migração 20270320090000_makecrm_links): um
 * clique abre o MakeCRM do cliente numa aba nova, já logado. Cada pessoa tem
 * o próprio login em cada empresa do CRM, criado no primeiro clique, com o
 * papel que tem no MAVI (administrador → Admin, gestor → Gerente,
 * colaborador → Equipe Interna, que só olha). Administradores e gestores
 * ligam cada cliente à empresa dele no CRM, em Campanhas › Conexões.
 */
export type CrmCompany = {
  id: string;
  make_id: number | null;
  active: boolean;
  admins: { name: string; email: string }[];
};
export type CrmClient = {
  client_id: string;
  name: string;
  crm_company_id: string | null;
  crm_label: string | null;
  /** Os códigos da Make dos formulários de leads do cliente (sugestão). */
  make_ids: string[];
};
export type CrmBackend = {
  /** Os clientes com CRM ligado que a pessoa vê: cliente → empresa. */
  links: (company: string) => Promise<Record<string, string>>;
  clients: (company: string) => Promise<CrmClient[]>;
  companies: (company: string) => Promise<CrmCompany[]>;
  link: (
    company: string,
    client: string,
    crm: string,
    label: string,
  ) => Promise<void>;
  unlink: (company: string, client: string) => Promise<void>;
  /** O link de entrada, de uso único (next: o funil já filtrado). */
  open: (company: string, client: string, next?: string) => Promise<string>;
  /** Oportunidades e ganhos por UTM no período (Campanhas › Plataforma). */
  utm: (
    company: string,
    client: string,
    since: string,
    until: string,
  ) => Promise<CrmUtm>;
};

/** Como a empresa aparece: no MakeCRM ela não tem nome, só o código da Make. */
export function crmLabel(c: CrmCompany) {
  const admin = c.admins[0];
  return [
    c.make_id !== null ? `Código Make ${c.make_id}` : "Sem código da Make",
    admin
      ? `${admin.name || admin.email}${admin.name && admin.email ? ` (${admin.email})` : ""}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export async function crmServer<T>(body: Record<string, unknown>): Promise<T> {
  if (!supabase) throw Error("Supabase não configurado");
  const call = async () => {
    const token = (await supabase!.auth.getSession()).data.session
      ?.access_token;
    return fetch("/api/crm", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  };
  let res = await call();
  if (res.status === 401) {
    await supabase.auth.refreshSession();
    res = await call();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw Error(data.error ?? "Não foi possível falar com o servidor.");
  return data as T;
}

export const serverCrm: CrmBackend = {
  async links(company) {
    if (!supabase) return {};
    const { data, error } = await supabase
      .from("client_crm_links")
      .select("client_id, crm_label")
      .eq("company_id", company);
    if (error) throw error;
    return Object.fromEntries(
      (data ?? []).map((r) => [
        r.client_id as string,
        (r.crm_label as string) ?? "",
      ]),
    );
  },
  clients: async (company) =>
    ((await rpc("crm_link_clients", { p_company: company })) ??
      []) as CrmClient[],
  companies: async (company) =>
    (
      await crmServer<{ companies: CrmCompany[] }>({
        action: "companies",
        company,
      })
    ).companies,
  link: async (company, client, crm, label) => {
    await rpc("crm_link_set", {
      p_company: company,
      p_client: client,
      p_crm_company: crm,
      p_label: label,
    });
  },
  unlink: async (company, client) => {
    await rpc("crm_link_remove", { p_company: company, p_client: client });
  },
  open: async (company, client, next) =>
    (
      await crmServer<{ url: string }>({
        action: "open",
        company,
        client,
        ...(next ? { next } : {}),
      })
    ).url,
  utm: (company, client, since, until) =>
    crmServer<CrmUtm>({ action: "utm", company, client, since, until }),
};

/** Demonstração: empresas inventadas, ligações em memória, nada abre. */
export function demoCrm(clients: () => Client[]): CrmBackend {
  const linked = new Map<string, string>();
  const fake = (): CrmCompany[] =>
    clients()
      .filter((c) => !c.archived)
      .map((c, i) => ({
        id: `00000000-0000-4000-9000-${String(i + 1).padStart(12, "0")}`,
        make_id: 4000 + i,
        active: true,
        admins: [
          {
            name: c.name,
            email: `contato@${fold(c.name).replace(/[^a-z0-9]+/g, "")}.com.br`,
          },
        ],
      }));
  return {
    links: async () =>
      Object.fromEntries([...linked].map(([client, crm]) => [client, crm])),
    clients: async () =>
      clients()
        .filter((c) => !c.archived)
        .map((c) => ({
          client_id: c.id,
          name: c.name,
          crm_company_id: linked.has(c.id) ? "demo" : null,
          crm_label: linked.get(c.id) ?? null,
          make_ids: [],
        })),
    companies: async () => fake(),
    link: async (_company, client, _crm, label) => {
      linked.set(client, label);
    },
    unlink: async (_company, client) => {
      linked.delete(client);
    },
    open: async () => {
      throw Error("Na demonstração o MakeCRM não abre.");
    },
    utm: async () => demoCrmUtm(),
  };
}

/**
 * Abre o MakeCRM do cliente numa aba nova, já logado (next: uma tela dele,
 * como o funil filtrado). A aba abre já no clique (senão o navegador a
 * bloqueia) e vai para o MakeCRM quando o link de entrada chega.
 */
export async function openCrmTab({
  backend,
  company,
  client,
  clientName,
  notify,
  next,
}: {
  backend: CrmBackend;
  company: string;
  client: string;
  clientName: string;
  notify: (message: string) => void;
  next?: string;
}) {
  const tab = window.open("", "_blank");
  if (tab) {
    tab.document.title = "Abrindo o MakeCRM…";
    const p = tab.document.createElement("p");
    p.textContent = `Abrindo o MakeCRM de ${clientName}…`;
    p.style.cssText =
      "font: 15px system-ui, sans-serif; color: #44504a; margin: 40px; text-align: center";
    tab.document.body.appendChild(p);
  }
  try {
    const url = await backend.open(company, client, next);
    if (tab && !tab.closed) {
      tab.opener = null;
      tab.location.replace(url);
    } else if (!window.open(url, "_blank", "noopener")) {
      notify(
        "O navegador bloqueou a aba nova: permita pop-ups do MAVI e clique de novo.",
      );
    }
  } catch (e) {
    tab?.close();
    notify((e as Error).message);
  }
}

/**
 * "Abrir no CRM": a aba nova abre já no clique (senão o navegador a
 * bloqueia) e vai para o MakeCRM quando o link de entrada chega.
 */
export function OpenInCrm({
  backend,
  company,
  client,
  clientName,
  notify,
  compact = false,
}: {
  backend: CrmBackend;
  company: string;
  client: string;
  clientName: string;
  notify: (message: string) => void;
  /** Só o ícone (a linha da lista). */
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    if (busy) return;
    setBusy(true);
    await openCrmTab({ backend, company, client, clientName, notify });
    setBusy(false);
  };
  const title = `Abrir o MakeCRM de ${clientName} numa aba nova, já logado`;
  return compact ? (
    <button
      type="button"
      className="text-btn campaign-crm-icon"
      title={title}
      aria-label={title}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        void open();
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <ExternalLink size={14} /> CRM
    </button>
  ) : (
    <Button
      className="btn crm-open"
      onClick={() => void open()}
      loading={busy}
      title={title}
    >
      <ExternalLink size={15} /> Abrir no CRM
    </Button>
  );
}

/** Campanhas › Conexões: qual empresa do MakeCRM é de cada cliente. */
export function CrmConnections({
  backend,
  company,
  notify,
  onChange,
  onSummary,
}: {
  backend: CrmBackend;
  company: string;
  notify: (message: string) => void;
  /** Uma ligação mudou (o botão aparece ou some). */
  onChange: () => void;
  /** Quantos clientes e quantos sem ligação (o menu das Conexões). */
  onSummary?: (summary: { total: number; unlinked: number }) => void;
}) {
  const [clients, setClients] = useState<CrmClient[] | null>(null);
  const [companies, setCompanies] = useState<CrmCompany[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [picking, setPicking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () =>
    backend
      .clients(company)
      .then(setClients)
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, company]);
  const pick = (client: string) => {
    setPicking(picking === client ? null : client);
    if (!companies)
      backend
        .companies(company)
        .then(setCompanies)
        .catch((e) => {
          setPicking(null);
          setError((e as Error).message);
        });
  };
  const run = async (action: () => Promise<void>, done: string) => {
    setBusy(true);
    setError("");
    try {
      await action();
      notify(done);
      setPicking(null);
      onChange();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const q = fold(query.trim());
  const listed = useMemo(
    () =>
      (clients ?? [])
        .filter((c) => !q || fold(`${c.name} ${c.crm_label ?? ""}`).includes(q))
        .sort(
          (a, b) =>
            Number(!!a.crm_company_id) - Number(!!b.crm_company_id) ||
            a.name.localeCompare(b.name, "pt-BR"),
        ),
    [clients, q],
  );
  const unlinked = (clients ?? []).filter((c) => !c.crm_company_id).length;
  useEffect(() => {
    if (clients) onSummary?.({ total: clients.length, unlinked });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients, unlinked]);
  // Sem ligação primeiro, até a pessoa escolher.
  const [filter, setFilter] = useState<"unlinked" | "linked" | "all" | null>(
    null,
  );
  const shown = filter ?? (unlinked ? "unlinked" : "all");
  const rows = listed.filter((c) =>
    shown === "all"
      ? true
      : shown === "linked"
        ? !!c.crm_company_id
        : !c.crm_company_id,
  );

  return (
    <>
      <ConnectionHeader
        title="MakeCRM"
        lead="Ligue cada cliente à empresa dele no MakeCRM: a campanha ganha o botão Abrir no CRM."
      >
        Um clique em Abrir no CRM abre o CRM do cliente numa aba nova, já
        logado, com um login da pessoa criado no primeiro acesso. Administrador
        entra como Admin, gestor como Gerente e colaborador só olha. No MakeCRM
        a empresa não tem nome: ela aparece pelo código da Make e pelo
        administrador dela.
      </ConnectionHeader>
      {error && (
        <p className="campaign-links-problem" role="alert">
          <TriangleAlert size={15} /> <span>{error}</span>
        </p>
      )}
      {clients === null ? (
        !error && <Loading variant="list" />
      ) : (
        <>
          <div className="connections-tools">
            <span className="portfolio-search">
              <Input
                type="search"
                placeholder="Buscar cliente"
                aria-label="Buscar cliente para ligar ao MakeCRM"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </span>
            <ConnectionFilter
              value={shown}
              onChange={setFilter}
              options={[
                { value: "unlinked", label: "Sem ligação", count: unlinked },
                {
                  value: "linked",
                  label: "Ligados",
                  count: clients.length - unlinked,
                },
                { value: "all", label: "Todos", count: clients.length },
              ]}
            />
          </div>
          {rows.length ? (
            <ul className="campaign-profiles connections-list">
              {rows.map((c) => (
                <li key={c.client_id}>
                  <div className="campaign-profile-head">
                    <div>
                      <strong>{c.name}</strong>
                      <small className="cell-note">
                        {c.crm_company_id
                          ? c.crm_label || "Ligado ao MakeCRM"
                          : "Sem ligação com o MakeCRM"}
                      </small>
                    </div>
                    <span className="campaign-row-actions">
                      <Button
                        type="button"
                        className={
                          c.crm_company_id ? "btn secondary" : "btn primary"
                        }
                        disabled={busy}
                        onClick={() => pick(c.client_id)}
                      >
                        <Link2 size={14} />{" "}
                        {c.crm_company_id ? "Trocar" : "Ligar"}
                      </Button>
                      {c.crm_company_id && (
                        <Button
                          type="button"
                          className="btn secondary"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () => backend.unlink(company, c.client_id),
                              `${c.name} desligado do MakeCRM.`,
                            )
                          }
                        >
                          <Unlink size={14} /> Remover
                        </Button>
                      )}
                    </span>
                  </div>
                  {picking === c.client_id && (
                    <CrmCompanyPicker
                      client={c}
                      companies={companies}
                      busy={busy}
                      onPick={(crm) =>
                        void run(
                          () =>
                            backend.link(
                              company,
                              c.client_id,
                              crm.id,
                              crmLabel(crm),
                            ),
                          `${c.name} ligado ao MakeCRM.`,
                        )
                      }
                    />
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="connections-empty">
              {q
                ? "Nenhum cliente encontrado."
                : shown === "unlinked"
                  ? "Todos os clientes já estão ligados ao MakeCRM."
                  : shown === "linked"
                    ? "Nenhum cliente ligado ao MakeCRM ainda."
                    : "Nenhum cliente com campanha ainda."}
            </p>
          )}
        </>
      )}
    </>
  );
}

const SHOWN = 50;

function CrmCompanyPicker({
  client,
  companies,
  busy,
  onPick,
}: {
  client: CrmClient;
  companies: CrmCompany[] | null;
  busy: boolean;
  onPick: (crm: CrmCompany) => void;
}) {
  const [query, setQuery] = useState("");
  const q = fold(query.trim());
  const suggested = (c: CrmCompany) =>
    c.make_id !== null && client.make_ids.includes(String(c.make_id));
  const matches = useMemo(
    () =>
      (companies ?? [])
        .filter(
          (c) =>
            !q ||
            fold(
              `${c.make_id ?? ""} ${c.admins.map((a) => `${a.name} ${a.email}`).join(" ")}`,
            ).includes(q),
        )
        .sort(
          (a, b) =>
            Number(suggested(b)) - Number(suggested(a)) ||
            Number(b.active) - Number(a.active) ||
            (b.make_id ?? 0) - (a.make_id ?? 0),
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [companies, q, client],
  );
  if (!companies) return <Loading variant="list" />;
  return (
    <div className="campaign-crm-picker">
      <span className="portfolio-search">
        <Input
          type="search"
          autoFocus
          placeholder="Código da Make, nome ou e-mail do administrador"
          aria-label={`Buscar a empresa de ${client.name} no MakeCRM`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </span>
      <ul className="campaign-pick-list" aria-label="Empresas do MakeCRM">
        {matches.slice(0, SHOWN).map((c) => (
          <li
            key={c.id}
            className={c.id === client.crm_company_id ? "taken" : ""}
          >
            <span>
              {crmLabel(c)}
              {c.admins.length > 1 && (
                <small className="cell-note">
                  {" "}
                  e mais {c.admins.length - 1}{" "}
                  {c.admins.length === 2 ? "administrador" : "administradores"}
                </small>
              )}
            </span>
            <span className="campaign-row-actions">
              {suggested(c) && (
                <span className="campaign-chip">Mesmo código da Make</span>
              )}
              {!c.active && (
                <span className="campaign-chip muted">Inativa</span>
              )}
              <Button
                type="button"
                className="btn secondary"
                disabled={busy || c.id === client.crm_company_id}
                onClick={() => onPick(c)}
              >
                {c.id === client.crm_company_id ? "Ligada" : "Escolher"}
              </Button>
            </span>
          </li>
        ))}
        {!matches.length && (
          <li className="cell-note">Nenhuma empresa encontrada.</li>
        )}
        {matches.length > SHOWN && (
          <li className="cell-note">
            Mais {matches.length - SHOWN} empresas: busque pelo código ou pelo
            administrador.
          </li>
        )}
      </ul>
    </div>
  );
}

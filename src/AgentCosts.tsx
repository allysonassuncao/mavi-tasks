import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Input, Loading, Select, SelectOption } from "./ui";
import {
  agentOp,
  builderCosts,
  COST_GROUP_LABEL,
  COST_GROUPS,
  COST_SOURCE_LABEL,
  dayMonth,
  errorOf,
  lastDays,
  money,
  rateOn,
  wabaPrices,
  ymdDaysAgo,
  type AgentBinding,
  type CostFilters,
  type CostGroupKey,
  type CostReport,
  type WabaPrice,
} from "./agent-builder";
import { ConversationInsightModal } from "./AgentConversationModal";
import type { Snapshot } from "./types";

/**
 * Agentes MAVI › Custos: cada gasto do agente (respostas da IA, áudios,
 * imagens, vídeos, busca no conhecimento, análises, modelos aprovados do
 * WhatsApp oficial, testes) por dia, tipo, modelo, caixa, conversa, agente e
 * cliente, em R$ (PTAX do dia) e US$.
 */

type Currency = "brl" | "usd";
type Period = { from: string; to: string };
type GroupChoice = CostFilters["group"] | "client";

/** Este mês e o mês passado, em Brasília. */
function monthPeriod(offset: 0 | -1): Period {
  const today = ymdDaysAgo(0);
  const [y, m] = today.split("-").map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1 + offset, 1));
  const last = offset === 0 ? today : new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
  return { from: first.toISOString().slice(0, 10), to: last };
}
const PERIODS: { id: string; label: string; get: () => Period }[] = [
  { id: "7", label: "7 dias", get: () => lastDays(7) },
  { id: "30", label: "30 dias", get: () => lastDays(30) },
  { id: "90", label: "90 dias", get: () => lastDays(90) },
  { id: "month", label: "Este mês", get: () => monthPeriod(0) },
  { id: "last", label: "Mês passado", get: () => monthPeriod(-1) },
];
const GROUP_COLORS: Record<CostGroupKey, string> = {
  ia: "#3e6f6e",
  midias: "#8bb5a8",
  conhecimento: "#c9b56b",
  analises: "#9b8ec4",
  whatsapp: "#4f9a72",
  testes: "#c98b6b",
};

export function CostsView({
  load,
  mode,
  agents,
  clients,
  inboxes,
  onOpenConversation,
}: {
  load: (f: CostFilters) => Promise<CostReport>;
  mode: "agent" | "all";
  agents?: { id: string; name: string; client_id: string | null }[];
  clients?: { id: string; name: string }[];
  inboxes?: { id: string; name: string }[];
  onOpenConversation?: (id: string) => void;
}) {
  const [periodId, setPeriodId] = useState("30");
  const [period, setPeriod] = useState<Period>(() => lastDays(30));
  const [currency, setCurrency] = useState<Currency>("brl");
  const [groups, setGroups] = useState<CostGroupKey[]>([]);
  const [simulation, setSimulation] = useState<"exclude" | "include" | "only">("exclude");
  const [group, setGroup] = useState<GroupChoice>(mode === "all" ? "agent" : "source");
  const [client, setClient] = useState("");
  const [agent, setAgent] = useState("");
  const [inbox, setInbox] = useState("");
  const [data, setData] = useState<CostReport | null>(null);
  const [error, setError] = useState("");

  const filters = useMemo<CostFilters>(
    () => ({
      ...period,
      group: group === "client" ? "agent" : group,
      sources: groups.length ? COST_GROUPS.filter((g) => groups.includes(g.key)).flatMap((g) => g.sources) : undefined,
      simulation,
      inbox_ids: inbox ? [inbox] : undefined,
      clients: client ? [client] : undefined,
      agents: agent ? [agent] : undefined,
    }),
    [period, group, groups, simulation, inbox, client, agent],
  );
  const reload = useCallback(() => {
    setData(null);
    load(filters)
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((e) => setError(errorOf(e)));
  }, [load, filters]);
  useEffect(reload, [reload]);

  const value = (x: { cost_usd: number; cost_brl: number } | null | undefined) => (x ? (currency === "usd" ? x.cost_usd : x.cost_brl) : 0);
  const fmt = (n: number) => money(n, currency);
  const other = (x: { cost_usd: number; cost_brl: number } | null | undefined) => money(currency === "usd" ? x?.cost_brl : x?.cost_usd, currency === "usd" ? "brl" : "usd");
  const noRates = currency === "brl" && data && !Object.keys(data.rates).length;

  // Por cliente: as linhas por agente somadas pelo cliente de cada agente.
  const rows = useMemo(() => {
    if (!data) return [];
    if (group !== "client") return data.rows;
    const byClient = new Map<string, (typeof data.rows)[number]>();
    for (const r of data.rows) {
      const a = (data.agents ?? agents ?? []).find((x) => x.id === r.key);
      const k = a?.client_id ?? "";
      const name = clients?.find((c) => c.id === k)?.name ?? "Sem cliente";
      const cur = byClient.get(k);
      byClient.set(k, cur ? { ...cur, events: cur.events + r.events, cost_usd: cur.cost_usd + r.cost_usd, cost_brl: cur.cost_brl + r.cost_brl, tokens_in: cur.tokens_in + r.tokens_in, tokens_out: cur.tokens_out + r.tokens_out } : { ...r, key: k, label: name });
    }
    return [...byClient.values()].sort((a, b) => b.cost_usd - a.cost_usd);
  }, [data, group, agents, clients]);

  const t = data?.totals;
  const total = value(t);
  const msgs = data?.messages;
  const whatsapp = (data?.daily ?? []).filter((d) => d.group === "whatsapp").reduce((s, d) => s + value(d), 0);
  const ia = (data?.daily ?? []).filter((d) => d.group === "ia").reduce((s, d) => s + value(d), 0);
  const media = (data?.daily ?? []).filter((d) => d.group === "midias").reduce((s, d) => s + value(d), 0);
  const days = Math.round((Date.parse(period.to) - Date.parse(period.from)) / 86_400_000) + 1;
  const rateValues = Object.values(data?.rates ?? {});
  const groupChoices: { id: GroupChoice; label: string }[] = [
    ...(mode === "all"
      ? [
          { id: "agent" as const, label: "Agente" },
          { id: "client" as const, label: "Cliente" },
        ]
      : []),
    { id: "source", label: "Tipo" },
    { id: "day", label: "Dia" },
    { id: "model", label: "Modelo" },
    { id: "inbox", label: "Caixa" },
    ...(mode === "agent" ? [{ id: "conversation" as const, label: "Conversa" }] : []),
  ];
  const rowLabel = (r: { key: string; label: string | null }) =>
    group === "source"
      ? (COST_SOURCE_LABEL[r.key] ?? r.key)
      : group === "day"
        ? dayMonth(r.key)
        : group === "model"
          ? r.key || "—"
          : group === "agent"
            ? (r.label ?? (data?.agents ?? agents ?? []).find((a) => a.id === r.key)?.name ?? r.key)
            : group === "inbox"
              ? (r.label ?? (r.key ? r.key : "Sem caixa (testes, conhecimento)"))
              : (r.label ?? r.key) || "—";

  return (
    <div className="ab-stack">
      <div className="ab-toolbar">
        <div className="ab-chips" role="group" aria-label="Período">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={periodId === p.id ? "selected" : ""}
              onClick={() => {
                setPeriodId(p.id);
                setPeriod(p.get());
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <span className="ab-toolbar-right">
          <span className="ab-chips" role="group" aria-label="Moeda">
            <button type="button" className={currency === "brl" ? "selected" : ""} onClick={() => setCurrency("brl")}>
              R$
            </button>
            <button type="button" className={currency === "usd" ? "selected" : ""} onClick={() => setCurrency("usd")}>
              US$
            </button>
          </span>
          <button type="button" className="agent-link-btn" onClick={reload}>
            Atualizar
          </button>
        </span>
      </div>

      <div className="cost-filters">
        {mode === "all" && (
          <>
            <Select value={client} aria-label="Cliente" onValueChange={(v) => setClient(v)}>
              <SelectOption value="">Todos os clientes</SelectOption>
              {(clients ?? [])
                .filter((c) => (data?.agents ?? agents ?? []).some((a) => a.client_id === c.id))
                .map((c) => (
                  <SelectOption key={c.id} value={c.id}>
                    {c.name}
                  </SelectOption>
                ))}
            </Select>
            <Select value={agent} aria-label="Agente" onValueChange={(v) => setAgent(v)}>
              <SelectOption value="">Todos os agentes</SelectOption>
              {(data?.agents ?? agents ?? [])
                .filter((a) => !client || a.client_id === client)
                .map((a) => (
                  <SelectOption key={a.id} value={a.id}>
                    {a.name}
                  </SelectOption>
                ))}
            </Select>
          </>
        )}
        {mode === "agent" && (inboxes?.length ?? 0) > 1 && (
          <Select value={inbox} aria-label="Caixa" onValueChange={(v) => setInbox(v)}>
            <SelectOption value="">Todas as caixas</SelectOption>
            {(inboxes ?? []).map((i) => (
              <SelectOption key={i.id} value={i.id}>
                {i.name}
              </SelectOption>
            ))}
          </Select>
        )}
        <Select value={simulation} aria-label="Testes" onValueChange={(v) => setSimulation(v as typeof simulation)}>
          <SelectOption value="exclude">Só conversas reais</SelectOption>
          <SelectOption value="include">Reais + testes</SelectOption>
          <SelectOption value="only">Só testes e simulações</SelectOption>
        </Select>
        <div className="ab-chips" role="group" aria-label="Tipos de gasto">
          {COST_GROUPS.map((g) => (
            <button
              key={g.key}
              type="button"
              className={groups.includes(g.key) ? "selected" : ""}
              onClick={() => setGroups((cur) => (cur.includes(g.key) ? cur.filter((x) => x !== g.key) : [...cur, g.key]))}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      {!data && !error && <Loading variant="page" />}
      {data && (
        <>
          {noRates && <p className="ab-notice warn">Ainda sem cotação do dólar (PTAX) guardada: os valores em R$ aparecem depois da próxima leitura, de hora em hora.</p>}
          <div className="ab-kpis">
            <div>
              <span className="muted">Total no período</span>
              <strong>{fmt(total)}</strong>
              <small className="muted">{other(t)}</small>
            </div>
            <div title="O total dividido pelas conversas com mensagem do lead no período.">
              <span className="muted">Por conversa</span>
              <strong>{msgs?.conversations ? fmt(total / msgs.conversations) : "—"}</strong>
              <small className="muted">{msgs?.conversations ?? 0} conversa(s)</small>
            </div>
            <div title="O total dividido pelas mensagens que os leads mandaram no período.">
              <span className="muted">Por mensagem do lead</span>
              <strong>{msgs?.lead_messages ? fmt(total / msgs.lead_messages) : "—"}</strong>
              <small className="muted">{msgs?.lead_messages ?? 0} mensagem(ns)</small>
            </div>
            <div>
              <span className="muted">IA nas conversas</span>
              <strong>{fmt(ia)}</strong>
            </div>
            <div>
              <span className="muted">Mídias</span>
              <strong>{fmt(media)}</strong>
            </div>
            <div title="Modelos aprovados enviados (preço da tabela no Painel da MAVI).">
              <span className="muted">WhatsApp oficial</span>
              <strong>{fmt(whatsapp)}</strong>
            </div>
            <div>
              <span className="muted">Média por dia</span>
              <strong>{fmt(total / days)}</strong>
            </div>
            {rateValues.length > 0 && (
              <div title="PTAX de venda do Banco Central de cada dia (fim de semana e feriado: a do último dia útil).">
                <span className="muted">Dólar (PTAX)</span>
                <strong>
                  {Math.min(...rateValues).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                  {Math.max(...rateValues) !== Math.min(...rateValues) &&
                    ` – ${Math.max(...rateValues).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`}
                </strong>
              </div>
            )}
          </div>

          <DailyChart data={data} period={period} value={value} fmt={fmt} />

          <section className="ab-section">
            <div className="ab-toolbar">
              <h3>Detalhe</h3>
              <div className="ab-chips" role="group" aria-label="Agrupar por">
                {groupChoices.map((g) => (
                  <button key={g.id} type="button" className={group === g.id ? "selected" : ""} onClick={() => setGroup(g.id)}>
                    {g.label}
                  </button>
                ))}
              </div>
            </div>
            {!rows.length ? (
              <p className="muted ai-small">Nenhum gasto no período com estes filtros.</p>
            ) : (
              <div className="cost-table-wrap">
                <table className="cost-table">
                  <thead>
                    <tr>
                      <th>{groupChoices.find((g) => g.id === group)?.label}</th>
                      <th className="num">Registros</th>
                      <th className="num">Tokens (entrada / saída)</th>
                      <th className="num">Custo</th>
                      <th className="num">%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key}>
                        <td>
                          {group === "conversation" && onOpenConversation && r.key ? (
                            <button type="button" className="agent-link-btn" onClick={() => onOpenConversation(r.key)}>
                              {rowLabel(r)}
                            </button>
                          ) : (
                            rowLabel(r)
                          )}
                        </td>
                        <td className="num">{r.events.toLocaleString("pt-BR")}</td>
                        <td className="num">
                          {Number(r.tokens_in).toLocaleString("pt-BR")} / {Number(r.tokens_out).toLocaleString("pt-BR")}
                        </td>
                        <td className="num" title={other(r)}>
                          {fmt(value(r))}
                        </td>
                        <td className="num">{total ? `${Math.round((value(r) / total) * 100)}%` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function DailyChart({
  data,
  period,
  value,
  fmt,
}: {
  data: CostReport;
  period: Period;
  value: (x: { cost_usd: number; cost_brl: number }) => number;
  fmt: (n: number) => string;
}) {
  const days: string[] = [];
  for (let d = Date.parse(period.from); d <= Date.parse(period.to); d += 86_400_000) days.push(new Date(d).toISOString().slice(0, 10));
  const present = COST_GROUPS.filter((g) => data.daily.some((d) => d.group === g.key && value(d) > 0));
  const perDay = days.map((day) => ({
    day,
    parts: present.map((g) => ({ g: g.key, v: data.daily.filter((d) => d.day === day && d.group === g.key).reduce((s, d) => s + value(d), 0) })),
  }));
  const max = Math.max(...perDay.map((d) => d.parts.reduce((s, p) => s + p.v, 0)), 0);
  if (!max) return null;
  return (
    <section className="ab-section">
      <div className="ab-toolbar">
        <h3>Gasto por dia</h3>
        <span className="cost-legend">
          {present.map((g) => (
            <span key={g.key}>
              <i style={{ background: GROUP_COLORS[g.key] }} /> {g.label}
            </span>
          ))}
        </span>
      </div>
      <div className="cost-days" role="img" aria-label="Gasto por dia">
        {perDay.map((d) => {
          const sum = d.parts.reduce((s, p) => s + p.v, 0);
          return (
            <span key={d.day} title={`${dayMonth(d.day)}: ${fmt(sum)}\n${d.parts.filter((p) => p.v).map((p) => `${COST_GROUP_LABEL[p.g]}: ${fmt(p.v)}`).join("\n")}`}>
              {d.parts.map((p) => (
                <i key={p.g} style={{ height: `${(p.v / max) * 100}%`, background: GROUP_COLORS[p.g] }} />
              ))}
            </span>
          );
        })}
      </div>
      <div className="ai-axis muted">
        <span>{dayMonth(days[0]!)}</span>
        <span>{dayMonth(days[days.length - 1]!)}</span>
      </div>
    </section>
  );
}

// ------------------------------------------------------------ no agente
export function AgentCostsPanel({ company, agentId, bindings }: { company: string; agentId: string; bindings: AgentBinding[] }) {
  const [conversation, setConversation] = useState<string | null>(null);
  const load = useCallback((f: CostFilters) => agentOp<CostReport>(company, agentId, "costs", { ...f }), [company, agentId]);
  return (
    <>
      <CostsView load={load} mode="agent" inboxes={bindings.map((b) => ({ id: b.inbox_id, name: b.inbox_name }))} onOpenConversation={setConversation} />
      {conversation && <ConversationInsightModal company={company} agentId={agentId} conversationId={conversation} onClose={() => setConversation(null)} />}
    </>
  );
}

// ------------------------------------------------------------ todos os agentes
export function AgentCostsPage({ company, data }: { company: string; data: Snapshot }) {
  const load = useCallback((f: CostFilters) => builderCosts(company, f), [company]);
  return (
    <div className="ab-page">
      <div className="ab-head">
        <div>
          <h2 className="ab-title">Custos dos Agentes MAVI</h2>
          <p className="ab-intro muted">
            Tudo o que os agentes gastam: respostas da IA, áudios, imagens e vídeos, busca no conhecimento, análises da MAVI, modelos aprovados do WhatsApp
            oficial e testes. Em R$ pela PTAX de cada dia.
          </p>
        </div>
      </div>
      <CostsView load={load} mode="all" clients={data.clients.map((c) => ({ id: c.id, name: c.name }))} />
    </div>
  );
}

// ------------------------------------------------------------ Painel da MAVI: preços do WhatsApp oficial
const CATEGORIES: { id: WabaPrice["category"]; label: string }[] = [
  { id: "marketing", label: "Marketing" },
  { id: "utility", label: "Utilidade" },
  { id: "authentication", label: "Autenticação" },
];

export function WabaPricesSection({ company, notify }: { company: string; notify: (m: string) => void }) {
  const [prices, setPrices] = useState<WabaPrice[] | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [newCountry, setNewCountry] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    wabaPrices(company)
      .then((r) => {
        setPrices(r.prices);
        setCanEdit(r.can_edit);
      })
      .catch((e) => setError(errorOf(e)));
  }, [company]);
  const countries = [...new Set((prices ?? []).map((p) => p.country))].sort((a, b) => (a === "*" ? 1 : b === "*" ? -1 : a.localeCompare(b)));
  const get = (country: string, category: string) => prices?.find((p) => p.country === country && p.category === category)?.price_usd ?? 0;
  const set = (country: string, category: WabaPrice["category"], v: number) =>
    setPrices((cur) => [...(cur ?? []).filter((p) => !(p.country === country && p.category === category)), { country, category, price_usd: v }]);
  const save = async () => {
    setSaving(true);
    try {
      const r = await wabaPrices(company, (prices ?? []).map(({ country, category, price_usd }) => ({ country, category, price_usd })));
      setPrices(r.prices);
      notify("Tabela de preços salva: vale para os próximos envios.");
    } catch (e) {
      notify(errorOf(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="ab-section">
      <h3>Preço do WhatsApp oficial (por modelo aprovado)</h3>
      <p className="muted ai-small">
        A Meta cobra cada modelo aprovado enviado, pela categoria e pelo país de quem recebe (DDI). Os agentes só enviam modelo aprovado no follow-up, com a
        janela de 24 h fechada. O custo de cada envio fica registrado com o preço do momento. Em US$; "Outros" vale para os países sem linha própria.
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!prices && !error && <Loading variant="list" />}
      {prices && (
        <>
          <div className="cost-table-wrap">
            <table className="cost-table">
              <thead>
                <tr>
                  <th>País</th>
                  {CATEGORIES.map((c) => (
                    <th key={c.id} className="num">
                      {c.label}
                    </th>
                  ))}
                  {canEdit && <th />}
                </tr>
              </thead>
              <tbody>
                {countries.map((country) => (
                  <tr key={country}>
                    <td>{country === "*" ? "Outros" : country}</td>
                    {CATEGORIES.map((c) => (
                      <td key={c.id} className="num">
                        {canEdit ? (
                          <input
                            className="ui-input cost-price"
                            type="number"
                            min={0}
                            step={0.0001}
                            value={get(country, c.id)}
                            aria-label={`${country === "*" ? "Outros" : country} · ${c.label}`}
                            onChange={(e) => set(country, c.id, Math.max(0, Number(e.target.value) || 0))}
                          />
                        ) : (
                          `US$ ${get(country, c.id).toLocaleString("pt-BR", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`
                        )}
                      </td>
                    ))}
                    {canEdit && (
                      <td>
                        {country !== "*" && (
                          <button type="button" className="agent-link-btn" onClick={() => setPrices((cur) => (cur ?? []).filter((p) => p.country !== country))}>
                            Remover
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canEdit ? (
            <div className="ab-toolbar">
              <span className="ab-inline">
                <Input
                  value={newCountry}
                  maxLength={2}
                  placeholder="País (ex.: PT)"
                  aria-label="Novo país"
                  onChange={(e) => setNewCountry(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))}
                />
                <Button
                  type="button"
                  className="btn secondary"
                  disabled={newCountry.length !== 2 || countries.includes(newCountry)}
                  onClick={() => {
                    setPrices((cur) => [...(cur ?? []), ...CATEGORIES.map((c) => ({ country: newCountry, category: c.id, price_usd: get("*", c.id) }))]);
                    setNewCountry("");
                  }}
                >
                  Adicionar país
                </Button>
              </span>
              <Button type="button" className="btn primary" loading={saving} onClick={() => void save()}>
                Salvar preços
              </Button>
            </div>
          ) : (
            <p className="muted ai-small">Só administradores e gestores mudam a tabela.</p>
          )}
        </>
      )}
    </section>
  );
}

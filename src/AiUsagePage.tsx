import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CircleDollarSign,
  Database,
  MessageSquare,
  OctagonX,
  Sigma,
  Zap,
} from "lucide-react";
import { Button, Input, Loading, Select, SelectOption } from "./ui";
import { contractProductLabel, dateKey } from "./domain";
import type { Snapshot } from "./types";
import {
  aiTaskCap,
  setAiLimit,
  setAiTaskCap,
  usageReport,
  type UsageLimit,
  type UsageReport,
  type UsageRow,
} from "./ai";

type Tab =
  "user" | "client" | "contract" | "project" | "module" | "model" | "tool";
/** Divisões sem limite próprio. */
const NO_LIMIT = new Set<Tab>(["module", "model", "tool"]);
const TABS: { id: Tab; label: string }[] = [
  { id: "user", label: "Pessoas" },
  { id: "client", label: "Clientes" },
  { id: "contract", label: "Produtos" },
  { id: "project", label: "Projetos" },
  { id: "module", label: "Módulos" },
  { id: "model", label: "Modelos" },
  { id: "tool", label: "Ferramentas" },
];
/** As ferramentas da MAVI (as de consulta e as dos poderes). */
const TOOL_LABELS: Record<string, string> = {
  find_clients: "Achar clientes",
  search_knowledge: "Buscar na base de conhecimento",
  read_more: "Ler um trecho com mais contexto",
  list_meetings: "Listar reuniões",
  campaign_results: "Resultados das campanhas",
  list_tasks: "Listar tarefas",
  client_temperature: "Termômetro do cliente",
  client_radar: "Radar do cliente",
  show_chart: "Gráfico (Visualizações)",
  show_table: "Tabela (Visualizações)",
  show_kpis: "Indicadores (Visualizações)",
  show_timeline: "Linha do tempo (Visualizações)",
  generate_image: "Gerar ou editar imagem (Imagens)",
  propose_task: "Propor tarefa (Ações)",
  propose_comment: "Propor comentário (Ações)",
};
const MODULE_LABELS: Record<string, string> = {
  assistant: "Assistente (MAVI)",
  meetings: "Gravações da MAVI",
  whatsapp: "Grupos do Whatsapp",
  index: "Indexação da base",
  mcp: "MAVI em apps externos (MCP)",
  tasks: "Assistente MAVI nas tarefas",
  notices: "Mural de avisos",
  skills: "Skills da MAVI",
  clients: "Termômetro do cliente",
  radar: "Radar do cliente",
  campaigns: "Campanhas",
  dashboards: "Dashboards (MAVI)",
};

const money = (v: number) => {
  const n = Number(v) || 0;
  if (n > 0 && n < 0.01) return "< US$ 0,01";
  return `US$ ${n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const count = (v: number) => (Number(v) || 0).toLocaleString("pt-BR");

/**
 * Consumo de IA (líderes): quanto a IA custou no período — por pessoa,
 * cliente, produto, projeto e módulo — e os limites mensais de cada um.
 */
export function AiUsagePage({
  company,
  data,
  notify,
}: {
  company: string;
  data: Snapshot;
  notify: (message: string) => void;
}) {
  const today = dateKey();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("user");

  const load = useCallback(() => {
    setError("");
    usageReport(company, from, to)
      .then(setReport)
      .catch((e) => setError((e as Error).message));
  }, [company, from, to]);
  useEffect(() => {
    setReport(null);
    load();
  }, [load]);

  const nameOf = useCallback(
    (type: Tab, id: string) => {
      if (type === "user")
        return (
          data.members.find((m) => m.user_id === id)?.name ?? "Pessoa removida"
        );
      if (type === "client")
        return `Cliente ${data.clients.find((c) => c.id === id)?.name ?? "?"}`;
      if (type === "contract") {
        const k = data.contracts.find((c) => c.id === id);
        const client = data.clients.find((c) => c.id === k?.client_id)?.name;
        return k
          ? `${contractProductLabel(data, id)} · cliente ${client ?? "?"}`
          : "Produto removido";
      }
      if (type === "project")
        return (
          data.projects.find((p) => p.id === id)?.name ?? "Projeto removido"
        );
      if (type === "model") {
        const [provider, ...model] = id.split("|");
        return `${provider || "Padrão do servidor"} · ${model.join("|") || "?"}`;
      }
      return MODULE_LABELS[id] ?? id;
    },
    [data],
  );

  async function saveLimit(
    type: UsageLimit["type"],
    id: string | null,
    value: string,
  ) {
    const amount = value.trim() ? Number(value.replace(",", ".")) : null;
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
      setError("Informe o limite em dólares, por exemplo 50 ou 12,50.");
      return;
    }
    try {
      await setAiLimit(company, type, id, amount);
      notify(amount ? "Limite salvo." : "Limite removido.");
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const limitOf = (type: UsageLimit["type"], id: string | null) =>
    report?.limits.find((l) => l.type === type && l.id === id);
  const rows = useMemo(() => {
    if (!report) return [];
    const source: UsageRow[] = {
      user: report.by_user,
      client: report.by_client,
      contract: report.by_contract,
      project: report.by_project,
      module: report.by_module,
      model: report.by_model ?? [],
      tool: [],
    }[tab];
    const list = source.map((r) => ({ ...r, id: r.id ?? "" }));
    // Quem tem limite aparece mesmo sem gasto no período.
    if (!NO_LIMIT.has(tab))
      for (const l of report.limits)
        if (l.type === tab && l.id && !list.some((r) => r.id === l.id))
          list.push({ id: l.id, cost: 0, asks: 0 });
    return list.sort((a, b) => Number(b.cost) - Number(a.cost));
  }, [report, tab]);

  const company_limit = limitOf("company", null);
  const total = report?.total;
  const avg =
    total && total.asks
      ? (Number(total.cost) - Number(total.index_cost)) / total.asks
      : 0;

  const presets: [string, string, string][] = (() => {
    const d = new Date(`${today}T12:00:00`);
    const last = new Date(d.getFullYear(), d.getMonth(), 0);
    const key = (x: Date) =>
      `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
    const minus30 = new Date(d);
    minus30.setDate(d.getDate() - 29);
    return [
      ["Este mês", `${today.slice(0, 7)}-01`, today],
      ["Mês passado", `${key(last).slice(0, 7)}-01`, key(last)],
      ["Últimos 30 dias", key(minus30), today],
    ];
  })();

  return (
    <div className="ai-usage">
      <div className="ai-usage-toolbar">
        <div className="meetings-period" role="group" aria-label="Período">
          <label>
            De
            <Input
              type="date"
              value={from}
              max={to}
              onChange={(e) => e.target.value && setFrom(e.target.value)}
            />
          </label>
          <label>
            Até
            <Input
              type="date"
              value={to}
              min={from}
              onChange={(e) => e.target.value && setTo(e.target.value)}
            />
          </label>
        </div>
        <div
          className="drive-view"
          role="group"
          aria-label="Atalhos de período"
        >
          {presets.map(([label, f, t]) => (
            <button
              key={label}
              type="button"
              className={from === f && to === t ? "selected" : ""}
              onClick={() => {
                setFrom(f);
                setTo(t);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!report ? (
        <Loading variant="chart" />
      ) : (
        <>
          <section
            className={`stats-grid${total!.cache_read_tokens || total!.cache_write_tokens ? " ai-usage-five" : ""}`}
            aria-label="Resumo do período"
          >
            <article className="stat-card green">
              <div>
                Gasto no período <CircleDollarSign size={17} />
              </div>
              <strong>{money(total!.cost)}</strong>
              <footer>perguntas e indexação</footer>
            </article>
            <article className="stat-card blue">
              <div>
                Perguntas à MAVI <MessageSquare size={17} />
              </div>
              <strong>{count(total!.asks)}</strong>
              <footer>no assistente e nas Gravações</footer>
            </article>
            <article className="stat-card purple">
              <div>
                Custo médio por pergunta <Sigma size={17} />
              </div>
              <strong>{total!.asks ? money(avg) : "—"}</strong>
              <footer>modelo e busca</footer>
            </article>
            <article className="stat-card">
              <div>
                Indexação da base <Database size={17} />
              </div>
              <strong>{money(total!.index_cost)}</strong>
              <footer>
                {count(total!.embedding_tokens)} tokens de vetores
              </footer>
            </article>
            {(() => {
              // Cache do prompt: quanto da entrada dos modelos veio do cache.
              const read = Number(total!.cache_read_tokens ?? 0);
              const all = read + Number(total!.cache_write_tokens ?? 0) + Number(total!.input_tokens ?? 0);
              if (!all) return null;
              return (
                <article className="stat-card green">
                  <div>
                    Cache do prompt <Zap size={17} />
                  </div>
                  <strong>{Math.round((read / all) * 100)}%</strong>
                  <footer>
                    da entrada lida do cache ({count(read)} tokens, a ~10% do preço)
                  </footer>
                </article>
              );
            })()}
          </section>

          <section className="panel ai-usage-company">
            <div>
              <strong>Limite mensal da empresa</strong>
              <small>
                Gasto neste mês: {money(company_limit?.month_spent ?? 0)}
                {company_limit
                  ? ` de ${money(company_limit.monthly_usd)}`
                  : " · sem limite"}
              </small>
              <LimitStatus limit={company_limit} />
            </div>
            <LimitInput
              value={company_limit?.monthly_usd}
              onSave={(v) => void saveLimit("company", null, v)}
              label="Limite mensal da empresa em dólares"
            />
          </section>

          <TaskCapPanel company={company} notify={notify} onError={setError} />

          <div className="drive-view drive-tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={tab === t.id ? "selected" : ""}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === "tool" ? (
            <ToolTable rows={report.by_tool ?? []} />
          ) : (
          <div className="panel drive-table-wrap">
            <table className="drive-table ai-usage-table">
              <thead>
                <tr>
                  <th>{TABS.find((t) => t.id === tab)!.label.slice(0, -1)}</th>
                  <th className="num">Perguntas</th>
                  <th className="num">Gasto no período</th>
                  {!NO_LIMIT.has(tab) && (
                    <>
                      <th className="num hide-mobile">Gasto no mês</th>
                      <th>Limite mensal</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.length ? (
                  rows.map((r) => {
                    const limit = !NO_LIMIT.has(tab)
                      ? limitOf(tab as UsageLimit["type"], r.id)
                      : undefined;
                    return (
                      <tr key={r.id}>
                        <td>
                          <span className="ai-usage-name">
                            {nameOf(tab, r.id)}
                          </span>
                          <LimitStatus limit={limit} />
                        </td>
                        <td className="num">{count(r.asks)}</td>
                        <td className="num">{money(r.cost)}</td>
                        {!NO_LIMIT.has(tab) && (
                          <>
                            <td className="num hide-mobile">
                              {limit ? money(limit.month_spent) : "—"}
                            </td>
                            <td>
                              <LimitInput
                                value={limit?.monthly_usd}
                                onSave={(v) =>
                                  void saveLimit(
                                    tab as UsageLimit["type"],
                                    r.id,
                                    v,
                                  )
                                }
                                label={`Limite mensal de ${nameOf(tab, r.id)} em dólares`}
                              />
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={5} className="muted centered">
                      Nenhum uso da MAVI no período.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          )}
          {!NO_LIMIT.has(tab) && (
            <NewLimit
              tab={tab as Exclude<Tab, "module" | "model">}
              data={data}
              nameOf={nameOf}
              onSave={(id, v) =>
                void saveLimit(tab as UsageLimit["type"], id, v)
              }
            />
          )}
          <p className="muted ai-usage-note">
            Valores em dólares: as respostas pelos preços cadastrados de cada
            provedor (no padrão do servidor, pelos de tabela da Claude) e os
            vetores pelos da OpenAI. Limites valem por mês (horário de Brasília)
            e são conferidos antes de cada pergunta, qualquer que seja o
            provedor; limites de produto e de projeto valem para perguntas
            feitas dentro deles.
          </p>
        </>
      )}
    </div>
  );
}

/** Cada ferramenta: chamadas, falhas, tempo médio, pessoas e custo. */
function ToolTable({ rows }: { rows: NonNullable<UsageReport["by_tool"]> }) {
  const seconds = (ms: number) =>
    ms < 1000
      ? `${Math.round(ms)} ms`
      : `${(ms / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s`;
  return (
    <div className="panel drive-table-wrap">
      <table className="drive-table ai-usage-table">
        <thead>
          <tr>
            <th>Ferramenta</th>
            <th className="num">Chamadas</th>
            <th className="num">Falhas</th>
            <th className="num hide-mobile">Tempo médio</th>
            <th className="num hide-mobile">Pessoas</th>
            <th className="num">Custo próprio</th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <span className="ai-usage-name">
                    {TOOL_LABELS[r.id] ?? r.id}
                  </span>
                </td>
                <td className="num">{count(r.calls)}</td>
                <td className="num">
                  {r.errors ? (
                    <span className="ai-tool-errors">
                      {count(r.errors)} (
                      {Math.round((r.errors / Math.max(1, r.calls)) * 100)}%)
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="num hide-mobile">{seconds(r.avg_ms)}</td>
                <td className="num hide-mobile">{count(r.people)}</td>
                <td className="num">
                  {Number(r.cost) ? money(r.cost) : "—"}
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={6} className="muted centered">
                Nenhuma ferramenta usada no período.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="muted ai-usage-note">
        Cada vez que a MAVI consulta o sistema, desenha, gera uma imagem ou
        propõe uma ação. O custo próprio é o que a ferramenta gasta além da
        resposta (as imagens); o da resposta está nas outras abas.
      </p>
    </div>
  );
}

function LimitStatus({ limit }: { limit?: UsageLimit }) {
  if (!limit) return null;
  const share = Number(limit.month_spent) / Number(limit.monthly_usd);
  if (share >= 1)
    return (
      <span className="ai-limit-status critical">
        <OctagonX size={12} aria-hidden="true" /> Limite atingido
      </span>
    );
  if (share >= 0.8)
    return (
      <span className="ai-limit-status warning">
        <AlertTriangle size={12} aria-hidden="true" /> {Math.round(share * 100)}
        % do limite
      </span>
    );
  return null;
}

/**
 * O teto por tarefa longa da MAVI (migração 20270111090000): a MAVI mostra
 * no plano e, perto dele, entrega o que já tem. Vazio volta ao padrão.
 */
function TaskCapPanel({
  company,
  notify,
  onError,
}: {
  company: string;
  notify: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [cap, setCap] = useState<number | null>(null);
  useEffect(() => {
    aiTaskCap(company)
      .then(setCap)
      .catch(() => setCap(null));
  }, [company]);
  async function save(value: string) {
    const amount = value.trim() ? Number(value.replace(",", ".")) : null;
    if (amount !== null && (!Number.isFinite(amount) || amount < 0.5 || amount > 100)) {
      onError("O teto por tarefa vai de US$ 0,50 a US$ 100.");
      return;
    }
    try {
      setCap(await setAiTaskCap(company, amount));
      notify(amount ? "Teto por tarefa salvo." : "Teto por tarefa de volta ao padrão (US$ 10).");
    } catch (e) {
      onError((e as Error).message);
    }
  }
  return (
    <section className="panel ai-usage-company">
      <div>
        <strong>Teto por tarefa longa da MAVI</strong>
        <small>
          Pedidos grandes (como a passagem de vários clientes) viram uma tarefa em segundo plano: a MAVI mostra o custo
          estimado e este teto antes de começar e, perto dele, entrega o que já tem.
          {cap !== null && ` Hoje: ${money(cap)} por tarefa.`}
        </small>
      </div>
      <LimitInput
        value={cap ?? undefined}
        onSave={(v) => void save(v)}
        label="Teto por tarefa longa em dólares"
        placeholder="10 (padrão)"
      />
    </section>
  );
}

function LimitInput({
  value,
  onSave,
  label,
  placeholder = "sem limite",
}: {
  value?: number;
  onSave: (value: string) => void;
  label: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(
    value ? String(value).replace(".", ",") : "",
  );
  useEffect(
    () => setDraft(value ? String(value).replace(".", ",") : ""),
    [value],
  );
  const changed =
    draft.trim() !== (value ? String(value).replace(".", ",") : "");
  return (
    <form
      className="ai-limit-input"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(draft);
      }}
    >
      <span>US$</span>
      <input
        inputMode="decimal"
        aria-label={label}
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      {changed && (
        <Button className="btn secondary" type="submit">
          Salvar
        </Button>
      )}
    </form>
  );
}

function NewLimit({
  tab,
  data,
  nameOf,
  onSave,
}: {
  tab: Exclude<Tab, "module" | "model">;
  data: Snapshot;
  nameOf: (type: Tab, id: string) => string;
  onSave: (id: string, value: string) => void;
}) {
  const options = useMemo(() => {
    const ids =
      tab === "user"
        ? data.members.filter((m) => m.active).map((m) => m.user_id)
        : tab === "client"
          ? data.clients.filter((c) => !c.archived).map((c) => c.id)
          : tab === "contract"
            ? data.contracts.filter((k) => !k.archived).map((k) => k.id)
            : data.projects.filter((p) => !p.archived).map((p) => p.id);
    return ids
      .map((id) => ({ id, name: nameOf(tab, id) }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { numeric: true }));
  }, [tab, data, nameOf]);
  const [id, setId] = useState("");
  const [amount, setAmount] = useState("");
  useEffect(() => {
    setId("");
    setAmount("");
  }, [tab]);
  return (
    <form
      className="ai-new-limit"
      onSubmit={(e) => {
        e.preventDefault();
        if (id && amount.trim()) onSave(id, amount);
      }}
    >
      <strong>Novo limite</strong>
      <Select
        aria-label="Para quem"
        value={id || "none"}
        onValueChange={(v) => setId(v === "none" ? "" : v)}
      >
        <SelectOption value="none">Escolha…</SelectOption>
        {options.map((o) => (
          <SelectOption key={o.id} value={o.id}>
            {o.name}
          </SelectOption>
        ))}
      </Select>
      <span className="ai-limit-input">
        <span>US$</span>
        <input
          inputMode="decimal"
          aria-label="Limite mensal em dólares"
          placeholder="por mês"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </span>
      <Button
        className="btn primary"
        type="submit"
        disabled={!id || !amount.trim()}
      >
        Definir
      </Button>
    </form>
  );
}

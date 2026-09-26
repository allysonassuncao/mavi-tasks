import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CircleDollarSign,
  Database,
  MessageSquare,
  OctagonX,
  Sigma,
} from "lucide-react";
import { Button, Input, Loading, Select, SelectOption } from "./ui";
import { contractProductLabel, dateKey } from "./domain";
import type { Snapshot } from "./types";
import {
  setAiLimit,
  usageReport,
  type UsageLimit,
  type UsageReport,
  type UsageRow,
} from "./ai";

type Tab = "user" | "client" | "contract" | "project" | "module";
const TABS: { id: Tab; label: string }[] = [
  { id: "user", label: "Pessoas" },
  { id: "client", label: "Clientes" },
  { id: "contract", label: "Produtos" },
  { id: "project", label: "Projetos" },
  { id: "module", label: "Módulos" },
];
const MODULE_LABELS: Record<string, string> = {
  assistant: "Assistente (IA geral)",
  meetings: "Gravações da MAVI",
  index: "Indexação da base",
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
    }[tab];
    const list = source.map((r) => ({ ...r, id: r.id ?? "" }));
    // Quem tem limite aparece mesmo sem gasto no período.
    if (tab !== "module")
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
        <Loading compact />
      ) : (
        <>
          <section className="stats-grid" aria-label="Resumo do período">
            <article className="stat-card green">
              <div>
                Gasto no período <CircleDollarSign size={17} />
              </div>
              <strong>{money(total!.cost)}</strong>
              <footer>perguntas e indexação</footer>
            </article>
            <article className="stat-card blue">
              <div>
                Perguntas à IA <MessageSquare size={17} />
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

          <div className="panel drive-table-wrap">
            <table className="drive-table ai-usage-table">
              <thead>
                <tr>
                  <th>{TABS.find((t) => t.id === tab)!.label.slice(0, -1)}</th>
                  <th className="num">Perguntas</th>
                  <th className="num">Gasto no período</th>
                  {tab !== "module" && (
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
                    const limit =
                      tab !== "module" ? limitOf(tab, r.id) : undefined;
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
                        {tab !== "module" && (
                          <>
                            <td className="num hide-mobile">
                              {limit ? money(limit.month_spent) : "—"}
                            </td>
                            <td>
                              <LimitInput
                                value={limit?.monthly_usd}
                                onSave={(v) => void saveLimit(tab, r.id, v)}
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
                      Nenhum uso de IA no período.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {tab !== "module" && (
            <NewLimit
              tab={tab}
              data={data}
              nameOf={nameOf}
              onSave={(id, v) => void saveLimit(tab, id, v)}
            />
          )}
          <p className="muted ai-usage-note">
            Valores em dólares, pelos preços das APIs (Claude para as respostas,
            OpenAI para os vetores). Limites valem por mês (horário de Brasília)
            e são conferidos antes de cada pergunta; limites de produto e de
            projeto valem para perguntas feitas dentro deles.
          </p>
        </>
      )}
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

function LimitInput({
  value,
  onSave,
  label,
}: {
  value?: number;
  onSave: (value: string) => void;
  label: string;
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
        placeholder="sem limite"
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
  tab: Exclude<Tab, "module">;
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

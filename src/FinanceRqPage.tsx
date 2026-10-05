import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Receipt, RefreshCw } from "lucide-react";
import { Button, Input, Loading } from "./ui";
import { Empty } from "./components";
import { useUrlState } from "./router";
import { RqBillingEditorModal, RqMonthPanel, rqBackend } from "./RqBilling";
import {
  RQ_MODEL_LABEL,
  rqMoney,
  rqMonthName,
  rqMonths,
  rqPriceText,
  rqShiftMonth,
  type RqMonth,
  type RqOverview,
  type RqOverviewClient,
  type RqTotals,
} from "./rq-billing";
import "./rq-billing.css";

/**
 * Financeiro › Make Ads RQ: o fechamento mensal de cada cliente com o
 * produto Make Ads RQ — quantos leads geraram cobrança no mês, a receita da
 * Make, a mídia investida e o resultado; abre o mês de um cliente para
 * conferir, tirar/incluir com motivo e validar. Padrão: o mês anterior (a
 * cobrança é sempre do mês que passou).
 */
export function FinanceRqPage({
  company,
  demo,
  notify,
}: {
  company: string;
  demo: boolean;
  notify: (message: string) => void;
}) {
  const rq = useMemo(() => rqBackend(demo), [demo]);
  const { current, previous } = rqMonths();
  const [rawMonth, setMonth] = useUrlState<string>("mes", previous);
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(rawMonth) && rawMonth <= current ? rawMonth : previous;
  const [selected, setSelected] = useUrlState<string>("cliente", "");
  const [overview, setOverview] = useState<RqOverview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  // Os totais ao vivo dos meses abertos (o CRM, um cliente por vez).
  const [live, setLive] = useState<Record<string, RqTotals | "error" | "missing">>({});
  const liveRef = useRef(live);
  liveRef.current = live;
  const [editing, setEditing] = useState<RqOverviewClient | null>(null);
  const [rev, setRev] = useState(0);

  const load = useCallback(() => {
    setBusy(true);
    setError("");
    rq.overview(company, month)
      .then((o) => setOverview(o))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  }, [rq, company, month]);
  useEffect(() => {
    setOverview(null);
    setLive({});
    load();
  }, [load, rev]);

  // Os abertos com regra e CRM: conta cada um (até 3 de cada vez).
  useEffect(() => {
    if (!overview) return;
    let stop = false;
    // Só os que faltam: depois de um ajuste, conta de novo só aquele cliente.
    const queue = overview.clients.filter(
      (c) => c.config && c.linked && c.closing?.status !== "validated" && !(c.client in liveRef.current),
    );
    const next = async (): Promise<void> => {
      const c = queue.shift();
      if (!c || stop) return;
      try {
        const m: RqMonth = await rq.month(company, c.client, month);
        if (!stop) setLive((l) => ({ ...l, [c.client]: m.result?.totals ?? "missing" }));
      } catch {
        if (!stop) setLive((l) => ({ ...l, [c.client]: "error" }));
      }
      return next();
    };
    void Promise.all([next(), next(), next()]);
    return () => {
      stop = true;
    };
  }, [overview, rq, company, month]);

  const clients = overview?.clients ?? [];
  const totalsOf = (c: RqOverviewClient): RqTotals | null => {
    if (c.closing?.status === "validated") return c.closing.totals;
    const t = live[c.client];
    return t && typeof t === "object" ? t : null;
  };
  const shown = clients.filter((c) => !query.trim() || c.client_name.toLowerCase().includes(query.trim().toLowerCase()));
  const sum = clients.reduce(
    (acc, c) => {
      const t = totalsOf(c);
      if (c.closing?.status === "validated") acc.validated++;
      else if (c.config) acc.pending++;
      if (t) {
        acc.revenue += t.total;
        acc.result += t.result;
        acc.leads += t.count;
      }
      acc.spend += c.spend.net;
      return acc;
    },
    { validated: 0, pending: 0, revenue: 0, spend: 0, result: 0, leads: 0 },
  );
  const counting = clients.some((c) => c.config && c.linked && c.closing?.status !== "validated" && !(c.client in live));
  const open = clients.find((c) => c.client === selected) ?? null;

  const statusOf = (c: RqOverviewClient) => {
    if (!c.config) return { tone: "info", text: "Sem regra" };
    if (!c.linked) return { tone: "warn", text: "Sem CRM" };
    if (c.closing?.status === "validated") return { tone: "ok", text: "Validado" };
    if (live[c.client] === "error") return { tone: "warn", text: "Erro ao contar" };
    if (overview?.current_month) return { tone: "info", text: "Parcial" };
    return { tone: "warn", text: c.closing?.status === "reopened" ? "Reaberto" : "A validar" };
  };

  return (
    <div className="rq-page">
      <div className="rq-page-head">
        <div className="rq-month-nav" role="group" aria-label="Mês">
          <button type="button" className="icon-btn" aria-label="Mês anterior" onClick={() => setMonth(rqShiftMonth(month, -1))}>
            <ChevronLeft size={16} />
          </button>
          <strong>{rqMonthName(month)}</strong>
          <button
            type="button"
            className="icon-btn"
            aria-label="Próximo mês"
            disabled={month >= current}
            onClick={() => setMonth(rqShiftMonth(month, 1))}
          >
            <ChevronRight size={16} />
          </button>
        </div>
        {month === current && <small>Mês em andamento: os números são parciais e só se valida quando ele acabar.</small>}
        <span className="rq-search">
          <Input
            type="search"
            aria-label="Buscar cliente"
            placeholder="Buscar cliente"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </span>
        <Button className="icon-btn" onClick={() => setRev((n) => n + 1)} loading={busy} aria-label="Atualizar" title="Atualizar">
          <RefreshCw size={15} />
        </Button>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!overview && !error && <Loading variant="table" />}

      {overview && (
        <>
          <section className="rq-kpis" aria-label={`Resumo de ${rqMonthName(month)}`}>
            <div>
              <span>Clientes Make Ads RQ</span>
              <strong>{clients.length}</strong>
              <small>
                {sum.validated} validados · {sum.pending} {month === current ? "em andamento" : "a validar"}
              </small>
            </div>
            <div>
              <span>Leads cobrados</span>
              <strong>{sum.leads}</strong>
              <small>{counting ? "contando no CRM…" : "reuniões e vendas que geram cobrança"}</small>
            </div>
            <div>
              <span>Receita da Make</span>
              <strong>{rqMoney(sum.revenue)}</strong>
              <small>validados + contados ao vivo</small>
            </div>
            <div className={sum.result < 0 ? "neg" : "pos"}>
              <span>Resultado</span>
              <strong>{rqMoney(sum.result)}</strong>
              <small>receita − mídia ({rqMoney(sum.spend)} investidos)</small>
            </div>
          </section>

          {!clients.length ? (
            <Empty
              title="Nenhum cliente com o Make Ads RQ"
              body="Os clientes aparecem aqui quando têm o produto “Make Ads RQ” contratado (e são de uma equipe sua, se você é colaborador)."
            />
          ) : (
            <div className="panel rq-clients">
              <table className="rq-table stack-mobile">
                <thead>
                  <tr>
                    <th>Cliente</th>
                    <th>Cobrança</th>
                    <th>Leads</th>
                    <th>Receita</th>
                    <th>Mídia</th>
                    <th>Resultado</th>
                    <th>Status</th>
                    <th aria-label="Ações" />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((c) => {
                    const t = totalsOf(c);
                    const st = statusOf(c);
                    const pending = c.config && c.linked && c.closing?.status !== "validated" && !(c.client in live);
                    return (
                      <tr key={c.client} className={c.client === selected ? "selected" : ""}>
                        <td data-label="Cliente">
                          <span className="product-dot" style={{ background: c.color ?? "#a3acab" }} aria-hidden="true" />
                          <strong>{c.client_name}</strong>
                        </td>
                        <td data-label="Cobrança">
                          {c.config ? (
                            <>
                              {RQ_MODEL_LABEL[c.config.model]}
                              <small>{rqPriceText(c.config)}</small>
                            </>
                          ) : (
                            <button type="button" className="text-btn" onClick={() => setEditing(c)}>
                              Definir a cobrança
                            </button>
                          )}
                        </td>
                        <td data-label="Leads">{t ? t.count : pending ? "…" : "—"}</td>
                        <td data-label="Receita">{t ? rqMoney(t.total) : pending ? "…" : "—"}</td>
                        <td data-label="Mídia">{rqMoney(t ? t.spend_net : c.spend.net)}</td>
                        <td data-label="Resultado" className={t ? (t.result < 0 ? "neg" : "pos") : ""}>
                          {t ? rqMoney(t.result) : "—"}
                        </td>
                        <td data-label="Status">
                          <span className={`rq-status ${st.tone}`}>{st.text}</span>
                        </td>
                        <td className="rq-act">
                          <Button className="btn secondary" onClick={() => setSelected(c.client === selected ? "" : c.client)}>
                            {c.client === selected ? "Fechar" : "Conferir"}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {open ? (
            <section className="panel rq-detail" aria-label={`Fechamento de ${open.client_name}`}>
              <h2>
                <Receipt size={18} aria-hidden="true" /> {open.client_name}
              </h2>
              <RqMonthPanel
                key={`${open.client}:${month}:${rev}`}
                rq={rq}
                company={company}
                client={open.client}
                month={month}
                onMonth={setMonth}
                onEditRule={() => setEditing(open)}
                onChanged={() =>
                  rq.overview(company, month).then(
                    (o) => {
                      setOverview(o);
                      setLive((l) => {
                        const n = { ...l };
                        delete n[open.client];
                        return n;
                      });
                    },
                    () => undefined,
                  )
                }
                notify={notify}
              />
            </section>
          ) : (
            clients.length > 0 && (
              <p className="rq-hint">
                Escolha <strong>Conferir</strong> num cliente para ver os leads do mês, tirar ou incluir com motivo e
                validar. Validado, o mês fica congelado.
              </p>
            )
          )}
        </>
      )}

      {editing && (
        <RqBillingEditorModal
          rq={rq}
          company={company}
          client={editing.client}
          clientName={editing.client_name}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            notify("Cobrança do Make Ads RQ salva.");
            setRev((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

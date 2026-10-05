import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  History,
  LockOpen,
  Receipt,
  Undo2,
} from "lucide-react";
import { Button, Checkbox, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import { Modal } from "./components";
import {
  RQ_MODEL_LABEL,
  demoRq,
  rqContractText,
  rqFilterText,
  rqInputFrom,
  rqInputOut,
  rqMoney,
  rqMonthName,
  rqMonths,
  rqPriceText,
  rqShiftMonth,
  serverRq,
  type RqBackend,
  type RqBillingView,
  type RqConfigInput,
  type RqCrmOptions,
  type RqEvent,
  type RqMonth,
  type RqRow,
} from "./rq-billing";
import "./rq-billing.css";

export const rqBackend = (demo: boolean): RqBackend => (demo ? demoRq() : serverRq);

/**
 * Os campos da regra de cobrança do Make Ads RQ: o modelo (reunião
 * qualificada ou venda), a etapa ou o funil, o valor, o contrato e quais
 * leads contam. Usado no modal "Etapas que importam no CRM" e no Financeiro.
 */
export function RqBillingFields({
  input,
  onChange,
  options,
}: {
  input: RqConfigInput;
  onChange: (next: RqConfigInput) => void;
  options: RqCrmOptions | null;
}) {
  const set = (patch: Partial<RqConfigInput>) => onChange({ ...input, ...patch });
  const pipelines = options?.pipelines ?? [];
  const many = pipelines.length > 1;
  const stageValue = input.stage_id ? `${input.pipeline_id}|${input.stage_id}` : "";
  const filter = input.lead_filter;
  const utmText = filter.mode === "utm" ? (filter.utm_sources ?? []).join(", ") : "";
  const picked = (list: "sources" | "campaigns") =>
    filter.mode === "crm" ? (filter[list] ?? []).map((x) => x.id) : [];
  const toggle = (list: "sources" | "campaigns", item: { id: string; name: string }, on: boolean) => {
    const f = filter.mode === "crm" ? filter : { mode: "crm" as const };
    const current = f[list] ?? [];
    set({
      lead_filter: {
        ...f,
        [list]: on ? [...current.filter((x) => x.id !== item.id), item] : current.filter((x) => x.id !== item.id),
      },
    });
  };
  return (
    <div className="rq-fields">
      <div className="rq-choice" role="radiogroup" aria-label="Como a Make cobra">
        {(
          [
            ["meeting", "Conta cada lead que chegou à etapa escolhida (ou passou dela), no mês em que chegou."],
            ["sale", "Conta cada negócio ganho no CRM, pela data do ganho."],
          ] as const
        ).map(([value, hint]) => (
          <label key={value} className={input.model === value ? "on" : ""}>
            <input
              type="radio"
              name="rq-model"
              checked={input.model === value}
              onChange={() => set({ model: value, price_kind: value === "meeting" ? "fixed" : input.price_kind })}
            />
            <span>
              <strong>{RQ_MODEL_LABEL[value]}</strong>
              <small>{hint}</small>
            </span>
          </label>
        ))}
      </div>

      {input.model === "meeting" ? (
        <label className="rq-field">
          <span>Etapa que gera cobrança</span>
          <Select
            value={stageValue}
            onValueChange={(v) => {
              const [pid, sid] = v.split("|");
              const p = pipelines.find((x) => x.id === pid);
              const st = p?.stages.find((x) => x.id === sid);
              set({ pipeline_id: pid || null, pipeline_name: p?.name ?? "", stage_id: sid || null, stage_name: st?.name ?? "" });
            }}
            aria-label="Etapa que gera cobrança"
          >
            <SelectOption value="">Escolha a etapa</SelectOption>
            {pipelines.flatMap((p) =>
              p.stages.map((st) => (
                <SelectOption key={`${p.id}|${st.id}`} value={`${p.id}|${st.id}`}>
                  {many ? `${p.name} › ${st.name}` : st.name}
                </SelectOption>
              )),
            )}
          </Select>
          {input.stage_id && !pipelines.some((p) => p.stages.some((s) => s.id === input.stage_id)) && options && (
            <small className="rq-warn">
              A etapa salva ({input.stage_name}) não existe mais no CRM: escolha outra.
            </small>
          )}
        </label>
      ) : (
        <label className="rq-field">
          <span>Funil</span>
          <Select
            value={input.pipeline_id ?? ""}
            onValueChange={(v) => set({ pipeline_id: v || null, pipeline_name: pipelines.find((p) => p.id === v)?.name ?? "" })}
            aria-label="Funil das vendas"
          >
            <SelectOption value="">Todos os funis</SelectOption>
            {pipelines.map((p) => (
              <SelectOption key={p.id} value={p.id}>
                {p.name}
              </SelectOption>
            ))}
          </Select>
        </label>
      )}

      <div className="rq-row">
        {input.model === "sale" && (
          <label className="rq-field">
            <span>Cobrança por venda</span>
            <Select
              value={input.price_kind}
              onValueChange={(v) => set({ price_kind: v as RqConfigInput["price_kind"] })}
              aria-label="Cobrança por venda"
            >
              <SelectOption value="fixed">Valor fixo por venda</SelectOption>
              <SelectOption value="percent">% do valor da venda</SelectOption>
            </Select>
          </label>
        )}
        {input.model === "sale" && input.price_kind === "percent" ? (
          <label className="rq-field">
            <span>Porcentagem (%)</span>
            <Input
              inputMode="decimal"
              value={input.percent}
              placeholder="Ex.: 10"
              onChange={(e) => set({ percent: e.target.value })}
            />
          </label>
        ) : (
          <label className="rq-field">
            <span>Valor por {input.model === "meeting" ? "reunião" : "venda"} (R$)</span>
            <Input
              inputMode="decimal"
              value={input.unit_price}
              placeholder="Ex.: 150,00"
              onChange={(e) => set({ unit_price: e.target.value })}
            />
          </label>
        )}
      </div>

      <div className="rq-row">
        <label className="rq-field">
          <span>Contrato</span>
          <Select
            value={input.contract_kind}
            onValueChange={(v) => set({ contract_kind: v as RqConfigInput["contract_kind"] })}
            aria-label="Contrato"
          >
            <SelectOption value="variable">Só o variável</SelectOption>
            <SelectOption value="fixed_plus">Fixo + variável</SelectOption>
            <SelectOption value="minimum">Mínimo garantido</SelectOption>
          </Select>
        </label>
        {input.contract_kind !== "variable" && (
          <label className="rq-field">
            <span>{input.contract_kind === "fixed_plus" ? "Mensalidade fixa (R$)" : "Mínimo mensal (R$)"}</span>
            <Input
              inputMode="decimal"
              value={input.fixed_amount}
              onChange={(e) => set({ fixed_amount: e.target.value })}
            />
          </label>
        )}
        <label className="rq-field">
          <span>Teto mensal (R$, opcional)</span>
          <Input inputMode="decimal" value={input.cap} onChange={(e) => set({ cap: e.target.value })} />
        </label>
      </div>

      <fieldset className="rq-filter">
        <legend>Quais leads contam</legend>
        <div className="rq-choice compact" role="radiogroup" aria-label="Quais leads contam">
          {(
            [
              ["all", "Todos", "Qualquer lead do funil."],
              ["utm", "Por UTM", "Só os que chegaram com UTM."],
              ["crm", "Origem/campanha", "Pela Origem ou Campanha do negócio no CRM."],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className={filter.mode === value ? "on" : ""}>
              <input
                type="radio"
                name="rq-filter"
                checked={filter.mode === value}
                onChange={() => set({ lead_filter: value === "all" ? { mode: "all" } : value === "utm" ? { mode: "utm", utm_sources: [] } : { mode: "crm", sources: [], campaigns: [] } })}
              />
              <span>
                <strong>{label}</strong>
                <small>{hint}</small>
              </span>
            </label>
          ))}
        </div>
        {filter.mode === "utm" && (
          <label className="rq-field">
            <span>utm_source (opcional, separe por vírgula)</span>
            <Input
              value={utmText}
              placeholder="Ex.: facebook, instagram, google"
              onChange={(e) =>
                set({ lead_filter: { mode: "utm", utm_sources: e.target.value.split(",").map((x) => x.trimStart()) } })
              }
            />
            <small>Vazio: qualquer lead que tenha alguma UTM.</small>
          </label>
        )}
        {filter.mode === "crm" && (
          <div className="rq-crm-lists">
            {(
              [
                ["sources", "Origens", options?.sources ?? []],
                ["campaigns", "Campanhas do CRM", options?.campaigns ?? []],
              ] as const
            ).map(([list, label, items]) => (
              <div key={list}>
                <strong>{label}</strong>
                {!items.length ? (
                  <small>Nenhuma cadastrada no CRM.</small>
                ) : (
                  <ul>
                    {items.map((item) => (
                      <li key={item.id}>
                        <label className="cins-check">
                          <Checkbox
                            checked={picked(list).includes(item.id)}
                            onCheckedChange={(v) => toggle(list, item, v === true)}
                          />
                          <span>{item.name}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            <small className="rq-note">Marcando origens e campanhas, o lead precisa bater nas duas.</small>
          </div>
        )}
      </fieldset>
    </div>
  );
}

/** "Faltou" antes de salvar: o que o banco também confere, dito antes. */
export function rqInputProblem(i: RqConfigInput): string {
  if (i.model === "meeting" && !i.stage_id) return "Escolha a etapa que gera cobrança.";
  const out = rqInputOut(i);
  const positive = (v: string) => /^\d+(\.\d+)?$/.test(v) && Number(v) > 0;
  if (out.price_kind === "percent" ? !positive(out.percent) || Number(out.percent) > 100 : !positive(out.unit_price))
    return out.price_kind === "percent"
      ? "Informe a porcentagem da venda (de 0,01 a 100)."
      : `Informe o valor cobrado por ${i.model === "meeting" ? "reunião" : "venda"}.`;
  if (i.contract_kind !== "variable" && !positive(out.fixed_amount))
    return i.contract_kind === "fixed_plus" ? "Informe a mensalidade fixa." : "Informe o valor mínimo mensal.";
  if (out.cap && !positive(out.cap)) return "O teto precisa ser maior que zero.";
  return "";
}

/** A regra no Financeiro (o cliente pode não ter campanha com insights). */
export function RqBillingEditorModal({
  rq,
  company,
  client,
  clientName,
  onClose,
  onSaved,
}: {
  rq: RqBackend;
  company: string;
  client: string;
  clientName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [view, setView] = useState<RqBillingView | null>(null);
  const [options, setOptions] = useState<RqCrmOptions | null>(null);
  const [input, setInput] = useState<RqConfigInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    Promise.all([rq.billing(company, client), rq.crmOptions(company, client)]).then(
      ([v, o]) => {
        if (!live) return;
        setView(v);
        setOptions(o);
        setInput(rqInputFrom(v.config));
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [rq, company, client]);
  const save = async (remove = false) => {
    if (!input) return;
    const problem = remove ? "" : rqInputProblem(input);
    if (problem) return setError(problem);
    setBusy(true);
    setError("");
    try {
      await rq.setBilling(company, client, remove ? null : rqInputOut(input));
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Cobrança do Make Ads RQ · ${clientName}`} onClose={onClose} busy={busy}>
      <form
        className="entity-form rq-editor"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {!input && !error && <Loading variant="list" />}
        {options && !options.linked && (
          <p className="insights-empty">
            O cliente não está ligado ao MakeCRM: ligue em Campanhas › Abrir no CRM para escolher a etapa.
          </p>
        )}
        {input && <RqBillingFields input={input} onChange={setInput} options={options} />}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          {view?.config && (
            <Button type="button" className="btn secondary" onClick={() => void save(true)} disabled={busy}>
              Remover a cobrança
            </Button>
          )}
          <Button type="button" className="btn secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" className="btn primary" loading={busy} disabled={!input}>
            Salvar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const when = (iso: string | null | undefined) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" })
    : "";
};
const whenFull = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "";
const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 1000) / 10}%`.replace(".", ","));

/** Pede o motivo (tirar, incluir ou reabrir). */
function ReasonModal({
  title,
  help,
  confirm,
  onClose,
  onConfirm,
}: {
  title: string;
  help: string;
  confirm: string;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title={title} onClose={onClose} busy={busy}>
      <form
        className="entity-form insights-reason"
        onSubmit={async (e) => {
          e.preventDefault();
          if (reason.trim().length < 3) return setError("Conte o motivo.");
          setBusy(true);
          setError("");
          try {
            await onConfirm(reason.trim());
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <p className="insights-owners-help">{help}</p>
        <Textarea
          autoFocus
          rows={3}
          maxLength={500}
          value={reason}
          aria-label="Motivo"
          placeholder="Motivo"
          onChange={(e) => setReason(e.target.value)}
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          <Button type="button" className="btn secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" className="btn primary" loading={busy}>
            {confirm}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const OUTSIDE_LABEL = { filtered: "Fora do filtro", excluded: "Tirado", billed: "Já cobrado" } as const;
const EVENT_LABEL: Record<RqEvent["action"], string> = {
  config: "mudou a regra",
  exclude: "tirou um lead",
  include: "incluiu um lead",
  undo: "desfez um ajuste",
  validated: "validou o mês",
  reopened: "reabriu o mês",
};

/**
 * O fechamento de um mês de um cliente: os leads que geram cobrança, os que
 * ficaram de fora, a receita da Make, a mídia e o resultado; tirar/incluir
 * com motivo, validar (congela) e reabrir (líderes, com motivo).
 */
export function RqMonthPanel({
  rq,
  company,
  client,
  month,
  onMonth,
  onEditRule,
  onChanged,
  notify,
}: {
  rq: RqBackend;
  company: string;
  client: string;
  month: string;
  onMonth: (month: string) => void;
  /** Abre a regra (sem regra, o fechamento pede uma). */
  onEditRule?: () => void;
  /** Validou, reabriu ou mudou um ajuste (a lista de fora se atualiza). */
  onChanged?: () => void;
  notify: (message: string) => void;
}) {
  const [data, setData] = useState<RqMonth | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<
    | { kind: "exclude" | "include"; lead: RqRow }
    | { kind: "reopen" }
    | null
  >(null);
  const [confirming, setConfirming] = useState(false);
  const [showOutside, setShowOutside] = useState(false);
  const [events, setEvents] = useState<RqEvent[] | null>(null);
  const [showEvents, setShowEvents] = useState(false);
  const load = useCallback(() => {
    setBusy(true);
    setError("");
    return rq
      .month(company, client, month)
      .then((d) => setData(d))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  }, [rq, company, client, month]);
  useEffect(() => {
    setData(null);
    setEvents(null);
    void load();
  }, [load]);
  useEffect(() => {
    if (!showEvents) return;
    rq.events(company, client, month).then(setEvents, (e: Error) => setError(e.message));
  }, [showEvents, rq, company, client, month, data]);

  const v = data?.view;
  const result = data?.result;
  const t = result?.totals;
  const frozen = !!data?.frozen;
  const closing = v?.closing ?? null;
  const config = frozen ? (closing?.config ?? v?.config) : v?.config;
  const { current } = rqMonths();
  const canValidate = !!v?.closed_month && !frozen && !!result && !!v.config;

  const adjust = async (lead: RqRow, action: "exclude" | "include" | null, reason?: string) => {
    await rq.adjust(company, client, month, lead, action, reason);
    await load();
    onChanged?.();
  };
  const validate = async () => {
    setBusy(true);
    setError("");
    try {
      const d = await rq.validate(company, client, month);
      setData(d);
      setConfirming(false);
      notify(`Fechamento de ${rqMonthName(month)} validado.`);
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const crmLink = (l: RqRow) => (data?.crm_url ? `${data.crm_url}/deals/${l.deal_id}` : null);

  const status = !v
    ? null
    : frozen
      ? { tone: "ok", text: `Validado${closing?.validated_by_name ? ` por ${closing.validated_by_name}` : ""} em ${when(closing?.validated_at)}` }
      : closing?.status === "reopened"
        ? { tone: "warn", text: `Reaberto por ${closing.reopened_by_name ?? "—"}: ${closing.reopen_reason ?? ""}` }
        : v.current_month
          ? { tone: "info", text: "Mês em andamento (parcial)" }
          : v.closed_month
            ? { tone: "warn", text: "A validar" }
            : { tone: "info", text: "Mês futuro" };

  const lines = useMemo(() => result?.leads ?? [], [result]);
  const outside = useMemo(() => result?.outside ?? [], [result]);

  return (
    <div className="rq-month">
      <div className="rq-month-head">
        <div className="rq-month-nav" role="group" aria-label="Mês">
          <button type="button" className="icon-btn" aria-label="Mês anterior" onClick={() => onMonth(rqShiftMonth(month, -1))}>
            <ChevronLeft size={16} />
          </button>
          <strong>{rqMonthName(month)}</strong>
          <button
            type="button"
            className="icon-btn"
            aria-label="Próximo mês"
            disabled={month >= current}
            onClick={() => onMonth(rqShiftMonth(month, 1))}
          >
            <ChevronRight size={16} />
          </button>
        </div>
        {status && <span className={`rq-status ${status.tone}`}>{status.text}</span>}
        {config && (
          <span className="rq-rule">
            {RQ_MODEL_LABEL[config.model]} · {rqPriceText(config)}
            {rqContractText(config) ? ` · ${rqContractText(config)}` : ""} · {rqFilterText(config.lead_filter)}
            {onEditRule && !frozen && (
              <button type="button" className="text-btn" onClick={onEditRule}>
                Alterar
              </button>
            )}
          </span>
        )}
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <Loading variant="list" />}

      {data?.missing === "config" && (
        <div className="rq-missing">
          <Receipt size={22} aria-hidden="true" />
          <p>
            Falta a regra de cobrança: escolha se a Make cobra por reunião qualificada ou por venda, a etapa e o valor.
          </p>
          {onEditRule && (
            <Button className="btn primary" onClick={onEditRule}>
              Definir a cobrança
            </Button>
          )}
        </div>
      )}
      {data?.missing === "crm" && (
        <div className="rq-missing">
          <AlertTriangle size={22} aria-hidden="true" />
          <p>O cliente não está ligado ao MakeCRM. Ligue em Campanhas › Abrir no CRM para contar os leads.</p>
        </div>
      )}

      {t && (
        <>
          <section className="rq-kpis" aria-label="Resumo do mês">
            <div>
              <span>{config?.model === "sale" ? "Vendas cobradas" : "Reuniões cobradas"}</span>
              <strong>{t.count}</strong>
              <small>
                {t.estimated ? `${t.estimated} com data estimada · ` : ""}
                {config?.model === "sale" ? `vendido ${rqMoney(t.sales_value)}` : `${rqMoney(t.revenue_per_lead ?? 0)} por lead`}
              </small>
            </div>
            <div>
              <span>Receita da Make</span>
              <strong>{rqMoney(t.total)}</strong>
              <small>
                variável {rqMoney(t.variable)}
                {t.fixed ? ` + ${t.minimum_applied ? "mínimo" : "fixo"} ${rqMoney(t.fixed)}` : ""}
                {t.capped ? " · no teto" : ""}
              </small>
            </div>
            <div>
              <span>Mídia investida</span>
              <strong>{rqMoney(t.spend_net)}</strong>
              <small>
                gasto real nas plataformas · com M {rqMoney(t.spend_gross)}
                {t.media_per_lead !== null ? ` · ${rqMoney(t.media_per_lead)} por lead` : ""}
              </small>
            </div>
            <div className={t.result < 0 ? "neg" : "pos"}>
              <span>Resultado</span>
              <strong>{rqMoney(t.result)}</strong>
              <small>receita − mídia · margem {pct(t.margin)}</small>
            </div>
          </section>

          <section className="rq-leads" aria-label="Leads que geram cobrança">
            <h3>
              {config?.model === "sale" ? "Vendas" : "Leads"} que geram cobrança
              <small>{lines.length}</small>
            </h3>
            {!lines.length ? (
              <p className="insights-empty">Nenhum lead gerou cobrança neste mês.</p>
            ) : (
              <table className="rq-table stack-mobile">
                <thead>
                  <tr>
                    <th>{config?.model === "sale" ? "Ganho em" : "Chegou em"}</th>
                    <th>Lead</th>
                    <th>{config?.model === "sale" ? "Valor" : "Etapa atual"}</th>
                    <th>Origem</th>
                    {!frozen && <th aria-label="Ações" />}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <LeadRow
                      key={l.key}
                      lead={l}
                      sale={config?.model === "sale"}
                      link={crmLink(l)}
                      action={
                        frozen ? null : l.adjustment?.action === "include" ? (
                          <button type="button" className="text-btn" onClick={() => void adjust(l, null)}>
                            <Undo2 size={13} aria-hidden="true" /> Desfazer
                          </button>
                        ) : (
                          <button type="button" className="text-btn" onClick={() => setAsking({ kind: "exclude", lead: l })}>
                            Tirar
                          </button>
                        )
                      }
                      frozen={frozen}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {!frozen && outside.length > 0 && (
            <section className="rq-leads outside">
              <button type="button" className="rq-toggle" onClick={() => setShowOutside((x) => !x)} aria-expanded={showOutside}>
                Fora da conta <small>{outside.length}</small>
                <span>{showOutside ? "Esconder" : "Mostrar"}</span>
              </button>
              {showOutside && (
                <table className="rq-table stack-mobile">
                  <tbody>
                    {outside.map((l) => (
                      <LeadRow
                        key={l.key}
                        lead={l}
                        sale={config?.model === "sale"}
                        link={crmLink(l)}
                        frozen={false}
                        action={
                          l.outside === "excluded" ? (
                            <button type="button" className="text-btn" onClick={() => void adjust(l, null)}>
                              <Undo2 size={13} aria-hidden="true" /> Desfazer
                            </button>
                          ) : l.outside === "filtered" ? (
                            <button type="button" className="text-btn" onClick={() => setAsking({ kind: "include", lead: l })}>
                              Incluir
                            </button>
                          ) : null
                        }
                      />
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}

          <div className="rq-actions">
            <button type="button" className="text-btn" onClick={() => setShowEvents((x) => !x)} aria-expanded={showEvents}>
              <History size={14} aria-hidden="true" /> Histórico
            </button>
            {frozen && v?.can_reopen && (
              <Button className="btn secondary" onClick={() => setAsking({ kind: "reopen" })}>
                <LockOpen size={15} aria-hidden="true" /> Reabrir
              </Button>
            )}
            {canValidate && (
              <Button className="btn primary" onClick={() => setConfirming(true)} loading={busy}>
                <BadgeCheck size={15} aria-hidden="true" /> Validar {rqMonthName(month)}
              </Button>
            )}
            {!frozen && v?.current_month && <small>Dá para validar quando o mês acabar.</small>}
          </div>
          {showEvents && (
            <ul className="rq-events">
              {!events && <li>Carregando…</li>}
              {events?.length === 0 && <li>Nada ainda.</li>}
              {events?.map((e, i) => (
                <li key={i}>
                  <strong>{e.user_name ?? "Sistema"}</strong> {EVENT_LABEL[e.action]}
                  {e.detail?.lead?.name ? ` (${e.detail.lead.name})` : ""}
                  {e.reason ? `: ${e.reason}` : ""}
                  <small>{whenFull(e.created_at)}</small>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {confirming && t && (
        <Modal title={`Validar ${rqMonthName(month)}`} onClose={() => setConfirming(false)} busy={busy}>
          <div className="entity-form">
            <p className="insights-owners-help">
              {t.count} {config?.model === "sale" ? "vendas" : "reuniões"} · receita da Make <strong>{rqMoney(t.total)}</strong>
              {t.estimated ? ` · ${t.estimated} com data estimada (confira antes)` : ""}. Validado, o mês fica congelado: a
              lista e o valor não mudam mais, e esses leads não entram em outro mês. Só administradores e gestores reabrem.
            </p>
            <div className="form-footer">
              <Button type="button" className="btn secondary" onClick={() => setConfirming(false)} disabled={busy}>
                Cancelar
              </Button>
              <Button className="btn primary" onClick={() => void validate()} loading={busy}>
                Validar e congelar
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {asking && (
        <ReasonModal
          title={
            asking.kind === "reopen"
              ? `Reabrir ${rqMonthName(month)}`
              : asking.kind === "exclude"
                ? "Tirar da cobrança"
                : "Incluir na cobrança"
          }
          help={
            asking.kind === "reopen"
              ? "O mês volta a ser contado ao vivo pelo CRM até alguém validar de novo. Fica no histórico."
              : `${asking.lead.contact || asking.lead.name}: ${asking.kind === "exclude" ? "por que este lead não deve ser cobrado?" : "por que este lead deve ser cobrado?"}`
          }
          confirm={asking.kind === "reopen" ? "Reabrir" : asking.kind === "exclude" ? "Tirar" : "Incluir"}
          onClose={() => setAsking(null)}
          onConfirm={async (reason) => {
            if (asking.kind === "reopen") {
              await rq.reopen(company, client, month, reason);
              setAsking(null);
              notify(`${rqMonthName(month)} reaberto.`);
              await load();
              onChanged?.();
            } else {
              await adjust(asking.lead, asking.kind, reason);
              setAsking(null);
            }
          }}
        />
      )}
    </div>
  );
}

function LeadRow({
  lead: l,
  sale,
  link,
  action,
  frozen,
}: {
  lead: RqRow;
  sale: boolean;
  link: string | null;
  action: ReactNode;
  frozen: boolean;
}) {
  return (
    <tr className={l.outside ? `out ${l.outside}` : ""}>
      <td data-label={sale ? "Ganho em" : "Chegou em"}>
        {when(l.at) || "—"}
        {l.estimated && (
          <span className="rq-badge" title="O CRM não registrou a entrada nesta etapa (criado direto nela ou movido em massa): é a melhor data que havia. Confira.">
            data estimada
          </span>
        )}
      </td>
      <td data-label="Lead">
        <strong>{l.contact || l.name || "—"}</strong>
        {link && (
          <a className="rq-crm-link" href={link} target="_blank" rel="noreferrer" aria-label="Abrir no CRM" title="Abrir no CRM">
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        )}
        <small>
          {l.contact && l.name ? l.name : ""}
          {l.phone ? `${l.contact && l.name ? " · " : ""}${l.phone}` : ""}
        </small>
      </td>
      <td data-label={sale ? "Valor" : "Etapa atual"}>{sale ? rqMoney(l.value) : l.stage || "—"}</td>
      <td data-label="Origem">
        {l.source || l.campaign ? [l.source, l.campaign].filter(Boolean).join(" · ") : <span className="muted">—</span>}
        {l.utms?.[0] && (l.utms[0].s || l.utms[0].c) && (
          <small>UTM {[l.utms[0].s, l.utms[0].c].filter(Boolean).join(" / ")}</small>
        )}
        {l.outside && (
          <small className={`rq-out ${l.outside}`}>
            {OUTSIDE_LABEL[l.outside]}
            {l.outside === "billed" && l.billed_month ? ` em ${rqMonthName(l.billed_month)}` : ""}
            {l.adjustment && l.outside === "excluded" ? `: ${l.adjustment.reason}` : ""}
          </small>
        )}
        {!l.outside && l.adjustment?.action === "include" && (
          <small className="rq-out included">
            Incluído{l.adjustment.by ? ` por ${l.adjustment.by}` : ""}: {l.adjustment.reason}
            {l.manual ? " (não veio do CRM nesta conta)" : ""}
          </small>
        )}
      </td>
      {(!frozen || l.outside) && <td className="rq-act">{action}</td>}
    </tr>
  );
}

/**
 * Na campanha: o atalho para o fechamento do Make Ads RQ do cliente (só
 * quem tem o Financeiro › Make Ads RQ).
 */
export function RqCampaignButton({
  company,
  client,
  clientName,
  demo,
  notify,
}: {
  company: string;
  client: string;
  clientName: string;
  demo: boolean;
  notify: (message: string) => void;
}) {
  const rq = useMemo(() => rqBackend(demo), [demo]);
  const [view, setView] = useState<RqBillingView | null>(null);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => rqMonths().previous);
  const [editing, setEditing] = useState(false);
  // Bumped when the rule is saved: the month counts again.
  const [rev, setRev] = useState(0);
  useEffect(() => {
    let live = true;
    rq.billing(company, client).then(
      (v) => live && setView(v),
      () => live && setView(null),
    );
    return () => {
      live = false;
    };
  }, [rq, company, client, rev]);
  if (!view?.is_rq || !view.can_edit) return null;
  return (
    <>
      <Button
        className="btn secondary rq-campaign-btn"
        onClick={() => setOpen(true)}
        title={view.config ? `${RQ_MODEL_LABEL[view.config.model]} · ${rqPriceText(view.config)}` : "Definir a cobrança do Make Ads RQ"}
      >
        <Receipt size={15} aria-hidden="true" /> Cobrança RQ
      </Button>
      {open && (
        <Modal title={`Make Ads RQ · ${clientName}`} onClose={() => setOpen(false)} wide hidden={editing}>
          <RqMonthPanel
            key={`${month}:${rev}`}
            rq={rq}
            company={company}
            client={client}
            month={month}
            onMonth={setMonth}
            onEditRule={() => setEditing(true)}
            notify={notify}
          />
        </Modal>
      )}
      {editing && (
        <RqBillingEditorModal
          rq={rq}
          company={company}
          client={client}
          clientName={clientName}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setRev((n) => n + 1);
            notify("Cobrança do Make Ads RQ salva.");
          }}
        />
      )}
    </>
  );
}

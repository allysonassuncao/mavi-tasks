import { useEffect, useState } from "react";
import { Scale, TriangleAlert } from "lucide-react";
import { Button, Input, Loading, Textarea } from "./ui";
import { Empty, Modal } from "./components";
import { money, platforms, shortDate, type AdPlatform } from "./campaigns";
import type {
  MultiplierApply,
  MultiplierBackend,
  MultiplierBelow,
  MultiplierImpact,
  MultiplierLogItem,
} from "./campaign-multiplier";

/*
 * Índice de performance (M): the reason and the days a change reaches, in
 * the cycle form, and the audit log of every change (administrators and
 * managers). Rules in src/campaign-multiplier.ts.
 */

const decimal = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 });
const m = (value: number | null) => (value === null ? "—" : decimal.format(value));
const day5 = (date: string) => shortDate(date).slice(0, 5);
const signed = (value: number) =>
  value === 0 ? "sem mudança" : `${value > 0 ? "+" : "−"}${money(Math.abs(value))}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What each choice changes in the registered days, read as the form changes. */
export function useMultiplierImpact(
  backend: MultiplierBackend,
  cycle: string | null,
  multiplier: number,
  from: string,
  to: string,
  enabled: boolean,
) {
  const [state, setState] = useState<{
    impact: MultiplierImpact | null;
    error: string;
    loading: boolean;
  }>({ impact: null, error: "", loading: false });
  const range = from && to && from <= to;
  useEffect(() => {
    if (!enabled || !cycle || !Number.isFinite(multiplier)) {
      setState({ impact: null, error: "", loading: false });
      return;
    }
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    // After a pause in typing, not at every key.
    const t = setTimeout(() => {
      backend
        .impact(cycle, multiplier, range ? from : null, range ? to : null)
        .then(
          (impact) => live && setState({ impact, error: "", loading: false }),
        )
        .catch(
          (e) =>
            live &&
            setState({
              impact: null,
              error: (e as Error).message,
              loading: false,
            }),
        );
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [backend, cycle, multiplier, from, to, range, enabled]);
  return state;
}

/**
 * Below the M field, when it differs from the cycle's (or, in a new cycle,
 * the previous one's): the reason and, editing a cycle with registered
 * days, which of them take the new M.
 */
export function MultiplierChangeFields({
  previous,
  next,
  newCycle,
  cycleStart,
  cycleEnd,
  reason,
  onReason,
  apply,
  onApply,
  from,
  to,
  onRange,
  impact,
}: {
  previous: number;
  next: number;
  /** A new cycle: no registered day to choose. */
  newCycle: boolean;
  cycleStart: string;
  cycleEnd: string;
  reason: string;
  onReason: (value: string) => void;
  apply: MultiplierApply | null;
  onApply: (value: MultiplierApply) => void;
  from: string;
  to: string;
  onRange: (from: string, to: string) => void;
  impact: ReturnType<typeof useMultiplierImpact>;
}) {
  const data = impact.impact;
  const today = data?.today ?? "";
  const ended = !!today && cycleEnd < today;
  const effect = (o: MultiplierApply) => {
    const x = data?.options[o];
    if (!x) return "";
    if (!x.days) return "Nenhum dia registrado muda.";
    return `Muda ${plural(x.days, "dia registrado", "dias registrados")}${
      x.manual ? ` (${x.manual} editado${x.manual === 1 ? "" : "s"} à mão)` : ""
    }; débito no Financeiro › Mídia: ${signed(x.diff)}.`;
  };
  const options: [MultiplierApply, string, string][] = [
    [
      "all",
      "Todos os dias do ciclo",
      `Os dias já registrados passam a usar M ${m(next)}. O investimento com M desses dias e o débito no Financeiro › Mídia são refeitos. O ciclo fica com um M só e os números batem em toda a tela. Use quando o M estava errado desde o início.`,
    ],
    [
      "forward",
      ended
        ? "Só daqui para frente (o ciclo já terminou)"
        : `Só daqui para frente (a partir de hoje${today ? `, ${day5(today)}` : ""})`,
      ended
        ? `Nenhum dia registrado muda: continuam com o M que têm. Muda só o M do ciclo (verba sem M e meta de custo), e o ciclo passa a ter dias com um M diferente do dele.`
        : `Os dias até ontem continuam com o M que têm (o Financeiro não muda para trás); hoje e os próximos dias usam M ${m(next)}. Use quando o índice da operação mudou agora. Atenção: o ciclo passa a ter dias com M diferentes, e a verba sem M e a meta de custo usam o M novo para o ciclo todo.`,
    ],
    [
      "range",
      "Um período",
      `Só os dias registrados no período escolhido passam a usar M ${m(next)}; os de fora mantêm o M que têm. Os dias que ainda vão entrar usam sempre o M novo. Use para corrigir dias específicos.`,
    ],
  ];
  const choose = !newCycle && !!data && data.registered > 0;
  return (
    <fieldset className="campaign-shared-day campaign-m-change">
      <legend>
        <Scale size={15} /> Alteração do M: {m(previous)} → {m(next)}
      </legend>
      <label>
        Motivo da alteração
        <Textarea
          value={reason}
          onChange={(e) => onReason(e.target.value)}
          rows={2}
          maxLength={1000}
          required
          placeholder="Ex.: novo índice acordado com o cliente a partir de outubro"
        />
        <small>
          Obrigatório. Fica no histórico da campanha e no registro de
          alterações do M, que ninguém edita nem apaga.
        </small>
      </label>
      {!newCycle && impact.loading && !data && (
        <p className="cell-note">Conferindo os dias já registrados…</p>
      )}
      {!newCycle && impact.error && (
        <p className="form-error" role="alert">
          Não foi possível conferir os dias registrados: {impact.error}
        </p>
      )}
      {!newCycle && data && !data.registered && (
        <p className="cell-note">
          O ciclo ainda não tem dias registrados: todos os dias que entrarem
          usam o M novo.
        </p>
      )}
      {choose && (
        <>
          <p>
            O ciclo tem {plural(data.registered, "dia registrado", "dias registrados")}
            {data.first_day && data.last_day
              ? ` (${day5(data.first_day)} a ${day5(data.last_day)})`
              : ""}
            , cada um com o M de quando entrou. A quais deles o M novo se
            aplica? Os dias que ainda vão entrar usam sempre o M novo.
          </p>
          <div
            className="campaign-shared-options"
            role="radiogroup"
            aria-label="A quais dias o M novo se aplica"
          >
            {options.map(([o, label, hint]) => (
              <label key={o} className="share-toggle">
                <input
                  type="radio"
                  name="multiplier-apply"
                  checked={apply === o}
                  onChange={() => onApply(o)}
                />
                <span>
                  <strong>{label}</strong>
                  <small>{hint}</small>
                  {o === "range" && apply === "range" && (
                    <span className="campaign-m-range">
                      <Input
                        type="date"
                        aria-label="De"
                        value={from}
                        min={cycleStart}
                        max={to || cycleEnd}
                        onChange={(e) => onRange(e.target.value, to)}
                        required
                      />
                      <span>a</span>
                      <Input
                        type="date"
                        aria-label="Até"
                        value={to}
                        min={from || cycleStart}
                        max={cycleEnd}
                        onChange={(e) => onRange(from, e.target.value)}
                        required
                      />
                    </span>
                  )}
                  {(o !== "range" || (from && to)) && effect(o) && (
                    <small className="campaign-m-effect">{effect(o)}</small>
                  )}
                </span>
              </label>
            ))}
          </div>
        </>
      )}
    </fieldset>
  );
}

/* ------------------------------------------------------------------ */
/* The log                                                             */

const kindLabel = (l: MultiplierLogItem) =>
  l.kind === "day"
    ? `Dia ${l.day ? shortDate(l.day) : ""} (Dia a Dia)`
    : l.kind === "new_cycle"
      ? "Novo ciclo"
      : "Ciclo";
function applyLabel(l: MultiplierLogItem) {
  if (l.kind !== "cycle") return "";
  const n = l.days.length;
  const days = n ? plural(n, "dia registrado mudou", "dias registrados mudaram") : "nenhum dia registrado mudou";
  if (l.apply === "all") return `Todos os dias do ciclo · ${days}`;
  if (l.apply === "forward") return `Daqui para frente · ${days}`;
  if (l.apply === "range" && l.apply_from && l.apply_to)
    return `${shortDate(l.apply_from)} a ${shortDate(l.apply_to)} · ${days}`;
  return days;
}

/**
 * Every change of the M in the company, newest first, with who, when,
 * from/to, the reason and the days it reached; and the cycles still below
 * 1 from before the rule. Administrators and managers.
 */
export function MultiplierLog({
  backend,
  company,
  href,
  onClose,
}: {
  backend: MultiplierBackend;
  company: string;
  /** A campaign's own address (opens in a new tab). */
  href: (id: string) => string;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [items, setItems] = useState<MultiplierLogItem[] | null>(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [below, setBelow] = useState<MultiplierBelow[] | null>(null);
  const [showBelow, setShowBelow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSearch(typed.trim()), 300);
    return () => clearTimeout(t);
  }, [typed]);
  useEffect(() => {
    let live = true;
    setItems(null);
    backend
      .log(company, { search, from: from || null, to: to || null })
      .then((r) => {
        if (!live) return;
        setItems(r.items);
        setMore(r.more);
        setError("");
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [backend, company, search, from, to]);
  useEffect(() => {
    let live = true;
    backend
      .belowMin(company)
      .then((r) => live && setBelow(r))
      .catch(() => live && setBelow([]));
    return () => {
      live = false;
    };
  }, [backend, company]);
  async function loadMore() {
    if (!items?.length) return;
    setLoadingMore(true);
    try {
      const r = await backend.log(company, {
        search,
        from: from || null,
        to: to || null,
        before: items[items.length - 1].id,
      });
      setItems([...items, ...r.items]);
      setMore(r.more);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }
  const campaignLink = (id: string, name: string) => (
    <a href={href(id)} target="_blank" rel="noreferrer">
      {name || "Campanha removida"}
    </a>
  );
  return (
    <Modal title="Alterações do índice de performance (M)" onClose={onClose} wide>
      <div className="campaign-m-log">
        <p className="campaign-form-context">
          Toda alteração do M (ciclo, novo ciclo com M diferente do anterior e
          M de um dia no Dia a Dia) com quem alterou, quando, de quanto para
          quanto, o motivo e os dias registrados que mudaram. O registro é
          permanente: ninguém edita nem apaga.
        </p>
        {below && below.length > 0 && (
          <div className="campaign-m-below">
            <button
              type="button"
              className="text-btn"
              aria-expanded={showBelow}
              onClick={() => setShowBelow(!showBelow)}
            >
              <TriangleAlert size={14} />{" "}
              {plural(below.length, "ciclo com M abaixo de 1", "ciclos com M abaixo de 1")}{" "}
              (de antes da regra) · {showBelow ? "Esconder" : "Ver lista"}
            </button>
            {showBelow && (
              <div className="table-scroll">
                <table className="campaign-table stack-mobile">
                  <thead>
                    <tr>
                      <th>Campanha</th>
                      <th>Cliente</th>
                      <th>Ciclo</th>
                      <th>M do ciclo</th>
                      <th>Dias abaixo de 1</th>
                    </tr>
                  </thead>
                  <tbody>
                    {below.map((b) => (
                      <tr key={b.cycle_id}>
                        <td data-label="Campanha">
                          {campaignLink(b.campaign_id, b.campaign)}
                          {b.archived && <small className="cell-note"> (arquivada)</small>}
                        </td>
                        <td data-label="Cliente">
                          {b.client}
                          {b.product && <small className="cell-note"> · {b.product}</small>}
                        </td>
                        <td data-label="Ciclo">
                          {shortDate(b.start_date)} a {shortDate(b.end_date)}
                        </td>
                        <td data-label="M do ciclo">{m(b.multiplier)}</td>
                        <td data-label="Dias abaixo de 1">
                          {b.days_below
                            ? `${b.days_below} (menor: ${m(b.lowest_day)})`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <small className="cell-note">
                  Ficam como estão. Para corrigir, edite o ciclo (ou o dia no
                  Dia a Dia) com um M de 1 ou mais e o motivo.
                </small>
              </div>
            )}
          </div>
        )}
        <div className="campaign-filters campaign-m-filters">
          <Input
            type="search"
            aria-label="Buscar campanha, cliente ou produto"
            placeholder="Buscar campanha, cliente ou produto"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <label>
            De
            <Input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            Até
            <Input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {!items && !error ? (
          <Loading variant="table" />
        ) : items && items.length ? (
          <div className="table-scroll">
            <table className="campaign-table stack-mobile campaign-m-table">
              <thead>
                <tr>
                  <th>Quando</th>
                  <th>Quem</th>
                  <th>Campanha</th>
                  <th>Onde</th>
                  <th>M</th>
                  <th>Dias registrados</th>
                  <th title="Quanto o investimento com M dos dias que mudaram variou (o ajuste no débito de mídia)">
                    Financeiro
                  </th>
                  <th>Motivo</th>
                </tr>
              </thead>
              <tbody>
                {items.map((l) => (
                  <tr key={l.id}>
                    <td data-label="Quando">
                      {new Date(l.at).toLocaleString("pt-BR", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </td>
                    <td data-label="Quem">{l.actor_name || "—"}</td>
                    <td data-label="Campanha">
                      {campaignLink(l.campaign_id, l.campaign)}
                      <small className="cell-note">
                        {" "}
                        {[l.client, l.product, l.platform ? platforms[l.platform as AdPlatform] : ""]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    </td>
                    <td data-label="Onde">
                      {kindLabel(l)}
                      {l.cycle_start && l.cycle_end && (
                        <small className="cell-note">
                          {" "}
                          ciclo de {day5(l.cycle_start)} a {day5(l.cycle_end)}
                        </small>
                      )}
                    </td>
                    <td data-label="M">
                      <strong>
                        {m(l.from)} → {m(l.to)}
                      </strong>
                    </td>
                    <td data-label="Dias registrados">
                      {l.kind === "cycle" ? applyLabel(l) : l.kind === "day" ? "Só esse dia" : "—"}
                    </td>
                    <td data-label="Financeiro">{signed(Number(l.media_diff))}</td>
                    <td data-label="Motivo" className="campaign-m-reason">
                      {l.reason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {more && (
              <Button
                className="btn secondary campaign-m-more"
                loading={loadingMore}
                onClick={() => void loadMore()}
              >
                Carregar mais
              </Button>
            )}
          </div>
        ) : (
          <Empty
            title="Nenhuma alteração do M"
            body={
              search || from || to
                ? "Nada com esses filtros."
                : "As alterações aparecem aqui a partir de agora."
            }
          />
        )}
      </div>
    </Modal>
  );
}

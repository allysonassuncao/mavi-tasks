import { useEffect, useMemo, useState, type MouseEvent } from "react";
import {
  ChevronDown,
  ExternalLink,
  Plus,
  ShieldCheck,
  TriangleAlert,
  Wallet,
} from "lucide-react";
import { Button, Textarea } from "./ui";
import {
  addDays,
  money,
  shortDate,
  type AdCampaign,
  type AdCycle,
  type CampaignsBackend,
} from "./campaigns";
import {
  canRelease,
  cycleFit,
  runway,
  type MediaRoom,
} from "./campaign-media";
import { coalesce } from "./finance-media";
import { navigate, pageUrl, routeParts } from "./router";
import "./campaign-media.css";

/**
 * Campanhas × Financeiro › Mídia (migration 20270222090000): the client's
 * media balance in the campaign's detail, and the check of the cycle's
 * budget in the cycle form. The values are the client's money (with M).
 */

const LEVEL_LABEL = { low: "Baixo", negative: "Negativo" } as const;

/** Financeiro › Mídia, on the account (and its "Nova entrada" form). */
function financeHref(contract: string, launch = false) {
  const company = routeParts(window.location.pathname).company;
  return `${pageUrl("financeMedia", company)}?contrato=${encodeURIComponent(contract)}${launch ? "&lancar=entrada" : ""}`;
}
const openInApp = (href: string) => (e: MouseEvent) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(href);
};

/**
 * The room of the campaign's account, read again when the account changes
 * (Realtime "media" notices, no polling) or `refresh` does.
 */
export function useMediaRoom(
  backend: CampaignsBackend,
  campaign: AdCampaign,
  refresh: unknown,
) {
  const [room, setRoom] = useState<MediaRoom | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    backend
      .mediaRoom(campaign)
      .then((r) => {
        if (!live) return;
        setRoom(r);
        setError("");
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [backend, campaign, refresh, tick]);
  // The Campanhas sync sends one notice per day it records: one read after
  // the burst.
  const again = useMemo(() => coalesce(() => setTick((t) => t + 1)), []);
  useEffect(() => {
    const onChange = (e: Event) => {
      const contracts = (e as CustomEvent<{ contracts: string[] | null }>)
        .detail?.contracts;
      if (!contracts || contracts.includes(campaign.contract_id)) again();
    };
    window.addEventListener("mavi:media", onChange);
    return () => {
      window.removeEventListener("mavi:media", onChange);
      again.cancel();
    };
  }, [again, campaign.contract_id]);
  return { room, error };
}

export function CampaignMediaBalance({
  backend,
  campaign,
  current,
  today,
  refresh,
}: {
  backend: CampaignsBackend;
  campaign: AdCampaign;
  current: AdCycle | null;
  today: string;
  refresh: unknown;
}) {
  const { room, error } = useMediaRoom(backend, campaign, refresh);
  const [open, setOpen] = useState(false);
  if (error)
    return (
      <p className="media-room-error" role="status">
        Não foi possível carregar o saldo de mídia: {error}
      </p>
    );
  if (!room) return <section className="panel media-room is-loading" aria-busy="true" />;

  const days = runway(room);
  const until = days === null ? null : addDays(today, days);
  const runsOut =
    until !== null &&
    current !== null &&
    current.end_date >= today &&
    until < current.end_date;
  const statement = financeHref(room.contract_id);
  const launch = financeHref(room.contract_id, true);
  return (
    <section className="panel media-room" aria-label="Saldo de mídia">
      <div className="media-room-head">
        <span className="media-room-title">
          <Wallet size={16} aria-hidden="true" /> Saldo de mídia
          <small>
            {room.client_name} › {room.product_name} · valores com M (o dinheiro
            do cliente)
          </small>
        </span>
        {room.finance && (
          <span className="media-room-links">
            <a className="btn secondary" href={statement} onClick={openInApp(statement)}>
              <ExternalLink size={14} aria-hidden="true" /> Ver extrato
            </a>
            <a className="btn secondary" href={launch} onClick={openInApp(launch)}>
              <Plus size={14} aria-hidden="true" /> Lançar entrada
            </a>
          </span>
        )}
      </div>
      <dl className="media-room-grid">
        <div>
          <dt>Saldo atual</dt>
          <dd>
            <strong className={room.balance < 0 ? "neg" : ""}>{money(room.balance)}</strong>
            {room.level !== "ok" && (
              <span className={`media-level ${room.level}`}>{LEVEL_LABEL[room.level]}</span>
            )}
          </dd>
          {room.min_balance !== null && <small>mínimo {money(room.min_balance)}</small>}
        </div>
        <div>
          <dt title="O que os ciclos ainda não encerrados das campanhas deste produto ainda vão gastar">
            Reservado nos ciclos
          </dt>
          <dd>
            <strong>{money(room.reserved)}</strong>
          </dd>
          {room.reservations.length > 0 && (
            <button
              type="button"
              className="text-btn media-room-toggle"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              {room.reservations.length}{" "}
              {room.reservations.length === 1 ? "ciclo aberto" : "ciclos abertos"}
              <ChevronDown size={13} aria-hidden="true" />
            </button>
          )}
        </div>
        <div>
          <dt title="Saldo atual − reservado: o que cabe em novos ciclos">
            Disponível para novos ciclos
          </dt>
          <dd>
            <strong className={room.available < 0 ? "neg" : room.available > 0 ? "pos" : ""}>
              {money(room.available)}
            </strong>
          </dd>
        </div>
        <div>
          <dt title="Gasto × M do produto contratado nos últimos 7 dias completos">Ritmo</dt>
          <dd>
            <strong>{room.daily > 0 ? `${money(room.daily)}/dia` : "—"}</strong>
          </dd>
          {until !== null && (
            <small>
              {room.balance <= 0
                ? "saldo já acabou"
                : `dura ~${days} ${days === 1 ? "dia" : "dias"} (até ${shortDate(until)})`}
            </small>
          )}
        </div>
      </dl>
      {open && (
        <div className="table-scroll">
          <table className="campaign-table media-room-table stack-mobile">
            <thead>
              <tr>
                <th>Campanha</th>
                <th>Ciclo</th>
                <th>Verba</th>
                <th>Gasto</th>
                <th>Reservado</th>
              </tr>
            </thead>
            <tbody>
              {room.reservations.map((r) => (
                <tr key={r.cycle_id} className={r.campaign_id === campaign.id ? "campaign-current" : ""}>
                  <td>
                    <strong>{r.campaign_name}</strong>
                  </td>
                  <td data-label="Ciclo">
                    {shortDate(r.start_date)} a {shortDate(r.end_date)}
                  </td>
                  <td data-label="Verba">{money(r.budget)}</td>
                  <td data-label="Gasto">{money(r.spent)}</td>
                  <td data-label="Reservado">{money(r.remaining)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {room.entries === 0 ? (
        <p className="media-room-note warn">
          <TriangleAlert size={15} aria-hidden="true" />
          A conta de mídia deste produto ainda não tem lançamentos. Lance o saldo
          inicial no Financeiro › Mídia para liberar novos ciclos.
        </p>
      ) : room.available < 0 ? (
        <p className="media-room-note danger">
          <TriangleAlert size={15} aria-hidden="true" />
          Os ciclos abertos pedem {money(-room.available)} a mais do que o saldo.
          Novos ciclos ficam travados até entrar mais verba.
        </p>
      ) : runsOut ? (
        <p className="media-room-note warn">
          <TriangleAlert size={15} aria-hidden="true" />
          No ritmo da última semana, o saldo acaba por volta de {shortDate(until!)},
          antes do fim do ciclo atual ({shortDate(current!.end_date)}).
        </p>
      ) : null}
    </section>
  );
}

/**
 * Under "Verba do ciclo": what is available and, when the budget does not
 * fit, how much is missing, the shortcuts and the leaders' release.
 */
export function CycleMediaFit({
  room,
  error,
  cycle,
  endDate,
  budget,
  today,
  reason,
  onReason,
  onUseAvailable,
}: {
  room: MediaRoom | null;
  error: string;
  /** The cycle being edited (null: a new one). */
  cycle: AdCycle | null;
  endDate: string;
  budget: number;
  today: string;
  reason: string;
  onReason: (reason: string) => void;
  onUseAvailable: (value: number) => void;
}) {
  if (error)
    return (
      <p className="media-fit muted">
        Não foi possível conferir o saldo de mídia agora ({error}). Ao salvar, o
        sistema confere de novo.
      </p>
    );
  if (!room) return <p className="media-fit muted">Conferindo o saldo de mídia…</p>;
  const valid = Number.isFinite(budget) && budget > 0 && !!endDate;
  const fit = cycleFit(
    room,
    { id: cycle?.id ?? null, end_date: endDate || today, budget: valid ? budget : 0 },
    today,
  );
  const launch = financeHref(room.contract_id, true);
  if (!valid || fit.free)
    return (
      <p className="media-fit">
        <Wallet size={14} aria-hidden="true" />
        {endDate && endDate < today
          ? "Ciclo já encerrado: não reserva saldo de mídia."
          : `Disponível para ciclos: ${money(fit.available)} (saldo ${money(room.balance)} − reservado ${money(room.reserved)}).`}
      </p>
    );
  if (!fit.shortfall)
    return (
      <p className="media-fit ok">
        <Wallet size={14} aria-hidden="true" />
        Cabe no saldo de mídia: disponível {money(fit.available)}; depois deste
        ciclo sobram {money(fit.available - fit.need)}.
      </p>
    );
  const release = canRelease(room, fit.shortfall);
  return (
    <div className="media-fit danger" role="alert">
      <p>
        <TriangleAlert size={15} aria-hidden="true" />
        <span>
          <strong>Saldo de mídia insuficiente.</strong> Disponível para ciclos{" "}
          {money(fit.available)}; este ciclo precisa de {money(fit.need)}.{" "}
          <strong>Faltam {money(fit.shortfall)}.</strong>
        </span>
      </p>
      <div className="media-fit-actions">
        {fit.available > 0 && (
          <Button
            type="button"
            className="btn secondary"
            onClick={() => onUseAvailable(fit.available + (fit.need < budget ? budget - fit.need : 0))}
          >
            Usar o disponível
          </Button>
        )}
        {room.finance && (
          <a className="btn secondary" href={launch} target="_blank" rel="noopener">
            <Plus size={14} aria-hidden="true" /> Lançar entrada no Financeiro
          </a>
        )}
      </div>
      {release ? (
        <label className="media-fit-release">
          <span>
            <ShieldCheck size={14} aria-hidden="true" /> Liberar acima do saldo
            (até {money(room.override_cap)}): motivo
          </span>
          <Textarea
            value={reason}
            onChange={(e) => onReason(e.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="Ex.: o cliente enviou o comprovante do PIX; o lançamento entra hoje"
          />
          <small>A liberação e o motivo ficam no histórico da campanha.</small>
        </label>
      ) : (
        <small>
          {room.can_override
            ? room.override_cap > 0
              ? `Acima do limite de liberação desta empresa (${money(room.override_cap)}).`
              : "A liberação acima do saldo está desligada nesta empresa (um administrador define o limite em Financeiro › Mídia)."
            : "Lance a entrada no Financeiro › Mídia ou peça a um administrador ou gestor para liberar."}
          {room.finance ? "" : " A entrada é lançada por quem usa o Financeiro › Mídia."}
        </small>
      )}
    </div>
  );
}

/** Whether the form may be sent (the database checks it again). */
export function cycleMediaBlocked(
  room: MediaRoom | null,
  cycle: AdCycle | null,
  endDate: string,
  budget: number,
  today: string,
  reason: string,
) {
  if (!room || !Number.isFinite(budget) || budget <= 0 || !endDate) return false;
  const fit = cycleFit(room, { id: cycle?.id ?? null, end_date: endDate, budget }, today);
  if (!fit.shortfall) return false;
  return !(canRelease(room, fit.shortfall) && reason.trim().length >= 3);
}

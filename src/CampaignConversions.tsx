import { useEffect, useState } from "react";
import { Button, Checkbox, Loading } from "./ui";
import { Modal } from "./components";
import {
  PHONE_CALLS,
  shortDate,
  type AdCycle,
  type AdsBackend,
  type CampaignsBackend,
  type ConversionActionsView,
} from "./campaigns";

const count = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });

/**
 * "Conversões do Google que contam": the cycle's conversion actions on
 * Google (in the cycle, up to yesterday), and which count as its result.
 * Without a choice, Google's categories of the objective decide (form,
 * contact, call… for leads; purchase for sales); a choice counts only the
 * ticked ones. Saving syncs the campaign again (the whole cycle).
 */
export function GoogleConversions({
  ads,
  backend,
  company,
  cycle,
  onClose,
  onSaved,
}: {
  ads: AdsBackend;
  backend: CampaignsBackend;
  company: string;
  cycle: AdCycle;
  onClose: () => void;
  /** After saving: sync and reload the numbers. */
  onSaved: (message: string) => Promise<void>;
}) {
  const [view, setView] = useState<ConversionActionsView | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    ads
      .conversionActions(company, cycle.id)
      .then((v) => {
        if (!live) return;
        setView(v);
        setPicked(
          new Set([
            ...v.actions.filter((a) => a.counted).map((a) => a.id),
            ...(v.calls_counted ? [PHONE_CALLS] : []),
          ]),
        );
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [ads, company, cycle.id]);

  const toggle = (id: string, on: boolean) =>
    setPicked((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const total = view
    ? view.actions
        .filter((a) => picked.has(a.id))
        .reduce((n, a) => n + a.conversions, 0) +
      (picked.has(PHONE_CALLS) ? view.phone_calls : 0)
    : 0;
  const save = async (actions: string[] | null, message: string) => {
    setBusy(true);
    setError("");
    try {
      await backend.setConversionActions(cycle, actions);
      await onSaved(message);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Conversões do Google que contam"
      onClose={() => !busy && onClose()}
      busy={busy}
      wide
    >
      <div className="entity-form campaign-conversions">
        <p className="cell-note">
          As ações de conversão das campanhas do ciclo no Google Ads
          {view?.period
            ? ` (${shortDate(view.period.since)} a ${shortDate(view.period.until)})`
            : ""}
          . Marque as que são o resultado da campanha: só elas entram nas
          conversões, no custo por resultado e no status Bom/Ruim.{" "}
          {view?.selection
            ? "Este ciclo tem uma escolha própria."
            : "Sem escolha, contam as categorias do objetivo (formulário, contato, ligação, inscrição, orçamento, agendamento; em vendas, compra)."}
        </p>
        {!view && !error && <Loading compact />}
        {view && !view.period && (
          <p className="muted">
            O ciclo ainda não tem dias para ler (ele começa hoje ou depois) ou
            não tem campanhas vinculadas.
          </p>
        )}
        {view?.period && (
          <>
            <ul className="campaign-pick-list campaign-conversion-list">
              {view.actions.map((a) => (
                <li key={a.id}>
                  <label className="checkbox-label">
                    <Checkbox
                      checked={picked.has(a.id)}
                      disabled={busy}
                      onCheckedChange={(v) => toggle(a.id, v === true)}
                    />
                    <span>
                      {a.name}
                      <small className="cell-note">
                        {a.category_label}
                        {a.counted_by_default ? " · conta no padrão" : ""}
                      </small>
                    </span>
                  </label>
                  <strong>{count.format(a.conversions)}</strong>
                </li>
              ))}
              <li>
                <label className="checkbox-label">
                  <Checkbox
                    checked={picked.has(PHONE_CALLS)}
                    disabled={busy}
                    onCheckedChange={(v) => toggle(PHONE_CALLS, v === true)}
                  />
                  <span>
                    Ligações dos anúncios
                    <small className="cell-note">
                      Todas as ligações pelos anúncios (as que o Google conta
                      como conversão já estão acima, categoria Ligação)
                    </small>
                  </span>
                </label>
                <strong>{count.format(view.phone_calls)}</strong>
              </li>
              {!view.actions.length && (
                <li className="cell-note">
                  Nenhuma ação de conversão registrou resultados no ciclo.
                </li>
              )}
            </ul>
            <p className="campaign-conversion-total">
              Contam <strong>{count.format(total)}</strong>{" "}
              {total === 1 ? "conversão" : "conversões"} no ciclo
              {total !== view.counted &&
                ` (hoje: ${count.format(view.counted)})`}
              .
            </p>
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          <Button
            type="button"
            className="btn secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancelar
          </Button>
          {view?.selection && (
            <Button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() =>
                void save(
                  null,
                  "Conversões pelas categorias do objetivo. Números sincronizados.",
                )
              }
            >
              Usar o padrão
            </Button>
          )}
          <Button
            type="button"
            className="btn primary"
            loading={busy}
            disabled={!view?.period || !picked.size}
            onClick={() =>
              void save(
                [...picked],
                "Conversões do ciclo escolhidas. Números sincronizados.",
              )
            }
          >
            Salvar e sincronizar
          </Button>
        </div>
      </div>
    </Modal>
  );
}

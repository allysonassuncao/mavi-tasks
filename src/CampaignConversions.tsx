import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button, Checkbox, Input, Loading } from "./ui";
import { Modal } from "./components";
import {
  PHONE_CALLS,
  addDays,
  shortDate,
  type AdCycle,
  type AdsBackend,
  type CampaignsBackend,
  type ConversionActionsView,
  type MetaConversionMode,
  type MetaConversionRow,
  type MetaConversionsView,
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
            : "Sem escolha, contam as categorias do objetivo (formulário, contato, ligação, inscrição, orçamento, agendamento; em vendas, compra) e, como no MASO, as ações com WhatsApp, lead, contato, cadastro, inscrição, compra… no nome."}
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
                  "Conversões pelas categorias do objetivo e pelos nomes do MASO. Números sincronizados.",
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

const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

/**
 * "Conversões do Meta que contam": the action types of the cycle's
 * campaigns on Meta (in the cycle up to yesterday; before it starts, the
 * last 30 days) and the account's custom conversions; which count as the
 * cycle's result. Without a choice, the objective's rule decides; a choice
 * counts the sum of the ticked ones. Saving asks whether the whole cycle is
 * counted again or only from today on, then syncs the campaign.
 */
export function MetaConversions({
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
  const [view, setView] = useState<MetaConversionsView | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [useDefault, setUseDefault] = useState(false);
  const [mode, setMode] = useState<MetaConversionMode | null>(null);
  const [showEngagement, setShowEngagement] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    ads
      .metaConversions(company, cycle.id)
      .then((v) => {
        if (!live) return;
        setView(v);
        const start = new Set(
          v.current ?? v.actions.filter((a) => a.by_default).map((a) => a.type),
        );
        setPicked(start);
        setShowEngagement(
          v.actions.some((a) => a.engagement && start.has(a.type)),
        );
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [ads, company, cycle.id]);

  const byType = useMemo(
    () => new Map((view?.actions ?? []).map((a) => [a.type, a])),
    [view],
  );
  const nameOf = (type: string) => byType.get(type)?.label ?? type;
  const toggle = (type: string, on: boolean) =>
    setPicked((s) => {
      const next = new Set(s);
      if (on) next.add(type);
      else next.delete(type);
      return next;
    });

  // What counts today, to know whether anything changed.
  const before = useMemo(
    () =>
      new Set(
        view?.current ??
          view?.actions.filter((a) => a.by_default).map((a) => a.type) ??
          [],
      ),
    [view],
  );
  const changed = view
    ? useDefault
      ? view.current !== null
      : !sameSet(picked, before)
    : false;
  // Ticked ones that may count the same lead (or purchase…) twice.
  const overlaps = useMemo(() => {
    if (useDefault) return [];
    const list = [...picked]
      .map((t) => byType.get(t))
      .filter((a): a is MetaConversionRow => !!a);
    const pairs: [string, string][] = [];
    list.forEach((a, i) =>
      list.slice(i + 1).forEach((b) => {
        if (a.families.some((f) => b.families.includes(f)))
          pairs.push([a.label, b.label]);
      }),
    );
    return pairs;
  }, [picked, byType, useDefault]);

  const total = view
    ? view.actions
        .filter((a) => picked.has(a.type))
        .reduce((n, a) => n + a.conversions, 0)
    : 0;
  const started = view ? view.today > view.start_date : false;
  const ended = view ? view.today > view.end_date : false;
  // "Só daqui para frente" only while the cycle runs.
  const canForward = started && !ended;
  const effectiveMode: MetaConversionMode | null = canForward ? mode : "all";
  const yesterday = view ? addDays(view.today, -1) : "";

  const q = query.trim().toLocaleLowerCase("pt-BR");
  const matches = (a: MetaConversionRow) =>
    !q ||
    a.label.toLocaleLowerCase("pt-BR").includes(q) ||
    a.type.includes(q) ||
    picked.has(a.type);
  const conversions = view?.actions.filter((a) => !a.engagement && matches(a)) ?? [];
  const engagement = view?.actions.filter((a) => a.engagement && matches(a)) ?? [];

  const save = async () => {
    if (!view || !effectiveMode) return;
    setBusy(true);
    setError("");
    try {
      await backend.setMetaConversions(
        cycle,
        useDefault ? null : [...picked],
        effectiveMode,
      );
      await onSaved(
        effectiveMode === "all"
          ? "Conversões do ciclo escolhidas. O ciclo inteiro foi recalculado."
          : "Conversões escolhidas a partir de hoje. Os dias anteriores continuam como estavam.",
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const row = (a: MetaConversionRow) => (
    <li key={a.type}>
      <label className="checkbox-label" title={a.type}>
        <Checkbox
          checked={picked.has(a.type)}
          disabled={busy || useDefault}
          onCheckedChange={(v) => toggle(a.type, v === true)}
        />
        <span>
          {a.label}
          <small className="cell-note">
            {[a.detail, a.by_default ? "conta no padrão" : ""]
              .filter(Boolean)
              .join(" · ") || a.type}
          </small>
        </span>
      </label>
      <strong>{count.format(a.conversions)}</strong>
    </li>
  );

  return (
    <Modal
      title="Conversões do Meta que contam"
      onClose={() => !busy && onClose()}
      busy={busy}
      wide
    >
      <div className="entity-form campaign-conversions">
        <p className="cell-note">
          Os resultados das campanhas do ciclo no Meta Ads
          {view?.period
            ? ` (${shortDate(view.period.since)} a ${shortDate(view.period.until)})`
            : ""}
          . Marque os que são o resultado da campanha: só eles entram nas
          conversões, no custo por resultado e no status Bom/Ruim.{" "}
          {view &&
            (view.current
              ? view.inherited
                ? "Este ciclo herdou a escolha do ciclo anterior."
                : "Este ciclo tem uma escolha própria."
              : `Sem escolha, contam ${view.default_label}.`)}
        </p>
        {view?.make_page && (
          <p className="cell-note">
            Os cadastros da página de captura da Make contam sempre. O que você
            marcar aqui é somado a eles.
          </p>
        )}
        {view?.period && !view.period.cycle && (
          <p className="cell-note">
            O ciclo ainda não começou: os números são dos últimos 30 dias, só
            para ajudar a escolher.
          </p>
        )}
        {view?.rules && view.rules.length > 1 && (
          <ul className="campaign-conversion-rules cell-note">
            {view.rules.map((r, i) => {
              const next = view.rules![i + 1]?.from;
              const when = `${r.from ? `De ${shortDate(r.from)}` : `De ${shortDate(view.start_date)}`}${next ? ` a ${shortDate(addDays(next, -1))}` : " em diante"}`;
              return (
                <li key={`${r.from}-${i}`}>
                  {when}:{" "}
                  {r.actions
                    ? r.actions.map(nameOf).join(", ")
                    : `padrão (${view.default_label})`}
                </li>
              );
            })}
          </ul>
        )}
        {!view && !error && <Loading compact />}
        {view && !view.period && (
          <p className="muted">
            O ciclo não tem campanhas vinculadas no Meta Ads.
          </p>
        )}
        {view?.period && (
          <>
            {view.actions.length > 12 && (
              <Input
                type="search"
                placeholder="Buscar pelo nome"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                disabled={busy}
              />
            )}
            <ul
              className={`campaign-pick-list campaign-conversion-list${useDefault ? " is-default" : ""}`}
            >
              {conversions.map(row)}
              {!conversions.length && (
                <li className="cell-note">
                  {q
                    ? "Nenhum resultado com esse nome."
                    : "Nenhuma conversão registrada no período."}
                </li>
              )}
              {engagement.length > 0 && (
                <li className="campaign-conversion-more">
                  <Button
                    type="button"
                    className="text-btn"
                    onClick={() => setShowEngagement((s) => !s)}
                  >
                    {showEngagement
                      ? "Esconder cliques e engajamento"
                      : `Mostrar cliques e engajamento (${engagement.length})`}
                  </Button>
                </li>
              )}
              {showEngagement && engagement.map(row)}
            </ul>
            {useDefault ? (
              <p className="campaign-conversion-total">
                Volta para a regra padrão: contam {view.default_label}.{" "}
                <Button
                  type="button"
                  className="text-btn"
                  onClick={() => setUseDefault(false)}
                  disabled={busy}
                >
                  Desfazer
                </Button>
              </p>
            ) : (
              <p className="campaign-conversion-total">
                Contam <strong>{count.format(total)}</strong>{" "}
                {total === 1 ? "conversão" : "conversões"}{" "}
                {view.period.cycle ? "no ciclo" : "nos últimos 30 dias"}
                {view.make_page ? ", além dos cadastros da Make" : ""}
                {view.counted !== null &&
                  total !== view.counted &&
                  ` (hoje: ${count.format(view.counted)})`}
                .
              </p>
            )}
            {overlaps.length > 0 && (
              <p className="share-warning" role="status">
                <AlertTriangle size={14} aria-hidden="true" />
                <span>
                  {overlaps
                    .map(([a, b]) => `"${a}" e "${b}"`)
                    .join("; ")}{" "}
                  podem contar o mesmo resultado duas vezes (o Meta registra o
                  mesmo lead ou compra em mais de um tipo). Você pode salvar
                  assim, mas confira se é isso mesmo.
                </span>
              </p>
            )}
            {changed && (
              <fieldset className="share-block campaign-conversion-mode">
                <strong className="share-title">Como aplicar a mudança</strong>
                {canForward ? (
                  <>
                    <label className="share-toggle">
                      <input
                        type="radio"
                        name="meta-conversion-mode"
                        checked={mode === "all"}
                        onChange={() => setMode("all")}
                        disabled={busy}
                      />
                      <span>
                        <strong>Recalcular o ciclo inteiro</strong>
                        <small>
                          Todos os dias desde o início do ciclo (
                          {shortDate(view.start_date)}) passam a contar a nova
                          escolha. O Dia a Dia, a Linha do tempo, o custo por
                          resultado e o status Bom/Ruim do ciclo são refeitos.
                          Use quando a contagem antiga estava errada. Dias
                          editados à mão e relatórios já gerados não mudam.
                        </small>
                      </span>
                    </label>
                    <label className="share-toggle">
                      <input
                        type="radio"
                        name="meta-conversion-mode"
                        checked={mode === "forward"}
                        onChange={() => setMode("forward")}
                        disabled={busy}
                      />
                      <span>
                        <strong>Só daqui para frente</strong>
                        <small>
                          Os dias até ontem ({shortDate(yesterday)}) continuam
                          com a contagem de antes e a nova escolha vale a
                          partir de hoje ({shortDate(view.today)}). Use quando
                          algo mudou na campanha agora (um evento novo no site,
                          outro formulário). Os números de hoje entram na
                          sincronização de amanhã.
                        </small>
                      </span>
                    </label>
                  </>
                ) : (
                  <small className="share-hint">
                    {ended
                      ? "O ciclo já terminou: a nova escolha recalcula o ciclo inteiro (Dia a Dia, Linha do tempo, custo por resultado e status Bom/Ruim). Dias editados à mão e relatórios já gerados não mudam."
                      : "O ciclo ainda não começou: a nova escolha vale para o ciclo inteiro."}
                  </small>
                )}
              </fieldset>
            )}
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
          {view?.current && !useDefault && (
            <Button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => setUseDefault(true)}
            >
              Usar o padrão
            </Button>
          )}
          <Button
            type="button"
            className="btn primary"
            loading={busy}
            disabled={
              !view?.period ||
              !changed ||
              !effectiveMode ||
              (!useDefault && !picked.size)
            }
            title={
              changed && !effectiveMode
                ? "Escolha como aplicar a mudança"
                : undefined
            }
            onClick={() => void save()}
          >
            Salvar e sincronizar
          </Button>
        </div>
      </div>
    </Modal>
  );
}

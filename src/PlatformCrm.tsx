import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  crmIndex,
  crmKeyLabel,
  type CrmCounts,
  type CrmIndex,
  type CrmKey,
  type CrmLevel,
  type PlatformCrm,
} from "./platform-crm";
import "./platform-crm.css";

/**
 * Campanhas › Plataforma × MakeCRM (src/platform-crm.ts): reads the CRM's
 * numbers for the period once — only while a CRM column is on screen — and
 * again on "Atualizar".
 */
export function useCrmUtm(
  crm: PlatformCrm | null,
  wanted: boolean,
  since: string,
  until: string,
  refresh: number,
) {
  const [state, setState] = useState<{
    index: CrmIndex | null;
    linked: boolean;
    error: string;
    loading: boolean;
  }>({ index: null, linked: !!crm?.linked, error: "", loading: false });
  const load = useRef(crm?.load);
  load.current = crm?.load;
  const lastRefresh = useRef(refresh);
  const on = !!crm?.linked && wanted;
  useEffect(() => {
    if (!on || !load.current) {
      setState({ index: null, linked: !!crm?.linked, error: "", loading: false });
      return;
    }
    const fresh = lastRefresh.current !== refresh;
    lastRefresh.current = refresh;
    let live = true;
    setState((s) => ({ ...s, linked: true, error: "", loading: true }));
    load
      .current(since, until, fresh)
      .then((d) => {
        if (live)
          setState({ index: crmIndex(d), linked: d.linked, error: "", loading: false });
      })
      .catch((e) => {
        if (live)
          setState({ index: null, linked: true, error: (e as Error).message, loading: false });
      });
    return () => {
      live = false;
    };
    // crm.linked is in "on".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, since, until, refresh]);
  return state;
}

const count = (n: number) => n.toLocaleString("pt-BR");

/**
 * Above the table: why the CRM columns are empty; below it, the CRM's UTMs
 * that no row here answers for (as the CRM's Anúncios page shows them).
 */
export function CrmNotice({
  crm,
  state,
}: {
  crm: PlatformCrm | null;
  state: ReturnType<typeof useCrmUtm>;
}) {
  if (!crm)
    return (
      <div className="pcrm-notice">
        As colunas do MakeCRM precisam de um cliente nesta campanha.
      </div>
    );
  if (!crm.linked || !state.linked)
    return (
      <div className="pcrm-notice">
        <strong>{crm.clientName}</strong> não está ligado a uma empresa do
        MakeCRM: as colunas do CRM ficam vazias. Um administrador ou gestor
        liga em Campanhas › Conexões › MakeCRM.
      </div>
    );
  if (state.error)
    return (
      <div className="pcrm-notice bad" role="alert">
        <strong>Não foi possível ler o MakeCRM.</strong> {state.error}
      </div>
    );
  if (state.loading && !state.index)
    return <div className="pcrm-notice">Lendo as oportunidades do MakeCRM…</div>;
  return null;
}

export function CrmUnmatched({
  level,
  items,
  money,
  noun,
}: {
  level: CrmLevel;
  items: { key: CrmKey; counts: CrmCounts }[];
  money: (v: number) => string;
  /** "campanha nesta conta", "conjunto nestas campanhas"… */
  noun: string;
}) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  const shown = items.slice(0, 200);
  return (
    <div className="pcrm-unmatched">
      <button type="button" className="pcrm-unmatched-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {items.length === 1
          ? "1 UTM do MakeCRM sem"
          : `${count(items.length)} UTMs do MakeCRM sem`}{" "}
        {noun} com o mesmo nome
      </button>
      {open && (
        <>
          <p className="pcrm-hint">
            O CRM liga pelo nome exato (maiúsculas e espaços contam):
            utm_campaign = campanha, utm_term = conjunto ou grupo,
            utm_content = anúncio. Estas oportunidades têm UTM, mas nenhum
            nome daqui é igual.
          </p>
          <table className="pcrm-unmatched-table">
            <thead>
              <tr>
                <th>UTM no CRM</th>
                <th className="num">Oportunidades</th>
                <th className="num">Ganhos</th>
                <th className="num">Receita</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(({ key, counts }) => {
                const label = crmKeyLabel(level, key);
                return (
                  <tr key={label}>
                    <td title={label}>{label}</td>
                    <td className="num">{count(counts.leads)}</td>
                    <td className="num">{count(counts.wons)}</td>
                    <td className="num">{money(counts.revenue)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {items.length > shown.length && (
            <p className="pcrm-hint">Mostrando as 200 com mais oportunidades.</p>
          )}
        </>
      )}
    </div>
  );
}

/** The opportunities' number: opens the CRM's pipeline filtered. */
export function CrmLeadsLink({
  value,
  label,
  onOpen,
}: {
  value: number;
  label: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="pcrm-link"
      title="Abrir estas oportunidades no MakeCRM (aba nova, já logado)"
      onClick={onOpen}
    >
      {label || count(value)}
    </button>
  );
}

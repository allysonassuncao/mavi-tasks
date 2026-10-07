import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "./ui";
import { labelMesFull, numberFormat } from "./cs-engine";
import { HS_CRITERIA, evidenceLink, type HsCriterion, type HsKey } from "./cs-hs";
import type { HsItem } from "./cs-dashboard";
import { csPill, useCs } from "./CsCommon";

/**
 * A sugestão de Health Score da MAVI (fase 4b, migração 20270524090000): no
 * Bloco 3 do CS Make, a lista do mês com a nota lançada ao lado da sugerida;
 * no perfil do cliente, cada critério com o porquê e a evidência. O time
 * confere e lança (Customer Success › Health Score, ou a planilha enquanto ela for a fonte).
 */

const MARK = (v: boolean | null | undefined) => (v === true ? "✓" : v === false ? "✗" : "?");
const markClass = (v: boolean | null | undefined) => (v === true ? "good" : v === false ? "bad" : "unknown");
/** Os critérios em que a sugestão difere do que foi lançado. */
export function hsDiffs(it: HsItem) {
  if (!it.registered) return [];
  return HS_CRITERIA.filter((c) => {
    const s = it.criteria[c.key]?.value;
    return s !== null && s !== undefined && s !== it.registered![c.key];
  }).map((c) => c.key);
}

export function HsSuggestionsCard({ mes }: { mes: string }) {
  const { e, hs, requestHs, profile } = useCs();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  if (!hs) return null;
  const done = hs.items.filter((x) => x.done_at && x.score !== null);
  const rows = done
    .map((x) => ({ x, diffs: hsDiffs(x), c: e.clientOf(x.cs_client_id) }))
    .filter((r) => r.c)
    .sort((a, b) => b.diffs.length - a.diffs.length || Math.abs((b.x.score ?? 0) - (b.x.registered?.score ?? 0)) -
      Math.abs((a.x.score ?? 0) - (a.x.registered?.score ?? 0)) || a.c.name.localeCompare(b.c.name, "pt-BR"));
  const divergent = rows.filter((r) => r.diffs.length).length;
  const failed = hs.items.filter((x) => x.error && !x.done_at).length;
  return (
    <div className="cs-card cs-hs-card">
      <div className="cs-row-between wrap">
        <div>
          <div className="cs-label"><Sparkles size={13} /> Sugestão de Health Score da MAVI — {labelMesFull(mes)}</div>
          <span className="cs-muted cs-small">
            Pagamento e reunião pelos dados; meta, percepção de valor e criativos a MAVI lê nas campanhas, Termômetro, Social Leads,
            WhatsApp e Radar. Confira e lance (em Customer Success, ou na planilha enquanto ela for a fonte).
          </span>
        </div>
        {requestHs && (
          <Button className="btn secondary small" loading={busy} onClick={async () => {
            setBusy(true);
            setMsg("");
            try {
              await requestHs();
              setMsg("Pedido enviado: as sugestões chegam em alguns minutos.");
            } catch (err) {
              setMsg((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}>
            <Sparkles size={14} /> {done.length ? "Refazer as sugestões" : "Pedir sugestões agora"}
          </Button>
        )}
      </div>
      {msg && <p className="cs-small cs-info-text">{msg}</p>}
      {hs.pending > 0 && <p className="cs-small cs-muted">⏳ {hs.pending} {hs.pending === 1 ? "cliente" : "clientes"} em análise pela MAVI.</p>}
      {failed > 0 && <p className="cs-small cs-warn-text">{failed} {failed === 1 ? "cliente ficou" : "clientes ficaram"} sem sugestão (erro do provedor de IA); a MAVI tenta de novo.</p>}
      {rows.length ? (
        <>
          <p className="cs-small">
            <b>{rows.length}</b> {rows.length === 1 ? "cliente sugerido" : "clientes sugeridos"}
            {divergent > 0 && <> · <b className="cs-warn-text">{divergent}</b> com critério diferente do lançado</>}
          </p>
          <div className="cs-table-wrap">
            <table className="cs-table">
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th className="r">Lançado</th>
                  <th className="r">Sugerido</th>
                  {HS_CRITERIA.map((c) => <th key={c.key} className="c" title={c.label}>{c.label.split(" ")[0]}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 40).map(({ x, diffs, c }) => (
                  <tr key={x.cs_client_id} className="cs-row-link" tabIndex={0} onClick={() => profile(x.cs_client_id)}
                    onKeyDown={(ev) => ev.key === "Enter" && profile(x.cs_client_id)}>
                    <td><b>{c.name}</b> <span className="cs-muted">#{c.external_id}</span></td>
                    <td className="r">{x.registered ? <span className={`cs-pill ${csPill(x.registered.band)}`}>{numberFormat(x.registered.score, 0)}%</span> : <span className="cs-muted">—</span>}</td>
                    <td className="r"><span className={`cs-pill ${csPill(x.band)}`}>{numberFormat(x.score ?? 0, 0)}%</span></td>
                    {HS_CRITERIA.map((k) => {
                      const v = x.criteria[k.key]?.value;
                      return (
                        <td key={k.key} className={`c cs-hs-mark ${markClass(v)} ${diffs.includes(k.key) ? "diff" : ""}`}
                          title={`${k.label}: ${x.criteria[k.key]?.why ?? ""}${x.registered ? ` · lançado: ${x.registered[k.key] ? "sim" : "não"}` : ""}`}>
                          {MARK(v)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > 40 && <p className="cs-muted cs-small">Mostrando os 40 com mais diferença de {rows.length}.</p>}
          <p className="cs-muted cs-small">✓ sim · ✗ não · ? sem evidência (não soma) · em destaque, o que difere do lançado. Clique para ver o porquê e as evidências.</p>
        </>
      ) : !hs.pending && (
        <p className="cs-muted">
          Ainda sem sugestões neste mês. Elas saem sozinhas do dia 25 ao dia 5 do mês seguinte{requestHs ? ", ou peça agora" : ""}.
        </p>
      )}
    </div>
  );
}

/** No perfil do cliente: cada critério sugerido, o porquê e as evidências. */
export function HsProfileSection({ client }: { client: string }) {
  const { hs } = useCs();
  const it = hs?.items.find((x) => x.cs_client_id === client && x.done_at);
  if (!hs || !it) return null;
  const diffs = hsDiffs(it);
  return (
    <div className="cs-hs-profile">
      <h4 className="cs-label"><Sparkles size={13} /> Sugestão da MAVI para {labelMesFull(hs.month)}: {numberFormat(it.score ?? 0, 0)}% ({it.band})
        {it.registered && <span className="cs-muted"> · lançado {numberFormat(it.registered.score, 0)}%</span>}
      </h4>
      <ul className="cs-hs-list">
        {HS_CRITERIA.map((c) => {
          const s = it.criteria[c.key as HsKey] as HsCriterion | undefined;
          return (
            <li key={c.key} className={diffs.includes(c.key) ? "diff" : ""}>
              <span className={`cs-hs-mark ${markClass(s?.value)}`}>{MARK(s?.value)}</span>
              <div>
                <b>{c.label}</b>
                {s && <small className="cs-muted"> · confiança {s.confidence}</small>}
                {it.registered && <small className="cs-muted"> · lançado: {it.registered[c.key] ? "sim" : "não"}</small>}
                <p>{s?.why || "Sem sugestão."}</p>
                {!!s?.evidence.length && (
                  <span className="cs-hs-evidence">
                    {s.evidence.map((ev, i) => {
                      const href = evidenceLink(ev);
                      const label = `${ev.title}${ev.date ? ` (${ev.date.slice(8, 10)}/${ev.date.slice(5, 7)})` : ""}`;
                      return href
                        ? <a key={i} href={href} target="_blank" rel="noreferrer">{label}</a>
                        : <span key={i}>{label}</span>;
                    })}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <small className="cs-muted">Sugestão para conferir: o Health Score que vale é o lançado.</small>
    </div>
  );
}

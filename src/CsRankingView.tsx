import { useMemo } from "react";
import { addMonths, labelMes, monthStart, numberFormat } from "./cs-engine";
import { rankingSquadsData, RANKING_CRITERIA } from "./cs-blocks";
import { useCs } from "./CsCommon";

/**
 * 🏆 Ranking dos Squads (ranking.php do dash antigo): score de 0 a 100 por
 * taxas relativas — quem lidera um critério leva o peso cheio, os demais
 * proporcional; critério sem dados sai da conta (score renormalizado).
 */

const MEDALHA: Record<number, string> = { 1: "🥇", 2: "🥈", 3: "🥉" };

export function CsRankingView({ mes }: { mes: string }) {
  const { e, color } = useCs();
  const rk = useMemo(() => rankingSquadsData(e, mes), [e, mes]);
  const hall = useMemo(() => Array.from({ length: 6 }, (_, i) => {
    const m = addMonths(mes, i - 5);
    const r = m === mes ? rk : rankingSquadsData(e, m);
    const v = r.squads[0];
    const ok = v && v.score > 0;
    return { mes: m, label: labelMes(m), squad_id: ok ? v.squad_id : null, nome: ok ? v.nome : "—", score: ok ? v.score : null };
  }).reverse(), [e, mes, rk]);
  const corrente = monthStart(e.today) === mes;

  return (
    <div className="cs-rank">
      {corrente && <div className="cs-banner warn">📅 Mês em andamento — o placar muda até o fechamento. Que vença o melhor!</div>}
      <div className="cs-rank-podium">
        {rk.squads.map((sq) => (
          <div key={sq.squad_id} className={`cs-card cs-rank-card ${sq.pos === 1 ? "first" : ""}`}>
            <span className="medal">{MEDALHA[sq.pos] ?? `${sq.pos}º`}</span>
            <div className="score" style={{ color: color(sq.squad_id) }}>{numberFormat(sq.score, 1)}<small>/100</small></div>
            <div className="name" style={{ color: color(sq.squad_id) }}>{sq.nome}</div>
            <span className="cs-bar"><i style={{ width: `${Math.min(100, sq.score).toFixed(1)}%`, background: color(sq.squad_id) }} /></span>
          </div>
        ))}
        {!rk.squads.length && <p className="cs-muted">Nenhum squad com operação neste mês.</p>}
      </div>

      <div className="cs-card">
        <div className="cs-label">Placar por critério — quem lidera leva o peso cheio, os demais proporcional</div>
        <div className="cs-table-wrap">
          <table className="cs-table">
            <thead>
              <tr><th>Critério (peso)</th>{rk.squads.map((sq) => <th key={sq.squad_id} className="r" style={{ color: color(sq.squad_id) }}>{sq.nome}</th>)}</tr>
            </thead>
            <tbody>
              {RANKING_CRITERIA.map((c) => {
                const cr = rk.criterios[c.key];
                return (
                  <tr key={c.key}>
                    <td><b>{cr.label}</b> <span className="cs-muted">({cr.peso})</span><small className="cs-muted cs-block">{cr.hint}</small></td>
                    {rk.squads.map((sq) => {
                      const cat = sq.cats[c.key];
                      return (
                        <td key={sq.squad_id} className="r">
                          {cat.valor === null ? (
                            <span className="cs-muted" title="Sem dados — critério fora da conta deste squad (score renormalizado)">n/a</span>
                          ) : cat.pontos === null ? (
                            <>{numberFormat(cat.valor, 1)}%<small className="cs-muted cs-block" title="Ninguém pontuou neste critério no mês — ele sai da conta de todos">fora da conta no mês</small></>
                          ) : (
                            <>{cat.lider ? "🏅 " : ""}{numberFormat(cat.valor, 1)}%<small className="cs-muted cs-block">{numberFormat(cat.pontos, 1)} pts</small></>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="cs-grid-2">
        <div className="cs-card">
          <div className="cs-label">🏛 Hall da fama — vencedores por mês</div>
          <table className="cs-table">
            <tbody>
              {hall.map((h) => (
                <tr key={h.mes}>
                  <td>{h.label}</td>
                  <td style={{ color: color(h.squad_id) }}><b>{h.nome}</b>{h.mes === mes && corrente && <span className="cs-muted"> (parcial)</span>}</td>
                  <td className="r">{h.score !== null ? numberFormat(h.score, 1) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="cs-card">
          <div className="cs-label">📜 Regras do jogo</div>
          <ul className="cs-list">
            <li>Só <b>taxas relativas</b> — nada de valores absolutos. Squad pequeno compete de igual para igual.</li>
            <li>Cada critério: o líder leva o <b>peso cheio</b>; os demais, proporcional ao líder.</li>
            <li>Critério sem dados (ex.: squad novo sem cohort de graduação) <b>sai da conta</b> — o score é renormalizado, ninguém é punido por ser novo.</li>
            <li>Score final: <b>0 a 100</b>. Vence o mês quem fechar na frente.</li>
            <li>Pesos: {RANKING_CRITERIA.map((c) => `${rk.criterios[c.key].label} ${rk.criterios[c.key].peso}`).join(" · ")}.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

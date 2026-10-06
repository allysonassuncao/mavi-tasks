import { useMemo } from "react";
import { fmtDateBr, fmtMoney, labelMes, numberFormat, sprintfFixed } from "./cs-engine";
import { recPlanejamento } from "./cs-receiving";
import { useCs } from "./CsCommon";

/**
 * 📅 Planejamento de Recebimento (recebimento.php do dash antigo): quando o
 * dinheiro do mês entra, pela DATA DE COBRANÇA. O que já entrou → o que
 * venceu e não entrou → o que ainda vem → como ajustar o próximo mês.
 */

const ZONA_COR = { verde: "#2f8a5b", amarela: "#c28a1e", vermelha: "#c8514f" } as const;
const TINT = {
  verde: (i: number) => `rgba(47,138,91,${(0.06 + 0.2 * i).toFixed(3)})`,
  amarela: (i: number) => `rgba(194,138,30,${(0.06 + 0.24 * i).toFixed(3)})`,
  vermelha: (i: number) => `rgba(200,81,79,${(0.06 + 0.26 * i).toFixed(3)})`,
};
function k(v: number) {
  if (Math.abs(v) >= 1000) return `R$ ${numberFormat(v / 1000, Math.abs(v) >= 100000 ? 0 : 1)}k`;
  return fmtMoney(v);
}
const s = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function CsReceivingView({ mes, squad }: { mes: string; squad: string | null }) {
  const { e, color } = useCs();
  const r = useMemo(() => recPlanejamento(e, { mes_ref: mes, squad_id: squad }), [e, mes, squad]);
  const esp = r.total_esperado;
  const pc = (v: number) => (esp > 0 ? (v / esp) * 100 : 0);
  const RED = r.regras.zona_vermelha_dia, YELLOW = r.regras.zona_amarela_dia;
  const zona = (d: number) => (d >= RED ? "vermelha" : d >= YELLOW ? "amarela" : "verde") as keyof typeof ZONA_COR;
  const pRec = pc(r.total_recebido), pVen = pc(r.total_vencido), pAv = pc(r.total_a_vencer);
  const maxDia = Math.max(0, ...r.por_dia.map((d) => d.esperado));
  const dowIni = r.por_dia[0]?.dow ?? 0;
  const tabela = [...r.linhas].sort((a, b) => (a.dia_ref ?? 99) - (b.dia_ref ?? 99) || b.esperado - a.esperado);
  const SIT = { vencido: ["🔴 vencido", "bad"], a_vencer: ["📅 a vencer", "orange"], perda: ["⚫ perda", ""], resolvido: ["✅ pago", "good"] };

  return (
    <div className="cs-rec">
      <p className="cs-muted cs-help">
        Organizado pela <b>data de cobrança</b> — quando o dinheiro é esperado. O <b>fim do ciclo</b> é a causa (quando a verba acaba e o
        cliente precisa reinvestir): é ele que se ajusta para mover a cobrança. Valores <b>efetivos</b> (regra M1: os primeiros R$ 3.000
        do 1º mês de trial são comissão comercial) — batem com o Faturamento do Bloco 1.
        {r.eh_corrente && <> Hoje é dia <b>{r.hoje_dia}</b> de {r.dias_mes}.</>}
      </p>

      {r.alertas.map((a, i) => (
        <div key={i} className={`cs-rec-alert ${a.severidade}`}>
          {a.severidade === "alta" ? "🔴" : "🟡"} <span dangerouslySetInnerHTML={{ __html: a.mensagem }} />
        </div>
      ))}

      <div className="cs-rec-kpis">
        <div className="cs-card good">
          <span className="cs-label">✅ Já entrou</span>
          <div className="cs-big cs-good-text">{fmtMoney(r.total_recebido)}</div>
          <small className="cs-muted">
            {r.n_recebidos} {s(r.n_recebidos, "cliente pagou", "clientes pagaram")} · {numberFormat(pRec, 0)}% do esperado
            {r.total_comissao_m1 > 0.01 && <><br />{fmtMoney(r.total_recebido_bruto)} caiu na conta · −{fmtMoney(r.total_comissao_m1)} comissão M1 ({r.n_m1} {s(r.n_m1, "cliente", "clientes")})</>}
          </small>
        </div>
        <div className={`cs-card ${r.total_vencido > 0.01 ? "bad" : ""}`}>
          <span className="cs-label">🔴 Venceu e não entrou</span>
          <div className={`cs-big ${r.total_vencido > 0.01 ? "cs-bad-text" : "cs-muted"}`}>{fmtMoney(r.total_vencido)}</div>
          <small className="cs-muted">{r.n_vencido} {s(r.n_vencido, "cobrança", "cobranças")} com data já passada</small>
        </div>
        <div className="cs-card orange">
          <span className="cs-label">📅 Ainda vai vencer</span>
          <div className="cs-big cs-orange-text">{fmtMoney(r.total_a_vencer)}</div>
          <small className="cs-muted">{r.n_a_vencer} {s(r.n_a_vencer, "cobrança", "cobranças")} até o fim do mês</small>
        </div>
        <div className="cs-card">
          <span className="cs-label">Esperado no mês</span>
          <div className="cs-big">{fmtMoney(esp)}</div>
          <small className="cs-muted">= já entrou + o que falta · {r.n_ciclos} ciclos{r.total_perda > 0 ? ` · ${fmtMoney(r.total_perda)} em PERDA (fora da conta)` : ""}</small>
        </div>
      </div>

      {esp > 0 && (
        <div className="cs-card">
          <div className="cs-row-between">
            <h4>Como o mês está andando</h4>
            <b className={r.progresso.delta_pp <= -15 ? "cs-bad-text" : r.progresso.delta_pp <= -5 ? "cs-warn-text" : "cs-good-text"}>
              {r.hoje_dia > 0 ? `${numberFormat(r.progresso.mes_decorrido_pct, 0)}% do mês passou · ${numberFormat(pRec, 0)}% do dinheiro entrou` : "o mês ainda não começou"}
            </b>
          </div>
          <div className="cs-rec-track">
            {pRec > 0 && <i className="good" style={{ width: `${pRec.toFixed(2)}%` }}>{pRec >= 8 ? `${numberFormat(pRec, 0)}%` : ""}</i>}
            {pVen > 0 && <i className="bad" style={{ width: `${pVen.toFixed(2)}%` }}>{pVen >= 8 ? `${numberFormat(pVen, 0)}%` : ""}</i>}
            {pAv > 0 && <i className="orange" style={{ width: `${pAv.toFixed(2)}%` }}>{pAv >= 8 ? `${numberFormat(pAv, 0)}%` : ""}</i>}
            {r.hoje_dia > 0 && r.eh_corrente && (
              <span className="cs-rec-today" style={{ left: `${Math.min(100, r.progresso.mes_decorrido_pct).toFixed(2)}%` }}><span>hoje</span></span>
            )}
          </div>
          <div className="cs-legend-row">
            <span><i className="sw good" />Já entrou {fmtMoney(r.total_recebido)}</span>
            <span><i className="sw bad" />Venceu e não entrou {fmtMoney(r.total_vencido)}</span>
            <span><i className="sw orange" />Ainda vai vencer {fmtMoney(r.total_a_vencer)}</span>
            {r.eh_corrente && <span>│ marcador = quanto do mês já passou</span>}
          </div>
        </div>
      )}

      {r.vencidos.length > 0 && (
        <div className="cs-card bad">
          <div className="cs-row-between"><h4>🔴 Cobrar hoje — venceu e não entrou</h4><b className="cs-bad-text">{fmtMoney(r.total_vencido)}</b></div>
          <p className="cs-muted cs-small">A data de cobrança já passou e o dinheiro não entrou. É o que dá para destravar agora.</p>
          <div className="cs-table-wrap">
            <table className="cs-table">
              <thead><tr><th>Cliente</th><th>Squad</th><th>Cobrança</th><th className="r">Atraso</th><th className="r">Falta entrar</th><th>Já pagou</th></tr></thead>
              <tbody>
                {r.vencidos.map((l) => (
                  <tr key={l.cycle.id}>
                    <td><b>{l.nome}</b> <span className="cs-muted">#{l.id_externo}</span>{l.hs_faixa === "CRITICO" && <span className="cs-pill bad">HS crítico</span>}</td>
                    <td style={{ color: color(l.squad_id) }}>{l.squad_nome}</td>
                    <td>{fmtDateBr(l.data_cobranca)}</td>
                    <td className="r cs-bad-text"><b>{l.dias_atraso}d</b></td>
                    <td className="r"><b>{fmtMoney(l.a_receber)}</b></td>
                    <td className="cs-muted">{l.pago > 0 ? `${fmtMoney(l.pago)}${l.parcelas.length ? ` (${l.parcelas.length}×)` : ""}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="cs-card">
        <div className="cs-row-between"><h4>📅 Ainda vai vencer — agenda até o fim do mês</h4><b className="cs-orange-text">{fmtMoney(r.total_a_vencer)}</b></div>
        <p className="cs-muted cs-small">Por data de cobrança. Dias {RED}+ em vermelho (fora da regra do CEO), {YELLOW}–{RED - 1} em amarelo (limite).</p>
        {r.agenda.length ? r.agenda.map((d) => {
          const cor = ZONA_COR[d.zona as keyof typeof ZONA_COR];
          return (
            <div key={d.dia} className="cs-rec-day">
              <span className="d" style={{ color: cor, borderColor: `${cor}55` }}>dia {d.dia}</span>
              <span className="cli">{d.clientes.map((c, i) => <span key={i}>{i > 0 && " · "}{c.nome} <span className="cs-muted">{k(c.valor)}</span></span>)}</span>
              <b style={{ color: cor }}>{fmtMoney(d.valor)}</b>
            </div>
          );
        }) : <p className="cs-muted">Nada mais a vencer neste mês.</p>}
      </div>

      <div className="cs-card">
        <div className="cs-row-between">
          <h4>📆 Calendário do mês</h4>
          {r.maior_dia && <small className="cs-muted">pico no dia {r.maior_dia.dia} ({numberFormat(r.maior_dia.pct, 0)}% do mês)</small>}
        </div>
        <p className="cs-muted cs-small">
          Cada dia mostra o que é <b>cobrado</b> ali. A barrinha divide <span className="cs-good-text">o que já entrou</span> do{" "}
          <span className="cs-orange-text">que falta</span>. Fundo por zona: verde até {YELLOW - 1} · amarelo {YELLOW}–{RED - 1} · vermelho {RED}+.
          Borda vermelha = venceu e não entrou · hachura = fim de semana.
        </p>
        <div className="cs-cal">
          {["dom", "seg", "ter", "qua", "qui", "sex", "sáb"].map((h) => <span key={h} className="hd">{h}</span>)}
          {Array.from({ length: dowIni }, (_, i) => <span key={`x${i}`} />)}
          {r.por_dia.map((c) => {
            const z = zona(c.dia);
            const tem = c.esperado > 0.01;
            const atrasado = c.a_receber > 0.01 && r.hoje_dia > 0 && c.dia < r.hoje_dia;
            const recPct = c.esperado > 0 ? (c.recebido_cobranca / c.esperado) * 100 : 0;
            const corFalta = atrasado ? ZONA_COR.vermelha : ZONA_COR[z];
            return (
              <div key={c.dia} title={tem ? `Dia ${c.dia}: ${c.clientes.join(" · ")}` : `Dia ${c.dia} — sem cobrança`}
                className={`cs-cel ${tem ? "" : "vazio"} ${c.fds ? "fds" : ""} ${r.eh_corrente && c.dia === r.hoje_dia ? "hoje" : ""} ${atrasado ? "atrasado" : ""}`}
                style={tem ? { backgroundColor: TINT[z](maxDia > 0 ? c.esperado / maxDia : 0) } : undefined}>
                <span className="n">{c.dia}{atrasado ? " ⚠" : ""}</span>
                {tem && (
                  <>
                    <b style={{ color: c.a_receber > 0.01 ? corFalta : ZONA_COR.verde }}>{k(c.esperado)}</b>
                    <small>{c.n} cobr.{c.a_receber > 0.01 ? ` · falta ${k(c.a_receber)}` : " · ok"}</small>
                    <span className="mini">
                      <i style={{ width: `${Math.min(100, recPct).toFixed(1)}%`, background: ZONA_COR.verde }} />
                      <i style={{ width: `${Math.max(0, 100 - recPct).toFixed(1)}%`, background: corFalta }} />
                    </span>
                  </>
                )}
              </div>
            );
          })}
        </div>
        {r.fim_de_semana.dias.length > 0 && r.fim_de_semana.esperado > 0 && (
          <p className="cs-muted cs-small">
            🗓 <b>{fmtMoney(r.fim_de_semana.esperado)}</b> em {r.fim_de_semana.n} {s(r.fim_de_semana.n, "cobrança", "cobranças")} cai em sábado/domingo
            (dias {r.fim_de_semana.dias.join(", ")}) — na prática esse dinheiro só entra na segunda.
          </p>
        )}
      </div>

      <div className="cs-card">
        <div className="cs-row-between"><h4>Distribuição por semana</h4><small className="cs-muted">Cada semana deveria ficar perto de 25% do mês</small></div>
        <p className="cs-muted cs-small">
          Quanto do dinheiro do mês é cobrado em cada semana — e quanto disso já entrou. A barra usa escala fixa (cheia = metade do mês),
          então o <b>traço é sempre o ideal</b>: passar dele quer dizer semana sobrecarregada.
        </p>
        <div className="cs-rec-weeks">
          {r.por_semana.map((w) => {
            const falta = Math.max(0, w.esperado - w.recebido);
            const bRec = esp > 0 ? Math.min(100, (w.recebido / esp) * 200) : 0;
            const bFal = esp > 0 ? Math.min(100 - bRec, (falta / esp) * 200) : 0;
            const acima = w.pct > w.pct_ideal * 1.35;
            return (
              <div key={w.semana} className={`cs-rec-week ${acima ? "over" : ""}`}>
                <div className="cs-row-between"><b>Semana {w.semana}</b><small className="cs-muted">dias {w.label}</small></div>
                <div className={`cs-mid ${acima ? "cs-warn-text" : ""}`}>{numberFormat(w.pct, 0)}%<small className="cs-muted"> do mês</small></div>
                <span className="cs-rec-wbar" title={`${numberFormat(w.pct, 1)}% do mês · ideal ${numberFormat(w.pct_ideal, 1)}%`}>
                  <i className="good" style={{ width: `${bRec.toFixed(2)}%` }} />
                  <i className="orange" style={{ width: `${bFal.toFixed(2)}%` }} />
                  <span className="ideal" style={{ left: `${Math.min(100, w.pct_ideal * 2).toFixed(2)}%` }} />
                </span>
                <small className="cs-muted">ideal ~{numberFormat(w.pct_ideal, 0)}%{acima && <span className="cs-warn-text"> · acima do ideal</span>}</small>
                <table className="cs-rec-wvals">
                  <tbody>
                    <tr className="tot"><td>Esperado</td><td>{fmtMoney(w.esperado)}</td></tr>
                    <tr className="cs-good-text"><td>✅ Já entrou</td><td>{fmtMoney(w.recebido)}</td></tr>
                    <tr className="cs-orange-text"><td>🟠 Falta entrar</td><td>{fmtMoney(falta)}</td></tr>
                  </tbody>
                </table>
                <small className="cs-muted">{w.n} {s(w.n, "cobrança", "cobranças")}{w.semana === r.semana_mais_leve && <span className="cs-info-text"> · semana mais leve</span>}</small>
              </div>
            );
          })}
        </div>
      </div>

      <div className="cs-grid-2">
        <div className="cs-card">
          <div className="cs-row-between">
            <h4>💡 Antecipar no próximo planejamento</h4>
            {r.impacto_sugestoes > 0 && <span className="cs-pill good">{fmtMoney(r.impacto_sugestoes)} sairiam do fim do mês</span>}
          </div>
          <p className="cs-muted cs-small">Cobranças do dia {RED}+ em clientes que aguentam a conversa. Máximo {r.regras.passo_max_dias} dias por mês, piso dia {r.regras.dia_alvo}.</p>
          {r.sugestoes.length ? r.sugestoes.map((x) => {
            const sg = x.sugestao!;
            return (
              <div key={x.cycle.id} className={`cs-rec-sug ${sg.classe}`}>
                <div className="cs-row-between top">
                  <div>
                    <b>{x.nome}</b> <span className="cs-muted">#{x.id_externo} · <span style={{ color: color(x.squad_id) }}>{x.squad_nome}</span></span>
                    <div>{sg.texto}{sg.proximo_passo && <span className="cs-muted"> · {sg.proximo_passo}</span>}</div>
                    <small className="cs-muted">Fim do ciclo hoje: {x.data_fim_ciclo ? fmtDateBr(x.data_fim_ciclo) : "— não informado"} (é essa data que precisa mudar)</small>
                  </div>
                  <div className="cs-right">
                    <span className={`cs-pill ${sg.classe === "forte" ? "good" : sg.classe === "possivel" ? "warn" : ""}`}>
                      {sg.classe === "forte" ? "forte" : sg.classe === "possivel" ? "possível" : "cautela"}
                    </span>
                    {x.hs !== null && <small className="cs-muted cs-block">HS {numberFormat(x.hs, 0)}%</small>}
                  </div>
                </div>
                <ul>{sg.motivos.map((m, i) => <li key={i}>{m}</li>)}</ul>
              </div>
            );
          }) : <p className="cs-muted">Nenhuma cobrança elegível no fim do mês — ou está tudo distribuído, ou os clientes do fim do mês estão fora de alcance (ao lado).</p>}
        </div>
        <div>
          <div className="cs-card">
            <h4>🚫 Não mexer</h4>
            <p className="cs-muted cs-small">Cobram no fim do mês, mas com HS crítico ou inadimplência — primeiro recupera, depois renegocia a data.</p>
            {r.fora_alcance.length ? r.fora_alcance.map((x) => (
              <div key={x.cycle.id} className="cs-rec-line">
                <b>{x.nome}</b> <span className="cs-muted">dia {x.dia_ref} · {fmtMoney(x.esperado)}</span>
                <small className="cs-muted cs-block">{x.bloqueio}</small>
              </div>
            )) : <p className="cs-muted">Nenhum.</p>}
          </div>
          {r.replanejados.length > 0 && (
            <div className="cs-card">
              <h4>🔁 Datas que mudaram no mês</h4>
              <p className="cs-muted cs-small">Cobrança replanejada depois do lançamento inicial.</p>
              <table className="cs-table">
                <tbody>
                  {r.replanejados.map((x) => (
                    <tr key={x.cycle.id}>
                      <td>{x.nome} <span className="cs-muted">{k(x.esperado)}</span></td>
                      <td className="cs-muted">{fmtDateBr(x.replan!.primeira_data)} → {fmtDateBr(x.replan!.data_atual)}</td>
                      <td className={`r ${Math.abs(x.replan!.dias_deslize) >= 7 ? "cs-bad-text" : ""}`}>
                        {x.replan!.dias_deslize >= 0 ? "+" : ""}{sprintfFixed(x.replan!.dias_deslize, 0)}d
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(r.sem_data_no_mes.length > 0 || r.n_sem_fim > 0) && (
            <div className="cs-card warn">
              <h4>⚠️ Furos na planilha</h4>
              {r.sem_data_no_mes.length > 0 && (
                <>
                  <p className="cs-muted cs-small"><b>{r.sem_data_no_mes.length} ciclo(s) sem data de cobrança dentro de {labelMes(mes)}</b> — ficam fora do calendário acima:</p>
                  <p className="cs-small">
                    {r.sem_data_no_mes.map((x) => (
                      <span key={x.cycle.id} className="cs-block">{x.nome} <span className="cs-muted">{k(x.esperado)}{x.data_cobranca ? ` · cobrança ${fmtDateBr(x.data_cobranca)} (outro mês)` : " · sem cobrança"}</span></span>
                    ))}
                  </p>
                </>
              )}
              {r.n_sem_fim > 0 && (
                <p className="cs-muted cs-small"><b>{r.n_sem_fim} ciclo(s) sem FimCiclo</b> — sem essa data não dá para planejar a renovação: {r.sem_fim.slice(0, 10).join(", ")}{r.sem_fim.length > 10 ? "…" : ""}</p>
              )}
            </div>
          )}
        </div>
      </div>

      <details className="cs-card cs-details">
        <summary>Ver todos os {r.n_ciclos} ciclos do mês (detalhe completo)</summary>
        <div className="cs-table-wrap">
          <table className="cs-table">
            <thead><tr><th>Cliente</th><th>Squad</th><th>HS</th><th>Ciclo (consumo da verba)</th><th>Cobrança</th><th className="r">Esperado</th><th className="r">Entrou</th><th className="r">Falta</th><th>Quando entrou</th><th>Situação</th></tr></thead>
            <tbody>
              {tabela.map((l) => {
                const [sit, cls] = SIT[l.situacao];
                return (
                  <tr key={l.cycle.id}>
                    <td>{l.nome} <span className="cs-muted">#{l.id_externo}</span>{l.eh_m1 && <span className="cs-pill" title="1º mês de trial — os primeiros R$ 3.000 são comissão comercial">M1</span>}</td>
                    <td style={{ color: color(l.squad_id) }}>{l.squad_nome}</td>
                    <td>{l.hs !== null ? <span className={`cs-pill ${l.hs_faixa === "SATISFEITO" ? "good" : l.hs_faixa === "ALERTA" ? "warn" : "bad"}`}>{numberFormat(l.hs, 0)}%</span> : <span className="cs-muted">—</span>}</td>
                    <td className="cs-muted cs-small">{l.data_inicio_ciclo ? fmtDateBr(l.data_inicio_ciclo) : "—"} → {l.data_fim_ciclo ? fmtDateBr(l.data_fim_ciclo) : <span className="cs-warn-text">sem fim</span>}</td>
                    <td>
                      {l.data_cobranca ? <span style={l.zona ? { color: ZONA_COR[l.zona] } : undefined}>{fmtDateBr(l.data_cobranca)}</span> : <span className="cs-muted">—</span>}
                      {l.dia_ref === null && <span className="cs-pill warn">fora do mês</span>}
                    </td>
                    <td className="r">{fmtMoney(l.esperado)}</td>
                    <td className={`r ${l.pago > 0 ? "cs-good-text" : ""}`}>
                      {l.pago_bruto > 0 ? fmtMoney(l.pago) : "—"}
                      {l.comissao_m1 > 0.01 && <small className="cs-muted cs-block">bruto {fmtMoney(l.pago_bruto)} · M1 −{fmtMoney(l.comissao_m1)}</small>}
                    </td>
                    <td className={`r ${l.a_receber > 0 ? "cs-orange-text" : ""}`}>{l.a_receber > 0 ? <b>{fmtMoney(l.a_receber)}</b> : "—"}</td>
                    <td className="cs-muted cs-small">
                      {l.parcelas.length ? l.parcelas.map((x) => <span key={x.ordem} className="cs-block">{fmtDateBr(x.data)} {k(x.valor)}</span>)
                        : l.data_pagamento ? fmtDateBr(l.data_pagamento) : "—"}
                    </td>
                    <td className={`cs-${cls}-text cs-small`}>{sit}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

import { useMemo, type CSSProperties, type ReactNode } from "react";
import { PanelChart } from "./DashboardCharts";
import type { Display, PanelSpec, Unit } from "./dashboards";
import {
  addDays,
  addMonths,
  fmtDateBr,
  fmtMoney,
  labelMes,
  labelMesFull,
  numberFormat,
  ym,
  type CsFilter,
} from "./cs-engine";
import type { CsPeriod } from "./cs-dashboard";
import type { DdParams } from "./cs-drilldowns";
import {
  churnDataAnual,
  churnDataMensal,
  evolucaoMensalData,
  financeiroData,
  gerarInsights,
  kpiStripData,
  kpiStripPeriodoData,
  melhorSquadPorMesData,
  previsibilidadeData,
  provavelRecebidoData,
  saudeData,
  squadsData,
  tendenciaHsData,
  trialDataAnual,
  trialDataMensal,
} from "./cs-blocks";
import { Dd, Info, csPill, useCs, useProfileRow } from "./CsCommon";
import { HsSuggestionsCard } from "./CsHsSuggestions";

/**
 * Os blocos 1 a 8 do painel de CS (home.php do dash antigo), com os mesmos
 * números, textos de "como calculamos" e botões de detalhe.
 */

const C = { orange: "#e0782a", good: "#2f8a5b", warn: "#c28a1e", bad: "#c8514f", info: "#3f79c4", muted: "#84908f" };
const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? "—" : `${numberFormat(v, d)}%`);
function moneyShort(v: number) {
  const a = Math.abs(v);
  if (a >= 1e6) return `R$ ${numberFormat(v / 1e6, 1)}M`;
  if (a >= 1e3) return `R$ ${numberFormat(v / 1e3, 0)}k`;
  return `R$ ${numberFormat(v, 0)}`;
}
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
/** As frases do motor trazem só <strong> (com o texto já escapado). */
const Html = ({ html }: { html: string }) => <span dangerouslySetInnerHTML={{ __html: html }} />;

function Mom({ v }: { v: number | null }) {
  if (v === null) return <span className="cs-muted">—</span>;
  if (v > 0.5) return <span className="cs-up">▲ {numberFormat(v, 1)}%</span>;
  if (v < -0.5) return <span className="cs-down">▼ {numberFormat(Math.abs(v), 1)}%</span>;
  return <span className="cs-flat">→ {numberFormat(v, 1)}%</span>;
}
function Delta({ a, b, better = true, suffix = "" }: { a: number; b: number; better?: boolean; suffix?: string }) {
  if (b === 0) return <span className="cs-muted">—</span>;
  const d = ((a - b) / Math.abs(b)) * 100;
  const good = better ? d > 0 : d < 0;
  return (
    <span className={Math.abs(d) < 1 ? "cs-flat" : good ? "cs-up" : "cs-down"}>
      {d > 0 ? "+" : ""}{numberFormat(d, 1)}%{suffix}
    </span>
  );
}
const tone = (p: number) => (p >= 100 ? "good" : p >= 80 ? "warn" : "bad");
function Achieved({ v }: { v: number }) {
  return <span className={`cs-pill ${tone(v)}`}>{numberFormat(v, 1)}% atingido</span>;
}
function Bar({ value, cls }: { value: number; cls?: string }) {
  return <span className="cs-bar"><i className={cls} style={{ width: `${Math.min(100, Math.max(0, value)).toFixed(2)}%` }} /></span>;
}

function Section({ id, layer, title, sub, dot, meta, children, tinted }: {
  id: string; layer: string; title: string; sub: string; dot: string; meta?: ReactNode; children: ReactNode; tinted?: boolean;
}) {
  return (
    <section className={`cs-section ${tinted ? "tinted" : ""}`} id={id}>
      <header className="cs-section-head">
        <div>
          <span className="cs-layer">{layer}</span>
          <h3><i className="cs-dot" style={{ background: dot }} />{title}</h3>
          <p>{sub}</p>
        </div>
        {meta && <span className="cs-section-meta">{meta}</span>}
      </header>
      {children}
    </section>
  );
}
function Kpi({ label, value, sub, highlight, valueClass }: {
  label: ReactNode; value: ReactNode; sub?: ReactNode; highlight?: boolean; valueClass?: string;
}) {
  return (
    <div className={`cs-kpi ${highlight ? "highlight" : ""}`}>
      <div className="cs-label">{label}</div>
      <div className={`cs-kpi-value ${valueClass ?? ""}`}>{value}</div>
      {sub && <div className="cs-kpi-sub">{sub}</div>}
    </div>
  );
}
function Card({ children, className = "", style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return <div className={`cs-card ${className}`} style={style}>{children}</div>;
}

type Series = { name: string; color: string; values: (number | null)[] };
function Chart({ kind, labels, series, unit, height = 220 }: {
  kind: "line" | "bar" | "donut"; labels: string[]; series: Series[]; unit: Unit; height?: number;
}) {
  const display: Display = {
    keys: labels.map((_, i) => String(i)), labels, unit, interval: "month",
    series: series.map((s, i) => ({ id: String(i), name: s.name, color: s.color, unit, values: s.values })),
  };
  const spec: PanelSpec = { viz: kind, groupBy: kind === "line" ? "time" : "client", queries: [] };
  return <div className="cs-chart" style={{ height }}><PanelChart display={display} spec={spec} /></div>;
}
const PALETTE = ["#e0782a", "#3f79c4", "#2f8a5b", "#c28a1e", "#7b62c4", "#c8514f", "#1baf7a", "#e87ba4", "#4a3aa7", "#008300",
  "#eda100", "#2a78d6"];

export function CsPanelBlocks({ f, p, semana, onSemana, onReceiving, onYear }: {
  f: CsFilter; p: CsPeriod; semana: string | null; onSemana: (d: string | null) => void; onReceiving: () => void;
  onYear: () => void;
}) {
  const { e, color } = useCs();
  const profileRow = useProfileRow();
  const pm = p.is_single ? null : p.meses;
  const d = useMemo(() => {
    const mensal = f.modo === "mensal";
    return {
      k: kpiStripData(e, f),
      kp: p.is_single ? null : kpiStripPeriodoData(e, f, p.meses),
      cmp: p.compare ? {
        a: kpiStripPeriodoData(e, { ...f, mes_ref: p.compare.a.fim }, p.compare.a.meses),
        b: kpiStripPeriodoData(e, { ...f, mes_ref: p.compare.b.fim }, p.compare.b.meses),
      } : null,
      fin: financeiroData(e, f, pm),
      pr: provavelRecebidoData(e, f, pm),
      ev: p.is_single ? null : evolucaoMensalData(e, f, p.meses),
      sd: saudeData(e, f, pm),
      th: p.is_single ? null : tendenciaHsData(e, f, p.meses),
      tr: mensal ? trialDataMensal(e, f) : trialDataAnual(e, f, pm),
      ch: mensal ? churnDataMensal(e, f) : churnDataAnual(e, f, pm),
      sq7: squadsData(e, f, pm),
      msm: p.is_single ? [] : melhorSquadPorMesData(e, f, p.meses),
      ins: gerarInsights(e, f),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e, f.mes_ref, f.squad_id, f.dim, f.modo, p.label]);
  const pv = useMemo(() => (p.is_single ? previsibilidadeData(e, f, semana) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [e, f.mes_ref, f.squad_id, f.dim, p.is_single, semana]);

  // Os parâmetros do detalhe herdam squad, recorte e período (dd_params).
  const ddp = (over: Partial<DdParams> = {}): DdParams => ({
    squad: f.squad_id, dim: f.dim,
    ...(p.is_single ? { mes: ym(f.mes_ref) } : { mes_ini: ym(p.inicio), mes_fim: ym(p.fim) }),
    ...over,
  });
  // Squad arquivado sem nada no recorte não aparece nas listas.
  const shown = (sid: string, has: boolean) => has || !e.squadOf(sid)?.archived;
  const SquadName = ({ id, name }: { id: string; name: string }) => <span style={{ color: color(id) }}>{name}</span>;
  const { k, kp, cmp, fin, pr, ev, sd, th, tr, ch, sq7, msm, ins } = d;

  return (
    <>
      {/* ------------------------------------------------ BLOCO 1 */}
      <Section id="b1" layer="Camada Executiva" title="Bloco 1 — KPI Strip Running" dot={C.orange}
        sub={p.is_single ? "Como a Make está agora — pulso da operação CS" : "Visão acumulada do período · médias e totais"}
        meta={`${p.is_single ? "Mês de referência" : "Período"}: ${p.label}`}>
        {cmp && p.compare ? (
          <div className="cs-compare">
            <div className="cs-compare-row head">
              <span />
              <span className="a">A · {p.compare.a.label}</span>
              <span className="b">B · {p.compare.b.label}</span>
              <span>Δ A vs B</span>
            </div>
            {([
              ["Faturamento total", fmtMoney(cmp.a.fat_total), fmtMoney(cmp.b.fat_total), <Delta a={cmp.a.fat_total} b={cmp.b.fat_total} />],
              ["Faturamento médio/mês", fmtMoney(cmp.a.fat_medio_mes), fmtMoney(cmp.b.fat_medio_mes),
                <Delta a={cmp.a.fat_medio_mes} b={cmp.b.fat_medio_mes} />],
              ["Atingimento de meta", pct(cmp.a.atingimento_pct), pct(cmp.b.atingimento_pct),
                <><Delta a={cmp.a.atingimento_pct} b={cmp.b.atingimento_pct} /> pts</>],
              ["Total Planejado", fmtMoney(cmp.a.planejado_total), fmtMoney(cmp.b.planejado_total),
                <Delta a={cmp.a.planejado_total} b={cmp.b.planejado_total} />],
              ["Ativos ao fim", cmp.a.ativos_fim, cmp.b.ativos_fim, <Delta a={cmp.a.ativos_fim} b={cmp.b.ativos_fim} />],
              ["Pagantes únicos", `${cmp.a.pagantes_unicos} / ${cmp.a.clientes_no_periodo}`,
                `${cmp.b.pagantes_unicos} / ${cmp.b.clientes_no_periodo}`, <Delta a={cmp.a.pagantes_unicos} b={cmp.b.pagantes_unicos} />],
              ["% Faturamento Trial", pct(cmp.a.pct_trial), pct(cmp.b.pct_trial),
                <><Delta a={cmp.a.pct_trial} b={cmp.b.pct_trial} better={false} /> pts</>],
              ["Net churn", `${cmp.a.net_churn > 0 ? "+" : ""}${cmp.a.net_churn}`, `${cmp.b.net_churn > 0 ? "+" : ""}${cmp.b.net_churn}`,
                <Delta a={cmp.a.net_churn} b={cmp.b.net_churn} />],
            ] as [string, ReactNode, ReactNode, ReactNode][]).map(([name, a, b, delta]) => (
              <div key={name} className="cs-compare-row">
                <span className="name">{name}</span>
                <strong>{a}</strong>
                <strong>{b}</strong>
                <span>{delta}</span>
              </div>
            ))}
          </div>
        ) : p.is_single ? (
          <>
            <div className="cs-kpis">
              <Kpi label={<>Faturamento mês <Info text="SUM(valor_pago) dos ciclos do mês com status PAGO/PARCIAL, descontados os primeiros R$ 3.000 de cada cliente em M1 de trial (vão pra comissão comercial). Não usa MRR — receita Make é variável por ciclo individual." /> <Dd m="faturamento" p={ddp()} /></>}
                value={fmtMoney(k.fat_mes)}
                sub={<>
                  vs {labelMes(k.mes_ant)} ({fmtMoney(k.fat_mes_ant)}) · <Mom v={k.fat_mom_pct} />
                  {k.mensalidades.total > 0 && (
                    <span className="cs-info-text">+ {fmtMoney(k.mensalidades.total)} em mensalidades (à parte, fora da meta) <Dd m="mensalidades" p={ddp()} /></span>
                  )}
                </>} />
              <Kpi label={<>Atingimento meta <Info text="Faturamento do mês ÷ meta consolidada (soma das metas de cada squad)." /> <Dd m="meta" p={ddp({ squad: null })} label="gap" /></>}
                value={pct(k.atingimento_pct)} sub={`Meta CS: ${fmtMoney(k.meta)}`} />
              <Kpi label={<>Total Planejado mês <Info text="SUM(valor_planejado_provavel) dos ciclos do mês. KPI substituto para MRR — usa cenário Provável de cada ciclo." /> <Dd m="planejado" p={ddp()} /></>}
                value={fmtMoney(k.planejado)} sub={<>soma de Provável · <span className="cs-muted">{k.ciclos_count} ciclos</span></>} />
              <Kpi label={<>Clientes ativos <Info text="Clientes ATIVOS sem churn até o último dia do mês de referência. Cliente Ativo ≠ Cliente Pagante." /> <Dd m="ativos" p={ddp()} /></>}
                value={k.ativos_total} sub={`${k.ativos_base} Base · ${k.ativos_trial} Trial`} />
              <Kpi label={<>Pagantes <Info text="Numerador: clientes que pagaram algo no mês (M1 de trial conta mesmo se pagou ≤ R$ 3k — o desconto da comissão afeta só o faturamento). Denominador: total de clientes com ciclo no mês — inclui ativos, inativos e churnados." /> <Dd m="pagantes" p={ddp()} /></>}
                value={`${k.pagantes} / ${k.total_no_mes}`}
                sub={(() => {
                  const n = Math.max(0, k.total_no_mes - k.pagantes);
                  return `${n} ainda ${plural(n, "pendente", "pendentes")} em ${labelMes(k.mes_ref)}`;
                })()} />
              <Kpi label={<>% Faturamento Trial <Info text="Faturamento de ciclos em fase de trial ÷ faturamento total (regra M1 aplicada). Usa a fase HISTÓRICA: cliente que graduou tem os meses anteriores à graduação contados como trial, não retroativos pra base. Ciclos ACL ficam na categoria própria." /> <Dd m="fat_trial" p={ddp()} /></>}
                value={pct(k.pct_trial)} sub={`Base ${pct(100 - k.pct_trial)}`} />
              <Kpi label={<>Net churn <Info text="Entradas (novos com data de entrada no mês + reativações no mês) − saídas (churn no mês). Trocas internas não contam." /></>}
                value={`${k.net_churn > 0 ? "+" : ""}${k.net_churn}`} valueClass={k.net_churn < 0 ? "cs-down" : k.net_churn > 0 ? "cs-up" : "cs-flat"}
                sub={<>
                  <Dd m="churns" p={ddp()} label={`${k.net_saidas} ${plural(k.net_saidas, "saída", "saídas")}`} />,{" "}
                  <Dd m="entradas" p={ddp()} label={`${k.net_novos} ${plural(k.net_novos, "nova", "novas")}`} />
                  {k.net_reativacoes > 0 && <>, <Dd m="reativacoes" p={ddp()} label={`${k.net_reativacoes} ${plural(k.net_reativacoes, "reativação", "reativações")}`} /></>}
                  {k.net_trocas > 0 && (
                    <span className="cs-small cs-muted">
                      + {k.net_trocas} {plural(k.net_trocas, "troca", "trocas")} de origem — não {plural(k.net_trocas, "entra", "entram")} nesta conta (<Dd m="entradas" p={ddp()} />)
                    </span>
                  )}
                  {(k.net_troca_squad_in > 0 || k.net_troca_squad_out > 0) && (
                    <span className="cs-small cs-info-text">
                      ↔{" "}
                      {f.squad_id === null ? (
                        <><Dd m="trocas_squad" p={ddp()} label={`${k.net_troca_squad_in} ${plural(k.net_troca_squad_in, "cliente trocou", "clientes trocaram")} de squad`} /> <span className="cs-muted">— não afeta o total da Make</span></>
                      ) : (
                        <>
                          {k.net_troca_squad_in > 0 && <Dd m="trocas_squad" p={ddp()} label={`+${k.net_troca_squad_in} veio de outro squad`} />}
                          {k.net_troca_squad_in > 0 && k.net_troca_squad_out > 0 && " · "}
                          {k.net_troca_squad_out > 0 && <Dd m="trocas_squad" p={ddp()} label={`−${k.net_troca_squad_out} foi pra outro squad`} />}
                          {" "}<span className="cs-muted">— fora do net churn</span>
                        </>
                      )}
                    </span>
                  )}
                </>} />
              <Kpi highlight
                label={<>Forecast fim de mês <Info text="Fórmula F-1 sobre o que está EM ABERTO (pendentes + resto dos parciais que pagam parcelado): Pessimista = realizado + 50% do Provável · Provável = realizado + Provável + 30% do Baixa · Melhor = realizado + Melhor. Valores CHEIOS (não desconta a regra M1) — projeções olham pra frente." /> <Dd m="pendentes" p={ddp()} label="em aberto" /></>}
                value={<span className="smaller">{moneyShort(k.forecast.pessimista)} → {moneyShort(k.forecast.provavel)} → {moneyShort(k.forecast.melhor)}</span>}
                sub="Pessimista · Provável · Melhor" />
            </div>
            {k.make_in.qtd > 0 && (
              <div className="cs-makein">
                <span className="cs-makein-icon" title="Programa Make IN">⚠️</span>
                <div>
                  <div className="cs-makein-head">
                    <strong>{fmtMoney(k.make_in.faturamento)}</strong> em <b>Make IN</b> · {k.make_in.qtd} {plural(k.make_in.qtd, "cliente", "clientes")}{" "}
                    <Info text="Soma do faturamento previsto (valor provável) dos ciclos do mês para clientes atualmente em Make IN. Retrato ao vivo: conforme o cliente vira ATIVO, sai dessa conta." />
                  </div>
                  <div className="cs-makein-list">
                    {k.make_in.lista.map((c) => (
                      <span key={c.id_externo} className="cs-chip-pill" title={`Faturamento previsto: ${fmtMoney(c.faturamento)}`}>
                        {c.nome} <small>#{c.id_externo}</small>
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </>
        ) : kp && (
          <div className="cs-kpis">
            <Kpi label={<>Faturamento acumulado <Info text="Soma do faturamento de todos os meses do período (com regra M1: desconta R$ 3k de M1 de trial). Quando há faturamento oficial lançado para o mês/squad, esse valor tem prioridade." /> <Dd m="faturamento" p={ddp()} /></>}
              value={fmtMoney(kp.fat_total)} sub={`${kp.qtd_meses} meses · média ${fmtMoney(kp.fat_medio_mes)}/mês`} />
            <Kpi label={<>Atingimento meta <Info text="Faturamento acumulado ÷ soma das metas mensais do período." /> <Dd m="meta" p={ddp({ squad: null })} label="gap" /></>}
              value={pct(kp.atingimento_pct)} sub={`Meta acumulada: ${fmtMoney(kp.meta_total)}`} />
            <Kpi label={<>Total Planejado período <Info text="SUM(valor_planejado_provavel) dos ciclos no período. Total que estava previsto." /> <Dd m="planejado" p={ddp()} /></>}
              value={fmtMoney(kp.planejado_total)} sub="soma de Provável dos ciclos" />
            <Kpi label={<>Variação mensal <Info text="Maior e menor faturamento de um único mês dentro do período. Quanto mais próximos, mais estável." /></>}
              value={<span className="smaller">{moneyShort(kp.fat_min_mes)} → {moneyShort(kp.fat_max_mes)}</span>} sub="menor mês · maior mês" />
            <Kpi label={<>Ativos ao fim <Info text="Retrato da carteira ATIVA ou MAKE IN no fim do período. Não é média — é a foto do último dia." /> <Dd m="ativos" p={{ mes: ym(p.fim), squad: f.squad_id, dim: f.dim }} /></>}
              value={kp.ativos_fim} sub={`no fim de ${labelMes(p.fim)}`} />
            <Kpi label={<>Pagantes únicos <Info text="Clientes distintos que pagaram pelo menos 1 ciclo no período (com regra M1)." /> <Dd m="pagantes" p={ddp()} /></>}
              value={`${kp.pagantes_unicos} / ${kp.clientes_no_periodo}`} sub="clientes únicos com ciclo no período" />
            <Kpi label={<>% Faturamento Trial <Info text="Faturamento de TRIAL ÷ faturamento total no período (ambos com regra M1)." /> <Dd m="fat_trial" p={ddp()} /></>}
              value={pct(kp.pct_trial)} sub={`Base ${pct(100 - kp.pct_trial)}`} />
            <Kpi label={<>Net churn período <Info text="Entradas (novos + reativações no período) − saídas (churns) acumulados." /></>}
              value={`${kp.net_churn > 0 ? "+" : ""}${kp.net_churn}`} valueClass={kp.net_churn < 0 ? "cs-down" : kp.net_churn > 0 ? "cs-up" : "cs-flat"}
              sub={<>
                <Dd m="churns" p={ddp()} label={`${kp.net_saidas} saídas`} />, <Dd m="entradas" p={ddp()} label={`${kp.net_novos} novas`} />
                {kp.net_reativacoes > 0 && <>, <Dd m="reativacoes" p={ddp()} label={`${kp.net_reativacoes} reativações`} /></>}
              </>} />
          </div>
        )}
      </Section>

      {p.is_compare ? (
        <div className="cs-banner info">
          ℹ️ Modo <strong>comparação</strong> ativo: mostrando apenas os KPIs principais lado a lado. Para a análise detalhada, escolha um período único.
        </div>
      ) : (
        <>
          {/* ------------------------------------------------ BLOCO 2 */}
          <Section id="b2" layer="Camada Análise" title="Bloco 2 — Financeiro" dot={C.good}
            sub="Quanto a Make está ganhando, e a curva está a favor?">
            <div className="cs-grid-auto">
              {fin.por_squad.filter((s) => shown(s.squad_id, s.fat > 0 || s.meta > 0)).map((s) => (
                <Card key={s.squad_id}>
                  <div className="cs-row-between">
                    <span className="cs-squad-title" style={{ color: color(s.squad_id) }}>
                      {s.nome} <Dd m="meta" p={ddp({ squad: s.squad_id })} label="explorar" />
                    </span>
                    <Achieved v={s.atingimento} />
                  </div>
                  <div className="cs-big">{fmtMoney(s.fat)}</div>
                  <div className="cs-muted cs-small">Meta: {fmtMoney(s.meta)} · Faltam {fmtMoney(Math.max(0, s.meta - s.fat))}</div>
                  <Bar value={s.atingimento} cls={tone(s.atingimento)} />
                </Card>
              ))}
              <Card className="cs-span-all accent">
                <div className="cs-row-between">
                  <span className="cs-squad-title accent">CS Consolidado <Dd m="meta" p={ddp({ squad: null })} label="explorar" /></span>
                  <Achieved v={fin.consolidado.atingimento} />
                </div>
                <div className="cs-big">{fmtMoney(fin.consolidado.fat)}</div>
                <div className="cs-muted cs-small">
                  Meta: {fmtMoney(fin.consolidado.meta)} · Faltam {fmtMoney(Math.max(0, fin.consolidado.meta - fin.consolidado.fat))}
                </div>
                <Bar value={fin.consolidado.atingimento} cls={tone(fin.consolidado.atingimento)} />
              </Card>
            </div>
            <div className="cs-grid-auto">
              <Card>
                <div className="cs-label">Ticket Médio (ARPU do mês) <Info text="Faturamento do mês (com regra M1) ÷ PAGANTES EFETIVOS: status pago/parcial com valor acima do limiar M1. Pendentes e M1 que pagaram ≤ R$ 3k ficam FORA do denominador (diferente da contagem de Pagantes do Bloco 1, que conta quem pagou algo)." /> <Dd m="ticket_medio" p={ddp()} /></div>
                <div className="cs-stack">
                  {fin.ticket.squads.filter((t) => shown(t.squad_id, t.tm > 0)).map((t) => (
                    <div key={t.squad_id} className="cs-row-between">
                      <span style={{ color: color(t.squad_id) }}>{t.nome} <Dd m="ticket_medio" p={ddp({ squad: t.squad_id })} /></span>
                      <b>{fmtMoney(t.tm)}</b>
                    </div>
                  ))}
                  <hr />
                  <div className="cs-row-between"><b>CS Total</b><strong>{fmtMoney(fin.ticket.consolidado)}</strong></div>
                </div>
                <p className="cs-muted cs-small">Faturamento ÷ pagantes do mês · valor varia mês a mês</p>
              </Card>
              <Card>
                <div className="cs-label">Composição do Faturamento <Dd m="faturamento" p={ddp()} /></div>
                <Chart kind="donut" unit="money" height={150}
                  labels={["Trial", "Base", ...(fin.composicao.acl > 0 ? ["ACL"] : [])]}
                  series={[{ name: "Faturamento", color: C.orange,
                    values: [fin.composicao.trial, fin.composicao.base, ...(fin.composicao.acl > 0 ? [fin.composicao.acl] : [])] }]} />
                <div className="cs-legend-row">
                  <span>Trial — {pct(fin.composicao.pct_trial)} <Dd m="faturamento" p={ddp({ categoria: "TRIAL" })} /></span>
                  <span>Base — {pct(fin.composicao.pct_base)} <Dd m="faturamento" p={ddp({ categoria: "BASE" })} /></span>
                  {fin.composicao.acl > 0 && <span>ACL — {pct(fin.composicao.pct_acl)} <Dd m="fat_acl" p={ddp()} /></span>}
                </div>
              </Card>
              <Card className="info">
                <div className="cs-label cs-info-text">Mensalidades (à parte) <Info text="Mensalidade pós-graduação. Receita À PARTE: NÃO entra no faturamento da meta, composição, ticket nem forecast. Prevista = valor combinado do mês (registrado POR MÊS — renegociação não altera meses antigos); Recebida = o que entrou." /> <Dd m="mensalidades" p={ddp()} /></div>
                <div className="cs-big">{fmtMoney(fin.mensalidades.recebido)}</div>
                <div className="cs-muted cs-small">recebido de {fmtMoney(fin.mensalidades.previsto)} previstos · fora da meta</div>
                <hr />
                <div className="cs-small">
                  {fin.mensalidades.a_receber > 0 && (
                    <><b className="cs-down">a receber {fmtMoney(fin.mensalidades.a_receber)}</b> ({fin.mensalidades.clientes_pendentes} {plural(fin.mensalidades.clientes_pendentes, "pendente", "pendentes")}) · </>
                  )}
                  {fin.mensalidades.clientes_pagando} pagando
                </div>
              </Card>
            </div>
            <ProvRec pr={pr} ddp={ddp} />
            {ev && (
              <Card>
                <div className="cs-label">Evolução Mensal — {p.label}</div>
                <p className="cs-muted cs-small">Squads sobrepostos com a meta · {ev.linhas.length} meses</p>
                <Chart kind="line" unit="money" height={240} labels={ev.linhas.map((l) => l.label)}
                  series={[
                    { name: "Meta consolidada", color: "#c9cfcf", values: ev.linhas.map((l) => l.meta_consolidada) },
                    ...ev.squads.filter((s) => shown(s.id, ev.linhas.some((l) => l.squads[s.id] > 0)))
                      .map((s) => ({ name: s.nome, color: color(s.id), values: ev.linhas.map((l) => l.squads[s.id] ?? 0) })),
                    { name: "Consolidado", color: "#263334", values: ev.linhas.map((l) => l.consolidado) },
                  ]} />
              </Card>
            )}
          </Section>

          {/* ------------------------------------------------ BLOCO 3 */}
          <Section id="b3" layer="Camada Análise" title="Bloco 3 — Saúde da Carteira" dot={C.bad}
            sub="Onde estou sangrando, onde estou em ouro? · 5 critérios HS · 3 faixas">
            <Card>
              <div className="cs-label">Distribuição de Health Score (3 faixas) <Info text="5 critérios HS pesados: Aprovação 10% + Reunião 15% + Pagamento 20% + Percepção 25% + Meta 30%. Faixas: ≥80% Satisfeito, 50–79% Alerta, <50% Crítico." /> <Dd m="hs_geral" p={ddp()} label="explorar" /></div>
              <div className="cs-stack">
                {sd.faixas_por_squad.filter((r) => shown(r.squad_id, r.total > 0)).map((r) => (
                  <StackLine key={r.squad_id} name={<SquadName id={r.squad_id} name={r.nome} />} total={`${r.total} clientes`}
                    parts={[[r.satisfeito, "good", "satisfeitos"], [r.alerta, "warn", "alerta"], [r.critico, "bad", "críticos"]]}
                    totalN={r.total} right={`HS médio ${numberFormat(r.hs_medio, 0)}%`} />
                ))}
                <hr />
                <StackLine name={<b>CS Total</b>} total={<b>{sd.faixas_consolidado.total} clientes</b>} totalN={sd.faixas_consolidado.total}
                  parts={[[sd.faixas_consolidado.satisfeito, "good", "satisfeitos"], [sd.faixas_consolidado.alerta, "warn", "alerta"],
                    [sd.faixas_consolidado.critico, "bad", "críticos"]]}
                  right={`HS médio ${numberFormat(sd.faixas_consolidado.hs_medio, 0)}%`} />
              </div>
              <div className="cs-pills">
                <span className="cs-pill good">Satisfeito ≥ 80%</span>
                <span className="cs-pill warn">Alerta 50–79%</span>
                <span className="cs-pill bad">Crítico &lt; 50%</span>
              </div>
            </Card>
            <div className="cs-grid-2">
              <Card>
                <div className="cs-label">Top ofensores no Health Score <Dd m="hs_geral" p={ddp()} label="explorar" /></div>
                <div className="cs-stack">
                  {sd.ofensores.map((o) => (
                    <div key={o.criterio}>
                      <div className="cs-row-between"><span>{o.label}</span><span>{o.falharam} falharam · peso {o.peso}%</span></div>
                      <Bar value={o.pct_falha} cls={o.pct_falha >= 40 ? "bad" : o.pct_falha >= 20 ? "warn" : "good"} />
                      <span className="cs-muted cs-small">Impacto {numberFormat(o.impacto, 2)} pts no score médio</span>
                    </div>
                  ))}
                </div>
              </Card>
              <Card>
                <div className="cs-label">Mix de Adimplência — {labelMes(f.mes_ref)} <Dd m="adimplencia_geral" p={ddp()} label="explorar" /></div>
                <div className="cs-stack">
                  {sd.adimplencia_squads.filter((r) => shown(r.squad_id, r.total > 0)).map((r) => (
                    <StackLine key={r.squad_id} name={<SquadName id={r.squad_id} name={r.nome} />} total={`${r.total} ciclos`} totalN={r.total}
                      parts={[[r.adimplente, "good", "adimplentes"], [r.inadimplente, "warn", "inadimplentes"], [r.perda, "bad", "em PERDA"]]} />
                  ))}
                  <hr />
                  <StackLine name={<b>CS Total</b>} total={`${sd.adimplencia_total.total} ciclos`} totalN={sd.adimplencia_total.total}
                    parts={[[sd.adimplencia_total.adimplente, "good", "adimplentes"], [sd.adimplencia_total.inadimplente, "warn", "inadimplentes"],
                      [sd.adimplencia_total.perda, "bad", "em PERDA"]]} />
                </div>
                <div className="cs-pills">
                  <span className="cs-pill good">Adimplente</span><span className="cs-pill warn">Inadimplente</span><span className="cs-pill bad">PERDA</span>
                </div>
              </Card>
            </div>
            <Card>
              <div className="cs-row-between">
                <div>
                  <div className="cs-label">Top contas em risco</div>
                  <span className="cs-muted cs-small">HS &lt; 70% · clique para ver o perfil</span>
                </div>
                <span className="cs-pill bad">{fmtMoney(sd.em_risco_total)} planejado em risco</span>
              </div>
              {sd.em_risco.length ? (
                <div className="cs-table-wrap">
                  <table className="cs-table">
                    <thead><tr><th>Cliente</th><th>Squad</th><th>Fase</th><th className="r">Investimento</th><th>HS</th><th>Tendência</th><th>Adimplência</th><th>Status</th></tr></thead>
                    <tbody>
                      {sd.em_risco.map((r) => (
                        <tr key={r.id} {...profileRow(r.id)}>
                          <td><b>{r.nome}</b> <span className="cs-muted">#{r.id_externo}</span></td>
                          <td>{r.squad_nome}</td>
                          <td>{r.tipo_id === "TRIAL"
                            ? <span className="cs-pill orange">Trial {r.trial_mes_atual >= 4 ? "M4+" : `M${r.trial_mes_atual}`}</span>
                            : <span className="cs-pill info">{r.tipo_id}</span>}</td>
                          <td className="r">{fmtMoney(r.investimento)}</td>
                          <td><span className={`cs-pill ${csPill(r.hs_faixa)}`}>{numberFormat(r.hs_atual, 0)}%</span></td>
                          <td>{r.delta_hs === null ? <span className="cs-muted">—</span>
                            : r.delta_hs < -2 ? <span className="cs-down">▼ {numberFormat(r.delta_hs, 0)}</span>
                              : r.delta_hs > 2 ? <span className="cs-up">▲ +{numberFormat(r.delta_hs, 0)}</span>
                                : <span className="cs-flat">→ estável</span>}</td>
                          <td><span className={`cs-pill ${csPill(r.adimplencia)}`}>{r.adimplencia || "—"}</span></td>
                          <td className="cs-muted">{r.status_pagamento ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="cs-muted">Nenhuma conta com HS &lt; 70% nesse mês.</p>}
            </Card>
            {p.is_single && <HsSuggestionsCard mes={f.mes_ref} />}
            {th && (
              <div className="cs-grid-2">
                <Card>
                  <div className="cs-label">Tendência mensal — HS médio</div>
                  <Chart kind="line" unit="percent" labels={th.map((x) => x.label)}
                    series={[{ name: "HS médio (%)", color: C.good, values: th.map((x) => x.hs_medio) }]} />
                </Card>
                <Card>
                  <div className="cs-label">Tendência mensal — Multiplicador (M) médio</div>
                  <Chart kind="line" unit="number" labels={th.map((x) => x.label)}
                    series={[{ name: "M médio", color: C.orange, values: th.map((x) => x.m_medio) }]} />
                </Card>
              </div>
            )}
          </Section>

          {/* ------------------------------------------------ BLOCO 4 */}
          <Section id="b4" layer="Camada Análise" title="Bloco 4 — Trial e Funil de Onboarding" dot={C.orange}
            sub="O trial está convertendo? Onde estou perdendo?">
            <div className="cs-grid-2">
              <Card>
                <div className="cs-label">Funil do Trial — {tr.periodo_label} <Dd m="trial_funil" p={{ mes: ym(tr.mes_ref), squad: f.squad_id }} label="explorar" /></div>
                {(() => {
                  const fn = tr.funil;
                  const max = Math.max(1, fn.m1, fn.m2, fn.m3, fn.m4plus, fn.graduados);
                  const rows: [string, number, number | null, string][] = [
                    ["Entraram (M1)", fn.m1, null, ""], ["Em M2", fn.m2, fn.m1, ""], ["Em M3", fn.m3, fn.m1, ""],
                    ["M4+ ⚠️", fn.m4plus, null, "warn"], ["→ Base", fn.graduados, fn.entradas, "good"],
                  ];
                  return (
                    <div className="cs-funnel">
                      {rows.map(([lbl, val, base, cls]) => (
                        <div key={lbl} className={`cs-funnel-row ${cls}`}>
                          <span>{lbl}</span>
                          <span className="cs-funnel-track"><i className={cls} style={{ width: `${Math.max(2, (val / max) * 100).toFixed(2)}%` }}>{val}</i></span>
                          <span className="cs-muted">{base ? `${Math.round((val / base) * 100)}%` : "100%"}</span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
                <hr />
                <div className="cs-grid-2 tight">
                  <div><small className="cs-muted">Taxa de graduação (cohort 3m)</small><div className="cs-mid">{pct(tr.funil.taxa_graduacao, 0)}</div></div>
                  <div><small className="cs-muted">Tempo médio até Base</small>
                    <div className="cs-mid">{tr.tempo_medio_dias !== null ? `${tr.tempo_medio_dias} dias` : <span className="cs-muted cs-small">só no período de vários meses</span>}</div></div>
                </div>
              </Card>
              <Card>
                <div className="cs-label">Cancelamento por mês de trial <Dd m="trial_churn_fase" p={{ mes: ym(tr.mes_ref), squad: f.squad_id }} label="explorar" /></div>
                <p className="cs-muted cs-small">{tr.periodo_label} · 1º Onboarding · 2º Performance · 3º Retenção/Escala</p>
                {(() => {
                  const cf = tr.churns_fase;
                  const max = Math.max(1, cf.M1, cf.M2, cf.M3, cf.M4plus, cf.PosTrial);
                  const rows: [keyof typeof cf, string, string][] = [["M1", "1º mês", C.orange], ["M2", "2º mês", C.bad], ["M3", "3º mês", C.orange],
                    ["M4plus", "M4+ (estendido) ⚠️", C.warn], ["PosTrial", "Pós-trial (Base)", C.muted]];
                  return (
                    <div className="cs-stack">
                      {rows.map(([key, lbl, cor]) => (
                        <div key={key}>
                          <div className="cs-row-between"><span>{lbl}</span><span>{cf[key]} {plural(cf[key], "churn", "churns")}</span></div>
                          <span className="cs-bar thick"><i style={{ width: `${((cf[key] / max) * 100).toFixed(2)}%`, background: cor }} /></span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </Card>
            </div>
            <div className="cs-grid-2">
              <Card>
                <div className="cs-label">Taxa de graduação por cohort <Dd m="trial_cohort" p={{ mes: ym(addMonths(tr.mes_ref, -3)), squad: f.squad_id }} label="explorar" /> <span className="cs-muted cs-small">— {tr.periodo_label}</span></div>
                <Chart kind="bar" unit="number" height={180} labels={tr.cohorts_grad.map((x) => x.label)}
                  series={[{ name: "Entradas", color: "#c9cfcf", values: tr.cohorts_grad.map((x) => x.total) },
                    { name: "Graduados", color: C.orange, values: tr.cohorts_grad.map((x) => x.graduados) }]} />
                <div className="cs-rates">
                  {tr.cohorts_grad.map((x) => <span key={x.mes}>{x.label} <b>{numberFormat(x.taxa, 0)}%</b></span>)}
                </div>
                <p className="cs-muted cs-small">Cada cohort = clientes que entraram naquele mês. Taxa = % que hoje são BASE.</p>
              </Card>
              <Card>
                <div className="cs-label">Comparativo squads no Trial — {tr.periodo_label} <Dd m="trial_cohort" p={{ mes: ym(tr.mes_ref) }} label="explorar" /></div>
                <div className="cs-table-wrap">
                  <table className="cs-table">
                    <thead><tr><th>Squad</th><th className="r">Em trial</th><th className="r">{tr.modo === "anual" ? "Entradas (período)" : "Entradas no mês"}</th><th className="r">Graduados</th><th className="r">Taxa</th><th className="r">Fat. médio</th></tr></thead>
                    <tbody>
                      {tr.por_squad.filter((s) => shown(s.squad_id, s.em_trial + s.entradas + s.graduados > 0)).map((s) => (
                        <tr key={s.squad_id}>
                          <td><SquadName id={s.squad_id} name={s.nome} /></td>
                          <td className="r">{s.em_trial}</td><td className="r">{s.entradas}</td><td className="r">{s.graduados}</td>
                          <td className="r">{pct(s.taxa_grad, 0)}</td><td className="r">{fmtMoney(s.fat_trial_avg)}</td>
                        </tr>
                      ))}
                      <tr className="total">
                        <td>CS Total</td><td className="r">{tr.total_squad.em_trial}</td><td className="r">{tr.total_squad.entradas}</td>
                        <td className="r">{tr.total_squad.graduados}</td><td className="r">{pct(tr.total_squad.taxa_grad, 0)}</td>
                        <td className="r">{fmtMoney(tr.total_squad.fat_trial_avg)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          </Section>

          {/* ------------------------------------------------ BLOCO 5 */}
          <Section id="b5" layer="Camada Análise" title="Bloco 5 — Churn e Retenção" dot={C.bad}
            sub="Por que estou perdendo? O que dá pra agir?">
            <div className="cs-grid-2">
              <Card>
                <div className="cs-row-between">
                  <div>
                    <div className="cs-label">Cancelamentos — {ch.modo === "mensal" ? labelMesFull(ch.mes_ref) : ch.periodo_label} <Dd m="churns" p={ddp()} /></div>
                    <span className="cs-muted cs-small">{ch.cancelamentos.length} {plural(ch.cancelamentos.length, "churn", "churns")} · perda anual potencial</span>
                  </div>
                  <span className="cs-pill bad">{fmtMoney(ch.perda_potencial)} ano</span>
                </div>
                {ch.cancelamentos.length ? (
                  <>
                    <div className="cs-table-wrap">
                      <table className="cs-table">
                        <thead><tr><th>Cliente</th><th>Squad</th><th>Motivo</th><th className="r">Inv. médio</th><th>Data</th></tr></thead>
                        <tbody>
                          {ch.cancelamentos.map((c, i) => (
                            <tr key={`${c.id}-${i}`} {...profileRow(c.id)}>
                              <td><b>{c.nome}</b> <span className="cs-muted">#{c.id_externo}</span></td>
                              <td>{c.squad_nome}</td>
                              <td><span className={`cs-pill ${c.evitavel ? "warn" : ""}`}>{c.motivo ?? "—"}</span></td>
                              <td className="r">{fmtMoney(c.investimento_medio)}</td>
                              <td className="cs-muted">{fmtDateBr(c.data_churn)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="cs-split cs-small">
                      <span className="cs-muted">Evitável: <b className="cs-warn-text">{fmtMoney(ch.perda_evitavel)}</b></span>
                      <span className="cs-muted">Inevitável: <b>{fmtMoney(ch.perda_potencial - ch.perda_evitavel)}</b></span>
                    </div>
                  </>
                ) : <p className="cs-muted">Sem cancelamentos no período de referência.</p>}
              </Card>
              <Card>
                <div className="cs-label">Distribuição de motivos — {ch.periodo_label}</div>
                {ch.motivos.length ? (
                  <>
                    <Chart kind="donut" unit="number" height={180} labels={ch.motivos.map((m) => m.label ?? "Sem motivo")}
                      series={[{ name: "Churns", color: C.bad, values: ch.motivos.map((m) => m.n) }]} />
                    <div className="cs-stack tight">
                      {ch.motivos.map((m) => (
                        <div key={m.label ?? ""} className="cs-row-between cs-small">
                          <span>{m.label ?? "Sem motivo"}</span>
                          <span>{m.n} · {pct(m.pct, 0)} <span className={`cs-pill ${m.evitavel ? "warn" : ""}`}>{m.evitavel ? "evitável" : "inevitável"}</span></span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : <p className="cs-muted">Sem dados de churn — {ch.periodo_label}.</p>}
              </Card>
            </div>
            <Card>
              <div className="cs-label">Curva de retenção por cohort</div>
              <p className="cs-muted cs-small">
                {ch.modo === "anual" ? `${ch.retencao.length} cohorts (1 por mês do período)` : `Cohort de ${ch.periodo_label}`} · M0 (entrada) → M6 (6 meses depois)
              </p>
              <Chart kind="line" unit="percent" height={240} labels={["M0", "M1", "M2", "M3", "M4", "M5", "M6"]}
                series={ch.retencao.filter((r) => r.inicial > 0).map((r, i) => ({
                  name: `${r.label} (n=${r.inicial})`, color: PALETTE[i % PALETTE.length],
                  values: Array.from({ length: 7 }, (_, j) => r.serie[j] ?? null),
                }))} />
            </Card>
            <div className="cs-grid-2">
              {ch.modo === "anual" && ch.ltv_consolidado ? (
                <Card>
                  <div className="cs-label">LTV histórico (real, não estimado) <Info text="Soma histórica do valor efetivo (valor pago com a regra M1: desconta R$ 3k do primeiro mês). NÃO é ticket × meses — porque o ticket varia muito." /></div>
                  <div className="cs-grid-2 tight">
                    <div><small className="cs-muted">CS Total — em meses</small><div className="cs-big">{numberFormat(ch.ltv_consolidado.ltv_meses ?? 0, 1)}</div></div>
                    <div><small className="cs-muted">CS Total — em R$</small><div className="cs-big accent">{fmtMoney(ch.ltv_consolidado.ltv_reais ?? 0)}</div></div>
                  </div>
                  <table className="cs-table">
                    <thead><tr><th>Squad</th><th className="r">LTV (meses)</th><th className="r">LTV (R$)</th></tr></thead>
                    <tbody>
                      {ch.ltv_squads.map((l) => (
                        <tr key={l.id}><td><SquadName id={l.id} name={l.nome} /></td><td className="r">{numberFormat(l.ltv_meses, 1)}</td><td className="r">{fmtMoney(l.ltv_reais)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="cs-muted cs-small">LTV em R$ = soma histórica de tudo que cada cliente já investiu. Não é ticket × meses.</p>
                </Card>
              ) : (
                <Card className="cs-placeholder">
                  <span>LTV histórico</span>
                  <small>Disponível nos períodos de vários meses — <button type="button" className="cs-link" onClick={onYear}>ver os últimos 12 meses</button></small>
                </Card>
              )}
              <Card>
                <div className="cs-label">Comparativo squads no Churn — {ch.periodo_label}</div>
                <table className="cs-table">
                  <thead><tr><th>Squad</th><th className="r"># Churns</th><th className="r">Perda anual potencial</th></tr></thead>
                  <tbody>
                    {ch.squads_churn.map((s) => (
                      <tr key={s.id}><td><SquadName id={s.id} name={s.nome} /></td><td className="r">{s.n_churns}</td><td className="r">{fmtMoney(s.perda_anual)}</td></tr>
                    ))}
                    {!ch.squads_churn.length && <tr><td colSpan={3} className="cs-muted">Nenhum churn no período.</td></tr>}
                  </tbody>
                </table>
                <p className="cs-muted cs-small">Perda anual = média do investimento dos 3 ciclos antes do churn × 12.</p>
              </Card>
            </div>
          </Section>

          {/* ------------------------------------------------ BLOCO 6 */}
          {pv && (
            <Section id="b6" layer="Camada Inteligência" title="Bloco 6 — Previsibilidade" dot={C.orange} tinted
              sub="Realizado x Planejado · vai bater o mês?">
              <div className="cs-grid-3">
                {([
                  ["Cenário Pessimista", pv.forecast.pessimista, pv.forecast.pct_pessimista, "bad", "realizado + 50% do Provável pendente"],
                  ["Cenário Provável", pv.forecast.provavel, pv.forecast.pct_provavel, "orange", "realizado + Provável + 30% do Baixa"],
                  ["Cenário Melhor", pv.forecast.melhor, pv.forecast.pct_melhor, "good", "realizado + Melhor de TODOS os pendentes"],
                ] as const).map(([lbl, v, pc, cls, how]) => (
                  <Card key={lbl} className={`scenario ${cls}`}>
                    <div className="cs-row-between">
                      <span className={`cs-label cs-${cls}-text`}>{lbl}</span>
                      <span className={`cs-pill ${cls}`}>{pct(pc, 1)} meta</span>
                    </div>
                    <div className="cs-huge">{fmtMoney(v)}</div>
                    <div className="cs-muted cs-small">
                      vs meta {fmtMoney(pv.forecast.meta)}
                      {pv.forecast.meta > 0 && <> · <span className={v >= pv.forecast.meta ? "cs-up" : "cs-down"}>
                        {v >= pv.forecast.meta ? "+" : ""}{numberFormat(((v - pv.forecast.meta) / pv.forecast.meta) * 100, 1)}%</span></>}
                    </div>
                    <hr />
                    <span className="cs-muted cs-small">{how}</span>
                  </Card>
                ))}
              </div>
              <Week sm={pv.semana} onSemana={onSemana} onReceiving={onReceiving} />
              {pv.anomalias.length > 0 && (
                <Card>
                  <div className="cs-label">Detector de anomalias — F-4</div>
                  <p className="cs-muted cs-small">
                    {pv.anomalias.length} {plural(pv.anomalias.length, "sinal", "sinais")} · regras: queda HS, queda meta, prob baixa 2x, PERDA recorrente, queda squad, pico churn, M3 com HS&lt;50, concentração de recebimento no fim do mês, ciclo replanejado, recebimento atrás da linha ideal
                  </p>
                  <div className="cs-stack tight">
                    {pv.anomalias.map((a, i) => (
                      <div key={i} className="cs-tight cs-alert-row" {...profileRow(a.cliente_id)}>
                        <span className={`cs-pill ${a.severidade === "alta" ? "bad" : "warn"}`}>{a.severidade === "alta" ? "ALTA" : "MÉDIA"}</span>
                        <Html html={a.mensagem} />
                      </div>
                    ))}
                  </div>
                </Card>
              )}
              <div className="cs-grid-2">
                <Card>
                  <div className="cs-row-between">
                    <div>
                      <div className="cs-label">Pipeline de churn — próximos 30 dias</div>
                      <span className="cs-muted cs-small">HS &lt; 70% ou adimplência ruim · investimento médio (3m)</span>
                    </div>
                    <span className="cs-pill bad">{fmtMoney(pv.pipeline_churn_total)} em risco</span>
                  </div>
                  {pv.pipeline_churn.length ? (
                    <table className="cs-table">
                      <thead><tr><th>Cliente</th><th className="r">Inv. médio</th><th>Motivo</th><th>Ação</th></tr></thead>
                      <tbody>
                        {pv.pipeline_churn.map((r) => (
                          <tr key={r.id} {...profileRow(r.id)}>
                            <td><b>{r.nome}</b> <span className="cs-muted">HS {r.hs === null ? "—" : `${numberFormat(r.hs, 0)}%`}</span></td>
                            <td className="r">{fmtMoney(r.investimento_medio)}</td>
                            <td><span className={`cs-pill ${r.motivo_provavel === "Financeiro" ? "bad" : r.motivo_provavel === "Performance Trial" ? "orange" : "warn"}`}>{r.motivo_provavel}</span></td>
                            <td className="cs-muted cs-small">{r.acao}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <p className="cs-muted">Sem clientes em risco neste mês.</p>}
                </Card>
                <Card>
                  <div className="cs-row-between">
                    <div>
                      <div className="cs-label">Pipeline de graduação — Trial M3 e M4+</div>
                      <span className="cs-muted cs-small">F-3 · 3 condições: HS≥70% + adimplência total + probabilidade≥PROVÁVEL · M4+ = estendido (decisão atrasada)</span>
                    </div>
                    <span className="cs-pill good">{fmtMoney(pv.pipeline_grad_total)} entrando</span>
                  </div>
                  {pv.pipeline_grad.length ? (
                    <table className="cs-table">
                      <thead><tr><th>Cliente</th><th>Fase</th><th className="r">Inv. atual</th><th>HS</th><th>Probabilidade</th></tr></thead>
                      <tbody>
                        {pv.pipeline_grad.map((r) => (
                          <tr key={r.id} {...profileRow(r.id)}>
                            <td><b>{r.nome}</b></td>
                            <td className={r.fase_num >= 4 ? "cs-warn-text" : ""}>{r.fase_num >= 4 ? `⚠️ ${r.fase}` : `M${r.fase_num}`}</td>
                            <td className="r">{fmtMoney(r.investimento)}</td>
                            <td>{r.hs === null ? "—" : `${numberFormat(r.hs, 0)}%`}</td>
                            <td>
                              <span className={`cs-pill ${r.probabilidade_grad === "ALTA" ? "good" : r.probabilidade_grad === "MEDIA" ? "warn" : "bad"}`}>{r.probabilidade_grad}</span>
                              <small className="cs-muted cs-block">{r.cond_hs ? "✓" : "✗"} HS · {r.cond_adimp ? "✓" : "✗"} Adimp · {r.cond_prob ? "✓" : "✗"} Prob</small>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <p className="cs-muted">Sem clientes em M3 ou M4+ neste mês.</p>}
                </Card>
              </div>
            </Section>
          )}

          {/* ------------------------------------------------ BLOCO 7 */}
          <Section id="b7" layer="Camada Inteligência" title="Bloco 7 — Comparativo Squads" dot={C.info}
            sub="Qual squad performa melhor, em que dimensão? Onde realocar?">
            {(() => {
              const sids = Object.keys(sq7.por_squad).filter((sid) => {
                const m = sq7.por_squad[sid];
                return shown(sid, m.fat > 0 || m.ativos_trial + m.ativos_base > 0);
              });
              const defs: [keyof (typeof sq7.por_squad)[string], string, (v: number) => string][] = [
                ["fat", "Faturamento", fmtMoney], ["ticket", "Ticket médio (ARPU)", fmtMoney],
                ["ativos_trial", "# Ativos Trial", String], ["ativos_base", "# Ativos Base", String],
                ["hs_medio", "HS médio", (v) => pct(v, 0)], ["m_medio", "Multiplicador (M) médio", (v) => numberFormat(v, 2)],
                ["net_churn", "Net churn (entradas − saídas)", (v) => `${v >= 0 ? "+" : ""}${v}`],
                ["entradas", "Novos (Comercial+Reat)", String], ["taxa_grad", "Taxa de graduação", (v) => pct(v, 0)],
                ["taxa_adimp", "Taxa de adimplência", (v) => pct(v, 0)],
              ];
              return (
                <Card>
                  <div className="cs-label">Tabela comparativa — {p.is_single ? labelMesFull(f.mes_ref) : p.label}</div>
                  <div className="cs-table-wrap">
                    <table className="cs-table">
                      <thead>
                        <tr><th>Métrica</th>{sids.map((sid) => <th key={sid} className="r" style={{ color: color(sid) }}>{sq7.por_squad[sid].nome}</th>)}<th>Líder</th></tr>
                      </thead>
                      <tbody>
                        {defs.map(([key, label, fmt]) => {
                          const lider = sq7.lideres[key as string];
                          return (
                            <tr key={key as string}>
                              <td>{label}</td>
                              {sids.map((sid) => (
                                <td key={sid} className={`r ${sid === lider ? "lead" : "cs-muted"}`}>{fmt(Number(sq7.por_squad[sid][key]))}</td>
                              ))}
                              <td>{lider && <span className="cs-pill" style={{ color: color(lider) }}>{sq7.por_squad[lider].nome}</span>}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </Card>
              );
            })()}
            <div className="cs-grid-2">
              {!p.is_single && (
                <Card>
                  <div className="cs-label">Melhor squad por mês</div>
                  <p className="cs-muted cs-small">Critério: maior faturamento · {p.label}</p>
                  <div className="cs-months-row">
                    {msm.map((m) => (
                      <div key={m.mes}>
                        <small className="cs-muted">{m.label}</small>
                        <span className="cs-pill" style={{ color: color(m.squad_id) }} title={fmtMoney(m.fat)}>
                          {m.fat > 0 && m.squad_id ? e.squadName(m.squad_id) : "—"}
                        </span>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
              <Card className={p.is_single ? "cs-span-all" : ""}>
                <div className="cs-label">Insights de comparação</div>
                {sq7.insights.length ? (
                  <ul className="cs-list">{sq7.insights.map((i, n) => <li key={n}><Html html={i} /></li>)}</ul>
                ) : <p className="cs-muted">Sem diferenças relevantes entre squads neste mês.</p>}
              </Card>
            </div>
          </Section>

          {/* ------------------------------------------------ BLOCO 8 */}
          <Section id="b8" layer="Camada Inteligência" title="Bloco 8 — Insights Automáticos" dot={C.orange}
            sub="5 minutos antes da reunião — frases acionáveis em 4 categorias">
            <div className="cs-grid-2">
              {([
                ["Alertas vermelhos", "🔴", "bad", ins.alertas], ["Atenções amarelas", "🟡", "warn", ins.atencoes],
                ["Conquistas verdes", "🟢", "good", ins.conquistas], ["Recomendações", "🧭", "orange", ins.recomendacoes],
              ] as const).map(([title, emoji, cls, frases]) => (
                <Card key={title} className={`insight ${cls}`}>
                  <div className={`cs-label cs-${cls}-text`}><span aria-hidden="true">{emoji}</span> {title}</div>
                  {frases.length ? <ul className="cs-list">{frases.map((fr, i) => <li key={i}><Html html={fr} /></li>)}</ul>
                    : <p className="cs-muted">Sem destaques nesta categoria.</p>}
                </Card>
              ))}
            </div>
            <p className="cs-muted cs-small cs-center">Insights gerados pelas regras do painel sobre o mês de referência. Os filtros de squad e recorte valem.</p>
          </Section>
        </>
      )}
    </>
  );
}

function StackLine({ name, total, totalN, parts, right }: {
  name: ReactNode; total: ReactNode; totalN: number; parts: [number, string, string][]; right?: string;
}) {
  const t = Math.max(1, totalN);
  return (
    <div>
      <div className="cs-row-between"><span>{name}</span><span className="cs-muted">{total}</span></div>
      <span className="cs-stackbar">
        {parts.map(([n, cls, lbl]) => <i key={lbl} className={cls} style={{ width: `${(n / t) * 100}%` }} title={`${n} ${lbl}`} />)}
      </span>
      <div className="cs-row-between cs-muted cs-small">
        <span>{parts.map(([n, , lbl]) => `${n} ${lbl}`).join(" · ")}</span>
        {right && <span>{right}</span>}
      </div>
    </div>
  );
}

function ProvRec({ pr, ddp }: { pr: ReturnType<typeof provavelRecebidoData>; ddp: () => DdParams }) {
  const { e } = useCs();
  const gaps = pr.rows.filter((r) => !r.pendente && Math.abs(r.diff) > 0.009);
  const top = gaps.slice(0, 8);
  const mais = [...gaps].reverse().slice(0, 4).filter((r) => r.diff > 0 && !top.includes(r));
  const Row = ({ r }: { r: (typeof gaps)[number] }) => (
    <tr>
      <td>{r.nome} <span className="cs-muted">#{r.id_externo}</span></td>
      <td>{e.squadName(r.squad_id)}</td>
      <td className="r">{fmtMoney(r.provavel)}</td>
      <td className="r">{fmtMoney(r.recebido)}</td>
      <td className={`r ${r.diff < 0 ? "cs-down" : "cs-up"}`}><b>{r.diff > 0 ? "+" : ""}{fmtMoney(r.diff)}</b></td>
      <td>{r.status_pagamento}</td>
    </tr>
  );
  return (
    <Card>
      <div className="cs-row-between">
        <div>
          <div className="cs-label">2.6 Provável vs Recebido <Info text="Compara o Provável de cada ciclo com o pago, ambos EFETIVOS (M1 de trial tem R$ 3k descontados dos dois lados). Saldo = recebido − provável SÓ de ciclos resolvidos (pagos/parciais/perda) — pendentes ficam fora do saldo e aparecem em “ainda pode entrar”." /> <Dd m="provavel_recebido" p={ddp()} label="ver todos" /></div>
          <span className="cs-muted cs-small">Onde estamos recebendo menos (ou mais) do que o esperado</span>
        </div>
        <div className="cs-right">
          <div className="cs-label">Saldo</div>
          <div className={`cs-mid ${pr.saldo < 0 ? "cs-down" : pr.saldo > 0 ? "cs-up" : "cs-flat"}`}>{pr.saldo > 0 ? "+" : ""}{fmtMoney(pr.saldo)}</div>
        </div>
      </div>
      <div className="cs-grid-3 tight">
        <div className="cs-tight"><small className="cs-muted">Recebendo A MENOS</small><div className="cs-mid cs-down">{fmtMoney(pr.menos_total)}</div>
          <small className="cs-muted">{pr.n_menos} {plural(pr.n_menos, "ciclo pago", "ciclos pagos")} abaixo do provável</small></div>
        <div className="cs-tight"><small className="cs-muted">Recebendo A MAIS</small><div className="cs-mid cs-up">+{fmtMoney(pr.mais_total)}</div>
          <small className="cs-muted">{pr.n_mais} {plural(pr.n_mais, "ciclo", "ciclos")} acima do provável</small></div>
        <div className="cs-tight"><small className="cs-muted">Ainda pode entrar (pendente)</small><div className="cs-mid">{fmtMoney(pr.pend_provavel)}</div>
          <small className="cs-muted">{pr.n_pend} {plural(pr.n_pend, "ciclo", "ciclos")} sem pagamento</small></div>
      </div>
      {top.length ? (
        <div className="cs-table-wrap">
          <table className="cs-table">
            <thead><tr><th>Cliente</th><th>Squad</th><th className="r">Provável</th><th className="r">Recebido</th><th className="r">Diferença</th><th>Status</th></tr></thead>
            <tbody>
              {top.map((r) => <Row key={r.cycle.id} r={r} />)}
              {mais.map((r) => <Row key={r.cycle.id} r={r} />)}
            </tbody>
          </table>
          {gaps.length > top.length && (
            <p className="cs-muted cs-small">Mostrando os maiores gaps · {gaps.length} ciclos com diferença no total — <Dd m="provavel_recebido" p={ddp()} label="ver lista completa" /></p>
          )}
        </div>
      ) : <p className="cs-muted">Nenhum ciclo pago com diferença vs o provável neste período.</p>}
    </Card>
  );
}

function Week({ sm, onSemana, onReceiving }: {
  sm: NonNullable<ReturnType<typeof previsibilidadeData>>["semana"]; onSemana: (d: string | null) => void; onReceiving: () => void;
}) {
  const profileRow = useProfileRow();
  const aberto = sm.linhas.filter((l) => l.a_receber > 0);
  const perda = sm.linhas.filter((l) => l.status_pagamento === "PERDA");
  const ok = sm.linhas.filter((l) => l.a_receber <= 0 && l.status_pagamento !== "PERDA");
  const okPago = ok.reduce((t, l) => t + (l.data_pagamento && l.data_pagamento >= sm.inicio && l.data_pagamento <= sm.fim ? l.valor_pago : 0), 0);
  const mesSemana = ym(sm.fim);
  const grupos: [string, typeof sm.linhas, string][] = [
    ...(aberto.length ? [[`🟠 A receber nesta semana — ${fmtMoney(sm.tot_a_receber)} em ${aberto.length} ${plural(aberto.length, "ciclo", "ciclos")}`, aberto, "orange"] as [string, typeof sm.linhas, string]] : []),
    ...(ok.length ? [[`✅ Resolvidos (pago / isento) — recebido na semana ${fmtMoney(okPago)}`, ok, "good"] as [string, typeof sm.linhas, string]] : []),
    ...(perda.length ? [[`🔴 Perdas — ${fmtMoney(sm.tot_perda)} (não vem mais)`, perda, "bad"] as [string, typeof sm.linhas, string]] : []),
  ];
  const sa = sm.score_acum;
  const saPct = sm.planejado_acum > 0 ? Math.round((sm.recebido_acum / sm.planejado_acum) * 1000) / 10 : 0;
  return (
    <Card>
      <div className="cs-row-between wrap">
        <div>
          <div className="cs-label">Realizado x Planejado — semana</div>
          <span className="cs-muted cs-small">Espelha a aba “Realizado x Planejado” da Smart Acompanhamento. Domingo a sábado.</span>
        </div>
        <div className="cs-week-nav">
          <button type="button" className="icon-btn" aria-label="Semana anterior" onClick={() => onSemana(addDays(sm.inicio, -1))}>◀</button>
          <span className="cs-chip-pill">{fmtDateBr(sm.inicio)} → {fmtDateBr(sm.fim)}</span>
          <button type="button" className="icon-btn" aria-label="Semana seguinte" onClick={() => onSemana(addDays(sm.fim, 1))}>▶</button>
          <button type="button" className="btn secondary small" onClick={() => onSemana(null)}>Hoje</button>
          <button type="button" className="btn secondary small accent" onClick={onReceiving}>📅 Distribuição do mês →</button>
        </div>
      </div>
      <div className="cs-grid-5">
        <div className="cs-tight"><small className="cs-muted">Total Planejado (Provável)</small><div className="cs-mid">{fmtMoney(sm.tot_planejado_provavel)}</div>
          <small className="cs-muted">Melhor: {fmtMoney(sm.tot_planejado_melhor)}</small></div>
        <div className="cs-tight"><small className="cs-muted">Total Recebido (planejado)</small><div className="cs-mid">{fmtMoney(sm.tot_recebido_planejado)}</div>
          <small className="cs-muted">dos {sm.linhas.length} ciclos da semana</small></div>
        <div className="cs-tight"><small className="cs-muted">Não planejado mas recebido</small><div className="cs-mid">{fmtMoney(sm.tot_nao_planejado)}</div>
          <small className="cs-muted">{sm.nao_planejado_linhas.length} {plural(sm.nao_planejado_linhas.length, "pagamento", "pagamentos")} fora do plano</small></div>
        <div className={`cs-tight ${sm.tot_a_receber > 0 ? "orange" : "good"}`}><small className="cs-muted">💰 A receber na semana</small>
          <div className={`cs-mid ${sm.tot_a_receber > 0 ? "cs-orange-text" : ""}`}>{fmtMoney(sm.tot_a_receber)}</div>
          <small className="cs-muted">{sm.n_a_receber} {plural(sm.n_a_receber, "ciclo", "ciclos")} em aberto (pendentes + resto dos parciais){sm.tot_perda > 0 ? ` · perdas ${fmtMoney(sm.tot_perda)} fora` : ""}</small></div>
        <div className={`cs-tight ${sa >= 0 ? "good" : "bad"}`}><small className="cs-muted">Score acumulado no mês ({labelMes(sm.mes_score)})</small>
          <div className={`cs-mid ${sa >= 0 ? "cs-up" : "cs-down"}`}>{sa > 0 ? "+" : ""}{fmtMoney(sa)}</div>
          <small className="cs-muted">Planej. {fmtMoney(sm.planejado_acum)} · Receb. {fmtMoney(sm.recebido_acum)} ({numberFormat(saPct, 1)}%) · {sa >= 0 ? "adiantado ✓" : "atrasado ⚠️"}</small></div>
      </div>
      {!sm.linhas.length && !sm.nao_planejado_linhas.length ? <p className="cs-muted">Sem cobranças ou pagamentos nesta semana.</p> : (
        <div className="cs-table-wrap">
          <table className="cs-table">
            <thead><tr><th>Cliente</th><th>Squad</th><th>Cobrança</th><th className="r">Melhor</th><th className="r">Provável</th><th className="r">Pago</th><th className="r">A receber</th><th>Pgto</th><th>Prob.</th><th>Status</th></tr></thead>
            <tbody>
              {grupos.map(([titulo, linhas, cls]) => [
                <tr key={titulo} className={`group ${cls}`}><td colSpan={10}>{titulo}</td></tr>,
                ...linhas.map((l) => (
                  <tr key={l.cycle.id} {...profileRow(l.cliente_id)}>
                    <td>{l.nome} <span className="cs-muted">#{l.id_externo}</span>
                      {ym(l.mes_competencia) !== mesSemana && <span className="cs-pill warn" title="Este ciclo é de outra competência — a data de cobrança dele caiu nesta semana">ciclo {labelMes(l.mes_competencia)}</span>}</td>
                    <td className="cs-muted">{l.squad_nome}</td>
                    <td className="cs-muted">{fmtDateBr(l.data_cobranca)}</td>
                    <td className="r cs-muted">{fmtMoney(l.valor_planejado_melhor)}</td>
                    <td className="r">{fmtMoney(l.valor_planejado_provavel)}</td>
                    <td className="r"><b>{fmtMoney(l.valor_pago)}</b></td>
                    <td className={`r ${l.a_receber > 0 ? "cs-orange-text" : ""}`}>{l.a_receber > 0 ? <b>{fmtMoney(l.a_receber)}</b> : "—"}</td>
                    <td className="cs-muted">{l.data_pagamento ? fmtDateBr(l.data_pagamento) : "—"}</td>
                    <td><span className={`cs-pill ${l.probabilidade === "ALTA" ? "good" : l.probabilidade === "BAIXA" ? "bad" : ""}`}>{l.probabilidade}</span></td>
                    <td><span className={`cs-pill ${l.status_pagamento === "PAGO" ? "good" : l.status_pagamento === "PERDA" ? "bad" : "warn"}`}>{l.status_pagamento}</span></td>
                  </tr>
                )),
              ])}
              {sm.nao_planejado_linhas.length > 0 && [
                <tr key="np" className="group orange"><td colSpan={10}>Recebidos não planejados nesta semana — {fmtMoney(sm.tot_nao_planejado)}</td></tr>,
                ...sm.nao_planejado_linhas.map((l, i) => (
                  <tr key={`np-${i}`}>
                    <td>{l.nome} <span className="cs-muted">#{l.id_externo}</span></td>
                    <td className="cs-muted">{l.squad_nome}</td>
                    <td className="cs-muted">{l.data_cobranca ? fmtDateBr(l.data_cobranca) : "—"}</td>
                    <td className="r cs-muted">—</td><td className="r cs-muted">—</td>
                    <td className="r cs-orange-text"><b>{fmtMoney(l.valor_pago)}</b></td>
                    <td className="r cs-muted">—</td>
                    <td className="cs-muted">{fmtDateBr(l.data_pagamento)}</td>
                    <td>—</td>
                    <td><span className="cs-pill good">{l.status_pagamento}</span></td>
                  </tr>
                )),
              ]}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

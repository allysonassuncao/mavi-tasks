// Customer Success: conferência de paridade do motor novo (src/cs-*.ts) com
// o dash antigo (cs-make-dashboard). Os dados e o gabarito NÃO entram no git
// (são dados financeiros dos clientes):
//
//   1. o dump do MySQL do dash (phpMyAdmin → Exportar → SQL);
//   2. o gabarito: as funções PHP do dash rodando sobre esse dump
//      (_gabarito.php no Docker, ver o handoff da fase 2), em JSON.
//
//   npx tsx scripts/cs-parity.ts --dump dump.json --gabarito gabarito.json [--only kpi] [--verbose]
//
// dump.json é o dump convertido por parseSqlDump (scripts/import-maso-campaigns.mjs).
// Para cada bloco, mês e squad compara campo a campo (números com tolerância
// de 1 centavo; listas pela chave do cliente) e lista as diferenças.
import { readFileSync } from "node:fs";
import { CsEngine, type CsData } from "../src/cs-engine";
import { dumpToData } from "./cs-dump";
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
  rankingSquadsData,
  saudeData,
  squadsData,
  tendenciaHsData,
  trialDataAnual,
  trialDataMensal,
  trocasSquadMes,
  mensalidadesResumo,
} from "../src/cs-blocks";
import { recPlanejamento } from "../src/cs-receiving";
import { drilldownRun } from "../src/cs-drilldowns";

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const verbose = process.argv.includes("--verbose");
const only = arg("only");
const dump = JSON.parse(readFileSync(arg("dump")!, "utf8"));
const gab = JSON.parse(readFileSync(arg("gabarito")!, "utf8"));

// ------------------------------------------------------------ comparação
type Diff = { path: string; php: unknown; ts: unknown };
const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#039;/g, "'").replace(/&quot;/g, '"')
  .replace(/\s+/g, " ").trim();
function norm(v: unknown): unknown {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v !== "" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  if (typeof v === "string") return strip(v);
  return v;
}
/** Listas cuja ordem vem de consultas sem ORDER BY no PHP (ordem física do MySQL). */
const UNORDERED = ["alertas", "atencoes", "conquistas", "recomendacoes", "insights"];
/** Linhas que só se distinguem pelo texto (ordem física do MySQL no PHP). */
const BY_TEXT = ["anomalias", "dd_anomalias", "dd_insights"];
const ROW_KEYS = ["id_externo", "nome", "cliente_id", "mes", "mes_competencia", "squad_id", "criterio", "key", "regra", "label", "dia", "semana", "cohort", "id"];
function rowKey(r: Record<string, unknown>, other?: Record<string, unknown>) {
  return ROW_KEYS.filter((k) => k in r && r[k] !== null && typeof r[k] !== "object" && (!other || k in other))
    .map((k) => `${k}=${norm(r[k])}`).join("|");
}
/** O PHP serializa arrays associativos (chave = dia ou id do squad) como objeto. */
function alignObject(a: Record<string, unknown>, b: unknown): Record<string, unknown> | null {
  if (!Array.isArray(b)) return null;
  const keys = Object.keys(a);
  const objs = b.some((x) => x && typeof x === "object" && ("squad_id" in x || "id" in x));
  if (!objs && keys.every((k) => /^\d+$/.test(k)) && b.length === keys.length && keys[0] === "1")
    return Object.fromEntries(keys.map((k) => [k, b[Number(k) - 1]]));
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const hit = b.find((x) => x && typeof x === "object" && String((x as Record<string, unknown>).squad_id ??
      (x as Record<string, unknown>).id ?? (x as Record<string, unknown>).dia) === k);
    if (hit) out[k] = hit;
  }
  return out;
}
function compare(php: unknown, ts: unknown, path: string, out: Diff[], ignore: Set<string>) {
  if (ignore.has(path.replace(/\[\d+\]/g, "[]").replace(/\{[^}]*\}/g, "{}"))) return;
  const a = norm(php), b = norm(ts);
  if (a === null || a === undefined) {
    if (b !== null && b !== undefined && b !== 0 && !(Array.isArray(b) && !b.length)) out.push({ path, php: a, ts: b });
    return;
  }
  if (typeof a === "number") {
    if (typeof b !== "number" || Math.abs(a - b) > 0.011 * Math.max(1, Math.abs(a) / 1e6)) out.push({ path, php: a, ts: b });
    return;
  }
  if (typeof a === "string") {
    if (a !== norm(b)) out.push({ path, php: a, ts: b });
    return;
  }
  if (Array.isArray(a)) {
    const bArr = Array.isArray(b) ? b : b && typeof b === "object" ? Object.values(b) : [];
    if (a.length !== bArr.length) out.push({ path: `${path}.length`, php: a.length, ts: bArr.length });
    const ref = bArr.find((x) => x && typeof x === "object") as Record<string, unknown> | undefined;
    const isRows = a.length > 0 && typeof a[0] === "object" && a[0] !== null && !Array.isArray(a[0]) &&
      rowKey(a[0] as never, ref);
    if (UNORDERED.some((u) => path.includes(u)) && a.every((x) => typeof x === "string")) {
      const sa = [...a].map((x) => norm(x)).sort(), sb = [...bArr].map((x) => norm(x)).sort();
      sa.forEach((x, i) => { if (x !== sb[i]) out.push({ path: `${path}(sem ordem)`, php: x, ts: sb[i] }); });
      return;
    }
    if (a.length && typeof a[0] === "object" && BY_TEXT.some((u) => path.startsWith(u) || path.includes(`.${u}`))) {
      const txt = (x: unknown) => JSON.stringify(Object.values(x as object).map(norm).filter((v) => typeof v === "string").sort());
      const sa = a.map(txt).sort(), sb = bArr.map(txt).sort();
      sa.forEach((x, i) => { if (x !== sb[i]) out.push({ path: `${path}(sem ordem)`, php: x, ts: sb[i] }); });
      return;
    }
    if (isRows) {
      const used = new Set<number>();
      a.forEach((row) => {
        const k = rowKey(row as never, ref);
        const j = bArr.findIndex((x, jj) => !used.has(jj) && x && typeof x === "object" &&
          rowKey(x as never, row as never) === rowKey(row as never, x as never));
        if (j < 0) { out.push({ path: `${path}{${k}}`, php: "presente", ts: "ausente" }); return; }
        used.add(j);
        compare(row, bArr[j], `${path}{${k}}`, out, ignore);
      });
    } else a.forEach((x, i) => compare(x, bArr[i], `${path}[${i}]`, out, ignore));
    return;
  }
  if (typeof a === "object") {
    const bo = (alignObject(a as Record<string, unknown>, b) ?? b ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
      if (!(k in bo)) continue;
      compare(v, bo[k], `${path}.${k}`, out, ignore);
    }
  }
}

// ------------------------------------------------------------ execução
// --snapshot: os dados lidos do banco do MAVI (cs_snapshot) depois da
// importação; os ids do MAVI (uuid) voltam aos do dash antigo para comparar.
const snapPath = arg("snapshot");
const data = snapPath ? (JSON.parse(readFileSync(snapPath, "utf8")) as CsData) : dumpToData(dump, gab.today);
if (snapPath) data.today = gab.today;
const back = new Map<string, number>();
const squadUuid = new Map<string, string>();
if (snapPath) {
  for (const s of dump.squads) {
    const m = data.squads.find((x) => x.name === s.nome);
    if (m) { back.set(m.id, Number(s.id)); squadUuid.set(String(s.id), m.id); }
  }
  for (const c of dump.clientes) {
    const m = data.clients.find((x) => x.external_id === c.id_externo);
    if (m) back.set(m.id, Number(c.id));
  }
}
const idStr = (k: string) => {
  if (back.has(k)) return String(back.get(k));
  const m = /^squad_(.+)$/.exec(k);
  return m && back.has(m[1]) ? `squad_${back.get(m[1])}` : k;
};
const toPhpIds = (v: unknown): unknown =>
  !snapPath ? v : typeof v === "string" ? (back.has(v) ? back.get(v) : idStr(v)) : Array.isArray(v) ? v.map(toPhpIds)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [idStr(k), toPhpIds(x)])) : v;
const e = new CsEngine(data);
const sqOf = (k: string) => (k === "all" ? null : snapPath ? squadUuid.get(k) ?? k : k);
const IGNORE = new Set<string>([
  // métricas que não existem mais / são HTML de layout
]);
const results = new Map<string, { checks: number; diffs: Diff[] }>();
const run = (name: string, php: unknown, fn: () => unknown) => {
  if (only && !name.startsWith(only)) return;
  const r = results.get(name.split(" ")[0]) ?? { checks: 0, diffs: [] };
  results.set(name.split(" ")[0], r);
  r.checks++;
  if (php && typeof php === "object" && "__error" in (php as object)) return;
  try {
    compare(php, toPhpIds(fn()), name, r.diffs, IGNORE);
  } catch (err) {
    r.diffs.push({ path: name, php: "ok", ts: `ERRO: ${(err as Error).message}` });
  }
};
for (const [k, blk] of Object.entries(gab.monthly as Record<string, Record<string, unknown>>)) {
  const [ym, sq] = k.split("|");
  const f = { mes_ref: `${ym}-01`, squad_id: sqOf(sq), dim: "tudo" as const };
  run(`kpi ${k}`, blk.kpi, () => kpiStripData(e, f));
  run(`kpi_trial ${k}`, blk.kpi_trial, () => kpiStripData(e, { ...f, dim: "trial" }));
  run(`kpi_base ${k}`, blk.kpi_base, () => kpiStripData(e, { ...f, dim: "base" }));
  run(`fin ${k}`, blk.fin, () => financeiroData(e, f));
  run(`fin_trial ${k}`, blk.fin_trial, () => financeiroData(e, { ...f, dim: "trial" }));
  run(`pr ${k}`, blk.pr, () => provavelRecebidoData(e, f));
  run(`saude ${k}`, blk.saude, () => saudeData(e, f));
  run(`trial ${k}`, blk.trial, () => trialDataMensal(e, f));
  run(`churn ${k}`, blk.churn, () => churnDataMensal(e, f));
  run(`prev ${k}`, blk.prev, () => previsibilidadeData(e, f, `${ym}-15`));
  run(`squads ${k}`, blk.squads, () => squadsData(e, f));
  run(`insights ${k}`, blk.insights, () => gerarInsights(e, f));
  run(`trocas ${k}`, blk.trocas, () => trocasSquadMes(e, f.mes_ref, f.squad_id));
}
for (const [k, r] of Object.entries(gab.rec as Record<string, unknown>)) {
  const [ym, sq] = k.split("|");
  run(`rec ${k}`, r, () => recPlanejamento(e, { mes_ref: `${ym}-01`, squad_id: sqOf(sq) }));
}
for (const [k, r] of Object.entries(gab.rank as Record<string, unknown>)) run(`rank ${k}`, r, () => rankingSquadsData(e, `${k}-01`));
for (const [k, blk] of Object.entries(gab.period as Record<string, Record<string, unknown>>)) {
  const [ym, , sq] = k.split("|");
  const meses = blk.meses as string[];
  const f = { mes_ref: `${ym}-01`, squad_id: sqOf(sq), dim: "tudo" as const, modo: "anual" as const };
  run(`p_kpi ${k}`, blk.kpi, () => kpiStripPeriodoData(e, f, meses));
  run(`p_fin ${k}`, blk.fin, () => financeiroData(e, f, meses));
  run(`p_pr ${k}`, blk.pr, () => provavelRecebidoData(e, f, meses));
  run(`p_saude ${k}`, blk.saude, () => saudeData(e, f, meses));
  run(`p_trial ${k}`, blk.trial, () => trialDataAnual(e, f, meses));
  run(`p_churn ${k}`, blk.churn, () => churnDataAnual(e, f, meses));
  run(`p_squads ${k}`, blk.squads, () => squadsData(e, f, meses));
  run(`p_evol ${k}`, blk.evol, () => evolucaoMensalData(e, f, meses));
  run(`p_tend ${k}`, blk.tend, () => tendenciaHsData(e, f, meses));
  run(`p_melhor ${k}`, blk.melhor, () => melhorSquadPorMesData(e, f, meses));
  run(`p_mens ${k}`, blk.mens, () => mensalidadesResumo(e, meses, f.squad_id));
}
for (const [k, r] of Object.entries(gab.dd as Record<string, unknown>)) {
  const [met, a, b, c] = k.split("|");
  const [name, extra] = met.split(":");
  const p = c === undefined
    ? { mes: a, squad: sqOf(b), ...(name === "hs_faixa" ? { faixa: extra } : name === "trial_squad" ? { metrica: extra } : {}) }
    : (() => {
      const meses = (gab.period[`${a}|${b}|${c}`] as { meses: string[] }).meses;
      return { mes_ini: meses[0].slice(0, 7), mes_fim: meses[meses.length - 1].slice(0, 7), squad: sqOf(c) };
    })();
  run(`dd_${name} ${k}`, r, () => drilldownRun(e, name, p));
}

let total = 0;
for (const [name, r] of [...results].sort()) {
  total += r.diffs.length;
  console.log(`${r.diffs.length ? "✗" : "✓"} ${name.padEnd(28)} ${String(r.checks).padStart(4)} conferências, ${r.diffs.length} diferenças`);
  for (const d of r.diffs.slice(0, verbose ? 40 : 4))
    console.log(`    ${d.path}: php=${JSON.stringify(d.php)?.slice(0, 120)} ts=${JSON.stringify(d.ts)?.slice(0, 120)}`);
}
console.log(`\n${total} diferenças no total (hoje do gabarito: ${gab.today}).`);
process.exitCode = total ? 1 : 0;

/**
 * Customer Success (migração 20270520090000): a leitura da planilha mestre
 * de CS do Google. Porta das regras do dash antigo
 * (cs-make-dashboard/dash/lib/sheets-parser.php e sync-planilha.php).
 *
 * Aqui só se lê e se normaliza cada linha; o banco (cs_sync_store) faz o
 * resto: reconhece os squads, liga cada linha ao cliente, grava só o que
 * mudou e remove o que sumiu da planilha, com as salvaguardas.
 *
 * As abas são reconhecidas pelo banner da linha 1 (não pelo nome):
 *  - "📅 LANÇAMENTO MMM AAAA": ciclos do mês (cabeçalho na linha 3);
 *  - "🔵 HEALTH SCORE MMM AAAA": Health Score do mês (cabeçalho na linha 3);
 *  - "...METAS...": metas por squad e mês; "...EVENTOS...": pares antigos de
 *    churn/reativação;
 *  - a aba Clientes: cabeçalho com "ID" e "Nome" (ou "Nome" + "DataEntrada"
 *    com a célula do ID apagada) numa das 3 primeiras linhas;
 *  - modelos ("TEMPLATE"), históricos e instruções são ignorados.
 */

export type CsTabKind =
  | "clients"
  | "cycles"
  | "hs"
  | "goals"
  | "events"
  | "template"
  | "history"
  | "instructions"
  | "empty"
  | "unknown";

export type CsTab = {
  gid: string;
  name: string;
  kind: CsTabKind;
  month: string | null;
  rows: number;
  /** Mês com duas abas: não foi lido. */
  duplicate?: boolean;
};

export type CsClientRow = {
  external_id: string;
  name: string;
  squad: string;
  vertical: string | null;
  origin: "comercial" | "reativacao" | "troca" | null;
  kind: "TRIAL" | "BASE" | "BASE_RA";
  trial_month: number | null;
  status: "ATIVO" | "MAKE_IN" | "INATIVO";
  entry_date: string;
  churn_date: string | null;
  reactivation_date: string | null;
  churn_reason: ChurnReason | null;
  notes: string | null;
};

export type CsPayment = { ord: number; date: string; amount: number };

export type CsCycleRow = {
  external_id: string;
  squad: string | null;
  start_date: string | null;
  end_date: string | null;
  billing_date: string | null;
  best: number;
  probable: number;
  probability: "ALTA" | "PROVAVEL" | "BAIXA";
  paid: number;
  paid_date: string | null;
  status: "PAGO" | "PARCIAL" | "PENDENTE" | "PERDA" | "ISENTO";
  adimplencia: "ADIMPLENTE" | "INADIMPLENTE" | "PERDA";
  acl: boolean;
  acl_value: number | null;
  fee_planned: number | null;
  fee_paid: number | null;
  payments: CsPayment[];
};

export type CsHsRow = {
  external_id: string;
  /** Linha presente mas sem avaliação: mantém o que havia. */
  empty: boolean;
  creatives: boolean;
  meeting: boolean;
  payment: boolean;
  perception: boolean;
  goal: boolean;
  manual_score: number | null;
  collection: number | null;
  notes: string | null;
};

export type CsGoalRow = {
  squad: string;
  month: string;
  revenue: number;
  retention_pct: number | null;
  ticket: number | null;
  notes: string | null;
};

export type CsEventRow = {
  external_id: string;
  kind: "CHURN" | "REATIVACAO";
  date: string;
  churn_reason: ChurnReason | null;
};

export type CsPayload = {
  tabs: CsTab[];
  warnings: string[];
  clients: CsClientRow[];
  cycles: { month: string; rows: CsCycleRow[] }[];
  hs: { month: string; rows: CsHsRow[] }[];
  goals: CsGoalRow[];
  /** null: a planilha não tem a aba EVENTOS (nada é removido). */
  events: CsEventRow[] | null;
  meta: Record<string, unknown>;
};

export type ChurnReason = "performance" | "financeiro" | "fechou" | "estrategia";

// ------------------------------------------------------------ CSV
/** CSV do Google (RFC 4180: aspas, aspas dobradas, quebra de linha dentro). */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ------------------------------------------------------------ valores
const MONTHS: Record<string, number> = {
  JAN: 1, FEV: 2, MAR: 3, ABR: 4, MAI: 5, JUN: 6, JUL: 7, AGO: 8, SET: 9, OUT: 10, NOV: 11, DEZ: 12,
  JANEIRO: 1, FEVEREIRO: 2, "MARÇO": 3, MARCO: 3, ABRIL: 4, MAIO: 5, JUNHO: 6, JULHO: 7, AGOSTO: 8,
  SETEMBRO: 9, OUTUBRO: 10, NOVEMBRO: 11, DEZEMBRO: 12,
};

const iso = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const monthIso = (y: number, m: number) => iso(y, m, 1);

function validDate(y: number, m: number, d: number) {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Data da planilha: DD/MM/AAAA (dia e mês com 1 ou 2 dígitos) ou AAAA-MM-DD.
 * Vazio ou "-": null. `bad` recebe o texto que parecia data mas não existe
 * (31/02), que o dash antigo deixava passar e o banco recusaria.
 */
export function parseDate(s: string | undefined | null, bad?: (raw: string) => void): string | null {
  const v = (s ?? "").trim();
  if (v === "" || v === "-") return null;
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (m) {
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (validDate(y, mo, d)) return iso(y, mo, d);
    bad?.(v);
    return null;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (validDate(y, mo, d)) return v;
    bad?.(v);
    return null;
  }
  return null;
}

/** Igual ao (float) do PHP: o número do começo do texto, senão 0. */
function phpFloat(s: string) {
  const m = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(s.trim());
  return m ? Number(m[0]) : 0;
}

/**
 * Valor em reais como o dash antigo lia (sp_parse_money): "R$ 3.000,00",
 * "3000", "1500.00", "4.000" (milhar). Vazio ou "-": 0.
 */
export function parseMoney(s: string | undefined | null): number {
  let v = (s ?? "").trim();
  if (v === "" || v === "-") return 0;
  v = v.replace(/R\$/g, "").replace(/[\s ]/g, "");
  if (v.includes(",")) v = v.replace(/\./g, "").replace(",", ".");
  else {
    const dots = (v.match(/\./g) ?? []).length;
    if (dots > 1) v = v.replace(/\./g, "");
    else if (dots === 1 && v.split(".")[1].length >= 3) v = v.replace(".", "");
  }
  return Math.round(phpFloat(v) * 100) / 100;
}

export function parseIntCell(s: string | undefined | null): number | null {
  const v = (s ?? "").trim();
  return /^\d+$/.test(v) ? Number(v) : null;
}

/** Cabeçalho comparável: minúsculas, sem acento, sem espaço nem símbolo. */
export function normHeader(h: string) {
  return h
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export function normalizeOrigin(s: string): CsClientRow["origin"] {
  const v = s.trim().toLowerCase();
  if (v.startsWith("reativ")) return "reativacao";
  if (v.startsWith("troca")) return "troca";
  if (v.startsWith("comerc")) return "comercial";
  return null;
}

export function normalizeChurnReason(s: string): ChurnReason | null {
  const v = s.trim().toLowerCase();
  if (v.includes("performance")) return "performance";
  if (v.includes("financeiro") || v.includes("inadiml")) return "financeiro";
  if (v.includes("fechou") || v.includes("pivot")) return "fechou";
  if (v.includes("estrat")) return "estrategia";
  return null;
}

const upper = (s: string | undefined) => (s ?? "").trim().toUpperCase();
const text = (s: string | undefined) => {
  const v = (s ?? "").trim();
  return v === "" ? null : v;
};
const brl = (n: number) =>
  n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const monthLabel = (month: string) => `${month.slice(5, 7)}/${month.slice(0, 4)}`;

/** Índice das colunas: nome exato primeiro, depois o comparável. */
function columns(header: string[]) {
  const exact = new Map<string, number>();
  const loose = new Map<string, number>();
  header.forEach((h, i) => {
    const t = h.trim();
    if (t && !exact.has(t)) exact.set(t, i);
    const k = normHeader(h);
    if (k && !loose.has(k)) loose.set(k, i);
  });
  return (name: string): number | null => exact.get(name) ?? loose.get(normHeader(name)) ?? null;
}

// ------------------------------------------------------------ abas
/** O tipo de cada aba pelo banner (linha 1) ou pelo cabeçalho. */
export function classifyTab(rows: string[][], name = ""): { kind: CsTabKind; month: string | null; headerRow?: number } {
  if (!rows.length || rows.every((r) => r.every((c) => c.trim() === "")))
    return { kind: "empty", month: null };
  const banner = (rows[0][0] ?? "").trim();
  const up = banner.toUpperCase();
  if (banner.includes("TEMPLATE")) return { kind: "template", month: null };
  if (up.includes("HISTÓRICO") || up.includes("HISTORICO")) return { kind: "history", month: null };
  let m = /LAN[ÇC]AMENTO\s+([A-ZÇÃ]+)\s+(\d{4})/u.exec(up);
  if (m && MONTHS[m[1]]) return { kind: "cycles", month: monthIso(Number(m[2]), MONTHS[m[1]]) };
  m = /HEALTH\s+SCORE\s+([A-ZÇÃ]+)\s+(\d{4})/u.exec(up);
  if (m && MONTHS[m[1]]) return { kind: "hs", month: monthIso(Number(m[2]), MONTHS[m[1]]) };
  if (up.includes("METAS")) return { kind: "goals", month: null };
  if (up.includes("EVENTOS")) return { kind: "events", month: null };
  for (let i = 0; i < Math.min(3, rows.length); i++) {
    const line = rows[i].map((c) => c.trim());
    const [a, b] = [line[0] ?? "", line[1] ?? ""];
    if ((a === "ID" && b === "Nome") || (b === "Nome" && a !== "IDCliente" && line.includes("DataEntrada")))
      return { kind: "clients", month: null, headerRow: i };
  }
  // A aba de instruções do modelo da planilha (o dash antigo avisava a cada
  // leitura que não a reconhecia).
  const tab = name.trim().toUpperCase();
  if (tab.startsWith("INSTRU") || up.includes("PLANILHA MESTRE")) return { kind: "instructions", month: null };
  return { kind: "unknown", month: null };
}

// ------------------------------------------------------------ cada tipo
function readClients(rows: string[][], headerRow: number, warn: (w: string) => void): CsClientRow[] {
  if (rows.length <= headerRow + 1) return [];
  const col = columns(rows[headerRow]);
  let idCol = col("ID");
  if (idCol === null) {
    idCol = 0;
    warn("Aba Clientes: cabeçalho 'ID' não encontrado — usando a coluna A como ID. Escreva 'ID' na primeira célula do cabeçalho da planilha.");
  }
  const cell = (row: string[], name: string) => {
    const i = col(name);
    return i === null ? "" : row[i] ?? "";
  };
  const out: CsClientRow[] = [];
  for (const row of rows.slice(headerRow + 1)) {
    const id = (row[idCol] ?? "").trim();
    if (!/^\d+$/.test(id)) continue;
    const name = cell(row, "Nome").trim();
    if (!name) continue;
    const where = `Cliente ${id} (${name})`;
    const badDate = (raw: string) => warn(`${where}: data inválida "${raw}", ignorada.`);
    const kindRaw = upper(cell(row, "Tipo") || "BASE");
    let status = upper(cell(row, "Status") || "ATIVO");
    if (status === "MAKE IN") status = "MAKE_IN";
    const trialRaw = cell(row, "MesTrial");
    const trial = parseIntCell(trialRaw);
    out.push({
      external_id: id,
      name,
      squad: cell(row, "Squad").trim(),
      vertical: text(cell(row, "Vertical")),
      origin: normalizeOrigin(cell(row, "Origem")),
      kind: (["BASE", "TRIAL", "BASE_RA"].includes(kindRaw) ? kindRaw : "BASE") as CsClientRow["kind"],
      trial_month: trial !== null && trial <= 120 ? trial : null,
      status: (["ATIVO", "MAKE_IN", "INATIVO"].includes(status) ? status : "ATIVO") as CsClientRow["status"],
      entry_date: parseDate(cell(row, "DataEntrada"), badDate) ?? "2024-01-01",
      churn_date: parseDate(cell(row, "DataChurn"), badDate),
      reactivation_date: parseDate(cell(row, "DataReativacao"), badDate),
      churn_reason: normalizeChurnReason(cell(row, "MotivoChurn")),
      notes: text(cell(row, "Observacoes")),
    });
  }
  return out;
}

const REQUIRED_CYCLE = [
  "IDCliente", "InicioCiclo", "FimCiclo", "DataCobranca", "Melhor", "Provavel", "Probabilidade",
  "ValorPago", "DataPagamento", "Status", "Adimplencia",
];
const ACL_WHOLE = new Set(["x", "sim", "s", "1", "acl", "true", "yes"]);
const ACL_NONE = new Set(["", "0", "não", "nao", "n", "false"]);

function readCycles(rows: string[][], month: string, warn: (w: string) => void): CsCycleRow[] | null {
  const label = monthLabel(month);
  if (rows.length < 4) return [];
  const col = columns(rows[2]);
  for (const r of REQUIRED_CYCLE)
    if (col(r) === null) {
      warn(`Aba de ciclos ${label}: coluna '${r}' faltando, aba ignorada.`);
      return null;
    }
  const at = (row: string[], name: string) => {
    const i = col(name);
    return i === null ? "" : row[i] ?? "";
  };
  const out: CsCycleRow[] = [];
  for (const row of rows.slice(3)) {
    const id = at(row, "IDCliente").trim();
    if (!/^\d+$/.test(id)) continue;
    const where = `Ciclo ${label} ID ${id}`;
    const badDate = (raw: string) => warn(`${where}: data inválida "${raw}", ignorada.`);
    let paid = parseMoney(at(row, "ValorPago"));
    let paidDate = parseDate(at(row, "DataPagamento"), badDate);
    const probRaw = upper(at(row, "Probabilidade") || "PROVAVEL");
    const statusRaw = upper(at(row, "Status") || "PENDENTE");
    const adimpRaw = upper(at(row, "Adimplencia") || "ADIMPLENTE");

    let acl = false;
    let aclValue: number | null = null;
    if (col("ACL") !== null) {
      const raw = at(row, "ACL").trim().toLowerCase();
      if (ACL_WHOLE.has(raw)) acl = true;
      else if (!ACL_NONE.has(raw)) {
        const v = parseMoney(raw);
        if (v > 0) {
          acl = true;
          aclValue = v;
        } else
          warn(`${where}: coluna ACL com valor não reconhecido ('${raw}'), tratado como NÃO-ACL. Use x (inteiro) ou um valor em R$ (parcial).`);
      }
    }
    const fee = (name: string) => {
      if (col(name) === null) return null;
      const v = parseMoney(at(row, name));
      return v > 0 ? v : null;
    };
    const feePlanned = fee("MensalidadePrevista");
    const feePaid = fee("Mensalidade");

    // Pagamento picado: Pgto1Data/Pgto1Valor ... (até 6). Com parcelas, elas
    // mandam: pago = soma, data do pagamento = a mais antiga.
    const payments: CsPayment[] = [];
    for (let n = 1; n <= 6; n++) {
      const dCol = col(`Pgto${n}Data`);
      const vCol = col(`Pgto${n}Valor`);
      if (dCol === null && vCol === null) continue;
      const d = dCol !== null ? parseDate(row[dCol], badDate) : null;
      const v = vCol !== null ? parseMoney(row[vCol]) : 0;
      if (d && v > 0) payments.push({ ord: n, date: d, amount: v });
      else if (d || v > 0)
        warn(`${where}: Pgto${n}Data/Pgto${n}Valor incompleto (precisa data E valor) — entrada ignorada.`);
    }
    if (payments.length) {
      const sum = Math.round(payments.reduce((s, p) => s + p.amount, 0) * 100) / 100;
      if (paid > 0.01 && Math.abs(paid - sum) > 0.01)
        warn(`${where}: ValorPago (R$ ${brl(paid)}) diverge da soma dos pagamentos (R$ ${brl(sum)}). Valeu a SOMA — corrija o ValorPago ou as parcelas.`);
      const dates = payments.map((p) => p.date);
      const sorted = [...dates].sort();
      if (dates.join() !== sorted.join())
        warn(`${where}: as datas de Pgto1/Pgto2/Pgto3 não estão em ordem crescente — confira a sequência dos pagamentos.`);
      paid = sum;
      paidDate = sorted[0];
    }

    const start = parseDate(at(row, "InicioCiclo"), badDate);
    const end = parseDate(at(row, "FimCiclo"), badDate);
    const billing = parseDate(at(row, "DataCobranca"), badDate);
    const best = parseMoney(at(row, "Melhor"));
    const probable = parseMoney(at(row, "Provavel"));
    const status = (["PAGO", "PARCIAL", "PENDENTE", "PERDA", "ISENTO"].includes(statusRaw)
      ? statusRaw
      : "PENDENTE") as CsCycleRow["status"];
    // Linha vazia: fica fora (e o ciclo, se existia, sai do banco).
    if (best === 0 && probable === 0 && paid === 0 && !payments.length && feePlanned === null &&
      feePaid === null && !start && !end && !billing && status === "PENDENTE")
      continue;
    if (!end && (probable > 0 || best > 0))
      warn(`${where}: FimCiclo vazio — fica fora do calendário de recebimento. Preencha o fim do ciclo.`);
    out.push({
      external_id: id,
      squad: col("Squad") !== null ? text(at(row, "Squad")) : null,
      start_date: start,
      end_date: end,
      billing_date: billing,
      best,
      probable,
      probability: (["ALTA", "PROVAVEL", "BAIXA"].includes(probRaw) ? probRaw : "PROVAVEL") as CsCycleRow["probability"],
      paid,
      paid_date: paidDate,
      status,
      adimplencia: (["ADIMPLENTE", "INADIMPLENTE", "PERDA"].includes(adimpRaw)
        ? adimpRaw
        : "ADIMPLENTE") as CsCycleRow["adimplencia"],
      acl,
      acl_value: aclValue,
      fee_planned: feePlanned,
      fee_paid: feePaid,
      payments,
    });
  }
  return out;
}

function readHs(rows: string[][], month: string, warn: (w: string) => void): CsHsRow[] | null {
  const label = monthLabel(month);
  if (rows.length < 4) return [];
  const col = columns(rows[2]);
  for (const r of ["IDCliente", "ScorePct"])
    if (col(r) === null) {
      warn(`Aba de Health Score ${label}: coluna '${r}' faltando, aba ignorada.`);
      return null;
    }
  const at = (row: string[], name: string) => {
    const i = col(name);
    return i === null ? "" : row[i] ?? "";
  };
  const yes = (row: string[], name: string) => upper(at(row, name)) === "S";
  const out: CsHsRow[] = [];
  for (const row of rows.slice(3)) {
    const id = at(row, "IDCliente").trim();
    if (!/^\d+$/.test(id)) continue;
    const scoreRaw = at(row, "ScorePct").trim();
    let score = phpFloat(scoreRaw.replace(/%/g, "").replace(/,/g, "."));
    if (score < 0 || score > 100) {
      warn(`Health Score ${label} ID ${id}: ScorePct "${scoreRaw}" fora de 0 a 100, ignorado.`);
      score = 0;
    }
    const crit = {
      creatives: yes(row, "Criativos"),
      meeting: yes(row, "Reuniao"),
      payment: yes(row, "Pagamento"),
      perception: yes(row, "Percepcao"),
      goal: yes(row, "Meta"),
    };
    const any = Object.values(crit).some(Boolean);
    const collection = parseIntCell(at(row, "Coleta"));
    out.push({
      external_id: id,
      empty: score === 0 && !any,
      ...crit,
      manual_score: score > 0 ? score : null,
      collection: collection !== null && collection >= 1 && collection <= 9 ? collection : null,
      notes: text(at(row, "Observacoes")),
    });
  }
  return out;
}

function readGoals(rows: string[][], warn: (w: string) => void): CsGoalRow[] {
  if (rows.length < 4) return [];
  const col = columns(rows[2]);
  for (const r of ["Squad", "Ano", "Mês", "MetaFaturamento"])
    if (col(r) === null) {
      warn(`Aba Metas: coluna '${r}' faltando, aba ignorada.`);
      return [];
    }
  const at = (row: string[], name: string) => {
    const i = col(name);
    return i === null ? "" : row[i] ?? "";
  };
  const out: CsGoalRow[] = [];
  for (const row of rows.slice(3)) {
    const squad = at(row, "Squad").trim();
    const year = at(row, "Ano").trim();
    const month = MONTHS[at(row, "Mês").trim().toUpperCase()];
    const revenue = parseMoney(at(row, "MetaFaturamento"));
    if (!squad || !/^\d{4}$/.test(year) || !month || revenue <= 0) continue;
    const retention = parseMoney(at(row, "MetaRetencaoPct"));
    const ticket = parseMoney(at(row, "MetaTicket"));
    out.push({
      squad,
      month: monthIso(Number(year), month),
      revenue,
      retention_pct: retention ? retention : null,
      ticket: ticket > 0 ? ticket : null,
      notes: text(at(row, "Observacoes")),
    });
  }
  return out;
}

function readEvents(rows: string[][], warn: (w: string) => void): CsEventRow[] | null {
  if (rows.length < 3) return [];
  const col = columns(rows[2] ?? []);
  for (const r of ["IDCliente", "Tipo", "Data"])
    if (col(r) === null) {
      warn(`Aba Eventos: coluna '${r}' faltando, aba ignorada.`);
      return null;
    }
  const at = (row: string[], name: string) => {
    const i = col(name);
    return i === null ? "" : row[i] ?? "";
  };
  const out: CsEventRow[] = [];
  for (const row of rows.slice(3)) {
    const id = at(row, "IDCliente").trim();
    if (!/^\d+$/.test(id)) continue;
    const kindRaw = at(row, "Tipo").trim().toLowerCase();
    const kind = kindRaw.startsWith("churn") ? "CHURN" : kindRaw.startsWith("reativ") ? "REATIVACAO" : null;
    if (!kind) {
      if (kindRaw) warn(`Evento ID ${id}: Tipo '${kindRaw}' inválido (use CHURN ou REATIVACAO), ignorado.`);
      continue;
    }
    const date = parseDate(at(row, "Data"));
    if (!date) {
      warn(`Evento ID ${id} (${kind}): Data inválida ou vazia, ignorado.`);
      continue;
    }
    out.push({
      external_id: id,
      kind,
      date,
      churn_reason: col("Motivo") !== null ? normalizeChurnReason(at(row, "Motivo")) : null,
    });
  }
  return out;
}

// ------------------------------------------------------------ a planilha
export type SheetTabInput = { gid: string; name: string; rows: string[][] };

/** Lê todas as abas e monta o que vai para o banco (cs_sync_store). */
export function buildPayload(tabs: SheetTabInput[]): CsPayload {
  const warnings: string[] = [];
  const warn = (w: string) => warnings.push(w);
  const classified = tabs.map((t) => ({ ...t, ...classifyTab(t.rows, t.name) }));

  // Duas abas para o mesmo mês: a segunda sobrescreveria a primeira em
  // silêncio (Ago/26 perdeu todos os pagamentos assim). O mês não é lido.
  const dup = new Set<string>();
  for (const kind of ["cycles", "hs"] as const) {
    const byMonth = new Map<string, typeof classified>();
    for (const t of classified)
      if (t.kind === kind && t.month) byMonth.set(t.month, [...(byMonth.get(t.month) ?? []), t]);
    for (const [month, list] of byMonth)
      if (list.length > 1) {
        dup.add(`${kind}:${month}`);
        warn(`⚠️ ATENÇÃO: ${monthLabel(month)} tem ${list.length} abas de ${kind === "cycles" ? "LANÇAMENTO" : "HEALTH SCORE"} (${list.map((t) => `"${t.name}"`).join(", ")}). Esse mês NÃO foi lido para não sobrescrever os dados bons com os da aba errada. Causa provável: aba nova criada duplicando outra sem trocar o banner da linha 1.`);
      }
  }

  const payload: CsPayload = {
    tabs: [],
    warnings,
    clients: [],
    cycles: [],
    hs: [],
    goals: [],
    events: null,
    meta: {},
  };
  for (const t of classified) {
    const duplicate = !!t.month && dup.has(`${t.kind}:${t.month}`);
    payload.tabs.push({
      gid: t.gid,
      name: t.name,
      kind: t.kind,
      month: t.month,
      rows: t.rows.length,
      ...(duplicate ? { duplicate } : {}),
    });
    if (duplicate) continue;
    if (t.kind === "unknown")
      warn(`Aba "${t.name || t.gid}" NÃO RECONHECIDA e ignorada (linha 1: '${(t.rows[0]?.[0] ?? "").slice(0, 60)}'). Se for uma aba que deveria ser lida, confira o banner/cabeçalho dela.`);
    else if (t.kind === "clients") payload.clients.push(...readClients(t.rows, t.headerRow ?? 0, warn));
    else if (t.kind === "cycles" && t.month) {
      const rows = readCycles(t.rows, t.month, warn);
      if (rows) payload.cycles.push({ month: t.month, rows });
    } else if (t.kind === "hs" && t.month) {
      const rows = readHs(t.rows, t.month, warn);
      if (rows) payload.hs.push({ month: t.month, rows });
    } else if (t.kind === "goals") payload.goals.push(...readGoals(t.rows, warn));
    else if (t.kind === "events") {
      const rows = readEvents(t.rows, warn);
      if (rows) payload.events = [...(payload.events ?? []), ...rows];
    }
  }
  return payload;
}

// ------------------------------------------------------------ Google
const SHEET_ID = /^[A-Za-z0-9_-]{20,100}$/;

/** As abas visíveis da planilha (nome e gid), pela página htmlview. */
export function sheetTabsFromHtml(html: string): { gid: string; name: string }[] {
  const out: { gid: string; name: string }[] = [];
  const seen = new Set<string>();
  const re = /items\.push\(\{name:\s*"((?:[^"\\]|\\.)*)",\s*pageUrl:\s*"[^"]*?gid=(\d+)/g;
  for (const m of html.matchAll(re)) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    let name = m[1];
    try {
      name = JSON.parse(`"${m[1]}"`);
    } catch {
      /* fica como veio */
    }
    out.push({ gid: m[2], name });
  }
  if (out.length) return out;
  // Sem a lista (a página mudou): os gids que aparecerem, como o dash antigo.
  for (const m of html.matchAll(/gid=(\d+)/g))
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push({ gid: m[1], name: "" });
    }
  return out;
}

export const NOT_PUBLIC =
  "Não consegui abrir a planilha. Confira se ela está compartilhada como \"Qualquer pessoa com o link pode ver\".";

/**
 * Baixa a planilha inteira: a lista de abas e o CSV de cada uma (4 por vez,
 * com uma nova tentativa). Qualquer aba que falhe derruba a leitura: gravar
 * com uma aba faltando faria o banco achar que ela sumiu.
 */
export async function downloadSheet(
  sheetId: string,
  fetchImpl: typeof fetch,
  timeoutMs = 15_000,
): Promise<SheetTabInput[]> {
  if (!SHEET_ID.test(sheetId)) throw new Error("ID da planilha inválido.");
  const base = `https://docs.google.com/spreadsheets/d/${sheetId}`;
  const get = async (url: string) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetchImpl(url, {
          redirect: "follow",
          signal: AbortSignal.timeout(timeoutMs),
          headers: { "User-Agent": "MAVI-CS/1.0 (+sheets-sync)" },
        });
        const body = await res.text();
        if (res.ok) return { body, type: res.headers.get("content-type") ?? "" };
        if (attempt >= 1 || res.status < 500) return { body: "", type: "", status: res.status };
      } catch (e) {
        if (attempt >= 1) throw e;
      }
    }
  };
  const view = await get(`${base}/htmlview`);
  const list = view.body ? sheetTabsFromHtml(view.body) : [];
  if (!list.length) throw new Error(NOT_PUBLIC);
  const out: SheetTabInput[] = [];
  for (let i = 0; i < list.length; i += 4) {
    const batch = await Promise.all(
      list.slice(i, i + 4).map(async (t) => {
        const r = await get(`${base}/export?format=csv&gid=${t.gid}`);
        if (!r.body && "status" in r)
          throw new Error(`Não consegui baixar a aba "${t.name || t.gid}" (HTTP ${r.status}). Nada foi gravado; a próxima leitura tenta de novo.`);
        if (/text\/html/i.test(r.type)) throw new Error(NOT_PUBLIC);
        return { ...t, rows: parseCsv(r.body) };
      }),
    );
    out.push(...batch);
  }
  return out;
}

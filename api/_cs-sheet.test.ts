import { describe, expect, it } from "vitest";
import {
  buildPayload,
  classifyTab,
  downloadSheet,
  NOT_PUBLIC,
  parseCsv,
  parseDate,
  parseMoney,
  sheetTabsFromHtml,
} from "./_cs-sheet";
import { handleCsSync } from "./_cs-sync";

const csv = (rows: (string | number)[][]) =>
  rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(",")).join("\n");

const CYCLE_HEADER = [
  "IDCliente", "Nome", "InicioCiclo", "FimCiclo", "DataCobranca", "Melhor", "Provavel", "Probabilidade",
  "Pgto1Data", "Pgto1Valor", "Pgto2 Data", "PGTO2VALOR", "ValorPago", "DataPagamento", "Status", "Adimplencia",
  "ACL", "MensalidadePrevista", "Mensalidade", "Squad",
];
const cycleTab = (banner: string, rows: string[][]) => [
  [banner], ["Cada linha é um cliente."], CYCLE_HEADER, ...rows,
];
const CLIENTS = [
  ["ID", "Nome", "Squad", "Vertical", "Origem", "Tipo", "MesTrial", "Status", "DataEntrada", "DataChurn", "DataReativacao", "MotivoChurn", "Observacoes"],
  ["4862", " MaqFlex ", "Tão Tão Perto", "", "Comercial", "trial", "2", "MAKE IN", "31/03/2026", "", "", "", ""],
  ["4690", "Nexus", "Tão Tão Perto", "Indústria", "Reativação", "BASE_RA", "", "INATIVO", "1/12/2025", "30/08/2026", "16/07/2026", "Mudança de estratégia interna", "obs"],
  ["abc", "Linha de total", "", "", "", "", "", "", "", "", "", "", ""],
  ["5000", "", "", "", "", "", "", "", "", "", "", "", ""],
  ["5001", "Data errada", "Primogênito", "", "Troca", "XYZ", "", "", "31/02/2026", "", "", "Financeiro / inadimplência", ""],
];

describe("valores da planilha", () => {
  it("lê dinheiro como o dash antigo", () => {
    expect(parseMoney("R$ 3.000,00")).toBe(3000);
    expect(parseMoney("R$ 3.000")).toBe(3000);
    expect(parseMoney("1500")).toBe(1500);
    expect(parseMoney("1500.50")).toBe(1500.5);
    expect(parseMoney("4.000")).toBe(4000);
    expect(parseMoney("1.234.567")).toBe(1234567);
    expect(parseMoney("R$ 2.250,00")).toBe(2250);
    expect(parseMoney("")).toBe(0);
    expect(parseMoney("-")).toBe(0);
    expect(parseMoney("abc")).toBe(0);
  });
  it("lê datas e recusa as que não existem", () => {
    const bad: string[] = [];
    expect(parseDate("5/9/2026")).toBe("2026-09-05");
    expect(parseDate("2026-09-30")).toBe("2026-09-30");
    expect(parseDate("31/02/2026", (r) => bad.push(r))).toBeNull();
    expect(parseDate("29/02/2028")).toBe("2028-02-29");
    expect(parseDate("")).toBeNull();
    expect(parseDate("amanhã")).toBeNull();
    expect(bad).toEqual(["31/02/2026"]);
  });
  it("CSV com aspas, aspas dobradas e quebra de linha", () => {
    expect(parseCsv('﻿a,"b,c","d ""e""",\n"x\ny",z\r\n')).toEqual([
      ["a", "b,c", 'd "e"', ""],
      ["x\ny", "z"],
    ]);
  });
});

describe("abas", () => {
  it("reconhece cada aba pelo banner ou pelo cabeçalho", () => {
    expect(classifyTab([["📅 LANÇAMENTO SET 2026"]])).toEqual({ kind: "cycles", month: "2026-09-01" });
    expect(classifyTab([["📅 LANCAMENTO MARÇO 2026"]])).toEqual({ kind: "cycles", month: "2026-03-01" });
    expect(classifyTab([["🔵 HEALTH SCORE OUT 2026"]])).toEqual({ kind: "hs", month: "2026-10-01" });
    expect(classifyTab([["📋 TEMPLATE HS — DUPLIQUE"]]).kind).toBe("template");
    expect(classifyTab([["⬜ CICLOS · HISTÓRICO"]]).kind).toBe("history");
    expect(classifyTab([["🟡 METAS POR SQUAD POR MÊS"]]).kind).toBe("goals");
    expect(classifyTab([["🗂 EVENTOS — CHURNS"]]).kind).toBe("events");
    expect(classifyTab(CLIENTS).kind).toBe("clients");
    // A célula do ID apagada não pode esconder a aba Clientes.
    expect(classifyTab([["x"], ["", "Nome", "Squad", "DataEntrada"]])).toEqual({ kind: "clients", month: null, headerRow: 1 });
    expect(classifyTab([["Dashboard CS Make — Planilha Mestre"]], "INSTRUÇÕES").kind).toBe("instructions");
    expect(classifyTab([["Outra coisa"]], "Rascunho").kind).toBe("unknown");
    expect(classifyTab([[""], [""]]).kind).toBe("empty");
  });
  it("lista as abas visíveis da página da planilha", () => {
    const html =
      'items.push({name: "INSTRU\\u00c7\\u00d5ES", pageUrl: "https://docs.google.com/x/htmlview/sheet?headers=true&gid=871948398", gid: "871948398"});' +
      'items.push({name: "Ciclos · Out 2026", pageUrl: "https://x/sheet?gid=1387045913"});';
    expect(sheetTabsFromHtml(html)).toEqual([
      { gid: "871948398", name: "INSTRUÇÕES" },
      { gid: "1387045913", name: "Ciclos · Out 2026" },
    ]);
    expect(sheetTabsFromHtml("<a href='#gid=5'></a><a href='#gid=5'></a><b gid=7>")).toEqual([
      { gid: "5", name: "" },
      { gid: "7", name: "" },
    ]);
  });
});

describe("buildPayload", () => {
  it("lê os clientes com as normalizações do dash antigo", () => {
    const p = buildPayload([{ gid: "1", name: "Clientes", rows: CLIENTS }]);
    expect(p.clients.map((c) => c.external_id)).toEqual(["4862", "4690", "5001"]);
    expect(p.clients[0]).toMatchObject({
      name: "MaqFlex", squad: "Tão Tão Perto", origin: "comercial", kind: "TRIAL", trial_month: 2,
      status: "MAKE_IN", entry_date: "2026-03-31",
    });
    expect(p.clients[1]).toMatchObject({
      origin: "reativacao", kind: "BASE_RA", status: "INATIVO", entry_date: "2025-12-01",
      churn_date: "2026-08-30", reactivation_date: "2026-07-16", churn_reason: "estrategia", vertical: "Indústria",
    });
    expect(p.clients[2]).toMatchObject({ origin: "troca", kind: "BASE", entry_date: "2024-01-01", churn_reason: "financeiro" });
    expect(p.warnings).toEqual(['Cliente 5001 (Data errada): data inválida "31/02/2026", ignorada.']);
  });

  it("lê ciclos: parcelas mandam, ACL inteiro ou parcial, mensalidade e linha vazia", () => {
    const p = buildPayload([
      {
        gid: "2", name: "Ciclos · Set 2026",
        rows: cycleTab("📅 LANÇAMENTO SET 2026", [
          ["4486", "Boteco", "31/08/2026", "19/09/2026", "03/09/2026", "R$ 4.500", "R$ 4.500", "ALTA", "22/09/2026", "R$ 2.250,00", "08/09/2026", "R$ 2.250,00", "R$ 4.000,00", "", "PAGO", "ADIMPLENTE", "", "", "", ""],
          ["5022", "Vittalum", "31/08/2026", "30/09/2026", "30/09/2026", "R$ 3.000", "R$ 3.000", "provavel", "", "", "", "", "R$ 3.000,00", "30/09/2026", "PAGO", "ADIMPLENTE", "x", "R$ 1.600", "R$ 1.600", "Eu Resolvo LTDA"],
          ["4456", "Slod", "", "", "", "R$ 10.000", "R$ 10.000", "", "", "", "", "", "", "", "", "", "4000", "", "", ""],
          ["3914", "Biomist", "", "", "", "R$ 0", "R$ 0", "BAIXA", "", "", "", "", "", "", "PENDENTE", "", "", "", "", ""],
          ["3915", "Pela metade", "", "", "", "", "", "", "10/09/2026", "", "", "", "", "", "", "", "talvez", "", "", ""],
        ]),
      },
    ]);
    const rows = p.cycles[0].rows;
    expect(p.cycles[0].month).toBe("2026-09-01");
    // 3914 e 3915 ficam de fora: sem valores, datas nem parcelas completas.
    expect(rows.map((r) => r.external_id)).toEqual(["4486", "5022", "4456"]);
    expect(rows[0]).toMatchObject({ paid: 4500, paid_date: "2026-09-08", probability: "ALTA" });
    expect(rows[0].payments).toEqual([
      { ord: 1, date: "2026-09-22", amount: 2250 },
      { ord: 2, date: "2026-09-08", amount: 2250 },
    ]);
    expect(rows[1]).toMatchObject({ acl: true, acl_value: null, fee_planned: 1600, fee_paid: 1600, squad: "Eu Resolvo LTDA", probability: "PROVAVEL" });
    expect(rows[2]).toMatchObject({ acl: true, acl_value: 4000, status: "PENDENTE", adimplencia: "ADIMPLENTE", end_date: null });
    expect(p.warnings).toEqual([
      "Ciclo 09/2026 ID 4486: ValorPago (R$ 4.000,00) diverge da soma dos pagamentos (R$ 4.500,00). Valeu a SOMA — corrija o ValorPago ou as parcelas.",
      "Ciclo 09/2026 ID 4486: as datas de Pgto1/Pgto2/Pgto3 não estão em ordem crescente — confira a sequência dos pagamentos.",
      "Ciclo 09/2026 ID 4456: FimCiclo vazio — fica fora do calendário de recebimento. Preencha o fim do ciclo.",
      "Ciclo 09/2026 ID 3915: coluna ACL com valor não reconhecido ('talvez'), tratado como NÃO-ACL. Use x (inteiro) ou um valor em R$ (parcial).",
      "Ciclo 09/2026 ID 3915: Pgto1Data/Pgto1Valor incompleto (precisa data E valor) — entrada ignorada.",
    ]);
  });

  it("aba de ciclos sem coluna obrigatória é ignorada com aviso", () => {
    const p = buildPayload([{ gid: "2", name: "x", rows: [["📅 LANÇAMENTO OUT 2026"], [""], ["IDCliente", "Nome"], ["1", "a"]] }]);
    expect(p.cycles).toEqual([]);
    expect(p.warnings[0]).toMatch(/coluna 'InicioCiclo' faltando/);
  });

  it("mês com duas abas não é lido", () => {
    const tab = cycleTab("📅 LANÇAMENTO AGO 2026", [["1", "a", "", "31/08/2026", "", "1000", "1000", "", "", "", "", "", "", "", "", "", "", "", "", ""]]);
    const p = buildPayload([
      { gid: "1", name: "Ciclos · Ago 2026", rows: tab },
      { gid: "2", name: "Cópia de Ciclos · Ago 2026", rows: tab },
    ]);
    expect(p.cycles).toEqual([]);
    expect(p.tabs.every((t) => t.duplicate)).toBe(true);
    expect(p.warnings[0]).toMatch(/08\/2026 tem 2 abas de LANÇAMENTO/);
  });

  it("lê Health Score: critérios, nota digitada e linha vazia", () => {
    const p = buildPayload([
      {
        gid: "3", name: "HS · Set 2026",
        rows: [
          ["🔵 HEALTH SCORE SET 2026"], ["Marque"],
          ["IDCliente", "Nome", "Coleta", "ScorePct", "Faixa", "Criativos", "Reuniao", "Pagamento", "Percepcao", "Meta", "Observacoes"],
          ["4486", "Boteco", "1", "70%", "ALERTA", "S", "S", "S", "S", "N", "Sazonalidade"],
          ["3914", "Biomist", "2", "45,5%", "", "", "", "", "", "", ""],
          ["2477", "Grupo CR", "", "", "", "", "", "", "", "", ""],
          ["1", "Fora", "", "150%", "", "", "", "", "", "", ""],
        ],
      },
    ]);
    expect(p.hs[0].rows).toEqual([
      { external_id: "4486", empty: false, creatives: true, meeting: true, payment: true, perception: true, goal: false, manual_score: 70, collection: 1, notes: "Sazonalidade" },
      { external_id: "3914", empty: false, creatives: false, meeting: false, payment: false, perception: false, goal: false, manual_score: 45.5, collection: 2, notes: null },
      { external_id: "2477", empty: true, creatives: false, meeting: false, payment: false, perception: false, goal: false, manual_score: null, collection: null, notes: null },
      { external_id: "1", empty: true, creatives: false, meeting: false, payment: false, perception: false, goal: false, manual_score: null, collection: null, notes: null },
    ]);
    expect(p.warnings).toEqual(['Health Score 09/2026 ID 1: ScorePct "150%" fora de 0 a 100, ignorado.']);
  });

  it("lê metas e eventos", () => {
    const p = buildPayload([
      {
        gid: "4", name: "Metas",
        rows: [
          ["🟡 METAS POR SQUAD POR MÊS"], [""],
          ["Squad", "Ano", "Mês", "MetaFaturamento", "MetaRetencaoPct", "MetaTicket", "Observacoes"],
          ["Primogênito", "2026", "Março", "R$ 150.000,00", "95", "", ""],
          ["Squad 3", "2026", "Outubro", "R$ 0,00", "", "", ""],
          ["Tão Tão Perto", "2026", "Novembro", "", "", "", ""],
        ],
      },
      {
        gid: "5", name: "Eventos",
        rows: [
          ["🗂 EVENTOS — CHURNS/REATIVAÇÕES ANTERIORES"], [""], ["IDCliente", "Tipo", "Data", "Motivo"],
          ["4690", "CHURN", "30/04/2026", "Mudança de estratégia interna"],
          ["4690", "reativação", "16/07/2026", ""],
          ["4691", "outro", "16/07/2026", ""],
          ["4692", "CHURN", "", ""],
        ],
      },
    ]);
    expect(p.goals).toEqual([
      { squad: "Primogênito", month: "2026-03-01", revenue: 150000, retention_pct: 95, ticket: null, notes: null },
    ]);
    expect(p.events).toEqual([
      { external_id: "4690", kind: "CHURN", date: "2026-04-30", churn_reason: "estrategia" },
      { external_id: "4690", kind: "REATIVACAO", date: "2026-07-16", churn_reason: null },
    ]);
    expect(p.warnings).toEqual([
      "Evento ID 4691: Tipo 'outro' inválido (use CHURN ou REATIVACAO), ignorado.",
      "Evento ID 4692 (CHURN): Data inválida ou vazia, ignorado.",
    ]);
  });

  it("sem a aba EVENTOS, events fica nulo (nada é removido)", () => {
    expect(buildPayload([{ gid: "1", name: "Clientes", rows: CLIENTS }]).events).toBeNull();
  });

  it("avisa da aba desconhecida, mas não das instruções", () => {
    const p = buildPayload([
      { gid: "9", name: "INSTRUÇÕES", rows: [["Dashboard CS Make — Planilha Mestre"]] },
      { gid: "8", name: "Rascunho", rows: [["anotações soltas"]] },
    ]);
    expect(p.warnings).toEqual([
      "Aba \"Rascunho\" NÃO RECONHECIDA e ignorada (linha 1: 'anotações soltas'). Se for uma aba que deveria ser lida, confira o banner/cabeçalho dela.",
    ]);
  });
});

describe("download", () => {
  const ID = "1BY4n2nKKznZj0RDHU8fGUhYUbjFqC5i691ip3Zq1Ksc";
  const page = 'items.push({name: "Clientes", pageUrl: "x?gid=11"});items.push({name: "Metas", pageUrl: "x?gid=22"});';
  it("baixa a lista e cada aba", async () => {
    const urls: string[] = [];
    const f = (async (url: string) => {
      urls.push(url);
      if (url.endsWith("/htmlview")) return new Response(page, { headers: { "content-type": "text/html" } });
      return new Response(csv([["ID", "Nome"], [1, "a"]]), { headers: { "content-type": "text/csv" } });
    }) as typeof fetch;
    const tabs = await downloadSheet(ID, f);
    expect(tabs.map((t) => [t.gid, t.name, t.rows.length])).toEqual([["11", "Clientes", 2], ["22", "Metas", 2]]);
    expect(urls[1]).toBe(`https://docs.google.com/spreadsheets/d/${ID}/export?format=csv&gid=11`);
  });
  it("planilha fechada ou aba que falha derrubam a leitura", async () => {
    const closed = (async () => new Response("<html>login</html>", { headers: { "content-type": "text/html" } })) as typeof fetch;
    await expect(downloadSheet(ID, closed)).rejects.toThrow(NOT_PUBLIC);
    let calls = 0;
    const flaky = (async (url: string) => {
      if (url.endsWith("/htmlview")) return new Response(page);
      calls++;
      return new Response("erro", { status: 503 });
    }) as typeof fetch;
    await expect(downloadSheet(ID, flaky)).rejects.toThrow(/Não consegui baixar a aba "Clientes" \(HTTP 503\)/);
    expect(calls).toBeGreaterThanOrEqual(2);
    await expect(downloadSheet("../../etc", flaky)).rejects.toThrow(/ID da planilha inválido/);
  });
});

describe("handleCsSync", () => {
  const env = { supabaseUrl: "https://db.test", supabaseKey: "anon", workerSecret: "w".repeat(40) };
  const rpcs: { name: string; auth: string | null; body: any }[] = [];
  const fakeFetch = (targets: unknown) =>
    (async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://db.test/rest/v1/rpc/")) {
        const name = url.split("/").pop()!;
        const body = JSON.parse(String(init?.body));
        rpcs.push({ name, auth: (init?.headers as Record<string, string>).Authorization, body });
        if (name === "cs_sync_targets") return new Response(JSON.stringify(targets));
        return new Response(JSON.stringify({ status: body.p_error ? "error" : "ok" }));
      }
      if (url.endsWith("/htmlview")) return new Response('items.push({name: "Clientes", pageUrl: "x?gid=1"});');
      return new Response(csv([["ID", "Nome", "Squad", "Origem", "DataEntrada"], [1, "Cliente", "Squad", "Comercial", "01/01/2026"]]), {
        headers: { "content-type": "text/csv" },
      });
    }) as typeof fetch;

  it("o agendamento lê todas as planilhas como anônimo com o segredo", async () => {
    rpcs.length = 0;
    const r = await handleCsSync({}, `Bearer ${env.workerSecret}`, env,
      fakeFetch([{ company: "c1", sheet_id: "1BY4n2nKKznZj0RDHU8fGUhYUbjFqC5i691ip3Zq1Ksc" }]));
    expect(r.status).toBe(200);
    expect(rpcs.map((x) => x.name)).toEqual(["cs_sync_targets", "cs_sync_store"]);
    expect(rpcs[0].body).toEqual({ p_secret: env.workerSecret, p_company: null });
    expect(rpcs[1].auth).toBe("Bearer anon");
    expect(rpcs[1].body).toMatchObject({ p_secret: env.workerSecret, p_company: "c1", p_trigger: "schedule", p_error: null, p_allow_removals: false });
    expect(rpcs[1].body.p_payload.clients[0]).toMatchObject({ external_id: "1", origin: "comercial" });
  });

  it("manual: a pessoa precisa de login e da empresa; a falha de leitura vai para o banco", async () => {
    expect((await handleCsSync({ company: "x" }, "Bearer user", env, fakeFetch([]))).status).toBe(400);
    expect((await handleCsSync({}, null, env, fakeFetch([]))).status).toBe(401);
    rpcs.length = 0;
    const company = "00000000-0000-4000-8000-000000000001";
    const closed = (async (url: string, init?: RequestInit) => {
      if (url.includes("/rest/v1/")) return fakeFetch([{ company, sheet_id: "1BY4n2nKKznZj0RDHU8fGUhYUbjFqC5i691ip3Zq1Ksc" }])(url, init);
      return new Response("<html>login</html>", { headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    const r = await handleCsSync({ company, allow_removals: true }, "Bearer user", env, closed);
    expect(r.body.results).toEqual([{ company, ok: false, run: { status: "error" }, error: NOT_PUBLIC }]);
    expect(rpcs[1].auth).toBe("Bearer user");
    expect(rpcs[1].body).toMatchObject({ p_secret: null, p_payload: null, p_error: NOT_PUBLIC, p_trigger: "manual", p_allow_removals: true });
  });
});

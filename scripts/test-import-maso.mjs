// Campanhas: import of the MASO's history (scripts/import-maso-campaigns.mjs).
// Builds a small phpMyAdmin export, generates the mapping template and the
// SQL through the CLI, runs the SQL as postgres (like the Supabase SQL
// editor) and checks the rows, then runs it again: nothing may change.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase } from "./database-fixture.mjs";
import {
  cleanText,
  parseDate,
  parseNumber,
  parseSqlDump,
  readExports,
} from "./import-maso-campaigns.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, member] = [1, 10, 11].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, member],
]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Tiago Tráfego','member')`,
  [A, admin, member],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [
    user ?? "",
  ]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
async function rpc(name, args) {
  return (
    await db.query(
      `select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})) as result`,
      args,
    )
  ).rows[0].result;
}
const sql = async (text, args = []) => {
  await db.exec("reset role");
  return (await db.query(text, args)).rows;
};
// The Supabase SQL editor: postgres, no session user.
const runScript = async (text) => {
  await as(null);
  await db.exec("reset role");
  await db.exec(text);
};
let passed = 0;
async function check(title, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${title}`);
  } catch (e) {
    console.error(`FAIL ${title}`);
    throw e;
  }
}

await as(admin);
const team = await rpc("create_team", [A, "Tráfego", []]);
const vittalium = await rpc("create_client", [A, "Vittalium", ""]);
const motion = await rpc("create_client", [A, "Motion", ""]);
const makeAds = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [
  A,
  vittalium,
  makeAds,
  "Make Ads",
  team,
]);
const contract2 = await rpc("create_contract", [
  A,
  motion,
  makeAds,
  "Make Ads",
  team,
]);

// ---------------------------------------------------------------- fixture
// Mojibake: UTF-8 bytes read as latin1, as the MASO stores some names.
const latin1 = (s) => Buffer.from(s, "utf8").toString("latin1");
const META = "0123456789abcdef0123456789abcdef";
const GOOGLE = "fedcba9876543210";
const OUTSIDE = "99999999999999999999999999999999";
const [Y1, Y2, Y3, Y4, Y5] = [
  "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
  "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
  "c3c3c3c3c3c3c3c3",
  "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4",
  "e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5",
];
const campaigns = [
  {
    id_campanha: META,
    id_cliente: "101",
    id_produto: "1",
    campanha: latin1("Promoção Verão - Meta"),
    ciclo: Y2,
    plataforma: "1",
    status_campanha: "1",
    briefing: "https://drive.google.com/briefing",
    plano_midia: "0",
  },
  {
    id_campanha: GOOGLE,
    id_cliente: "202",
    id_produto: "2",
    campanha: "Google - Pesquisa",
    ciclo: "1",
    plataforma: "2",
    status_campanha: "0",
    briefing: "",
    plano_midia: "www.plano.com/x",
  },
  {
    id_campanha: OUTSIDE,
    id_cliente: "999",
    id_produto: "1",
    campanha: "Fora do mapa",
    ciclo: Y5,
    plataforma: "1",
    status_campanha: "1",
    briefing: null,
    plano_midia: null,
  },
  // A 16-hex collision: the first one wins.
  {
    id_campanha: GOOGLE,
    id_cliente: "202",
    campanha: "Colisão",
    plataforma: "1",
    status_campanha: "1",
  },
];
const cycle = (fields) => ({
  id_cliente: "101",
  competencia: "0000-00-00",
  valor_midia_ciclo: "0",
  multiplicador: "1",
  meta_string: "3",
  meta_valor: "0",
  id_capture: "1",
  id_conta_anuncios_facebook: "0",
  id_campanha_facebook: "0",
  id_mcc_google: "",
  id_conta_anuncios_google: "",
  id_campanha_google: "",
  id_conta_anuncios_linkedin: "",
  id_campanha_linkedin: "",
  id_nichomercado: "0",
  ...fields,
});
const cycles = [
  cycle({
    id_ciclo: Y1,
    id_campanha: META,
    competencia: "2026-07-01",
    data_inicio: "2026-07-01",
    data_termino: "2026-07-31",
    valor_midia_ciclo: "3000.50",
    multiplicador: "1.5",
    objetivo: "LEAD",
    meta_valor: "100",
    id_capture: "0",
    id_conta_anuncios_facebook: "act_111, 222",
    id_campanha_facebook: "c1,c2 ",
    id_nichomercado: "7",
  }),
  cycle({
    id_ciclo: Y2,
    id_campanha: META,
    competencia: "2026-08-01",
    data_inicio: "2026-08-01",
    data_termino: "2026-08-31",
    valor_midia_ciclo: "R$ 4.500,00",
    multiplicador: "",
    objetivo: "VENDA",
    meta_string: "4",
    meta_valor: "50",
    id_capture: "0,1, 301,302",
    id_conta_anuncios_facebook: "111",
    id_campanha_facebook: "0",
  }),
  // Ends before it starts: skipped.
  cycle({
    id_ciclo: Y3,
    id_campanha: META,
    data_inicio: "2026-09-10",
    data_termino: "2026-09-01",
    objetivo: "LEAD",
  }),
  cycle({
    id_ciclo: Y4,
    id_cliente: "202",
    id_campanha: GOOGLE,
    competencia: "2026-08-01",
    data_inicio: "2026-08-01",
    data_termino: "2026-08-30",
    valor_midia_ciclo: "2000",
    multiplicador: "2",
    objetivo: latin1("TRÁFEGO"),
    meta_valor: "40",
    id_capture: "1",
    id_mcc_google: "123-456-7890",
    id_conta_anuncios_google: "111-222-3333, 444-555-6666",
    id_campanha_google: "9001",
  }),
  // Its campaign's client isn't mapped.
  cycle({
    id_ciclo: Y5,
    id_cliente: "999",
    id_campanha: OUTSIDE,
    data_inicio: "2026-08-01",
    data_termino: "2026-08-31",
    objetivo: "LEAD",
  }),
];
const registro = (fields) => ({
  impressao: "0",
  alcance: "0",
  total_clique: "0",
  conversoes: "0",
  conversoes_vis_produto: "0",
  conversoes_add_carrinho: "0",
  conversoes_finalizacao_compra: "0",
  investimento_total: "0",
  ...fields,
});
const snapshots = [
  registro({
    id: "1",
    id_campanha: META,
    id_ciclo: Y1,
    tipo: "0",
    ciclo_registro_inicio: "2026-07-01",
    ciclo_registro_fim: "2026-07-09",
    impressao: "10000",
    alcance: "4000",
    total_clique: "321",
    conversoes: "12",
    investimento_total: "R$ 1.234,56",
    status: "1",
    id_usuario_maso: "75",
    data_registro: "2026-07-10 08:00:00",
  }),
  registro({
    id: "2",
    id_campanha: META,
    id_ciclo: Y2,
    tipo: "0",
    ciclo_registro_inicio: "2026-08-05",
    ciclo_registro_fim: "2026-08-01",
    conversoes_add_carrinho: "3,5",
    status: "2",
    id_usuario_maso: "12",
    data_registro: "2026-08-05 09:30:00",
  }),
  // A note on the timeline, not a snapshot.
  registro({
    id: "3",
    id_campanha: META,
    id_ciclo: Y1,
    tipo: "3",
    data_registro: "2026-07-11 10:00:00",
  }),
  registro({
    id: "4",
    id_campanha: OUTSIDE,
    id_ciclo: Y5,
    tipo: "0",
    data_registro: "2026-08-10 08:00:00",
  }),
  registro({
    id: "5",
    id_campanha: GOOGLE,
    id_ciclo: Y4,
    tipo: "0",
    ciclo_registro_inicio: "2026-08-01",
    ciclo_registro_fim: "2026-08-04",
    // The MASO's Google cron: impressions in "alcance", "impressao" empty.
    alcance: "3000",
    investimento_total: null,
    status: "0",
    id_usuario_maso: "",
    data_registro: "2026-08-05 08:00:00",
  }),
];
const daily = [
  registro({
    id: "1",
    id_campanha: META,
    id_ciclo: Y1,
    data_registro: "2026-07-01",
    multiplicador: "1.5",
    investimento_total: "100.00",
    impressao: "1000",
  }),
  registro({
    id: "2",
    id_campanha: META,
    id_ciclo: Y1,
    data_registro: "2026-07-02",
    multiplicador: "1.5",
    investimento_total: "-5",
    total_clique: "7",
  }),
  // Same cycle and day as id 1: the last one (by id) wins.
  registro({
    id: "3",
    id_campanha: META,
    id_ciclo: Y1,
    data_registro: "2026-07-01",
    multiplicador: "1.5",
    investimento_total: "150",
    impressao: "1500",
  }),
  registro({
    id: "4",
    id_campanha: GOOGLE,
    id_ciclo: Y4,
    data_registro: "2026-08-02",
    multiplicador: "",
    investimento_total: "80,25",
    alcance: "1200",
    conversoes: "2",
  }),
  registro({
    id: "5",
    id_campanha: META,
    id_ciclo: Y3,
    data_registro: "2026-09-02",
    multiplicador: "1",
  }),
  registro({
    id: "6",
    id_campanha: META,
    id_ciclo: Y1,
    data_registro: "2026-09-15",
    multiplicador: "1.5",
  }),
];
const table = (name, data) => ({
  type: "table",
  name,
  database: "makevend_maso",
  data,
});
const dir = await mkdtemp(join(tmpdir(), "maso-import-"));
const exportFile = join(dir, "makevend_maso.json");
const usersFile = join(dir, "usuarios_maso.json");
await writeFile(
  exportFile,
  JSON.stringify([
    {
      type: "header",
      version: "5.2.1",
      comment: "Export to JSON plugin for PHPMyAdmin",
    },
    { type: "database", name: "makevend_maso" },
    table("maso_acompanhamento", campaigns),
    table("maso_acompanhamento_ciclo", cycles),
    table("maso_acompanhamento_registro", snapshots),
    table("maso_acompanhamento_registro_diario", daily),
    table("nichomercado", [{ id: "7", nome: latin1("Saúde") }]),
  ]),
);
// A second file: a plain array named after its table.
await writeFile(
  usersFile,
  JSON.stringify([
    { id: "12", nome: latin1("João Analista") },
    { id: "75", nome: "Robo" },
  ]),
);

const script = "scripts/import-maso-campaigns.mjs";
const cli = (args) =>
  execFileSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const cliError = (args) => {
  try {
    cli(args);
  } catch (e) {
    return e.stderr;
  }
  assert.fail("era esperado um erro");
};
const inputs = ["--input", exportFile, "--input", usersFile];
const templateFile = join(dir, "mapa.csv");
const mappingFile = join(dir, "mapa-preenchido.csv");
const outFile = join(dir, "import.sql");

try {
  await check("textos, números e datas do MASO", async () => {
    assert.equal(cleanText(latin1("Promoção")), "Promoção");
    // Already correct text and mixed fields stay right.
    assert.equal(cleanText("São Paulo"), "São Paulo");
    assert.equal(
      cleanText(`Açaí ${latin1("Maçã")} &amp; Promo&ccedil;&atilde;o`),
      "Açaí Maçã & Promoção",
    );
    assert.equal(cleanText(latin1("’")), "’");
    assert.equal(parseNumber("R$ 1.234,56"), 1234.56);
    assert.equal(parseNumber("1234.56"), 1234.56);
    assert.equal(parseNumber("3,5"), 3.5);
    assert.equal(parseNumber(""), null);
    assert.ok(Number.isNaN(parseNumber("abc")));
    assert.equal(parseDate("0000-00-00"), null);
    assert.equal(parseDate("2026-07-10 08:00:00"), "2026-07-10");
    assert.equal(parseDate("31/08/2026"), "2026-08-31");
    assert.equal(parseDate("2026-02-30"), null);
  });

  await check(
    "modelo do mapa: um cliente com campanhas por linha",
    async () => {
      const out = cli([...inputs, "--template", templateFile]);
      assert.match(out, /3 clientes com campanhas/);
      const text = await readFile(templateFile, "utf8");
      assert.equal(
        text,
        [
          "id_cliente;campanhas;exemplo;contract_id",
          "101;1;Promoção Verão - Meta;",
          "202;1;Google - Pesquisa;",
          "999;1;Fora do mapa;",
          "",
        ].join("\n"),
      );
    },
  );

  await check("argumentos inválidos são recusados", async () => {
    assert.match(
      cliError([
        ...inputs,
        "--company",
        "x",
        "--author",
        admin,
        "--mapping",
        templateFile,
        "--out",
        outFile,
      ]),
      /--company precisa ser um uuid/,
    );
    assert.match(cliError([...inputs, "--company", A]), /Falta --author/);
    assert.match(
      cliError(["--input", join(dir, "nada.json"), "--template", templateFile]),
      /arquivo não encontrado/,
    );
    await writeFile(join(dir, "ruim.csv"), "id_cliente;contract_id\n101;123\n");
    assert.match(
      cliError([
        ...inputs,
        "--company",
        A,
        "--author",
        admin,
        "--mapping",
        join(dir, "ruim.csv"),
        "--out",
        outFile,
      ]),
      /não é um uuid válido/,
    );
  });

  let output;
  await check(
    "gera o SQL e resume o que entra e o que fica de fora",
    async () => {
      // The user fills the template (client 999 stays out); "," also works.
      const template = await readFile(templateFile, "utf8");
      await writeFile(
        mappingFile,
        template
          .replace(
            "101;1;Promoção Verão - Meta;",
            `101;1;Promoção Verão - Meta;${contract}`,
          )
          .replace(
            "202;1;Google - Pesquisa;",
            `202;1;Google - Pesquisa;${contract2.toUpperCase()}`,
          ),
      );
      output = cli([
        ...inputs,
        "--company",
        A,
        "--author",
        admin,
        "--mapping",
        mappingFile,
        "--out",
        outFile,
      ]);
      assert.match(output, /Campanhas\s+2 gravados\s+2 ignorados/);
      assert.match(output, /1 cliente sem contrato no mapa/);
      assert.match(output, /1 id_campanha repetido/);
      assert.match(output, /Ciclos\s+3 gravados\s+2 ignorados/);
      assert.match(output, /1 término antes do início/);
      assert.match(output, /1 campanha não importada/);
      assert.match(output, /Vínculos\s+7 gravados/);
      assert.match(output, /Snapshots\s+3 gravados\s+1 ignorados/);
      assert.match(output, /Registros diários\s+3 gravados\s+3 ignorados/);
      assert.match(output, /1 dia repetido/);
      assert.match(output, /1 dia fora do período do ciclo/);
      assert.match(output, /cliente 999: 1 campanha \(ex\.: "Fora do mapa"\)/);
      assert.match(output, /investimento negativo \(-5\)/);
      assert.match(output, /multiplicador "" inválido, usado 1/);
      assert.match(output, /1 registro da linha do tempo não é snapshot/);
      const text = await readFile(outFile, "utf8");
      assert.match(text, /^begin;$/m);
      assert.match(text, /^commit;$/m);
      // Ids come from legacy_id lookups, never generated in the file.
      assert.ok(!text.includes("gen_random_uuid"));
    },
  );

  await check("contrato do mapa precisa ser da empresa", async () => {
    const wrongMapping = join(dir, "mapa-errado.csv");
    await writeFile(wrongMapping, `id_cliente,contract_id\n101,${uid(777)}\n`);
    const wrongOut = join(dir, "errado.sql");
    cli([
      ...inputs,
      "--company",
      A,
      "--author",
      admin,
      "--mapping",
      wrongMapping,
      "--out",
      wrongOut,
    ]);
    await assert.rejects(
      runScript(await readFile(wrongOut, "utf8")),
      /Contratos do mapa que não existem nesta empresa: 00000000-0000-4000-8000-000000000777/,
    );
    await db.exec("rollback").catch(() => {});
    const notAdmin = join(dir, "nao-admin.sql");
    cli([
      ...inputs,
      "--company",
      A,
      "--author",
      member,
      "--mapping",
      mappingFile,
      "--out",
      notAdmin,
    ]);
    await assert.rejects(
      runScript(await readFile(notAdmin, "utf8")),
      /não é administrador ativo/,
    );
    await db.exec("rollback").catch(() => {});
    assert.equal(
      (await sql("select count(*)::int n from ad_campaigns"))[0].n,
      0,
    );
  });

  const script1 = await readFile(outFile, "utf8");
  let ids;
  await check("campanhas: contrato, plataforma, status e links", async () => {
    await runScript(script1);
    const rows = await sql(
      "select legacy_id,contract_id,name,platform,status,briefing_url,media_plan_url,notes,created_by from ad_campaigns order by legacy_id",
    );
    assert.deepEqual(rows, [
      {
        legacy_id: META,
        contract_id: contract,
        name: "Promoção Verão - Meta",
        platform: "meta",
        status: "active",
        briefing_url: "https://drive.google.com/briefing",
        media_plan_url: "",
        notes: "",
        created_by: admin,
      },
      {
        legacy_id: GOOGLE,
        contract_id: contract2,
        name: "Google - Pesquisa",
        platform: "google",
        status: "inactive",
        briefing_url: "",
        media_plan_url: "https://www.plano.com/x",
        notes: "",
        created_by: admin,
      },
    ]);
    ids = Object.fromEntries(
      (await sql("select legacy_id,id from ad_cycles")).map((r) => [
        r.legacy_id,
        r.id,
      ]),
    );
    assert.deepEqual(Object.keys(ids).sort(), [Y1, Y2, Y4]);
  });

  await check("ciclo atual apontado para o ciclo do MASO", async () => {
    const rows = await sql(
      "select legacy_id,current_cycle_id from ad_campaigns order by legacy_id",
    );
    assert.deepEqual(rows, [
      { legacy_id: META, current_cycle_id: ids[Y2] },
      { legacy_id: GOOGLE, current_cycle_id: null },
    ]);
  });

  await check("ciclos: objetivo, meta, verba, M, destino e nicho", async () => {
    const rows = await sql(
      `select legacy_id,competence_month::text,start_date::text,end_date::text,objective,goal_results,
       budget::float,multiplier::float,destination,landing_pages,niche,created_by
       from ad_cycles order by start_date,legacy_id`,
    );
    assert.deepEqual(rows, [
      {
        legacy_id: Y1,
        competence_month: "2026-07-01",
        start_date: "2026-07-01",
        end_date: "2026-07-31",
        objective: "lead",
        goal_results: 100,
        budget: 3000.5,
        multiplier: 1.5,
        destination: "lead_form",
        landing_pages: [],
        niche: "Saúde",
        created_by: admin,
      },
      {
        legacy_id: Y2,
        competence_month: "2026-08-01",
        start_date: "2026-08-01",
        end_date: "2026-08-31",
        objective: "sale",
        goal_results: 0,
        budget: 4500,
        multiplier: 1,
        destination: "make_landing_page",
        landing_pages: ["301", "302"],
        niche: "",
        created_by: admin,
      },
      {
        legacy_id: Y4,
        competence_month: "2026-08-01",
        start_date: "2026-08-01",
        end_date: "2026-08-30",
        objective: "traffic",
        goal_results: 40,
        budget: 2000,
        multiplier: 2,
        destination: "external_page",
        landing_pages: [],
        niche: "",
        created_by: admin,
      },
    ]);
  });

  await check(
    "vínculos: contas × campanhas, Meta sem act_, Google com MCC",
    async () => {
      const links = async (cycle) =>
        (
          await sql(
            "select account_id,external_campaign_id,manager_id from ad_cycle_links where cycle_id=$1 order by 1,2",
            [cycle],
          )
        ).map((l) => [l.account_id, l.external_campaign_id, l.manager_id]);
      assert.deepEqual(await links(ids[Y1]), [
        ["111", "c1", ""],
        ["111", "c2", ""],
        ["222", "c1", ""],
        ["222", "c2", ""],
      ]);
      assert.deepEqual(await links(ids[Y2]), [["111", "", ""]]);
      assert.deepEqual(await links(ids[Y4]), [
        ["1112223333", "9001", "1234567890"],
        ["4445556666", "9001", "1234567890"],
      ]);
    },
  );

  await check("histórico: uma entrada 'imported' por campanha", async () => {
    const rows = await sql(
      "select a.legacy_id,e.actor_id,e.detail,e.cycle_id from ad_campaign_events e join ad_campaigns a on a.id=e.campaign_id order by a.legacy_id",
    );
    assert.deepEqual(rows, [
      {
        legacy_id: META,
        actor_id: admin,
        detail: { legacy_id: META, source: "MASO" },
        cycle_id: null,
      },
      {
        legacy_id: GOOGLE,
        actor_id: admin,
        detail: { legacy_id: GOOGLE, source: "MASO" },
        cycle_id: null,
      },
    ]);
  });

  await check("snapshots: só tipo 0, status da meta e autor", async () => {
    const rows = await sql(
      `select y.legacy_id,s.taken_on::text,s.period_start::text,s.period_end::text,s.spend::float,
       s.impressions::int,s.reach::int,s.clicks::int,s.conversions::float,s.add_to_cart::float,
       s.goal_status,s.source,s.author_label
       from ad_cycle_snapshots s join ad_cycles y on y.id=s.cycle_id order by s.taken_on,y.legacy_id`,
    );
    assert.deepEqual(rows, [
      {
        legacy_id: Y1,
        taken_on: "2026-07-10",
        period_start: "2026-07-01",
        period_end: "2026-07-09",
        spend: 1234.56,
        impressions: 10000,
        reach: 4000,
        clicks: 321,
        conversions: 12,
        add_to_cart: 0,
        goal_status: "good",
        source: "maso",
        author_label: "MASO · Robô",
      },
      {
        legacy_id: Y2,
        taken_on: "2026-08-05",
        period_start: "2026-08-05",
        period_end: "2026-08-05",
        spend: 0,
        impressions: 0,
        reach: 0,
        clicks: 0,
        conversions: 0,
        add_to_cart: 3.5,
        goal_status: "bad",
        source: "maso",
        author_label: "MASO · João Analista",
      },
      {
        legacy_id: Y4,
        taken_on: "2026-08-05",
        period_start: "2026-08-01",
        period_end: "2026-08-04",
        spend: 0,
        impressions: 3000,
        reach: 0,
        clicks: 0,
        conversions: 0,
        add_to_cart: 0,
        goal_status: null,
        source: "maso",
        author_label: "MASO",
      },
    ]);
  });

  await check(
    "diários: último repetido, negativo zerado, M do ciclo",
    async () => {
      const rows = await sql(
        `select y.legacy_id,d.day::text,d.multiplier::float,d.spend::float,d.impressions::int,d.clicks::int,
       d.conversions::float,d.source,d.campaign_id=y.campaign_id as same_campaign
       from ad_daily_metrics d join ad_cycles y on y.id=d.cycle_id order by d.day`,
      );
      assert.deepEqual(rows, [
        {
          legacy_id: Y1,
          day: "2026-07-01",
          multiplier: 1.5,
          spend: 150,
          impressions: 1500,
          clicks: 0,
          conversions: 0,
          source: "maso",
          same_campaign: true,
        },
        {
          legacy_id: Y1,
          day: "2026-07-02",
          multiplier: 1.5,
          spend: 0,
          impressions: 0,
          clicks: 7,
          conversions: 0,
          source: "maso",
          same_campaign: true,
        },
        {
          legacy_id: Y4,
          day: "2026-08-02",
          multiplier: 2,
          spend: 80.25,
          impressions: 1200,
          clicks: 0,
          conversions: 2,
          source: "maso",
          same_campaign: true,
        },
      ]);
    },
  );

  await check("o administrador enxerga o que foi importado", async () => {
    await as(admin);
    assert.equal((await db.query("select * from ad_campaigns")).rows.length, 2);
    assert.equal(
      (await db.query("select * from ad_daily_metrics")).rows.length,
      3,
    );
    await as(member);
    assert.equal((await db.query("select * from ad_campaigns")).rows.length, 0);
  });

  const everything = async () => {
    const out = {};
    for (const t of [
      "ad_campaigns",
      "ad_cycles",
      "ad_cycle_links",
      "ad_campaign_events",
      "ad_daily_metrics",
      "ad_cycle_snapshots",
    ])
      out[t] = await sql(`select * from ${t} order by id`);
    return out;
  };

  await check("rodar de novo não muda nada (idempotente)", async () => {
    const before = await everything();
    await runScript(script1);
    // Regenerated from the same export, too.
    cli([
      ...inputs,
      "--company",
      A,
      "--author",
      admin,
      "--mapping",
      mappingFile,
      "--out",
      outFile,
    ]);
    await runScript(await readFile(outFile, "utf8"));
    assert.deepEqual(await everything(), before);
  });

  await check("rodar de novo não desfaz o que mudou no MAVI", async () => {
    // A link removed and the current cycle changed in the app.
    await sql(
      "delete from ad_cycle_links where cycle_id=$1 and account_id='222'",
      [ids[Y1]],
    );
    await sql(
      "update ad_campaigns set current_cycle_id=$1 where legacy_id=$2",
      [ids[Y1], META],
    );
    const before = await everything();
    await runScript(script1);
    assert.deepEqual(await everything(), before);
  });
  await check("lê o dump SQL do phpMyAdmin", async () => {
    const dump = [
      "-- phpMyAdmin SQL Dump",
      "CREATE TABLE `maso_acompanhamento` (`id` int(11) NOT NULL);",
      "INSERT INTO `maso_acompanhamento` (`id`, `campanha`, `briefing`) VALUES",
      "(1, 'D\\'Ávila, \\\\ \\n (x)', NULL),",
      "(2, 'O''Neil', '');",
      "INSERT INTO `maso_acompanhamento_registro` (`id`, `tipo`, `impressao`) VALUES",
      "(1, 0, '10'), (2, 3, '0'), (3, '0', '5');",
    ].join("\n");
    const tables = parseSqlDump(dump);
    assert.deepEqual(tables.get("maso_acompanhamento"), [
      { id: "1", campanha: "D'Ávila, \\ \n (x)", briefing: null },
      { id: "2", campanha: "O'Neil", briefing: "" },
    ]);
    // Timeline rows other than snapshots are kept only as a count.
    assert.deepEqual(tables.get("maso_acompanhamento_registro"), [
      { id: "1", tipo: "0", impressao: "10" },
      { tipo: "3" },
      { id: "3", tipo: "0", impressao: "5" },
    ]);
    const file = join(dir, "maso_acompanhamento.sql");
    await writeFile(file, dump);
    const read = await readExports([file]);
    assert.equal(read.get("maso_acompanhamento").length, 2);
    assert.throws(
      () => parseSqlDump("INSERT INTO `x` (`a`, `b`) VALUES (1);"),
      /número de colunas/,
    );
  });

  // A former client (inactive campaign) and the active one of client 999,
  // neither in the map: --clients creates them.
  const formerFile = join(dir, "antigo.json");
  const FORMER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const FORMER_CYCLE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  await writeFile(
    formerFile,
    JSON.stringify([
      table("maso_acompanhamento", [
        {
          id_campanha: FORMER,
          id_cliente: "303",
          id_produto: "1",
          campanha: "Cliente antigo",
          ciclo: FORMER_CYCLE,
          plataforma: "1",
          status_campanha: "0",
        },
        {
          id_campanha: "cccccccccccccccccccccccccccccccc",
          id_cliente: "404",
          id_produto: "4",
          campanha: "Social Media",
          ciclo: "1",
          plataforma: "1",
          status_campanha: "1",
        },
      ]),
      table("maso_acompanhamento_ciclo", [
        cycle({
          id_ciclo: FORMER_CYCLE,
          id_campanha: FORMER,
          id_cliente: "303",
          competencia: "2021-03-01",
          data_inicio: "2021-03-01",
          data_termino: "2021-03-31",
          valor_midia_ciclo: "900",
          objetivo: "LEAD",
          meta_valor: "30",
        }),
        // A typo seen in the MASO: R$ 700 trillion.
        cycle({
          id_ciclo: "dddddddddddddddddddddddddddddddd",
          id_campanha: FORMER,
          id_cliente: "303",
          competencia: "2021-04-01",
          data_inicio: "2021-04-01",
          data_termino: "2021-04-30",
          valor_midia_ciclo: "700000000000000",
          objetivo: "",
          meta_valor: "10",
        }),
      ]),
    ]),
  );
  const withClients = [
    ...inputs,
    "--input",
    formerFile,
    "--company",
    A,
    "--author",
    admin,
    "--mapping",
    mappingFile,
    "--products",
    "1,2",
    "--clients",
    "Make Ads",
    "--out",
    outFile,
  ];
  const clientsOf = async () =>
    sql(
      `select c.name, c.archived, k.name as contract, k.archived as contract_archived, p.name as product
       from clients c left join contracts k on k.company_id = c.company_id and k.client_id = c.id
       left join products p on p.company_id = k.company_id and p.id = k.product_id
       where c.company_id = $1 order by c.name, k.name`,
      [A],
    );

  await check(
    "--clients cria os clientes que faltam; ex-clientes arquivados",
    async () => {
      const output = cli(withClients);
      assert.match(output, /produto fora da importação/);
      assert.match(output, /clientes do MASO a criar/);
      assert.match(output, /verba 700000000000000 impossível/);
      await runScript(await readFile(outFile, "utf8"));
      const rows = await clientsOf();
      const byName = (n) => rows.filter((r) => r.name === n);
      assert.deepEqual(byName("303"), [
        {
          name: "303",
          archived: true,
          contract: "Make Ads · 303",
          contract_archived: true,
          product: "Make Ads",
        },
      ]);
      assert.equal(byName("999").length, 1);
      assert.equal(byName("999")[0].contract, "Make Ads · 999");
      // Social Media (product 4) stays out; mapped clients are untouched.
      assert.equal(byName("404").length, 0);
      assert.equal(byName("Vittalium").length, 1);
      const [imported] = await sql(
        `select a.status, k.name as contract from ad_campaigns a join contracts k on k.company_id = a.company_id and k.id = a.contract_id where a.legacy_id = $1`,
        [FORMER],
      );
      assert.deepEqual(imported, {
        status: "inactive",
        contract: "Make Ads · 303",
      });
      assert.equal(
        (
          await sql(
            "select count(*)::int as n from ad_cycles where legacy_id=$1",
            [FORMER_CYCLE],
          )
        )[0].n,
        1,
      );
      // The typo becomes 0; no objective falls back to LEAD (MASO's default).
      const [typo] = await sql(
        "select budget::float, objective from ad_cycles where legacy_id=$1",
        ["dddddddddddddddddddddddddddddddd"],
      );
      assert.deepEqual(typo, { budget: 0, objective: "lead" });
    },
  );

  await check(
    "--clients de novo não duplica clientes nem contratos",
    async () => {
      const before = await clientsOf();
      const data = await everything();
      await runScript(await readFile(outFile, "utf8"));
      cli(withClients);
      await runScript(await readFile(outFile, "utf8"));
      assert.deepEqual(await clientsOf(), before);
      assert.deepEqual(await everything(), data);
    },
  );

  await check("--clients com produto que não existe é recusado", async () => {
    cli(withClients.map((a) => (a === "Make Ads" ? "Produto Inexistente" : a)));
    await assert.rejects(
      runScript(await readFile(outFile, "utf8")),
      /Produto Inexistente não encontrado/,
    );
    // The failed transaction stays open in this session (the SQL editor
    // starts a new one each run).
    await db.exec("rollback");
  });
  await check("--parts divide em arquivos que rodam separados", async () => {
    const data = await everything();
    const clients = await clientsOf();
    const output = cli([
      ...withClients.filter(
        (x, i, all) => all[i - 1] !== "--out" && x !== "--out",
      ),
      "--out",
      join(dir, "partes.sql"),
      "--parts",
      "0.002",
    ]);
    const files = [...output.matchAll(/(\/\S+partes-\d+\.sql)/g)].map(
      (m) => m[1],
    );
    assert.ok(files.length >= 3, output);
    const texts = await Promise.all(files.map((f) => readFile(f, "utf8")));
    assert.match(texts[0], /Parte 1 de/);
    assert.match(texts[0], /insert into public\.ad_cycles/);
    assert.doesNotMatch(texts[0], /insert into public\.ad_daily_metrics/);
    for (const t of texts.slice(1)) {
      assert.match(t, /^-- Campanhas: importação do MASO, parte \d+ de \d+/);
      assert.match(t, /begin;[\s\S]*commit;/);
    }
    // Everything is already in: running every part changes nothing.
    for (const [i, t] of texts.entries())
      await runScript(t).catch((e) => {
        throw Error(`parte ${i + 1}: ${e.message}`);
      });
    assert.deepEqual(await everything(), data);
    assert.deepEqual(await clientsOf(), clients);
    // The numbers alone (after part 1) bring back deleted days.
    await sql("delete from ad_daily_metrics where source='maso'");
    for (const t of texts.slice(1)) await runScript(t);
    // Same days again (only the row ids and sync time are new).
    const days = (rows) =>
      rows.map(({ id: _id, synced_at: _at, ...rest }) => rest);
    const after = await everything();
    assert.deepEqual(days(after.ad_daily_metrics), days(data.ad_daily_metrics));
    assert.deepEqual(after.ad_cycle_snapshots, data.ad_cycle_snapshots);
  });
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${passed} verificações da importação do MASO passaram.`);

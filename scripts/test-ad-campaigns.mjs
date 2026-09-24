// Campanhas (migration 20260930090000_ad_campaigns): campaigns belong to a
// contracted product and go through cycles; the current cycle only changes
// by hand. The module is exclusive to the company's administrators.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, admin2, manager, trafego, outsider] = [
  1, 2, 10, 11, 12, 13, 14,
].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, admin2, manager, trafego, outsider],
]);
await db.query(
  `insert into companies(id,name) values($1,'Make'),($2,'Outra agência')`,
  [A, B],
);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$3,'Ana Admin','admin'),($1,$4,'Beto Admin','admin'),
   ($1,$5,'Gabi Gestora','manager'),($1,$6,'Tiago Tráfego','member'),
   ($2,$7,'Fora','admin')`,
  [A, B, admin, admin2, manager, trafego, outsider],
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
const visible = async (user, table) => {
  await as(user);
  return (await db.query(`select * from ${table}`)).rows;
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

// Tiago's team (Tráfego) serves the client, and Gabi is a manager: neither
// is an administrator, so neither sees nor changes campaigns.
await as(admin);
const team = await rpc("create_team", [A, "Tráfego", [trafego]]);
const client = await rpc("create_client", [A, "Vittalium", ""]);
const otherClient = await rpc("create_client", [A, "Outro cliente", ""]);
const makeAds = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [
  A,
  client,
  makeAds,
  "Make Ads",
  team,
]);
const otherContract = await rpc("create_contract", [
  A,
  otherClient,
  makeAds,
  "Make Ads",
  team,
]);

const campaign = (user, args = {}) =>
  as(user).then(() =>
    rpc("create_ad_campaign", [
      A,
      args.contract ?? contract,
      args.name ?? "Motion - Meta - Mensagem",
      args.platform ?? "meta",
      args.briefing ?? "",
      args.plan ?? "",
      args.notes ?? "",
    ]),
  );
const cycle = (user, id, c = {}) =>
  as(user).then(() =>
    rpc("create_ad_cycle", [
      id,
      c.competence ?? c.start ?? "2026-08-31",
      c.start ?? "2026-08-31",
      c.end ?? "2026-09-30",
      c.objective ?? "message",
      c.goal ?? 100,
      c.budget ?? 3000,
      c.m ?? null,
      c.destination ?? "external_page",
      c.pages ?? [],
      c.niche ?? "Suplementos",
      JSON.stringify(c.links ?? [{ account_id: "act_1", campaign_id: "c1" }]),
      c.current ?? false,
    ]),
  );

let main, current;

await check(
  "administrador cadastra campanha, inativa e sem ciclo",
  async () => {
    main = await campaign(admin);
    const [row] = await sql("select * from ad_campaigns where id=$1", [main]);
    assert.equal(row.status, "inactive");
    assert.equal(row.current_cycle_id, null);
    assert.equal(row.contract_id, contract);
    assert.equal(row.created_by, admin);
    const events = await sql(
      "select action from ad_campaign_events where campaign_id=$1",
      [main],
    );
    assert.deepEqual(
      events.map((e) => e.action),
      ["created"],
    );
  },
);

await check("só administradores da empresa cadastram", async () => {
  await campaign(admin2, { name: "Google - Lead" });
  for (const user of [manager, trafego, outsider])
    await assert.rejects(campaign(user), /exclusivo de administradores/);
  // Without permission, nothing is revealed about the contract.
  await assert.rejects(
    campaign(manager, { contract: uid(999) }),
    /exclusivo de administradores/,
  );
  await assert.rejects(
    campaign(admin, { contract: uid(999) }),
    /Produto contratado inválido/,
  );
});

await check("links precisam começar com http(s)", async () => {
  await assert.rejects(
    campaign(admin, { briefing: "drive.google.com/x" }),
    /briefing precisa começar/,
  );
  await assert.rejects(
    campaign(admin, { plan: "ftp://plano" }),
    /plano de mídia precisa começar/,
  );
});

await check("só administradores da empresa leem", async () => {
  assert.equal((await visible(admin, "ad_campaigns")).length, 2);
  assert.equal((await visible(admin2, "ad_campaigns")).length, 2);
  for (const user of [manager, trafego, outsider])
    assert.equal((await visible(user, "ad_campaigns")).length, 0);
  await as(null);
  await assert.rejects(
    db.query("select * from ad_campaigns"),
    /permission denied/,
  );
});

await check("ninguém escreve direto nas tabelas", async () => {
  await as(admin);
  await assert.rejects(
    db.query(
      `insert into ad_campaigns(company_id,contract_id,name,platform) values($1,$2,'X','meta')`,
      [A, contract],
    ),
    /permission denied/,
  );
  await assert.rejects(
    db.query(`update ad_cycles set budget=0`),
    /permission denied/,
  );
});

await check("ciclo novo: vínculos gravados; atual só se pedido", async () => {
  await assert.rejects(cycle(trafego, main), /Sem permissão/);
  await assert.rejects(cycle(manager, main), /Sem permissão/);
  const first = await cycle(admin, main);
  const [row] = await sql("select * from ad_campaigns where id=$1", [main]);
  assert.equal(row.current_cycle_id, null);
  const links = await sql(
    "select account_id,external_campaign_id from ad_cycle_links where cycle_id=$1",
    [first],
  );
  assert.deepEqual(links, [
    { account_id: "act_1", external_campaign_id: "c1" },
  ]);
  const [y] = await sql(
    "select competence_month::text,multiplier::float,budget::float from ad_cycles where id=$1",
    [first],
  );
  assert.deepEqual(y, {
    competence_month: "2026-08-01",
    multiplier: 1,
    budget: 3000,
  });
  current = first;
});

await check("ativar exige ciclo atual e motivo", async () => {
  await as(manager);
  await assert.rejects(
    rpc("set_ad_campaign_current_cycle", [main, current]),
    /Sem permissão/,
  );
  await as(admin);
  await assert.rejects(
    rpc("set_ad_campaign_status", [main, "active", "Começou"]),
    /Defina o ciclo atual/,
  );
  await rpc("set_ad_campaign_current_cycle", [main, current]);
  await assert.rejects(
    rpc("set_ad_campaign_status", [main, "active", ""]),
    /Informe o motivo/,
  );
  await as(trafego);
  await assert.rejects(
    rpc("set_ad_campaign_status", [main, "active", "Ciclo de setembro"]),
    /Sem permissão/,
  );
  await as(admin);
  await rpc("set_ad_campaign_status", [main, "active", "Ciclo de setembro"]);
  await assert.rejects(
    rpc("set_ad_campaign_status", [main, "active", "De novo"]),
    /já está ativa/,
  );
  const [row] = await sql("select status from ad_campaigns where id=$1", [
    main,
  ]);
  assert.equal(row.status, "active");
});

await check(
  "períodos de ciclos da mesma campanha não se sobrepõem",
  async () => {
    await assert.rejects(
      cycle(admin, main, { start: "2026-09-30", end: "2026-10-29" }),
      /conflita com o ciclo de 31\/08\/2026 a 30\/09\/2026/,
    );
    await assert.rejects(
      cycle(admin, main, { start: "2026-10-10", end: "2026-10-01" }),
      /término precisa ser igual ou posterior/,
    );
    await assert.rejects(
      cycle(admin, main, {
        start: "2026-10-01",
        end: "2026-10-30",
        destination: "make_landing_page",
      }),
      /página de captura da Make/,
    );
  },
);

await check("sem M informado, o ciclo herda o do anterior", async () => {
  const october = await cycle(admin, main, {
    start: "2026-10-01",
    end: "2026-10-30",
    m: 2.5,
  });
  const november = await cycle(admin2, main, {
    start: "2026-10-31",
    end: "2026-11-29",
  });
  const rows = await sql(
    "select id,multiplier::float from ad_cycles where id=any($1)",
    [[october, november]],
  );
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, r.multiplier])), {
    [october]: 2.5,
    [november]: 2.5,
  });
});

await check("o ciclo atual não troca sozinho", async () => {
  const [row] = await sql(
    "select current_cycle_id from ad_campaigns where id=$1",
    [main],
  );
  assert.equal(row.current_cycle_id, current);
});

await check("ciclo atual precisa ser da própria campanha", async () => {
  const other = await campaign(admin, { contract: otherContract });
  const foreign = await cycle(admin, other);
  await as(admin);
  await assert.rejects(
    rpc("set_ad_campaign_current_cycle", [main, foreign]),
    /Ciclo inválido/,
  );
});

await check("edição registra antes e depois, e checa a versão", async () => {
  const [y] = await sql("select version from ad_cycles where id=$1", [current]);
  const edit = (version, budget) =>
    rpc("update_ad_cycle", [
      current,
      version,
      "2026-09-01",
      "2026-08-31",
      "2026-09-30",
      "message",
      120,
      budget,
      null,
      "external_page",
      [],
      "Suplementos",
      JSON.stringify([
        { account_id: "act_1", campaign_id: "c1" },
        { account_id: "act_1", campaign_id: "c2" },
      ]),
    ]);
  await as(manager);
  await assert.rejects(edit(y.version, 3500), /Sem permissão/);
  await as(admin);
  await edit(y.version, 3500);
  await assert.rejects(edit(y.version, 3600), /alterado por outra pessoa/);
  const [event] = await sql(
    "select detail from ad_campaign_events where cycle_id=$1 and action='cycle_updated'",
    [current],
  );
  assert.deepEqual(event.detail.budget, { from: 3000, to: 3500 });
  assert.deepEqual(event.detail.goal_results, { from: 100, to: 120 });
  assert.equal(event.detail.links.to.length, 2);
  assert.equal(event.detail.multiplier, undefined);
});

await check(
  "ciclo encerrado continua editável pelo administrador",
  async () => {
    const old = await cycle(admin, main, {
      start: "2025-01-01",
      end: "2025-01-31",
    });
    const [y] = await sql("select version from ad_cycles where id=$1", [old]);
    await as(admin);
    await rpc("update_ad_cycle", [
      old,
      y.version,
      "2025-01-01",
      "2025-01-01",
      "2025-01-31",
      "lead",
      50,
      1000,
      3,
      "lead_form",
      [],
      "",
      "[]",
    ]);
    const [row] = await sql(
      "select multiplier::float,objective from ad_cycles where id=$1",
      [old],
    );
    assert.deepEqual(row, { multiplier: 3, objective: "lead" });
  },
);

await check("plataforma não muda com mais de um ciclo", async () => {
  const [a] = await sql("select version from ad_campaigns where id=$1", [main]);
  await as(admin);
  await assert.rejects(
    rpc("update_ad_campaign", [
      main,
      a.version,
      "Nome novo",
      "google",
      "",
      "",
      "",
    ]),
    /plataforma não muda/,
  );
  await rpc("update_ad_campaign", [
    main,
    a.version,
    "  Nome novo  ",
    "meta",
    "https://briefing",
    "",
    "Obs.",
  ]);
  const [row] = await sql(
    "select name,briefing_url from ad_campaigns where id=$1",
    [main],
  );
  assert.deepEqual(row, {
    name: "Nome novo",
    briefing_url: "https://briefing",
  });
});

await check("ciclos, vínculos e histórico: só administradores", async () => {
  const events = await visible(admin2, "ad_campaign_events");
  assert.ok(events.some((e) => e.action === "status"));
  for (const user of [manager, trafego, outsider])
    for (const table of ["ad_cycles", "ad_cycle_links", "ad_campaign_events"])
      assert.equal((await visible(user, table)).length, 0, `${user} ${table}`);
});

await check("administrador desativado perde o acesso", async () => {
  await sql("update memberships set active=false where user_id=$1", [admin2]);
  assert.equal((await visible(admin2, "ad_campaigns")).length, 0);
  await assert.rejects(campaign(admin2), /exclusivo de administradores/);
});

console.log(`\n${passed} verificações de campanhas passaram.`);

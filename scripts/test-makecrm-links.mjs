// Campanhas › Abrir no CRM (migration 20270320090000_makecrm_links): só
// administradores e gestores ligam um cliente a uma empresa do MakeCRM; vê o
// botão e abre quem vê o cliente em Campanhas (líder, ou colaborador com o
// módulo ligado numa equipe do cliente); cada abertura fica registrada com o
// papel de quem abriu, até 120 por hora.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, manager, trafego, other, outsider] = [
  1, 2, 10, 11, 12, 13, 14,
].map(uid);
const CRM = "11111111-2222-4333-8444-555555555555";
await db.query(
  `insert into auth.users(id, email) select * from unnest($1::uuid[], $2::text[])`,
  [
    [admin, manager, trafego, other, outsider],
    [
      "ana@make.com",
      "gabi@make.com",
      "tiago@make.com",
      "olga@make.com",
      "fora@outra.com",
    ],
  ],
);
await db.query(
  `insert into companies(id,name) values($1,'Make'),($2,'Outra agência')`,
  [A, B],
);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$3,'Ana Admin','admin',true),($1,$4,'Gabi Gestora','manager',true),
   ($1,$5,'Tiago Tráfego','member',true),($1,$6,'Olga Outra','member',true),
   ($2,$7,'Fora','admin',true)`,
  [A, B, admin, manager, trafego, other, outsider],
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

// Tiago's team serves Vittalium; Olga's serves nobody. Both have Campanhas on.
await as(admin);
const team = await rpc("create_team", [A, "Tráfego", [trafego]]);
await rpc("create_team", [A, "Outra", [other]]);
const client = await rpc("create_client", [A, "Vittalium", ""]);
const otherClient = await rpc("create_client", [A, "Outro cliente", ""]);
const noCampaign = await rpc("create_client", [A, "Sem campanha", ""]);
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
  null,
]);
await rpc("create_ad_campaign", [
  A,
  contract,
  "Motion - Meta",
  "meta",
  "",
  "",
  "",
]);
await rpc("create_ad_campaign", [
  A,
  otherContract,
  "Outro - Meta",
  "meta",
  "",
  "",
  "",
]);
await sql(
  `update memberships set shown_pages = '{campaigns}' where user_id = any($1)`,
  [[trafego, other]],
);
// The client's Make code, from a lead form (twice: listed once).
await sql(
  `insert into ad_lead_forms(company_id, client_id, page_id, form_id, landing_page_id, make_user_id, created_by)
   values ($1,$2,'1','11','lp1','4321',$3),($1,$2,'1','12','lp2','4321',$3)`,
  [A, client, admin],
);

await check(
  "líderes veem os clientes com campanha e o código da Make",
  async () => {
    for (const who of [admin, manager]) {
      await as(who);
      const list = await rpc("crm_link_clients", [A]);
      assert.deepEqual(
        list.map((c) => c.name),
        ["Outro cliente", "Vittalium"],
      );
      const v = list.find((c) => c.client_id === client);
      assert.deepEqual(v.make_ids, ["4321"]);
      assert.equal(v.crm_company_id, null);
    }
    assert.ok(noCampaign);
  },
);

await check("colaborador e outra empresa não ligam nem listam", async () => {
  for (const who of [trafego, outsider]) {
    await as(who);
    await assert.rejects(rpc("crm_link_clients", [A]), /Sem permissão/);
    await assert.rejects(
      rpc("crm_link_set", [A, client, CRM, "x"]),
      /Sem permissão/,
    );
    await assert.rejects(rpc("crm_link_admin", [A]), /Sem permissão/);
  }
  await as(admin);
  assert.equal(await rpc("crm_link_admin", [A]), true);
});

await check("sem ligação, ninguém abre", async () => {
  await as(admin);
  await assert.rejects(rpc("crm_open", [A, client]), /ainda não está ligado/);
});

await check("gestor liga, troca e a lista mostra", async () => {
  await as(manager);
  await rpc("crm_link_set", [A, client, uid(99), "Código Make 1"]);
  await rpc("crm_link_set", [A, client, CRM, "Código Make 4321 · Dono"]);
  const v = (await rpc("crm_link_clients", [A])).find(
    (c) => c.client_id === client,
  );
  assert.equal(v.crm_company_id, CRM);
  assert.equal(v.crm_label, "Código Make 4321 · Dono");
  await assert.rejects(
    rpc("crm_link_set", [A, uid(98), CRM, ""]),
    /Cliente não encontrado/,
  );
  // A client of another company isn't found either.
  await as(outsider);
  const foreign = await rpc("create_client", [B, "Deles", ""]);
  await as(manager);
  await assert.rejects(
    rpc("crm_link_set", [A, foreign, CRM, ""]),
    /Cliente não encontrado/,
  );
});

await check(
  "a ligação aparece só para quem vê o cliente em Campanhas",
  async () => {
    const seen = async (who) => {
      await as(who);
      return (
        await db.query("select client_id from client_crm_links")
      ).rows.map((r) => r.client_id);
    };
    assert.deepEqual(await seen(admin), [client]);
    assert.deepEqual(await seen(trafego), [client]);
    assert.deepEqual(await seen(other), []);
    assert.deepEqual(await seen(outsider), []);
    await sql(`update memberships set shown_pages = '{}' where user_id = $1`, [
      trafego,
    ]);
    assert.deepEqual(await seen(trafego), []);
    await sql(
      `update memberships set shown_pages = '{campaigns}' where user_id = $1`,
      [trafego],
    );
  },
);

await check("abrir devolve quem é e o papel, e registra", async () => {
  await as(trafego);
  const r = await rpc("crm_open", [A, client]);
  assert.deepEqual(r, {
    crm_company_id: CRM,
    user_id: trafego,
    email: "tiago@make.com",
    name: "Tiago Tráfego",
    role: "member",
  });
  await as(admin);
  assert.equal((await rpc("crm_open", [A, client])).role, "admin");
  const log = await sql(
    "select user_id, role, crm_company_id from client_crm_opens order by id",
  );
  assert.deepEqual(log, [
    { user_id: trafego, role: "member", crm_company_id: CRM },
    { user_id: admin, role: "admin", crm_company_id: CRM },
  ]);
});

await check("fora da equipe, sem o módulo ou inativo não abre", async () => {
  await as(other);
  await assert.rejects(rpc("crm_open", [A, client]), /Sem permissão/);
  await as(outsider);
  await assert.rejects(rpc("crm_open", [A, client]), /Sem permissão/);
  await sql(`update memberships set shown_pages = '{}' where user_id = $1`, [
    trafego,
  ]);
  await as(trafego);
  await assert.rejects(rpc("crm_open", [A, client]), /Sem permissão/);
  await sql(
    `update memberships set shown_pages = '{campaigns}', active = false where user_id = $1`,
    [trafego],
  );
  await as(trafego);
  await assert.rejects(rpc("crm_open", [A, client]), /Sem permissão/);
  await sql(`update memberships set active = true where user_id = $1`, [
    trafego,
  ]);
});

await check("ninguém lê nem altera as tabelas direto", async () => {
  await as(admin);
  await assert.rejects(
    db.query("select * from client_crm_opens"),
    /permission denied/,
  );
  await assert.rejects(
    db.query(
      "insert into client_crm_links(company_id, client_id, crm_company_id) values($1,$2,$3)",
      [A, otherClient, CRM],
    ),
    /permission denied/,
  );
  await assert.rejects(
    db.query("update client_crm_links set crm_company_id = $1", [uid(97)]),
    /permission denied/,
  );
  await as(null);
  await assert.rejects(rpc("crm_open", [A, client]), /permission denied/);
});

await check("até 120 aberturas por hora por pessoa", async () => {
  await sql(
    `insert into client_crm_opens(company_id, client_id, user_id, crm_company_id, role)
     select $1, $2, $3, $4, 'member' from generate_series(1, 119)`,
    [A, client, trafego, CRM],
  );
  await as(trafego);
  await assert.rejects(rpc("crm_open", [A, client]), /Muitas aberturas/);
  await sql(
    `update client_crm_opens set created_at = now() - interval '2 hours' where user_id = $1`,
    [trafego],
  );
  await as(trafego);
  assert.equal((await rpc("crm_open", [A, client])).crm_company_id, CRM);
});

await check("remover a ligação some o botão", async () => {
  await as(trafego);
  await assert.rejects(rpc("crm_link_remove", [A, client]), /Sem permissão/);
  await as(admin);
  await rpc("crm_link_remove", [A, client]);
  await as(trafego);
  await assert.rejects(rpc("crm_open", [A, client]), /ainda não está ligado/);
  assert.equal(
    (await db.query("select * from client_crm_links")).rows.length,
    0,
  );
});

await check("excluir o cliente leva a ligação junto", async () => {
  await as(admin);
  await rpc("crm_link_set", [A, noCampaign, CRM, ""]);
  // Linked, it is listed even without a campaign.
  assert.ok(
    (await rpc("crm_link_clients", [A])).some(
      (c) => c.client_id === noCampaign,
    ),
  );
  await sql("delete from clients where id = $1", [noCampaign]);
  assert.equal(
    (
      await sql("select * from client_crm_links where client_id = $1", [
        noCampaign,
      ])
    ).length,
    0,
  );
});

console.log(`\n${passed} verificações do Abrir no CRM passaram.`);
await db.close?.();

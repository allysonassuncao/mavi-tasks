// Social Leads (migration 20261122090000_social_leads_archive): tirar um
// cliente da carteira (arquivar, e voltar com o histórico), excluir de vez o
// que foi adicionado por engano e a lista do "Adicionar cliente", que mostra
// a quem não é líder os clientes que ele pode atender, mesmo sem produto.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, lorena, outsider, nobody] = [1, 10, 12, 13, 15].map(uid);
const [product, squad, other, client, contract, fresh, served, secret] = [
  20, 22, 26, 24, 25, 27, 28, 29,
].map(uid);
await db.query("insert into auth.users select unnest($1::uuid[])", [
  [admin, lorena, outsider, nobody],
]);
await db.exec(`insert into companies(id,name) values('${A}','Make');
insert into memberships(company_id,user_id,name,role) values('${A}','${admin}','Ana Admin','admin'),
 ('${A}','${lorena}','Lorena Amaral','member'),('${A}','${outsider}','Caio Fora','member'),
 ('${A}','${nobody}','Nina Sem Equipe','member');
insert into products(company_id,id,name) values('${A}','${product}','Social Leads');
insert into teams(company_id,id,name) values('${A}','${squad}','Squad'),('${A}','${other}','Outra');
insert into team_members(company_id,team_id,user_id) values('${A}','${squad}','${lorena}'),
 ('${A}','${other}','${outsider}');
insert into clients(company_id,id,name) values('${A}','${client}','Agente Stravitta'),
 ('${A}','${fresh}','5065'),('${A}','${served}','Loja da Outra'),('${A}','${secret}','Cliente Reservado');
insert into client_teams(company_id,client_id,team_id) values('${A}','${client}','${squad}'),
 ('${A}','${served}','${other}');
insert into contracts(company_id,id,client_id,product_id,name) values('${A}','${contract}','${client}','${product}','Social Leads · Stravitta');
insert into social_leads_settings(company_id,product_id,team_id) values('${A}','${product}','${squad}');`);

async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [
    user ?? "",
  ]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const all = async (sql, params = []) => (await db.query(sql, params)).rows;
const names = async () =>
  (await one("select public.social_leads_addable_clients($1) as r", [A])).r.map(
    (c) => c.name,
  );
const portfolio = async () =>
  (await one("select public.social_leads_portfolio($1) as r", [A])).r.items.map(
    (i) => i.client_name,
  );
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

await check(
  "a lista do Adicionar cliente mostra o cliente sem produto a quem pode atendê-lo",
  async () => {
    // A visibilidade de Clientes esconde de quem não é líder o cliente sem produto…
    await as(lorena);
    assert.deepEqual(
      (await all("select name from clients order by name")).map((c) => c.name),
      ["Agente Stravitta"],
    );
    // …mas quem é do squad vê todos os que ainda não estão no Social Leads.
    assert.deepEqual(await names(), [
      "5065",
      "Cliente Reservado",
      "Loja da Outra",
    ]);
    // Fora do squad: só os atendidos por uma equipe sua.
    await as(outsider);
    assert.deepEqual(await names(), ["Loja da Outra"]);
    await as(nobody);
    assert.deepEqual(await names(), []);
    await assert.rejects(
      db.query("select public.social_leads_add_client($1,$2,null,null)", [
        A,
        fresh,
      ]),
      /atendidos por uma equipe sua/,
    );
    await as(admin);
    assert.deepEqual(await names(), [
      "5065",
      "Cliente Reservado",
      "Loja da Outra",
    ]);
  },
);

let added;
await check("quem é do squad adiciona o 5065 e passa a vê-lo", async () => {
  await as(lorena);
  added = (
    await one("select public.social_leads_add_client($1,$2,null,null) as r", [
      A,
      fresh,
    ])
  ).r;
  assert.deepEqual(
    await portfolio(),
    ["5065", "Agente Stravitta"].sort((a, b) => a.localeCompare(b)),
  );
  assert.ok(!(await names()).includes("5065"));
});

await check(
  "arquivar tira da carteira e o cliente volta com o histórico",
  async () => {
    await as(lorena);
    await db.query(
      "select public.save_social_leads_briefing($1,$2,$3,'ctwa',null,null)",
      [A, contract, { clientName: "Agente Stravitta", segment: "Afiliados" }],
    );
    await as(outsider);
    await assert.rejects(
      db.query("select public.social_leads_archive($1,true)", [contract]),
      /Sem permissão/,
    );
    await as(lorena);
    await db.query("select public.social_leads_archive($1,true)", [contract]);
    assert.deepEqual(await portfolio(), ["5065"]);
    const back = (
      await one("select public.social_leads_addable_clients($1) as r", [A])
    ).r.find((c) => c.name === "Agente Stravitta");
    assert.equal(back.archived_contract, contract);
    // Voltar pelo Adicionar cliente reaproveita o mesmo produto e o briefing.
    const k = (
      await one("select public.social_leads_add_client($1,$2,null,null) as r", [
        A,
        client,
      ])
    ).r;
    assert.equal(k, contract);
    const b = await one(
      "select fields from social_leads_briefings where contract_id=$1",
      [contract],
    );
    assert.equal(b.fields.segment, "Afiliados");
    assert.equal(
      (
        await one(
          "select count(*)::int as n from contracts where client_id=$1",
          [client],
        )
      ).n,
      1,
    );
  },
);

await check("excluir de vez só o que não tem histórico", async () => {
  await as(lorena);
  await db.query(
    "select public.social_leads_write_plan($1,$2,null,$3,'x',null,'ai')",
    [
      A,
      contract,
      {
        diagnostico: { negocio: "R", comoQuerSerVista: "C" },
        swot: { forcas: "", fraquezas: "", oportunidades: "", ameacas: "" },
        pilares: [1, 2, 3, 4].map((n) => ({
          titulo: `P${n}`,
          descricao: `D${n}`,
        })),
        publico: "P",
        campanha: {},
        alertas: [],
        posts: Array.from({ length: 8 }, (_, i) => ({
          numero: i + 1,
          badge: "oferta",
          gancho: `G${i}`,
          direcaoCopy: "C",
          direcaoVisual: "V",
          formato: "Reels",
          cta: "Seguir",
          ehAnuncio: i === 0,
        })),
      },
    ],
  );
  await assert.rejects(
    db.query("select public.social_leads_remove($1)", [contract]),
    /Arquive em vez de excluir/,
  );
  await db.query("select public.social_leads_remove($1)", [added]);
  assert.deepEqual(await portfolio(), ["Agente Stravitta"]);
  assert.ok((await names()).includes("5065"));
  await db.exec("reset role");
  assert.equal(
    (await all("select * from contracts where id=$1", [added])).length,
    0,
  );
  assert.equal(
    (await all("select * from clients where id=$1", [fresh])).length,
    1,
  );
});

console.log(
  `\n${passed} verificações de arquivar e adicionar clientes passaram.`,
);

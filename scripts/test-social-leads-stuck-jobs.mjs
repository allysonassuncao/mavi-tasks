// Geração do plano presa (migration 20261213090000_social_leads_stuck_jobs):
// passados 6 minutos sem resposta da função, o banco fecha a geração como
// falha e avisa quem pediu; as que ainda estão no prazo e as terminadas ficam.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, lorena, product, aurora, forma] = [1, 12, 20, 30, 31].map(uid);
const [stuckContract, freshContract] = [40, 41].map(uid);
await db.query("insert into auth.users select unnest($1::uuid[])", [[lorena]]);
await db.exec(`insert into companies(id,name) values('${A}','Make');
insert into memberships(company_id,user_id,name,role) values('${A}','${lorena}','Lorena Amaral','admin');
insert into products(company_id,id,name) values('${A}','${product}','Social Leads');
insert into clients(company_id,id,name) values('${A}','${aurora}','Aurora'),('${A}','${forma}','Forma');
insert into contracts(company_id,id,client_id,product_id,name) values
 ('${A}','${stuckContract}','${aurora}','${product}','Social Leads · Aurora'),
 ('${A}','${freshContract}','${forma}','${product}','Social Leads · Forma');`);

const job = async (contract, minutesAgo, status = "running") =>
  (
    await db.query(
      `insert into social_leads_jobs(company_id,contract_id,kind,created_by,status,created_at)
       values($1,$2,'new',$3,$4,now() - make_interval(mins => $5)) returning id`,
      [A, contract, lorena, status, minutesAgo],
    )
  ).rows[0].id;
const done = await job(stuckContract, 40, "done");
const stuck = await job(stuckContract, 30);
const fresh = await job(freshContract, 2);

const closed = (
  await db.query("select mavi_private.social_leads_expire_jobs() n")
).rows[0].n;
assert.equal(closed, 1);
const rows = Object.fromEntries(
  (
    await db.query("select id,status,error,finished_at from social_leads_jobs")
  ).rows.map((r) => [r.id, r]),
);
assert.equal(rows[stuck].status, "failed");
assert.match(rows[stuck].error, /interrompida/);
assert.ok(rows[stuck].finished_at);
assert.equal(rows[fresh].status, "running");
assert.equal(rows[done].status, "done");
const n = (
  await db.query(
    "select user_id,title,link from notifications where kind='social_leads'",
  )
).rows;
assert.equal(n.length, 1);
assert.equal(n[0].user_id, lorena);
assert.equal(n[0].title, "A geração do plano de Aurora falhou");
assert.match(n[0].link, new RegExp(`\\?contrato=${stuckContract}$`));
// De novo não avisa outra vez.
assert.equal(
  (await db.query("select mavi_private.social_leads_expire_jobs() n")).rows[0]
    .n,
  0,
);
console.log("PASS geração presa vira falha e avisa quem pediu");

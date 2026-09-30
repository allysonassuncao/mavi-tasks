// Financeiro › Mídia: how long the page's queries take with a real-sized
// portfolio (≈1.300 clients, 3.000 contracted products, 8.000 credits and
// 400.000 days of Campanhas spend). PGlite is slower than the real database;
// the numbers are for comparing versions.
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const id = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [co, admin] = [id(1), id(10)];
await db.query(`insert into auth.users(id) values ($1)`, [admin]);
await db.query(`insert into companies(id,name) values ($1,'Bench')`, [co]);
await db.query(`insert into memberships(company_id,user_id,name,role) values ($1,$2,'Admin','admin')`, [co, admin]);
await db.exec(`
insert into products(company_id,name) values ('${co}','Make Ads'),('${co}','SEO'),('${co}','Social');
insert into clients(company_id,name) select '${co}', (1000 + n)::text from generate_series(1,1300) n;
insert into contracts(company_id,client_id,product_id,name)
 select l.company_id, l.id, p.id, p.name from clients l join products p on p.company_id = l.company_id
 where p.name = 'Make Ads' or (p.name = 'SEO' and l.name::int % 2 = 0) or (p.name = 'Social' and l.name::int % 3 = 0);
`);
const t0 = Date.now();
await db.exec(`
insert into media_entries(company_id, contract_id, kind, amount, occurred_on, source, category_id, reason, created_by, created_at)
 select k.company_id, k.id, 'credit', 3000, date '2024-01-01' + (g * 30), 'manual',
  (select id from media_categories where company_id = k.company_id and name = 'Depósito do cliente'), 'Importado do MASO', '${admin}',
  now() - interval '1 day' * g
 from contracts k join products p on p.id = k.product_id and p.name = 'Make Ads' cross join generate_series(0, 5) g;
insert into media_entries(company_id, contract_id, kind, amount, occurred_on, source, reason, cycle_id, day, spend, multiplier, created_at)
 select k.company_id, k.id, 'debit', 100 + (d % 50), date '2025-01-01' + d, 'campaign', 'Gasto Meta', gen_random_uuid(), date '2025-01-01' + d, 80, 1.3,
  now() - interval '1 hour' * d
 from (select k.* from contracts k join products p on p.id = k.product_id and p.name = 'Make Ads' limit 800) k cross join generate_series(0, 499) d;
`);
console.log(`dados: ${(await db.query("select count(*)::int n from media_entries")).rows[0].n} lançamentos em ${Date.now() - t0} ms`);
await db.exec("analyze");
await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [admin]);
await db.exec("set role authenticated");
const big = (await db.query(`select contract_id from media_entries group by 1 order by count(*) desc limit 1`).catch(() => null))?.rows?.[0]?.contract_id;
await db.exec("reset role");
const k = big ?? (await db.query(`select contract_id from media_entries group by 1 order by count(*) desc limit 1`)).rows[0].contract_id;
await db.exec("set role authenticated");
async function time(label, sql, args) {
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    await db.query(sql, args);
    runs.push(performance.now() - t);
  }
  runs.sort((a, b) => a - b);
  console.log(`${label.padEnd(34)} ${runs[2].toFixed(1).padStart(8)} ms (mediana de 5)`);
}
await time("media_accounts (lista)", "select public.media_accounts($1, false)", [co]);
await time("media_accounts (todos os produtos)", "select public.media_accounts($1, true)", [co]);
await time("media_categories", "select public.media_categories($1)", [co]);
await time("media_statement (500 dias, 1ª página)", "select public.media_statement($1,$2,null,null,'',null,100,0)", [co, k]);
await time("media_statement (período de 30 dias)", "select public.media_statement($1,$2,'2025-06-01','2025-06-30','',null,100,0)", [co, k]);
await db.exec("reset role");
const t = performance.now();
await db.query(`insert into media_entries(company_id, contract_id, kind, amount, occurred_on, source, category_id, reason, created_by)
 values ($1,$2,'credit',10,'2026-09-01','manual',(select id from media_categories where company_id=$1 and name='Ajuste'),'Teste',$3)`, [co, k, admin]);
console.log(`${"um lançamento (com gatilhos)".padEnd(34)} ${(performance.now() - t).toFixed(1).padStart(8)} ms`);
{
  await db.exec("set role authenticated");
  const { rows } = await db.query("select public.media_accounts($1, false)::text as j", [co]);
  const { gzipSync } = await import("node:zlib");
  const n = JSON.parse(rows[0].j).accounts.length;
  console.log(`${"resposta da lista".padEnd(34)} ${n} contas, ${(rows[0].j.length / 1024).toFixed(0)} KB (${(gzipSync(rows[0].j).length / 1024).toFixed(0)} KB comprimido)`);
}

// Financeiro › Mídia: the MASO media credits import (import-maso-media.mjs).
// Rules on a small dump, then the generated SQL run on a database with every
// migration: the account of each client (named after the MASO id), who made
// each entry, vouchers, what stays out, and that running it again adds nothing.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase } from "./database-fixture.mjs";
import { buildEntries, main } from "./import-maso-media.mjs";

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

const dump = `INSERT INTO \`usuarios_make_midia\` (\`id\`, \`id_cliente\`, \`id_transacao\`, \`valor\`, \`competencia\`, \`tipo\`, \`voucher\`, \`somavel\`, \`id_usuario_maso\`, \`motivo\`, \`data\`, \`hora\`) VALUES
(1, 774, 'a', '3000.00', '2026-09-01', '2', 0, 1, 73, 'Pix d\\'Ávila', '2026-09-28', '11:26:56'),
(2, 774, 'b', '500.50', '2026-08-01', '3', 1, 1, 135, 'Voucher\\nreativação', '2026-08-10', '09:00:00'),
(3, 774, 'c', '100.00', '2026-08-01', '1', 0, 1, 75, '', '2026-08-10', '09:00:00'),
(4, 774, 'd', '100.00', '2026-08-01', '2', 0, 0, 75, 'runrun', '2026-08-10', '09:00:00'),
(5, 774, 'e', '0.00', '2026-08-01', '2', 0, 1, 75, '', '2026-08-10', '09:00:00'),
(6, 900, 'f', '250.00', '2021-05-01', '2', 0, 1, 75, '', '0000-00-00', '00:00:00'),
(7, 901, 'g', '10.00', '2026-01-01', '2', 0, 1, 1, 'sem Make Ads', '2026-01-05', '10:00:00'),
(8, 999, 'h', '10.00', '2026-01-01', '2', 0, 1, 1, 'sem cliente', '2026-01-05', '10:00:00'),
(9, 774, 'i', '-50.00', '2026-01-01', '2', 0, 1, 1, 'negativo', '2026-01-05', '10:00:00'),
(10, 774, 'j', '', '2026-01-01', '2', 0, 1, 1, 'vazio', '2026-01-05', '10:00:00');
`;

await check("regras: tipos 2 e 3, somáveis, valor positivo, data ou competência", async () => {
  const { parseSqlDump } = await import("./import-maso-campaigns.mjs");
  const rows = parseSqlDump(dump).get("usuarios_make_midia");
  const { entries, skipped } = buildEntries(rows);
  assert.deepEqual(entries.map((e) => e.id), [1, 2, 6, 7, 8]);
  assert.deepEqual(skipped, {
    "tipo 1": 1,
    "não somável": 1,
    "valor zero": 1,
    "valor negativo": 1,
    "valor vazio ou ilegível": 1,
  });
  const [a, b, , c] = entries;
  assert.equal(a.reason, "Importado do MASO #1 (tipo 2): Pix d'Ávila");
  assert.equal(a.email, "financeiro@makevendas.com.br");
  assert.equal(a.registered_at, "2026-09-28 11:26:56");
  assert.equal(b.voucher, true);
  assert.equal(b.email, "andrey@makevendas.com.br");
  assert.equal(b.reason, "Importado do MASO #2 (tipo 3): Voucher reativação");
  // No date: the competence month, at noon.
  assert.equal(entries[2].occurred_on, "2021-05-01");
  assert.equal(entries[2].registered_at, "2021-05-01 12:00:00");
  assert.equal(c.email, "allyson@makevendas.com.br");
});

// The SQL on a real schema.
const dir = await mkdtemp(join(tmpdir(), "maso-midia-"));
await writeFile(join(dir, "dump.sql"), dump);
await main(["--input", join(dir, "dump.sql"), "--out-dir", dir], () => {});
const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, fin, ally, andrey] = [1, 2, 10, 11, 12].map(uid);
await db.query(
  `insert into auth.users(id,email) values ($1,'financeiro@makevendas.com.br'),($2,'Allyson@makevendas.com.br'),($3,'andrey@makevendas.com.br')`,
  [fin, ally, andrey],
);
await db.query(`insert into companies(id,name) values($1,'Make'),($2,'Outra')`, [A, B]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values ($1,$2,'Financeiro','admin'),($1,$3,'Allyson','admin'),($1,$4,'Andrey','manager')`,
  [A, fin, ally, andrey],
);
const one = async (text, args = []) => (await db.query(text, args)).rows[0];
const make = (await one(`insert into products(company_id,name) values($1,'Make Ads') returning id`, [A])).id;
const seo = (await one(`insert into products(company_id,name) values($1,'SEO') returning id`, [A])).id;
const client = async (name) =>
  (await one(`insert into clients(company_id,name) values($1,$2) returning id`, [A, name])).id;
const c774 = await client("774");
const c900 = await client(" 900 ");
const c901 = await client("901");
const k774 = (await one(`insert into contracts(company_id,client_id,product_id,name) values($1,$2,$3,'Make Ads') returning id`, [A, c774, make])).id;
await one(`insert into contracts(company_id,client_id,product_id,name) values($1,$2,$3,'SEO') returning id`, [A, c774, seo]);
const k900 = (await one(`insert into contracts(company_id,client_id,product_id,name) values($1,$2,$3,'Make Ads') returning id`, [A, c900, make])).id;
await one(`insert into contracts(company_id,client_id,product_id,name) values($1,$2,$3,'SEO') returning id`, [A, c901, seo]);

const run = async (file) => {
  const results = await db.exec(await readFile(join(dir, file), "utf8"));
  return results.filter((r) => r.rows?.length).map((r) => r.rows);
};

await check("conferência: mostra quem entra e quem fica de fora, sem mudar nada", async () => {
  const out = await run("01-conferencia.sql");
  const report = out.at(-1);
  assert.deepEqual(
    report.map((r) => [r.problema, Number(r.clientes), Number(r.lancamentos), r.ids_do_maso]),
    [
      [null, 2, 3, null],
      ["cliente sem o produto Make Ads", 1, 1, "901"],
      ["sem cliente com esse nome no MAVI", 1, 1, "999"],
    ],
  );
  assert.ok(out.at(-2).every((r) => r.encontrado));
  assert.equal((await one("select count(*)::int as n from media_entries")).n, 0);
});

await check("importação: entradas na conta Make Ads, com quem lançou, categoria e horário do MASO", async () => {
  const out = await run("02-importacao.sql");
  assert.equal(Number(out.at(-2)[0].importadas_agora), 3);
  const rows = (
    await db.query(
      `select e.contract_id, e.amount::float, e.occurred_on::text, e.kind, e.source, g.name as category,
        m.name as who, e.reason, to_char(e.created_at at time zone 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI') as at
       from media_entries e join media_categories g on g.id = e.category_id
       join memberships m on m.company_id = e.company_id and m.user_id = e.created_by order by e.created_at`,
    )
  ).rows;
  assert.deepEqual(rows, [
    { contract_id: k900, amount: 250, occurred_on: "2021-05-01", kind: "credit", source: "manual",
      category: "Depósito do cliente", who: "Financeiro", reason: "Importado do MASO #6 (tipo 2)", at: "2021-05-01 12:00" },
    { contract_id: k774, amount: 500.5, occurred_on: "2026-08-10", kind: "credit", source: "manual",
      category: "Bônus ou cortesia", who: "Andrey", reason: "Importado do MASO #2 (tipo 3): Voucher reativação", at: "2026-08-10 09:00" },
    { contract_id: k774, amount: 3000, occurred_on: "2026-09-28", kind: "credit", source: "manual",
      category: "Depósito do cliente", who: "Financeiro", reason: "Importado do MASO #1 (tipo 2): Pix d'Ávila", at: "2026-09-28 11:26" },
  ]);
  assert.equal((await one("select count(*)::int as n from notifications")).n, 0, "credits don't alert");
});

await check("rodar de novo não duplica", async () => {
  const out = await run("02-importacao.sql");
  assert.equal(Number(out.at(-2)[0].importadas_agora), 0);
  assert.equal(Number(out.at(-2)[0].ja_estavam_importadas), 3);
  assert.equal((await one("select count(*)::int as n from media_entries")).n, 3);
});

await check("sem a pessoa na empresa, nada entra", async () => {
  await db.query("update memberships set active = false where user_id = $1", [andrey]);
  await db.query("alter table media_entries disable trigger media_entries_frozen");
  await db.query("delete from media_entries");
  await db.query("alter table media_entries enable trigger media_entries_frozen");
  await assert.rejects(run("02-importacao.sql"), /Sem pessoa ativa na empresa para: andrey@/);
  await db.exec("rollback");
  assert.equal((await one("select count(*)::int as n from media_entries")).n, 0);
});

console.log(`${passed} checks passed`);

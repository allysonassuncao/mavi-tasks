// Onboarding, Fase 2 (migration 20270625090000_tutorial_tours_reach): público
// por squad e por quem atende clientes e produtos, "só nas telas de" um
// cliente/produto (a tela manda cliente, produto, contrato, campanha ou
// tarefa) e as escolhas por passo (registro, clique de verdade).
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, ana, beto, caio, duda] = [1, 10, 11, 12, 13, 14].map(uid);
const [teamX, teamY, client1, client2, prodP, prodQ, k1, k2, squad, camp, task] = [20, 21, 30, 31, 40, 41, 50, 51, 60, 70, 80].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, ana, beto, caio, duda]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Admin','admin',true),($1,$3,'Ana','member',true),($1,$4,'Beto','member',true),
   ($1,$5,'Caio','member',true),($1,$6,'Duda','member',true)`,
  [A, admin, ana, beto, caio, duda],
);
const sql = (text, args = []) => db.query(text, args);
await sql(`insert into teams(id,company_id,name) values($1,$3,'Equipe X'),($2,$3,'Equipe Y')`, [teamX, teamY, A]);
await sql(`insert into team_members(company_id,team_id,user_id) values($1,$2,$3),($1,$4,$5)`, [A, teamX, ana, teamY, beto]);
await sql(`insert into clients(id,company_id,name) values($1,$3,'Cliente 1'),($2,$3,'Cliente 2')`, [client1, client2, A]);
await sql(`insert into products(id,company_id,name) values($1,$3,'Produto P'),($2,$3,'Produto Q')`, [prodP, prodQ, A]);
await sql(`insert into contracts(id,company_id,client_id,product_id,name) values($1,$3,$4,$5,'1·P'),($2,$3,$6,$7,'2·Q')`, [
  k1, k2, A, client1, prodP, client2, prodQ,
]);
// Ana atende o Cliente 1 (equipe X, extra); Beto atende o Produto Q (equipe Y).
await sql(`insert into client_teams(company_id,client_id,team_id,manual) values($1,$2,$3,true)
 on conflict (company_id,client_id,team_id) do update set manual = true`, [A, client1, teamX]);
await sql(`insert into product_teams(company_id,product_id,team_id) values($1,$2,$3)`, [A, prodQ, teamY]);
await sql(`insert into cs_squads(id,company_id,name) values($1,$2,'Squad Azul')`, [squad, A]);
await sql(`insert into cs_squad_members(company_id,squad_id,user_id) values($1,$2,$3)`, [A, squad, caio]);
await sql(`insert into ad_campaigns(id,company_id,contract_id,name,platform,created_by) values($1,$2,$3,'Campanha','meta',$4)`, [
  camp, A, k2, admin,
]);
await sql(
  `insert into tasks(id,company_id,contract_id,title,assignee_id,creator_id,due_date,original_due_date)
   values($1,$2,$3,'Tarefa',$4,$4,current_date,current_date)`,
  [task, A, k1, admin],
);

async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user ?? ""]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
async function rpc(name, args) {
  return (await db.query(`select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})) as result`, args))
    .rows[0].result;
}
const rows = async (name, args) =>
  (await db.query(`select * from public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})`, args)).rows;
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
const body = (text) =>
  "mavi:richtext:v1:" +
  JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const step = (id, extra = {}) => ({
  id,
  kind: "next",
  placement: "auto",
  page: "tasks",
  url: "/tarefas",
  title: "Passo",
  body: body("Texto"),
  target: { tag: "button", text: "Salvar" },
  ...extra,
});
const tour = (extra = {}) => ({
  title: "Tour",
  summary: "",
  steps: [step("passo1")],
  modules: ["tasks"],
  aud_all: false,
  aud_roles: [],
  aud_teams: [],
  aud_users: [],
  aud_exclude: [],
  ...extra,
});
const publish = async (content) => {
  await as(admin);
  return rpc("save_tutorial_tour", [A, null, content, true, null]);
};
const sees = async (user, ctx = null) => {
  await as(user);
  return (await rows("list_tutorial_tours", [A, "library", null, null, ctx])).map((r) => r.title).sort();
};

await check("squad, quem atende o cliente e quem atende o produto recebem", async () => {
  await publish(tour({ title: "Squad", aud_squads: [squad] }));
  await publish(tour({ title: "Cliente 1", aud_clients: [client1] }));
  await publish(tour({ title: "Produto Q", aud_products: [prodQ] }));
  assert.deepEqual(await sees(caio), ["Squad"]);
  assert.deepEqual(await sees(ana), ["Cliente 1"]);
  assert.deepEqual(await sees(beto), ["Produto Q"]);
  assert.deepEqual(await sees(duda), []);
  // Entrou na equipe do produto: passa a receber na hora.
  await db.exec("reset role");
  await sql(`insert into team_members(company_id,team_id,user_id) values($1,$2,$3)`, [A, teamY, duda]);
  assert.deepEqual(await sees(duda), ["Produto Q"]);
});

await check("ids de fora da empresa somem; nenhum público é recusado", async () => {
  await as(admin);
  const r = await rpc("save_tutorial_tour", [A, null, tour({ title: "Lixo", aud_clients: [uid(999)], aud_teams: [teamX] }), false, null]);
  const d = await rpc("tutorial_tour_detail", [r.id]);
  assert.deepEqual(d.audience.aud_clients, []);
  assert.deepEqual(d.audience.aud_teams, [teamX]);
  await assert.rejects(
    () => rpc("save_tutorial_tour", [A, null, tour({ title: "Ninguém", aud_clients: [uid(999)] }), false, null]),
    /Escolha quem recebe/,
  );
  await rpc("delete_tutorial_tour", [r.id]);
});

await check("só nas telas de: a tela diz cliente, contrato, campanha ou tarefa", async () => {
  await publish(tour({ title: "Telas do Cliente 2", aud_all: true, scr_clients: [client2] }));
  await publish(tour({ title: "Telas do Produto P", aud_all: true, scr_products: [prodP] }));
  const restricted = (list) => list.filter((t) => t.startsWith("Telas"));
  // Sem tela (aba Onboarding): todos aparecem.
  assert.deepEqual(restricted(await sees(duda)), ["Telas do Cliente 2", "Telas do Produto P"]);
  // Uma tela qualquer: nenhum dos dois.
  assert.deepEqual(restricted(await sees(duda, {})), []);
  assert.deepEqual(restricted(await sees(duda, { clients: [client2] })), ["Telas do Cliente 2"]);
  assert.deepEqual(restricted(await sees(duda, { products: [prodP] })), ["Telas do Produto P"]);
  assert.deepEqual(restricted(await sees(duda, { contracts: [k1] })), ["Telas do Produto P"]);
  assert.deepEqual(restricted(await sees(duda, { campaign: camp })), ["Telas do Cliente 2"]);
  assert.deepEqual(restricted(await sees(duda, { task })), ["Telas do Produto P"]);
  assert.deepEqual(restricted(await sees(duda, { task: "nada", campaign: uid(999) })), []);
  await as(admin);
  const l = await rows("list_tutorial_tours", [A, "admin", null, null, {}]);
  assert.equal(l.filter((t) => t.screen_only).length, 2);
});

await check("passo: registro e clique de verdade conferidos", async () => {
  await as(admin);
  const r = await rpc("save_tutorial_tour", [
    A,
    null,
    tour({
      title: "Passos",
      aud_all: true,
      steps: [
        step("passo1", { kind: "click", record: "same", real: false }),
        step("passo2", { kind: "auto", record: "outro", real: false }),
        step("passo3"),
      ],
    }),
    false,
    null,
  ]);
  const d = await rpc("tutorial_tour_detail", [r.id]);
  assert.deepEqual(
    d.steps.map((s) => [s.record, s.real]),
    [
      ["same", false],
      ["any", true],
      ["any", true],
    ],
  );
});

console.log(`\n${passed} verificações passaram.`);

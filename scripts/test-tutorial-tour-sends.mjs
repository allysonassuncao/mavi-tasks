// Onboarding: envios agendados (migration 20270703150000_tutorial_tour_sends).
// Data e público por envio, entrega pela rotina (ou na hora), acesso para
// quem recebe, "só quem ainda não fez" × todos, avisos na caixa de entrada
// e/ou push, rascunho espera, cancelar, o começar dá o envio como recebido.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, manager, ana, beto, caio, team, squad] = [1, 10, 11, 12, 13, 14, 20, 30].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, manager, ana, beto, caio]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Admin','admin',true),($1,$3,'Gabi','manager',true),($1,$4,'Ana','member',true),
   ($1,$5,'Beto','member',true),($1,$6,'Caio','member',true)`,
  [A, admin, manager, ana, beto, caio],
);
await db.query(`insert into teams(id,company_id,name) values($1,$2,'Tráfego')`, [team, A]);
await db.query(`insert into team_members(company_id,team_id,user_id) values($1,$2,$3),($1,$2,$4)`, [A, team, ana, caio]);
await db.query(`insert into cs_squads(id,company_id,name) values($1,$2,'Squad Azul')`, [squad, A]);
await db.query(`insert into cs_squad_members(company_id,squad_id,user_id) values($1,$2,$3)`, [A, squad, beto]);

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
const body = (text) =>
  "mavi:richtext:v1:" +
  JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const content = (extra = {}) => ({
  title: "Novidade: filtros",
  summary: "Os filtros novos da lista de tarefas.",
  steps: [{ id: "passo1", kind: "next", page: "tasks", url: "/tarefas", title: "Filtros", body: body("x"), target: null }],
  modules: ["tasks"],
  // O próprio onboarding só é para o admin: o envio dá acesso a quem recebe.
  aud_all: false,
  aud_roles: [],
  aud_teams: [],
  aud_users: [admin],
  aud_exclude: [],
  ...extra,
});
const autos = async (user) => {
  await as(user);
  return rows("my_auto_tutorial_tours", [A]);
};
const inbox = (user) =>
  sql(`select title, link, push from notifications where user_id = $1 and kind = 'tutorial' order by created_at`, [user]);
const later = (h) => new Date(Date.now() + h * 3600_000).toISOString();

await as(manager);
const tour = await rpc("save_tutorial_tour", [A, null, content(), true, null]);

let squadSend;
await check("agendado para depois: nada sai até a hora; a rotina entrega", async () => {
  await as(manager);
  squadSend = await rpc("save_tutorial_tour_send", [tour.id, null, { starts_at: later(2), aud_squads: [squad] }]);
  assert.equal(squadSend.status, "scheduled");
  assert.equal((await autos(beto)).length, 0);
  await as(beto);
  assert.equal(await rpc("tutorial_tour_detail", [tour.id]), null);
  // Chega a hora.
  await sql(`update tutorial_tour_sends set starts_at = now() - interval '1 minute' where id = $1`, [squadSend.id]);
  assert.equal((await sql(`select mavi_private.tutorial_tour_sends_run() as n`))[0].n, 1);
  const a = await autos(beto);
  assert.equal(a.length, 1);
  assert.equal(a[0].id, tour.id);
  assert.equal(a[0].send_id, squadSend.id);
  await as(beto);
  assert.ok(await rpc("tutorial_tour_detail", [tour.id]));
  assert.deepEqual(await inbox(beto), [
    { title: "Novidade: Novidade: filtros", link: `/tutoriais?aba=onboarding&iniciar=${tour.id}`, push: true },
  ]);
  const msg = await sql(`select payload from realtime.messages where payload->>'send' = $1`, [squadSend.id]);
  assert.equal(msg.length, 1);
  // A rotina não entrega de novo.
  assert.equal((await sql(`select mavi_private.tutorial_tour_sends_run() as n`))[0].n, 0);
});

await check("começar dá o envio como recebido", async () => {
  await as(beto);
  await rpc("set_tutorial_tour_progress", [tour.id, "start", 0, "passo1"]);
  assert.equal((await autos(beto)).length, 0);
  await as(manager);
  const l = await rows("tutorial_tour_sends", [tour.id]);
  assert.equal(l[0].people, 1);
  assert.equal(l[0].started, 1);
  assert.equal(l[0].completed, 0);
});

await check("só quem ainda não fez × todos; canais escolhidos", async () => {
  // Ana já concluiu (recebeu acesso por um envio antigo).
  await sql(
    `insert into tutorial_tour_progress(company_id,tour_id,user_id,version,status,completed_at,times_completed)
     values($1,$2,$3,1,'completed',now(),1)`,
    [A, tour.id, ana],
  );
  await as(manager);
  let r = await rpc("save_tutorial_tour_send", [
    tour.id,
    null,
    { starts_at: new Date().toISOString(), aud_teams: [team], notify_inbox: true, notify_push: false },
  ]);
  assert.equal(r.status, "sent");
  assert.equal(r.people, 1); // só o Caio
  assert.deepEqual((await inbox(caio)).map((n) => n.push), [false]);
  assert.equal((await inbox(ana)).length, 0);
  await as(manager);
  r = await rpc("save_tutorial_tour_send", [
    tour.id,
    null,
    { starts_at: new Date().toISOString(), aud_users: [ana], repeat_done: true, notify_inbox: false, notify_push: true },
  ]);
  assert.equal(r.people, 1);
  // Só push (sem configuração nos testes): nada na caixa de entrada.
  assert.equal((await inbox(ana)).length, 0);
  assert.equal((await autos(ana))[0].send_id, r.id);
});

await check("rascunho espera; cancelar; quem pode", async () => {
  await as(manager);
  const draft = await rpc("save_tutorial_tour", [A, null, content({ title: "Rascunho" }), false, null]);
  const r = await rpc("save_tutorial_tour_send", [draft.id, null, { starts_at: new Date().toISOString(), aud_all: true }]);
  assert.equal(r.status, "scheduled");
  assert.equal(r.waiting, true);
  await as(manager);
  const d = await rpc("tutorial_tour_detail", [draft.id]);
  await rpc("save_tutorial_tour", [A, draft.id, content({ title: "Rascunho" }), true, d.revision]);
  assert.equal((await sql(`select mavi_private.tutorial_tour_sends_run() as n`))[0].n, 1);
  await as(manager);
  const future = await rpc("save_tutorial_tour_send", [tour.id, null, { starts_at: later(24), aud_all: true }]);
  await rpc("cancel_tutorial_tour_send", [future.id]);
  await assert.rejects(() => rpc("cancel_tutorial_tour_send", [squadSend.id]), /já saiu/);
  await assert.rejects(
    () => rpc("save_tutorial_tour_send", [tour.id, squadSend.id, { starts_at: later(1), aud_all: true }]),
    /já saiu ou foi cancelado/,
  );
  await assert.rejects(() => rpc("save_tutorial_tour_send", [tour.id, null, { starts_at: later(1) }]), /Escolha para quem/);
  await assert.rejects(() => rpc("save_tutorial_tour_send", [tour.id, null, { aud_all: true }]), /data e a hora/);
  await as(caio);
  await assert.rejects(
    () => rpc("save_tutorial_tour_send", [tour.id, null, { starts_at: later(1), aud_all: true }]),
    /Só um administrador ou o gestor/,
  );
  await as(caio);
  assert.deepEqual(await rows("tutorial_tour_sends", [tour.id]), []);
  await as(manager);
  const l = await rows("tutorial_tour_sends", [tour.id]);
  const count = (st) => l.filter((s) => s.status === st).length;
  assert.equal(l.length, 4);
  assert.equal(count("sent"), 3);
  assert.equal(count("canceled"), 1);
});

console.log(`\n${passed} verificações passaram.`);

// MAVI · parar, sair e ser avisado, e ler páginas (migration
// 20261220090000_mavi_runs_scrape): a execução de cada resposta, o pedido
// para parar, o aviso na caixa de entrada para quem saiu, a conversa nova
// que some se a resposta falha vazia, e o poder 'scrape'.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, ana, bia] = [1, 10, 12, 13].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, ana, bia]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values ($1,$2,'Ana Admin','admin',true),($1,$3,'Ana Souza','member',true),($1,$4,'Bia Lima','member',true)`,
  [A, admin, ana, bia],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user ?? ""]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
const q = async (user, text, args = []) => {
  await as(user);
  return (await db.query(text, args)).rows;
};
const one = async (user, text, args = []) => Object.values((await q(user, text, args))[0])[0];
let passed = 0;
async function check(title, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${title}`);
  } catch (e) {
    console.error(`FAIL ${title}`, String(e?.message ?? e).slice(0, 300));
    throw e;
  }
}
const start = (user, conversation, question) =>
  one(user, "select public.ai_run_start($1,$2,$3,'assistant','{}'::jsonb)", [A, conversation, question]);
const save = (user, conversation, question) =>
  one(
    user,
    "select public.ai_save_turn($1,$2,'{}'::jsonb,'assistant',$3,'Resposta','[]'::jsonb,'[]'::jsonb)",
    [A, conversation, question],
  );
const inbox = async (user) =>
  (await q(user, "select kind, title, body, link from notifications where user_id = $1 order by created_at", [user]));

await check("a conversa nova nasce com a resposta; saiu, terminou: aviso com o link", async () => {
  const run = await start(ana, null, "Resuma as reuniões   de setembro");
  assert.equal(run.created, true);
  const [conv] = await q(ana, "select title from ai_conversations where id = $1", [run.conversation]);
  assert.equal(conv.title, "Resuma as reuniões de setembro");
  assert.deepEqual((await one(ana, "select public.ai_runs_active($1)", [A])).map((r) => r.question), ["Resuma as reuniões de setembro"]);
  // Só quem perguntou vê a execução.
  assert.deepEqual(await one(bia, "select public.ai_runs_active($1)", [A]), []);
  assert.equal((await q(bia, "select id from ai_runs")).length, 0);
  // A conexão caiu sem pedido para parar: segue em segundo plano.
  assert.equal(await one(ana, "select public.ai_run_detach($1)", [run.id]), false);
  assert.equal(await one(ana, "select public.ai_run_should_stop($1)", [run.id]), false);
  await save(ana, run.conversation, "Resuma as reuniões de setembro");
  await q(ana, "select public.ai_run_finish($1,'done',null)", [run.id]);
  assert.deepEqual(await inbox(ana), [
    {
      kind: "ai_answer",
      title: "A MAVI terminou de responder",
      body: "Resuma as reuniões de setembro",
      link: `/mavi/conversas/${run.conversation}`,
    },
  ]);
  assert.deepEqual(await one(ana, "select public.ai_runs_active($1)", [A]), []);
  // A tela fica sabendo pelo tópico privado da pessoa (sem postgres_changes).
  await db.exec("reset role");
  const [sent] = (await db.query("select topic, payload from realtime.messages where event = 'ai_run'")).rows;
  assert.equal(sent.topic, `mavi:inbox:${A}:${ana}`);
  assert.deepEqual([sent.payload.id, sent.payload.status, sent.payload.conversation], [run.id, "done", run.conversation]);
  // Terminar de novo não muda nada.
  await q(ana, "select public.ai_run_finish($1,'error','x')", [run.id]);
  assert.equal((await inbox(ana)).length, 1);
});

await check("quem ficou na tela não recebe aviso; parar é pedido e o servidor confere", async () => {
  const conv = await save(bia, null, "Oi");
  const run = await start(bia, conv, "E agora?");
  assert.equal(run.created, false);
  assert.equal(run.conversation, conv);
  await assert.rejects(() => start(ana, conv, "Invadir"), /Só quem começou a conversa/);
  assert.equal(await one(ana, "select public.ai_run_cancel($1)", [run.id]), null);
  assert.equal(await one(bia, "select public.ai_run_cancel($1)", [run.id]), true);
  // Parou pela tela: a conexão cai, mas é para parar (sem aviso).
  assert.equal(await one(bia, "select public.ai_run_detach($1)", [run.id]), true);
  assert.equal(await one(bia, "select public.ai_run_should_stop($1)", [run.id]), true);
  await q(bia, "select public.ai_run_finish($1,'cancelled',null)", [run.id]);
  assert.deepEqual(await inbox(bia), []);
  // Na tela até o fim: sem aviso.
  const again = await start(bia, conv, "Mais uma");
  await q(bia, "select public.ai_run_finish($1,'done',null)", [again.id]);
  assert.deepEqual(await inbox(bia), []);
});

await check("falhou sem nada salvo: a conversa nova sai; o aviso diz que não terminou", async () => {
  const run = await start(ana, null, "Pergunta que falha");
  await q(ana, "select public.ai_run_detach($1)", [run.id]);
  await q(ana, "select public.ai_run_finish($1,'error','O provedor caiu')", [run.id]);
  assert.equal((await q(ana, "select id from ai_conversations where id = $1", [run.conversation])).length, 0);
  const last = (await inbox(ana)).at(-1);
  assert.deepEqual(last, {
    kind: "ai_answer",
    title: "A MAVI não conseguiu terminar a resposta",
    body: "Pergunta que falha",
    link: "/mavi/conversas",
  });
  // Quem desligou o aviso nas preferências não recebe.
  await q(ana, "select public.save_notification_prefs($1,'{\"ai_answer\":false}'::jsonb)", [A]);
  const off = await start(ana, null, "Sem aviso");
  await q(ana, "select public.ai_run_detach($1)", [off.id]);
  await save(ana, off.conversation, "Sem aviso");
  await q(ana, "select public.ai_run_finish($1,'done',null)", [off.id]);
  assert.equal((await inbox(ana)).length, 2);
});

await check("execução esquecida (a função caiu) vira erro na próxima; o poder 'scrape'", async () => {
  const run = await start(bia, null, "Velha");
  await db.exec("reset role");
  await db.query("update ai_runs set started_at = now() - interval '20 minutes' where id = $1", [run.id]);
  await start(bia, null, "Nova");
  await db.exec("reset role");
  assert.equal((await db.query("select status from ai_runs where id = $1", [run.id])).rows[0].status, "error");
  const powers = (await one(admin, "select public.ai_powers_admin($1)", [A])).map((p) => p.power);
  assert.ok(powers.includes("scrape"));
  await q(admin, "select public.ai_set_power($1,'scrape',true,true,'{}','{}','{}')", [A]);
  assert.ok((await one(ana, "select public.ai_my_powers($1)", [A])).includes("scrape"));
  await q(ana, "select public.ai_log_tool_calls($1,null,'assistant',$2::jsonb)", [A, JSON.stringify([{ tool: "scrape_pages", power: "scrape", ok: true, ms: 800 }])]);
  await db.exec("reset role");
  assert.equal((await db.query("select power from ai_tool_calls where tool = 'scrape_pages'")).rows[0].power, "scrape");
});

console.log(`\n${passed} checks passed`);

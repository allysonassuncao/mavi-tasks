// Radar pessoal · o próximo passo (migration 20270513090000_personal_radar_next_step):
// quem atende o cliente para a tarefa sugerida, a sugestão conferida ao
// gravar a resposta, o "boa resposta" com motivos (e desmarcar), a tarefa
// criada pelo formulário (com o que mudou) ou dispensada, e as lições de
// tarefa no aprendizado da pessoa e do produto.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, ana, gabi, fora] = [1, 10, 11, 13, 14].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, ana, gabi, fora]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,email,role,active) values
   ($1,$2,'Ana Admin','ana@make.com','admin',true),($1,$3,'Ana Design','design@make.com','member',true),
   ($1,$4,'Gabi Gestora','gabi@make.com','manager',true),($1,$5,'Fábio Fora','fabio@make.com','member',true)`,
  [A, admin, ana, gabi, fora],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user ?? ""]);
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
async function rejects(fn, pattern) {
  await assert.rejects(fn, (e) => pattern.test(e.message));
  await db.exec("reset role");
}
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

await sql(`insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`, [SECRET]);
await as(admin);
const criacao = await rpc("create_team", [A, "Criação", [ana], [gabi]]);
const outra = await rpc("create_team", [A, "Outra", [fora], []]);
const client = await rpc("create_client", [A, "Clínica Sorriso", "", [criacao]]);
const mavi = await rpc("create_product", [A, "MAVI"]);
const contract = await rpc("create_contract", [A, client, mavi, "MAVI · Clínica", criacao]);
const GROUP = uid(900);
await sql(`insert into whatsapp_groups(id, company_id, jid, title, client_id) values ($1,$2,'1@g.us','Clínica',$3)`, [GROUP, A, client]);
// Gabi (gestora, liberada por padrão) usa o Radar pessoal.
await sql(`insert into personal_radar_people(company_id, user_id, active, started_at, about) values ($1,$2,true, now(), 'Atendimento e robô.')`, [A, gabi]);
await sql(`insert into personal_radar_people(company_id, user_id, active, about) values ($1,$2,false,'Artes e criativos.')`, [A, ana]);
const M1 = uid(1001);
await sql(
  `insert into whatsapp_messages(id, company_id, group_id, wa_id, sent_at, sender, sender_phone, sender_name, from_me, kind, body)
   values ($1,$2,$3,'W1', now(),'c@lid','5511911112222','Carla',false,'text','Precisamos de uma arte nova para o sábado.')`,
  [M1, A, GROUP],
);
const [item] = await sql(
  `insert into personal_radar_items(company_id, client_id, group_id, kind, title, summary, first_at, last_at, product_id)
   values ($1,$2,$3,'request','Arte nova para o sábado','Quer arte para o post de sábado.', now(), now(), $4) returning id`,
  [A, client, GROUP, mavi],
);
await sql(`insert into personal_radar_owners(company_id, item_id, user_id, reason) values ($1,$2,$3,'role')`, [A, item.id, gabi]);
await sql(`insert into personal_radar_mentions(company_id, item_id, message_id, role, speaker, quote, at) values ($1,$2,$3,'client','Carla','arte nova', now())`, [A, item.id, M1]);
const store = async (draft) => {
  await sql(`insert into personal_radar_replies(company_id, item_id, user_id, status) values ($1,$2,$3,'running')
   on conflict (item_id, user_id) do update set status = 'running'`, [A, item.id, gabi]);
  await as(gabi);
  return rpc("personal_radar_draft_store", [A, item.id, JSON.stringify(draft), JSON.stringify({ model: "x", cost: 0.01 })]);
};

await check("o contexto da tarefa: só quem atende o cliente, os produtos e as tarefas abertas", async () => {
  await sql(
    `insert into tasks(company_id, contract_id, title, creator_id, assignee_id, due_date, original_due_date)
     values ($1,$2,'Ajustar horário do robô',$3,$4, current_date + 3, current_date + 3)`,
    [A, contract, gabi, ana],
  );
  await as(gabi);
  const c = await rpc("personal_radar_task_context", [A, item.id]);
  assert.deepEqual(c.teams.map((t) => t.name), ["Criação"]);
  assert.deepEqual(c.people.map((p) => p.name).sort(), ["Ana Design", "Gabi Gestora"]);
  assert.equal(c.people.find((p) => p.name === "Ana Design").about, "Artes e criativos.");
  assert.equal(c.people.find((p) => p.name === "Gabi Gestora").me, true);
  assert.deepEqual(c.contracts.map((k) => [k.id, k.product]), [[contract, "MAVI"]]);
  assert.deepEqual(c.open_tasks.map((t) => [t.title, t.assignee]), [["Ajustar horário do robô", "Ana Design"]]);
  await as(ana);
  await rejects(() => rpc("personal_radar_task_context", [A, item.id]), /não encontrado/);
});

await check("a sugestão é conferida ao gravar a resposta: quem não atende sai, equipe só sem pessoa", async () => {
  let j = await store({
    reply: "Oi Carla! Já vou pedir a arte.",
    task: { title: "Criar arte do post de sábado", description: "Pedido da Carla.", assignee_id: fora, team_id: criacao,
      contract_id: contract, due: "2000-01-01", priority: "high", why: "Precisa de arte nova." },
  });
  assert.deepEqual(j.reply.task, {
    title: "Criar arte do post de sábado", description: "Pedido da Carla.", team_id: criacao, contract_id: contract,
    priority: "high", why: "Precisa de arte nova.", team_name: "Criação", product_name: "MAVI",
  });
  j = await store({ reply: "Oi!", task: { title: "Criar arte", assignee_id: ana, team_id: outra, contract_id: uid(999) } });
  assert.deepEqual([j.reply.task.assignee_id, j.reply.task.assignee_name, j.reply.task.team_id, j.reply.task.contract_id], [ana, "Ana Design", undefined, undefined]);
  j = await store({ reply: "Oi!", task: { title: "x" } });
  assert.equal(j.reply.task, undefined);
  j = await store({ reply: "Oi!", task: { title: "Criar arte do post de sábado", assignee_id: ana, contract_id: contract } });
  assert.equal(j.reply.version, 4);
});

await check("boa resposta: com motivos, troca os motivos, desmarca e some do aprendizado", async () => {
  await as(gabi);
  let j = await rpc("personal_radar_reply_like", [A, item.id, true, ["tone", "solved", "invalido"]]);
  assert.ok(j.reply.liked_at);
  assert.deepEqual(j.reply.liked_tags.sort(), ["solved", "tone"]);
  j = await rpc("personal_radar_reply_like", [A, item.id, true, ["data"]]);
  assert.deepEqual(j.reply.liked_tags, ["data"]);
  let fb = await sql(`select snapshot from personal_radar_feedback where action = 'liked'`);
  assert.equal(fb.length, 1);
  assert.deepEqual(fb[0].snapshot.tags, ["data"]);
  assert.equal(fb[0].snapshot.final, "Oi!");
  // O exemplo marcado como boa vale mais.
  const [lp] = await sql(`select product_id from personal_radar_product_learning where company_id = $1`, [A]);
  assert.equal(lp.product_id, mavi);
  j = await rpc("personal_radar_reply_like", [A, item.id, false, []]);
  assert.equal(j.reply.liked_at, undefined);
  fb = await sql(`select count(*)::int as n from personal_radar_feedback where action = 'liked'`);
  assert.equal(fb[0].n, 0);
  await rpc("personal_radar_reply_like", [A, item.id, true, []]);
  await as(ana);
  await rejects(() => rpc("personal_radar_reply_like", [A, item.id, true, []]), /não encontrado/);
});

await check("a tarefa criada pelo formulário liga ao item e ensina o que mudou; dispensar também ensina", async () => {
  const [t] = await sql(
    `insert into tasks(company_id, contract_id, title, creator_id, assignee_id, due_date, original_due_date)
     values ($1,$2,'Criar arte do sábado (stories)',$3,$3, current_date + 2, current_date + 2) returning id`,
    [A, contract, gabi],
  );
  await as(gabi);
  await rejects(() => rpc("personal_radar_task_outcome", [A, item.id, "talvez", null, ""]), /Ação inválida/);
  await rejects(() => rpc("personal_radar_task_outcome", [A, item.id, "created", uid(998), ""]), /Tarefa não encontrada/);
  const j = await rpc("personal_radar_task_outcome", [A, item.id, "created", t.id, ""]);
  assert.deepEqual([j.reply.task.outcome, j.reply.task.task_id, j.task.id], ["created", t.id, t.id]);
  const [fb] = await sql(`select snapshot from personal_radar_feedback where action = 'task_created'`);
  assert.match(fb.snapshot.draft, /^Tarefa sugerida: Criar arte do post de sábado · para Ana Design/);
  assert.match(fb.snapshot.final, /^Tarefa criada: Criar arte do sábado \(stories\) · com Gabi Gestora · mudou: title, assignee$/);
  // Uma resposta nova não traz a sugestão de volta: a tarefa já foi decidida.
  const again = await store({ reply: "Oi de novo!", task: { title: "Outra tarefa qualquer" } });
  assert.equal(again.reply.task.title, "Criar arte do post de sábado");
  assert.equal(again.reply.task.outcome, "created");
  // Dispensar: só com sugestão.
  await sql(`update personal_radar_replies set task_outcome = null where item_id = $1`, [item.id]);
  await as(gabi);
  const d = await rpc("personal_radar_task_outcome", [A, item.id, "dismissed", null, "Era só responder."]);
  assert.equal(d.reply.task.outcome, "dismissed");
  const [x] = await sql(`select note from personal_radar_feedback where action = 'task_dismissed'`);
  assert.equal(x.note, "Era só responder.");
  await sql(`update personal_radar_replies set task_suggestion = null where item_id = $1`, [item.id]);
  await as(gabi);
  await rejects(() => rpc("personal_radar_task_outcome", [A, item.id, "dismissed", null, ""]), /Não há tarefa sugerida/);
});

await check("lições de tarefa: a MAVI e a pessoa escrevem; entram na resposta com as de resposta", async () => {
  await as(null);
  assert.equal(await rpc("ai_personal_radar_learning_store", [SECRET, A, gabi, JSON.stringify([
    { op: "add", kind: "task", text: "Pedido de arte vira tarefa para a equipe Criação." },
  ]), [], "{}"]), 1);
  await as(gabi);
  await rpc("save_personal_radar_lesson", [A, null, "reply", "Chame pelo primeiro nome."]);
  const l = await rpc("personal_radar_reply_lessons", [A, client, mavi]);
  assert.deepEqual(l.map((x) => [x.kind, x.text]).sort(), [
    ["reply", "Chame pelo primeiro nome."],
    ["task", "Pedido de arte vira tarefa para a equipe Criação."],
  ]);
  await rejects(() => rpc("save_personal_radar_lesson", [A, null, "outro", "Tipo inválido aqui."]), /Tipo inválido/);
  await as(admin);
  const p = await rpc("save_personal_radar_product_lesson", [A, null, mavi, "task", "Ajuste no robô vira tarefa."]);
  assert.equal(p.kind, "task");
  // O aprendizado do produto lê o boa e a tarefa.
  await as(null);
  await sql(`update personal_radar_product_learning set dirty_at = now(), learned_at = null, claimed_until = null`);
  await sql(`update personal_radar_feedback set created_at = now() - interval '7 hours'`);
  const c = await rpc("ai_personal_radar_product_claim", [SECRET]);
  assert.deepEqual(c.feedback.map((f) => f.action).sort(), ["liked", "task_created", "task_dismissed"]);
});

console.log(`\n${passed} verificações do próximo passo passaram.`);

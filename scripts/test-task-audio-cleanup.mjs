// Limpeza e armazenamento dos áudios das tarefas (migration
// 20261203090000_task_audio_cleanup): rascunhos com mais de 24 horas saem do
// banco, o arquivo entra na fila do GCS só quando nenhuma linha usa mais o
// caminho, o worker só entra com o segredo, e o Armazenamento conta cada
// caminho uma vez só, no cliente da tarefa.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, creator, doer] = [1, 10, 11, 12].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, creator, doer]]);
await db.query(`insert into companies(id,name) values($1,'Empresa A')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Cris Criadora','member'),($1,$4,'Davi Faz','member')`,
  [A, admin, creator, doer],
);
await db.query(`insert into mavi_private.ai_config(url,secret) values('https://app.example/api/ai',$1)`, [SECRET]);
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
const rows = async (text, args = []) => (await db.query(text, args)).rows;
const sql = async (text, args = []) => {
  await db.exec("reset role");
  return (await db.query(text, args)).rows;
};
const fails = async (fn, pattern) => {
  await assert.rejects(fn, pattern);
  await db.exec("rollback").catch(() => {});
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

await as(admin);
const team = await rpc("create_team", [A, "Equipe", [creator, doer]]);
const client = await rpc("create_client", [A, "Cliente A", ""]);
const product = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [A, client, product, "Contrato A", team]);
const newTask = async (title, repeat = null) => {
  await as(creator);
  return rpc("create_task", [
    A, contract, title, doer, "2026-10-05", null, team, "", "normal", 60, false,
    null, null, null, repeat,
  ]);
};
// Grava e (se `sent`) envia e confirma um rascunho.
const recorded = async (user, { purpose = "description", seconds = 83, size = 64000, sent = true } = {}) => {
  await as(user);
  const a = await rpc("prepare_task_audio", [A, purpose, "audio/webm", size, seconds]);
  return sent ? rpc("confirm_task_audio", [a.id]) : a;
};
const age = (id, hours) =>
  sql("update task_audios set created_at = now() - make_interval(hours => $2) where id = $1", [id, hours]);
const claim = async (limit = 100) => {
  await as(null);
  return (await rows("select path from task_audio_cleanup_claim($1,$2)", [SECRET, limit])).map((r) => r.path);
};
const done = async (ok, failed = [], error = null) => {
  await as(null);
  return rpc("task_audio_cleanup_done", [SECRET, ok, failed, error]);
};
const queue = async () =>
  (await sql("select path from mavi_private.task_audio_cleanup order by path")).map((r) => r.path);
const ledger = (source) =>
  sql("select * from storage_uploads where kind='audio' and source_id=$1", [source]);
const kicks = async () =>
  (await sql("select count(*)::int as n from net.requests where body->>'action'='task-audio-cleanup'"))[0].n;
const clearQueue = () => sql("delete from mavi_private.task_audio_cleanup");

await check("o worker só entra com o segredo", async () => {
  await as(null);
  await fails(() => rows("select * from task_audio_cleanup_claim($1,10)", ["errado"]), /Sem permissão/);
  await fails(() => rpc("task_audio_cleanup_done", ["errado", [], [], null]), /Sem permissão/);
  await as(creator);
  await fails(() => rows("select * from task_audio_cleanup_claim($1,10)", [null]), /Sem permissão/);
  await fails(() => rows("select mavi_private.task_audio_cleanup_kick()"), /permission denied/);
  await fails(() => rows("select * from mavi_private.task_audio_cleanup"), /permission denied/);
});

await check("o agendamento só acorda o worker quando há trabalho", async () => {
  await sql("select mavi_private.task_audio_cleanup_kick()");
  assert.equal(await kicks(), 0, "sem rascunho vencido nem fila, nada");
  const fresh = await recorded(creator);
  await sql("select mavi_private.task_audio_cleanup_kick()");
  assert.equal(await kicks(), 0, "rascunho de hoje ainda pode entrar numa tarefa");
  await age(fresh.id, 25);
  await sql("select mavi_private.task_audio_cleanup_kick()");
  assert.equal(await kicks(), 1);
  const [req] = await sql("select url, headers from net.requests where body->>'action'='task-audio-cleanup'");
  assert.equal(req.url, "https://app.example/api/ai");
  assert.equal(req.headers.Authorization, `Bearer ${SECRET}`);
  // Deixa o rascunho para o próximo passo.
  await sql("delete from net.requests");
});

await check("rascunhos com mais de 24 horas saem; os mais novos e os de tarefa ficam", async () => {
  const [old] = await sql("select * from task_audios where task_id is null");
  const neverSent = await recorded(doer, { purpose: "comment", sent: false });
  await age(neverSent.id, 30);
  const young = await recorded(creator);
  await age(young.id, 23);
  const bound = await recorded(creator);
  await age(bound.id, 48);
  const task = await newTask("Campanha");
  await as(creator);
  await rows("select * from bind_task_audios($1,$2)", [task, [bound.id]]);

  const paths = await claim();
  assert.deepEqual(paths.sort(), [old.path, neverSent.path].sort());
  const left = (await sql("select id from task_audios order by created_at")).map((r) => r.id);
  assert.deepEqual(left.sort(), [young.id, bound.id].sort());
  // Rascunhos não avisam ninguém pelo Realtime nem entram no RAG.
  assert.equal(
    (await sql("select count(*)::int as n from realtime.messages where payload->>'task' is null and payload->>'kind'='extras'"))[0].n,
    0,
  );
  // Pegos, mas não confirmados: não voltam na mesma rodada.
  assert.deepEqual(await claim(), []);
  assert.equal(await done([old.path], [neverSent.path], "GCS 503"), 1);
  const [pending] = await sql("select * from mavi_private.task_audio_cleanup");
  assert.equal(pending.path, neverSent.path);
  assert.equal(pending.attempts, 1);
  assert.equal(pending.last_error, "GCS 503");
  // Depois do intervalo, a falha volta.
  await sql("update mavi_private.task_audio_cleanup set next_attempt_at = now() - interval '1 minute'");
  assert.deepEqual(await claim(), [neverSent.path]);
  await done([neverSent.path]);
  assert.deepEqual(await queue(), []);
});

await check("o limite por rodada vale para os rascunhos e para a fila", async () => {
  const drafts = [];
  for (let i = 0; i < 3; i++) {
    const d = await recorded(doer);
    await age(d.id, 26 + i);
    drafts.push(d);
  }
  assert.equal((await claim(2)).length, 2);
  assert.equal((await sql("select count(*)::int as n from task_audios where task_id is null and created_at < now() - interval '24 hours'"))[0].n, 1);
  const rest = await claim(2);
  assert.equal(rest.length, 1, "o terceiro rascunho sai na rodada seguinte");
  await clearQueue();
});

await check("tirar da tarefa: só a última linha do caminho põe o arquivo na fila", async () => {
  const draft = await recorded(creator);
  const source = await newTask("Relatório semanal", "daily");
  await as(creator);
  await rows("select * from bind_task_audios($1,$2)", [source, [draft.id]]);
  const [{ next_run }] = await sql("select next_run::text from task_recurrences where source_task_id=$1", [source]);
  await sql("select mavi_private.run_task_recurrences($1::date)", [next_run]);
  const [copy] = await sql(
    "select a.* from task_audios a join tasks t on t.id=a.task_id where a.path=$1 and a.id<>$2",
    [draft.path, draft.id],
  );
  assert.ok(copy, "a cópia da repetição aponta para o mesmo arquivo");
  // A cópia fica velha: não é rascunho, não sai.
  await age(copy.id, 72);
  assert.deepEqual(await claim(), []);

  await as(creator);
  assert.equal(await rpc("delete_task_audio", [draft.id]), null);
  assert.deepEqual(await queue(), [], "a cópia ainda toca o arquivo");
  assert.equal((await ledger(draft.id))[0].deleted_at, null);
  assert.equal(await rpc("delete_task_audio", [copy.id]), draft.path);
  assert.deepEqual(await queue(), [draft.path], "a fila garante o arquivo se a tela não apagar");
  assert.notEqual((await ledger(draft.id))[0].deleted_at, null);
  await sql("select mavi_private.task_audio_cleanup_kick()");
  assert.equal(await kicks(), 1);
  assert.deepEqual(await claim(), [draft.path]);
  await done([draft.path]);
});

await check("comentário apagado leva o áudio e põe o arquivo na fila", async () => {
  const task = await newTask("Com comentário");
  const draft = await recorded(doer, { purpose: "comment" });
  await as(doer);
  const c = await rpc("add_audio_comment", [task, "segue o áudio", null, draft.id]);
  await sql("delete from comments where id=$1", [c.id]);
  assert.equal((await sql("select count(*)::int as n from task_audios where id=$1", [draft.id]))[0].n, 0);
  assert.deepEqual(await queue(), [draft.path]);
  await clearQueue();
});

await check("um caminho que voltou a ser usado sai da fila sem ser apagado", async () => {
  const task = await newTask("Volta");
  const draft = await recorded(creator);
  await as(creator);
  await rows("select * from bind_task_audios($1,$2)", [task, [draft.id]]);
  await sql(
    "insert into mavi_private.task_audio_cleanup(path, company_id) values ($1, $2)",
    [draft.path, A],
  );
  assert.deepEqual(await claim(), []);
  assert.deepEqual(await queue(), []);
});

await check("Armazenamento: conta do envio confirmado, cada caminho uma vez só", async () => {
  const pending = await recorded(creator, { sent: false, seconds: 12 });
  let [row] = await ledger(pending.id);
  assert.equal(row.completed_at, null, "ainda enviando, não conta");
  assert.equal(row.name, "Áudio da descrição (0:12)");
  await as(creator);
  await rpc("confirm_task_audio", [pending.id]);
  [row] = await ledger(pending.id);
  assert.notEqual(row.completed_at, null);
  assert.equal(row.user_id, creator);
  assert.equal(Number(row.size_bytes), 64000);

  const source = await newTask("Repete muito", "daily");
  await as(creator);
  await rows("select * from bind_task_audios($1,$2)", [source, [pending.id]]);
  for (let i = 0; i < 3; i++) {
    const [{ next_run }] = await sql("select next_run::text from task_recurrences where source_task_id=$1", [source]);
    await sql("select mavi_private.run_task_recurrences($1::date)", [next_run]);
  }
  assert.equal(
    (await sql("select count(*)::int as n from task_audios where path=$1", [pending.path]))[0].n,
    4,
    "a tarefa e três cópias",
  );
  assert.equal((await ledger(pending.id)).length, 1);

  await as(admin);
  const usage = await rows("select * from storage_usage($1) where kind='audio'", [A]);
  const mine = usage.find((u) => u.user_id === creator);
  const counted = (await sql("select count(*)::int as n from storage_uploads where kind='audio' and completed_at is not null and deleted_at is null and user_id=$1", [creator]))[0].n;
  assert.equal(Number(mine.files), counted);
  const byClient = await rows("select * from storage_usage_by_client($1) where kind='audio'", [A]);
  const ofClient = byClient.find((r) => r.client_id === client);
  assert.ok(ofClient, "o áudio conta no cliente da tarefa");
  const files = await rows("select * from storage_client_files($1,$2,200) where kind='audio'", [A, client]);
  const listed = files.filter((f) => f.source_id === pending.id);
  assert.equal(listed.length, 1, "as cópias não repetem o arquivo");
  assert.equal(listed[0].contract_id, contract);

  // O original sai da tarefa: o arquivo continua no cliente pela cópia.
  await as(creator);
  await rpc("delete_task_audio", [pending.id]);
  await as(admin);
  const still = await rows("select * from storage_client_files($1,$2,200) where source_id=$3", [A, client, pending.id]);
  assert.equal(still.length, 1);
  assert.equal(still[0].contract_id, contract);
});

await check("Armazenamento: rascunho sem cliente; ao vencer, deixa de contar", async () => {
  const draft = await recorded(doer, { purpose: "comment", seconds: 125 });
  await as(admin);
  const loose = await rows("select * from storage_client_files($1,null,200) where source_id=$2", [A, draft.id]);
  assert.equal(loose.length, 1);
  assert.equal(loose[0].name, "Áudio de comentário (2:05)");
  await age(draft.id, 25);
  assert.deepEqual(await claim(), [draft.path]);
  assert.notEqual((await ledger(draft.id))[0].deleted_at, null, "o histórico fica, sem contar");
  await as(admin);
  assert.equal((await rows("select * from storage_client_files($1,null,200) where source_id=$2", [A, draft.id])).length, 0);
});

await check("quem não é gestor não vê o armazenamento dos outros", async () => {
  await as(doer);
  await fails(() => rows("select * from storage_usage($1)", [A]), /Sem permissão/);
  const visible = await rows("select distinct user_id from storage_uploads where kind='audio'");
  assert.deepEqual(visible.map((r) => r.user_id), [doer]);
});

console.log(`${passed} task audio cleanup checks passed`);

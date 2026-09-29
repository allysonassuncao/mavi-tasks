// Áudio na descrição e nos comentários, e anexos de qualquer tipo
// (migration 20261201090000_task_audio): rascunho → envio → tarefa ou
// comentário, quem cuida de cada áudio, a correção da transcrição, as cópias
// da repetição, a busca e os executáveis barrados.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, creator, doer, other, stranger] = [1, 2, 10, 11, 12, 13, 14].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, creator, doer, other, stranger],
]);
await db.query(`insert into companies(id,name) values($1,'Empresa A'),($2,'Empresa B')`, [A, B]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Cris Criadora','member'),
   ($1,$4,'Davi Faz','member'),($1,$5,'Olga Outra','member'),($6,$7,'Sem Vínculo','admin')`,
  [A, admin, creator, doer, other, B, stranger],
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
const team = await rpc("create_team", [A, "Equipe", [creator, doer, other]]);
const client = await rpc("create_client", [A, "Cliente A", ""]);
const product = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [A, client, product, "Contrato A", team]);
const newTask = async (user, title = "Campanha de outubro", repeat = null) => {
  await as(user);
  return rpc("create_task", [
    A, contract, title, doer, "2026-10-05", null, team, "", "normal", 60, false,
    null, null, null, repeat,
  ]);
};
// Grava, envia e confirma um rascunho.
const recorded = async (user, purpose = "description", seconds = 42) => {
  await as(user);
  const a = await rpc("prepare_task_audio", [A, purpose, "audio/webm;codecs=opus", 64000, seconds]);
  const target = await rows("select * from public.task_audio_upload_target($1)", [a.id]);
  assert.equal(target.length, 1, "o rascunho recém-preparado pode ser enviado");
  return rpc("confirm_task_audio", [a.id]);
};

await check("rascunho: só quem gravou vê e envia; formato e duração conferidos", async () => {
  const a = await recorded(creator);
  assert.equal(a.status, "transcribing");
  assert.equal(a.mime, "audio/webm");
  assert.equal(a.path, `${A}/audio/${a.id}`);
  assert.equal(a.task_id, null);
  await as(other);
  assert.equal((await rows("select id from task_audios where id=$1", [a.id])).length, 0);
  assert.equal((await rows("select * from task_audio_upload_target($1)", [a.id])).length, 0);
  await as(creator);
  // Já enviado: não assina outro envio.
  assert.equal((await rows("select * from task_audio_upload_target($1)", [a.id])).length, 0);
  await fails(() => rpc("prepare_task_audio", [A, "description", "audio/webm", 1000, 400]), /5 minutos/);
  await fails(() => rpc("prepare_task_audio", [A, "description", "video/mp4", 1000, 10]), /Formato/);
  await as(stranger);
  await fails(() => rpc("prepare_task_audio", [A, "description", "audio/webm", 1000, 10]), /Sem permissão/);
});

let task;
await check("na criação, os rascunhos entram na descrição em ordem e avisam a tarefa", async () => {
  const first = await recorded(creator);
  const second = await recorded(creator);
  task = await newTask(creator);
  await as(creator);
  const bound = (await rows("select to_jsonb(b) as r from bind_task_audios($1,$2) b", [task, [first.id, second.id]])).map((r) => r.r);
  assert.deepEqual(bound.map((b) => [b.id, b.position]), [[first.id, 0], [second.id, 1]]);
  const extras = await rpc("task_extras", [task]);
  assert.deepEqual(extras.audios.map((a) => a.id), [first.id, second.id]);
  assert.equal("working_at" in extras.audios[0], false);
  const notices = await sql(
    "select payload from realtime.messages where payload->>'task'=$1 and payload->>'kind'='extras'",
    [task],
  );
  assert.ok(notices.length >= 2, "cada áudio que entra avisa quem está com a tarefa");
  assert.equal(
    (await sql("select count(*)::int as n from task_events where task_id=$1 and action='audio_added'", [task]))[0].n,
    1,
  );
  // Quem executa ouve, mas não mexe na descrição.
  await as(doer);
  assert.equal((await rpc("task_extras", [task])).audios.length, 2);
  const mine = await recorded(doer);
  await as(doer);
  await fails(() => rows("select * from bind_task_audios($1,$2)", [task, [mine.id]]), /Sem permissão/);
  await fails(() => rpc("delete_task_audio", [first.id]), /Sem permissão/);
});

await check("rascunho de outra pessoa, ainda enviando ou já usado não entra", async () => {
  const theirs = await recorded(other);
  await as(creator);
  await fails(() => rows("select * from bind_task_audios($1,$2)", [task, [theirs.id]]), /inválido/);
  const pending = await rpc("prepare_task_audio", [A, "description", "audio/mp4", 5000, 3]);
  await fails(() => rows("select * from bind_task_audios($1,$2)", [task, [pending.id]]), /enviado/);
  const [used] = (await rpc("task_extras", [task])).audios;
  await fails(() => rows("select * from bind_task_audios($1,$2)", [task, [used.id]]), /inválido/);
});

await check("o trabalho da MAVI: transcrição, resumo, falha e nova tentativa", async () => {
  const [a] = (await rpc("task_extras", [task])).audios;
  await as(creator);
  const started = await rpc("start_task_audio_work", [a.id, null]);
  assert.equal(started.skip, false);
  assert.equal(started.client, client);
  assert.equal(started.contract, contract);
  assert.equal(started.task_title, "Campanha de outubro");
  // Um segundo pedido logo depois não trabalha em dobro.
  assert.equal((await rpc("start_task_audio_work", [a.id, null])).skip, true);
  let saved = await rpc("save_task_audio_work", [a.id, "  Subir a campanha de outubro com três criativos.  ", null, null]);
  assert.equal(saved.status, "summarizing");
  assert.equal(saved.transcript, "Subir a campanha de outubro com três criativos.");
  saved = await rpc("save_task_audio_work", [a.id, null, null, "O provedor não respondeu"]);
  assert.equal(saved.status, "ready", "sem resumo, a transcrição continua valendo");
  assert.equal(saved.summary, null);
  const retry = await rpc("start_task_audio_work", [a.id, null]);
  assert.equal(retry.skip, false);
  assert.equal(retry.audio.status, "summarizing");
  saved = await rpc("save_task_audio_work", [a.id, null, "- Três criativos\n- Outubro", null]);
  assert.equal(saved.status, "ready");
  assert.equal(saved.error, null);
  assert.equal((await rpc("start_task_audio_work", [a.id, null])).skip, true, "pronto não volta");

  const [, b] = (await rpc("task_extras", [task])).audios;
  await rpc("start_task_audio_work", [b.id, null]);
  saved = await rpc("save_task_audio_work", [b.id, null, null, "Download do GCS falhou (404)."]);
  assert.equal(saved.status, "failed");
  assert.equal((await rpc("start_task_audio_work", [b.id, null])).audio.status, "transcribing");
  saved = await rpc("save_task_audio_work", [b.id, "   ", null, null]);
  assert.equal(saved.status, "empty", "áudio sem fala");
  // Quem não cuida do áudio não dispara a MAVI.
  await as(doer);
  await fails(() => rpc("start_task_audio_work", [a.id, null]), /Sem permissão/);
});

await check("correção da transcrição: quem edita a tarefa corrige e o resumo é refeito", async () => {
  const [a] = (await rpc("task_extras", [task])).audios;
  await as(admin);
  const edited = await rpc("edit_task_audio", [a.id, "Subir a campanha de outubro com quatro criativos."]);
  assert.equal(edited.status, "summarizing");
  assert.equal(edited.summary, null);
  assert.equal(edited.edited_by, admin);
  assert.equal((await rpc("start_task_audio_work", [a.id, null])).skip, false);
  await rpc("save_task_audio_work", [a.id, null, "- Quatro criativos", null]);
  await as(doer);
  await fails(() => rpc("edit_task_audio", [a.id, "outra coisa"]), /Sem permissão/);
});

await check("comentário com áudio: pode ir sem texto, só o autor cuida dele", async () => {
  const draft = await recorded(doer, "comment", 12);
  await as(doer);
  const c = await rpc("add_audio_comment", [task, "", null, draft.id]);
  assert.equal(c.body, "");
  const extras = await rpc("task_extras", [task]);
  const bound = extras.audios.find((a) => a.id === draft.id);
  assert.equal(bound.comment_id, c.id);
  assert.equal(bound.task_id, task);
  // O comentário só de texto continua exigindo texto.
  await fails(() => rpc("add_comment", [task, "   ", null]), /Escreva/);
  // Rascunho de descrição não vira comentário.
  const wrong = await recorded(doer, "description");
  await as(doer);
  await fails(() => rpc("add_audio_comment", [task, "oi", null, wrong.id]), /inválido/);
  // Comentário: transcrição sem resumo.
  await rpc("start_task_audio_work", [draft.id, null]);
  const saved = await rpc("save_task_audio_work", [draft.id, "Já subi os criativos.", null, null]);
  assert.equal(saved.status, "ready");
  await as(other);
  await fails(() => rpc("edit_task_audio", [draft.id, "x"]), /Sem permissão/);
  await fails(() => rpc("delete_task_audio", [draft.id]), /Sem permissão/);
  // Tirar o áudio de um comentário que era só o áudio tira o comentário.
  await as(doer);
  const path = await rpc("delete_task_audio", [draft.id]);
  assert.equal(path, `${A}/audio/${draft.id}`);
  assert.equal((await sql("select count(*)::int as n from comments where id=$1", [c.id]))[0].n, 0);
});

await check("a busca e o RAG leem o que foi dito", async () => {
  await as(doer);
  const hits = await rows("select task_id, match_in, snippet from search_tasks($1,'quatro criativos')", [A]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].task_id, task);
  assert.equal(hits[0].match_in, "description");
  await sql("select mavi_private.ai_build_task($1)", [task]);
  const [doc] = await sql(
    `select string_agg(c.content, ' ') as text from public.ai_chunks c
     join public.ai_documents d on d.id = c.document_id
     where d.source_type = 'task' and d.source_id = $1`,
    [task],
  );
  assert.match(doc.text, /quatro criativos/, "a transcrição entra no texto indexado");
});

await check("repetição: cada cópia leva os áudios da descrição (o mesmo arquivo)", async () => {
  const draft = await recorded(creator);
  const source = await newTask(creator, "Relatório semanal", "daily");
  await as(creator);
  await rows("select * from bind_task_audios($1,$2)", [source, [draft.id]]);
  await rpc("start_task_audio_work", [draft.id, null]);
  await rpc("save_task_audio_work", [draft.id, "Mandar o relatório toda manhã.", null, null]);
  await rpc("save_task_audio_work", [draft.id, null, "- Relatório pela manhã", null]);
  const [{ next_run }] = await sql("select next_run::text from task_recurrences where source_task_id=$1", [source]);
  await sql("select mavi_private.run_task_recurrences($1::date)", [next_run]);
  const [{ id: copy }] = await sql(
    "select t.id from tasks t join task_recurrences r on r.id=t.recurrence_id where r.source_task_id=$1 and t.id<>$1",
    [source],
  );
  const copied = await sql("select * from task_audios where task_id=$1", [copy]);
  assert.equal(copied.length, 1);
  assert.equal(copied[0].path, `${A}/audio/${draft.id}`);
  assert.equal(copied[0].transcript, "Mandar o relatório toda manhã.");
  assert.equal(copied[0].summary, "- Relatório pela manhã");
  assert.equal(copied[0].status, "ready");
  // O arquivo só sai do GCS quando ninguém mais aponta para ele.
  await as(creator);
  assert.equal(await rpc("delete_task_audio", [draft.id]), null);
  assert.equal(await rpc("delete_task_audio", [copied[0].id]), `${A}/audio/${draft.id}`);
});

await check("anexos: qualquer tipo até 100 MB, sem executáveis", async () => {
  await as(doer);
  const ok = await rpc("prepare_attachment", [task, "reuniao.m4a", 90 * 1024 * 1024]);
  assert.equal(ok.size_bytes, 90 * 1024 * 1024);
  await rpc("prepare_attachment", [task, "layout.psd", 1000]);
  await rpc("prepare_attachment", [task, "SEM-EXTENSAO", 1000]);
  await fails(() => rpc("prepare_attachment", [task, "instalador.EXE", 1000]), /segurança/);
  await fails(() => rpc("prepare_attachment", [task, "script.sh", 1000]), /segurança/);
  await fails(() => rpc("prepare_attachment", [task, "grande.zip", 101 * 1024 * 1024]), /check/);
});

await check("o Painel da MAVI aceita a funcionalidade dos áudios", async () => {
  await sql(
    "insert into mavi_private.ai_routes(company_id,scope_type,scope_id,feature,provider_id,model) values($1,'feature',null,'task_audio',gen_random_uuid(),'m')",
    [A],
  ).catch((e) => {
    // Sem provedor cadastrado a chave estrangeira recusa; o check não.
    assert.doesNotMatch(e.message, /ai_routes_feature_check/);
  });
});

console.log(`${passed} task audio checks passed`);

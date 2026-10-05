// Tutoriais, Fase 2 (migration 20270420090000_tutorials_mavi): o tutorial
// publicado vira trechos por seção no cérebro da MAVI (âncoras iguais às da
// tela, transcrições dos vídeos), a busca respeita o público, a transcrição
// em segundo plano (fila, provedor ainda processando, grande demais, manual),
// as dúvidas sem tutorial e os provedores que só transcrevem.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, manager, member, member2] = [1, 10, 11, 13, 14].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, manager, member, member2]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Gabi Gestora','manager',true),
   ($1,$4,'Bruno Colaborador','member',true),($1,$5,'Carla Colaboradora','member',true)`,
  [A, admin, manager, member, member2],
);
await db.query(`insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`, [SECRET]);
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
const text = (t, marks) => ({ type: "text", text: t, ...(marks ? { marks } : {}) });
const p = (...content) => ({ type: "paragraph", content });
const h = (t, level = 2) => ({ type: "heading", attrs: { level }, content: [text(t)] });
const doc = (...content) => "mavi:richtext:v1:" + JSON.stringify({ type: "doc", content });
const save = async (user, id, content, publish = true) => {
  await as(user);
  return rpc("save_tutorial", [A, id, content, publish, null]);
};
const search = async (user, query, opts = {}) => {
  await as(user);
  return rows("search_tutorials", [
    A,
    query,
    opts.embedding ?? null,
    opts.module ?? null,
    opts.strict ?? false,
    null,
    null,
    20,
  ]);
};
const chunks = (id) =>
  sql(
    `select c.content, c.meta, c.access, c.source_type from ai_chunks c join ai_documents d on d.id = c.document_id
     where d.source_type = 'tutorial' and d.source_id = $1 order by c.ord`,
    [id],
  );
const kicks = async () =>
  (await sql(`select count(*)::int as n from net.requests where body->>'action' = 'tutorial-transcribe'`))[0].n;

// Um tutorial com introdução, seções (título repetido, acento, negrito no
// meio da palavra), lista e um vídeo do YouTube com transcrição colada.
const body = doc(
  p(text("Este guia mostra o caminho das tarefas.")),
  h("Criar a tarefa"),
  p(text("Clique em "), text("No", [{ type: "bold" }]), text("va tarefa e escolha o cliente.")),
  { type: "bulletList", content: [{ type: "listItem", content: [p(text("Descreva o pedido"))] }] },
  h("Passo à passo", 3),
  { type: "tutorialVideo", attrs: { provider: "youtube", videoId: "dQw4w9WgXcQ", label: "Demonstração", transcript: "Aqui eu mostro o filtro de prazo atrasado." } },
  h("Criar a tarefa"),
  p(text("Repetido de propósito.")),
);
let tutorial;

await check("publicar indexa por seção, com as âncoras da tela", async () => {
  const r = await save(admin, null, {
    title: "Como criar uma tarefa",
    summary: "O básico de Tarefas",
    body,
    modules: ["tasks"],
    category: "Primeiros passos",
    tags: ["Tarefas"],
  });
  tutorial = r.id;
  const list = await chunks(tutorial);
  assert.deepEqual(
    list.map((c) => c.meta.anchor),
    ["", "criar-a-tarefa", "passo-a-passo", "criar-a-tarefa-2"],
  );
  assert.ok(list.every((c) => c.access === "tutorial" && c.source_type === "tutorial"));
  assert.match(list[0].content, /^\[Tutorial\] "Como criar uma tarefa" · categoria Primeiros passos · módulos Tarefas · tags Tarefas/);
  assert.match(list[0].content, /O básico de Tarefas\nEste guia mostra/);
  assert.match(list[1].content, /Seção: Criar a tarefa\nClique em Nova tarefa e escolha o cliente\.\nDescreva o pedido/);
  assert.match(list[2].content, /\[Vídeo: Demonstração\]\nTranscrição do vídeo: Aqui eu mostro o filtro de prazo atrasado\./);
});

await check("rascunho não entra; tirar do ar e apagar tiram do cérebro", async () => {
  const d = await save(admin, null, { title: "Rascunho secreto", body: doc(p(text("nada ainda"))) }, false);
  assert.deepEqual(await chunks(d.id), []);
  const other = await save(admin, null, { title: "Vai sair do ar", body: doc(p(text("conteúdo"))) });
  assert.equal((await chunks(other.id)).length, 1);
  await as(admin);
  await rpc("unpublish_tutorial", [other.id]);
  assert.deepEqual(await chunks(other.id), []);
  await save(admin, other.id, { title: "Vai sair do ar", body: doc(p(text("conteúdo"))) });
  assert.equal((await chunks(other.id)).length, 1);
  await as(admin);
  await rpc("delete_tutorial", [other.id]);
  assert.deepEqual(await sql(`select 1 from ai_documents where source_type='tutorial' and source_id=$1`, [other.id]), []);
});

await check("busca sem acento, pela seção, e não aparece na busca geral", async () => {
  const hits = await search(member, "Como faço o FILTRO de prazo atrasado?");
  assert.equal(hits[0].tutorial_id, tutorial);
  assert.equal(hits[0].anchor, "passo-a-passo");
  assert.equal(hits[0].section, "Passo à passo");
  assert.ok(!hits[0].content.startsWith("[Tutorial]"));
  assert.deepEqual(await search(member, "palavrainexistente"), []);
  await as(member);
  const general = await rows("ai_search", [A, null, "filtro prazo atrasado", {}, 12]);
  assert.ok(general.every((g) => g.source_type !== "tutorial"));
});

await check("a busca respeita o público e o módulo", async () => {
  const team = (await sql(`insert into teams(company_id,name) values($1,'Tráfego') returning id`, [A]))[0].id;
  await sql(`insert into team_members(company_id,team_id,user_id) values($1,$2,$3)`, [A, team, member2]);
  const r = await save(admin, null, {
    title: "Configurar campanhas",
    body: doc(h("Filtro das campanhas"), p(text("O filtro de status mostra as ativas."))),
    modules: ["campaigns"],
    aud_all: false,
    aud_teams: [team],
  });
  assert.ok(!(await search(member, "filtro")).some((x) => x.tutorial_id === r.id));
  assert.ok((await search(member2, "filtro")).some((x) => x.tutorial_id === r.id));
  // Só do módulo; e o da tela primeiro.
  const strict = await search(member2, "filtro", { module: "campaigns", strict: true });
  assert.ok(strict.length && strict.every((x) => x.tutorial_id === r.id));
  const boosted = await search(member2, "filtro", { module: "campaigns" });
  assert.equal(boosted[0].tutorial_id, r.id);
  const other = await search(member2, "filtro", { module: "tasks" });
  assert.equal(other[0].tutorial_id, tutorial);
});

await check("busca por significado com corte de semelhança", async () => {
  const vec = (i) => `[${Array.from({ length: 1536 }, (_, k) => (k === i ? 1 : 0)).join(",")}]`;
  const list = await sql(
    `select c.id, c.meta->>'anchor' as anchor from ai_chunks c join ai_documents d on d.id = c.document_id
     where d.source_id = $1 order by c.ord`,
    [tutorial],
  );
  for (const [i, c] of list.entries())
    await sql(`update ai_chunks set embedding = $1::extensions.halfvec(1536) where id = $2`, [vec(i), c.id]);
  const hits = await search(member, "zzz qqq", { embedding: vec(1) });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].anchor, "criar-a-tarefa");
  assert.ok(Math.abs(hits[0].similarity - 1) < 1e-3);
});

let media;
await check("vídeo enviado: fila, provedor ainda processando, transcrição e custo", async () => {
  await as(admin);
  media = await rpc("prepare_tutorial_media", [tutorial, "passo.mp4", 900_000_000 / 2, "video/mp4"]);
  const before = await kicks();
  await as(admin);
  await rpc("confirm_tutorial_media", [media, 125]);
  assert.equal(await kicks(), before + 1);
  // Sem o segredo, nada.
  await as(null);
  await assert.rejects(() => rows("tutorial_transcribe_claim", ["errado", 3]), /Sem permissão/);
  await as(null);
  const [job] = await rows("tutorial_transcribe_claim", [SECRET, 3]);
  assert.equal(job.id, media);
  assert.equal(job.duration_seconds, 125);
  assert.equal(job.job, null);
  // Um segundo worker não pega o mesmo vídeo.
  await as(null);
  assert.deepEqual(await rows("tutorial_transcribe_claim", [SECRET, 3]), []);
  // O provedor ainda processa: volta para a fila com o pedido e acorda o worker.
  await as(null);
  await rpc("tutorial_transcribe_save", [SECRET, media, null, null, false, "job-123", null, 0, null, null]);
  const [m1] = await sql(`select transcript_status, transcript_job from tutorial_media where id=$1`, [media]);
  assert.deepEqual(m1, { transcript_status: "pending", transcript_job: "job-123" });
  assert.equal(await kicks(), before + 2);
  await as(null);
  const [again] = await rows("tutorial_transcribe_claim", [SECRET, 3]);
  assert.equal(again.job, "job-123");
  await as(null);
  await rpc("tutorial_transcribe_save", [SECRET, media, "Abra a lista e clique em Nova tarefa.", null, false, null, "nova-3", 0.009, null, 130]);
  const [m2] = await sql(`select transcript_status, transcript_source, duration_seconds from tutorial_media where id=$1`, [media]);
  assert.deepEqual(m2, { transcript_status: "ready", transcript_source: "auto", duration_seconds: 130 });
  const [usage] = await sql(`select user_id, module, kind, model, cost_usd from ai_usage where kind='tutorial_transcribe'`);
  assert.deepEqual({ ...usage, cost_usd: Number(usage.cost_usd) }, {
    user_id: admin, module: "tutorials", kind: "tutorial_transcribe", model: "nova-3", cost_usd: 0.009,
  });
});

await check("a transcrição entra na seção do vídeo quando ele está no texto", async () => {
  const withVideo = doc(h("Vídeo do passo a passo"), { type: "tutorialVideo", attrs: { mediaId: media, label: "Passo" } });
  await save(admin, tutorial, { title: "Como criar uma tarefa", body: withVideo, modules: ["tasks"] });
  const list = await chunks(tutorial);
  assert.equal(list.length, 1);
  assert.match(list[0].content, /\[Vídeo: Passo\]\nTranscrição do vídeo: Abra a lista e clique em Nova tarefa\./);
  // Quem lê vê a transcrição; o erro só quem edita.
  await as(member);
  const d = await rpc("tutorial_detail", [tutorial]);
  assert.equal(d.media[0].transcript, "Abra a lista e clique em Nova tarefa.");
});

await check("quem edita corrige, apaga (volta à fila) e transcreve de novo", async () => {
  await as(manager);
  await assert.rejects(() => rpc("set_tutorial_media_transcript", [media, "x"]), /Sem permissão/);
  await as(admin);
  await rpc("set_tutorial_media_transcript", [media, "Texto corrigido à mão."]);
  assert.match((await chunks(tutorial))[0].content, /Texto corrigido à mão\./);
  // O worker atrasado não passa por cima da correção.
  await as(null);
  await rpc("tutorial_transcribe_save", [SECRET, media, "Texto do worker", null, false, null, "nova-3", 0, null, null]);
  const [m] = await sql(`select transcript from tutorial_media where id=$1`, [media]);
  assert.equal(m.transcript, "Texto corrigido à mão.");
  await as(admin);
  await rpc("retry_tutorial_media_transcript", [media]);
  const [r] = await sql(`select transcript_status, transcript_source from tutorial_media where id=$1`, [media]);
  assert.equal(r.transcript_status, "pending");
  // Grande demais para o provedor escolhido.
  await as(null);
  await rows("tutorial_transcribe_claim", [SECRET, 3]);
  await as(null);
  await rpc("tutorial_transcribe_save", [SECRET, media, null, "Vídeo maior que 25 MB.", true, null, null, 0, null, null]);
  const [s] = await sql(`select transcript_status, transcript_error from tutorial_media where id=$1`, [media]);
  assert.deepEqual(s, { transcript_status: "skipped", transcript_error: "Vídeo maior que 25 MB." });
  await as(admin);
  await rpc("set_tutorial_media_transcript", [media, ""]);
  const [e] = await sql(`select transcript_status, transcript from tutorial_media where id=$1`, [media]);
  assert.deepEqual(e, { transcript_status: "pending", transcript: null });
});

await check("dúvidas sem tutorial: somam, só líderes veem, resolver reabre se voltar", async () => {
  await as(member);
  await rpc("log_tutorial_gap", [A, "Como exporto o relatório?", "search", "reports"]);
  await as(member2);
  await rpc("log_tutorial_gap", [A, "  como EXPORTO o relatório ", "mavi", null]);
  await as(member);
  await rpc("log_tutorial_gap", [A, "Como exporto o relatorio", "search", null]);
  await as(member);
  assert.deepEqual(await rows("tutorial_gaps_list", [A, "open", 100]), []);
  await as(member);
  assert.equal(await rpc("tutorial_gap_count", [A]), 0);
  await as(manager);
  const [g] = await rows("tutorial_gaps_list", [A, "open", 100]);
  assert.equal(g.asks, 3);
  assert.equal(g.people, 2);
  assert.equal(g.module, "reports");
  assert.equal(g.source, "search");
  await as(manager);
  assert.equal(await rpc("tutorial_gap_count", [A]), 1);
  await as(member);
  await assert.rejects(() => rpc("set_tutorial_gap", [g.id, "resolved", tutorial]), /Sem permissão/);
  await as(manager);
  await rpc("set_tutorial_gap", [g.id, "resolved", tutorial]);
  await as(manager);
  const [done] = await rows("tutorial_gaps_list", [A, "resolved", 100]);
  assert.equal(done.tutorial_title, "Como criar uma tarefa");
  assert.equal(done.handled_by_name, "Gabi Gestora");
  await as(member);
  await rpc("log_tutorial_gap", [A, "como exporto o relatório", "mavi", null]);
  await as(manager);
  assert.equal((await rows("tutorial_gaps_list", [A, "open", 100])).length, 1);
  await as(manager);
  await rpc("set_tutorial_gap", [g.id, "dismissed", null]);
  await as(member);
  await rpc("log_tutorial_gap", [A, "como exporto o relatório", "mavi", null]);
  await as(manager);
  assert.equal(await rpc("tutorial_gap_count", [A]), 0);
});

await check("Deepgram e AssemblyAI só na transcrição dos tutoriais", async () => {
  await as(admin);
  const dg = await rpc("ai_save_provider", [A, null, "Deepgram", "deepgram", null,
    [{ id: "nova-3", input: 0, output: 0 }], "v1:abc", "abc", true]);
  await as(admin);
  await rpc("ai_set_route", [A, "feature", null, dg, "nova-3", "tutorial_transcribe"]);
  await as(admin);
  await assert.rejects(() => rpc("ai_set_route", [A, "feature", null, dg, "nova-3", "whatsapp_transcribe"]), /só transcreve os vídeos dos tutoriais/);
  await as(admin);
  await assert.rejects(() => rpc("ai_set_route", [A, "company", null, dg, "nova-3", null]), /só transcreve/);
  await as(admin);
  const oa = await rpc("ai_save_provider", [A, null, "OpenAI", "openai", null,
    [{ id: "whisper-1", input: 0, output: 0 }, { id: "gpt-5", input: 1, output: 2 }], "v1:def", "def", true]);
  await as(admin);
  await assert.rejects(() => rpc("ai_set_route", [A, "feature", null, oa, "gpt-5", "tutorial_transcribe"]), /modelo de transcrição/);
  await as(admin);
  await rpc("ai_set_route", [A, "feature", null, oa, "gpt-5", "tutorial_search"]);
  await as(null);
  const route = await rpc("ai_worker_route", [SECRET, A, "tutorial_transcribe"]);
  assert.equal(route.kind, "deepgram");
  assert.equal(route.model, "nova-3");
});

console.log(`\n${passed} verificações da Fase 2 dos Tutoriais passaram.`);

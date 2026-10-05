// Tutoriais, Fase 4 (migration 20270503090000_tutorial_extras): "Isso
// ajudou?" com motivo e versão, visualizações (30 min) e buscas (2 min),
// métricas só para líderes, aviso de tutorial novo na caixa de entrada e no
// Mural, a funcionalidade 'tutorial_writer' em Quem usa qual modelo e quem
// pode pedir à MAVI para escrever.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, manager, member, member2, stranger] = [1, 2, 10, 11, 13, 14, 15].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, manager, member, member2, stranger]]);
await db.query(`insert into companies(id,name) values($1,'Make'),($2,'Outra')`, [A, B]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Gabi Gestora','manager',true),
   ($1,$4,'Bruno Colaborador','member',true),($1,$5,'Carla Colaboradora','member',true),
   ($6,$7,'Duda Outra','admin',true)`,
  [A, admin, manager, member, member2, B, stranger],
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
const rejects = (fn, pattern) => assert.rejects(fn, pattern);
const body = (text) =>
  "mavi:richtext:v1:" +
  JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const tutorial = async (user, title, extra = {}, publish = true) => {
  await as(user);
  return (await rpc("save_tutorial", [A, null, { title, summary: `Resumo de ${title}`, body: body(title), ...extra }, publish, null])).id;
};
const today = async () => (await sql(`select mavi_private.company_today($1)::text d`, [A]))[0].d;

const t1 = await tutorial(admin, "Criar uma tarefa");
const t2 = await tutorial(admin, "Configurar a MAVI", { aud_all: false, aud_roles: ["admin", "manager"] });
const tDraft = await tutorial(admin, "Rascunho", {}, false);
const tManager = await tutorial(manager, "Guia da gestora");

await check("voto: 👍 sem motivo, 👎 com motivo e versão, trocar e tirar", async () => {
  await as(member);
  let v = await rpc("vote_tutorial", [t1, "down", "confusing", "  Não achei o botão  "]);
  assert.equal(v.vote, "down");
  assert.equal(v.reason, "confusing");
  assert.equal(v.comment, "Não achei o botão");
  assert.equal(v.version, 1);
  v = await rpc("vote_tutorial", [t1, "up", "confusing", null]);
  assert.equal(v.reason, null, "o 👍 não guarda motivo");
  await rejects(() => rpc("vote_tutorial", [t1, "meh", null, null]), /Voto inválido/);
  await rejects(() => rpc("vote_tutorial", [t1, "down", "chato", null]), /Motivo inválido/);
  // Fora do público e rascunho: não vota.
  await rejects(() => rpc("vote_tutorial", [t2, "up", null, null]), /não está disponível/);
  await as(member);
  await rejects(() => rpc("vote_tutorial", [tDraft, "up", null, null]), /não está disponível/);
  await as(member);
  assert.equal(await rpc("vote_tutorial", [t1, null, null, null]), null);
  assert.equal((await sql(`select count(*)::int n from tutorial_feedback`))[0].n, 0);
});

await check("quem edita vê os votos; os outros só o próprio voto", async () => {
  await as(member);
  await rpc("vote_tutorial", [t1, "down", "outdated", "Mudou a tela"]);
  await as(member2);
  await rpc("vote_tutorial", [t1, "up", null, null]);
  await as(member);
  let d = await rpc("tutorial_detail", [t1]);
  assert.equal(d.my_vote.vote, "down");
  assert.equal(d.votes, null);
  assert.deepEqual(await rows("tutorial_feedback_list", [t1]), []);
  await as(admin);
  d = await rpc("tutorial_detail", [t1]);
  assert.deepEqual(d.votes, { up: 1, down: 1, down_current: 1 });
  const list = await rows("tutorial_feedback_list", [t1]);
  assert.deepEqual(list.map((r) => [r.name, r.vote, r.reason]).sort(), [
    ["Bruno Colaborador", "down", "outdated"],
    ["Carla Colaboradora", "up", null],
  ]);
  // A gestora não edita o tutorial do administrador.
  await as(manager);
  assert.deepEqual(await rows("tutorial_feedback_list", [t1]), []);
  // Versão nova: o 👎 fica marcado como da versão anterior.
  await as(admin);
  const [{ revision }] = await sql(`select revision from tutorials where id = $1`, [t1]);
  await rpc("save_tutorial", [A, t1, { title: "Criar uma tarefa", summary: "Resumo de Criar uma tarefa", body: body("Nova") }, true, revision]);
  d = await rpc("tutorial_detail", [t1]);
  assert.deepEqual(d.votes, { up: 1, down: 1, down_current: 0 });
});

let searchId;
await check("busca: registra, junta a repetida em 2 minutos, só da empresa", async () => {
  await as(member);
  searchId = await rpc("log_tutorial_search", [A, "  Como  criar tarefa ", null, 3]);
  const again = await rpc("log_tutorial_search", [A, "como criar TAREFA", "tasks", 2]);
  assert.equal(again, searchId);
  const [s] = await sql(`select query, query_key, results, module from tutorial_searches where id = $1`, [searchId]);
  assert.deepEqual(s, { query: "Como criar tarefa", query_key: "como criar tarefa", results: 2, module: "tasks" });
  await as(member);
  await rpc("log_tutorial_search", [A, "relatório de horas", null, 0]);
  await as(member2);
  await rpc("log_tutorial_search", [A, "Relatório de Horas", null, 0]);
  await as(stranger);
  await rejects(() => rpc("log_tutorial_search", [A, "x", null, 0]), /Sem acesso/);
});

await check("visualização: origem, busca da própria pessoa, uma a cada 30 minutos", async () => {
  await as(member);
  assert.equal(await rpc("log_tutorial_view", [t1, "library", searchId]), true);
  assert.equal(await rpc("log_tutorial_view", [t1, "library", null]), false, "30 minutos");
  const [v] = await sql(`select source, search_id from tutorial_views where user_id = $1`, [member]);
  assert.equal(v.source, "search");
  assert.equal(String(v.search_id), String(searchId));
  // A busca de outra pessoa não vale.
  await as(member2);
  await rpc("log_tutorial_view", [t1, "trail", searchId]);
  const [w] = await sql(`select source, search_id from tutorial_views where user_id = $1`, [member2]);
  assert.deepEqual(w, { source: "trail", search_id: null });
  // Origem desconhecida vira link; rascunho e fora do público não contam.
  await as(admin);
  await rpc("log_tutorial_view", [t1, "hack", null]);
  assert.equal((await sql(`select source from tutorial_views where user_id = $1`, [admin]))[0].source, "link");
  await as(member);
  assert.equal(await rpc("log_tutorial_view", [t2, "library", null]), false);
  await as(admin);
  assert.equal(await rpc("log_tutorial_view", [tDraft, "library", null]), false);
});

await check("métricas: só líderes; tutoriais, buscas e sem resultado", async () => {
  await progressDone(member, t1);
  const d = await today();
  await as(member);
  await rejects(() => rpc("tutorial_metrics", [A, d, d]), /Só administradores e gestores/);
  await as(admin);
  await rejects(() => rpc("tutorial_metrics", [A, d, "2020-01-01"]), /Período inválido/);
  await as(manager);
  const m = await rpc("tutorial_metrics", [A, d, d]);
  assert.equal(m.totals.views, 3);
  assert.equal(m.totals.viewers, 3);
  assert.equal(m.totals.searches, 3);
  assert.equal(m.totals.empty_searches, 2);
  assert.equal(m.totals.opened_searches, 1);
  assert.equal(m.totals.completions, 1);
  assert.deepEqual(m.sources, { search: 1, trail: 1, link: 1 });
  const first = m.tutorials[0];
  assert.equal(first.title, "Criar uma tarefa");
  assert.equal(first.views, 3);
  assert.equal(first.from_search, 1);
  assert.equal(first.completions, 1);
  assert.equal(first.up, 1);
  assert.equal(first.down, 1);
  // O rascunho sem visitas fica de fora; os publicados sem visita aparecem com zero.
  assert.ok(!m.tutorials.some((t) => t.title === "Rascunho"));
  assert.ok(m.tutorials.some((t) => t.title === "Guia da gestora" && t.views === 0));
  assert.equal(m.queries[0].query, "Relatório de Horas");
  assert.equal(m.queries[0].searches, 2);
  assert.equal(m.queries[0].people, 2);
  assert.deepEqual(m.empty.map((q) => [q.query_key, q.empty]), [["relatorio de horas", 2]]);
  const opened = m.queries.find((q) => q.query_key === "como criar tarefa");
  assert.equal(opened.opened, 1);
  // Um período sem nada.
  const old = await rpc("tutorial_metrics", [A, "2020-01-01", "2020-01-31"]);
  assert.equal(old.totals.views, 0);
  assert.deepEqual(old.queries, []);
});

async function progressDone(user, tutorialId) {
  await as(user);
  await rpc("set_tutorial_progress", [tutorialId, "complete"]);
}

await check("aviso na caixa de entrada: o público do tutorial, menos quem publica", async () => {
  await as(member);
  await rejects(() => rpc("announce_tutorial", [t1, "inbox", false]), /Sem permissão/);
  await as(admin);
  await rejects(() => rpc("announce_tutorial", [tDraft, "inbox", false]), /Publique o tutorial/);
  await as(admin);
  await rejects(() => rpc("announce_tutorial", [t1, "email", false]), /Escolha como avisar/);
  await as(admin);
  let r = await rpc("announce_tutorial", [t1, "inbox", false]);
  assert.deepEqual(r, { channel: "inbox", people: 3, notice: null });
  const notes = await sql(`select user_id, title, body, link from notifications where kind = 'tutorial' order by user_id`);
  assert.deepEqual(notes.map((n) => n.user_id), [manager, member, member2]);
  assert.equal(notes[0].title, "Tutorial novo: Criar uma tarefa");
  assert.equal(notes[0].body, "Resumo de Criar uma tarefa");
  assert.equal(notes[0].link, `/tutoriais?tutorial=${t1}&de=aviso`);
  // Público restrito: só gestores e administradores (menos quem publica).
  await as(admin);
  r = await rpc("announce_tutorial", [t2, "inbox", true]);
  assert.equal(r.people, 1);
  const [n2] = await sql(`select user_id, title from notifications where kind = 'tutorial' and title like 'Tutorial atualizado%'`);
  assert.deepEqual(n2, { user_id: manager, title: "Tutorial atualizado: Configurar a MAVI" });
});

await check("aviso no Mural: um aviso com o público e o link do tutorial", async () => {
  await as(admin);
  const r = await rpc("announce_tutorial", [t2, "notice", false]);
  assert.equal(r.channel, "notice");
  const [n] = await sql(`select title, body, inbox, level from notices where id = $1`, [r.notice]);
  assert.equal(n.title, "Tutorial novo: Configurar a MAVI");
  assert.equal(n.inbox, true);
  assert.equal(n.level, "info");
  assert.ok(n.body.includes(`/tutoriais?tutorial=${t2}&de=aviso`));
  const targets = await sql(`select kind, target_id from notice_targets where notice_id = $1 order by target_id`, [r.notice]);
  // Os papéis viram as pessoas (administradores e gestores ativos).
  assert.deepEqual(targets.map((t) => [t.kind, t.target_id]), [
    ["user", admin],
    ["user", manager],
  ]);
  // Tutorial para todos: o alvo "todos".
  await as(admin);
  const r2 = await rpc("announce_tutorial", [t1, "notice", true]);
  const [t] = await sql(`select kind from notice_targets where notice_id = $1`, [r2.notice]);
  assert.equal(t.kind, "everyone");
});

await check("'tutorial_writer' em Quem usa qual modelo; as outras continuam valendo", async () => {
  const features = (await sql(`select mavi_private.ai_route_features() f`))[0].f;
  assert.ok(features.includes("tutorial_writer"));
  assert.ok(features.includes("tutorial_search"));
  assert.ok(features.includes("assistant"));
  assert.ok(!features.includes("feature"));
  await as(admin);
  const provider = await rpc("ai_save_provider", [A, null, "Claude", "anthropic", null,
    [{ id: "claude-x", input: 1, output: 2 }], "v1:abc", "abc", true]);
  await as(admin);
  await db.query(`select public.ai_set_route($1, 'feature', null, $2, 'claude-x', 'tutorial_writer')`, [A, provider]);
  await as(admin);
  await db.query(`select public.ai_set_route($1, 'feature', null, $2, 'claude-x', 'notice_writer')`, [A, provider]);
  await as(admin);
  await rejects(
    () => db.query(`select public.ai_set_route($1, 'feature', null, $2, 'claude-x', 'inventada')`, [A, provider]),
    /Funcionalidade inválida/,
  );
  const routes = await sql(`select feature from mavi_private.ai_routes where company_id = $1 order by feature`, [A]);
  assert.deepEqual(routes.map((r) => r.feature), ["notice_writer", "tutorial_writer"]);
});

await check("quem pede à MAVI para escrever: líderes com a MAVI à mostra", async () => {
  await as(manager);
  assert.equal(await rpc("tutorial_can_write", [A]), true);
  await as(member);
  assert.equal(await rpc("tutorial_can_write", [A]), false);
  await sql(`update memberships set hidden_pages = array['assistant'] where user_id = $1`, [manager]);
  await as(manager);
  assert.equal(await rpc("tutorial_can_write", [A]), false);
});

await check("tabelas sem leitura direta", async () => {
  for (const table of ["tutorial_feedback", "tutorial_searches", "tutorial_views"]) {
    await as(member);
    await rejects(() => db.query(`select * from ${table}`), /permission denied/);
  }
});

console.log(`\n${passed} verificações da Fase 4 dos Tutoriais passaram.`);

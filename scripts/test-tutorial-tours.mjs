// Onboarding (migration 20270623090000_tutorial_tours): só líderes criam,
// gestores editam só os próprios, rascunho invisível para quem recebe,
// público por papel/equipe/pessoa com exclusões, alteração guardada sem
// tirar a versão no ar, passos conferidos, progresso por pessoa e passos
// cujo elemento não apareceu.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, manager, manager2, member, member2, stranger, team] = [1, 2, 10, 11, 12, 13, 14, 15, 20].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, manager, manager2, member, member2, stranger],
]);
await db.query(`insert into companies(id,name) values($1,'Make'),($2,'Outra')`, [A, B]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Gabi Gestora','manager',true),($1,$4,'Gil Gestor','manager',true),
   ($1,$5,'Bruno Colaborador','member',true),($1,$6,'Carla Colaboradora','member',true),
   ($7,$8,'Duda Outra','admin',true)`,
  [A, admin, manager, manager2, member, member2, B, stranger],
);
await db.query(`insert into teams(id,company_id,name) values($1,$2,'Tráfego')`, [team, A]);
await db.query(`insert into team_members(company_id,team_id,user_id) values($1,$2,$3)`, [A, team, member2]);

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
const target = { tag: "button", text: "Nova tarefa", path: "main > button", role: "button" };
const step = (id, extra = {}) => ({
  id,
  kind: "next",
  placement: "auto",
  page: "tasks",
  url: "/tarefas",
  title: "Nova tarefa",
  body: body("Clique aqui para criar uma tarefa."),
  target,
  ...extra,
});
const tour = (extra = {}) => ({
  title: "Primeiros passos nas Tarefas",
  summary: "Como criar a primeira tarefa.",
  steps: [step("passo1"), step("passo2", { kind: "click", url: "/tarefas?aba=x", title: "Salvar" })],
  modules: ["tasks"],
  aud_all: true,
  aud_roles: [],
  aud_teams: [],
  aud_users: [],
  aud_exclude: [],
  ...extra,
});
const save = async (user, id, content, publish = false, revision = null) => {
  await as(user);
  return rpc("save_tutorial_tour", [A, id, content, publish, revision]);
};
const list = async (user, scope = "library", module = null, page = null) => {
  await as(user);
  return rows("list_tutorial_tours", [A, scope, module, page]);
};
const titles = (l) => l.map((r) => r.title).sort();

let first;
await check("só líderes criam; colaborador e outra empresa são recusados", async () => {
  await rejects(() => save(member, null, tour()), /Só administradores e gestores/);
  await rejects(() => save(stranger, null, tour()), /Só administradores e gestores/);
  first = await save(manager, null, tour());
  assert.equal(first.mode, "created");
  assert.equal(first.status, "draft");
  assert.equal(first.revision, 1);
});

await check("passos conferidos: tipo, tela, endereço, elemento e texto", async () => {
  await rejects(() => save(admin, null, tour({ steps: [step("passo1", { kind: "voar" })] })), /Tipo do passo 1/);
  await rejects(() => save(admin, null, tour({ steps: [step("passo1", { page: "" })] })), /não tem a tela/);
  await rejects(() => save(admin, null, tour({ steps: [step("passo1", { url: "//evil.com" })] })), /Endereço do passo 1/);
  await rejects(
    () => save(admin, null, tour({ steps: [step("passo1", { kind: "click", target: null })] })),
    /precisa de um elemento/,
  );
  await rejects(() => save(admin, null, tour({ steps: [step("passo1", { title: "", body: "" })] })), /texto do balão/);
  await rejects(() => save(admin, null, tour({ steps: [step("passo1"), step("passo1")] })), /identificador/);
  // Um passo sem elemento (balão no centro) só pode ser "Próximo"; o "clica
  // sozinho" dispensa texto; chaves desconhecidas somem.
  const ok = await save(admin, null, tour({
    title: "Centro",
    steps: [step("centro1", { target: null }), step("auto01", { kind: "auto", title: "", body: "", lixo: 1 })],
  }));
  await as(admin);
  const d = await rpc("tutorial_tour_detail", [ok.id]);
  assert.equal(d.steps.length, 2);
  assert.equal(d.steps[0].target, null);
  assert.equal(d.steps[1].lixo, undefined);
  assert.equal(d.start_page, "tasks");
  await rpc("delete_tutorial_tour", [ok.id]);
});

await check("rascunho só aparece para quem edita; publicar exige passos", async () => {
  assert.deepEqual(titles(await list(member)), []);
  assert.deepEqual(titles(await list(manager, "admin")), ["Primeiros passos nas Tarefas"]);
  assert.deepEqual(titles(await list(admin, "admin")), ["Primeiros passos nas Tarefas"]);
  // O outro gestor não vê o rascunho de quem criou nem edita.
  assert.deepEqual(titles(await list(manager2, "admin")), []);
  await rejects(() => save(manager2, first.id, tour(), false), /Só um administrador ou o gestor que criou/);
  await as(member);
  assert.equal(await rpc("tutorial_tour_detail", [first.id]), null);
  await rejects(() => save(manager, null, tour({ title: "Vazio", steps: [] }), true), /ao menos um passo/);
});

await check("publicado: público por papel, equipe e pessoa, com exclusão", async () => {
  const r = await save(manager, first.id, tour(), true, first.revision);
  assert.equal(r.mode, "published");
  assert.equal(r.version, 1);
  assert.deepEqual(titles(await list(member)), ["Primeiros passos nas Tarefas"]);
  await rejects(() => list(stranger), /Sem acesso/);
  // Só a equipe Tráfego (Carla) e o Bruno excluído de todo jeito.
  const cur = await list(manager, "admin");
  await save(manager, first.id, tour({ aud_all: false, aud_teams: [team] }), true, null);
  assert.deepEqual(titles(await list(member)), []);
  assert.deepEqual(titles(await list(member2)), ["Primeiros passos nas Tarefas"]);
  await save(manager, first.id, tour({ aud_all: true, aud_exclude: [member2] }), true, null);
  assert.deepEqual(titles(await list(member2)), []);
  assert.deepEqual(titles(await list(member)), ["Primeiros passos nas Tarefas"]);
  assert.ok(cur.length === 1);
  await rejects(
    () => save(manager, first.id, tour({ aud_all: false }), true),
    /Escolha quem recebe/,
  );
});

await check("alteração de um publicado fica à parte até publicar de novo", async () => {
  await as(manager);
  let d = await rpc("tutorial_tour_detail", [first.id]);
  const r = await save(manager, first.id, tour({ title: "Primeiros passos (novo)", aud_exclude: [member2] }), false, d.revision);
  assert.equal(r.mode, "draft");
  assert.deepEqual(titles(await list(member)), ["Primeiros passos nas Tarefas"]);
  await as(manager);
  d = await rpc("tutorial_tour_detail", [first.id]);
  assert.equal(d.draft.content.title, "Primeiros passos (novo)");
  // Quem recebe não vê o rascunho nem o público.
  await as(member);
  const seen = await rpc("tutorial_tour_detail", [first.id]);
  assert.equal(seen.draft, null);
  assert.equal(seen.audience, null);
  // Revisão velha é recusada.
  await rejects(() => save(manager, first.id, tour(), false, 1), /alterado por outra pessoa/);
  // O administrador edita o do gestor.
  await as(admin);
  d = await rpc("tutorial_tour_detail", [first.id]);
  await save(admin, first.id, d.draft.content, true, d.revision);
  assert.deepEqual(titles(await list(member)), ["Primeiros passos (novo)"]);
  await as(admin);
  assert.equal((await rpc("tutorial_tour_detail", [first.id])).draft, null);
});

await check("filtro do \"?\": por módulo ou pela página onde começa", async () => {
  assert.equal((await list(member, "library", "tasks", null)).length, 1);
  assert.equal((await list(member, "library", "campaigns", null)).length, 0);
  assert.equal((await list(member, "library", "campaigns", "tasks")).length, 1);
  assert.equal((await list(member, "library", null, "drive")).length, 0);
});

await check("progresso: começar, avançar, fechar e concluir", async () => {
  await as(member);
  let p = await rpc("set_tutorial_tour_progress", [first.id, "start", 0, "passo1"]);
  assert.equal(p.status, "started");
  p = await rpc("set_tutorial_tour_progress", [first.id, "step", 9, "passo2"]);
  assert.equal(p.step, 1); // limitado ao último passo
  p = await rpc("set_tutorial_tour_progress", [first.id, "dismiss", 1, "passo2"]);
  assert.equal(p.status, "dismissed");
  let l = await list(member);
  assert.equal(l[0].my_status, "dismissed");
  assert.equal(l[0].my_step, 1);
  await as(member);
  p = await rpc("set_tutorial_tour_progress", [first.id, "complete", 1, "passo2"]);
  assert.equal(p.status, "completed");
  // Passear de novo não desfaz o concluído.
  p = await rpc("set_tutorial_tour_progress", [first.id, "step", 0, "passo1"]);
  assert.equal(p.status, "completed");
  await rejects(() => rpc("set_tutorial_tour_progress", [first.id, "pular", 0, ""]), /Ação inválida/);
  // Quem não recebe não registra nada.
  await as(member2);
  assert.equal(await rpc("set_tutorial_tour_progress", [first.id, "start", 0, ""]), null);
});

await check("passo não encontrado: contado por versão, só para quem edita", async () => {
  await as(member);
  await rpc("log_tutorial_tour_miss", [first.id, "passo2", "/tarefas"]);
  await rpc("log_tutorial_tour_miss", [first.id, "passo2", "/tarefas"]);
  await rpc("log_tutorial_tour_miss", [first.id, "naoexiste", "/tarefas"]);
  await as(member2); // excluída: não conta
  await rpc("log_tutorial_tour_miss", [first.id, "passo2", "/tarefas"]);
  await as(manager);
  const d = await rpc("tutorial_tour_detail", [first.id]);
  assert.equal(d.misses.length, 1);
  assert.equal(d.misses[0].misses, 2);
  assert.equal(d.misses[0].people, 1);
  assert.equal((await list(manager, "admin"))[0].misses, 2);
  await as(member);
  assert.equal((await rpc("tutorial_tour_detail", [first.id])).misses, null);
  assert.equal((await list(member))[0].misses, 0);
});

await check("tirar do ar e apagar; tabelas sem leitura direta; aviso ao vivo", async () => {
  await as(member);
  await rejects(() => db.query("select * from public.tutorial_tours"), /permission denied/);
  await as(member);
  await rejects(() => rpc("unpublish_tutorial_tour", [first.id]), /Sem permissão/);
  await as(manager);
  await rpc("unpublish_tutorial_tour", [first.id]);
  assert.deepEqual(titles(await list(member)), []);
  await db.exec("reset role");
  const msgs = (await db.query(`select payload from realtime.messages where payload->>'kind' = 'tutorials'`)).rows;
  assert.ok(msgs.some((m) => JSON.stringify(m.payload).includes(first.id)));
  await as(manager2);
  await rejects(() => rpc("delete_tutorial_tour", [first.id]), /Só um administrador ou o gestor que criou/);
  await as(manager);
  await rpc("delete_tutorial_tour", [first.id]);
  assert.deepEqual(titles(await list(manager, "admin")), []);
});

console.log(`\n${passed} verificações passaram.`);

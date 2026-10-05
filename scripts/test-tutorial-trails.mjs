// Trilhas dos Tutoriais (migration 20270424090000_tutorial_trails): só
// líderes montam, gestores editam só as próprias, público e obrigatoriedade
// (quem entra depois, papel, equipe), chegada com aviso, prazo e atraso,
// progresso por tutorial (automático, botão, desmarcar), tutorial que a
// pessoa não vê fora da conta, "pedir que releiam" e o progresso do time.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, manager, manager2, member, member2, newbie, stranger] = [1, 2, 10, 11, 12, 13, 14, 16, 15].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, manager, manager2, member, member2, newbie, stranger],
]);
await db.query(`insert into companies(id,name) values($1,'Make'),($2,'Outra')`, [A, B]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Gabi Gestora','manager',true),($1,$4,'Gil Gestor','manager',true),
   ($1,$5,'Bruno Colaborador','member',true),($1,$6,'Carla Colaboradora','member',true),
   ($7,$8,'Duda Outra','admin',true)`,
  [A, admin, manager, manager2, member, member2, B, stranger],
);
// Quem já estava entrou antes de qualquer trilha.
await db.query(`update memberships set joined_at = now() - interval '30 days'`);

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
  (
    await db.query(
      `select * from public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})`,
      args,
    )
  ).rows;
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
const tutorial = async (title, extra = {}, publish = true) => {
  await as(admin);
  return (await rpc("save_tutorial", [A, null, { title, body: body(`Texto de ${title}`), ...extra }, publish, null])).id;
};
const saveTrail = async (user, id, content, publish = false, revision = null) => {
  await as(user);
  return rpc("save_tutorial_trail", [A, id, content, publish, revision]);
};
const trails = async (user) => {
  await as(user);
  return rows("list_tutorial_trails", [A]);
};
const progress = async (user, tutorialId, action) => {
  await as(user);
  return rpc("set_tutorial_progress", [tutorialId, action]);
};
const inbox = (user) =>
  sql(`select title, body, link from notifications where user_id = $1 and kind = 'tutorial_trail' order by created_at, title`, [
    user,
  ]);

await as(admin);
const team = await rpc("create_team", [A, "Equipe Tráfego", [member]]);
const t1 = await tutorial("Criar uma tarefa");
const t2 = await tutorial("Mudar o prazo");
const t3 = await tutorial("Entregar a tarefa");
// Só administradores veem este (público por papel).
const tAdmins = await tutorial("Configurar a MAVI", { aud_all: false, aud_roles: ["admin"] });
const tDraft = await tutorial("Rascunho", {}, false);

await check("colaborador não monta trilha; título e tutoriais conferidos", async () => {
  await as(member);
  await rejects(() => rpc("save_tutorial_trail", [A, null, { title: "Minha" }, false, null]), /administradores e gestores/);
  await rejects(() => saveTrail(manager, null, { title: "x" }), /título de 3 a 120/);
  await rejects(() => saveTrail(manager, null, { title: "Vazia" }, true), /ao menos um tutorial/);
  await rejects(
    () => saveTrail(manager, null, { title: "Ninguém", aud_all: false }),
    /quem vê a trilha/,
  );
  // De outra empresa ou inexistente: some; repetido: fica a primeira posição.
  const r = await saveTrail(manager, null, {
    title: "Primeiros passos",
    tutorials: [t2, t1, t2, uid(999), "lixo"],
  });
  assert.equal(r.status, "draft");
  assert.equal(r.revision, 1);
  const items = await sql(`select tutorial_id from tutorial_trail_items where trail_id = $1 order by position`, [r.id]);
  assert.deepEqual(items.map((i) => i.tutorial_id), [t2, t1]);
});

const [{ id: draftTrail }] = await sql(`select id from tutorial_trails where title = 'Primeiros passos'`);

await check("rascunho de trilha: só quem edita; gestor edita só a própria", async () => {
  assert.deepEqual((await trails(member)).map((t) => t.title), []);
  assert.deepEqual((await trails(manager2)).map((t) => t.title), []);
  assert.deepEqual((await trails(admin)).map((t) => t.title), ["Primeiros passos"]);
  await rejects(() => saveTrail(manager2, draftTrail, { title: "Tomada", tutorials: [t1] }), /gestor que criou/);
  await as(member);
  assert.equal(await rpc("tutorial_trail_detail", [draftTrail]), null);
  await rejects(() => saveTrail(manager, draftTrail, { title: "Primeiros passos", tutorials: [t1] }, false, 7), /alterada por outra pessoa/);
});

await check("publicada e opcional: todos veem, ninguém é avisado", async () => {
  const r = await saveTrail(manager, draftTrail, {
    title: "Primeiros passos",
    summary: "O básico",
    tutorials: [t1, t2, t3, tAdmins, tDraft],
  }, true, 1);
  assert.equal(r.status, "published");
  const [mine] = await trails(member);
  assert.equal(mine.title, "Primeiros passos");
  assert.equal(mine.for_me, true);
  assert.equal(mine.required_for_me, false);
  // O tutorial só de administradores e o rascunho não contam para o colaborador.
  assert.equal(mine.total, 3);
  assert.equal(mine.done, 0);
  assert.equal(mine.next_tutorial, t1);
  assert.equal(mine.people, null);
  const [adminView] = await trails(admin);
  assert.equal(adminView.total, 4);
  // Líderes: o resumo do time (todas as pessoas ativas veem).
  assert.equal(adminView.people, 5);
  assert.equal(adminView.people_done, 0);
  assert.deepEqual(await inbox(member), []);
  await as(member);
  const d = await rpc("tutorial_trail_detail", [draftTrail]);
  assert.deepEqual(d.items.map((i) => i.title), ["Criar uma tarefa", "Mudar o prazo", "Entregar a tarefa"]);
  assert.equal(d.config, null);
  assert.equal(d.can_edit, false);
  await as(manager);
  const e = await rpc("tutorial_trail_detail", [draftTrail]);
  assert.equal(e.items.length, 5);
  assert.deepEqual(e.items.filter((i) => !i.visible).map((i) => i.title), ["Configurar a MAVI", "Rascunho"]);
  assert.equal(e.config.aud_all, true);
});

await check("progresso: abrir, concluir sozinho, desmarcar trava o automático, botão volta", async () => {
  let p = await progress(member, t1, "open");
  assert.equal(p.completed_at, null);
  p = await progress(member, t1, "auto");
  assert.ok(p.completed_at);
  assert.equal(p.completed_how, "auto");
  assert.equal(p.completed_version, 1);
  p = await progress(member, t1, "undo");
  assert.equal(p.completed_at, null);
  assert.equal(p.undone, true);
  p = await progress(member, t1, "auto");
  assert.equal(p.completed_at, null, "quem desmarcou não conclui sozinho");
  p = await progress(member, t1, "complete");
  assert.ok(p.completed_at);
  assert.equal(p.completed_how, "manual");
  assert.equal(p.undone, false);
  // Rascunho e tutorial fora do público não registram.
  assert.equal(await progress(member, tDraft, "complete"), null);
  assert.equal(await progress(member, tAdmins, "complete"), null);
  await rejects(() => progress(member, t1, "apagar"), /Ação inválida/);
  const [mine] = await trails(member);
  assert.equal(mine.done, 1);
  assert.equal(mine.next_tutorial, t2);
  await as(member);
  const d = await rpc("tutorial_detail", [t1]);
  assert.equal(d.trackable, true);
  assert.ok(d.progress.completed_at);
  assert.deepEqual(d.trails.map((t) => t.title), ["Primeiros passos"]);
  // O aviso ao vivo diz quem e qual, sem o conteúdo.
  const [msg] = await sql(
    `select payload from realtime.messages where payload->>'progress' = 'true' order by id desc limit 1`,
  );
  assert.equal(msg.payload.user, member);
  assert.equal(msg.payload.tutorial, t1);
});

await check("tutorial atualizado: continua concluído; pedir que releiam volta a pendente", async () => {
  await as(admin);
  const [cur] = await sql(`select revision from tutorials where id = $1`, [t1]);
  await rpc("save_tutorial", [A, t1, { title: "Criar uma tarefa", body: body("Versão nova") }, true, cur.revision]);
  await as(member);
  let d = await rpc("tutorial_detail", [t1]);
  assert.equal(d.version, 2);
  assert.equal(d.progress.completed_version, 1);
  await as(member);
  await rejects(() => rpc("ask_tutorial_reread", [t1]), /Sem permissão/);
  await as(admin);
  assert.equal(await rpc("ask_tutorial_reread", [t1]), 1);
  await as(member);
  d = await rpc("tutorial_detail", [t1]);
  assert.equal(d.progress.completed_at, null);
  assert.equal(d.progress.undone, false);
  // Depois de pedir releitura, chegar ao fim conclui de novo (versão 2).
  const p = await progress(member, t1, "auto");
  assert.equal(p.completed_version, 2);
});

await check("obrigatória para uma equipe: chega com aviso e prazo", async () => {
  const r = await saveTrail(manager, null, {
    title: "Tráfego obrigatório",
    tutorials: [t1, t2],
    aud_all: false,
    req_teams: [team],
    due_days: 7,
  }, true);
  const [x] = await sql(`select user_id from tutorial_trail_assignments where trail_id = $1`, [r.id]);
  assert.equal(x.user_id, member);
  const notes = await inbox(member);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, "Trilha obrigatória: Tráfego obrigatório");
  assert.match(notes[0].body, /^2 tutoriais · conclua até \d\d\/\d\d$/);
  assert.equal(notes[0].link, `/tutoriais?trilha=${r.id}`);
  // Quem não é da equipe nem vê (o público é só o obrigatório).
  assert.deepEqual((await trails(member2)).map((t) => t.title), ["Primeiros passos"]);
  const mine = (await trails(member)).find((t) => t.title === "Tráfego obrigatório");
  assert.equal(mine.required_for_me, true);
  assert.ok(mine.due_at);
  assert.equal(mine.done, 1);
  // Obrigatórias pendentes vêm primeiro.
  assert.equal((await trails(member))[0].title, "Tráfego obrigatório");
  await as(member);
  assert.equal(await rpc("my_tutorial_trails_pending", [A]), 1);
  await as(member2);
  assert.equal(await rpc("my_tutorial_trails_pending", [A]), 0);
  // Salvar de novo não avisa de novo.
  const [{ revision }] = await sql(`select revision from tutorial_trails where id = $1`, [r.id]);
  await saveTrail(manager, r.id, { title: "Tráfego obrigatório", tutorials: [t1, t2], aud_all: false, req_teams: [team], due_days: 7 }, false, revision);
  assert.equal((await inbox(member)).length, 1);
});

const [{ id: teamTrail }] = await sql(`select id from tutorial_trails where title = 'Tráfego obrigatório'`);

await check("quem entra na equipe depois recebe pela rotina; prazo vencido avisa uma vez", async () => {
  await sql(`insert into team_members(company_id, team_id, user_id) values($1,$2,$3)`, [A, team, member2]);
  await sql(`select mavi_private.tutorial_trails_run()`);
  assert.equal((await inbox(member2)).length, 1);
  // O prazo do colaborador venceu.
  await sql(`update tutorial_trail_assignments set assigned_at = now() - interval '8 days' where user_id = $1 and trail_id = $2`, [
    member,
    teamTrail,
  ]);
  await sql(`select mavi_private.tutorial_trails_run()`);
  await sql(`select mavi_private.tutorial_trails_run()`);
  const notes = await inbox(member);
  assert.equal(notes.length, 2);
  assert.equal(notes[1].title, "Trilha atrasada: Tráfego obrigatório");
  assert.match(notes[1].body, /^O prazo era \d\d\/\d\d\. Faltam 1 de 2 tutoriais\.$/);
  // Líderes veem o atraso.
  await as(manager2);
  const team1 = (await rows("list_tutorial_trails", [A])).find((t) => t.title === "Tráfego obrigatório");
  assert.equal(team1.people, 2);
  assert.equal(team1.people_overdue, 1);
  await as(manager2);
  const people = await rows("tutorial_trail_progress", [teamTrail]);
  assert.deepEqual(people.map((p) => [p.name, p.state, p.done, p.total]), [
    ["Bruno Colaborador", "overdue", 1, 2],
    ["Carla Colaboradora", "todo", 0, 2],
  ]);
  assert.deepEqual(people[0].done_ids, [t1]);
  // Colaborador não vê o progresso dos outros.
  await as(member);
  assert.deepEqual(await rows("tutorial_trail_progress", [teamTrail]), []);
});

await check("concluir tudo tira do número e marca concluída para os líderes", async () => {
  await progress(member, t2, "complete");
  await as(member);
  assert.equal(await rpc("my_tutorial_trails_pending", [A]), 0);
  await as(admin);
  const people = await rows("tutorial_trail_progress", [teamTrail]);
  const bruno = people.find((p) => p.user_id === member);
  assert.equal(bruno.state, "done");
  assert.ok(bruno.last_done_at);
  // Concluída não recebe outro aviso de atraso.
  await sql(`update tutorial_trail_assignments set overdue_notified_at = null where user_id = $1`, [member]);
  await sql(`select mavi_private.tutorial_trails_run()`);
  assert.equal((await inbox(member)).length, 2);
});

await check("obrigatória para quem entrar a partir de agora: só os novos", async () => {
  const r = await saveTrail(admin, null, {
    title: "Boas-vindas",
    tutorials: [t1],
    req_newcomers: true,
  }, true);
  assert.equal((await sql(`select count(*)::int n from tutorial_trail_assignments where trail_id = $1`, [r.id]))[0].n, 0);
  const [cfg] = await sql(`select req_since from tutorial_trails where id = $1`, [r.id]);
  assert.ok(cfg.req_since);
  await sql(`insert into memberships(company_id,user_id,name,role,active) values($1,$2,'Nina Nova','member',true)`, [A, newbie]);
  await sql(`select mavi_private.tutorial_trails_run()`);
  const notes = await inbox(newbie);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, "Trilha obrigatória: Boas-vindas");
  assert.equal(notes[0].body, "1 tutorial");
  await as(newbie);
  const mine = (await rows("list_tutorial_trails", [A])).find((t) => t.title === "Boas-vindas");
  assert.equal(mine.required_for_me, true);
  assert.equal(mine.due_at, null);
  // Salvar de novo mantém o marco (não vira "a partir de agora" outra vez).
  const [{ revision }] = await sql(`select revision from tutorial_trails where id = $1`, [r.id]);
  await saveTrail(admin, r.id, { title: "Boas-vindas", tutorials: [t1, t2], req_newcomers: true }, false, revision);
  const [after] = await sql(`select req_since from tutorial_trails where id = $1`, [r.id]);
  assert.equal(String(after.req_since), String(cfg.req_since));
  // Excluída de "quem vê" também sai da obrigação.
  const [{ revision: rev2 }] = await sql(`select revision from tutorial_trails where id = $1`, [r.id]);
  await saveTrail(admin, r.id, { title: "Boas-vindas", tutorials: [t1, t2], req_newcomers: true, aud_exclude: [newbie] }, false, rev2);
  await as(newbie);
  assert.equal(await rpc("my_tutorial_trails_pending", [A]), 0);
});

await check("tirar do ar e apagar: só quem edita; outra empresa não vê", async () => {
  await as(stranger);
  await rejects(() => rows("list_tutorial_trails", [A]), /Sem acesso/);
  await as(stranger);
  assert.equal(await rpc("tutorial_trail_detail", [draftTrail]), null);
  await as(manager2);
  await rejects(() => rpc("unpublish_tutorial_trail", [draftTrail]), /Sem permissão/);
  await as(manager);
  await rpc("unpublish_tutorial_trail", [draftTrail]);
  assert.ok(!(await trails(member)).some((t) => t.title === "Primeiros passos"));
  await as(manager2);
  await rejects(() => rpc("delete_tutorial_trail", [draftTrail]), /gestor que criou/);
  await as(admin);
  await rpc("delete_tutorial_trail", [draftTrail]);
  assert.equal((await sql(`select count(*)::int n from tutorial_trail_items where trail_id = $1`, [draftTrail]))[0].n, 0);
  // Apagar um tutorial tira da trilha.
  await as(admin);
  await db.query(`select public.delete_tutorial($1)`, [t2]);
  assert.deepEqual(
    (await sql(`select tutorial_id from tutorial_trail_items where trail_id = $1`, [teamTrail])).map((i) => i.tutorial_id),
    [t1],
  );
});

await check("tabelas sem leitura direta", async () => {
  for (const table of ["tutorial_trails", "tutorial_trail_items", "tutorial_progress", "tutorial_trail_assignments"]) {
    await as(member);
    await rejects(() => db.query(`select * from ${table}`), /permission denied/);
  }
});

console.log(`\n${passed} verificações das trilhas dos Tutoriais passaram.`);

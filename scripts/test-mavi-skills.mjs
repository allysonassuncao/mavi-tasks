// MAVI · Skills (migration 20261214090000_mavi_skills): qualquer pessoa cria,
// líderes aprovam (as deles já publicadas); editar a publicada abre uma
// versão nova que volta para aprovação (a publicada segue valendo); versões
// enviadas não mudam; líderes restauram versões antigas; quem usa depende do
// poder 'skills' e do público da skill; quem criou testa a versão em aberto;
// cada uso guarda a skill e a versão; avisos para aprovar e para quem criou.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, manager, ana, bia, caio, otto] = [1, 2, 10, 11, 12, 13, 14, 15].map(uid);
const team = uid(30);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, manager, ana, bia, caio, otto]]);
await db.query(`insert into companies(id,name) values($1,'Make'),($2,'Beta')`, [A, B]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$3,'Ana Admin','admin',true),($1,$4,'Gil Gestor','manager',true),
   ($1,$5,'Ana Souza','member',true),($1,$6,'Bia Lima','member',true),
   ($1,$7,'Caio Rocha','member',true),($2,$8,'Otto','admin',true)`,
  [A, B, admin, manager, ana, bia, caio, otto],
);
await db.query(`insert into teams(id,company_id,name) values($2,$1,'Criação')`, [A, team]);
await db.query(`insert into team_members(company_id,team_id,user_id) values($1,$2,$3)`, [A, team, bia]);

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
const sql = async (text, args = []) => {
  await db.exec("reset role");
  return (await db.query(text, args)).rows;
};
const files = (...list) => JSON.stringify(list.map(([name, content]) => ({ name, content })));
const save = (user, skill, fields = {}, submit = false) =>
  one(user, "select public.ai_skill_save($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)", [
    A,
    skill,
    fields.slug ?? null,
    fields.name ?? "Relatório mensal",
    fields.description ?? "Quando pedirem o relatório mensal de um cliente.",
    fields.instructions ?? "1. Busque as campanhas do mês.\n2. Monte os indicadores.",
    fields.files ?? files(["references/modelo.md", "# Modelo\nSeções: resumo, números."]),
    fields.note ?? null,
    submit,
  ]);
const catalog = async (user) =>
  (await one(user, "select public.ai_skill_catalog($1)", [A])).map((s) => `${s.slug}@${s.version}`);
const load = (user, slug, version = null) =>
  one(user, "select public.ai_skill_load($1,$2,$3)", [A, slug, version]);
const notes = async (user) =>
  (await sql("select title, body, link from notifications where company_id=$1 and user_id=$2 and kind='ai_skill' order by created_at, id", [A, user]));
let passed = 0;
async function check(title, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${title}`);
  } catch (e) {
    console.error(`FAIL ${title}`, String(e?.message ?? e).slice(0, 400));
    throw e;
  }
}

// O poder vem desligado; liga para todos.
await q(manager, "select public.ai_set_power($1,'skills',true,true,'{}','{}','{}')", [A]);
let skill;

await check("qualquer pessoa cria um rascunho; só ela e os líderes veem", async () => {
  await assert.rejects(() => save(ana, null, { slug: "Relatório Mensal" }), /identificador usa letras minúsculas/);
  const r = await save(ana, null, { slug: "relatorio-mensal" });
  skill = r.id;
  assert.deepEqual([r.version, r.state], [1, "draft"]);
  await assert.rejects(() => save(bia, null, { slug: "relatorio-mensal" }), /Já existe uma skill/);
  assert.deepEqual(await catalog(bia), []);
  assert.equal((await one(bia, "select public.ai_skills_list($1)", [A])).length, 0);
  await assert.rejects(() => one(bia, "select public.ai_skill_get($1)", [skill]), /Skill não encontrada/);
  await assert.rejects(() => save(bia, skill, {}), /Só quem criou a skill e os líderes editam/);
  const mine = (await one(ana, "select public.ai_skills_list($1)", [A]))[0];
  assert.equal(mine.mine, true);
  assert.equal(mine.latest.state, "draft");
  assert.equal(mine.available, false);
  // As tabelas não se leem direto.
  await assert.rejects(() => q(ana, "select * from public.ai_skills"), /permission denied/);
});

await check("quem criou testa o rascunho; os outros não", async () => {
  const draft = await load(ana, "relatorio-mensal", 1);
  assert.equal(draft.test, true);
  assert.deepEqual(draft.files, [{ name: "references/modelo.md", size: 36 }]);
  assert.equal(await load(ana, "relatorio-mensal"), null);
  assert.equal(await load(bia, "relatorio-mensal", 1), null);
  assert.match(
    await one(ana, "select public.ai_skill_file($1,'relatorio-mensal',1,'references/modelo.md')", [A]),
    /^# Modelo/,
  );
  assert.equal(await one(bia, "select public.ai_skill_file($1,'relatorio-mensal',1,'references/modelo.md')", [A]), null);
});

await check("enviar para aprovação avisa os líderes; aprovar publica", async () => {
  const r = await save(ana, skill, { note: "Primeira versão" }, true);
  assert.deepEqual([r.version, r.state], [1, "pending"]);
  assert.equal(await one(manager, "select public.ai_skill_review_count($1)", [A]), 1);
  assert.equal(await one(ana, "select public.ai_skill_review_count($1)", [A]), 0);
  const [n] = await notes(admin);
  assert.deepEqual(n, {
    title: "Skill da MAVI para aprovar",
    body: "Relatório mensal · versão 1",
    link: `/mavi/skills/${skill}`,
  });
  assert.equal((await notes(ana)).length, 0);
  await assert.rejects(() => q(ana, "select public.ai_skill_review($1,1,true,null)", [skill]), /Só administradores e gestores aprovam/);
  await q(manager, "select public.ai_skill_review($1,1,true,'Ótima')", [skill]);
  assert.deepEqual(await catalog(bia), ["relatorio-mensal@1"]);
  assert.equal((await notes(ana))[0].title, "Sua skill foi aprovada");
  assert.equal((await load(bia, "relatorio-mensal")).version, 1);
});

await check("quem usa: o poder e o público da skill", async () => {
  await q(manager, "select public.ai_skill_set_audience($1,false,$2::uuid[],'{}','{}')", [skill, [team]]);
  assert.deepEqual(await catalog(bia), ["relatorio-mensal@1"]);
  assert.deepEqual(await catalog(caio), []);
  assert.equal(await load(caio, "relatorio-mensal"), null);
  await assert.rejects(
    () => q(ana, "select public.ai_skill_set_audience($1,true,'{}','{}','{}')", [skill]),
    /Só administradores e gestores dizem quem usa/,
  );
  await q(manager, "select public.ai_skill_set_audience($1,true,'{}','{}',$2::uuid[])", [skill, [bia]]);
  assert.deepEqual(await catalog(bia), []);
  assert.deepEqual(await catalog(caio), ["relatorio-mensal@1"]);
  await q(manager, "select public.ai_skill_set_audience($1,true,'{}','{}','{}')", [skill]);
  // Sem o poder, nenhuma skill (nem a versão em teste).
  await q(manager, "select public.ai_set_power($1,'skills',true,true,'{}','{}',$2::uuid[])", [A, [ana]]);
  assert.deepEqual(await catalog(ana), []);
  assert.equal(await load(ana, "relatorio-mensal", 1), null);
  await q(manager, "select public.ai_set_power($1,'skills',true,true,'{}','{}','{}')", [A]);
  assert.deepEqual(await catalog(otto), []);
});

await check("editar a publicada abre a versão 2; a 1 segue valendo até aprovarem", async () => {
  const r = await save(ana, skill, { instructions: "1. Busque as campanhas e as reuniões do mês.\n2. Resuma." });
  assert.deepEqual([r.version, r.state], [2, "draft"]);
  assert.deepEqual(await catalog(bia), ["relatorio-mensal@1"]);
  const r2 = await save(ana, skill, { instructions: "1. Busque as campanhas e as reuniões do mês.\n2. Resuma em tópicos." }, true);
  assert.deepEqual([r2.version, r2.state], [2, "pending"]);
  await assert.rejects(() => q(admin, "select public.ai_skill_review($1,2,false,'')", [skill]), /Diga o que precisa mudar/);
  await q(admin, "select public.ai_skill_review($1,2,false,'Falta o período')", [skill]);
  assert.deepEqual(await catalog(bia), ["relatorio-mensal@1"]);
  const back = (await notes(ana)).at(-1);
  assert.equal(back.title, "Sua skill voltou para ajustes");
  assert.match(back.body, /Falta o período/);
  // Devolvida fica no histórico: a próxima edição é a versão 3.
  const r3 = await save(ana, skill, { note: "Com o período" }, true);
  assert.equal(r3.version, 3);
  await assert.rejects(() => q(admin, "select public.ai_skill_review($1,2,true,null)", [skill]), /não está esperando aprovação/);
  await q(admin, "select public.ai_skill_review($1,3,true,null)", [skill]);
  assert.deepEqual(await catalog(bia), ["relatorio-mensal@3"]);
  const got = await one(ana, "select public.ai_skill_get($1)", [skill]);
  assert.deepEqual(got.versions.map((v) => [v.version, v.state]), [
    [3, "approved"],
    [2, "rejected"],
    [1, "superseded"],
  ]);
  // Quem só usa vê a publicada, sem histórico nem outras versões.
  const seen = await one(bia, "select public.ai_skill_get($1)", [skill]);
  assert.equal(seen.version.version, 3);
  assert.deepEqual(seen.versions, []);
  await assert.rejects(() => one(bia, "select public.ai_skill_get($1,2)", [skill]), /Skill não encontrada/);
});

await check("líderes restauram uma versão antiga (vira uma versão nova, publicada)", async () => {
  await assert.rejects(() => one(ana, "select public.ai_skill_restore($1,1)", [skill]), /Só administradores e gestores restauram/);
  await assert.rejects(() => one(admin, "select public.ai_skill_restore($1,2)", [skill]), /já foi publicada/);
  assert.equal(await one(admin, "select public.ai_skill_restore($1,1)", [skill]), 4);
  assert.deepEqual(await catalog(bia), ["relatorio-mensal@4"]);
  const v4 = await one(admin, "select public.ai_skill_get($1,4)", [skill]);
  assert.equal(v4.version.note, "Restaurada da versão 1");
  assert.equal(v4.version.instructions, "1. Busque as campanhas do mês.\n2. Monte os indicadores.");
  assert.equal(v4.version.files.length, 1);
});

await check("as skills dos líderes já nascem publicadas; arquivos com o mesmo nome não", async () => {
  await assert.rejects(
    () => save(manager, null, { slug: "dup", files: files(["a.md", "x"], ["a.md", "y"]) }, true),
    /Dois arquivos com o mesmo nome/,
  );
  await assert.rejects(() => save(manager, null, { slug: "ruim", files: files(["../segredo", "x"]) }, true));
  const r = await save(manager, null, { slug: "briefing", name: "Briefing" }, true);
  assert.deepEqual([r.version, r.state], [1, "approved"]);
  assert.deepEqual(await catalog(caio), ["briefing@1", "relatorio-mensal@4"]);
});

await check("cada uso guarda a skill e a versão", async () => {
  await q(bia, "select public.ai_log_tool_calls($1,null,'assistant',$2::jsonb)", [
    A,
    JSON.stringify([
      { tool: "use_skill", power: "skills", ok: true, ms: 50, skill, skill_version: 4 },
      { tool: "use_skill", power: "skills", ok: true, ms: 50, skill: uid(99), skill_version: 1 },
    ]),
  ]);
  const rows = await sql("select skill_id, skill_version from ai_tool_calls order by id");
  assert.deepEqual(rows.map((r) => [r.skill_id, r.skill_version]), [
    [skill, 4],
    [null, null],
  ]);
  const list = await one(manager, "select public.ai_skills_list($1)", [A]);
  assert.equal(Number(list.find((s) => s.id === skill).uses_30d), 1);
  const got = await one(admin, "select public.ai_skill_get($1)", [skill]);
  assert.equal(Number(got.versions.find((v) => v.version === 4).uses), 1);
});

await check("arquivar tira do catálogo; a publicada só os líderes apagam", async () => {
  await q(ana, "select public.ai_skill_archive($1,true)", [skill]);
  assert.deepEqual(await catalog(bia), ["briefing@1"]);
  await assert.rejects(() => q(ana, "select public.ai_skill_delete($1)", [skill]), /só os líderes apagam/);
  await q(admin, "select public.ai_skill_delete($1)", [skill]);
  assert.equal((await sql("select count(*)::int n from ai_skill_versions where skill_id = $1", [skill]))[0].n, 0);
  // Um rascunho, quem criou apaga.
  const r = await save(caio, null, { slug: "rascunho" });
  await q(caio, "select public.ai_skill_delete($1)", [r.id]);
});

console.log(`\n${passed} checks passed`);

// Painel da MAVI › Quem usa qual modelo: histórico de alterações (migration
// 20270223090000_ai_settings_log). Cada campo gravado por gatilho (regras,
// esforço, provedores, animações do Mural), só o que mudou de fato, as
// causas do que sai sozinho (provedor excluído, modelo tirado, skill
// apagada), a chave nunca no histórico, ninguém altera nem apaga, só
// líderes leem, os filtros no banco e o estado inicial na aplicação.
import assert from "node:assert/strict";
import { applyMigration, createTestDatabase } from "./database-fixture.mjs";

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, manager, member, outsider] = [1, 2, 10, 11, 12, 13].map(uid);
const [client, product, contract, project, team] = [20, 22, 23, 24, 25].map(uid);

async function setup(db) {
  await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, manager, member, outsider]]);
  await db.query(`insert into companies(id,name) values($1,'Make'),($2,'Beta')`, [A, B]);
  await db.query(
    `insert into memberships(company_id,user_id,name,role,active) values
     ($1,$3,'Ana Admin','admin',true),($1,$4,'Gabi Gestora','manager',true),
     ($1,$5,'Bruno Colab','member',true),($2,$6,'Otto','admin',true)`,
    [A, B, admin, manager, member, outsider],
  );
  for (const [sql, args] of [
    [`insert into clients(id,company_id,name) values($2,$1,'ACME')`, [A, client]],
    [`insert into products(id,company_id,name) values($2,$1,'Tráfego')`, [A, product]],
    [`insert into contracts(id,company_id,client_id,product_id,name) values($2,$1,$3,$4,'Tráfego')`, [A, contract, client, product]],
    [`insert into projects(id,company_id,contract_id,name) values($2,$1,$3,'Lançamento')`, [A, project, contract]],
    [`insert into teams(id,company_id,name) values($2,$1,'Time')`, [A, team]],
  ])
    await db.query(sql, args);
}

function helpers(db) {
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
  return { as, q, one };
}

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

// ------------------------------------------------------------ estado inicial
await check("na aplicação, a configuração que já existe entra como estado inicial", async () => {
  const db = await createTestDatabase({ until: "20270223090000" });
  await setup(db);
  const { one, q } = helpers(db);
  const p = await one(admin, "select public.ai_save_provider($1,null,'Claude','anthropic',null,$2::jsonb,'v1:abc','wxyz',true)", [
    A, JSON.stringify([{ id: "claude-a", label: "Claude A", input: 1, output: 5 }]),
  ]);
  await q(admin, "select public.ai_set_route($1,'company',null,$2,'claude-a')", [A, p]);
  await q(manager, "select public.ai_set_route($1,'user',$2,$3,'claude-a')", [A, member, p]);
  await q(admin, "select public.ai_set_effort($1,'assistant','high')", [A]);
  await db.exec("reset role");
  await applyMigration(db, "20270223090000");
  const items = (await one(admin, "select public.ai_settings_log($1)", [A])).items;
  assert.deepEqual(
    items.map((i) => `${i.area}:${i.field}:${i.action}:${i.cause?.type}`).sort(),
    ["company:model:created:baseline", "feature:effort:created:baseline", "provider:provider:created:baseline", "user:model:created:baseline"],
  );
  const user = items.find((i) => i.area === "user");
  assert.equal(user.actor, manager);
  assert.equal(user.subject_label, "Bruno Colab");
  assert.deepEqual(user.new, { provider_id: p, provider: "Claude", model: "claude-a", model_label: "Claude A" });
  assert.ok(!JSON.stringify(items).includes("v1:"));
});

const db = await createTestDatabase();
await setup(db);
const { q, one } = helpers(db);
const models = (...list) => JSON.stringify(list.map(([id, input = 1, output = 5]) => ({ id, input, output })));
const save = (name, kind, list, cipher = "v1:abc", id = null) =>
  one(admin, "select public.ai_save_provider($1,$2,$3,$4,null,$5::jsonb,$6,'wxyz',true)", [A, id, name, kind, list, cipher]);
const route = (user, type, id, provider, model, feature = null) =>
  q(user, "select public.ai_set_route($1,$2,$3,$4,$5,$6)", [A, type, id, provider, model, feature]);
const effort = (user, key, value) => q(user, "select public.ai_set_effort($1,$2,$3)", [A, key, value]);
const log = async (filters = {}, user = admin) =>
  (
    await one(user, "select public.ai_settings_log($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
      A, filters.area ?? null, filters.subject ?? null, filters.field ?? null, filters.actor ?? null,
      filters.from ?? null, filters.to ?? null, filters.before ?? null, filters.limit ?? null,
    ])
  ).items;
const last = async (filters) => (await log(filters))[0];
const total = async () => {
  await db.exec("reset role");
  return (await db.query("select count(*)::int n from mavi_private.ai_settings_log where company_id = $1", [A])).rows[0].n;
};

let claude, openai;
await check("provedores: cadastro e cada campo alterado, sem a chave", async () => {
  claude = await save("Claude", "anthropic", models(["claude-a"], ["claude-b"]));
  openai = await save("OpenAI", "openai", models(["gpt-a"], ["gpt-b"], ["whisper-1"]));
  const created = await last({ area: "provider", subject: claude });
  assert.equal(created.action, "created");
  assert.equal(created.field, "provider");
  assert.equal(created.actor, admin);
  assert.equal(created.new.name, "Claude");
  assert.equal(created.new.models.length, 2);
  // Salvar sem mudar nada não registra.
  const before = await total();
  await save("Claude", "anthropic", models(["claude-a"], ["claude-b"]), null, claude);
  assert.equal(await total(), before);
  // Nome, chave e preço: um registro por campo.
  await save("Claude Pro", "anthropic", models(["claude-a", 2, 6], ["claude-b"]), "v1:nova", claude);
  const rows = await log({ area: "provider", subject: claude });
  assert.deepEqual(rows.slice(0, 3).map((r) => r.field).sort(), ["key", "models", "name"]);
  const name = rows.find((r) => r.field === "name");
  assert.deepEqual([name.old, name.new], ["Claude", "Claude Pro"]);
  const key = rows.find((r) => r.field === "key");
  assert.deepEqual([key.old, key.new], [{ key_hint: "wxyz" }, { key_hint: "wxyz" }]);
  const price = rows.find((r) => r.field === "models");
  assert.equal(price.old[0].input, 1);
  assert.equal(price.new[0].input, 2);
  assert.ok(!JSON.stringify(rows).includes("v1:"));
  await q(admin, "select public.ai_set_provider_active($1,$2,false)", [A, claude]);
  await q(admin, "select public.ai_set_provider_active($1,$2,false)", [A, claude]);
  const off = await log({ area: "provider", subject: claude, field: "active" });
  assert.equal(off.length, 1);
  assert.deepEqual([off[0].old, off[0].new], [true, false]);
  await q(admin, "select public.ai_set_provider_active($1,$2,true)", [A, claude]);
});

await check("regras: criada, trocada e tirada; repetir a mesma escolha não registra", async () => {
  await route(admin, "company", null, claude, "claude-a");
  const created = await last({ area: "company" });
  assert.equal(created.action, "created");
  assert.equal(created.old, null);
  assert.deepEqual(created.new, { provider_id: claude, provider: "Claude Pro", model: "claude-a" });
  const before = await total();
  await route(admin, "company", null, claude, "claude-a");
  assert.equal(await total(), before);
  await route(manager, "company", null, openai, "gpt-a");
  const changed = await last({ area: "company" });
  assert.equal(changed.action, "changed");
  assert.equal(changed.actor, manager);
  assert.equal(changed.old.model, "claude-a");
  assert.equal(changed.new.model, "gpt-a");
  await route(admin, "company", null, null, null);
  const removed = await last({ area: "company" });
  assert.equal(removed.action, "removed");
  assert.equal(removed.new, null);
  assert.equal(removed.old.provider, "OpenAI");
  // Cada tipo de regra com o nome de quem ela vale.
  await route(admin, "feature", null, openai, "gpt-a", "task_copilot");
  await route(admin, "user", member, claude, "claude-b");
  await route(admin, "client", client, openai, "gpt-b");
  await route(admin, "contract", contract, openai, "gpt-a");
  await route(admin, "project", project, claude, "claude-a");
  const feature = await last({ area: "feature", subject: "task_copilot" });
  assert.equal(feature.field, "model");
  assert.equal(feature.cause, null);
  assert.equal((await last({ area: "user", subject: member })).subject_label, "Bruno Colab");
  assert.equal((await last({ area: "client" })).subject_label, "ACME");
  assert.equal((await last({ area: "contract" })).subject_label, "Tráfego · ACME");
  assert.equal((await last({ area: "project" })).subject_label, "Lançamento");
});

await check("esforço: por funcionalidade, só quando muda", async () => {
  await effort(manager, "assistant", "high");
  await effort(manager, "assistant", "high");
  await effort(admin, "assistant", "max");
  await effort(admin, "assistant", null);
  const rows = await log({ area: "feature", subject: "assistant", field: "effort" });
  assert.deepEqual(rows.map((r) => `${r.action}:${r.old?.effort ?? "-"}>${r.new?.effort ?? "-"}`), [
    "removed:max>-",
    "changed:high>max",
    "created:->high",
  ]);
  // O ícone do modelo não traz o esforço.
  await route(admin, "feature", null, claude, "claude-a", "assistant");
  assert.deepEqual((await log({ area: "feature", subject: "assistant", field: "model" })).map((r) => r.field), ["model"]);
  assert.equal((await log({ area: "feature", subject: "assistant", field: "model,effort" })).length, 4);
});

await check("tirar um modelo do provedor leva a regra, com a causa", async () => {
  await save("OpenAI", "openai", models(["gpt-a"], ["whisper-1"]), null, openai);
  const gone = await last({ area: "client", subject: client });
  assert.equal(gone.action, "removed");
  assert.equal(gone.old.model, "gpt-b");
  assert.equal(gone.actor, admin);
  assert.equal(gone.cause.type, "model_removed");
  assert.equal(gone.cause.provider, "OpenAI");
  assert.deepEqual(gone.cause.removed, ["gpt-b"]);
  // A lista nova do provedor fica no histórico dele, sem causa.
  const list = await last({ area: "provider", subject: openai, field: "models" });
  assert.equal(list.cause, null);
});

await check("skills: modelo e esforço; apagar a skill leva os dois, com a causa", async () => {
  await db.exec("reset role");
  const skill = (
    await db.query(`insert into ai_skills(company_id,slug,author_id) values($1,'relatorio',$2) returning id`, [A, admin])
  ).rows[0].id;
  await route(admin, "skill", skill, claude, "claude-b");
  await effort(admin, `skill:${skill}`, "xhigh");
  const m = await last({ area: "skill", subject: skill, field: "model" });
  assert.equal(m.subject_label, "relatorio");
  const e = await last({ area: "skill", subject: skill, field: "effort" });
  assert.equal(e.subject_label, "relatorio");
  assert.deepEqual(e.new, { effort: "xhigh" });
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [admin]);
  await db.query(`delete from ai_skills where id = $1`, [skill]);
  const rows = await log({ area: "skill", subject: skill });
  const removed = rows.filter((r) => r.action === "removed");
  assert.equal(removed.length, 2);
  for (const r of removed) {
    assert.equal(r.cause.type, "skill_deleted");
    assert.equal(r.cause.label, "relatorio");
    assert.equal(r.subject_label, "relatorio");
  }
});

await check("animações do Mural: só o que mudou de fato, mesmo regravando tudo", async () => {
  const set = (user, knowledge, list) =>
    q(user, "select public.set_notice_animation_admin($1,$2,$3::jsonb)", [A, knowledge, JSON.stringify(list)]);
  await set(manager, true, [{ provider_id: claude, model: "claude-a" }]);
  let rows = await log({ area: "animation" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].field, "model");
  assert.equal(rows[0].action, "created");
  assert.equal(rows[0].subject, `${claude}|claude-a`);
  assert.equal(rows[0].subject_label, "Claude Pro · claude-a");
  assert.deepEqual(rows[0].new.user_ids, []);
  // Salvar igual: nada.
  const before = await total();
  await set(manager, true, [{ provider_id: claude, model: "claude-a" }]);
  assert.equal(await total(), before);
  // Pessoas e equipes de um modelo, outro liberado, a consulta à base.
  await set(admin, false, [
    { provider_id: claude, model: "claude-a", user_ids: [manager], team_ids: [team] },
    { provider_id: openai, model: "gpt-a" },
  ]);
  rows = await log({ area: "animation" });
  assert.deepEqual(rows.slice(0, 3).map((r) => `${r.field}:${r.action}`).sort(), [
    "access:changed",
    "knowledge:changed",
    "model:created",
  ]);
  const access = rows.find((r) => r.field === "access");
  assert.deepEqual(access.old.user_ids, []);
  assert.deepEqual(access.new.user_ids, [manager]);
  assert.deepEqual(access.new.team_ids, [team]);
  const knowledge = rows.find((r) => r.field === "knowledge");
  assert.deepEqual([knowledge.old, knowledge.new], [true, false]);
  await set(admin, false, [{ provider_id: claude, model: "claude-a", user_ids: [manager], team_ids: [team] }]);
  const out = await last({ area: "animation", subject: `${openai}|gpt-a` });
  assert.equal(out.action, "removed");
  assert.equal(out.cause, null);
});

await check("excluir o provedor: a exclusão é direta; regras e animações saem com a causa", async () => {
  await q(admin, "select public.ai_delete_provider($1,$2)", [A, claude]);
  const removed = await last({ area: "provider", subject: claude });
  assert.equal(removed.field, "provider");
  assert.equal(removed.action, "removed");
  assert.equal(removed.cause, null);
  assert.equal(removed.old.name, "Claude Pro");
  // A regra do projeto e a da pessoa usavam o Claude.
  for (const area of ["project", "user"]) {
    const r = await last({ area });
    assert.equal(r.action, "removed");
    assert.equal(r.cause.type, "provider_deleted");
    assert.equal(r.cause.label, "Claude Pro");
    // O nome do provedor apagado continua legível.
    assert.equal(r.old.provider, "Claude Pro");
    assert.equal(r.actor, admin);
  }
  const anim = await last({ area: "animation", subject: `${claude}|claude-a` });
  assert.equal(anim.action, "removed");
  assert.equal(anim.cause.type, "provider_deleted");
  assert.deepEqual(anim.old.user_ids, [manager]);
  assert.ok(!JSON.stringify(await log({ limit: 100 })).includes("v1:"));
});

await check("ninguém altera nem apaga o histórico", async () => {
  await assert.rejects(() => q(admin, "update mavi_private.ai_settings_log set actor = null"), /permission denied/);
  await assert.rejects(() => q(admin, "delete from mavi_private.ai_settings_log"), /permission denied/);
  await db.exec("reset role");
  await assert.rejects(() => db.query("update mavi_private.ai_settings_log set actor = null"), /não pode ser alterado/);
  await assert.rejects(() => db.query("delete from mavi_private.ai_settings_log"), /não pode ser alterado/);
  await assert.rejects(() => db.query("truncate mavi_private.ai_settings_log"), /não pode ser alterado/);
});

await check("só administradores e gestores leem, da própria empresa", async () => {
  assert.ok((await log({}, manager)).length > 0);
  await assert.rejects(() => log({}, member), /administradores e gestores/);
  await assert.rejects(() => log({}, outsider), /administradores e gestores/);
  await assert.rejects(() => log({}, null), /permission denied|administradores e gestores/);
});

await check("filtros no banco: quem alterou, período e carregar mais", async () => {
  const mine = await log({ actor: manager, limit: 100 });
  assert.ok(mine.length >= 3);
  assert.ok(mine.every((r) => r.actor === manager));
  const today = (await one(admin, "select (now() at time zone 'America/Sao_Paulo')::date::text")).slice(0, 10);
  assert.ok((await log({ from: today, to: today })).length > 0);
  assert.equal((await log({ to: "2020-01-01" })).length, 0);
  const all = await log({ limit: 100 });
  const page1 = await log({ limit: 5 });
  const page2 = await log({ limit: 5, before: page1[4].id });
  assert.deepEqual([...page1, ...page2].map((r) => r.id), all.slice(0, 10).map((r) => r.id));
  assert.ok(all.every((r, i) => i === 0 || all[i - 1].id > r.id));
});

console.log(`\n${passed} verificações passaram.`);

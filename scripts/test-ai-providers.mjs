// IA do MAVI · biblioteca de provedores (migration 20261025090000_ai_providers):
// só administradores cadastram provedores e regras, a chave nunca aparece
// para o navegador, a regra mais específica vale (projeto › produto ›
// cliente › pessoa › empresa), provedores desligados não respondem, o
// consumo guarda o provedor e o assistente vira um módulo que se esconde.
// Com a 20261031090000_ai_feature_routes, cada funcionalidade tem a sua regra.
import assert from "node:assert/strict";
import { applyMigration, createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, manager, member, outsider] = [1, 2, 10, 11, 12, 13].map(uid);
const [client, other, product, contract, project, team] = [20, 21, 22, 23, 24, 25].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, manager, member, outsider]]);
await db.query(`insert into companies(id,name) values($1,'Make'),($2,'Beta')`, [A, B]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$3,'Ana Admin','admin',true),($1,$4,'Gabi Gestora','manager',true),
   ($1,$5,'Bruno Colab','member',true),($2,$6,'Otto','admin',true)`,
  [A, B, admin, manager, member, outsider],
);
await db.query(`insert into clients(id,company_id,name) values($2,$1,'ACME'),($3,$1,'Outro')`, [
  A,
  client,
  other,
]);
for (const [sql, args] of [
  [`insert into products(id,company_id,name) values($2,$1,'Tráfego')`, [A, product]],
  [`insert into contracts(id,company_id,client_id,product_id,name) values($2,$1,$3,$4,'Tráfego')`, [A, contract, client, product]],
  [`insert into projects(id,company_id,contract_id,name) values($2,$1,$3,'Lançamento')`, [A, project, contract]],
  [`insert into teams(id,company_id,name) values($2,$1,'Time')`, [A, team]],
  [`insert into team_members(company_id,team_id,user_id) values($1,$2,$3)`, [A, team, member]],
  [`insert into client_teams(company_id,client_id,team_id) values($1,$2,$3)`, [A, client, team]],
])
  await db.query(sql, args);

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
const models = (...ids) => JSON.stringify(ids.map((id) => ({ id, input: 1, output: 5 })));
const save = (user, name, kind, list, cipher = "v1:abc", id = null, base = null) =>
  one(user, "select public.ai_save_provider($1,$2,$3,$4,$5,$6::jsonb,$7,'wxyz',true)", [
    A, id, name, kind, base, list, cipher,
  ]);
const route = (user, type, id, provider, model) =>
  q(user, "select public.ai_set_route($1,$2,$3,$4,$5)", [A, type, id, provider, model]);
const resolve = async (user, c = null, k = null, p = null) => {
  const r = await one(user, "select public.ai_resolve_route($1,$2,$3,$4)", [A, c, k, p]);
  return r ? `${r.scope}:${r.provider}:${r.model}` : null;
};
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

let claude, openai;
await check("só administradores cadastram provedores; a lista não traz a chave", async () => {
  await assert.rejects(() => save(manager, "Claude", "anthropic", models("claude-sonnet-5")), /Só administradores/);
  await assert.rejects(() => save(admin, "X", "anthropic", models("m"), null), /Informe a API Key/);
  await assert.rejects(() => save(admin, "X", "anthropic", models("m"), "texto-puro"), /Chave inválida/);
  await assert.rejects(() => save(admin, "X", "custom", models("m")), /endereço da API/);
  await assert.rejects(() => save(admin, "X", "openai", "[]"), /ao menos um modelo/);
  await assert.rejects(
    () => save(admin, "X", "openai", JSON.stringify([{ id: "gpt", input: 1 }])),
    /Informe os preços/,
  );
  claude = await save(admin, "Claude", "anthropic", models("claude-sonnet-5", "claude-haiku-4-5"));
  openai = await save(admin, "OpenAI", "openai", models("gpt-a", "gpt-b"));
  await assert.rejects(() => save(admin, "Claude", "anthropic", models("x")), /Já existe um provedor/);
  const list = await one(admin, "select public.ai_provider_list($1)", [A]);
  assert.deepEqual(list.providers.map((p) => `${p.name}:${p.key_hint}:${p.models.length}`), [
    "Claude:wxyz:2",
    "OpenAI:wxyz:2",
  ]);
  assert.ok(!JSON.stringify(list).includes("v1:"));
  // Gestores leem a lista (para escolher nas regras), sem a chave; não cadastram.
  const seen = await one(manager, "select public.ai_provider_list($1)", [A]);
  assert.equal(seen.providers.length, 2);
  assert.ok(!JSON.stringify(seen).includes("v1:"));
  await assert.rejects(() => save(manager, "Outro", "openai", models("gpt-c")), /Só administradores/);
  await assert.rejects(() => q(manager, "select * from public.ai_provider_secret($1,$2)", [A, claude]), /Só administradores/);
  await assert.rejects(() => q(member, "select public.ai_provider_list($1)", [A]), /administradores e gestores/);
  await assert.rejects(() => q(member, "select * from mavi_private.ai_providers"), /permission denied/);
  // Outra empresa não enxerga nem mexe.
  await assert.rejects(() => q(outsider, "select public.ai_provider_list($1)", [A]), /administradores e gestores/);
});

await check("a regra mais específica vale: projeto › produto › cliente › pessoa › empresa", async () => {
  assert.equal(await resolve(member, client), null);
  await assert.rejects(() => route(member, "company", null, claude, "claude-sonnet-5"), /administradores e gestores/);
  await assert.rejects(() => route(admin, "company", null, claude, "gpt-a"), /modelo cadastrado/);
  await assert.rejects(() => route(admin, "client", null, claude, "claude-sonnet-5"), /para quem vale/);
  await assert.rejects(() => route(admin, "client", uid(99), claude, "claude-sonnet-5"), /Não encontrado/);
  await route(admin, "company", null, claude, "claude-sonnet-5");
  assert.equal(await resolve(member), "company:Claude:claude-sonnet-5");
  await route(admin, "user", member, claude, "claude-haiku-4-5");
  assert.equal(await resolve(member), "user:Claude:claude-haiku-4-5");
  assert.equal(await resolve(manager), "company:Claude:claude-sonnet-5");
  await route(admin, "client", client, openai, "gpt-a");
  assert.equal(await resolve(member, client), "client:OpenAI:gpt-a");
  await route(admin, "contract", contract, openai, "gpt-b");
  assert.equal(await resolve(member, client, contract), "contract:OpenAI:gpt-b");
  await route(admin, "project", project, claude, "claude-sonnet-5");
  assert.equal(await resolve(member, client, contract, project), "project:Claude:claude-sonnet-5");
  // Só o projeto: o produto e o cliente vêm dele.
  await route(admin, "project", project, null, null);
  assert.equal(await resolve(member, null, null, project), "contract:OpenAI:gpt-b");
  // Trocar a regra da empresa substitui a anterior.
  await route(admin, "company", null, openai, "gpt-a");
  assert.equal(await resolve(manager), "company:OpenAI:gpt-a");
  const list = await one(admin, "select public.ai_provider_list($1)", [A]);
  assert.equal(list.routes.length, 4);
});

await check("sem acesso ao cliente, as regras dele não valem; a chave vem selada", async () => {
  await route(admin, "client", other, claude, "claude-haiku-4-5");
  // Bruno não atende "Outro": fica na regra dele.
  assert.equal(await resolve(member, other), "user:Claude:claude-haiku-4-5");
  assert.equal(await resolve(manager, other), "client:Claude:claude-haiku-4-5");
  const r = await one(member, "select public.ai_resolve_route($1,$2,null,null)", [A, client]);
  assert.equal(r.key_cipher, "v1:abc");
  assert.deepEqual(r.price, { id: "gpt-a", input: 1, output: 5 });
  await assert.rejects(() => q(outsider, "select public.ai_resolve_route($1,null,null,null)", [A]), /Sem acesso/);
});

await check("provedor desligado não responde; modelos removidos levam as regras", async () => {
  await q(admin, "select public.ai_set_provider_active($1,$2,false)", [A, openai]);
  assert.equal(await resolve(member, client, contract), "user:Claude:claude-haiku-4-5");
  await q(admin, "select public.ai_set_provider_active($1,$2,true)", [A, openai]);
  assert.equal(await resolve(member, client, contract), "contract:OpenAI:gpt-b");
  // Sai o gpt-b da lista (e a chave continua a mesma).
  await save(admin, "OpenAI", "openai", models("gpt-a"), null, openai);
  assert.equal(await resolve(member, client, contract), "client:OpenAI:gpt-a");
  const [row] = await q(admin, "select * from public.ai_provider_secret($1,$2)", [A, openai]);
  assert.equal(row.key_cipher, "v1:abc");
  await q(admin, "select public.ai_delete_provider($1,$2)", [A, openai]);
  assert.equal(await resolve(member, client, contract), "user:Claude:claude-haiku-4-5");
  assert.equal(await resolve(manager), null);
});

await check("o consumo guarda o provedor e o painel divide por modelo", async () => {
  await q(member, "select public.ai_log_usage($1,'assistant','ask',null,null,null,null,'claude-haiku-4-5',10,5,0,0,0,0.01,$2)", [A, claude]);
  await q(member, "select public.ai_log_usage($1,'assistant','ask',null,null,null,null,'claude-opus-5',10,5,0,0,0,0.02)", [A]);
  await assert.rejects(
    () => q(member, "select public.ai_log_usage($1,'assistant','ask',null,null,null,null,'m',1,1,0,0,0,0.01,$2)", [A, uid(98)]),
    /Provedor inválido/,
  );
  const report = await one(manager, "select public.ai_usage_report($1,current_date - 1,current_date + 1)", [A]);
  assert.deepEqual(
    report.by_model.map((m) => `${m.provider || "servidor"}:${m.model}:${m.asks}`).sort(),
    ["Claude:claude-haiku-4-5:1", "servidor:claude-opus-5:1"],
  );
});

await check("cada funcionalidade tem o seu modelo; pessoa e cliente só valem nas conversas", async () => {
  const gpt = await save(admin, "GPT", "openai", models("gpt-c"));
  const feat = async (user, feature, c = null) => {
    const r = await one(user, "select public.ai_resolve_route($1,$2,null,null,$3)", [A, c, feature]);
    return r ? `${r.scope}:${r.provider}:${r.model}` : null;
  };
  const setFeature = (user, feature, provider, model) =>
    q(user, "select public.ai_set_route($1,'feature',null,$2,$3,$4)", [A, provider, model, feature]);
  await assert.rejects(() => setFeature(member, "social_leads_plan", gpt, "gpt-c"), /administradores e gestores/);
  await assert.rejects(() => setFeature(admin, "inventada", gpt, "gpt-c"), /Funcionalidade inválida/);
  await assert.rejects(() => setFeature(admin, null, gpt, "gpt-c"), /Funcionalidade inválida/);
  await assert.rejects(() => setFeature(admin, "social_leads_plan", gpt, "claude-sonnet-5"), /modelo cadastrado/);
  // Sem regra da funcionalidade nem da empresa: o servidor.
  assert.equal(await feat(manager, "social_leads_plan"), null);
  await setFeature(admin, "social_leads_plan", gpt, "gpt-c");
  await setFeature(admin, "assistant", claude, "claude-sonnet-5");
  // A regra de Bruno (pessoa) não vale fora das conversas.
  assert.equal(await feat(member, "social_leads_plan"), "feature:GPT:gpt-c");
  assert.equal(await feat(member, "assistant"), "user:Claude:claude-haiku-4-5");
  assert.equal(await feat(manager, "assistant"), "feature:Claude:claude-sonnet-5");
  // Sem funcionalidade, é o assistente (a chamada de antes, com 4 argumentos).
  assert.equal(await resolve(manager), "feature:Claude:claude-sonnet-5");
  // O cliente vale na pergunta a uma reunião, não no Social Leads.
  assert.equal(await feat(manager, "meetings_ask", other), "client:Claude:claude-haiku-4-5");
  assert.equal(await feat(manager, "social_leads_plan", other), "feature:GPT:gpt-c");
  // Sem regra da funcionalidade, vale a da empresa.
  await route(admin, "company", null, claude, "claude-haiku-4-5");
  assert.equal(await feat(manager, "whatsapp_task"), "company:Claude:claude-haiku-4-5");
  // Trocar substitui; tirar volta para a da empresa.
  await setFeature(admin, "social_leads_plan", claude, "claude-sonnet-5");
  assert.equal(await feat(manager, "social_leads_plan"), "feature:Claude:claude-sonnet-5");
  await setFeature(admin, "social_leads_plan", null, null);
  assert.equal(await feat(manager, "social_leads_plan"), "company:Claude:claude-haiku-4-5");
  const list = await one(admin, "select public.ai_provider_list($1)", [A]);
  assert.deepEqual(
    list.routes.filter((r) => r.type === "feature").map((r) => `${r.feature}:${r.model}`),
    ["assistant:claude-sonnet-5"],
  );
  assert.ok(list.routes.filter((r) => r.type !== "feature").every((r) => r.feature === null));
  // Provedor desligado é pulado.
  await setFeature(admin, "whatsapp_task", gpt, "gpt-c");
  assert.equal(await feat(manager, "whatsapp_task"), "feature:GPT:gpt-c");
  await q(admin, "select public.ai_set_provider_active($1,$2,false)", [A, gpt]);
  assert.equal(await feat(manager, "whatsapp_task"), "company:Claude:claude-haiku-4-5");
});

await check("o assistente entra nos módulos que o administrador esconde", async () => {
  await q(admin, "select public.set_member_pages($1,$2,array['assistant'])", [A, member]);
  await db.exec("reset role");
  const [row] = (await db.query("select hidden_pages from memberships where company_id=$1 and user_id=$2", [A, member])).rows;
  assert.deepEqual(row.hidden_pages, ["assistant"]);
});


await check("gestores editam as regras; transcrição só com modelo e provedor de transcrição", async () => {
  const groq = await save(admin, "Groq", "groq", models("whisper-large-v3-turbo", "llama-4"));
  const setFeature = (user, feature, provider, model) =>
    q(user, "select public.ai_set_route($1,'feature',null,$2,$3,$4)", [A, provider, model, feature]);
  const resolveFeature = async (user, feature) => {
    const r = await one(user, "select public.ai_resolve_route($1,null,null,null,$2)", [A, feature]);
    return r ? `${r.scope}:${r.provider}:${r.model}` : null;
  };
  // O padrão da empresa (conversa) não vale para a transcrição.
  await route(manager, "company", null, claude, "claude-sonnet-5");
  assert.equal(await resolveFeature(member, "task_audio_transcribe"), null);
  assert.equal(await resolveFeature(member, "whatsapp_task"), "company:Claude:claude-sonnet-5");
  await assert.rejects(() => setFeature(manager, "task_audio_transcribe", claude, "claude-sonnet-5"), /transcrição usa/);
  await assert.rejects(() => setFeature(manager, "task_audio_transcribe", groq, "llama-4"), /modelo de transcrição/);
  await assert.rejects(() => setFeature(manager, "whatsapp_task", groq, "whisper-large-v3-turbo"), /só transcreve/);
  await assert.rejects(() => route(manager, "company", null, groq, "whisper-large-v3-turbo"), /só transcreve/);
  await setFeature(manager, "task_audio_transcribe", groq, "whisper-large-v3-turbo");
  assert.equal(await resolveFeature(member, "task_audio_transcribe"), "feature:Groq:whisper-large-v3-turbo");
  // Whatsapp: a coleta (segredo do worker) acha a regra dela.
  const secret = "s".repeat(40);
  await db.exec("reset role");
  await db.query("insert into mavi_private.whatsapp_config(company_id,url,secret) values($1,'https://uaz.example',$2)", [A, secret]);
  assert.equal(await one(null, "select public.whatsapp_transcribe_route($1)", [secret]), null);
  await setFeature(manager, "whatsapp_transcribe", groq, "whisper-large-v3-turbo");
  const wr = await one(null, "select public.whatsapp_transcribe_route($1)", [secret]);
  assert.equal(wr.model, "whisper-large-v3-turbo");
  assert.equal(wr.kind, "groq");
  await assert.rejects(() => q(null, "select public.whatsapp_transcribe_route($1)", ["x".repeat(40)]), /Não autorizado/);
  // Os modelos das animações do Mural também são dos gestores.
  await q(manager, "select public.set_notice_animation_admin($1,true,'[]'::jsonb)", [A]);
  assert.equal((await one(manager, "select public.notice_animation_admin($1)", [A])).knowledge, true);
  await assert.rejects(() => q(member, "select public.notice_animation_admin($1)", [A]), /Sem permissão/);
  await setFeature(manager, "task_audio_transcribe", null, null);
  await setFeature(manager, "whatsapp_transcribe", null, null);
  await route(manager, "company", null, null, null);
});

await db.close();

await check("reaplicar depois da ai_mcp (a ordem da produção) conserta o que ela sobrescreveu", async () => {
  const prod = await createTestDatabase({ until: "20261024" });
  await applyMigration(prod, "20261025090000");
  await applyMigration(prod, "20261024090000");
  const overloads = async () =>
    (await prod.query("select count(*)::int n from pg_proc where proname = 'ai_log_usage'")).rows[0].n;
  const assistantAllowed = async () =>
    (await prod.query(
      "select pg_get_constraintdef(oid) d from pg_constraint where conname = 'memberships_hidden_pages_check'",
    )).rows[0].d.includes("assistant");
  // O estado quebrado: duas ai_log_usage (a chamada com 14 argumentos fica
  // ambígua) e 'assistant' fora dos módulos.
  assert.equal(await overloads(), 2);
  assert.equal(await assistantAllowed(), false);
  await applyMigration(prod, "20261025090000");
  assert.equal(await overloads(), 1);
  assert.equal(await assistantAllowed(), true);
  const c = uid(1);
  const u = uid(10);
  await prod.query("insert into auth.users(id) values($1)", [u]);
  await prod.query("insert into companies(id,name) values($1,'Make')", [c]);
  await prod.query("insert into memberships(company_id,user_id,name,role,active) values($1,$2,'Ana','admin',true)", [c, u]);
  await prod.query(`select set_config('request.jwt.claim.sub',$1,false)`, [u]);
  await prod.exec("set role authenticated");
  // A chamada de sempre (sem p_provider) volta a funcionar, e a do MCP também.
  await prod.query("select public.ai_log_usage($1,'assistant','ask',null,null,null,null,'m',1,1,0,0,0,0.01)", [c]);
  await prod.query("select public.ai_log_usage($1,'mcp','search',null,null,null,null,'m',0,0,0,0,10,0.001)", [c]);
  await prod.query("select public.set_member_pages($1,$2,array['assistant'])", [c, u]);
  await prod.exec("reset role");
  assert.equal((await prod.query("select count(*)::int n from ai_usage")).rows[0].n, 2);
  await prod.close();
});

console.log(`\n${passed} verificações dos provedores de IA aprovadas.`);

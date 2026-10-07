// MAVI · roteador de modelos, fase 2 (migration 20270529090000_ai_router_policy):
// a configuração (só líderes; provedores da empresa; telas e níveis
// válidos), as exceções por pessoa/cliente/produto (sigiloso só em cliente e
// produto; tudo vazio tira a exceção), a política a cada pergunta (o nível
// pela ordem produto › cliente › pessoa › tela › empresa; os provedores pela
// interseção das listas; sigiloso só com os liberados; o Servidor), o
// "Automático" das regras, o registro "auto" só com o roteador ativo, as
// últimas decisões e o histórico de alterações.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SERVER = "00000000-0000-0000-0000-000000000000";
const [A, B, admin, ana, bia, manager] = [1, 2, 10, 11, 12, 14].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, ana, bia, manager]]);
await db.query(`insert into companies(id,name) values($1,'Make'),($2,'Outra')`, [A, B]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Ana Equipe','member',true),($1,$4,'Bia Equipe','member',true),
   ($1,$5,'Gabi Gestora','manager',true)`,
  [A, admin, ana, bia, manager],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user ?? ""]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
async function rpc(name, args) {
  return (
    await db.query(`select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})) as result`, args)
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

await as(admin);
const team = await rpc("create_team", [A, "Equipe A", [ana]]);
const client = await rpc("create_client", [A, "5022", "", [team]]);
const other = await rpc("create_client", [A, "7000", "", [team]]);
const [product] = await sql(`insert into products(company_id,name) values($1,'Make Ads') returning id`, [A]);
const [contract] = await sql(
  `insert into contracts(company_id,client_id,product_id,name) values($1,$2,$3,'Make Ads 5022') returning id`,
  [A, client, product.id],
);
const provider = async (name, kind, company = A, active = true) =>
  (
    await sql(
      `insert into mavi_private.ai_providers(company_id,name,kind,key_cipher,models,active)
       values ($1,$2,$3,'v1:k','[{"id":"m-${kind}","input":1,"output":5}]',$4) returning id`,
      [company, name, kind, active],
    )
  )[0].id;
const pClaude = await provider("Claude", "anthropic");
const pOpenai = await provider("OpenAI", "openai");
const pGroq = await provider("Groq", "groq");
const pOff = await provider("Desligado", "mistral", A, false);
const pOther = await provider("Deles", "openai", B);
const ctx = async (user, c = null, k = null, surface = "page") => {
  await as(user);
  return rpc("ai_route_context", [A, c, k, null, surface]);
};
const names = (x) => x.candidates.map((p) => p.name).sort();

await check("sem configuração: sombra, Equilibrado, escalonamento ligado, todos os provedores ativos", async () => {
  const x = await ctx(ana);
  assert.deepEqual([x.mode, x.level, x.escalate, Number(x.escalate_cap), x.sigiloso, x.restricted, x.server],
    ["shadow", "equilibrado", true, 0.5, false, false, true]);
  assert.deepEqual(names(x), ["Claude", "Groq", "OpenAI"]);
  assert.ok(x.candidates.every((p) => p.key_cipher === "v1:k"));
});

await check("configuração: só líderes; provedores da empresa; telas e níveis válidos; lista vazia recusa", async () => {
  await as(ana);
  await rejects(() => rpc("ai_router_get", [A]), /Só administradores e gestores/);
  await as(ana);
  await rejects(() => rpc("ai_router_save", [A, JSON.stringify({ mode: "active" })]), /Só administradores e gestores/);
  await as(admin);
  await rejects(() => rpc("ai_router_save", [A, JSON.stringify({ providers: [pOther] })]), /Provedor inválido/);
  await as(admin);
  await rejects(() => rpc("ai_router_save", [A, JSON.stringify({ providers: [] })]), /pelo menos um/);
  await as(admin);
  await rejects(() => rpc("ai_router_save", [A, JSON.stringify({ surface_levels: { inventada: "maxima" } })]), /tela inventada/);
  await as(admin);
  await rejects(() => rpc("ai_router_save", [A, JSON.stringify({ surface_levels: { bubble: "turbo" } })]), /Nível inválido/);
  await as(admin);
  await rejects(() => rpc("ai_router_save", [A, JSON.stringify({ level: "turbo" })]), /check/);
  // Gestora configura; os campos que não vieram ficam.
  await as(manager);
  await rpc("ai_router_save", [A, JSON.stringify({ level: "economico", surface_levels: { copilot: "maxima" } })]);
  await as(manager);
  await rpc("ai_router_save", [A, JSON.stringify({ escalate_cap: 1.25 })]);
  await as(admin);
  const g = await rpc("ai_router_get", [A]);
  assert.deepEqual([g.mode, g.level, g.surface_levels, Number(g.escalate_cap), g.providers],
    ["shadow", "economico", { copilot: "maxima" }, 1.25, null]);
});

await check("nível: produto › cliente › pessoa › tela › empresa", async () => {
  assert.equal((await ctx(ana)).level, "economico");
  assert.equal((await ctx(ana, null, null, "copilot")).level, "maxima");
  await as(admin);
  await rpc("ai_router_scope_save", [A, "user", ana, "equilibrado", null, false]);
  assert.equal((await ctx(ana, null, null, "copilot")).level, "equilibrado");
  assert.equal((await ctx(bia, null, null, "copilot")).level, "maxima");
  await as(admin);
  await rpc("ai_router_scope_save", [A, "client", client, "maxima", null, false]);
  assert.equal((await ctx(ana, client)).level, "maxima");
  await as(admin);
  await rpc("ai_router_scope_save", [A, "contract", contract.id, "economico", null, false]);
  assert.equal((await ctx(ana, null, contract.id)).level, "economico");
  // Cliente que a pessoa não acessa não conta.
  assert.equal((await ctx(bia, client)).level, "economico");
});

await check("provedores: interseção das listas; Servidor pelo id próprio; desligado nunca", async () => {
  await as(admin);
  await rpc("ai_router_save", [A, JSON.stringify({ providers: [pClaude, pOpenai, pOff, SERVER] })]);
  let x = await ctx(bia);
  assert.deepEqual(names(x), ["Claude", "OpenAI"]);
  assert.deepEqual([x.restricted, x.server], [true, true]);
  await as(admin);
  await rpc("ai_router_scope_save", [A, "user", bia, null, [pOpenai, pGroq], false]);
  x = await ctx(bia);
  assert.deepEqual(names(x), ["OpenAI"]);
  assert.equal(x.server, false);
  await as(admin);
  await rejects(() => rpc("ai_router_scope_save", [A, "user", bia, null, [], false]), /pelo menos um/);
  await as(admin);
  await rejects(() => rpc("ai_router_scope_save", [A, "user", bia, null, [pOther], false]), /Provedor inválido/);
});

await check("sigiloso: só em cliente e produto; só os provedores liberados para dados sigilosos", async () => {
  await as(admin);
  await rejects(() => rpc("ai_router_scope_save", [A, "user", ana, null, null, true]), /Sigiloso vale para clientes/);
  await as(admin);
  await rpc("ai_router_scope_save", [A, "client", other, null, null, true]);
  // Sem lista de liberados: os permitidos da empresa.
  assert.deepEqual(names(await ctx(ana, other)), ["Claude", "OpenAI"]);
  await as(admin);
  await rpc("ai_router_save", [A, JSON.stringify({ secret_providers: [pClaude] })]);
  const x = await ctx(ana, other);
  assert.deepEqual([x.sigiloso, names(x), x.server], [true, ["Claude"], false]);
  assert.deepEqual(names(await ctx(ana, client)), ["Claude", "OpenAI"]);
  // Tudo vazio tira a exceção.
  await as(admin);
  await rpc("ai_router_scope_save", [A, "client", other, null, null, false]);
  assert.equal((await sql(`select count(*)::int as n from mavi_private.ai_router_scopes where scope_id = $1`, [other]))[0].n, 0);
});

await check("Automático nas regras: só líderes, só regras existentes; resolve_route e a lista trazem", async () => {
  await as(admin);
  await rpc("ai_set_route", [A, "feature", null, pClaude, "m-anthropic", "mavi_page"]);
  await as(ana);
  await rejects(() => rpc("ai_set_route_auto", [A, "feature", null, "mavi_page", true]), /Só administradores e gestores/);
  await as(admin);
  await rejects(() => rpc("ai_set_route_auto", [A, "client", client, null, true]), /Escolha o provedor/);
  await as(admin);
  await rejects(() => rpc("ai_set_route_auto", [A, "company", null, null, true]), /O automático vale/);
  await as(admin);
  await rpc("ai_set_route_auto", [A, "feature", null, "mavi_page", true]);
  await as(ana);
  const r = await rpc("ai_resolve_route", [A, null, null, null, "mavi_page"]);
  assert.deepEqual([r.scope, r.auto, r.model], ["feature", true, "m-anthropic"]);
  await as(admin);
  const lib = await rpc("ai_provider_list", [A]);
  assert.equal(lib.routes.find((x) => x.feature === "mavi_page").auto, true);
});

const entry = (over = {}) =>
  JSON.stringify({
    surface: "page", feature: "mavi_page", task_type: "consulta", complexity: 1, mode: "auto",
    suggested_model: "m-openai", used_model: "m-openai", total_ms: 1200, cost_usd: 0.001, ...over,
  });
await check("registro: auto só com o roteador ativo; escalonamento marcado; últimas decisões só para líderes", async () => {
  await as(ana);
  const a = await rpc("ai_route_log", [A, entry()]);
  await as(admin);
  await rpc("ai_router_save", [A, JSON.stringify({ mode: "active" })]);
  await as(ana);
  const b = await rpc("ai_route_log", [A, entry({ escalated: true, reason: "Escalou para m-anthropic" })]);
  const rows = await sql(`select id, mode, escalated from ai_route_decisions order by id`);
  assert.deepEqual(rows.map((r) => [Number(r.id), r.mode, r.escalated]), [[Number(a), "shadow", false], [Number(b), "auto", true]]);
  await as(ana);
  await rejects(() => rpc("ai_route_recent", [A, 10]), /Só administradores e gestores/);
  await as(manager);
  const recent = await rpc("ai_route_recent", [A, 10]);
  assert.deepEqual(recent.map((r) => [r.mode, r.escalated, r.reason]), [["auto", true, "Escalou para m-anthropic"], ["shadow", false, ""]]);
});

await check("histórico de alterações: configuração, exceções e Automático", async () => {
  await as(admin);
  const log = (await rpc("ai_settings_log", [A, null, null, null, null, null, null, null, 100])).items;
  const has = (area, field, action) => log.some((l) => l.area === area && l.field === field && l.action === action);
  assert.ok(has("router", "level", "changed"), "nível mudou");
  assert.ok(has("router", "mode", "changed"), "modo mudou");
  assert.ok(has("router", "providers", "changed"), "provedores");
  assert.ok(has("router", "secret_providers", "changed"), "liberados para sigilosos");
  assert.ok(has("user", "level", "created"), "nível da pessoa");
  assert.ok(has("client", "sigiloso", "removed"), "sigiloso tirado");
  assert.ok(has("feature", "auto", "changed"), "automático");
  const mode = log.find((l) => l.area === "router" && l.field === "mode");
  assert.deepEqual([mode.old, mode.new, mode.actor], [{ mode: "shadow" }, { mode: "active" }, admin]);
  // O padrão que nasceu com a linha (escalonamento ligado) não vira alteração.
  assert.ok(!has("router", "escalate", "created"));
});

console.log(`\n${passed} verificações da política do roteador passaram.`);

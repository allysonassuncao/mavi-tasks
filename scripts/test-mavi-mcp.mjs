// MAVI · Conexões (MCP) (migrations 20261218090000_mavi_mcp e 20261219090000_mavi_mcp_auto): o poder 'mcp';
// conexões da empresa (líderes criam e dizem quem usa) e pessoais; as
// ferramentas guardadas com o liga/desliga; de quem é cada token; o OAuth
// pelo estado; e a ação confirmada que não roda duas vezes.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, manager, ana, bia, outsider] = [1, 2, 10, 11, 12, 13, 20].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, manager, ana, bia, outsider]]);
await db.query(`insert into companies(id,name) values($1,'Make'),($2,'Outra')`, [A, B]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values ($1,$2,'Ana Admin','admin',true),($1,$3,'Gil Gestor','manager',true),($1,$4,'Ana Souza','member',true),($1,$5,'Bia Lima','member',true),($6,$7,'Fora','admin',true)`,
  [A, admin, manager, ana, bia, B, outsider],
);
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
const save = (user, args) =>
  one(user, "select public.ai_mcp_save($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", [
    A,
    args.id ?? null,
    args.personal ?? false,
    args.name,
    args.url,
    args.instructions ?? "",
    args.auth ?? "none",
    args.per_person ?? false,
    args.header_name ?? null,
    args.header_cipher ?? null,
    args.header_hint ?? null,
    args.enabled ?? true,
  ]);
const list = (user) => one(user, "select public.ai_mcp_list($1)", [A]);
const catalog = (user) => one(user, "select public.ai_mcp_catalog($1)", [A]);
const power = (on, extra = "") =>
  q(admin, `select public.ai_set_power($1,'mcp',$2,${extra || "true,'{}','{}','{}'"})`, [A, on]);

let notion, crm, mine;
await check("o poder 'mcp': vem desligado; líderes criam as da empresa, cada um as suas com o poder", async () => {
  assert.deepEqual(await one(ana, "select public.ai_my_powers($1)", [A]), []);
  const admin_ = await one(admin, "select public.ai_powers_admin($1)", [A]);
  assert.equal(admin_.at(-1).power, "mcp");
  await assert.rejects(() => save(ana, { name: "Notion", url: "https://mcp.notion.com/mcp" }), /Só administradores e gestores criam/);
  await assert.rejects(
    () => save(ana, { personal: true, name: "Meu", url: "https://x.example.com/mcp" }),
    /não estão liberadas para você/,
  );
  await assert.rejects(() => save(manager, { name: "Ruim", url: "http://inseguro.com/mcp" }), /https:\/\//);
  notion = await save(manager, { name: "Notion Ágil", url: "https://mcp.notion.com/mcp", auth: "oauth", per_person: true, instructions: "Documentos do time." });
  crm = await save(admin, { name: "CRM", url: "https://crm.example.com/mcp", auth: "header", header_name: "Authorization", header_cipher: "v1:selado", header_hint: "…abcd" });
  await assert.rejects(
    () => save(admin, { name: "Sem chave", url: "https://y.example.com/mcp", auth: "header", header_name: "X-Key" }),
    /nome do cabeçalho e a chave/,
  );
  await power(true);
  mine = await save(ana, { personal: true, name: "Notion", url: "https://outro.example.com/mcp" });
  const slugs = (await list(admin)).map((s) => s.slug).sort();
  assert.deepEqual(slugs, ["crm", "notionagil"]);
  const anaSees = await list(ana);
  assert.deepEqual(anaSees.map((s) => [s.name, s.personal, s.editable]), [
    ["CRM", false, false],
    ["Notion Ágil", false, false],
    ["Notion", true, true],
  ]);
  assert.equal(anaSees.find((s) => s.name === "Notion").slug, "notion");
  // Nada selado sai na lista.
  assert.ok(!JSON.stringify(anaSees).includes("v1:selado"));
  assert.equal(anaSees[0].has_header, true);
  assert.deepEqual(await one(bia, "select public.ai_mcp_list($1)", [A]).then((l) => l.map((s) => s.name)), ["CRM", "Notion Ágil"]);
  assert.deepEqual(await one(outsider, "select public.ai_mcp_list($1)", [A]), []);
});

await check("ferramentas: guardadas, o liga/desliga fica; o catálogo só com as prontas e ligadas", async () => {
  const tools = [
    { name: "search", title: "Buscar", description: "Busca no CRM", read_only: true, input_schema: { type: "object", properties: { q: { type: "string" } } } },
    { name: "create_deal", description: "Cria negócio", read_only: false },
    { name: "search", description: "repetida" },
    { name: "nome inválido!" },
  ];
  await assert.rejects(() => q(ana, "select public.ai_mcp_set_tools($1,$2::jsonb,null)", [crm, JSON.stringify(tools)]), /Só quem edita/);
  await q(admin, "select public.ai_mcp_set_tools($1,$2::jsonb,null)", [crm, JSON.stringify(tools)]);
  await q(manager, "select public.ai_mcp_toggle_tool($1,'create_deal',false)", [crm]);
  await q(admin, "select public.ai_mcp_set_tools($1,$2::jsonb,null)", [crm, JSON.stringify(tools)]);
  const [row] = (await list(admin)).filter((s) => s.id === crm);
  assert.deepEqual(row.tools.map((t) => [t.name, t.enabled, t.read_only]), [
    ["search", true, true],
    ["create_deal", false, false],
  ]);
  assert.equal(row.tools[0].input_schema, undefined);
  const c = await catalog(ana);
  // O Notion é OAuth de cada pessoa: falta a Ana conectar.
  assert.deepEqual(c.servers.map((s) => s.name), ["CRM", "Notion"]);
  assert.deepEqual(c.missing, ["Notion Ágil"]);
  const crmRow = c.servers.find((s) => s.name === "CRM");
  assert.deepEqual(crmRow.tools.map((t) => t.name), ["search"]);
  assert.equal(crmRow.header_cipher, "v1:selado");
  assert.deepEqual(crmRow.tools[0].input_schema.properties.q, { type: "string" });
});

await check("rodar sem confirmar: a sugestão entra na primeira vez; a escolha de quem edita fica", async () => {
  const tools = [
    { name: "search", read_only: true },
    { name: "create_deal", read_only: false },
    { name: "wait_job", read_only: false, auto: true },
  ];
  await q(admin, "select public.ai_mcp_set_tools($1,$2::jsonb,null)", [crm, JSON.stringify(tools)]);
  const auto = async () => Object.fromEntries((await list(admin)).find((s) => s.id === crm).tools.map((t) => [t.name, t.auto]));
  // A ferramenta que já existia (sem a marca) segue pedindo; a nova entra com a sugestão.
  assert.deepEqual(await auto(), { search: false, create_deal: false, wait_job: true });
  await assert.rejects(() => q(ana, "select public.ai_mcp_tool_auto($1,'create_deal',true)", [crm]), /Só quem edita/);
  await q(manager, "select public.ai_mcp_tool_auto($1,'create_deal',true)", [crm]);
  await q(manager, "select public.ai_mcp_tool_auto($1,'wait_job',false)", [crm]);
  // Atualizar a lista não desfaz a escolha.
  await q(admin, "select public.ai_mcp_set_tools($1,$2::jsonb,null)", [crm, JSON.stringify(tools)]);
  assert.deepEqual(await auto(), { search: false, create_deal: true, wait_job: false });
  // O catálogo da resposta leva a marca (create_deal estava desligada no passo anterior).
  await q(manager, "select public.ai_mcp_toggle_tool($1,'create_deal',true)", [crm]);
  const c = await catalog(bia);
  assert.equal(c.servers.find((s) => s.name === "CRM").tools.find((t) => t.name === "create_deal").auto, true);
  await q(manager, "select public.ai_mcp_tool_auto($1,'create_deal',false)", [crm]);
  await q(manager, "select public.ai_mcp_toggle_tool($1,'create_deal',false)", [crm]);
});

await check("quem usa: público das da empresa; desligar o poder tira tudo", async () => {
  await q(admin, "select public.ai_mcp_set_audience($1,false,'{}',$2,'{}')", [crm, [bia]]);
  assert.deepEqual((await catalog(ana)).servers.map((s) => s.name), ["Notion"]);
  assert.deepEqual((await catalog(bia)).servers.map((s) => s.name), ["CRM"]);
  await assert.rejects(() => q(ana, "select public.ai_mcp_connection($1)", [crm]), /não encontrada/);
  await assert.rejects(() => q(manager, "select public.ai_mcp_set_audience($1,true,'{}','{}','{}')", [mine]), /Só administradores e gestores/);
  await q(admin, "select public.ai_mcp_set_audience($1,true,'{}','{}','{}')", [crm]);
  await power(false);
  assert.deepEqual(await catalog(ana), { servers: [], missing: [] });
  // Os líderes seguem vendo e editando as da empresa.
  assert.equal((await list(manager)).length, 2);
  await power(true);
});

await check("OAuth: cada pessoa com a sua conta; o estado vale uma vez, sem login, por 15 minutos", async () => {
  const hash = (n) => String(n).repeat(64).slice(0, 64);
  await q(manager, "select public.ai_mcp_set_oauth($1,$2::jsonb)", [notion, JSON.stringify({ token_endpoint: "https://mcp.notion.com/token", client_id: "abc" })]);
  // Depois de cadastrado o app, só quem edita muda o OAuth.
  await assert.rejects(() => q(ana, "select public.ai_mcp_set_oauth($1,'{}'::jsonb)", [notion]), /Só quem edita/);
  await q(ana, "select public.ai_mcp_oauth_begin($1,$2,'v1:verificador','/agencias/make/mavi/conexoes')", [notion, hash(1)]);
  const pending = await one(null, "select public.ai_mcp_oauth_pending($1)", [hash(1)]);
  assert.equal(pending.verifier_cipher, "v1:verificador");
  assert.equal(pending.oauth.client_id, "abc");
  assert.equal(await one(null, "select public.ai_mcp_oauth_finish($1,'v1:token','v1:refresh',now() + interval '1 hour','read')", [hash(1)]), "/agencias/make/mavi/conexoes");
  await assert.rejects(() => q(null, "select public.ai_mcp_oauth_finish($1,'v1:token',null,null,null)", [hash(1)]), /expirou/);
  assert.deepEqual((await catalog(ana)).missing, []);
  assert.deepEqual((await catalog(bia)).missing, ["Notion Ágil"]);
  const conn = await one(ana, "select public.ai_mcp_connection($1)", [notion]);
  assert.equal(conn.token.access_cipher, "v1:token");
  assert.equal(await one(bia, "select public.ai_mcp_connection($1)", [notion]).then((c) => c.token), null);
  // Estado velho não vale.
  await q(bia, "select public.ai_mcp_oauth_begin($1,$2,'v1:v','/')", [notion, hash(2)]);
  await db.exec("reset role");
  await db.query("update mavi_private.ai_mcp_oauth_states set created_at = now() - interval '20 minutes'");
  assert.equal(await one(null, "select public.ai_mcp_oauth_pending($1)", [hash(2)]), null);
  // Renovar o token e desconectar mexem só na conta de quem pede.
  await q(ana, "select public.ai_mcp_save_token($1,'v1:novo',null,now() + interval '1 hour',null)", [notion]);
  assert.equal((await one(ana, "select public.ai_mcp_connection($1)", [notion])).token.refresh_cipher, "v1:refresh");
  await q(ana, "select public.ai_mcp_disconnect($1)", [notion]);
  assert.deepEqual((await catalog(ana)).missing, ["Notion Ágil"]);
  // A conta da empresa: só líderes conectam.
  const shared = await save(admin, { name: "Linear", url: "https://mcp.linear.app/mcp", auth: "oauth" });
  await assert.rejects(() => q(ana, "select public.ai_mcp_oauth_begin($1,$2,'v1:v','/')", [shared, hash(3)]), /Só administradores e gestores conectam/);
  await q(manager, "select public.ai_mcp_oauth_begin($1,$2,'v1:v','/')", [shared, hash(4)]);
  await q(null, "select public.ai_mcp_oauth_finish($1,'v1:empresa',null,null,null)", [hash(4)]);
  assert.equal((await one(bia, "select public.ai_mcp_connection($1)", [shared])).token.access_cipher, "v1:empresa");
  // Trocar o endereço esquece as contas e o OAuth.
  await save(admin, { id: shared, name: "Linear", url: "https://mcp.linear.app/v2", auth: "oauth" });
  const after = await one(admin, "select public.ai_mcp_connection($1)", [shared]);
  assert.equal(after.token, null);
  assert.deepEqual(after.oauth, {});
});

await check("a ação confirmada roda uma vez; o resultado fica gravado", async () => {
  const action = [
    {
      id: "action-mcp-1",
      ref: "A1",
      type: "action",
      state: "pending",
      action: { kind: "mcp_call", server_id: crm, server_name: "CRM", tool: "create_deal", arguments: { title: "Novo" } },
    },
  ];
  const conv = await one(
    ana,
    "select public.ai_save_turn($1,null,'{}'::jsonb,'assistant','Crie o negócio','Proposta [[A1]]','[]'::jsonb,'[]'::jsonb,$2::jsonb)",
    [A, JSON.stringify(action)],
  );
  await assert.rejects(() => q(bia, "select public.ai_mcp_claim_action($1,'action-mcp-1')", [conv]), /Só quem começou/);
  const claimed = await one(ana, "select public.ai_mcp_claim_action($1,'action-mcp-1')", [conv]);
  assert.deepEqual([claimed.tool, claimed.arguments.title, claimed.company], ["create_deal", "Novo", A]);
  await assert.rejects(() => q(ana, "select public.ai_mcp_claim_action($1,'action-mcp-1')", [conv]), /já foi decidida/);
  await q(ana, "select public.ai_mcp_action_result($1,'action-mcp-1',true,$2::jsonb)", [conv, JSON.stringify({ text: "Criado: #12" })]);
  const [row] = await q(ana, "select artifacts from ai_messages where conversation_id=$1 and role='assistant'", [conv]);
  assert.deepEqual([row.artifacts[0].state, row.artifacts[0].result.text], ["confirmed", "Criado: #12"]);
  // Só a ação de conexão passa por aqui.
  const task = [{ id: "action-task-1", ref: "A1", type: "action", state: "pending", action: { kind: "comment_task", task_id: uid(50), task_title: "T", text: "oi" } }];
  const conv2 = await one(
    ana,
    "select public.ai_save_turn($1,null,'{}'::jsonb,'assistant','Comente','[[A1]]','[]'::jsonb,'[]'::jsonb,$2::jsonb)",
    [A, JSON.stringify(task)],
  );
  await assert.rejects(() => q(ana, "select public.ai_mcp_claim_action($1,'action-task-1')", [conv2]), /já foi decidida/);
});

await check("registro das chamadas com o poder 'mcp'; apagar a conexão apaga os tokens", async () => {
  await q(ana, "select public.ai_log_tool_calls($1,null,'assistant',$2::jsonb)", [A, JSON.stringify([{ tool: "mcp:crm/search", power: "mcp", ok: true, ms: 120 }])]);
  await db.exec("reset role");
  assert.equal((await db.query("select power from ai_tool_calls where tool='mcp:crm/search'")).rows[0].power, "mcp");
  await assert.rejects(() => q(ana, "select public.ai_mcp_delete($1)", [notion]), /Só quem criou/);
  await q(manager, "select public.ai_mcp_delete($1)", [notion]);
  await q(ana, "select public.ai_mcp_delete($1)", [mine]);
  await db.exec("reset role");
  assert.equal((await db.query("select count(*)::int n from mavi_private.ai_mcp_tokens t join mavi_private.ai_mcp_servers s on s.id = t.server_id where s.name like 'Notion%'")).rows[0].n, 0);
  assert.deepEqual((await list(ana)).map((s) => s.name), ["CRM", "Linear"]);
});

console.log(`\n${passed} checks passed`);

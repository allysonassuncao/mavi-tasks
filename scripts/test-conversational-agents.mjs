// Agente Conversacional (migration 20270323090000_conversational_agents):
// VPS do n8n só para administradores (a chave só cifrada); a leitura pelo
// agendamento (segredo da MAVI) guarda fluxos com nó AI Agent, cria versões
// quando o texto muda e marca os apagados; liga sozinho pelo nome e o
// subfluxo herda; quem vê o cliente lê, quem edita no Drive publica (versão
// base, registro no Drive); líderes ligam/ignoram; a MAVI acha os prompts
// (sem as cópias) só para quem vê o cliente.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, manager, member, outsider, stranger] = [1, 2, 10, 11, 12, 13, 14].map(uid);
const SECRET = "s".repeat(40);
const SEALED = "v1:QUJDREVGR0hJSktMTU5PUA==";
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, manager, member, outsider, stranger]]);
await db.query(`insert into companies(id,name) values($1,'Make'),($2,'Outra')`, [A, B]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Gil Gestor','manager',true),($1,$4,'Bruno Colab','member',true),
   ($1,$5,'Carla Fora','member',true),($6,$7,'Duda Outra','admin',true)`,
  [A, admin, manager, member, outsider, B, stranger],
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
const sql = async (text, args = []) => {
  await db.exec("reset role");
  return (await db.query(text, args)).rows;
};
async function fails(fn, pattern) {
  let error;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  assert.ok(error, "deveria falhar");
  if (pattern) assert.match(`${error.code} ${error.message}`, pattern);
  return error;
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
const index = async () => {
  await as(null);
  while ((await rpc("ai_index_step", [SECRET, 200])) > 0);
};

await as(admin);
const team = await rpc("create_team", [A, "Equipe A", [member]]);
const client = await rpc("create_client", [A, "Clínica Sorriso", "", [team]]);
const other = await rpc("create_client", [A, "Padaria Pão", ""]);
const mavi = await rpc("create_product", [A, "MAVI"]);
const ads = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [A, client, mavi, "MAVI", team]);
await rpc("create_contract", [A, client, ads, "Make Ads", team]);
await sql(`insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`, [SECRET]);

const node = (id, prompt, extra = {}) => ({
  node_id: id,
  node_name: `AI Agent ${id}`,
  node_type: "@n8n/n8n-nodes-langchain.agent",
  prompt,
  expression: false,
  setup: { model: "gpt-4.1-mini", tools: ["Agenda"] },
  ...extra,
});
const flow = (id, name, extra = {}) => ({
  n8n_id: id,
  name,
  active: false,
  archived: false,
  role: "copy",
  called_by: [],
  version_id: `v-${id}`,
  updated_at: "2026-10-01T12:00:00Z",
  ...extra,
});

let vps;
await check("só administradores cadastram a VPS; a chave nunca volta", async () => {
  await as(manager);
  await fails(() => rpc("agent_instance_save", [A, null, "VPS 1", "https://n8n.example.com", SEALED, "…abcd", true]), /42501/);
  await as(admin);
  await fails(() => rpc("agent_instance_save", [A, null, "VPS 1", "http://n8n.example.com", SEALED, "", true]), /https/);
  await fails(() => rpc("agent_instance_save", [A, null, "VPS 1", "https://n8n.example.com", "texto", "", true]), /Chave/);
  await fails(() => rpc("agent_instance_save", [A, null, "VPS 1", "https://n8n.example.com", null, "", true]), /chave/);
  vps = await rpc("agent_instance_save", [A, null, " VPS 1 ", "https://n8n.example.com/", SEALED, "…abcd", true]);
  assert.equal(vps.name, "VPS 1");
  assert.equal(vps.base_url, "https://n8n.example.com");
  // Editar sem chave mantém a guardada.
  await rpc("agent_instance_save", [A, vps.id, "VPS Principal", "https://n8n.example.com", null, null, true]);
  const [row] = await sql(`select * from agent_instances where id=$1`, [vps.id]);
  assert.equal(row.key_cipher, SEALED);
  assert.equal(row.key_hint, "…abcd");
  await as(manager);
  const list = await rpc("agent_instances_list", [A]);
  assert.equal(list[0].name, "VPS Principal");
  assert.equal(list[0].key_cipher, undefined);
  await fails(() => rpc("agent_instance_secret", [A, vps.id]), /42501/);
  await as(member);
  await fails(() => rpc("agent_instances_list", [A]), /42501/);
  await as(stranger);
  await fails(() => rpc("agent_instances_list", [A]), /42501/);
  // Ninguém lê as tabelas direto.
  await as(admin);
  await fails(() => db.query(`select * from agent_instances`), /permission denied/);
});

await check("o agendamento pega a VPS uma vez e guarda os fluxos lidos", async () => {
  await as(null);
  await fails(() => rpc("agent_sync_targets", ["x".repeat(40), null, null]), /42501/);
  const [t] = await rpc("agent_sync_targets", [SECRET, null, null]);
  assert.equal(t.id, vps.id);
  assert.equal(t.key_cipher, SEALED);
  assert.deepEqual(t.known, {});
  // Já pega: a próxima volta não pega de novo.
  assert.deepEqual(await rpc("agent_sync_targets", [SECRET, null, null]), []);
  const r = await rpc("agent_sync_store", [
    SECRET,
    vps.id,
    JSON.stringify([
      flow("wf1", "[Clínica Sorriso] Atendimento", {
        active: true,
        role: "main",
        nodes: [node("n1", "Você é a assistente da clínica. Agendamento só de segunda a sexta.")],
      }),
      flow("wf2", "Agendamento - sub", {
        role: "subflow",
        called_by: [{ id: "wf1", name: "[Clínica Sorriso] Atendimento" }],
        nodes: [node("n2", "Você agenda consultas.")],
      }),
      flow("wf3", "Clínica Sorriso BACKUP 12/09", { nodes: [node("n3", "Versão antiga.")] }),
      flow("wf4", "Fluxo interno de testes", { active: true, role: "main", nodes: [node("n4", "Teste.")] }),
    ]),
    true,
    null,
    JSON.stringify({ workflows: 30, agents: 4 }),
  ]);
  assert.deepEqual(r, { changed: 4, removed: 0, linked: 3 });
  const rows = await sql(`select n8n_id, client_id, contract_id, link_source from agent_workflows order by n8n_id`);
  assert.deepEqual(
    rows.map((w) => [w.n8n_id, w.client_id, w.contract_id, w.link_source]),
    [
      ["wf1", client, contract, "auto"],
      ["wf2", client, contract, "auto"],
      ["wf3", client, contract, "auto"],
      ["wf4", null, null, null],
    ],
  );
  const [i] = await sql(`select * from agent_instances where id=$1`, [vps.id]);
  assert.ok(i.last_sync_at);
  assert.equal(i.claimed_at, null);
  assert.equal(i.last_stats.agents, 4);
  // O aviso para as telas abertas.
  const [msg] = await sql(`select payload from realtime.messages order by id desc limit 1`);
  assert.equal(msg.payload.kind, "agents");
});

const prompts = async () =>
  Object.fromEntries((await sql(`select node_id, id from agent_prompts`)).map((r) => [r.node_id, r.id]));
let P;
await check("quem vê o cliente lê os fluxos; os sem cliente só líderes", async () => {
  P = await prompts();
  await as(member);
  const list = await rpc("agent_list", [A, null, null, null, false]);
  assert.deepEqual(list.map((w) => [w.n8n_id, w.role]), [
    ["wf1", "main"],
    ["wf2", "subflow"],
    ["wf3", "copy"],
  ]);
  assert.equal(list[0].client_name, "Clínica Sorriso");
  assert.equal(list[0].product_name, "MAVI");
  assert.equal(list[0].n8n_url, "https://n8n.example.com/workflow/wf1");
  assert.equal(list[0].can_edit, true);
  assert.equal(list[0].prompts[0].setup.model, "gpt-4.1-mini");
  assert.equal(list[0].prompts[0].prompt, undefined);
  // Busca no texto, com o trecho achado.
  const found = await rpc("agent_list", [A, null, null, "segunda a sexta", false]);
  assert.deepEqual(found.map((w) => w.n8n_id), ["wf1"]);
  assert.match(found[0].prompts[0].excerpt, /segunda a sexta/);
  assert.equal(await rpc("agent_count", [A, contract]), 3);
  await fails(() => rpc("agent_list", [A, null, null, null, true]), /42501/);
  const full = await rpc("agent_prompt_get", [P.n1]);
  assert.match(full.prompt, /assistente da clínica/);
  assert.equal(full.workflow.name, "[Clínica Sorriso] Atendimento");
  await fails(() => rpc("agent_prompt_get", [P.n4]), /P0002/);
  await as(outsider);
  assert.deepEqual(await rpc("agent_list", [A, null, null, null, false]), []);
  assert.equal(await rpc("agent_count", [A, contract]), 0);
  await fails(() => rpc("agent_prompt_get", [P.n1]), /P0002/);
  await as(stranger);
  await fails(() => rpc("agent_list", [A, null, null, null, false]), /42501/);
  await as(manager);
  const unlinked = await rpc("agent_list", [A, null, null, null, true]);
  assert.deepEqual(unlinked.map((w) => w.n8n_id), ["wf4"]);
  const status = await rpc("agent_status", [A]);
  assert.equal(status.unlinked, 1);
  assert.equal(status.instances, 1);
});

await check("mudou no n8n: versão nova; nó e fluxo que saíram ficam marcados", async () => {
  await as(null);
  const [t] = await rpc("agent_sync_targets", [SECRET, null, null]).then(() => []);
  assert.equal(t, undefined); // ainda não passou 1h
  await sql(`update agent_instances set last_attempt_at = now() - interval '2 hours'`);
  const [target] = await rpc("agent_sync_targets", [SECRET, null, null]);
  assert.deepEqual(target.known, { wf1: "v-wf1", wf2: "v-wf2", wf3: "v-wf3", wf4: "v-wf4" });
  await rpc("agent_sync_store", [
    SECRET,
    vps.id,
    JSON.stringify([
      flow("wf1", "[Clínica Sorriso] Atendimento", {
        active: true,
        role: "main",
        version_id: "v-wf1b",
        nodes: [node("n1", "Você é a assistente da clínica. Agendamento de segunda a sábado.")],
      }),
      // Sem nodes: não mudou desde a última leitura.
      { n8n_id: "wf2", name: "Agendamento - sub", active: false, archived: false, role: "subflow",
        called_by: [{ id: "wf1", name: "[Clínica Sorriso] Atendimento" }], version_id: "v-wf2" },
      flow("wf4", "Fluxo interno de testes", { active: true, role: "main", nodes: [] }),
    ]),
    true,
    null,
    null,
  ]);
  const versions = await sql(`select version, source, saved_by from agent_prompt_versions where prompt_id=$1 order by version`, [P.n1]);
  assert.deepEqual(versions.map((v) => [v.version, v.source, v.saved_by]), [
    [1, "first", null],
    [2, "n8n", null],
  ]);
  const [wf3] = await sql(`select removed_at from agent_workflows where n8n_id='wf3'`);
  assert.ok(wf3.removed_at);
  const [n4] = await sql(`select removed_at from agent_prompts where id=$1`, [P.n4]);
  assert.ok(n4.removed_at);
  await as(member);
  assert.deepEqual((await rpc("agent_list", [A, null, null, null, false])).map((w) => w.n8n_id), ["wf1", "wf2"]);
});

await check("publicar: quem edita confere a versão; o registro vai para o Drive", async () => {
  await as(outsider);
  await fails(() => rpc("agent_prompt_edit_target", [P.n1, 2]), /P0002/);
  await as(member);
  const e = await fails(() => rpc("agent_prompt_edit_target", [P.n1, 1]), /40001/);
  assert.match(e.message, /Alguém no n8n mudou este prompt/);
  assert.equal(e.hint, "version:2");
  const t = await rpc("agent_prompt_edit_target", [P.n1, 2]);
  assert.equal(t.n8n_id, "wf1");
  assert.equal(t.node_id, "n1");
  assert.equal(t.key_cipher, SEALED);
  assert.match(t.stored, /segunda a sábado/);
  await fails(() => rpc("agent_prompt_saved", [P.n1, 2, "x", "", "apagar", null, null, null]), /Ação/);
  const saved = await rpc("agent_prompt_saved", [
    P.n1, 2, "Você é a assistente da clínica. Agendamento de segunda a sexta, 8h às 18h.",
    "  Horário de atendimento  ", "edit", null, "v-wf1c", "2026-10-04T10:00:00Z",
  ]);
  assert.equal(saved.version, 3);
  const [v] = await rpc("agent_prompt_versions", [P.n1]);
  assert.equal(v.source, "edit");
  assert.equal(v.note, "Horário de atendimento");
  assert.equal(v.saved_by_name, "Bruno Colab");
  const [w] = await sql(`select n8n_version_id from agent_workflows where n8n_id='wf1'`);
  assert.equal(w.n8n_version_id, "v-wf1c");
  const [log] = await sql(`select * from drive_audit where action='agent_prompt_published'`);
  assert.equal(log.client_id, client);
  assert.equal(log.contract_id, contract);
  assert.equal(log.actor_id, member);
  const old = await rpc("agent_prompt_version", [P.n1, 1]);
  assert.match(old.prompt, /segunda a sexta\./);
  const restored = await rpc("agent_prompt_saved", [P.n1, 3, old.prompt, "", "restore", 1, "v-wf1d", null]);
  assert.equal(restored.version, 4);
  const [r] = await rpc("agent_prompt_versions", [P.n1]);
  assert.deepEqual([r.source, r.restored_from], ["restore", 1]);
  // A próxima leitura do n8n com o mesmo texto não cria versão.
  await as(null);
  await sql(`update agent_instances set last_attempt_at = null`);
  await rpc("agent_sync_targets", [SECRET, null, null]);
  await rpc("agent_sync_store", [SECRET, vps.id, JSON.stringify([
    flow("wf1", "[Clínica Sorriso] Atendimento", { active: true, role: "main", version_id: "v-wf1d",
      nodes: [node("n1", old.prompt)] }),
  ]), false, null, null]);
  assert.equal((await sql(`select version from agent_prompts where id=$1`, [P.n1]))[0].version, 4);
  // O histórico não muda.
  await fails(() => sql(`update agent_prompt_versions set note='x'`), /histórico/);
});

await check("líderes ligam, desligam e ignoram; ligar leva os subfluxos", async () => {
  const wf4 = (await sql(`select id from agent_workflows where n8n_id='wf4'`))[0].id;
  await as(member);
  await fails(() => rpc("agent_workflow_link", [wf4, other, null]), /P0002/);
  await as(manager);
  await fails(() => rpc("agent_workflow_link", [wf4, other, contract]), /não é deste cliente/);
  const linked = await rpc("agent_workflow_link", [wf4, other, null]);
  assert.equal(linked.client_name, "Padaria Pão");
  assert.equal(linked.link_source, "manual");
  // Só líderes publicam onde não há produto ligado.
  await as(member);
  await fails(() => rpc("agent_prompt_get", [P.n4]), /P0002/);
  await as(manager);
  const off = await rpc("agent_workflow_link", [wf4, null, null]);
  assert.equal(off.client_id, null);
  const ignored = await rpc("agent_workflow_ignore", [wf4, true]);
  assert.equal(ignored.ignored, true);
  assert.equal((await rpc("agent_status", [A])).unlinked, 0);
  // Um subfluxo novo, sem nome de cliente, herda quando o principal é ligado.
  await as(null);
  await rpc("agent_sync_targets", [SECRET, null, null]);
  await rpc("agent_sync_store", [SECRET, vps.id, JSON.stringify([
    flow("wf5", "Bot Padaria", { active: true, role: "main", nodes: [node("n5", "Padaria.")] }),
    flow("wf6", "Cardápio", { role: "subflow", called_by: [{ id: "wf5", name: "Bot Padaria" }],
      nodes: [node("n6", "Cardápio.")] }),
  ]), false, null, null]);
  assert.equal((await sql(`select client_id from agent_workflows where n8n_id='wf6'`))[0].client_id, null);
  await as(manager);
  const wf5 = (await sql(`select id from agent_workflows where n8n_id='wf5'`))[0].id;
  await as(manager);
  await rpc("agent_workflow_link", [wf5, other, null]);
  const [wf6] = await sql(`select client_id, link_source from agent_workflows where n8n_id='wf6'`);
  assert.deepEqual([wf6.client_id, wf6.link_source], [other, "auto"]);
});

await check("a MAVI acha os prompts (sem as cópias) só para quem vê o cliente", async () => {
  await index();
  const docs = await sql(`select source_id, access, client_id, contract_id, title from ai_documents
    where source_type='agent_prompt' order by title`);
  P = await prompts();
  assert.ok(docs.some((d) => d.source_id === P.n1 && d.access === "client" && d.client_id === client
    && d.contract_id === contract));
  assert.ok(docs.some((d) => d.source_id === P.n2));
  assert.ok(!docs.some((d) => d.source_id === P.n3), "cópia (e apagada) fica de fora");
  const [d] = await sql(`select id from ai_documents where source_id=$1`, [P.n1]);
  const text = (await sql(`select content from ai_chunks where document_id=$1`, [d.id])).map((c) => c.content).join("\n");
  assert.match(text, /\[Agente Conversacional do cliente — prompt de sistema do robô de WhatsApp\] fluxo "\[Clínica Sorriso\] Atendimento"/);
  assert.match(text, /produto MAVI · fluxo principal \(ativo\)/);
  // Desligar o fluxo do cliente tira da MAVI.
  await as(manager);
  const wf1 = (await sql(`select id from agent_workflows where n8n_id='wf1'`))[0].id;
  await rpc("agent_workflow_link", [wf1, null, null]);
  await index();
  assert.equal((await sql(`select count(*)::int n from ai_documents where source_id=$1`, [P.n1]))[0].n, 0);
  await as(manager);
  await rpc("agent_workflow_link", [wf1, client, contract]);
  await index();
  assert.equal((await sql(`select count(*)::int n from ai_documents where source_id=$1`, [P.n1]))[0].n, 1);
});

await check("contexto para a conversa, o Copiloto e o Radar", async () => {
  await as(member);
  const ctx = await rpc("agent_prompts_context", [A, client, contract, 6000]);
  assert.deepEqual(ctx.map((x) => x.workflow), ["[Clínica Sorriso] Atendimento", "Agendamento - sub"]);
  assert.equal(ctx[0].product, "MAVI");
  assert.equal(ctx[0].model, "gpt-4.1-mini");
  // Só pelo produto (o Copiloto da tarefa).
  assert.equal((await rpc("agent_prompts_context", [A, null, contract, 6000])).length, 2);
  await as(outsider);
  assert.deepEqual(await rpc("agent_prompts_context", [A, client, null, 6000]), []);
  await as(null);
  await fails(() => rpc("agent_prompts_for_worker", ["x".repeat(40), client, 4000]), /42501/);
  const rules = await rpc("agent_prompts_for_worker", [SECRET, client, 4000]);
  assert.equal(rules.length, 2);
});

await check("o agendamento só chama o servidor quando uma VPS passou de 1h", async () => {
  await sql(`update agent_instances set last_attempt_at = now(), claimed_at = null`);
  await sql(`select mavi_private.agent_kick()`);
  assert.equal((await sql(`select count(*)::int n from net.requests where body->>'action'='agent-sync'`))[0].n, 0);
  await sql(`update agent_instances set last_attempt_at = now() - interval '61 minutes'`);
  await sql(`select mavi_private.agent_kick()`);
  const [req] = await sql(`select * from net.requests where body->>'action'='agent-sync'`);
  assert.equal(req.url, "https://app.example/api/ai");
  assert.equal(req.headers.Authorization, `Bearer ${SECRET}`);
  // Falha: registra e solta.
  await as(null);
  await rpc("agent_sync_targets", [SECRET, null, null]);
  await rpc("agent_sync_store", [SECRET, vps.id, null, false, "n8n respondeu 401", null]);
  await as(admin);
  const [i] = await rpc("agent_instances_list", [A]);
  assert.equal(i.last_error, "n8n respondeu 401");
  assert.equal(i.syncing, false);
  // Sincronizar agora (administrador) pega a VPS mesmo dentro da hora.
  const [t] = await rpc("agent_sync_targets", [null, A, vps.id]);
  assert.equal(t.id, vps.id);
  await fails(() => rpc("agent_sync_targets", [null, A, vps.id]), /sendo lida/);
  await as(manager);
  await fails(() => rpc("agent_sync_targets", [null, A, vps.id]), /42501/);
});

await check("o módulo entra entre os que o administrador pode ocultar", async () => {
  await as(admin);
  await rpc("set_member_pages", [A, member, ["agents"]]);
  const [m] = await sql(`select hidden_pages from memberships where user_id=$1`, [member]);
  assert.ok(m.hidden_pages.includes("agents"));
});

await check("recurso da pessoa: quem liga fluxos usa Sem cliente e Trocar cliente nos clientes que atende", async () => {
  await as(null);
  await rpc("agent_sync_targets", [SECRET, null, null]);
  await rpc("agent_sync_store", [SECRET, vps.id, JSON.stringify([
    flow("wf7", "Bot sem nome de cliente", { active: true, role: "main", nodes: [node("n7", "Olá.")] }),
  ]), false, null, null]);
  const wf7 = (await sql(`select id from agent_workflows where n8n_id='wf7'`))[0].id;
  const wf1 = (await sql(`select id from agent_workflows where n8n_id='wf1'`))[0].id;
  await as(member);
  assert.deepEqual(await rpc("agent_status", [A]), { leader: false, linker: false });
  await fails(() => rpc("agent_list", [A, null, null, null, true]), /42501/);
  await fails(() => rpc("agent_workflow_link", [wf7, client, contract]), /P0002/);
  await fails(() => rpc("set_member_agent_linker", [A, member, true]), /42501/);
  // Gestor libera só as pessoas das equipes dele (o Gil não está na Equipe A).
  await as(manager);
  await fails(() => rpc("set_member_agent_linker", [A, member, true]), /42501/);
  await as(admin);
  await rpc("set_member_agent_linker", [A, member, true]);
  assert.equal((await sql(`select agent_linker from memberships where user_id=$1`, [member]))[0].agent_linker, true);
  const [msg] = await sql(`select payload from realtime.messages order by id desc limit 1`);
  assert.equal(msg.payload.kind, "agents");
  await as(member);
  const status = await rpc("agent_status", [A]);
  assert.deepEqual([status.leader, status.linker, status.unlinked, status.instances], [false, true, 1, undefined]);
  assert.deepEqual((await rpc("agent_list", [A, null, null, null, true])).map((w) => w.n8n_id).sort(), ["wf4", "wf7"]);
  // Lê o prompt do fluxo sem cliente para decidir, mas não publica.
  assert.equal((await rpc("agent_prompt_get", [P.n4])).node_name, "AI Agent n4");
  // Só liga a clientes que atende.
  await fails(() => rpc("agent_workflow_link", [wf7, other, null]), /clientes que atende/);
  const linked = await rpc("agent_workflow_link", [wf7, client, contract]);
  assert.equal(linked.client_name, "Clínica Sorriso");
  await rpc("agent_workflow_ignore", [(await sql(`select id from agent_workflows where n8n_id='wf4'`))[0].id, false]);
  // Trocar cliente de um fluxo que vê.
  await rpc("agent_workflow_link", [wf1, null, null]);
  await rpc("agent_workflow_link", [wf1, client, contract]);
  // Quem não atende o cliente, mesmo liberado, não mexe nos fluxos dele.
  await as(admin);
  await rpc("set_member_agent_linker", [A, outsider, true]);
  await as(outsider);
  await fails(() => rpc("agent_workflow_link", [wf1, null, null]), /P0002/);
  // Desligar o recurso: volta ao normal.
  await as(admin);
  await rpc("set_member_agent_linker", [A, member, false]);
  await as(member);
  await fails(() => rpc("agent_list", [A, null, null, null, true]), /42501/);
  await fails(() => rpc("agent_workflow_link", [wf1, null, null]), /42501/);
  // Desativada, a pessoa não usa (mesmo liberada).
  await as(admin);
  await rpc("set_member_agent_linker", [A, member, true]);
  await sql(`update memberships set active=false where user_id=$1`, [member]);
  await as(member);
  await fails(() => rpc("agent_list", [A, null, null, null, true]), /42501/);
  await sql(`update memberships set active=true where user_id=$1`, [member]);
});

await check("quem foi liberado na aba Permissões (20270324) continua liberado", async () => {
  const { createTestDatabase, applyMigration } = await import("./database-fixture.mjs");
  const old = await createTestDatabase({ until: "20270325090000" });
  await old.query(`insert into auth.users(id) values ($1), ($2)`, [admin, member]);
  await old.query(`insert into companies(id,name) values($1,'Make')`, [A]);
  await old.query(`insert into memberships(company_id,user_id,name,role,active) values ($1,$2,'Ana','admin',true),($1,$3,'Bruno','member',true)`, [A, admin, member]);
  await old.query(`insert into agent_linkers(company_id,user_id,granted_by) values ($1,$2,$3)`, [A, member, admin]);
  await applyMigration(old, "20270325090000");
  const r = await old.query(`select user_id, agent_linker from memberships order by name`);
  // A administradora não precisa (sempre pode); o Bruno vem da aba antiga.
  assert.deepEqual(r.rows.map((x) => x.agent_linker), [false, true]);
  const t = await old.query(`select to_regclass('public.agent_linkers') as t`);
  assert.equal(t.rows[0].t, null);
});

await check("apagar a VPS leva os fluxos e tira da MAVI", async () => {
  await as(admin);
  await rpc("agent_instance_delete", [A, vps.id]);
  assert.equal((await sql(`select count(*)::int n from agent_workflows`))[0].n, 0);
  await index();
  assert.equal((await sql(`select count(*)::int n from ai_documents where source_type='agent_prompt'`))[0].n, 0);
});

console.log(`\n${passed} checks passed`);

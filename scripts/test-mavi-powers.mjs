// MAVI · Poderes (migration 20261212090000_mavi_powers): só líderes ligam os
// poderes e dizem quem usa (todos, equipes e pessoas, com exceções); quem
// tem a MAVI desligada não tem nenhum; as respostas guardam os anexos (a
// imagem só da própria empresa); a ação proposta é decidida uma vez, só por
// quem começou a conversa; cada chamada de ferramenta entra no Consumo; e a
// geração de imagens ganha a sua regra em Quem usa qual modelo.
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
const setPower = (user, power, enabled, everyone, teams = [], users = [], except = []) =>
  q(user, "select public.ai_set_power($1,$2,$3,$4,$5::uuid[],$6::uuid[],$7::uuid[])", [
    A, power, enabled, everyone, teams, users, except,
  ]);
const powers = (user, company = A) => one(user, "select public.ai_my_powers($1)", [company]);
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

await check("tudo vem desligado; só líderes configuram", async () => {
  assert.deepEqual(await powers(ana), []);
  const list = await one(manager, "select public.ai_powers_admin($1)", [A]);
  assert.deepEqual(list.map((p) => [p.power, p.enabled]), [
    ["visuals", false],
    ["images", false],
    ["actions", false],
  ]);
  await assert.rejects(() => setPower(ana, "visuals", true, true), /Só administradores e gestores/);
  await assert.rejects(() => one(ana, "select public.ai_powers_admin($1)", [A]), /Só administradores e gestores/);
  await assert.rejects(() => setPower(manager, "codigo", true, true), /Poder inválido/);
  // A tabela não se lê direto.
  await assert.rejects(() => q(ana, "select * from public.ai_powers"), /permission denied/);
});

await check("todos, ou equipes e pessoas, com exceções", async () => {
  await setPower(manager, "visuals", true, true, [], [], [caio]);
  assert.deepEqual(await powers(ana), ["visuals"]);
  assert.deepEqual(await powers(caio), []);
  await assert.rejects(() => setPower(manager, "images", true, false), /Escolha pelo menos uma equipe ou pessoa/);
  // Ids de fora da empresa não entram.
  await setPower(manager, "images", true, false, [team], [ana, otto]);
  assert.deepEqual(await powers(bia), ["images", "visuals"]);
  assert.deepEqual(await powers(ana), ["images", "visuals"]);
  assert.deepEqual(await powers(caio), []);
  const images = (await one(admin, "select public.ai_powers_admin($1)", [A])).find((p) => p.power === "images");
  assert.deepEqual(images.user_ids, [ana]);
  assert.equal(images.updated_by, manager);
  // Outra empresa: nada.
  assert.deepEqual(await powers(ana, B), []);
});

await check("quem tem a MAVI desligada nos módulos não tem nenhum poder; desligar vale na hora", async () => {
  await sql(`update memberships set hidden_pages = array['assistant'] where company_id = $1 and user_id = $2`, [A, ana]);
  assert.deepEqual(await powers(ana), []);
  await sql(`update memberships set hidden_pages = '{}' where company_id = $1 and user_id = $2`, [A, ana]);
  await setPower(admin, "visuals", false, true);
  assert.deepEqual(await powers(ana), ["images"]);
});

const conversation = await one(
  ana,
  "select public.ai_save_turn($1,null,'{}'::jsonb,'assistant','Pergunta?','Resposta','[]'::jsonb,'[]'::jsonb)",
  [A],
);
const good = [
  { id: "visual-0001", ref: "V1", type: "visual", visual: { kind: "kpis", items: [] } },
  { id: "image-0001", ref: "I1", type: "image", path: `ai-images/${A}/11111111-1111-4111-8111-111111111111.png` },
  {
    id: "action-0001",
    ref: "A1",
    type: "action",
    state: "pending",
    action: { kind: "comment_task", task_id: uid(50), task_title: "T", text: "Ok" },
  },
];
await check("a resposta guarda os anexos; a imagem só da própria empresa", async () => {
  assert.equal(
    await one(
      ana,
      "select public.ai_save_turn($1,$2,'{}'::jsonb,'assistant','Mais?','Veja [[V1]]','[]'::jsonb,'[]'::jsonb,$3::jsonb)",
      [A, conversation, JSON.stringify(good)],
    ),
    conversation,
  );
  const [row] = await q(ana, "select artifacts from ai_messages where conversation_id = $1 and role = 'assistant' order by id desc limit 1", [conversation]);
  assert.equal(row.artifacts.length, 3);
  for (const bad of [
    [{ ...good[1], path: `ai-images/${B}/11111111-1111-4111-8111-111111111111.png` }],
    [{ ...good[1], path: "drive/arquivo.png" }],
    [{ ...good[0], type: "script" }],
    [{ ...good[0], id: "x" }],
  ])
    await assert.rejects(
      () =>
        q(ana, "select public.ai_save_turn($1,$2,'{}'::jsonb,'assistant','Q','R','[]'::jsonb,'[]'::jsonb,$3::jsonb)", [
          A,
          conversation,
          JSON.stringify(bad),
        ]),
      /Anexos da resposta inválidos/,
    );
});

await check("a ação é decidida uma vez, só por quem começou a conversa", async () => {
  await assert.rejects(
    () => q(bia, "select public.ai_set_action_state($1,'action-0001','confirmed','{}'::jsonb)", [conversation]),
    /Só quem começou a conversa/,
  );
  await assert.rejects(
    () => q(ana, "select public.ai_set_action_state($1,'action-0001','done','{}'::jsonb)", [conversation]),
    /Situação inválida/,
  );
  await q(ana, `select public.ai_set_action_state($1,'action-0001','confirmed',$2::jsonb)`, [
    conversation,
    JSON.stringify({ comment_id: "c1" }),
  ]);
  const [row] = await q(ana, "select artifacts from ai_messages where conversation_id = $1 and role = 'assistant' order by id desc limit 1", [conversation]);
  const action = row.artifacts.find((a) => a.id === "action-0001");
  assert.equal(action.state, "confirmed");
  assert.deepEqual(action.result, { comment_id: "c1" });
  assert.equal(action.decided_by, ana);
  // Os outros anexos ficam como estavam, na mesma ordem.
  assert.deepEqual(row.artifacts.map((a) => a.id), ["visual-0001", "image-0001", "action-0001"]);
  await assert.rejects(
    () => q(ana, "select public.ai_set_action_state($1,'action-0001','cancelled','{}'::jsonb)", [conversation]),
    /já foi decidida/,
  );
});

await check("cada chamada de ferramenta entra no Consumo (só líderes veem)", async () => {
  await q(ana, "select public.ai_log_tool_calls($1,$2,'assistant',$3::jsonb)", [
    A,
    conversation,
    JSON.stringify([
      { tool: "search_knowledge", ok: true, ms: 800 },
      { tool: "generate_image", power: "images", ok: true, ms: 30000, cost: 0.042 },
      { tool: "generate_image", power: "images", ok: false, ms: 1000, error: "recusou" },
      { tool: "  ", ok: true },
    ]),
  ]);
  // A conversa de outra pessoa não vale: a chamada fica sem conversa.
  await q(bia, "select public.ai_log_tool_calls($1,$2,'assistant',$3::jsonb)", [
    A,
    conversation,
    JSON.stringify([{ tool: "list_tasks", ok: true, ms: 100, power: "hack" }]),
  ]);
  const rows = await sql("select tool, conversation_id, power from ai_tool_calls where company_id = $1 order by id", [A]);
  assert.equal(rows.length, 4);
  assert.equal(rows[3].conversation_id, null);
  assert.equal(rows[3].power, null);
  await assert.rejects(() => q(ana, "select * from public.ai_tool_calls"), /permission denied/);
  await assert.rejects(
    () => q(otto, "select public.ai_log_tool_calls($1,null,'assistant','[]'::jsonb)", [A]),
    /Sem permissão/,
  );
  const report = await one(manager, "select public.ai_usage_report($1,current_date - 1,current_date)", [A]);
  const image = report.by_tool.find((t) => t.id === "generate_image");
  assert.equal(Number(image.calls), 2);
  assert.equal(Number(image.errors), 1);
  assert.equal(Number(image.avg_ms), 15500);
  assert.equal(Number(image.cost), 0.042);
  assert.equal(Number(image.people), 1);
});

await check("imagens em Quem usa qual modelo: só modelos de imagem, sem herdar a empresa", async () => {
  const models = (...ids) => JSON.stringify(ids.map((id) => ({ id, input: 5, output: 40 })));
  const openai = await one(admin, "select public.ai_save_provider($1,null,'OpenAI','openai',null,$2::jsonb,'v1:abc','wxyz',true)", [
    A,
    models("gpt-5", "gpt-image-1"),
  ]);
  const groq = await one(admin, "select public.ai_save_provider($1,null,'Groq','groq',null,$2::jsonb,'v1:abc','wxyz',true)", [
    A,
    models("flux-image"),
  ]);
  const setRoute = (user, provider, model, feature = "image_generation") =>
    q(user, "select public.ai_set_route($1,'feature',null,$2,$3,$4)", [A, provider, model, feature]);
  await assert.rejects(() => setRoute(manager, openai, "gpt-5"), /Escolha um modelo de imagem/);
  await assert.rejects(() => setRoute(manager, groq, "flux-image"), /As imagens usam a OpenAI/);
  await assert.rejects(() => setRoute(manager, openai, "gpt-image-1", "notice_writer"), /escolha um modelo de conversa/);
  await q(admin, "select public.ai_set_route($1,'company',null,$2,'gpt-5')", [A, openai]);
  // Sem a regra dela, as imagens não herdam o modelo de conversa da empresa.
  assert.equal(await one(ana, "select public.ai_resolve_route($1,null,null,null,'image_generation')", [A]), null);
  await setRoute(manager, openai, "gpt-image-1");
  const r = await one(ana, "select public.ai_resolve_route($1,null,null,null,'image_generation')", [A]);
  assert.equal(r.model, "gpt-image-1");
  assert.equal(Number(r.price.output), 40);
  // A conversa continua no padrão da empresa.
  assert.equal((await one(ana, "select public.ai_resolve_route($1,null,null,null,'assistant')", [A])).model, "gpt-5");
});

console.log(`\n${passed} checks passed`);

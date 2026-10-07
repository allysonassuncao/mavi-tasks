// MAVI · roteador de modelos, fase 1 (migration 20270528090000_ai_router):
// os candidatos sem as chaves (só provedores ativos, para quem é da empresa),
// o registro da decisão (só na própria conversa, no cliente que a pessoa
// acessa, com provedores da empresa; nada é "auto" nesta fase), a leitura só
// para líderes e o desempenho por tipo × modelo com votos, autoavaliação e
// a economia estimada.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, ana, bia, outsider] = [1, 2, 10, 11, 12, 13].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, ana, bia, outsider]]);
await db.query(`insert into companies(id,name) values($1,'Make'),($2,'Outra')`, [A, B]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Ana Equipe','member',true),($1,$4,'Bia Equipe','member',true),
   ($5,$6,'Fora','admin',true)`,
  [A, admin, ana, bia, B, outsider],
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
const [p1] = await sql(
  `insert into mavi_private.ai_providers(company_id,name,kind,key_cipher,models) values
   ($1,'OpenAI','openai','v1:x','[{"id":"gpt-5-mini","input":0.25,"output":2}]') returning id`,
  [A],
);
await sql(
  `insert into mavi_private.ai_providers(company_id,name,kind,key_cipher,models,active) values
   ($1,'Desligado','groq','v1:y','[{"id":"llama","input":0.1,"output":0.1}]',false)`,
  [A],
);
const [pOther] = await sql(
  `insert into mavi_private.ai_providers(company_id,name,kind,key_cipher) values ($1,'Deles','openai','v1:z') returning id`,
  [B],
);

async function turn(user, scope = {}) {
  await as(user);
  const conv = await rpc("ai_save_turn", [A, null, JSON.stringify(scope), "assistant", "Analise o ROAS", "Resposta", "[]", "[]"]);
  const [m] = await sql(`select id from ai_messages where conversation_id = $1 and role = 'assistant'`, [conv]);
  return { conv, message: Number(m.id) };
}
const entry = (over = {}) =>
  JSON.stringify({
    surface: "page",
    feature: "mavi_page",
    task_type: "analise",
    complexity: 2,
    modalities: ["text"],
    context_tokens: 8000,
    latency_class: "normal",
    why: ["tipo: analise"],
    mode: "auto",
    need_tier: 2,
    suggested_provider_id: null,
    suggested_model: "claude-sonnet-5",
    reason: "Análise, complexidade 2 → faixa 2",
    candidates: [
      { provider: "Servidor", providerId: null, model: "claude-sonnet-5", tier: 2, est: 0.02, score: 0.8 },
      { provider: "Servidor", providerId: null, model: "claude-opus-5-5", tier: 3, est: 0.05, score: 0.7 },
    ],
    used_provider_id: null,
    used_model: "claude-opus-5-5",
    first_token_ms: 1800,
    total_ms: 9000,
    rounds: 3,
    cost_usd: 0.061,
    tools_ok: 4,
    tools_failed: 0,
    capped: false,
    ...over,
  });

await check("candidatos: provedores ativos da empresa, sem a chave; só para quem é da empresa", async () => {
  await as(ana);
  const list = await rpc("ai_route_candidates", [A]);
  assert.deepEqual(list.map((p) => [p.name, p.kind, p.models.map((m) => m.id)]), [["OpenAI", "openai", ["gpt-5-mini"]]]);
  assert.ok(!JSON.stringify(list).includes("v1:"), "a chave não sai");
  await as(outsider);
  await rejects(() => rpc("ai_route_candidates", [A]), /Sem acesso/);
});

let t;
await check("registro: na própria conversa e mensagem; auto vira sombra nesta fase", async () => {
  t = await turn(ana, { client });
  await as(ana);
  const id = await rpc("ai_route_log", [A, entry({ conversation_id: t.conv, message_id: t.message, client_id: client })]);
  const [row] = await sql(`select * from ai_route_decisions where id = $1`, [id]);
  assert.equal(row.mode, "shadow");
  assert.equal(row.user_id, ana);
  assert.equal(Number(row.message_id), t.message);
  assert.equal(row.used_model, "claude-opus-5-5");
  assert.equal(row.first_token_ms, 1800);
  assert.equal(row.candidates.length, 2);
  // Travado pela regra: fica travado, com quem travou.
  const locked = await rpc("ai_route_log", [A, entry({ mode: "locked", locked_by: "client" })]);
  const [l] = await sql(`select mode, locked_by, first_token_ms from ai_route_decisions where id = $1`, [locked]);
  assert.deepEqual([l.mode, l.locked_by], ["locked", "client"]);
  // Sem a primeira palavra (falhou antes), fica vazio.
  const failed = await rpc("ai_route_log", [A, entry({ first_token_ms: null, error: "caiu" })]);
  const [f] = await sql(`select first_token_ms, error from ai_route_decisions where id = $1`, [failed]);
  assert.deepEqual([f.first_token_ms, f.error], [null, "caiu"]);
});

await check("registro: conversa de outra pessoa, cliente sem acesso, provedor de fora e mensagem solta recusam", async () => {
  await as(bia);
  await rejects(() => rpc("ai_route_log", [A, entry({ conversation_id: t.conv })]), /Conversa inválida/);
  await as(bia);
  await rejects(() => rpc("ai_route_log", [A, entry({ client_id: client })]), /Sem permissão/);
  await as(ana);
  await rejects(() => rpc("ai_route_log", [A, entry({ used_provider_id: pOther.id })]), /Provedor inválido/);
  await as(ana);
  await rejects(() => rpc("ai_route_log", [A, entry({ message_id: t.message })]), /Mensagem inválida/);
  await as(ana);
  await rejects(() => rpc("ai_route_log", [A, entry({ task_type: "inventado" })]), /check/);
  await as(outsider);
  await rejects(() => rpc("ai_route_log", [A, entry()]), /Sem permissão/);
  await as(ana);
  assert.ok(await rpc("ai_route_log", [A, entry({ used_provider_id: p1.id, used_model: "gpt-5-mini" })]));
});

await check("leitura e desempenho: só líderes; votos, autoavaliação, qualidade e economia estimada", async () => {
  await as(ana);
  assert.equal((await db.query(`select 1 from ai_route_decisions`)).rows.length, 0);
  await rejects(() => rpc("ai_route_stats", [A, 30]), /Só administradores e gestores/);
  // 👎 na resposta registrada e a autoavaliação aprovando outra.
  await as(ana);
  await rpc("mavi_feedback_vote", [t.message, "down", "wrong", ""]);
  const t2 = await turn(ana);
  await as(ana);
  await rpc("ai_route_log", [A, entry({ conversation_id: t2.conv, message_id: t2.message })]);
  await sql(
    `insert into mavi_answer_checks(message_id, company_id, conversation_id, status, verdict)
     values ($1,$2,$3,'done','{"ok":true,"confidence":0.9}')
     on conflict (message_id) do update set status = 'done', verdict = excluded.verdict`,
    [t2.message, A, t2.conv],
  );
  await as(admin);
  assert.ok((await db.query(`select 1 from ai_route_decisions`)).rows.length >= 5);
  const s = await rpc("ai_route_stats", [A, 30]);
  assert.equal(s.total, 5);
  const opus = s.by_type_model.find((x) => x.task_type === "analise" && x.model === "claude-opus-5-5");
  assert.equal(opus.n, 4);
  assert.equal(opus.down, 1);
  assert.equal(opus.judged, 1);
  assert.equal(opus.judged_bad, 0);
  // O 👎 e a falha contam contra.
  assert.equal(opus.quality, 0.5);
  assert.equal(opus.total_ms_p50, 9000);
  // Escolheria o Sonnet (0,02) no lugar do Opus (0,05) que respondeu.
  assert.equal(s.shadow.est_ratio, 0.4);
  assert.equal(s.shadow.locked, 1);
  assert.ok(s.shadow.by_suggestion.some((x) => x.used_model === "claude-opus-5-5" && x.suggested_model === "claude-sonnet-5"));
  await as(outsider);
  await rejects(() => rpc("ai_route_stats", [A, 30]), /Só administradores e gestores/);
});

console.log(`\n${passed} verificações do roteador de modelos passaram.`);

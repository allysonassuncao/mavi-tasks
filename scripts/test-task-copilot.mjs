// Assistente MAVI nas tarefas (migration 20261101090000_task_copilot):
// funcionalidades novas no Painel da MAVI, dossiê do cliente (leitura pela
// regra do Drive, edição só de líderes, itens fixados/removidos que a MAVI
// não mexe), fila do worker só para clientes em uso, material incremental
// com cursor, contexto do copiloto numa ida ao banco com as permissões de
// quem cria a tarefa, freio por pessoa e registro do que fizeram com os
// alertas.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, member, outsider, manager] = [1, 10, 11, 12, 13].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, member, outsider, manager],
]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Bruno Equipe','member',true),
   ($1,$4,'Carla Fora','member',true),($1,$5,'Gabi Gestora','manager',true)`,
  [A, admin, member, outsider, manager],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [
    user ?? "",
  ]);
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
/** Vetor apontando para um "tema" (eixo), com um pouco de outro eixo. */
const vec = (i, j = 1535, w = 0.01) =>
  `[${Array.from({ length: 1536 }, (_, k) => (k === i ? 1 : k === j ? w : 0)).join(",")}]`;

await sql(
  `insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`,
  [SECRET],
);
await as(admin);
const team = await rpc("create_team", [A, "Equipe A", [member]]);
const client = await rpc("create_client", [A, "4282", "", [team]]);
const other = await rpc("create_client", [A, "9001", "", []]);
const product = await rpc("create_product", [A, "Social Media"]);
const contract = await rpc("create_contract", [
  A,
  client,
  product,
  "Social · 4282",
  team,
]);
const otherContract = await rpc("create_contract", [
  A,
  other,
  product,
  "Social · 9001",
  null,
]);

// Documentos já indexados (o indexador é testado em test-ai-knowledge).
async function doc({
  type,
  source,
  access = "client",
  clientId = client,
  task = null,
  title,
  at,
  chunks,
  indexed,
}) {
  const [{ id }] = await sql(
    `insert into ai_documents(company_id, source_type, source_id, access, client_id, contract_id, task_id, title,
      occurred_at, content_hash, indexed_at)
     values ($1,$2,$3,$4,$5,null,$6,$7,$8,md5(random()::text),coalesce($9::timestamptz, now())) returning id`,
    [A, type, source, access, clientId, task, title, at, indexed ?? null],
  );
  for (const [ord, c] of chunks.entries())
    await sql(
      `insert into ai_chunks(company_id, document_id, ord, content, meta, source_type, access, client_id, task_id,
        occurred_at, embedding)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::extensions.halfvec(1536))`,
      [
        A,
        id,
        ord,
        c.text,
        JSON.stringify(c.meta ?? {}),
        type,
        access,
        clientId,
        task,
        at,
        c.vec ?? null,
      ],
    );
  return id;
}
async function task(title, assignee) {
  const [{ id }] = await sql(
    `insert into tasks(company_id, contract_id, title, description, assignee_id, creator_id, due_date, original_due_date)
     values ($1,$2,$3,'',$4,$4,'2026-10-05','2026-10-05') returning id`,
    [A, contract, title, assignee],
  );
  return id;
}
const bf = await task("Post de Black Friday", member);
const secret = await task("Post de Black Friday da diretoria", admin);
const report = await task("Relatório mensal", member);
await doc({
  type: "task",
  source: bf,
  access: "task",
  task: bf,
  title: "Post de Black Friday",
  at: "2026-09-20",
  chunks: [
    { text: "Tarefa\nCarrossel da Black Friday com 30% off", vec: vec(1) },
  ],
});
await doc({
  type: "task",
  source: secret,
  access: "task",
  task: secret,
  title: "Post de Black Friday da diretoria",
  at: "2026-09-21",
  chunks: [{ text: "Tarefa\nBlack Friday interna", vec: vec(1) }],
});
await doc({
  type: "task",
  source: report,
  access: "task",
  task: report,
  title: "Relatório mensal",
  at: "2026-09-01",
  chunks: [{ text: "Tarefa\nRelatório de resultados", vec: vec(7) }],
});
const caseId = uid(900);
await doc({
  type: "success_case",
  source: caseId,
  clientId: null,
  title: "Loja 9001 dobrou vendas na Black Friday",
  at: "2026-08-01",
  chunks: [{ text: "Case\nROAS 8 na Black Friday", vec: vec(1, 2, 0.3) }],
});
const meetingId = uid(901);
await doc({
  type: "meeting",
  source: meetingId,
  title: "R1 4282",
  at: "2026-09-10",
  indexed: "2026-09-10",
  chunks: [
    {
      text: "Reunião\nResumo: o cliente não gosta de vermelho",
      meta: { kind: "summary" },
      vec: vec(1, 3, 0.2),
    },
    {
      text: "Reunião\ntranscrição longa que não entra no dossiê",
      meta: { start: 30 },
      vec: vec(9),
    },
  ],
});
const waId = uid(902);
await doc({
  type: "whatsapp",
  source: waId,
  title: "Grupo 4282 · 12/09/2026",
  at: "2026-09-12",
  indexed: "2026-09-12",
  chunks: [{ text: "WhatsApp\nAprovação sempre com a Bia", vec: vec(4) }],
});
// Material de outro cliente não entra.
await doc({
  type: "whatsapp",
  source: uid(903),
  clientId: other,
  title: "Grupo 9001",
  at: "2026-09-12",
  chunks: [{ text: "WhatsApp\nOutro cliente", vec: vec(1) }],
});

await check(
  "copiloto e dossiê entram nas regras por funcionalidade",
  async () => {
    await sql(
      `insert into mavi_private.ai_providers(id, company_id, name, kind, base_url, key_cipher, key_hint, models)
     values ($1,$2,'OpenAI','openai','https://api.openai.com/v1','v1:cifra','9xYz','[{"id":"gpt-5.6-luna","label":"Luna"}]')`,
      [uid(800), A],
    );
    await as(admin);
    await rpc("ai_set_route", [
      A,
      "feature",
      null,
      uid(800),
      "gpt-5.6-luna",
      "task_copilot",
    ]);
    await rejects(
      () =>
        rpc("ai_set_route", [
          A,
          "feature",
          null,
          uid(800),
          "gpt-5.6-luna",
          "inventada",
        ]),
      /inválida/,
    );
    await as(member);
    const route = await rpc("ai_resolve_route", [
      A,
      client,
      contract,
      null,
      "task_copilot",
    ]);
    assert.equal(route.model, "gpt-5.6-luna");
    assert.equal(route.scope, "feature");
    // O worker (sem pessoa) escolhe pelo segredo: sem regra do dossiê, nenhuma.
    await as(null);
    assert.equal(
      await rpc("ai_worker_route", [SECRET, A, "client_dossier"]),
      null,
    );
    assert.equal(
      (await rpc("ai_worker_route", [SECRET, A, "task_copilot"])).model,
      "gpt-5.6-luna",
    );
    await rejects(
      () => rpc("ai_worker_route", ["errado", A, "task_copilot"]),
      /Sem permissão/,
    );
  },
);

await check(
  "contexto dos Relacionados: tarefas do cliente (as dos colegas só com título e status), cases de todos, sem histórico",
  async () => {
    await as(member);
    const ctx = await rpc("task_copilot_context", [
      A,
      contract,
      null,
      vec(1),
      "Black Friday",
      false,
    ]);
    assert.equal(ctx.throttled, false);
    assert.equal(ctx.client.name, "4282");
    assert.deepEqual(
      ctx.similar.map((t) => t.id).sort(),
      [bf, secret, report].sort(),
    );
    const byId = Object.fromEntries(ctx.similar.map((t) => [t.id, t]));
    assert.ok(byId[bf].similarity > 0.99 && byId[report].similarity < 0.1);
    assert.equal(byId[bf].status, "progress");
    assert.equal(byId[bf].restricted, false);
    assert.match(byId[bf].snippet, /Carrossel/);
    // A tarefa da diretoria (a pessoa não abre): só título e status.
    assert.deepEqual(Object.keys(byId[secret]).sort(), [
      "id",
      "restricted",
      "similarity",
      "status",
      "title",
    ]);
    assert.equal(byId[secret].restricted, true);
    assert.equal(byId[secret].title, "Post de Black Friday da diretoria");
    assert.equal(ctx.cases[0].id, caseId);
    assert.ok(ctx.cases[0].similarity > 0.9);
    assert.deepEqual(ctx.evidence, []);
    assert.equal(ctx.dossier, null);
    // Líder vê a tarefa da diretoria inteira; na edição, a própria tarefa sai.
    await as(admin);
    const lead = await rpc("task_copilot_context", [
      A,
      null,
      bf,
      vec(1),
      "Black Friday",
      false,
    ]);
    assert.equal(lead.similar.find((t) => t.id === secret).restricted, false);
    assert.ok(!lead.similar.some((t) => t.id === bf));
    // Relacionados não colocam o cliente na fila do dossiê.
    assert.equal(
      (
        await sql(
          `select count(*)::int as n from mavi_private.client_dossier_state`,
        )
      )[0].n,
      0,
    );
  },
);

await check("quem não atende o cliente não usa o copiloto nele", async () => {
  await as(outsider);
  await rejects(
    () => rpc("task_copilot_context", [A, contract, null, vec(1), "x", false]),
    /Sem acesso/,
  );
  await rejects(
    () => rpc("task_copilot_context", [A, null, bf, vec(1), "x", false]),
    /Sem acesso/,
  );
  await as(member);
  await rejects(
    () =>
      rpc("task_copilot_context", [A, otherContract, null, vec(1), "x", false]),
    /Sem acesso/,
  );
});

await check(
  "análise: histórico do cliente, dossiê e o cliente entra na fila",
  async () => {
    await as(member);
    const ctx = await rpc("task_copilot_context", [
      A,
      contract,
      null,
      vec(1),
      "Black Friday vermelho",
      true,
    ]);
    assert.ok(ctx.evidence.length >= 1);
    assert.ok(
      ctx.evidence.every((e) => ["meeting", "whatsapp"].includes(e.type)),
    );
    assert.ok(!ctx.evidence.some((e) => e.content.includes("Outro cliente")));
    assert.equal(ctx.evidence[0].id, meetingId);
    assert.deepEqual(ctx.dossier.items, []);
    const [state] = await sql(
      `select * from mavi_private.client_dossier_state where client_id = $1`,
      [client],
    );
    assert.ok(state.dirty_at);
    assert.equal(state.built_at, null);
  },
);

await check("freio: 12 análises por minuto por pessoa", async () => {
  await sql(
    `insert into ai_usage(company_id, user_id, module, kind, client_id, model, cost_usd)
     select $1, $2, 'tasks', 'copilot', $3, 'm', 0 from generate_series(1, 12)`,
    [A, member, client],
  );
  await as(member);
  assert.deepEqual(
    await rpc("task_copilot_context", [A, contract, null, vec(1), "x", true]),
    { throttled: true },
  );
  // Os Relacionados não têm freio (não chamam modelo); outra pessoa segue normal.
  assert.equal(
    (await rpc("task_copilot_context", [A, contract, null, vec(1), "x", false]))
      .throttled,
    false,
  );
  await as(manager);
  assert.equal(
    (await rpc("task_copilot_context", [A, contract, null, vec(1), "x", true]))
      .throttled,
    false,
  );
  await sql(`delete from ai_usage where kind = 'copilot'`);
});

let items;
await check(
  "worker: primeira leitura na hora, material do mais antigo ao mais novo, reunião pelo resumo",
  async () => {
    await as(null);
    const kicked = await sql(
      `select count(*)::int as n from net.requests where body->>'action' = 'ai-dossier'`,
    );
    await sql(`select mavi_private.ai_dossier_kick()`);
    const after = await sql(
      `select count(*)::int as n from net.requests where body->>'action' = 'ai-dossier'`,
    );
    assert.equal(after[0].n, kicked[0].n + 1);
    await as(null);
    const claimed = await rows("ai_dossier_claim", [SECRET, 4]);
    assert.deepEqual(
      claimed.map((c) => c.client_id),
      [client],
    );
    assert.equal(claimed[0].products, "Social Media");
    // Já em leitura: outro worker não pega.
    assert.equal((await rows("ai_dossier_claim", [SECRET, 4])).length, 0);
    const m = await rpc("ai_dossier_material", [
      SECRET,
      client,
      null,
      null,
      60000,
      4000,
    ]);
    assert.equal(m.more, false);
    const types = m.docs.map((d) => d.type);
    assert.ok(!types.includes("success_case"));
    const meeting = m.docs.find((d) => d.type === "meeting");
    assert.match(meeting.text, /não gosta de vermelho/);
    assert.doesNotMatch(meeting.text, /transcrição longa/);
    assert.ok(!m.docs.some((d) => d.text.includes("Outro cliente")));
    // Limite pequeno: vem um pedaço e "more".
    const part = await rpc("ai_dossier_material", [
      SECRET,
      client,
      null,
      null,
      10,
      4000,
    ]);
    assert.equal(part.docs.length, 1);
    assert.equal(part.more, true);
    const rest = await rpc("ai_dossier_material", [
      SECRET,
      client,
      part.cursor_at,
      part.cursor_id,
      60000,
      4000,
    ]);
    assert.equal(rest.docs.length, m.docs.length - 1);

    const changed = await rpc("ai_dossier_store", [
      SECRET,
      client,
      m.cursor_at,
      m.cursor_id,
      false,
      JSON.stringify([
        {
          op: "add",
          kind: "avoids",
          text: "Não gosta de vermelho nas artes",
          sources: [{ type: "meeting", title: "R1" }],
          seen_at: "2026-09-10",
        },
        { op: "add", kind: "rule", text: "Aprovação sempre com a Bia" },
        { op: "add", kind: "rule", text: "aprovação sempre com a bia" },
        { op: "add", kind: "inventado", text: "Tipo errado" },
      ]),
      JSON.stringify({
        model: "gpt-5.6-luna",
        input: 1000,
        output: 50,
        cost: 0.004,
        provider_id: uid(800),
        provider: "OpenAI",
      }),
    ]);
    assert.equal(changed, 2);
    const [state] = await sql(
      `select * from mavi_private.client_dossier_state where client_id = $1`,
      [client],
    );
    assert.equal(state.dirty_at, null);
    assert.equal(state.version, 1);
    assert.equal(state.running_until, null);
    const [usage] = await sql(`select * from ai_usage where kind = 'dossier'`);
    assert.equal(usage.user_id, null);
    assert.equal(usage.client_id, client);
    assert.equal(usage.provider_name, "OpenAI");
    items = await sql(
      `select * from client_dossier_items where client_id = $1 order by kind`,
      [client],
    );
    assert.equal(items.length, 2);
  },
);

await check(
  "dossiê na tela: equipe do cliente lê, só líderes editam e o que removem não volta",
  async () => {
    await as(member);
    const d = await rpc("client_dossier", [A, client]);
    assert.equal(d.items.length, 2);
    assert.equal(d.can_edit, false);
    assert.equal(d.version, 1);
    await rejects(
      () =>
        rpc("client_dossier_save", [A, client, null, "rule", "Posso editar?"]),
      /Só administradores/,
    );
    await as(outsider);
    await rejects(() => rpc("client_dossier", [A, client]), /Sem acesso/);

    await as(manager);
    const avoid = items.find((i) => i.kind === "avoids");
    const rule = items.find((i) => i.kind === "rule");
    await rpc("client_dossier_set", [A, avoid.id, "pin"]);
    await rpc("client_dossier_set", [A, rule.id, "remove"]);
    const mine = await rpc("client_dossier_save", [
      A,
      client,
      null,
      "style",
      "Tom leve, sem gírias",
    ]);
    const again = await rpc("client_dossier", [A, client]);
    assert.equal(again.can_edit, true);
    // Líder vê também os removidos (para restaurar).
    assert.equal(again.items.find((i) => i.id === rule.id).dismissed, true);
    assert.equal(again.items.find((i) => i.id === mine).origin, "person");
    assert.equal(again.items.find((i) => i.id === mine).pinned, true);
    assert.equal(again.version, 4);
    await as(member);
    assert.ok(
      !(await rpc("client_dossier", [A, client])).items.some(
        (i) => i.id === rule.id,
      ),
    );

    // A MAVI não muda fixados, não remove itens de pessoas nem repete removidos.
    await as(null);
    const n = await rpc("ai_dossier_store", [
      SECRET,
      client,
      null,
      null,
      false,
      JSON.stringify([
        { op: "update", id: avoid.id, text: "Mudou" },
        { op: "remove", id: mine },
        { op: "remove", id: rule.id },
        { op: "add", kind: "rule", text: "Aprovação sempre com a Bia" },
      ]),
      null,
    ]);
    assert.equal(n, 0);
    assert.equal(
      (
        await sql(`select text from client_dossier_items where id = $1`, [
          avoid.id,
        ])
      )[0].text,
      "Não gosta de vermelho nas artes",
    );
    // Pessoa: remover apaga de vez; da MAVI, restaurar traz de volta.
    await as(admin);
    await rpc("client_dossier_set", [A, mine, "remove"]);
    await rpc("client_dossier_set", [A, rule.id, "restore"]);
    assert.equal(
      (
        await sql(
          `select count(*)::int as n from client_dossier_items where id = $1`,
          [mine],
        )
      )[0].n,
      0,
    );
    assert.equal(
      (
        await sql(`select dismissed from client_dossier_items where id = $1`, [
          rule.id,
        ])
      )[0].dismissed,
      false,
    );
  },
);

await check(
  "material novo deixa o dossiê pendente; o worker espera 15 min parado",
  async () => {
    await doc({
      type: "whatsapp",
      source: uid(904),
      title: "Grupo 4282 · 20/09/2026",
      at: "2026-09-20",
      chunks: [{ text: "WhatsApp\nNovo pedido", vec: vec(5) }],
    });
    const [state] = await sql(
      `select dirty_at from mavi_private.client_dossier_state where client_id = $1`,
      [client],
    );
    assert.ok(state.dirty_at);
    await as(null);
    assert.equal((await rows("ai_dossier_claim", [SECRET, 4])).length, 0);
    await sql(
      `update mavi_private.client_dossier_state set dirty_at = now() - interval '16 minutes'`,
    );
    const [c] = await rows("ai_dossier_claim", [SECRET, 4]);
    const m = await rpc("ai_dossier_material", [
      SECRET,
      client,
      c.cursor_at,
      c.cursor_id,
      60000,
      4000,
    ]);
    assert.deepEqual(
      m.docs.map((d) => d.title),
      ["Grupo 4282 · 20/09/2026"],
    );
    // Falha: volta mais tarde, com espera crescente.
    await rpc("ai_dossier_fail", [SECRET, client, "provedor fora"]);
    const [failed] = await sql(
      `select attempts, running_until > now() + interval '9 minutes' as later
    from mavi_private.client_dossier_state where client_id = $1`,
      [client],
    );
    assert.equal(failed.attempts, 1);
    assert.equal(failed.later, true);
    // Cliente sem uso não entra na fila.
    assert.equal(
      (
        await sql(
          `select count(*)::int as n from mavi_private.client_dossier_state where client_id = $1`,
          [other],
        )
      )[0].n,
      0,
    );
  },
);

await check("o dossiê entra no contexto da análise", async () => {
  await as(member);
  const ctx = await rpc("task_copilot_context", [
    A,
    contract,
    null,
    vec(1),
    "Black Friday",
    true,
  ]);
  assert.ok(
    ctx.dossier.items.some(
      (i) => i.text === "Não gosta de vermelho nas artes" && i.pinned,
    ),
  );
  assert.ok(ctx.dossier.version >= 5);
});

await check("o que fizeram com os alertas fica registrado", async () => {
  await as(member);
  const n = await rpc("task_copilot_feedback", [
    A,
    client,
    bf,
    JSON.stringify([
      {
        kind: "avoids",
        severity: "high",
        action: "applied",
        title: "Sem vermelho",
      },
      {
        kind: "duplicate",
        severity: "high",
        action: "ignored",
        title: "Já existe",
      },
      { kind: "case", action: "inventada" },
    ]),
  ]);
  assert.equal(n, 2);
  await as(outsider);
  await rejects(
    () => rpc("task_copilot_feedback", [A, client, null, "[]"]),
    /Sem acesso/,
  );
  await as(member);
  await rejects(
    () => db.query(`select * from public.task_copilot_events`),
    /permission denied/,
  );
});

await check("tabelas do dossiê só por funções", async () => {
  await as(admin);
  await rejects(
    () => db.query(`select * from public.client_dossier_items`),
    /permission denied/,
  );
  // Sem conta: nem chama.
  await as(null);
  await rejects(() => rpc("client_dossier", [A, client]), /permission denied/);
});

console.log(`\n${passed} verificações passaram.`);

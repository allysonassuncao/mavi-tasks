// IA do MAVI · base de conhecimento (migration 20261021090000_ai_knowledge):
// trechos das reuniões e tarefas, reindexação só quando o texto muda, fila
// por instrução, worker concorrente, busca híbrida com as permissões de quem
// pergunta, custo e agendamento.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, teamMember, outsider, creator] = [1, 10, 11, 12, 13].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, teamMember, outsider, creator],
]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Bruno Equipe','member',true),
   ($1,$4,'Carla Fora','member',true),($1,$5,'Davi Criador','member',true)`,
  [A, admin, teamMember, outsider, creator],
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
/** Vetor de 1536 dimensões apontando para um "tema" (eixo). */
const axis = (i) =>
  `[${Array.from({ length: 1536 }, (_, k) => (k === i ? 1 : k === 1535 ? 0.01 : 0)).join(",")}]`;

await sql(
  `insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`,
  [SECRET],
);
await as(admin);
const team = await rpc("create_team", [A, "Equipe A", [teamMember]]);
const client = await rpc("create_client", [A, "4282", "", [team]]);
const product = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [
  A,
  client,
  product,
  "Make Ads · 4282",
  team,
]);

// Reunião com transcrição longa (vários trechos) e resumo.
// Uma frase a cada 6 s, como numa conversa real.
const segments = Array.from({ length: 60 }, (_, i) => [
  i * 6,
  i * 6 + 5,
  i % 2,
  i === 45
    ? "O orçamento mensal da campanha fica em três mil reais a partir de outubro."
    : `Fala número ${i} sobre o andamento geral do atendimento e dos leads que chegam pelo Instagram.`,
]);
const [{ id: meeting }] = await sql(
  `insert into meeting_recordings(company_id, client_id, source_id, title, recorded_at, recorded_by_email, speakers, summary)
   values ($1,$2,'bot-1','R2 4282','2026-09-10 13:00+00','ana@x.com','{Ana,Leandro}',
    '{"title":"Alinhamento de verba","overview":"Definição da verba de outubro.","action_items":[{"owner":"Ana","description":"Enviar proposta","deadline":"05/10"}]}')
   returning id`,
  [A, client],
);
await sql(
  `insert into meeting_transcripts(recording_id, company_id, speakers, segments) values ($1,$2,'{Ana,Leandro}',$3)`,
  [meeting, A, JSON.stringify(segments)],
);

// Tarefa criada por Davi (fora da equipe do cliente) e comentário.
await as(creator);
await sql(
  `insert into client_teams(company_id, client_id, team_id) select $1, $2, $3 where false`,
  [A, client, team],
);
const [{ id: task }] = await sql(
  `insert into tasks(company_id, contract_id, title, description, assignee_id, creator_id, due_date, original_due_date)
   values ($1,$2,'Criativos de outubro','Produzir três criativos com a nova oferta de consórcio.',$3,$3,'2026-10-05','2026-10-05')
   returning id`,
  [A, contract, creator],
);
await sql(
  `insert into comments(company_id, task_id, author_id, body) values ($1,$2,$3,'Cliente pediu tom mais leve no criativo.')`,
  [A, task, creator],
);

await check("mudanças entram na fila uma vez por item", async () => {
  const q = await sql(
    `select source_type, source_id from mavi_private.ai_queue order by source_type`,
  );
  assert.deepEqual(
    q.map((r) => r.source_type),
    ["meeting", "task"],
  );
});

await check("só o segredo do agendamento roda o worker", async () => {
  await as(null);
  await assert.rejects(
    () => rpc("ai_index_step", ["errado", 10]),
    /Sem permissão/,
  );
  await as(teamMember);
  await assert.rejects(
    () => rpc("ai_claim_chunks", [null, 10]),
    /Sem permissão/,
  );
});

await check(
  "monta os trechos: resumo, transcrição com o minuto, tarefa e comentários",
  async () => {
    await as(null);
    assert.equal(await rpc("ai_index_step", [SECRET, 100]), 2);
    const chunks = await sql(
      `select source_type, ord, content, meta, client_id, task_id, access from ai_chunks order by source_type, ord`,
    );
    const m = chunks.filter((c) => c.source_type === "meeting");
    assert.ok(m.length >= 3, `trechos da reunião: ${m.length}`);
    assert.match(
      m[0].content,
      /^\[Reunião\] "Alinhamento de verba" · cliente 4282 · 10\/09\/2026 · gravada por ana\n/,
    );
    assert.match(
      m[0].content,
      /Próximos passos:\n- Ana · Enviar proposta · 05\/10/,
    );
    assert.equal(m[0].meta.kind, "summary");
    assert.equal(m[1].meta.start, 0);
    assert.match(m[1].content, /\[00:00\] Ana: Fala número 0/);
    assert.ok(
      m.every(
        (c) =>
          c.content.length < 1800 &&
          c.client_id === client &&
          c.access === "client",
      ),
    );
    const t = chunks.filter((c) => c.source_type === "task");
    assert.match(
      t[0].content,
      /^\[Tarefa\] "Criativos de outubro" · cliente 4282 · produto Make Ads/,
    );
    assert.match(t[0].content, /Produzir três criativos/);
    assert.match(
      t[1].content,
      /Comentários:\n\[\d\d\/\d\d\/\d{4}\] Davi Criador: Cliente pediu tom mais leve/,
    );
    assert.ok(t.every((c) => c.task_id === task && c.access === "task"));
    assert.equal(
      (await sql(`select count(*)::int n from mavi_private.ai_queue`))[0].n,
      0,
    );
  },
);

await check(
  "sem mudança no texto, nada é refeito; status da tarefa nem entra na fila",
  async () => {
    const before = await sql(`select id from ai_chunks order by id`);
    await sql(
      `insert into mavi_private.ai_queue(source_type, source_id, company_id) values ('meeting',$1,$2)`,
      [meeting, A],
    );
    await sql(`update tasks set status = 'review' where id = $1`, [task]);
    assert.equal(
      (await sql(`select count(*)::int n from mavi_private.ai_queue`))[0].n,
      1,
    );
    await as(null);
    await rpc("ai_index_step", [SECRET, 100]);
    assert.deepEqual(await sql(`select id from ai_chunks order by id`), before);
  },
);

await check(
  "texto mudou: a tarefa é refeita e os vetores antigos saem",
  async () => {
    await sql(
      `update tasks set description = 'Produzir quatro criativos.' where id = $1`,
      [task],
    );
    await as(null);
    await rpc("ai_index_step", [SECRET, 100]);
    const t = await sql(
      `select content from ai_chunks where task_id = $1 order by ord`,
      [task],
    );
    assert.match(t[0].content, /quatro criativos/);
  },
);

await check(
  "workers concorrentes não pegam o mesmo trecho; vetores gravados",
  async () => {
    await as(null);
    const first = await rows("ai_claim_chunks", [SECRET, 3]);
    const second = await rows("ai_claim_chunks", [SECRET, 1000]);
    const ids = [...first, ...second].map((r) => Number(r.id));
    assert.equal(new Set(ids).size, ids.length);
    assert.equal((await rows("ai_claim_chunks", [SECRET, 10])).length, 0);
    // Temas: o trecho do orçamento aponta para o eixo 7; o resto, para o eixo 1.
    const all = await sql(`select id, content from ai_chunks`);
    const items = all.map((c) => ({
      id: Number(c.id),
      embedding: axis(
        /orçamento mensal/.test(c.content)
          ? 7
          : /criativo/i.test(c.content)
            ? 3
            : 1,
      ),
    }));
    await as(null);
    assert.equal(
      await rpc("ai_store_embeddings", [
        SECRET,
        "text-embedding-3-small",
        JSON.stringify(items),
      ]),
      all.length,
    );
    assert.equal(
      (
        await sql(
          `select count(*)::int n from ai_chunks where embedding is null`,
        )
      )[0].n,
      0,
    );
    const status = await rpc("ai_index_status", [SECRET]);
    assert.deepEqual(
      [status.queue, status.pending, status.documents],
      [0, 0, 2],
    );
  },
);

await check(
  "busca híbrida: acha pelo significado e pelos termos, com o minuto",
  async () => {
    await as(admin);
    const byVector = await rows("ai_search", [A, axis(7), "", {}, 3]);
    assert.match(byVector[0].content, /orçamento mensal/);
    // O trecho começa na primeira fala dele: no máximo 1 min antes da frase (4:30).
    const start = Number(byVector[0].meta.start);
    assert.ok(start <= 270 && start >= 270 - 60, `início ${start}`);
    const byText = await rows("ai_search", [
      A,
      null,
      "qual o orçamento mensal?",
      {},
      3,
    ]);
    assert.match(byText[0].content, /orçamento mensal/);
    // Tarefas trazem o estado atual.
    const tasks = await rows("ai_search", [
      A,
      axis(3),
      "criativos",
      { types: ["task"] },
      5,
    ]);
    assert.ok(tasks.length > 0 && tasks.every((r) => r.source_type === "task"));
    assert.equal(tasks[0].task_status, "review");
    assert.equal(tasks[0].task_assignee, creator);
  },
);

await check(
  "permissões: equipe vê a reunião do cliente, não a tarefa alheia; criador vê a tarefa",
  async () => {
    await as(teamMember);
    const team = await rows("ai_search", [
      A,
      axis(7),
      "orçamento criativos",
      {},
      20,
    ]);
    assert.ok(team.some((r) => r.source_type === "meeting"));
    assert.ok(!team.some((r) => r.source_type === "task"));
    await as(outsider);
    assert.equal(
      (await rows("ai_search", [A, axis(7), "orçamento criativos", {}, 20]))
        .length,
      0,
    );
    await as(creator);
    const own = await rows("ai_search", [A, axis(3), "criativos", {}, 20]);
    assert.ok(own.some((r) => r.source_type === "task"));
    assert.ok(!own.some((r) => r.source_type === "meeting"));
  },
);

await check("filtros: cliente e período", async () => {
  await as(admin);
  const other = await rows("ai_search", [
    A,
    axis(7),
    "orçamento",
    { client: uid(99) },
    5,
  ]);
  assert.equal(other.length, 0);
  const past = await rows("ai_search", [
    A,
    axis(7),
    "orçamento",
    { to: "2026-09-01" },
    5,
  ]);
  assert.equal(past.length, 0);
});

await check("ler mais: trechos vizinhos, com a mesma permissão", async () => {
  await as(admin);
  const [hit] = await rows("ai_search", [A, axis(7), "", {}, 1]);
  const around = await rows("ai_read", [hit.chunk_id, 1]);
  assert.equal(around.length, 3);
  await as(outsider);
  await assert.rejects(() => rows("ai_read", [hit.chunk_id, 1]), /Sem acesso/);
});

await check("apagar a reunião apaga os trechos (pela fila)", async () => {
  await sql(`delete from meeting_recordings where id = $1`, [meeting]);
  await as(null);
  await rpc("ai_index_step", [SECRET, 10]);
  assert.equal(
    (
      await sql(
        `select count(*)::int n from ai_chunks where source_type = 'meeting'`,
      )
    )[0].n,
    0,
  );
});

await check(
  "custo: pergunta de quem vê o cliente; indexação com o segredo; só líderes leem",
  async () => {
    await as(teamMember);
    await rpc("ai_log_usage", [
      A,
      "meetings",
      "ask",
      client,
      null,
      null,
      null,
      "claude-opus-5",
      1000,
      100,
      0,
      0,
      5,
      0.01,
    ]);
    await as(outsider);
    await assert.rejects(
      () =>
        rpc("ai_log_usage", [
          A,
          "meetings",
          "ask",
          client,
          null,
          null,
          null,
          "m",
          1,
          1,
          0,
          0,
          0,
          0.01,
        ]),
      /Sem permissão/,
    );
    await as(null);
    await rpc("ai_log_indexing", [
      SECRET,
      "text-embedding-3-small",
      JSON.stringify([{ company: A, tokens: 900, cost: 0.00002 }]),
    ]);
    await as(teamMember);
    assert.equal((await db.query(`select 1 from ai_usage`)).rows.length, 0);
    await as(admin);
    const usage = (
      await db.query(
        `select kind, embedding_tokens, user_id from ai_usage order by id`,
      )
    ).rows;
    assert.deepEqual(
      usage.map((u) => [u.kind, u.embedding_tokens, u.user_id]),
      [
        ["ask", 5, teamMember],
        ["index", 900, null],
      ],
    );
  },
);

await check("agendamento: só acorda o worker quando há trabalho", async () => {
  await sql(`delete from net.requests`);
  await sql(`select mavi_private.ai_kick()`);
  assert.equal((await sql(`select count(*)::int n from net.requests`))[0].n, 0);
  await sql(`update tasks set title = 'Criativos de novembro' where id = $1`, [
    task,
  ]);
  await sql(`select mavi_private.ai_kick()`);
  const [req] = await sql(`select url, body, headers from net.requests`);
  assert.equal(req.url, "https://app.example/api/ai");
  assert.deepEqual(req.body, { action: "ai-index" });
  assert.equal(req.headers.Authorization, `Bearer ${SECRET}`);
});

await check("ninguém lê as tabelas da IA direto", async () => {
  await as(admin);
  await assert.rejects(
    () => db.query(`select 1 from ai_chunks`),
    /permission denied/,
  );
  await assert.rejects(
    () => db.query(`select 1 from ai_documents`),
    /permission denied/,
  );
});

await db.close();
console.log(`\n${passed} verificações da base de conhecimento aprovadas.`);

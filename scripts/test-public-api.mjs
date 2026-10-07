// API pública (migration 20261115090000_public_api): chaves de API do espaço
// (só administradores; guardadas como hash) e as funções api_* que o
// servidor chama sem sessão para cadastrar clientes e vincular produtos.
// Reuniões já feitas (20270603090000_api_meetings): api_create_meeting e a
// fila do vídeo por link.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, manager, outsider] = [1, 2, 10, 11, 12].map(uid);
const [trafego, social, outroB, equipe, equipeB] = [20, 21, 22, 30, 31].map(
  uid,
);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, manager, outsider],
]);
await db.query(
  `insert into companies(id,name) values($1,'Empresa A'),($2,'Empresa B')`,
  [A, B],
);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$3,'Ana Admin','admin'),($1,$4,'Gabi Gestora','manager'),($2,$5,'Fora','admin')`,
  [A, B, admin, manager, outsider],
);
await db.query(
  `insert into products(id,company_id,name) values
   ($1,$4,'Gestão de tráfego'),($2,$4,'Social media'),($3,$5,'Gestão de tráfego')`,
  [trafego, social, outroB, A, B],
);
await db.query(
  `insert into teams(id,company_id,name) values($1,$3,'Performance'),($2,$4,'Performance')`,
  [equipe, equipeB, A, B],
);

async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [
    user ?? "",
  ]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
const one = async (sql, args) => (await db.query(sql, args)).rows[0];
const api = async (fn, args) => {
  await as(null);
  const params = args.map((_, i) => `$${i + 1}`).join(",");
  return Object.values(await one(`select public.${fn}(${params}) r`, args))[0];
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

let key, keyB;
await check("só administradores criam chaves; o texto só sai na criação", async () => {
  await as(manager);
  await assert.rejects(
    db.query("select public.api_key_create($1,'CRM')", [A]),
    /exclusivas de administradores/,
  );
  await as(admin);
  key = (await one("select public.api_key_create($1,'CRM') k", [A])).k;
  assert.match(key, /^workspace_[0-9a-f]{64}$/);
  const [row] = (await db.query("select * from public.api_keys_list($1)", [A]))
    .rows;
  assert.equal(row.name, "CRM");
  assert.equal(row.prefix, key.slice(0, 18));
  assert.equal(row.created_by_name, "Ana Admin");
  assert.equal(row.revoked_at, null);
  await db.exec("reset role");
  const stored = await one(
    "select encode(key_hash,'hex') h from mavi_private.api_keys",
  );
  assert.notEqual(stored.h, key);
  await as(outsider);
  keyB = (await one("select public.api_key_create($1,'Outro') k", [B])).k;
  // Another company's admin can't list or revoke A's keys.
  await assert.rejects(
    db.query("select * from public.api_keys_list($1)", [A]),
    /exclusivas/,
  );
  await assert.rejects(
    db.query("select public.api_key_revoke($1)", [row.id]),
    /exclusivas/,
  );
});

await check("chave inválida é recusada; a tabela não é acessível", async () => {
  await assert.rejects(api("api_list_products", ["workspace_nada"]), /inválida/);
  await assert.rejects(api("api_list_products", [null]), /inválida/);
  await as(admin);
  await assert.rejects(
    db.query("select * from mavi_private.api_keys"),
    /permission denied/,
  );
});

await check("lista produtos e equipes só da empresa da chave", async () => {
  const products = await api("api_list_products", [key]);
  assert.deepEqual(
    products.map((p) => p.name),
    ["Gestão de tráfego", "Social media"],
  );
  assert.deepEqual(await api("api_list_teams", [key]), [
    { id: equipe, name: "Performance" },
  ]);
  await db.exec("reset role");
  assert.ok(
    (await one("select last_used_at from mavi_private.api_keys where name='CRM'"))
      .last_used_at,
  );
});

let client;
await check("cria cliente com equipes e produtos por nome e por id", async () => {
  const r = await api("api_create_client", [
    key,
    {
      name: "  Aurora Studio ",
      email: "Contato@Aurora.com.br",
      teams: ["performance"],
      products: [
        "gestão de tráfego",
        { id: social, contract_name: "Social · plano anual" },
        { name: "Gestão de Tráfego" }, // repetido: ignorado
      ],
    },
  ]);
  client = r.client.id;
  assert.equal(r.client.name, "Aurora Studio");
  assert.equal(r.client.email, "contato@aurora.com.br");
  assert.deepEqual(r.client.teams, [{ id: equipe, name: "Performance" }]);
  assert.equal(r.linked.length, 2);
  assert.ok(r.linked.every((l) => l.created));
  assert.deepEqual(
    r.client.products.map((p) => p.contract_name),
    ["Gestão de tráfego · Aurora Studio", "Social · plano anual"],
  );
});

await check("mesmo e-mail ativo: 23505 com o id do cliente existente", async () => {
  await as(null);
  await assert.rejects(
    db.query("select public.api_create_client($1,$2)", [
      key,
      { name: "Aurora de novo", email: "contato@aurora.com.br" },
    ]),
    (e) => e.code === "23505" && e.detail === client,
  );
});

await check("erro em um produto desfaz o cadastro inteiro", async () => {
  await db.exec("reset role");
  const before = (await one("select count(*)::int n from clients")).n;
  await assert.rejects(
    api("api_create_client", [
      key,
      { name: "Borealis", products: ["Social media", "Inexistente"] },
    ]),
    /Produto não encontrado: Inexistente/,
  );
  // Another company's product or team is "not found" too.
  await assert.rejects(
    api("api_create_client", [key, { name: "Borealis", products: [outroB] }]),
    /Produto não encontrado/,
  );
  await assert.rejects(
    api("api_create_client", [key, { name: "Borealis", teams: [equipeB] }]),
    /Equipe não encontrada/,
  );
  await db.exec("reset role");
  assert.equal((await one("select count(*)::int n from clients")).n, before);
});

await check("validação dos campos", async () => {
  await assert.rejects(api("api_create_client", [key, { name: "A" }]), /name/);
  await assert.rejects(
    api("api_create_client", [key, { name: "Cliente", email: "x" }]),
    /email inválido/,
  );
  await assert.rejects(
    api("api_create_client", [key, { name: "Cliente", products: "x" }]),
    /lista/,
  );
});

await check("vincular produtos: não duplica o que já está vinculado", async () => {
  await db.exec("reset role");
  const novo = uid(23);
  await db.query(
    `insert into products(id,company_id,name) values($1,$2,'SEO')`,
    [novo, A],
  );
  const r = await api("api_link_client_products", [
    key,
    client,
    ["SEO", "Gestão de tráfego"],
  ]);
  assert.deepEqual(
    r.linked.map((l) => [l.product_name, l.created]),
    [
      ["SEO", true],
      ["Gestão de tráfego", false],
    ],
  );
  assert.equal(r.client.products.length, 3);
  await assert.rejects(
    api("api_link_client_products", [key, client, []]),
    /ao menos um produto/,
  );
  // A's client is invisible to B's key.
  await assert.rejects(
    api("api_link_client_products", [keyB, client, [outroB]]),
    /Cliente não encontrado/,
  );
  await assert.rejects(api("api_get_client", [keyB, client]), /não encontrado/);
});

await check("cliente arquivado não recebe produtos", async () => {
  await db.exec("reset role");
  const arq = uid(40);
  await db.query(
    `insert into clients(id,company_id,name,archived) values($1,$2,'Arquivado',true)`,
    [arq, A],
  );
  await assert.rejects(
    api("api_link_client_products", [key, arq, ["SEO"]]),
    /arquivado/,
  );
});

await check("busca por e-mail e por nome", async () => {
  const byEmail = await api("api_find_clients", [key, "CONTATO@aurora.com.br", null]);
  assert.deepEqual(
    byEmail.map((c) => c.id),
    [client],
  );
  const byName = await api("api_find_clients", [key, null, "auro"]);
  assert.equal(byName.length, 1);
  assert.deepEqual(await api("api_find_clients", [keyB, null, "auro"]), []);
  await assert.rejects(api("api_find_clients", [key, null, "a"]), /Informe/);
  const got = await api("api_get_client", [key, client]);
  assert.equal(got.name, "Aurora Studio");
});

const SECRET = "s".repeat(40);
const meeting = (extra = {}) => ({
  external_id: "zoom-1",
  title: "Kickoff",
  recorded_at: "2026-10-07T14:00:00-03:00",
  attendees: ["ana@x.com", "Bruno"],
  summary: { overview: "Alinhamos o escopo." },
  transcript: { speakers: ["Ana", "Bruno"], segments: [[0, 4, 0, "Bom dia, vamos falar do orçamento."], [4, 9, 1, "Certo."]] },
  ...extra,
});

let recording;
await check("reunião: grava, transcreve e entra na fila da MAVI", async () => {
  const r = await api("api_create_meeting", [key, client, meeting()]);
  recording = r.meeting.id;
  assert.equal(r.meeting.external_id, "zoom-1");
  assert.equal(r.meeting.segments, 2);
  assert.equal(r.meeting.timed, true);
  assert.equal(r.meeting.video, "none");
  await db.exec("reset role");
  const row = await one("select * from meeting_recordings where id=$1", [recording]);
  assert.equal(row.company_id, A);
  assert.equal(row.client_id, client);
  assert.equal(row.source_id, "api:zoom-1");
  assert.deepEqual(row.speakers, ["Ana", "Bruno"]);
  assert.deepEqual(row.attendees, ["ana@x.com", "Bruno"]);
  assert.equal(row.summary.overview, "Alinhamos o escopo.");
  const t = await one("select timed, search @@ to_tsquery('portuguese','orçamento') hit from meeting_transcripts where recording_id=$1", [recording]);
  assert.deepEqual(t, { timed: true, hit: true });
  assert.ok(await one("select 1 from mavi_private.ai_queue where source_type='meeting' and source_id=$1", [recording]));
  assert.ok(await one("select 1 from realtime.messages where payload->>'table'='meeting_recordings'"));
  // Quem vê o cliente no Drive vê a reunião.
  await as(admin);
  assert.ok(await one("select 1 from meeting_recordings where id=$1", [recording]));
});

await check("reunião repetida (mesmo external_id): 23505 com o id", async () => {
  await assert.rejects(api("api_create_meeting", [key, client, meeting()]), (e) => {
    assert.equal(e.code, "23505");
    assert.equal(e.detail, recording);
    return true;
  });
  // Sem external_id: cada envio é uma reunião nova.
  const { external_id, ...rest } = meeting();
  const r = await api("api_create_meeting", [key, client, rest]);
  assert.equal(r.meeting.external_id, null);
  await db.exec("reset role");
  assert.match((await one("select source_id from meeting_recordings where id=$1", [r.meeting.id])).source_id, /^api:[0-9a-f-]{36}$/);
});

await check("reunião: cliente de outra empresa não existe para a chave", async () => {
  await assert.rejects(api("api_create_meeting", [keyB, client, meeting({ external_id: "b" })]), (e) => e.code === "P0002");
});

await check("reunião: validação dos campos", async () => {
  const bad = async (extra, pattern) =>
    assert.rejects(api("api_create_meeting", [key, client, meeting({ external_id: null, ...extra })]), (e) => {
      assert.equal(e.code, "22023");
      assert.match(e.message, pattern);
      return true;
    });
  await bad({ recorded_at: null }, /recorded_at/);
  await bad({ recorded_at: "ontem" }, /recorded_at inválido/);
  await bad({ recorded_at: "2099-01-01T00:00:00Z" }, /fora do intervalo/);
  await bad({ duration_seconds: -1 }, /duration_seconds/);
  await bad({ recorded_by_email: "nada" }, /recorded_by_email/);
  await bad({ video_url: "http://x.com/a.mp4" }, /video_url/);
  await bad({ attendees: [1] }, /attendees/);
  await bad({ transcript: { speakers: [], segments: [[0, 1, 0]] } }, /transcript/);
  await bad({ transcript: null, summary: {} }, /ao menos/);
  await bad({ external_id: "x".repeat(101) }, /external_id/);
});

await check("vídeo por link: fila, worker com o segredo e novas tentativas", async () => {
  await db.exec("reset role");
  await db.query("insert into mavi_private.ai_config(url, secret) values('https://app.example.com/api/ai', $1)", [SECRET]);
  const r = await api("api_create_meeting", [key, client, meeting({ external_id: "zoom-video", video_url: "https://files.example.com/a.mp4" })]);
  assert.equal(r.meeting.video, "pending");
  const id = r.meeting.id;
  await db.exec("reset role");
  assert.ok(await one("select 1 from net.requests where body->>'action'='meeting-video-import'"));
  await as(null);
  await assert.rejects(db.query("select * from public.meeting_video_claim('errado')"), /Sem permissão/);
  let [job] = (await db.query("select * from public.meeting_video_claim($1)", [SECRET])).rows;
  assert.equal(job.recording_id, id);
  assert.equal(job.url, "https://files.example.com/a.mp4");
  assert.equal(job.attempts, 1);
  // Já pego: não sai de novo.
  assert.equal((await db.query("select * from public.meeting_video_claim($1)", [SECRET])).rows.length, 0);
  // Falha passageira: volta para a fila mais tarde.
  await db.query("select public.meeting_video_save($1,$2,null,null,null,null,'503',true)", [SECRET, id]);
  await db.exec("reset role");
  let q = await one("select status, next_at > now() later from mavi_private.meeting_video_imports where recording_id=$1", [id]);
  assert.deepEqual(q, { status: "pending", later: true });
  await db.query("update mavi_private.meeting_video_imports set next_at = now() - interval '1 minute' where recording_id=$1", [id]);
  await as(null);
  [job] = (await db.query("select * from public.meeting_video_claim($1)", [SECRET])).rows;
  assert.equal(job.attempts, 2);
  await db.query("select public.meeting_video_save($1,$2,'drive','meetings/a/b.mp4','video/mp4',1234,null,false)", [SECRET, id]);
  await db.exec("reset role");
  const rec = await one("select video_bucket, video_path, video_type, video_bytes from meeting_recordings where id=$1", [id]);
  assert.deepEqual(rec, { video_bucket: "drive", video_path: "meetings/a/b.mp4", video_type: "video/mp4", video_bytes: 1234 });
  assert.equal((await one("select status from mavi_private.meeting_video_imports where recording_id=$1", [id])).status, "done");
});

await check("vídeo: depois de 3 tentativas fica como falha", async () => {
  const r = await api("api_create_meeting", [key, client, meeting({ external_id: "zoom-falha", video_url: "https://files.example.com/b.mp4" })]);
  const id = r.meeting.id;
  for (let i = 0; i < 3; i++) {
    await db.exec("reset role");
    await db.query("update mavi_private.meeting_video_imports set next_at = now() - interval '1 minute' where recording_id=$1", [id]);
    await as(null);
    await db.query("select * from public.meeting_video_claim($1)", [SECRET]);
    await db.query("select public.meeting_video_save($1,$2,null,null,null,null,'timeout',true)", [SECRET, id]);
  }
  await db.exec("reset role");
  const q = await one("select status, attempts, error from mavi_private.meeting_video_imports where recording_id=$1", [id]);
  assert.deepEqual(q, { status: "failed", attempts: 3, error: "timeout" });
  // Parado no meio três vezes: o próximo pedido marca como falha.
  await db.query("update mavi_private.meeting_video_imports set status='working', claimed_at=now()-interval '11 minutes' where recording_id=$1", [id]);
  await as(null);
  assert.equal((await db.query("select * from public.meeting_video_claim($1)", [SECRET])).rows.length, 0);
  await db.exec("reset role");
  assert.equal((await one("select status from mavi_private.meeting_video_imports where recording_id=$1", [id])).status, "failed");
  await as(admin);
  await assert.rejects(db.query("select * from mavi_private.meeting_video_imports"), /permission denied/);
});

await check("chave revogada deixa de funcionar", async () => {
  await as(admin);
  const { id } = await one(
    "select id from public.api_keys_list($1) where name='CRM'",
    [A],
  );
  await db.query("select public.api_key_revoke($1)", [id]);
  await assert.rejects(api("api_list_products", [key]), /revogada/);
  await as(admin);
  const row = await one(
    "select revoked_at from public.api_keys_list($1) where id=$2",
    [A, id],
  );
  assert.ok(row.revoked_at);
});

console.log(`\n${passed} verificações da API pública passaram.`);

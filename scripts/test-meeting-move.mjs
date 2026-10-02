// Drive › Gravações da MAVI › Mover para outro cliente (migration
// 20270312090000_meeting_move_client): quem move (vê os dois clientes),
// cliente arquivado, a prévia com os avisos, a gravação no novo cliente, a
// MAVI na hora e reindexada, o Radar e o Termômetro refeitos no novo cliente,
// o link público que continua e o histórico do Drive.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, member, onlyOne, outsider] = [1, 10, 11, 12, 13].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, member, onlyOne, outsider],
]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,email,role,active) values
   ($1,$2,'Ana Admin','ana@make.com','admin',true),($1,$3,'Bruno Duas','bruno@make.com','member',true),
   ($1,$4,'Clara Uma','clara@make.com','member',true),($1,$5,'Davi Fora','davi@make.com','member',true)`,
  [A, admin, member, onlyOne, outsider],
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
const index = async () => {
  await as(null);
  while ((await rpc("ai_index_step", [SECRET, 100])) > 0);
};
const preview = (user, recs, client) =>
  as(user).then(() => rpc("meeting_move_preview", [A, recs, client]));
const move = (user, recs, client) =>
  as(user).then(() => rpc("move_meeting_recordings", [A, recs, client]));

await sql(`insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`, [SECRET]);
await sql(`update radar_settings set started_at = now() - interval '1 day'`);
await as(admin);
const teamOne = await rpc("create_team", [A, "Equipe 1", [member, onlyOne]]);
const teamTwo = await rpc("create_team", [A, "Equipe 2", [member]]);
const wrong = await rpc("create_client", [A, "4282", "", [teamOne]]);
const right = await rpc("create_client", [A, "9001", "", [teamTwo]]);
const gone = await rpc("create_client", [A, "7777", "", [teamTwo]]);
await rpc("set_client_archived", [gone, true]);

const [MEET, SECOND] = [uid(900), uid(901)];
const today9 = `(date_trunc('day', now() at time zone 'America/Sao_Paulo') + interval '9 hours') at time zone 'America/Sao_Paulo'`;
await sql(
  `insert into meeting_recordings(id, company_id, client_id, source_id, title, recorded_at, recorded_by_email, speakers, summary)
   values ($1,$3,$4,'m1','R2 9001',${today9},'ana@make.com','{Ana Admin,Carlos Cliente}',
    '{"title":"Alinhamento de setembro","overview":"O cliente reclamou dos leads."}'),
   ($2,$3,$4,'m2','R1 9001',${today9} - interval '1 hour','ana@make.com','{}','{}')`,
  [MEET, SECOND, A, wrong],
);
await sql(
  `insert into meeting_transcripts(recording_id, company_id, speakers, segments) values ($1,$2,
    '{Ana Admin,Carlos Cliente}', '[[0,5,0,"Bom dia."],[5,9,1,"Os leads caíram muito."]]')`,
  [MEET, A],
);
await index();
// O Radar leu a reunião no cliente errado; o Termômetro também.
await sql(`update radar_signals set dirty_at = now() - interval '1 hour' where status = 'pending'`);
await as(null);
await rpc("ai_radar_claim", [SECRET, 20]);
const [signal] = await sql(`select id from radar_signals where source_type = 'meeting' and source_id = $1`, [MEET]);
await as(null);
const material = await rpc("ai_radar_material", [SECRET, signal.id]);
const problems = material.topics.find((t) => t.key === "problemas");
await as(null);
await rpc("ai_radar_store", [SECRET, signal.id, JSON.stringify({
  items: [{
    topic_id: problems.id, title: "Leads caíram muito", severity: 2, speaker_confirmed: true,
    mentions: [{ quote: "Os leads caíram muito.", speaker: "Carlos Cliente", role: "client", at_seconds: 5 }],
  }],
})]);
await sql(`update temperature_signals set answers = '{"humor":2}', status = 'done' where source_id = $1`, [MEET]);
await as(member);
await rpc("set_meeting_share", [MEET, true, true, true, false, null, null, true]);

await check("só quem vê os dois clientes move; cliente arquivado não recebe", async () => {
  await rejects(() => preview(outsider, [MEET], right), /Sem acesso às gravações de "4282"/);
  await rejects(() => preview(onlyOne, [MEET], right), /não atende o cliente "9001"/);
  await rejects(() => preview(member, [MEET], gone), /"7777" está arquivado/);
  await rejects(() => preview(member, [MEET], wrong), /Já está nas gravações de "4282"/);
  await rejects(() => preview(member, [], right), /Escolha as gravações/);
  await rejects(() => preview(member, [uid(999)], right), /Gravação não encontrada/);
});

await check("a prévia conta o que muda e não mexe em nada", async () => {
  const p = await preview(member, [MEET, SECOND], right);
  assert.equal(p.recordings, 2);
  assert.deepEqual(p.from_clients, [wrong]);
  assert.equal(p.to.client_id, right);
  assert.equal(p.to.label, "Drive › 9001 › Gravações da MAVI");
  assert.equal(p.shared, 1);
  assert.equal(p.radar_mentions, 1);
  assert.equal(p.temperature, 1);
  const recs = await sql(`select distinct client_id from meeting_recordings`);
  assert.deepEqual(recs.map((r) => r.client_id), [wrong]);
  assert.equal((await sql(`select count(*)::int as n from drive_audit where action = 'recording_moved'`))[0].n, 0);
});

await check("move: gravação, MAVI, Radar e Termômetro vão para o novo cliente", async () => {
  await sql(`delete from realtime.messages`);
  const r = await move(member, [MEET, SECOND], right);
  assert.equal(r.recordings, 2);
  const recs = await sql(`select id, client_id from meeting_recordings order by id`);
  assert.deepEqual(recs.map((x) => x.client_id), [right, right]);
  // A MAVI do cliente antigo deixa de achar a reunião já (antes da fila).
  const docs = await sql(`select client_id from ai_documents where source_type = 'meeting'`);
  assert.ok(docs.length >= 1 && docs.every((d) => d.client_id === right));
  const chunks = await sql(
    `select distinct c.client_id from ai_chunks c join ai_documents d on d.id = c.document_id where d.source_type = 'meeting'`,
  );
  assert.deepEqual(chunks.map((c) => c.client_id), [right]);
  // Radar: o antigo perde a ocorrência (o item sem nada feito some) e a
  // reunião volta a ser lida no novo.
  assert.equal((await sql(`select count(*)::int as n from radar_mentions where source_id = $1`, [MEET]))[0].n, 0);
  assert.equal((await sql(`select count(*)::int as n from radar_items where client_id = $1`, [wrong]))[0].n, 0);
  const [rs] = await sql(`select client_id, status from radar_signals where source_type = 'meeting' and source_id = $1`, [MEET]);
  assert.deepEqual([rs.client_id, rs.status], [right, "pending"]);
  // Termômetro: a leitura recomeça no novo cliente.
  const [ts] = await sql(`select client_id, status, answers from temperature_signals where source_id = $1`, [MEET]);
  assert.deepEqual([ts.client_id, ts.status, ts.answers], [right, "pending", {}]);
  // O link público é da gravação: continua.
  assert.equal((await sql(`select count(*)::int as n from meeting_shares where recording_id = $1`, [MEET]))[0].n, 1);
  // Quem está com um dos dois clientes aberto vê a lista mudar.
  const notices = await sql(`select payload from realtime.messages where payload->>'kind' = 'meeting'`);
  assert.deepEqual(
    [...new Set(notices.map((n) => n.payload.payload?.client ?? n.payload.client))].sort(),
    [right, wrong].sort(),
  );
});

await check("o histórico do Drive guarda de onde e para onde", async () => {
  const rows = await sql(
    `select actor_id, item_name, client_id, details from drive_audit where action = 'recording_moved' order by item_name`,
  );
  assert.equal(rows.length, 2);
  const [first] = rows;
  assert.equal(first.actor_id, member);
  assert.equal(first.item_name, "Alinhamento de setembro");
  assert.equal(first.client_id, right);
  assert.equal(first.details.recording, MEET);
  assert.equal(first.details.from.client_id, wrong);
  assert.equal(first.details.from.label, "Drive › 4282 › Gravações da MAVI");
  assert.equal(first.details.to.label, "Drive › 9001 › Gravações da MAVI");
  assert.equal(rows[1].item_name, "R1 9001");
});

await check("quem via só o cliente antigo perde a gravação; a fila reescreve a MAVI", async () => {
  await as(onlyOne);
  assert.equal((await db.query(`select id from meeting_recordings`)).rows.length, 0);
  await index();
  const [doc] = await sql(`select d.client_id, c.content from ai_documents d
    join ai_chunks c on c.document_id = d.id where d.source_type = 'meeting' and d.source_id = $1 limit 1`, [MEET]);
  assert.equal(doc.client_id, right);
  assert.match(doc.content, /cliente 9001/);
});

console.log(`\n${passed} verificações ok`);

// Drive › cliente › Whatsapp (migration 20261027150000_whatsapp_groups): a
// ligação automática dos grupos pelo código do cliente, o ajuste pelo admin,
// a leitura em dia sem duplicar, a fila de mídias, o aviso ao servidor e a
// leitura pela regra do Drive (com o caminho da mídia fora do alcance).
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, manager, teamMember, outsider] = [1, 2, 10, 11, 12, 13].map(
  uid,
);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, manager, teamMember, outsider],
]);
await db.query(
  `insert into companies(id,name) values($1,'Empresa A'),($2,'Empresa B')`,
  [A, B],
);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Gil Gestor','manager',true),
   ($1,$4,'Bruno Equipe','member',true),($1,$5,'Carla Fora','member',true)`,
  [A, admin, manager, teamMember, outsider],
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
const rejects = async (fn, pattern) => {
  let error;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  assert.ok(error, "deveria falhar");
  assert.match(error.message, pattern);
};

await as(admin);
const team = await rpc("create_team", [A, "Equipe A", [teamMember]]);
const client = await rpc("create_client", [A, "2745", "", [team]]);
const other = await rpc("create_client", [A, "3108 - Loja do Lubrificante", "", []]);
const ads = await rpc("create_product", [A, "Make Ads"]);
const social = await rpc("create_product", [A, "Social Media"]);
const seo = await rpc("create_product", [A, "SEO"]);
await rpc("create_contract", [A, client, ads, "Make Ads 2745"]);
await rpc("create_contract", [A, client, social, "Social 2745"]);
await rpc("create_contract", [A, other, seo, "SEO 3108"]);

const now = Date.now();
const hour = 3600_000;
const groups = [
  { jid: "1@g.us", title: "(2745) - Facilita & Make (Make Ads)", last_message_at: now - hour },
  { jid: "2@g.us", title: "2745 - SEO/SME Facil&Make", last_message_at: now - 2 * hour },
  { jid: "3@g.us", title: "3108 - Loja do Lubrificante & Make (Social Media/SEO)", last_message_at: now },
  { jid: "4@g.us", title: "CS | CX - Relacionamento", last_message_at: now },
  { jid: "5@g.us", title: "HOJE - 19:00H - FRANQUIA", last_message_at: 0 },
];
const group = async (jid) =>
  (await sql(`select * from whatsapp_groups where jid = $1`, [jid]))[0];

await check("o código do cliente sai do título", async () => {
  const codes = await sql(
    `select mavi_private.whatsapp_code(t) as c from unnest($1::text[]) t`,
    [["(SME) 4316 - Daselis", "#232 Marcos", "(2745) - Facilita", "HOJE - 19:00H", "Squad 1", "Nº 123456 x"]],
  );
  assert.deepEqual(codes.map((r) => r.c), ["4316", "232", "2745", null, null, null]);
});

await check("sem configuração, o servidor não entra", async () => {
  await as(null);
  await rejects(() => rpc("whatsapp_worker_state", [SECRET]), /Não autorizado/);
  await sql(
    `insert into mavi_private.whatsapp_config(company_id,url,secret) values($1,'https://app.test/api/whatsapp',$2)`,
    [A, SECRET],
  );
  await as(null);
  await rejects(() => rpc("whatsapp_worker_state", ["x".repeat(40)]), /Não autorizado/);
  const state = await rpc("whatsapp_worker_state", [SECRET]);
  assert.equal(state.company, A);
  assert.equal(state.sweep_due, true);
  assert.equal(state.backfill_days, 8);
});

await check("a varredura liga os grupos pelo código e pelos produtos do título", async () => {
  await as(null);
  assert.equal(await rpc("whatsapp_sweep", [SECRET, JSON.stringify(groups), null]), 5);
  const g1 = await group("1@g.us");
  assert.equal(g1.client_id, client);
  assert.deepEqual(g1.product_ids, [ads]);
  assert.equal(g1.linked_by, "auto");
  // SEO não é contratado pelo 2745: o grupo fica com o cliente todo.
  assert.deepEqual((await group("2@g.us")).product_ids, []);
  const g3 = await group("3@g.us");
  assert.equal(g3.client_id, other);
  // Social Media não é contrato do 3108; SEO é.
  assert.deepEqual(g3.product_ids, [seo]);
  assert.equal((await group("4@g.us")).client_id, null);
  assert.equal((await group("5@g.us")).last_message_at, null);
  assert.equal((await rpc("whatsapp_worker_state", [SECRET])).sweep_due, false);
});

await check("só os grupos de cliente com mensagem nova são lidos, desde 8 dias atrás", async () => {
  await as(null);
  const claimed = await rows("whatsapp_claim_groups", [SECRET, 10]);
  assert.deepEqual(claimed.map((g) => g.jid).sort(), ["1@g.us", "2@g.us", "3@g.us"]);
  const since = new Date(claimed[0].since).getTime();
  assert.ok(Math.abs(since - (now - 8 * 24 * hour)) < 60_000);
  // Reservados: outra chamada não pega os mesmos.
  assert.equal((await rows("whatsapp_claim_groups", [SECRET, 10])).length, 0);
});

const g1 = await group("1@g.us");
const msg = (id, t, extra = {}) => ({
  wa_id: id,
  source_id: `5511986540334:${id}`,
  sent_at: new Date(t).toISOString(),
  sender: "184@lid",
  sender_phone: "5511986060266",
  sender_name: "Kamilli",
  from_me: false,
  kind: "text",
  body: `mensagem ${id}`,
  ...extra,
});

await check("as mensagens entram uma vez só e a edição atualiza o texto", async () => {
  await as(null);
  const batch = [
    msg("A1", now - 3 * hour),
    msg("A2", now - 2 * hour, { kind: "audio", body: "", media_mime: "audio/ogg", media_seconds: 23 }),
    msg("A3", now - hour, { kind: "document", body: "proposta", media_name: "Proposta.pdf", media_bytes: 1200 }),
    msg("A4", now - hour, { kind: "reaction", body: "❤️", reaction_to: "A1" }),
  ];
  assert.equal(
    await rpc("whatsapp_store_messages", [SECRET, g1.id, JSON.stringify(batch), new Date(now - hour).toISOString(), null]),
    4,
  );
  batch[0].body = "mensagem editada";
  batch[0].edited = true;
  assert.equal(
    await rpc("whatsapp_store_messages", [SECRET, g1.id, JSON.stringify(batch), new Date(now - hour).toISOString(), null]),
    0,
  );
  const saved = await sql(
    `select wa_id, body, edited, media_status from whatsapp_messages where group_id = $1 order by sent_at, wa_id`,
    [g1.id],
  );
  assert.deepEqual(
    saved.map((m) => [m.wa_id, m.media_status]),
    [["A1", "none"], ["A2", "pending"], ["A3", "pending"], ["A4", "none"]],
  );
  assert.equal(saved[0].body, "mensagem editada");
  assert.equal(saved[0].edited, true);
  const g = await group("1@g.us");
  assert.equal(g.message_count, 4);
  assert.equal(g.sync_claimed_at, null);
  assert.equal(new Date(g.synced_until).getTime(), now - hour);
});

await check("leitura incompleta não avança o ponto de leitura", async () => {
  await as(null);
  const g2 = await group("2@g.us");
  await rpc("whatsapp_store_messages", [SECRET, g2.id, JSON.stringify([msg("B1", now - 5 * hour)]), null, null]);
  const after = await group("2@g.us");
  assert.equal(after.synced_until, null);
  assert.equal(after.sync_claimed_at, null);
  const again = await rows("whatsapp_claim_groups", [SECRET, 10]);
  assert.deepEqual(again.map((g) => g.jid), ["2@g.us"]);
  // Completa, sem mensagens depois: fica em dia até a última vista pela varredura.
  await rpc("whatsapp_store_messages", [SECRET, g2.id, "[]", new Date(now - 5 * hour).toISOString(), null]);
  assert.equal(new Date((await group("2@g.us")).synced_until).getTime(), now - 2 * hour);
  // O erro fica registrado e o grupo volta para a fila.
  const g3 = await group("3@g.us");
  await rpc("whatsapp_store_messages", [SECRET, g3.id, "[]", null, "Uazapi 500"]);
  assert.equal((await group("3@g.us")).sync_error, "Uazapi 500");
});

await check("depois de lido, o grupo só volta com mensagem nova na varredura", async () => {
  await as(null);
  const g3 = await group("3@g.us");
  await rpc("whatsapp_store_messages", [SECRET, g3.id, "[]", new Date(now).toISOString(), null]);
  assert.equal((await rows("whatsapp_claim_groups", [SECRET, 10])).length, 0);
  groups[0].last_message_at = now + hour;
  await rpc("whatsapp_sweep", [SECRET, JSON.stringify(groups), null]);
  const claimed = await rows("whatsapp_claim_groups", [SECRET, 10]);
  assert.deepEqual(claimed.map((g) => g.jid), ["1@g.us"]);
  assert.equal(new Date(claimed[0].since).getTime(), now - hour);
  await rpc("whatsapp_store_messages", [SECRET, g1.id, "[]", new Date(now + hour).toISOString(), null]);
});

await check("a fila de mídias: copiar, falhar e dar como perdida", async () => {
  await as(null);
  const media = await rows("whatsapp_claim_media", [SECRET, 10]);
  assert.deepEqual(media.map((m) => m.source_id), ["5511986540334:A2", "5511986540334:A3"]);
  assert.equal(media[0].group_jid, "1@g.us");
  assert.equal((await rows("whatsapp_claim_media", [SECRET, 10])).length, 0);
  const [audio, doc] = media;
  await rpc("whatsapp_store_media", [SECRET, audio.id, "stored", "bucket", "whatsapp/a.mp3", "audio/mpeg", 5000, null]);
  await rpc("whatsapp_store_media", [SECRET, doc.id, "failed", null, null, null, null, "404"]);
  await rejects(
    () => rpc("whatsapp_store_media", [SECRET, doc.id, "pending", null, null, null, null, null]),
    /Situação inválida/,
  );
  const [a] = await sql(`select * from whatsapp_messages where id = $1`, [audio.id]);
  assert.equal(a.media_status, "stored");
  assert.equal(a.media_path, "whatsapp/a.mp3");
  assert.equal(a.media_mime, "audio/mpeg");
  // A que falhou volta para a fila; depois de 5 tentativas, é perdida.
  await sql(`update whatsapp_messages set media_claimed_at = null where id = $1`, [doc.id]);
  await as(null);
  assert.deepEqual((await rows("whatsapp_claim_media", [SECRET, 10])).map((m) => m.id), [doc.id]);
  await sql(`update whatsapp_messages set media_claimed_at = null, media_attempts = 5 where id = $1`, [doc.id]);
  await as(null);
  assert.equal((await rows("whatsapp_claim_media", [SECRET, 10])).length, 0);
  assert.equal((await sql(`select media_status from whatsapp_messages where id = $1`, [doc.id]))[0].media_status, "lost");
});

await check("o banco só acorda o servidor quando há trabalho", async () => {
  await sql(`delete from net.requests`);
  await sql(`update mavi_private.whatsapp_config set last_run_at = null`);
  // O áudio copiado acima já foi lido (a leitura das mídias é testada depois).
  await sql(`update whatsapp_messages set content_status = 'done' where content_status = 'pending'`);
  await sql(`select mavi_private.whatsapp_kick()`);
  assert.equal((await sql(`select count(*)::int as n from net.requests`))[0].n, 0);
  await sql(`update mavi_private.whatsapp_config set last_sweep_at = now() - interval '2 hours'`);
  await sql(`select mavi_private.whatsapp_kick()`);
  const [req] = await sql(`select * from net.requests`);
  assert.equal(req.url, "https://app.test/api/whatsapp");
  assert.equal(req.body.action, "whatsapp-sync");
  assert.equal(req.headers.Authorization, `Bearer ${SECRET}`);
  // Com uma chamada ainda trabalhando, não manda outra.
  await sql(`delete from net.requests`);
  await sql(`update mavi_private.whatsapp_config set last_run_at = now()`);
  await sql(`select mavi_private.whatsapp_kick()`);
  assert.equal((await sql(`select count(*)::int as n from net.requests`))[0].n, 0);
  await sql(`update mavi_private.whatsapp_config set last_sweep_at = now()`);
});

await check("leitura pela regra do Drive, sem o caminho da mídia", async () => {
  await as(teamMember);
  const seen = await db.query(`select jid from whatsapp_groups order by jid`);
  assert.deepEqual(seen.rows.map((r) => r.jid), ["1@g.us", "2@g.us"]);
  const msgs = await db.query(`select wa_id from whatsapp_messages order by wa_id`);
  assert.deepEqual(msgs.rows.map((r) => r.wa_id), ["A1", "A2", "A3", "A4", "B1"]);
  await rejects(() => db.query(`select media_path from whatsapp_messages`), /permission denied/);
  const hit = await db.query(
    `select wa_id from whatsapp_messages where search @@ websearch_to_tsquery('portuguese', 'proposta')`,
  );
  assert.deepEqual(hit.rows.map((r) => r.wa_id), ["A3"]);
  await as(outsider);
  assert.equal((await db.query(`select 1 from whatsapp_groups`)).rows.length, 0);
  assert.equal((await db.query(`select 1 from whatsapp_messages`)).rows.length, 0);
  await rejects(() => db.query(`select * from whatsapp_messages`), /permission denied/);
  // Gestores veem a lista inteira (tela de ajuste), inclusive os sem cliente.
  await as(manager);
  assert.equal((await db.query(`select 1 from whatsapp_groups`)).rows.length, 5);
  const status = await rpc("whatsapp_status", [A]);
  assert.equal(status.configured, true);
  assert.equal(status.messages, 5);
  assert.equal(status.media_lost, 1);
  await as(teamMember);
  await rejects(() => rpc("whatsapp_status", [A]), /Apenas administradores e gestores/);
});

await check("o admin liga, ignora e devolve o grupo ao automático", async () => {
  const g4 = await group("4@g.us");
  await as(manager);
  await rejects(() => rpc("whatsapp_set_group", [A, g4.id, client, [], false, false]), /Apenas administradores/);
  await as(admin);
  await rpc("whatsapp_set_group", [A, g4.id, client, [social], false, false]);
  let g = await group("4@g.us");
  assert.equal(g.client_id, client);
  assert.equal(g.linked_by, "manual");
  assert.deepEqual(g.product_ids, [social]);
  // A varredura não desfaz o ajuste manual, e o grupo passa a ser lido.
  await as(null);
  await rpc("whatsapp_sweep", [SECRET, JSON.stringify(groups), null]);
  assert.equal((await group("4@g.us")).client_id, client);
  assert.ok((await rows("whatsapp_claim_groups", [SECRET, 10])).some((x) => x.jid === "4@g.us"));
  // Ignorado: some da regra do Drive e não é mais lido.
  await as(admin);
  await rpc("whatsapp_set_group", [A, g1.id, client, [], true, false]);
  await as(teamMember);
  assert.ok(!(await db.query(`select jid from whatsapp_groups`)).rows.some((r) => r.jid === "1@g.us"));
  assert.equal((await db.query(`select 1 from whatsapp_messages where wa_id like 'A%'`)).rows.length, 0);
  await as(null);
  assert.equal(await rpc("whatsapp_store_messages", [SECRET, g1.id, JSON.stringify([msg("A9", now)]), null, null]), 0);
  // De volta ao automático: o título decide de novo.
  await as(admin);
  await rpc("whatsapp_set_group", [A, g1.id, null, [], false, true]);
  g = await group("1@g.us");
  assert.equal(g.linked_by, "auto");
  assert.equal(g.ignored, false);
  assert.equal(g.client_id, client);
  await rejects(() => rpc("whatsapp_set_group", [A, g1.id, uid(99), [], false, false]), /Cliente não encontrado/);
  await rejects(() => rpc("whatsapp_set_group", [A, g1.id, client, [uid(98)], false, false]), /Produto não encontrado/);
});

await check("mídias: só as copiadas, só para quem vê, e abrir entra no histórico", async () => {
  const stored = (await sql(`select id from whatsapp_messages where media_status = 'stored'`))[0].id;
  const lost = (await sql(`select id from whatsapp_messages where media_status = 'lost'`))[0].id;
  await as(teamMember);
  const seen = await rows("whatsapp_media_targets", [[stored, lost], false, null]);
  assert.deepEqual(seen.map((r) => [r.id, r.path, r.kind]), [[stored, "whatsapp/a.mp3", "audio"]]);
  assert.equal((await sql(`select count(*)::int as n from drive_audit where action = 'whatsapp_media_opened'`))[0].n, 0);
  await as(teamMember);
  await rows("whatsapp_media_targets", [[stored], true, JSON.stringify({ ip: "1.2.3.4" })]);
  const [log] = await sql(`select * from drive_audit where action = 'whatsapp_media_opened'`);
  assert.equal(log.actor_id, teamMember);
  assert.equal(log.client_id, client);
  assert.match(log.item_name, /^Áudio · /);
  assert.equal(log.details.message, stored);
  await as(outsider);
  assert.equal((await rows("whatsapp_media_targets", [[stored], true, null])).length, 0);
  assert.equal((await sql(`select count(*)::int as n from drive_audit where action = 'whatsapp_media_opened'`))[0].n, 1);
  await as(teamMember);
  await rejects(
    () => rows("whatsapp_media_targets", [Array.from({ length: 101 }, (_, i) => uid(1000 + i)), false, null]),
    /No máximo 100/,
  );
  await as(null);
  await rejects(() => rows("whatsapp_media_targets", [[stored], false, null]), /permission denied/);
});

// ------------------------------------------------------------ etapa 3: MAVI
const g2 = await group("2@g.us");
// Dois dias atrás: a Uazapi só guarda as mídias por 7 dias, então uma data
// fixa deixaria de ser copiada (e lida) com o tempo. 13h UTC = 10h em Brasília.
const ymd = new Date(now - 48 * hour).toISOString().slice(0, 10);
const dmy = ymd.split("-").reverse().join("/");
const day = (h) => `${ymd}T${String(h).padStart(2, "0")}:00:00.000Z`;
await check("áudios e documentos legíveis entram na fila de leitura", async () => {
  await as(null);
  const batch = [
    msg("C1", Date.parse(day(13)), { body: "Bom dia! *Relatório* da semana" }),
    msg("C2", Date.parse(day(13)) + 60_000, { kind: "audio", body: "", media_mime: "audio/ogg", media_seconds: 23 }),
    msg("C3", Date.parse(day(13)) + 120_000, { kind: "document", body: "segue", media_name: "Proposta.pdf", media_mime: "application/pdf", media_bytes: 900 }),
    msg("C4", Date.parse(day(13)) + 180_000, { kind: "document", body: "", media_name: "fotos.zip", media_mime: "application/zip", media_bytes: 900 }),
    msg("C5", Date.parse(day(13)) + 240_000, { kind: "image", body: "arte nova", media_mime: "image/jpeg" }),
    msg("C6", Date.parse(day(13)) + 300_000, { quoted_wa_id: "C1", body: "Ótimo, obrigado" }),
    // Mais de 45 min depois: outro trecho.
    msg("C7", Date.parse(day(15)), { sender_name: "Rauzer", body: "Voltando ao assunto do orçamento" }),
    msg("C8", Date.parse(day(15)) + 60_000, { kind: "reaction", body: "👍", reaction_to: "C7" }),
  ];
  await rpc("whatsapp_store_messages", [SECRET, g2.id, JSON.stringify(batch), null, null]);
  const media = await rows("whatsapp_claim_media", [SECRET, 10]);
  for (const m of media)
    await rpc("whatsapp_store_media", [SECRET, m.id, "stored", "bucket", `whatsapp/${m.source_id}`, m.media_mime, 900, null]);
  const status = Object.fromEntries(
    (await sql(`select wa_id, content_status from whatsapp_messages where wa_id like 'C%'`)).map((r) => [r.wa_id, r.content_status]),
  );
  assert.deepEqual(
    [status.C1, status.C2, status.C3, status.C4, status.C5],
    ["none", "pending", "pending", "skipped", "none"],
  );
  assert.equal((await rpc("whatsapp_status", [A]).catch(() => null)), null); // anon não vê o status
});

await check("o worker lê a mídia e guarda o texto; erro volta para a fila", async () => {
  await as(null);
  const claimed = await rows("whatsapp_claim_content", [SECRET, 10]);
  assert.deepEqual(claimed.map((c) => [c.kind, c.content_kind]).sort(), [["audio", "audio"], ["document", "pdf"]]);
  assert.equal(claimed[0].client_id, client);
  assert.equal((await rows("whatsapp_claim_content", [SECRET, 10])).length, 0);
  const audio = claimed.find((c) => c.kind === "audio");
  const doc = claimed.find((c) => c.kind === "document");
  await rpc("whatsapp_store_content", [SECRET, audio.id, "done", "Precisamos aumentar a verba em outubro", null]);
  await rpc("whatsapp_store_content", [SECRET, doc.id, "error", null, "timeout"]);
  await sql(`update whatsapp_messages set content_claimed_at = null where id = $1`, [doc.id]);
  await as(null);
  assert.deepEqual((await rows("whatsapp_claim_content", [SECRET, 10])).map((c) => c.id), [doc.id]);
  await rpc("whatsapp_store_content", [SECRET, doc.id, "done", "Proposta comercial: painel de LED por R$ 13.600", null]);
  await rejects(() => rpc("whatsapp_store_content", [SECRET, doc.id, "pending", null, null]), /Situação inválida/);
  await rpc("whatsapp_log_usage", [SECRET, "gpt-4o-mini-transcribe", JSON.stringify([{ client, cost: 0.0012 }])]);
  const [usage] = await sql(`select * from ai_usage where module = 'whatsapp'`);
  assert.equal(usage.client_id, client);
  assert.equal(Number(usage.cost_usd), 0.0012);
});

await check("cada dia do grupo vira um documento da MAVI com trechos de conversa", async () => {
  await sql(`insert into mavi_private.ai_config(url, secret) values('https://app.test/api/ai', $1)`, [SECRET]);
  await as(null);
  while ((await rpc("ai_index_step", [SECRET, 100])) > 0);
  const [d] = await sql(
    `select d.* from ai_documents d join mavi_private.whatsapp_ai_days w on w.id = d.source_id
     where d.source_type = 'whatsapp' and w.group_id = $1 and w.day = $2`,
    [g2.id, ymd],
  );
  assert.equal(d.client_id, client);
  assert.equal(d.access, "client");
  assert.equal(d.title, `Whatsapp · 2745 - SEO/SME Facil&Make · ${dmy}`);
  const chunks = await sql(`select content, meta from ai_chunks where document_id = $1 order by ord`, [d.id]);
  const text = chunks.map((c) => c.content).join("\n---\n");
  assert.equal(chunks.length, 3, text);
  assert.ok(
    chunks[0].content.startsWith(`[Whatsapp] grupo "2745 - SEO/SME Facil&Make" · cliente 2745 · ${dmy}\n10:00 Kamilli: Bom dia! *Relatório* da semana`),
    chunks[0].content,
  );
  assert.match(text, /10:01 Kamilli: \[áudio 00:23\] Precisamos aumentar a verba em outubro/);
  assert.match(text, /10:02 Kamilli: \[documento "Proposta.pdf"\] segue/);
  assert.match(text, /10:04 Kamilli: \[imagem\] arte nova/);
  assert.match(text, /10:05 Kamilli: \(respondendo a "Bom dia! \*Relatório\* da semana \(Kamilli\)"\) Ótimo, obrigado/);
  assert.doesNotMatch(text, /👍/);
  // A pausa de 2 h abre outro trecho; o texto do documento vem por último.
  assert.match(chunks[1].content, /\n12:00 Rauzer: Voltando ao assunto do orçamento$/);
  assert.match(chunks[2].content, /Documento "Proposta.pdf" enviado por Kamilli às 10:02:\nProposta comercial: painel de LED/);
  const first = (await sql(`select id from whatsapp_messages where wa_id = 'C1'`))[0].id;
  assert.equal(chunks[0].meta.message, first);
  assert.equal(chunks[0].meta.group, g2.id);
  assert.equal(chunks[2].meta.kind, "whatsapp_document");
});

await check("a busca da MAVI acha a conversa só para quem vê o cliente", async () => {
  const search = async (who, q) => {
    await as(who);
    return (await db.query(`select * from public.ai_search($1, null, $2, '{}'::jsonb, 10)`, [A, q])).rows;
  };
  const hits = await search(teamMember, "verba outubro");
  assert.ok(hits.some((h) => h.source_type === "whatsapp" && /aumentar a verba/.test(h.content)));
  assert.equal((await search(outsider, "verba outubro")).filter((h) => h.source_type === "whatsapp").length, 0);
  // Ignorar o grupo tira os dias dele da busca.
  await as(admin);
  await rpc("whatsapp_set_group", [A, g2.id, client, [], true, false]);
  await as(null);
  while ((await rpc("ai_index_step", [SECRET, 100])) > 0);
  assert.equal((await search(teamMember, "verba outubro")).filter((h) => h.source_type === "whatsapp").length, 0);
  await as(admin);
  await rpc("whatsapp_set_group", [A, g2.id, client, [], false, false]);
  await as(null);
  while ((await rpc("ai_index_step", [SECRET, 100])) > 0);
  assert.ok((await search(teamMember, "verba outubro")).some((h) => h.source_type === "whatsapp"));
});

await check("texto editado refaz só o dia dele", async () => {
  await sql(`delete from mavi_private.ai_queue`);
  await sql(`update whatsapp_messages set body = 'Bom dia! Relatório corrigido', edited = true where wa_id = 'C1'`);
  const queued = await sql(`select q.source_id, w.day::text as day from mavi_private.ai_queue q
    join mavi_private.whatsapp_ai_days w on w.id = q.source_id where q.source_type = 'whatsapp'`);
  assert.deepEqual(queued.map((q) => q.day), [ymd]);
  // Reservar a mídia (só o horário de reserva muda) não refaz nada.
  await sql(`delete from mavi_private.ai_queue`);
  await sql(`update whatsapp_messages set media_claimed_at = now() where wa_id = 'C2'`);
  assert.equal((await sql(`select count(*)::int as n from mavi_private.ai_queue`))[0].n, 0);
});

await check("o banco acorda o servidor para ler mídias", async () => {
  await sql(`delete from net.requests`);
  await sql(`update mavi_private.whatsapp_config set last_run_at = null, last_sweep_at = now()`);
  await sql(`update whatsapp_messages set media_status = 'lost' where media_status in ('pending', 'failed')`);
  await sql(`update whatsapp_groups set synced_until = greatest(synced_until, last_message_at, now()), sync_claimed_at = null`);
  await sql(`select mavi_private.whatsapp_kick()`);
  assert.equal((await sql(`select count(*)::int as n from net.requests`))[0].n, 0);
  await sql(`update whatsapp_messages set content_status = 'pending', content_attempts = 0, content_claimed_at = null where wa_id = 'C2'`);
  await sql(`select mavi_private.whatsapp_kick()`);
  assert.equal((await sql(`select count(*)::int as n from net.requests`))[0].n, 1);
});

await check("outra empresa não mexe nos grupos", async () => {
  await sql(
    `insert into memberships(company_id,user_id,name,role,active) values($1,$2,'Ana Admin','admin',true)`,
    [B, outsider],
  );
  await as(outsider);
  await rejects(() => rpc("whatsapp_set_group", [B, g1.id, null, [], true, false]), /Grupo não encontrado/);
});

console.log(`\n${passed} verificações passaram.`);

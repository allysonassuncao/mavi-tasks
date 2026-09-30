// Radar do cliente (migration 20261229090000_client_radar): os tópicos
// iniciais, o Jev da conferência, as leituras que nascem das reuniões e dos
// dias de grupo (só a partir de quando o Radar ligou), o material com quem é
// time e quem é cliente, o WhatsApp lido só nas mensagens novas, os itens com
// ocorrências (e reabertos quando voltam), a reunião lida de novo, os filtros
// do módulo, a aba do cliente pela regra do Drive, a edição por líderes e a
// configuração dos tópicos. Fase 2 (migration 20261230090000): os temas
// por tópico e produto, a tarefa ligada ao item e a fonte nos Dashboards.
// Fase 3 (migration 20261231090000): o relatório da MAVI, pedido e agendado.
// Fase 4 (migration 20270101090000): os avisos por regra pessoal e o histórico.
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
  `insert into memberships(company_id,user_id,name,email,role,active) values
   ($1,$2,'Ana Admin','ana@make.com','admin',true),($1,$3,'Bruno Equipe','bruno@make.com','member',true),
   ($1,$4,'Carla Fora','carla@make.com','member',true),($1,$5,'Gabi Gestora','gabi@make.com','manager',true)`,
  [A, admin, member, outsider, manager],
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
const due = () =>
  sql(`update radar_signals set dirty_at = now() - interval '1 hour' where status = 'pending'`);
/** Reserva e busca o material de cada uma (como o worker). */
const claim = async () => {
  await due();
  await as(null);
  const list = await rpc("ai_radar_claim", [SECRET, 20]);
  const out = [];
  for (const c of list) {
    await as(null);
    const m = await rpc("ai_radar_material", [SECRET, c.id]);
    if (m) out.push(m);
  }
  return out;
};
const store = async (id, result) => {
  await as(null);
  return rpc("ai_radar_store", [SECRET, id, JSON.stringify(result)]);
};
const today9 = `(date_trunc('day', now() at time zone 'America/Sao_Paulo') + interval '9 hours') at time zone 'America/Sao_Paulo'`;

await sql(`insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`, [SECRET]);
await as(admin);
const team = await rpc("create_team", [A, "Equipe A", [member], [manager]]);
const client = await rpc("create_client", [A, "4282", "", [team]]);
const other = await rpc("create_client", [A, "9001", "", []]);
const trafego = await rpc("create_product", [A, "Tráfego"]);
const social = await rpc("create_product", [A, "Social"]);
await rpc("create_contract", [A, client, trafego, "Tráfego · 4282", team]);
await rpc("create_contract", [A, client, social, "Social · 4282", team]);
await rpc("create_contract", [A, other, social, "Social · 9001", null]);
const OPENROUTER = uid(800);
await sql(
  `insert into mavi_private.ai_providers(id, company_id, name, kind, base_url, key_cipher, key_hint, models) values
   ($1,$2,'OpenRouter','openrouter','https://openrouter.ai/api/v1','v1:cifra','9xYz',
    '[{"id":"~typesafe/jev-latest","label":"Jev","input":0.042,"output":0},{"id":"openai/gpt-5.6","label":"GPT"}]')`,
  [OPENROUTER, A],
);
// O Radar ligou ontem (o que é de antes fica para o histórico).
await sql(`update radar_settings set started_at = now() - interval '1 day'`);

let topics;
await check("a empresa nasce com Problemas e Promessas; só líderes configuram", async () => {
  await as(manager);
  const cfg = await rpc("radar_settings", [A]);
  topics = Object.fromEntries(cfg.topics.map((t) => [t.key, t]));
  assert.deepEqual(cfg.topics.map((t) => [t.key, t.speaker, t.has_due]), [
    ["problemas", "client", false],
    ["promessas", "team", true],
  ]);
  assert.equal(topics.problemas.statuses[0].key, "aberto");
  assert.equal(topics.problemas.statuses.find((s) => s.key === "resolvido").reopen, true);
  assert.equal(topics.promessas.severity_label, "Importância");
  assert.equal(topics.problemas.severity_levels.length, 4);
  assert.deepEqual(cfg.jev, { provider: "OpenRouter", model: "~typesafe/jev-latest" });
  assert.equal(cfg.model, null);
  await as(member);
  await rejects(() => rpc("radar_settings", [A]), /Sem permissão/);
  await as(member);
  await rejects(() => rpc("radar_overview", [A]), /Sem permissão/);
});

await check("a conferência do Radar aceita só o Jev; a leitura, só modelos de conversa", async () => {
  await as(admin);
  await rejects(
    () => rpc("ai_set_route", [A, "feature", null, OPENROUTER, "openai/gpt-5.6", "client_radar_check"]),
    /usa o Jev/,
  );
  await as(admin);
  await rejects(
    () => rpc("ai_set_route", [A, "feature", null, OPENROUTER, "~typesafe/jev-latest", "client_radar"]),
    /só responde a perguntas de decisão/,
  );
  await as(manager);
  await rpc("ai_set_route", [A, "feature", null, OPENROUTER, "openai/gpt-5.6", "client_radar"]);
  await rpc("ai_set_route", [A, "feature", null, OPENROUTER, "~typesafe/jev-latest", "client_radar_check"]);
  await as(null);
  assert.equal((await rpc("ai_worker_route", [SECRET, A, "client_radar"])).model, "openai/gpt-5.6");
  const c = await rpc("ai_radar_config", [SECRET, A]);
  assert.equal(c.jev.model, "~typesafe/jev-latest");
  assert.equal(c.jev.key_cipher, "v1:cifra");
  await rejects(() => rpc("ai_radar_config", ["x".repeat(40), A]), /Sem permissão/);
  // Sem a regra da conferência, vale o Jev do termômetro.
  await as(admin);
  await rpc("ai_set_route", [A, "feature", null, null, null, "client_radar_check"]);
  await as(null);
  assert.equal((await rpc("ai_radar_config", [SECRET, A])).jev.model, "~typesafe/jev-latest");
  // O termômetro continua só com o Jev.
  await as(admin);
  await rejects(
    () => rpc("ai_set_route", [A, "feature", null, OPENROUTER, "openai/gpt-5.6", "client_temperature"]),
    /usa o Jev/,
  );
});

const MEET1 = uid(900);
const GROUP = uid(901);
let meeting;
let wa;
await check("reuniões e dias de grupo viram leituras (o de antes do Radar, não)", async () => {
  await as(member);
  await rpc("set_member_phones", [A, member, ["(11) 98765-4321"]]);
  await sql(
    `insert into meeting_recordings(id, company_id, client_id, source_id, title, recorded_at, recorded_by_email, speakers,
      summary)
     values ($1,$2,$3,'m1','Alinhamento',${today9},'gabi@make.com','{Bruno Equipe,Carlos Cliente}',
      '{"title":"Alinhamento de setembro","overview":"O cliente reclamou dos leads."}')`,
    [MEET1, A, client],
  );
  await sql(
    `insert into meeting_transcripts(recording_id, company_id, speakers, segments) values ($1,$2,
      '{Bruno Equipe,Carlos Cliente}',
      '[[0,5,0,"Bom dia, vamos ver os números."],[5,9,1,"Os leads caíram muito,"],[9,12,1,"estou preocupado."],
        [65,70,0,"Até sexta te mando o relatório novo."],[70,72,2,"Oi"]]')`,
    [MEET1, A],
  );
  await sql(
    `insert into whatsapp_groups(id, company_id, jid, title, client_id, product_ids) values ($1,$2,'1@g.us','4282 - Tráfego',$3,$4)`,
    [GROUP, A, client, [trafego]],
  );
  await sql(
    `insert into whatsapp_messages(company_id, group_id, wa_id, sent_at, sender, sender_phone, sender_name, from_me,
      kind, body) values
     ($1,$2,'W1',${today9},'a','5511986540334','Make',true,'text','Bom dia! Segue o relatório.'),
     ($1,$2,'W2',${today9} + interval '1 minute','c','5511911112222','Carlos',false,'text','A arte saiu com o logo errado de novo.'),
     ($1,$2,'W3',${today9} + interval '2 minutes','b','551187654321','Bruno',false,'text','Vou corrigir hoje à tarde.'),
     ($1,$2,'W4',${today9} + interval '3 minutes','c','5511911112222','Carlos',false,'reaction','👍'),
     ($1,$2,'W9',${today9} - interval '3 days','c','5511911112222','Carlos',false,'text','Mensagem antiga')`,
    [A, GROUP],
  );
  await index();
  const signals = await sql(`select source_type, day, status from radar_signals order by source_type`);
  assert.deepEqual(signals.map((s) => [s.source_type, s.status]), [["meeting", "pending"], ["whatsapp", "pending"]]);
  // Paradas há pouco não saem (a busca do WhatsApp pode estar no meio).
  await as(null);
  assert.deepEqual(await rpc("ai_radar_claim", [SECRET, 10]), []);
  const got = await claim();
  meeting = got.find((m) => m.source_type === "meeting");
  wa = got.find((m) => m.source_type === "whatsapp");
  assert.equal(meeting.client_name, "4282");
  assert.equal(meeting.title, "Alinhamento de setembro");
  assert.match(meeting.summary, /reclamou dos leads/);
  // Falas seguidas da mesma pessoa numa linha, com o segundo da primeira.
  assert.deepEqual(meeting.lines.map((l) => [l.role, l.who, l.t]), [
    ["team", "Bruno Equipe", 0],
    ["client", "Carlos Cliente", 5],
    ["team", "Bruno Equipe", 65],
    ["unknown", "Falante 3", 70],
  ]);
  assert.equal(meeting.lines[1].text, "Os leads caíram muito, estou preocupado.");
  assert.deepEqual(meeting.topics.map((t) => t.key), ["problemas", "promessas"]);
  assert.deepEqual(meeting.topics[0].products.sort(), [social, trafego].sort());
  assert.deepEqual(meeting.products.map((p) => p.name), ["Social", "Tráfego"]);
  assert.deepEqual(meeting.items, []);
  // WhatsApp: sem reação, com quem é time pelo telefone (sem o nono dígito).
  assert.deepEqual(wa.lines.map((l) => [l.role, l.who, l.at]), [
    ["team", "Make", "09:00"],
    ["client", "Carlos", "09:01"],
    ["team", "Bruno", "09:02"],
  ]);
  assert.equal(wa.seen.length, 3);
  assert.deepEqual(wa.group_products, [trafego]);
  assert.deepEqual(wa.context, []);
  assert.deepEqual(await claim(), [], "reservadas não saem de novo");
});

let problem;
let promise;
await check("os itens entram com as ocorrências, o produto e o custo", async () => {
  const n = await store(meeting.id, {
    items: [
      {
        topic_id: topics.problemas.id, title: "Leads caíram muito", summary: "O cliente está preocupado com os leads.",
        product_id: trafego, severity: 2, speaker_confirmed: true,
        mentions: [{ quote: "Os leads caíram muito", speaker: "Carlos Cliente", role: "client", at_seconds: 5 }],
      },
      {
        topic_id: topics.promessas.id, title: "Enviar o relatório novo", product_id: uid(999), due_date: "2026-10-02",
        severity: 1, fields: { lixo: "x" },
        mentions: [{ quote: "Até sexta te mando o relatório novo.", speaker: "Bruno Equipe", role: "team", at_seconds: 65 }],
      },
      { topic_id: uid(998), title: "Tópico que não existe", mentions: [{ quote: "x" }] },
      { topic_id: topics.problemas.id, title: "Sem fala", mentions: [] },
    ],
    usage: [
      { kind: "radar", model: "openai/gpt-5.6", input: 9000, output: 400, cost: 0.02, provider_id: OPENROUTER, provider: "OpenRouter" },
      { kind: "radar_check", model: "~typesafe/jev-latest", input: 1200, output: 0, cost: 0.0001 },
    ],
  });
  assert.equal(n, 2);
  const items = await sql(`select * from radar_items order by title`);
  promise = items.find((i) => i.title === "Enviar o relatório novo");
  problem = items.find((i) => i.title === "Leads caíram muito");
  assert.equal(problem.status, "aberto");
  assert.equal(problem.product_id, trafego);
  assert.equal(problem.severity, 2);
  assert.equal(problem.mentions, 1);
  assert.equal(promise.status, "pendente");
  assert.equal(promise.product_id, null, "produto que o cliente não contrata vira Geral");
  assert.equal(promise.due_date.toISOString().slice(0, 10), "2026-10-02");
  assert.deepEqual(promise.fields, {});
  const [m] = await sql(`select * from radar_mentions where item_id = $1`, [promise.id]);
  assert.equal(m.at_seconds, 65);
  assert.equal(m.role, "team");
  const [rec] = await sql(`select recorded_at from meeting_recordings where id = $1`, [MEET1]);
  assert.equal(m.occurred_at.getTime(), rec.recorded_at.getTime() + 65000);
  const usage = await sql(`select kind, module, client_id, cost_usd from ai_usage where module = 'radar' order by kind`);
  assert.deepEqual(usage.map((u) => [u.kind, u.client_id === client, Number(u.cost_usd)]), [
    ["radar", true, 0.02], ["radar_check", true, 0.0001],
  ]);
  const [s] = await sql(`select status, items, cost_usd from radar_signals where id = $1`, [meeting.id]);
  assert.deepEqual([s.status, s.items, Number(s.cost_usd)], ["done", 2, 0.0201]);
});

let artItem;
await check("o WhatsApp é lido só nas mensagens novas; o resto do dia vira contexto", async () => {
  await store(wa.id, {
    items: [{
      topic_id: topics.problemas.id, title: "Logo errado na arte", severity: 1, product_id: trafego,
      mentions: [{ quote: "A arte saiu com o logo errado de novo.", speaker: "Carlos", role: "client",
        message_id: wa.lines[1].msg }],
    }],
    seen: wa.seen,
  });
  artItem = (await sql(`select * from radar_items where title = 'Logo errado na arte'`))[0];
  const [m] = await sql(`select message_id, occurred_at from radar_mentions where item_id = $1`, [artItem.id]);
  assert.equal(m.message_id, wa.lines[1].msg);
  // Nova busca: uma mensagem nova do cliente e um áudio esperando a transcrição.
  await sql(
    `insert into whatsapp_messages(company_id, group_id, wa_id, sent_at, sender, sender_phone, sender_name, from_me,
      kind, body, content_status) values
     ($1,$2,'W5',${today9} + interval '2 hours','c','5511911112222','Carlos',false,'text','E o logo continua errado!', 'none'),
     ($1,$2,'W6',${today9} + interval '2 hours 1 minute','c','5511911112222','Carlos',false,'audio','', 'pending')`,
    [A, GROUP],
  );
  await sql(`update whatsapp_messages set sent_at = now() - interval '5 minutes' where wa_id = 'W6'`);
  await index();
  const [again] = await claim();
  assert.equal(again.source_type, "whatsapp");
  assert.deepEqual(again.lines.map((l) => l.text), ["E o logo continua errado!"]);
  assert.equal(again.context.length, 3);
  assert.equal(again.context[1].text, "A arte saiu com o logo errado de novo.");
  assert.deepEqual(again.items.map((i) => [i.title, i.closed]).sort(), [
    ["Enviar o relatório novo", false], ["Leads caíram muito", false], ["Logo errado na arte", false],
  ]);
  // A MAVI junta a fala ao item que já existe.
  await store(again.id, {
    items: [{
      topic_id: topics.problemas.id, item_id: artItem.id, title: "Logo errado na arte", severity: 3,
      summary: "Reclamou duas vezes do logo.",
      mentions: [{ quote: "E o logo continua errado!", role: "client", speaker: "Carlos", message_id: again.lines[0].msg }],
    }],
    seen: again.seen,
  });
  const [it] = await sql(`select * from radar_items where id = $1`, [artItem.id]);
  assert.equal(it.mentions, 2);
  assert.equal(it.severity, 3, "a gravidade sobe, não desce");
  assert.equal(it.summary, "Reclamou duas vezes do logo.");
  // Nada novo (o áudio ainda espera): a leitura termina sem ir ao modelo.
  await sql(`update radar_signals set status = 'pending', dirty_at = now() - interval '1 hour' where id = $1`, [again.id]);
  assert.deepEqual(await claim(), []);
  assert.equal((await sql(`select status from radar_signals where id = $1`, [again.id]))[0].status, "done");
  // O áudio transcrito entra na próxima.
  await sql(`update whatsapp_messages set content_status = 'done', content_text = 'Preciso disso resolvido hoje' where wa_id = 'W6'`);
  await index();
  const [third] = await claim();
  assert.equal(third.lines.length, 1);
  assert.match(third.lines[0].text, /^\[áudio.*\] Preciso disso resolvido hoje$/);
  await store(third.id, { items: [], seen: third.seen });
});

await check("resolvido que volta a aparecer reabre; descartado não", async () => {
  await as(manager);
  let item = await rpc("update_radar_item", [A, artItem.id, JSON.stringify({ status: "resolvido", assignee_id: member })]);
  assert.equal(item.status, "resolvido");
  assert.equal(item.assignee_name, "Bruno Equipe");
  const [g] = await sql(`select id from radar_signals where source_type = 'whatsapp'`);
  await sql(`update radar_signals set dirty_at = now() - interval '1 hour', claimed_at = now() where id = $1`, [g.id]);
  await store(g.id, {
    items: [{ topic_id: topics.problemas.id, item_id: artItem.id, title: "x", mentions: [{ quote: "logo de novo", role: "client" }] }],
  });
  const [it] = await sql(`select status, reopened_at, status_by, assignee_id from radar_items where id = $1`, [artItem.id]);
  assert.equal(it.status, "aberto");
  assert.ok(it.reopened_at);
  assert.equal(it.status_by, null);
  assert.equal(it.assignee_id, member, "o responsável continua");
  await as(manager);
  await rpc("update_radar_item", [A, artItem.id, JSON.stringify({ status: "descartado" })]);
  await store(g.id, {
    items: [{ topic_id: topics.problemas.id, item_id: artItem.id, title: "x", mentions: [{ quote: "logo outra vez", role: "client" }] }],
  });
  assert.equal((await sql(`select status from radar_items where id = $1`, [artItem.id]))[0].status, "descartado");
});

await check("a reunião lida de novo troca as ocorrências dela; o item que sobra sem fala sai", async () => {
  await sql(`update meeting_recordings set summary = summary || '{"overview":"Nova versão."}' where id = $1`, [MEET1]);
  await index();
  const [m] = await claim();
  assert.equal(m.source_type, "meeting");
  assert.equal(m.items.length, 3);
  await store(m.id, {
    items: [{
      topic_id: topics.problemas.id, item_id: problem.id, title: "Leads caíram muito",
      mentions: [{ quote: "Os leads caíram muito", role: "client", speaker: "Carlos Cliente", at_seconds: 5 }],
    }],
  });
  assert.equal((await sql(`select mentions from radar_items where id = $1`, [problem.id]))[0].mentions, 1);
  assert.equal((await sql(`select count(*)::int as n from radar_items where id = $1`, [promise.id]))[0].n, 0);
  // Mudou durante a leitura: não grava e lê de novo.
  await sql(`update radar_signals set status = 'pending', dirty_at = now() + interval '1 minute', claimed_at = now()
    where id = $1`, [m.id]);
  assert.equal(await store(m.id, { items: [] }), 0);
  assert.equal((await sql(`select mentions from radar_items where id = $1`, [problem.id]))[0].mentions, 1);
  await sql(`update radar_signals set status = 'done' where id = $1`, [m.id]);
});

await check("o módulo filtra no banco; só líderes veem e editam", async () => {
  await as(manager);
  const ov = await rpc("radar_overview", [A]);
  const p = ov.topics.find((t) => t.key === "problemas");
  assert.deepEqual([p.open, p.total, p.severe, p.new_7d], [1, 2, 1, 2]);
  assert.equal(ov.topics.find((t) => t.key === "promessas").overdue, 0);
  const list = (f) => rpc("radar_items", [A, JSON.stringify(f)]);
  let r = await list({ topic: topics.problemas.id });
  assert.equal(r.total, 2);
  assert.deepEqual(r.items.map((i) => i.title), ["Leads caíram muito", "Logo errado na arte"], "fechados por último");
  assert.equal(r.items[0].client_name, "4282");
  assert.equal(r.items[0].product_name, "Tráfego");
  r = await list({ topic: topics.problemas.id, statuses: ["descartado"] });
  assert.deepEqual(r.items.map((i) => i.title), ["Logo errado na arte"]);
  r = await list({ q: "logo" });
  assert.equal(r.total, 1);
  r = await list({ q: "4282" });
  assert.equal(r.total, 2);
  r = await list({ product: "none" });
  assert.equal(r.total, 0);
  r = await list({ severity: 3 });
  assert.deepEqual(r.items.map((i) => i.title), ["Logo errado na arte"]);
  r = await list({ assignee: member });
  assert.equal(r.total, 1);
  r = await list({ team: team, sort: "mentions", limit: 1 });
  assert.equal(r.total, 2);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].title, "Logo errado na arte");
  r = await list({ client: other });
  assert.deepEqual(r, { total: 0, items: [] });
  await as(member);
  await rejects(() => rpc("radar_items", [A, "{}"]), /Sem permissão/);
  await as(member);
  await rejects(() => rpc("update_radar_item", [A, problem.id, JSON.stringify({ status: "resolvido" })]), /Sem permissão/);
  await as(outsider);
  await rejects(() => db.query(`select * from radar_items`), /permission denied/);
});

await check("a aba do cliente segue a regra do Drive; o item mostra as ocorrências", async () => {
  await as(member);
  const c = await rpc("client_radar", [A, client]);
  assert.equal(c.can_edit, false);
  assert.equal(c.items.length, 2);
  assert.deepEqual(c.topics.map((t) => t.key), ["problemas", "promessas"]);
  const it = await rpc("radar_item", [A, artItem.id]);
  assert.equal(it.can_edit, false);
  assert.equal(it.topic.key, "problemas");
  assert.equal(it.occurrences.length, it.mentions);
  assert.equal(it.occurrences[0].source_type, "whatsapp");
  assert.equal(it.occurrences[0].group_id, GROUP);
  assert.deepEqual(it.client_products.map((p) => p.name), ["Social", "Tráfego"]);
  await as(outsider);
  await rejects(() => rpc("client_radar", [A, client]), /Sem acesso/);
  await as(outsider);
  await rejects(() => rpc("radar_item", [A, artItem.id]), /não encontrado/);
});

await check("editar por pessoa segura título, resumo e produto; validações", async () => {
  await as(manager);
  const it = await rpc("update_radar_item", [A, problem.id, JSON.stringify({
    title: "Queda de leads em setembro", product_id: social, severity: 0,
  })]);
  assert.equal(it.title, "Queda de leads em setembro");
  assert.equal(it.product_name, "Social");
  await as(manager);
  await rejects(() => rpc("update_radar_item", [A, problem.id, JSON.stringify({ status: "xyz" })]), /Status inválido/);
  await as(manager);
  await rejects(() => rpc("update_radar_item", [A, problem.id, JSON.stringify({ product_id: uid(777) })]), /não contrata/);
  await as(manager);
  await rejects(() => rpc("update_radar_item", [A, problem.id, JSON.stringify({ assignee_id: uid(777) })]), /Responsável/);
  const [m] = await sql(`select id from radar_signals where source_type = 'meeting'`);
  await sql(`update radar_signals set claimed_at = now(), dirty_at = now() - interval '1 hour' where id = $1`, [m.id]);
  await store(m.id, {
    items: [{
      topic_id: topics.problemas.id, item_id: problem.id, title: "Outro título", summary: "Outro resumo",
      product_id: trafego, severity: 3,
      mentions: [{ quote: "Os leads caíram muito", role: "client", at_seconds: 5 }],
    }],
  });
  const [row] = await sql(`select title, summary, product_id, severity from radar_items where id = $1`, [problem.id]);
  assert.deepEqual([row.title, row.product_id, row.severity], ["Queda de leads em setembro", social, 0]);
  assert.equal(row.summary, "O cliente está preocupado com os leads.");
});

await check("tópicos novos, desligados por produto, status que saem e tópico com itens", async () => {
  await as(manager);
  const cfg = await rpc("radar_settings", [A]);
  const saved = await rpc("save_radar_topics", [A, JSON.stringify([
    {
      ...cfg.topics[0],
      statuses: cfg.topics[0].statuses.filter((s) => s.key !== "descartado"),
      off_products: [social],
    },
    { ...cfg.topics[1], active: false },
    {
      name: "Pedidos de novos serviços",
      description: "O cliente pede um serviço que a agência ainda não faz para ele.",
      speaker: "client", sources: ["meeting"], severity: false,
      severity_levels: ["a", "b", "c", "d"],
      statuses: [
        { label: "Novo", color: "#2a78d6", kind: "open" },
        { label: "Proposta enviada", color: "#eda100", kind: "progress" },
        { label: "Fechado", color: "#2f9e6b", kind: "closed", reopen: true },
      ],
      fields: [
        { label: "Serviço", type: "choice", options: ["Site", "SEO", "Vídeo"] },
        { label: "Valor estimado", type: "number" },
      ],
    },
  ])]);
  const novo = saved.topics.find((t) => t.name === "Pedidos de novos serviços");
  assert.equal(novo.key, "pedidos_de_novos_servicos");
  assert.deepEqual(novo.statuses.map((s) => [s.key, s.reopen]), [["novo", false], ["proposta_enviada", false], ["fechado", true]]);
  assert.deepEqual(novo.fields.map((f) => [f.key, f.type]), [["servico", "choice"], ["valor_estimado", "number"]]);
  // O item descartado foi para o primeiro status fechado que sobrou.
  assert.equal((await sql(`select status from radar_items where id = $1`, [artItem.id]))[0].status, "resolvido");
  // O cliente 9001 só contrata Social, onde Problemas está desligado; Promessas está desligado.
  const t9001 = await sql(`select key from mavi_private.radar_client_topics($1, $2, 'meeting')`, [A, other]);
  assert.deepEqual(t9001.map((t) => t.key), ["pedidos_de_novos_servicos"]);
  const t4282 = await sql(`select key, products from mavi_private.radar_client_topics($1, $2, 'whatsapp') order by position`, [A, client]);
  assert.deepEqual(t4282.map((t) => [t.key, t.products]), [["problemas", [trafego]]]);
  await as(manager);
  await rejects(() => rpc("save_radar_topics", [A, JSON.stringify([novo])]), /já tem itens: desligue/);
  await as(manager);
  await rejects(() => rpc("save_radar_topics", [A, JSON.stringify([{ ...novo, statuses: novo.statuses.slice(0, 2) }])]),
    /um status aberto e de um fechado/);
  await as(manager);
  await rejects(() => rpc("save_radar_topics", [A, JSON.stringify([{ ...novo, severity_levels: ["a"] }])]), /4 níveis/);
});

await check("o módulo Radar se esconde por pessoa; falhas e o aviso ao worker", async () => {
  await as(admin);
  await rpc("set_member_pages", [A, manager, ["radar"]]);
  assert.deepEqual((await sql(`select hidden_pages from memberships where user_id = $1`, [manager]))[0].hidden_pages, ["radar"]);
  const [g] = await sql(`select id from radar_signals where source_type = 'whatsapp'`);
  for (let i = 0; i < 5; i++) {
    await as(null);
    await rpc("ai_radar_fail", [SECRET, g.id, "modelo fora do ar"]);
  }
  const [row] = await sql(`select status, attempts, last_error from radar_signals where id = $1`, [g.id]);
  assert.deepEqual([row.status, row.attempts, row.last_error], ["failed", 5, "modelo fora do ar"]);
  await sql(`delete from net.requests`);
  // Itens esperando tema também acordam o worker (Fase 2): aqui, nenhum.
  await sql(`update radar_items set theme_pending = false`);
  await sql(`select mavi_private.ai_radar_kick()`);
  assert.equal((await sql(`select count(*)::int as n from net.requests`))[0].n, 0, "sem nada para ler, não acorda");
  await sql(`update radar_signals set status = 'pending', attempts = 0, claimed_until = null, dirty_at = now() - interval '1 hour' where id = $1`, [g.id]);
  await sql(`select mavi_private.ai_radar_kick()`);
  const [req] = await sql(`select body from net.requests`);
  assert.deepEqual(req.body, { action: "ai-radar" });
});

await check("a reunião apagada leva as ocorrências e os itens que só ela sustentava", async () => {
  await sql(`update radar_items set person_edited = false, severity_person = false, assignee_id = null, status_by = null
    where id = $1`, [problem.id]);
  await sql(`delete from ai_documents where source_type = 'meeting' and source_id = $1`, [MEET1]);
  assert.equal((await sql(`select count(*)::int as n from radar_signals where source_type = 'meeting'`))[0].n, 0);
  assert.equal((await sql(`select count(*)::int as n from radar_items where id = $1`, [problem.id]))[0].n, 0);
  assert.equal((await sql(`select count(*)::int as n from radar_items where id = $1`, [artItem.id]))[0].n, 1);
});

// ------------------------------------------------------------ Fase 2
let themeA;
const newItem = (title, clientId, product, extra = {}) =>
  sql(`insert into radar_items(company_id, client_id, topic_id, product_id, title, summary, status, mentions)
    values ($1,$2,$3,$4,$5,'resumo','aberto',1) returning *`, [A, clientId, topics.problemas.id, product, title])
    .then(([r]) => r)
    .then(async (r) => {
      if (Object.keys(extra).length)
        await sql(`update radar_items set ${Object.keys(extra).map((k, i) => `${k} = $${i + 2}`).join(", ")} where id = $1`,
          [r.id, ...Object.values(extra)]);
      return r;
    });
let i1;
let i2;
let i3;
let geral;
await check("itens sem tema vão para a MAVI por tópico e produto; o que ela não decide volta", async () => {
  await sql(`update radar_items set theme_pending = false`);
  i1 = await newItem("Atraso na aprovação das artes", client, trafego);
  i2 = await newItem("Artes aprovadas com atraso", client, trafego);
  i3 = await newItem("Leads de baixa qualidade", client, trafego);
  geral = await newItem("Demora no atendimento", client, null);
  await as(null);
  const groups = await rpc("ai_radar_theme_claim", [SECRET, 5]);
  assert.equal(groups.length, 2);
  const g = groups.find((x) => x.product_id === trafego);
  assert.deepEqual(g.items.map((i) => i.title), ["Atraso na aprovação das artes", "Artes aprovadas com atraso",
    "Leads de baixa qualidade"]);
  assert.equal(g.items[0].client, "4282");
  assert.equal(g.topic.name, "Problemas / reclamações");
  assert.deepEqual(g.themes, []);
  assert.equal(groups.find((x) => x.product_id === null).product_name, null);
  await as(null);
  assert.deepEqual(await rpc("ai_radar_theme_claim", [SECRET, 5]), [], "reservados não saem de novo");
  await as(null);
  const n = await rpc("ai_radar_theme_store", [SECRET, JSON.stringify({
    company_id: A, topic_id: topics.problemas.id, product_id: trafego, claimed: g.items.map((i) => i.id),
    new: [{ ref: "N1", title: "Atraso na aprovação de criativos", summary: "Clientes esperam a aprovação." },
      { ref: "N2", title: "Tema sem item" }],
    assign: [{ item_id: i1.id, ref: "N1" }, { item_id: i2.id, ref: "N1" }, { item_id: uid(555), ref: "N1" }],
    usage: { model: "openai/gpt-5.6", input: 1500, output: 200, cost: 0.003 },
  })]);
  assert.equal(n, 2);
  const themes = await sql(`select * from radar_themes order by created_at`);
  assert.deepEqual(themes.map((t) => t.title), ["Atraso na aprovação de criativos"], "tema sem item não nasce");
  themeA = themes[0];
  assert.equal(themeA.product_id, trafego);
  const [r3] = await sql(`select theme_pending, theme_claimed_until, theme_attempts from radar_items where id = $1`, [i3.id]);
  assert.deepEqual([r3.theme_pending, r3.theme_claimed_until, r3.theme_attempts], [true, null, 1]);
  assert.equal((await sql(`select count(*)::int as n from ai_usage where kind = 'radar_themes'`))[0].n, 1);
  // Na próxima, o tema existente vai junto.
  await as(null);
  const [again] = (await rpc("ai_radar_theme_claim", [SECRET, 5])).filter((x) => x.product_id === trafego);
  assert.deepEqual(again.items.map((i) => i.id), [i3.id]);
  assert.deepEqual(again.themes.map((t) => [t.title, t.items, t.clients]), [["Atraso na aprovação de criativos", 2, 1]]);
  await as(null);
  await rpc("ai_radar_theme_store", [SECRET, JSON.stringify({
    company_id: A, topic_id: topics.problemas.id, product_id: trafego, claimed: [i3.id],
    new: [{ ref: "N1", title: "Leads de baixa qualidade" }], assign: [{ item_id: i3.id, ref: "N1" }],
    update: [{ theme_id: themeA.id, summary: "Resumo novo." }],
  })]);
  assert.equal((await sql(`select summary from radar_themes where id = $1`, [themeA.id]))[0].summary, "Resumo novo.");
  // Três tentativas sem decisão: o item para de ir.
  await sql(`update radar_items set theme_attempts = 3, theme_claimed_until = null where id = $1`, [geral.id]);
  await as(null);
  assert.deepEqual(await rpc("ai_radar_theme_claim", [SECRET, 5]), []);
});

await check("os temas do tópico com os números; renomear, mover, juntar e o tema vazio some", async () => {
  await as(manager);
  let list = await rpc("radar_themes", [A, JSON.stringify({ topic: topics.problemas.id })]);
  assert.deepEqual(list.themes.map((t) => [t.title, t.items, t.open_items, t.clients]), [
    ["Atraso na aprovação de criativos", 2, 2, 1], ["Leads de baixa qualidade", 1, 1, 1],
  ]);
  assert.equal(list.themes[0].product_name, "Tráfego");
  assert.deepEqual(list.themes[0].client_names, ["4282"]);
  assert.equal(list.pending, 1);
  list = await rpc("radar_themes", [A, JSON.stringify({ topic: topics.problemas.id, q: "leads" })]);
  assert.equal(list.total, 1);
  await as(manager);
  const leads = (await sql(`select id from radar_themes where title = 'Leads de baixa qualidade'`))[0].id;
  let th = await rpc("update_radar_theme", [A, themeA.id, "Aprovação de criativos atrasada", "Por pessoa."]);
  assert.equal(th.person_edited, true);
  assert.equal(th.items.length, 2);
  assert.deepEqual(th.others.map((o) => o.id), [leads]);
  // A MAVI não reescreve o resumo de tema editado por pessoa.
  await as(null);
  await rpc("ai_radar_theme_store", [SECRET, JSON.stringify({ company_id: A, topic_id: topics.problemas.id,
    product_id: trafego, update: [{ theme_id: themeA.id, summary: "Outro" }] })]);
  assert.equal((await sql(`select summary from radar_themes where id = $1`, [themeA.id]))[0].summary, "Por pessoa.");
  // Mover para um tema novo (fica travado), para "sem tema" e de volta para a MAVI.
  await as(manager);
  let it = await rpc("set_radar_item_theme", [A, i2.id, null, "Aprovação pelo WhatsApp", false]);
  assert.equal(it.theme_title, "Aprovação pelo WhatsApp");
  assert.equal(it.theme_locked, true);
  assert.equal(it.theme_options.length, 3);
  const whats = it.theme_id;
  await as(manager);
  it = await rpc("set_radar_item_theme", [A, i2.id, null, null, false]);
  assert.deepEqual([it.theme_id, it.theme_locked, it.theme_pending], [null, true, false]);
  assert.equal((await sql(`select count(*)::int as n from radar_themes where id = $1`, [whats]))[0].n, 0, "tema vazio some");
  await as(manager);
  it = await rpc("set_radar_item_theme", [A, i2.id, null, null, true]);
  assert.deepEqual([it.theme_locked, it.theme_pending], [false, true]);
  await as(manager);
  await rejects(() => rpc("set_radar_item_theme", [A, geral.id, themeA.id, null, false]), /mesmo tópico e produto/);
  // Juntar: os itens vão para o primeiro e o outro some.
  await as(manager);
  th = await rpc("merge_radar_themes", [A, themeA.id, [leads]]);
  assert.equal(th.items.length, 2);
  assert.equal((await sql(`select count(*)::int as n from radar_themes where id = $1`, [leads]))[0].n, 0);
  // Mudar o produto do item manda escolher o tema de novo.
  await as(manager);
  it = await rpc("update_radar_item", [A, i3.id, JSON.stringify({ product_id: social })]);
  assert.deepEqual([it.theme_id, it.theme_pending], [null, true]);
  await as(member);
  await rejects(() => rpc("radar_themes", [A, JSON.stringify({ topic: topics.problemas.id })]), /Sem permissão/);
  await as(member);
  await rejects(() => rpc("set_radar_item_theme", [A, i1.id, null, "x", false]), /Sem permissão/);
  // A lista filtra por tema.
  await as(manager);
  const byTheme = await rpc("radar_items", [A, JSON.stringify({ theme: themeA.id })]);
  assert.deepEqual(byTheme.items.map((x) => x.theme_title), ["Aprovação de criativos atrasada"]);
});

await check("a tarefa criada a partir do item fica ligada; quem não acessa a tarefa não a vê", async () => {
  const [k] = await sql(`select id from contracts where client_id = $1 and product_id = $2`, [client, trafego]);
  const [task] = await sql(`insert into tasks(company_id, contract_id, title, creator_id, assignee_id, due_date,
    original_due_date) values ($1,$2,'Resolver a aprovação',$3,$3,'2026-10-10','2026-10-10') returning id`, [A, k.id, admin]);
  await as(manager);
  await rpc("link_radar_task", [A, i1.id, task.id]);
  await rpc("link_radar_task", [A, i1.id, task.id]);
  const it = await rpc("radar_item", [A, i1.id]);
  assert.deepEqual(it.tasks.map((t) => [t.title, t.assignee_name, typeof t.status]), [["Resolver a aprovação", "Ana Admin", "string"]]);
  await as(member);
  assert.deepEqual((await rpc("radar_item", [A, i1.id])).tasks, []);
  await as(member);
  await rejects(() => rpc("link_radar_task", [A, i1.id, task.id]), /Sem permissão/);
  await as(manager);
  await rejects(() => rpc("link_radar_task", [A, i1.id, uid(444)]), /Tarefa não encontrada/);
});

await check("a fonte Radar nos Dashboards: métricas, agrupamentos e filtros", async () => {
  const spec = (q, groupBy = "none") => JSON.stringify({ viz: "stat", groupBy, queries: [{ ref: "A", filters: [], ...q }] });
  const today = (await sql(`select (now() at time zone 'America/Sao_Paulo')::date::text as d`))[0].d;
  const run = async (q, g) => {
    await as(manager);
    return (await rpc("dashboard_preview", [A, spec({ source: "radar", ...q }, g), today, today, "{}"])).series.A;
  };
  await sql(`update radar_items set severity = 3 where id = $1`, [i1.id]);
  // Os 4 itens novos e o da arte (resolvido, da Fase 1).
  const total = (await run({ metric: "items" }))[0].v;
  assert.equal(total, 5);
  assert.equal((await run({ metric: "open_items" }))[0].v, 4);
  assert.equal((await run({ metric: "closed_items" }))[0].v, 1);
  assert.equal((await run({ metric: "severe" }))[0].v, 2, "o novo e o da arte");
  assert.equal((await run({ metric: "clients" }))[0].v, 1);
  const byTopic = await run({ metric: "items" }, "topic");
  assert.deepEqual(byTopic.map((p) => [p.l, p.v]), [["Problemas / reclamações", 5]]);
  const byTheme = await run({ metric: "items" }, "theme");
  assert.deepEqual(byTheme.map((p) => p.l).sort(), ["Aprovação de criativos atrasada", "Sem tema"]);
  const byProduct = await run({ metric: "items" }, "product");
  assert.ok(byProduct.some((p) => p.l === "Geral / Agência"));
  const bySeverity = await run({ metric: "items" }, "severity");
  assert.ok(bySeverity.some((p) => p.l === "Crítica" && p.v === 2));
  const byStatus = await run({ metric: "items" }, "status");
  assert.deepEqual(byStatus.map((p) => [p.l, p.v]), [["Aberto", 4], ["Fechado", 1]]);
  const byPerson = await run({ metric: "items" }, "person");
  assert.deepEqual(byPerson.map((p) => [p.l, p.v]), [["Sem responsável", 4], ["Bruno Equipe", 1]]);
  const f = (field, values, op) => ({ metric: "items", filters: [{ field, values, ...(op ? { op } : {}) }] });
  assert.equal((await run(f("product", ["none"])))[0].v, 1);
  assert.equal((await run(f("state", ["closed"])))[0].v, 1);
  assert.equal((await run(f("theme", [themeA.id])))[0].v, 1, "o outro mudou de produto");
  assert.equal((await run(f("severity", ["3"])))[0].v, 2);
  assert.equal((await run(f("topic", [topics.problemas.id], "not_in")))[0].v, 0);
  assert.equal((await run(f("team", [team])))[0].v, 5);
  assert.equal((await run(f("project", [uid(1)])))[0].v, 5, "projeto não se aplica");
  const mentions = (await run({ metric: "mentions" }))[0].v;
  assert.ok(mentions >= 1);
  await as(manager);
  await rejects(() => run({ metric: "xyz" }), /Métrica inválida/);
  await as(manager);
  await rejects(() => run({ metric: "items", dateField: "xyz" }), /Campo de data inválido/);
  // O painel salvo aceita os agrupamentos novos.
  await as(manager);
  await sql(`select mavi_private.dashboard_check($1, $2::jsonb, '{}'::jsonb)`, [A, JSON.stringify([{
    id: "radar-tema", title: "Por tema", x: 0, y: 0, w: 6, h: 4,
    spec: { viz: "hbar", groupBy: "theme", queries: [{ ref: "A", source: "radar", metric: "items", filters: [] }] },
  }])]);
  await as(manager);
  await rpc("ai_set_route", [A, "feature", null, OPENROUTER, "openai/gpt-5.6", "client_radar_themes"]);
  await as(null);
  assert.equal((await rpc("ai_worker_route", [SECRET, A, "client_radar_themes"])).model, "openai/gpt-5.6");
  await as(manager);
  const opts = await rpc("radar_theme_options", [A]);
  assert.ok(opts.themes.some((t) => t.title === "Aprovação de criativos atrasada" && t.product === "Tráfego"));
});

await check("item sem tema também acorda o worker", async () => {
  await sql(`update radar_signals set status = 'done'`);
  await sql(`delete from net.requests`);
  await sql(`update radar_items set theme_pending = false`);
  await sql(`select mavi_private.ai_radar_kick()`);
  assert.equal((await sql(`select count(*)::int as n from net.requests`))[0].n, 0);
  await sql(`update radar_items set theme_pending = true, theme_attempts = 0, theme_locked = false where id = $1`, [i3.id]);
  await sql(`select mavi_private.ai_radar_kick()`);
  assert.equal((await sql(`select count(*)::int as n from net.requests`))[0].n, 1);
});

// ------------------------------------------------------------ Fase 3
let report;
await check("pedir um relatório: fica na fila, acorda o worker e a tela sabe", async () => {
  await sql(`delete from net.requests`);
  await sql(`delete from realtime.messages`);
  const today = (await sql(`select (now() at time zone 'America/Sao_Paulo')::date::text as d`))[0].d;
  await as(manager);
  report = await rpc("request_radar_report", [A, "2026-01-01", today, JSON.stringify({
    topics: [topics.problemas.id, uid(9)], products: [trafego, "none", "lixo"], clients: [client] })]);
  assert.equal(report.status, "pending");
  assert.match(report.title, /^Radar do cliente · 01\/01\/2026 a /);
  assert.deepEqual(report.filters.topics, [topics.problemas.id]);
  assert.deepEqual(report.filters.products.sort(), [trafego, "none"].sort());
  assert.deepEqual(report.labels.products.sort(), ["Geral / Agência", "Tráfego"]);
  assert.deepEqual(report.labels.clients, ["4282"]);
  assert.equal((await sql(`select count(*)::int as n from net.requests`))[0].n, 1);
  const [msg] = await sql(`select payload from realtime.messages order by id desc limit 1`);
  assert.deepEqual([msg.payload.kind, msg.payload.status], ["radar", "pending"]);
  await as(manager);
  await rejects(() => rpc("request_radar_report", [A, today, "2026-01-01", "{}"]), /período válido/);
  await as(manager);
  await rejects(() => rpc("request_radar_report", [A, "2024-01-01", today, "{}"]), /até um ano/);
  await as(member);
  await rejects(() => rpc("request_radar_report", [A, "2026-01-01", today, "{}"]), /Sem permissão/);
});

await check("o worker recebe os números do período e o texto vira o relatório com aviso", async () => {
  await as(null);
  const [c] = await rpc("ai_radar_report_claim", [SECRET, 2]);
  assert.equal(c.id, report.id);
  const m = c.material;
  assert.equal(m.company, "Make");
  assert.deepEqual(m.filters.topics, ["Problemas / reclamações"]);
  assert.deepEqual(m.topics.map((t) => t.topic), ["Problemas / reclamações"]);
  const t = m.topics[0];
  assert.ok(t.new >= 3 && t.open >= 3, JSON.stringify(t));
  assert.ok(m.products.some((p) => p.product === "Tráfego"));
  assert.ok(m.products.some((p) => p.product === "Geral / Agência"));
  assert.ok(m.themes.some((th) => th.title === "Aprovação de criativos atrasada" && th.clients === 1));
  assert.ok(m.severe.some((i) => i.title === "Atraso na aprovação das artes" && i.severity === 3));
  assert.ok(m.clients[0].client === "4282");
  assert.ok(m.new_items.length >= 3);
  await as(null);
  assert.deepEqual(await rpc("ai_radar_report_claim", [SECRET, 2]), [], "reservado não sai de novo");
  const [row] = await sql(`select status, attempts, material is not null as has from radar_reports where id = $1`, [report.id]);
  assert.deepEqual([row.status, row.attempts, row.has], ["running", 1, true]);
  await as(null);
  await rpc("ai_radar_report_store", [SECRET, report.id, JSON.stringify({
    headline: "Atraso na aprovação é o tema do mês.", summary: "Resumo.",
    sections: [{ title: "Tráfego", paragraphs: ["Texto."], bullets: ["Ponto."] }],
    actions: [{ priority: "alta", text: "Revisar a aprovação." }],
  }), JSON.stringify({ model: "claude-opus-5-5", input: 5000, output: 900, cost: 0.12 })]);
  await as(manager);
  const full = await rpc("radar_report", [A, report.id]);
  assert.equal(full.status, "done");
  assert.equal(full.content.actions[0].priority, "alta");
  assert.equal(full.headline, "Atraso na aprovação é o tema do mês.");
  assert.equal(full.requested_by_name, "Gabi Gestora");
  assert.equal(Number(full.cost_usd), 0.12);
  const [n] = await sql(`select * from notifications where kind = 'radar_report'`);
  assert.equal(n.user_id, manager);
  assert.equal(n.link, `/radar?relatorio=${report.id}`);
  assert.match(n.title, /^Relatório do Radar pronto: /);
  assert.equal((await sql(`select count(*)::int as n from ai_usage where kind = 'radar_report'`))[0].n, 1);
  const list = await rpc("radar_reports", [A, 50, 0]);
  assert.equal(list.total, 1);
  assert.equal(list.reports[0].material, undefined, "a lista não traz os números");
  assert.ok((await sql(`select mavi_private.notification_pref_keys() @> array['radar_report'] as ok`))[0].ok);
  await as(null);
  await rpc("ai_radar_report_store", [SECRET, report.id, JSON.stringify({ headline: "outra" }), "{}"]);
  assert.equal((await sql(`select content->>'headline' as h from radar_reports where id = $1`, [report.id]))[0].h,
    "Atraso na aprovação é o tema do mês.", "pronto não é reescrito");
});

await check("falhas tentam de novo até 3 vezes e avisam; tentar de novo e excluir", async () => {
  const today = (await sql(`select (now() at time zone 'America/Sao_Paulo')::date::text as d`))[0].d;
  await as(manager);
  const r = await rpc("request_radar_report", [A, today, today, "{}"]);
  for (let i = 0; i < 3; i++) {
    await sql(`update radar_reports set claimed_until = null where id = $1`, [r.id]);
    await as(null);
    const got = await rpc("ai_radar_report_claim", [SECRET, 2]);
    assert.deepEqual(got.map((x) => x.id), [r.id]);
    await as(null);
    await rpc("ai_radar_report_fail", [SECRET, r.id, "modelo fora do ar"]);
  }
  const [row] = await sql(`select status, attempts, error from radar_reports where id = $1`, [r.id]);
  assert.deepEqual([row.status, row.attempts, row.error], ["failed", 3, "modelo fora do ar"]);
  assert.equal((await sql(`select count(*)::int as n from notifications where kind = 'radar_report'
    and title like 'Não deu%'`))[0].n, 1);
  await as(manager);
  assert.equal((await rpc("retry_radar_report", [A, r.id])).status, "pending");
  await as(manager);
  await rejects(() => rpc("retry_radar_report", [A, r.id]), /que falhou/);
  // Outro gestor não exclui o pedido de alguém; o administrador exclui.
  await sql(`update memberships set role = 'manager' where user_id = $1`, [member]);
  await as(member);
  await rejects(() => rpc("delete_radar_report", [A, r.id]), /Só quem pediu/);
  await sql(`update memberships set role = 'member' where user_id = $1`, [member]);
  await as(admin);
  await rpc("delete_radar_report", [A, r.id]);
  assert.equal((await sql(`select count(*)::int as n from radar_reports where id = $1`, [r.id]))[0].n, 0);
});

await check("agendamentos: a próxima vez no fuso, o pedido do período e quem deixa de ser líder", async () => {
  // Quarta-feira 30/09/2026 10h em São Paulo: a próxima segunda às 8h é 05/10.
  const [{ next }] = await sql(`select mavi_private.radar_schedule_next('weekly', 1, 1, 8, 'America/Sao_Paulo',
    '2026-09-30 13:00+00') as next`);
  assert.equal(next.toISOString(), "2026-10-05T11:00:00.000Z");
  const [{ same }] = await sql(`select mavi_private.radar_schedule_next('weekly', 3, 1, 11, 'America/Sao_Paulo',
    '2026-09-30 13:00+00') as same`);
  assert.equal(same.toISOString(), "2026-09-30T14:00:00.000Z", "hoje, mais tarde");
  const [{ month }] = await sql(`select mavi_private.radar_schedule_next('monthly', 1, 5, 9, 'America/Sao_Paulo',
    '2026-09-30 13:00+00') as month`);
  assert.equal(month.toISOString(), "2026-10-05T12:00:00.000Z");
  await as(manager);
  let list = await rpc("save_radar_report_schedule", [A, JSON.stringify({ name: "Semanal de Tráfego",
    frequency: "weekly", weekday: 1, hour: 8, period_days: 7, filters: { products: [trafego] } })]);
  assert.equal(list.length, 1);
  assert.equal(list[0].labels.products[0], "Tráfego");
  assert.ok(list[0].next_run_at);
  await as(manager);
  await rejects(() => rpc("save_radar_report_schedule", [A, JSON.stringify({ name: "x", frequency: "weekly" })]), /nome/);
  await as(manager);
  await rejects(() => rpc("save_radar_report_schedule", [A, JSON.stringify({ name: "Ok", frequency: "daily" })]), /Frequência/);
  await as(admin);
  assert.deepEqual(await rpc("radar_report_schedules", [A]), [], "cada pessoa vê os seus");
  // Venceu: vira pedido dos últimos 7 dias até ontem, e a próxima vez anda.
  const sched = list[0].id;
  await sql(`update radar_report_schedules set next_run_at = now() - interval '1 minute' where id = $1`, [sched]);
  await sql(`delete from net.requests`);
  await sql(`select mavi_private.ai_radar_kick()`);
  assert.equal((await sql(`select count(*)::int as n from net.requests`))[0].n, 1, "agendamento vencido acorda");
  await as(null);
  const got = await rpc("ai_radar_report_claim", [SECRET, 5]);
  assert.equal(got.length, 1);
  const [r] = await sql(`select * from radar_reports where schedule_id = $1`, [sched]);
  const [{ y }] = await sql(`select ((now() at time zone 'America/Sao_Paulo')::date - 1) as y`);
  assert.equal(r.period_to.getTime(), y.getTime());
  assert.equal((r.period_to - r.period_from) / 864e5, 6);
  assert.equal(r.requested_by, manager);
  assert.match(r.title, /^Semanal de Tráfego · /);
  assert.deepEqual(r.filters.products, [trafego]);
  const [s2] = await sql(`select next_run_at, last_run_at from radar_report_schedules where id = $1`, [sched]);
  assert.ok(s2.next_run_at > new Date() && s2.last_run_at);
  // Quem deixa de ser líder perde o agendamento.
  await sql(`update radar_report_schedules set next_run_at = now() - interval '1 minute' where id = $1`, [sched]);
  await sql(`update memberships set role = 'member' where user_id = $1`, [manager]);
  await as(null);
  await rpc("ai_radar_report_claim", [SECRET, 5]);
  const [s3] = await sql(`select active, next_run_at from radar_report_schedules where id = $1`, [sched]);
  assert.deepEqual([s3.active, s3.next_run_at], [false, null]);
  await sql(`update memberships set role = 'manager' where user_id = $1`, [manager]);
  await as(manager);
  assert.deepEqual(await rpc("delete_radar_report_schedule", [A, sched]), []);
});

// ------------------------------------------------------------ Fase 4
const newSignal = async (extra = {}) => {
  const [g] = await sql(`insert into radar_signals(company_id, client_id, source_type, source_id, group_id, title,
    occurred_at, day, status, dirty_at, claimed_at, backfill)
    values ($1,$2,'whatsapp',gen_random_uuid(),$3,'Grupo',$4,current_date,'pending',now() - interval '1 hour',now(),$5)
    returning *`, [A, client, GROUP, extra.at ?? new Date(), extra.backfill ?? false]);
  return g;
};
const alerts = async () => sql(`select user_id, title, body, link from notifications where kind = 'radar_alert' order by created_at, title`);
let ruleNow;
await check("avisos por regra pessoal: cada gestor cria os seus, com validação", async () => {
  // Um teste da Fase 1 escondeu o módulo do gestor.
  await as(admin);
  await rpc("set_member_pages", [A, manager, []]);
  await as(manager);
  let list = await rpc("save_radar_alert_rule", [A, JSON.stringify({ name: "Reclamações de Tráfego",
    topic_id: topics.problemas.id, product_id: trafego, events: ["new", "recurring", "reopened"], channel: "now" })]);
  ruleNow = list[0];
  assert.deepEqual([ruleNow.labels.topic, ruleNow.labels.product, ruleNow.channel], ["Problemas / reclamações", "Tráfego", "now"]);
  await as(manager);
  list = await rpc("save_radar_alert_rule", [A, JSON.stringify({ name: "Prazos (resumo)", topic_id: topics.promessas.id,
    events: ["due_soon", "overdue", "lixo"], channel: "digest" })]);
  assert.deepEqual(list[1].events.sort(), ["due_soon", "overdue"]);
  await as(admin);
  await rpc("save_radar_alert_rule", [A, JSON.stringify({ name: "Só crítico", min_severity: 3, events: ["new"] })]);
  await as(manager);
  await rejects(() => rpc("save_radar_alert_rule", [A, JSON.stringify({ name: "Sem evento", events: [] })]), /ao menos um evento/);
  await as(manager);
  await rejects(() => rpc("save_radar_alert_rule", [A, JSON.stringify({ name: "Filtro", client_id: uid(4), events: ["new"] })]),
    /não encontrado/);
  await as(member);
  await rejects(() => rpc("radar_alert_rules", [A]), /Sem permissão/);
  await as(admin);
  assert.equal((await rpc("radar_alert_rules", [A])).length, 1, "cada pessoa vê as suas");
  await sql(`update radar_topics set active = true where company_id = $1`, [A]);
  await sql(`update radar_topics set off_products = '{}' where company_id = $1`, [A]);
});

let alertItem;
await check("item novo, fala nova e reaberto avisam na hora; sem repetir no mesmo dia", async () => {
  await sql(`delete from notifications where kind = 'radar_alert'`);
  const g = await newSignal();
  await store(g.id, { items: [{ topic_id: topics.problemas.id, title: "Relatório atrasado de novo", product_id: trafego,
    severity: 2, mentions: [{ quote: "cadê o relatório?", role: "client" }] }] });
  alertItem = (await sql(`select id from radar_items where title = 'Relatório atrasado de novo'`))[0].id;
  let got = await alerts();
  assert.equal(got.length, 1, "o administrador pediu só crítico");
  assert.equal(got[0].user_id, manager);
  assert.equal(got[0].title, "Problemas / reclamações: Relatório atrasado de novo");
  assert.match(got[0].body, /^Novo · 4282 · Tráfego · Alta$/);
  assert.equal(got[0].link, `/radar?item=${alertItem}`);
  const g2 = await newSignal();
  await store(g2.id, { items: [{ topic_id: topics.problemas.id, item_id: alertItem, title: "x",
    mentions: [{ quote: "e o relatório?", role: "client" }] }] });
  const g3 = await newSignal();
  await store(g3.id, { items: [{ topic_id: topics.problemas.id, item_id: alertItem, title: "x",
    mentions: [{ quote: "ainda nada do relatório", role: "client" }] }] });
  got = await alerts();
  assert.deepEqual(got.map((n) => n.body.split(" · ")[0]), ["Novo", "Voltou a aparecer"]);
  await as(manager);
  await rpc("update_radar_item", [A, alertItem, JSON.stringify({ status: "resolvido" })]);
  const g4 = await newSignal();
  await store(g4.id, { items: [{ topic_id: topics.problemas.id, item_id: alertItem, title: "x",
    mentions: [{ quote: "voltou o atraso", role: "client" }] }] });
  got = await alerts();
  assert.equal(got.at(-1).body.split(" · ")[0], "Reabriu");
});

await check("histórico, fala antiga e módulo escondido não avisam", async () => {
  await sql(`delete from notifications where kind = 'radar_alert'`);
  const b = await newSignal({ backfill: true });
  await store(b.id, { items: [{ topic_id: topics.problemas.id, title: "Problema do histórico", product_id: trafego,
    mentions: [{ quote: "coisa antiga", role: "client" }] }] });
  const old = await newSignal({ at: new Date(Date.now() - 5 * 864e5) });
  await store(old.id, { items: [{ topic_id: topics.problemas.id, title: "Problema de 5 dias", product_id: trafego,
    mentions: [{ quote: "faz tempo", role: "client" }] }] });
  assert.deepEqual(await alerts(), []);
  await as(admin);
  await rpc("set_member_pages", [A, manager, ["radar"]]);
  const g = await newSignal();
  await store(g.id, { items: [{ topic_id: topics.problemas.id, title: "Com o módulo escondido", product_id: trafego,
    mentions: [{ quote: "hoje", role: "client" }] }] });
  assert.deepEqual(await alerts(), []);
  await as(admin);
  await rpc("set_member_pages", [A, manager, []]);
});

await check("prazo amanhã e vencido vão para o resumo do dia, que sai uma vez", async () => {
  await sql(`delete from notifications where kind = 'radar_alert'`);
  const today = `(now() at time zone 'America/Sao_Paulo')::date`;
  await sql(`insert into radar_items(company_id, client_id, topic_id, product_id, title, status, due_date, theme_pending)
    values ($1,$2,$3,$4,'Mandar as artes','pendente',${today} + 1,false),
           ($1,$2,$3,$4,'Ligar com os números','pendente',${today} - 1,false),
           ($1,$2,$3,$4,'Já cumprida','cumprida',${today} - 1,false)`,
    [A, client, topics.promessas.id, trafego]);
  await sql(`select mavi_private.radar_daily($1)`, [A]);
  const got = await alerts();
  assert.equal(got.length, 1);
  assert.equal(got[0].user_id, manager);
  assert.equal(got[0].title, "Radar: 2 novidades desde o último resumo");
  assert.deepEqual(got[0].body.split(" · ").sort(), ["1 prazo amanhã", "1 prazo vencido"]);
  assert.equal(got[0].link, "/radar");
  assert.equal((await sql(`select count(*)::int as n from mavi_private.radar_alert_digest`))[0].n, 0);
  const [{ d }] = await sql(`select daily_on = ${today} as d from radar_settings where company_id = $1`, [A]);
  assert.equal(d, true);
  // O tick não roda de novo no mesmo dia.
  await sql(`select mavi_private.radar_tick()`);
  assert.equal((await alerts()).length, 1);
  // No dia seguinte (depois das 8h), roda de novo; antes das 8h, espera.
  await sql(`update radar_settings set daily_on = ${today} - 1 where company_id = $1`, [A]);
  await sql(`select mavi_private.radar_tick()`);
  const [{ h }] = await sql(`select extract(hour from now() at time zone 'America/Sao_Paulo') >= 8 as h`);
  const [{ ran }] = await sql(`select daily_on = ${today} as ran from radar_settings where company_id = $1`, [A]);
  assert.equal(ran, h);
});

await check("histórico: a estimativa, a leitura depois do dia a dia e parar", async () => {
  // Uma reunião de 20 dias atrás e o dia de grupo de 3 dias atrás existem, de antes do Radar ligar.
  await sql(`update radar_settings set started_at = now() where company_id = $1`, [A]);
  const OLD = uid(950);
  await sql(`insert into meeting_recordings(id, company_id, client_id, source_id, title, recorded_at, recorded_by_email)
    values ($1,$2,$3,'m-old','Reunião antiga',now() - interval '20 days','gabi@make.com')`, [OLD, A, client]);
  await sql(`insert into meeting_transcripts(recording_id, company_id, speakers, segments)
    values ($1,$2,'{Carlos Cliente}','[[0,5,0,"Os leads estão fracos há meses."]]')`, [OLD, A]);
  await index();
  assert.equal((await sql(`select count(*)::int as n from radar_signals where source_id = $1`, [OLD]))[0].n, 0,
    "antes de o Radar ligar, fica para o histórico");
  // O custo médio vem das leituras já feitas.
  await sql(`update radar_signals set status = 'done', cost_usd = 0.02 where company_id = $1`, [A]);
  await as(manager);
  const from = (await sql(`select ((now() at time zone 'America/Sao_Paulo')::date - 30)::text as d`))[0].d;
  const est = await rpc("radar_backfill_estimate", [A, from]);
  assert.equal(est.meetings, 1);
  assert.ok(est.whatsapp_days >= 1, JSON.stringify(est));
  assert.ok(est.meeting_chars > 10 && est.whatsapp_chars > 0);
  assert.ok(est.samples >= 1);
  assert.equal(Number(est.avg_whatsapp_cost), 0.02);
  assert.equal(est.price.id, "openai/gpt-5.6");
  await as(member);
  await rejects(() => rpc("start_radar_backfill", [A, from]), /Sem permissão/);
  await as(manager);
  const today = (await sql(`select ((now() at time zone 'America/Sao_Paulo')::date + 1)::text as d`))[0].d;
  await rejects(() => rpc("start_radar_backfill", [A, today]), /Escolha uma data antes/);
  await as(manager);
  const n = await rpc("start_radar_backfill", [A, from]);
  assert.equal(n, est.meetings + est.whatsapp_days);
  const [s] = await sql(`select started_at, backfill_from, backfill_by from radar_settings where company_id = $1`, [A]);
  assert.ok(s.started_at < new Date(Date.now() - 25 * 864e5));
  assert.equal(s.backfill_by, manager);
  // Uma leitura do dia a dia vai antes das do histórico.
  await sql(`update radar_signals set status = 'done' where not backfill`);
  const live = await newSignal();
  await sql(`update radar_signals set claimed_at = null where id = $1`, [live.id]);
  await as(null);
  const claimed = await rpc("ai_radar_claim", [SECRET, 1]);
  assert.deepEqual(claimed.map((c) => c.id), [live.id]);
  await as(manager);
  const cfg = await rpc("radar_settings", [A]);
  assert.equal(cfg.backfill.pending, n);
  assert.equal(cfg.backfill.by_name, "Gabi Gestora");
  const ov = await rpc("radar_overview", [A]);
  assert.equal(ov.reading.backfill_pending, n);
  assert.ok(ov.reading.done >= 1 && ov.reading.last_at);
  assert.equal(ov.backfill_from.slice(0, 10), from);
  await as(manager);
  assert.equal(await rpc("cancel_radar_backfill", [A]), n);
  await as(manager);
  assert.equal((await rpc("radar_settings", [A])).backfill.pending, 0);
});

// ------------------------------------------------------------ MAVI
await check("a MAVI lê o Radar pela regra do Drive: cliente, carteira e o relatório para líderes", async () => {
  await as(member);
  const mine = await rpc("radar_ai", [A, client, null, "open", null, 50]);
  assert.equal(mine.scope, "client");
  assert.equal(mine.leader, false);
  assert.ok(mine.items.length > 0 && mine.items.every((i) => i.client_id === client && !i.closed));
  assert.ok(mine.topics.some((t) => t.key === "problemas" && t.open > 0));
  const withQuote = mine.items.find((i) => i.title === "Relatório atrasado de novo");
  assert.equal(withQuote.quote.text, "voltou o atraso");
  assert.equal(withQuote.quote.source_type, "whatsapp");
  assert.equal(withQuote.severity, "Alta");
  assert.equal(mine.report, null);
  // Filtros: tópico, fechados e palavras.
  await as(member);
  const promises = await rpc("radar_ai", [A, client, "promessas", "open", null, 50]);
  assert.ok(promises.items.length > 0 && promises.items.every((i) => i.topic === "Promessas"));
  assert.ok(promises.items.some((i) => i.overdue), "a promessa de ontem está vencida");
  await as(member);
  const closed = await rpc("radar_ai", [A, client, null, "closed", null, 50]);
  assert.ok(closed.items.every((i) => i.closed));
  await as(member);
  assert.ok((await rpc("radar_ai", [A, client, null, "all", "relatório", 50])).items
    .every((i) => /relat/i.test(i.title + i.summary)));
  // Carteira: o membro só vê os clientes das equipes dele; o 9001 fica de fora.
  await sql(`insert into radar_items(company_id, client_id, topic_id, title, status, theme_pending)
    values ($1,$2,$3,'Item do 9001','aberto',false)`, [A, other, topics.problemas.id]);
  await as(member);
  const portfolio = await rpc("radar_ai", [A, null, null, "open", null, 50]);
  assert.equal(portfolio.scope, "portfolio");
  assert.ok(!portfolio.items.some((i) => i.title === "Item do 9001"));
  await as(manager);
  const all = await rpc("radar_ai", [A, null, null, "open", null, 50]);
  assert.ok(all.items.some((i) => i.title === "Item do 9001"));
  assert.equal(all.report.title.length > 0, true, "o último relatório pronto vai junto");
  await as(outsider);
  await rejects(() => rpc("radar_ai", [A, client, null, "open", null, 10]), /Sem acesso a este cliente/);
  await as(outsider);
  assert.deepEqual((await rpc("radar_ai", [A, null, null, "open", null, 10])).items, []);
});

// Migrations 20270105090000 e 20270107090000: um administrador liga o Radar
// para um colaborador; ele usa tudo, menos a configuração, só nos clientes
// das equipes dele.
await check("colaborador com o Radar ligado: tudo nos clientes dele, sem configurar", async () => {
  const [moved] = await sql(`select id from radar_items where client_id = $1 limit 1`, [client]);
  await sql(`update radar_items set client_id = $1 where id = $2`, [other, moved.id]);
  try {
    await as(member);
    await rejects(() => rpc("radar_items", [A, "{}"]), /Sem permissão/);
    await as(admin);
    // Tudo desligado menos o Radar.
    await rpc("set_member_pages", [A, member, ["overview", "campaigns", "dashboards"]]);
    const [{ n: mine }] = await sql(
      `select count(*)::int as n from radar_items where company_id = $1 and client_id = $2`,
      [A, client],
    );
    await as(member);
    const ov = await rpc("radar_overview", [A]);
    assert.equal(ov.can_configure, false);
    assert.equal(ov.topics.reduce((sum, t) => sum + Number(t.total), 0), mine);
    const r = await rpc("radar_items", [A, JSON.stringify({ limit: 200 })]);
    assert.equal(r.total, mine);
    assert.ok(r.items.every((i) => i.client_id === client));
    assert.ok(!r.items.some((i) => i.id === moved.id));
    // Pedir o outro cliente pelo filtro não abre nada.
    assert.equal((await rpc("radar_items", [A, JSON.stringify({ client: other })])).total, 0);
    assert.equal(ov.can_use, true);
    // A configuração segue dos líderes.
    await rejects(() => rpc("radar_settings", [A]), /Sem permissão/);
    // Edita os itens dos clientes dele; o do outro cliente, não.
    const own = await rpc("radar_item", [A, r.items[0].id]);
    assert.equal(own.can_edit, true);
    const edited = await rpc("update_radar_item", [A, r.items[0].id, JSON.stringify({ severity: 2 })]);
    assert.equal(edited.severity, 2);
    await rejects(
      () => rpc("update_radar_item", [A, moved.id, JSON.stringify({ severity: 1 })]),
      /Sem permissão/,
    );
    await rejects(() => rpc("set_radar_item_theme", [A, moved.id, null, "Tema alheio", false]), /Sem permissão/);
    // Temas: só os que têm itens dos clientes dele, contados nesses itens.
    for (const t of ov.topics) {
      const themes = await rpc("radar_themes", [A, JSON.stringify({ topic: t.id, open_only: false, limit: 200 })]);
      for (const th of themes.themes) {
        const [{ n }] = await sql(
          `select count(*)::int as n from radar_items where theme_id = $1 and client_id = $2`,
          [th.id, client],
        );
        assert.equal(th.items, n);
        assert.ok(n > 0);
      }
    }
    // Relatórios: pede e vê os seus; o material fica nos clientes dele.
    await as(admin);
    await rpc("request_radar_report", [A, "2026-01-01", "2026-12-31", "{}", "Do líder"]);
    await as(member);
    const mineReport = await rpc("request_radar_report", [A, "2026-01-01", "2026-12-31", "{}", "Meu"]);
    const reports = await rpc("radar_reports", [A]);
    assert.deepEqual(reports.reports.map((x) => x.id), [mineReport.id]);
    const [{ material }] = await sql(
      `select mavi_private.radar_report_material($1, '2026-01-01', '2026-12-31', '{}', array[$2]::uuid[]) as material`,
      [A, client],
    );
    assert.ok(material.clients.every((c) => c.client !== "9001"));
    // Avisos: com o cliente dele, sim; com outro, não.
    await rpc("save_radar_alert_rule", [A, JSON.stringify({ name: "Meu cliente", events: ["new"], client_id: client })]);
    await rejects(
      () => rpc("save_radar_alert_rule", [A, JSON.stringify({ name: "Outro", events: ["new"], client_id: other })]),
      /Filtro não encontrado/,
    );
    // O líder continua vendo tudo, e configurando.
    await as(manager);
    const all = await rpc("radar_overview", [A]);
    assert.equal(all.can_configure, true);
    assert.ok(all.topics.reduce((sum, t) => sum + Number(t.total), 0) > mine);
    // Quem não tem o módulo ligado continua fora.
    await as(outsider);
    await rejects(() => rpc("radar_overview", [A]), /Sem permissão/);
  } finally {
    await sql(`update radar_items set client_id = $1 where id = $2`, [client, moved.id]);
    await sql(`update memberships set shown_pages = '{}' where user_id = $1`, [member]);
    await sql(`delete from radar_alert_rules where user_id = $1`, [member]);
  }
});

console.log(`\n${passed} checks passed`);

// Termômetro do cliente (migration 20261110090000_client_temperature): a
// configuração inicial e o Jev do OpenRouter, o telefone do time, as leituras
// que nascem das reuniões e dos dias de grupo (com quem é time e quem é
// cliente), as respostas do Jev virando a temperatura de cada dia, o aviso
// quando esfria (sem aviso durante o histórico), o texto da MAVI, o acesso
// pela regra do Drive, o ajuste por produto com nova versão das perguntas e
// a fonte nos Dashboards.
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
  sql(`update temperature_signals set dirty_at = now() - interval '1 hour' where status = 'pending'`);
/** Reserva e busca o material de cada uma (como o worker); puladas saem. */
const claim = async () => {
  await due();
  await as(null);
  const list = await rpc("ai_temperature_claim", [SECRET, 30]);
  const out = [];
  for (const c of list) {
    await as(null);
    const m = await rpc("ai_temperature_material", [SECRET, c.id]);
    if (m) out.push({ ...c, ...m });
  }
  return out;
};
const refresh = async () => {
  await as(null);
  while ((await rpc("ai_temperature_refresh", [SECRET, 20])) > 0);
};
/** Respostas do Jev para uma leitura (nota 0–100 por indicador). */
const result = (id, version, v, extra = {}) => ({
  id,
  version,
  answers: {
    satisfacao: { v: v, c: 0.9, e: 0.9 },
    permanencia: { v: v, c: 0.9, e: 0.8 },
    relacao: { v: v + 10, c: 0.8, e: 0.9 },
    engajamento: { v: 60, c: 0.7, e: 0.1 },
  },
  flags: { cancelamento: 0.05, cobranca_prazo: 0.1, financeiro: 0.2 },
  reason: { key: "resultados", p: { resultados: 0.7, rotina: 0.3 } },
  excerpt: "trecho",
  client_lines: 3,
  cost: 0.0002,
  input: 4000,
  model: "~typesafe/jev-latest",
  ...extra,
});
// "Hoje" em São Paulo, às 9h (o dia da leitura é o de hoje).
const today9 = `(date_trunc('day', now() at time zone 'America/Sao_Paulo') + interval '9 hours') at time zone 'America/Sao_Paulo'`;

await sql(`insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`, [SECRET]);
await as(admin);
const team = await rpc("create_team", [A, "Equipe A", [member], [manager]]);
const client = await rpc("create_client", [A, "4282", "", [team]]);
const other = await rpc("create_client", [A, "9001", "", []]);
const product = await rpc("create_product", [A, "Tráfego"]);
const product2 = await rpc("create_product", [A, "Social"]);
await rpc("create_contract", [A, client, product, "Tráfego · 4282", team]);
await rpc("create_contract", [A, other, product2, "Social · 9001", null]);
const OPENROUTER = uid(800);
await sql(
  `insert into mavi_private.ai_providers(id, company_id, name, kind, base_url, key_cipher, key_hint, models) values
   ($1,$2,'OpenRouter','openrouter','https://openrouter.ai/api/v1','v1:cifra','9xYz',
    '[{"id":"~typesafe/jev-latest","label":"Jev","input":0.042,"output":0},{"id":"openai/gpt-5.6","label":"GPT"}]')`,
  [OPENROUTER, A],
);

await check("a empresa nasce com a escala, os indicadores e o Jev do OpenRouter", async () => {
  await as(admin);
  const cfg = await rpc("temperature_settings", [A]);
  assert.deepEqual(
    cfg.settings.bands.map((b) => [b.name, b.min, b.alert]),
    [["Gelado", 0, true], ["Frio", 30, true], ["Morno", 50, false], ["Quente", 70, false], ["Fervendo", 85, false]],
  );
  assert.deepEqual(
    cfg.indicators.map((i) => [i.key, i.kind]),
    [["satisfacao", "score"], ["permanencia", "score"], ["relacao", "score"], ["engajamento", "score"],
     ["cancelamento", "flag"], ["cobranca_prazo", "flag"], ["financeiro", "flag"]],
  );
  assert.equal(cfg.indicators.find((i) => i.key === "cancelamento").alert, true);
  assert.equal(cfg.indicators[0].levels.length, 5);
  assert.deepEqual(cfg.jev, { provider: "OpenRouter", model: "~typesafe/jev-latest" });
  assert.equal(cfg.settings.version, 1);
  await as(manager);
  assert.equal((await rpc("temperature_settings", [A])).settings.window_days, 60);
  await as(member);
  await rejects(() => rpc("temperature_settings", [A]), /Sem permissão/);
});

await check("o Jev só vale no termômetro, e o termômetro só com o Jev", async () => {
  await as(admin);
  await rejects(
    () => rpc("ai_set_route", [A, "feature", null, OPENROUTER, "openai/gpt-5.6", "client_temperature"]),
    /usa o Jev/,
  );
  await rejects(
    () => rpc("ai_set_route", [A, "feature", null, OPENROUTER, "~typesafe/jev-latest", "assistant"]),
    /só responde a perguntas de decisão/,
  );
  await rejects(() => rpc("ai_set_route", [A, "company", null, OPENROUTER, "~typesafe/jev-latest"]), /decisão/);
  await rpc("ai_set_route", [A, "feature", null, OPENROUTER, "~typesafe/jev-latest", "client_temperature"]);
  await rpc("ai_set_route", [A, "feature", null, OPENROUTER, "openai/gpt-5.6", "client_temperature_text"]);
  await as(null);
  const r = await rpc("ai_worker_route", [SECRET, A, "client_temperature_text"]);
  assert.equal(r.model, "openai/gpt-5.6");
  const c = await rpc("ai_temperature_config", [SECRET, A]);
  assert.equal(c.route.model, "~typesafe/jev-latest");
  assert.equal(c.route.key_cipher, "v1:cifra");
  assert.equal(c.version, 1);
  assert.equal(c.questions.indicators.length, 7);
  assert.equal(c.questions.reasons.length, 8);
  await rejects(() => rpc("ai_temperature_config", ["x".repeat(40), A]), /Sem permissão/);
});

await check("cada pessoa informa os telefones; líderes também, com as regras de sempre", async () => {
  await as(member);
  assert.deepEqual(await rpc("set_member_phones", [A, member, ["(11) 98765-4321"]]), ["5511987654321"]);
  assert.deepEqual(await rpc("member_phones", [A, member]), ["5511987654321"]);
  // Mais de um número, na ordem da pessoa; o repetido (sem o nono dígito) e o vazio saem.
  assert.deepEqual(
    await rpc("set_member_phones", [A, member, ["", "+44 20 7946 0958", "(11) 98765-4321", "11 8765-4321"]]),
    ["442079460958", "5511987654321"],
  );
  assert.deepEqual(await rpc("member_phones", [A, member]), ["442079460958", "5511987654321"]);
  await rejects(() => rpc("set_member_phones", [A, admin, ["11 99999-0000"]]), /Sem permissão/);
  await as(member);
  await rejects(() => rpc("member_phones", [A, admin]), /Sem permissão/);
  await as(member);
  await rejects(() => rpc("set_member_phones", [A, member, ["11 98765-4321", "123"]]), /telefone 123 com DDD/);
  await as(member);
  const eleven = Array.from({ length: 11 }, (_, i) => `11 9876${String(i).padStart(2, "0")}-0000`);
  await rejects(() => rpc("set_member_phones", [A, member, eleven]), /no máximo 10/);
  await as(manager);
  assert.deepEqual(await rpc("member_phones", [A, member]), ["442079460958", "5511987654321"]);
  await rejects(() => rpc("set_member_phones", [A, admin, ["11 99999-0000"]]), /administradores/);
  await as(admin);
  assert.deepEqual(await rpc("set_member_phones", [A, admin, ["+55 11 99999-0000"]]), ["5511999990000"]);
  assert.deepEqual(await rpc("set_member_phones", [A, admin, []]), []);
  assert.deepEqual(await rpc("member_phones", [A, admin]), []);
  await as(outsider);
  await rejects(() => db.query(`select * from mavi_private.user_phones`), /permission denied/);
});

const MEET1 = uid(900);
const GROUP = uid(901);
let meetingSignal;
let whatsappSignal;
await check("reuniões e dias de grupo viram leituras, com quem é do time", async () => {
  await sql(
    `insert into meeting_recordings(id, company_id, client_id, source_id, title, recorded_at, recorded_by_email, speakers,
      summary)
     values ($1,$2,$3,'m1','Alinhamento',${today9},'gabi@make.com','{Bruno Equipe,Carlos Cliente}',
      '{"title":"Alinhamento de setembro","overview":"O cliente reclamou dos leads."}')`,
    [MEET1, A, client],
  );
  await sql(
    `insert into meeting_transcripts(recording_id, company_id, speakers, segments) values ($1,$2,
      '{Bruno Equipe,Carlos Cliente,Gabi Gestora}',
      '[[0,5,0,"Bom dia, vamos ver os números."],[5,9,1,"Os leads caíram muito, estou preocupado."],[9,12,2,"Vamos ajustar."],[12,14,3,"Oi"]]')`,
    [MEET1, A],
  );
  await sql(
    `insert into whatsapp_groups(id, company_id, jid, title, client_id) values ($1,$2,'1@g.us','4282 - Tráfego',$3)`,
    [GROUP, A, client],
  );
  // A agência (from_me), o Bruno (sem o nono dígito) e o cliente.
  await sql(
    `insert into whatsapp_messages(company_id, group_id, wa_id, sent_at, sender, sender_phone, sender_name, from_me,
      kind, body) values
     ($1,$2,'W1',${today9},'a','5511986540334','Make',true,'text','Bom dia! Segue o relatório.'),
     ($1,$2,'W2',${today9} + interval '1 minute','b','551187654321','Bruno',false,'text','Qualquer dúvida me chama'),
     ($1,$2,'W3',${today9} + interval '2 minutes','c','5511911112222','Carlos',false,'text','Não gostei dos resultados.'),
     ($1,$2,'W4',${today9} - interval '2 days','b','551187654321','Bruno',false,'text','Lembrete da reunião')`,
    [A, GROUP],
  );
  await index();
  const signals = await sql(`select * from temperature_signals order by source_type, day`);
  assert.deepEqual(
    signals.map((s) => [s.source_type, s.client_id === client, s.status]),
    [["meeting", true, "pending"], ["whatsapp", true, "pending"], ["whatsapp", true, "pending"]],
  );
  // Pendentes há menos de 20 minutos não saem.
  await as(null);
  assert.deepEqual(await rpc("ai_temperature_claim", [SECRET, 30]), []);
  const claimed = await claim();
  assert.equal(claimed.length, 2, "o dia só com o time não vai ao Jev");
  const skipped = await sql(`select status from temperature_signals where source_type = 'whatsapp' and day < current_date - 1`);
  assert.deepEqual(skipped.map((s) => s.status), ["skipped"]);
  const meeting = claimed.find((c) => c.source_type === "meeting");
  const wa = claimed.find((c) => c.source_type === "whatsapp");
  meetingSignal = meeting.id;
  whatsappSignal = wa.id;
  assert.equal(meeting.version, 1);
  assert.equal(meeting.state.cliente, "4282");
  assert.equal(meeting.state.produtos_contratados, "Tráfego");
  assert.match(meeting.state.transcricao, /^\[time\] Bruno Equipe: Bom dia/);
  assert.match(meeting.state.transcricao, /\n\[cliente\] Carlos Cliente: Os leads caíram/);
  assert.match(meeting.state.transcricao, /\n\[time\] Gabi Gestora: Vamos ajustar/);
  assert.match(meeting.state.transcricao, /\n\[não identificado\] Falante 4: Oi$/);
  assert.deepEqual(meeting.state.participantes_do_time.sort(), ["Bruno Equipe", "Gabi Gestora"]);
  assert.deepEqual(meeting.state.participantes_do_cliente, ["Carlos Cliente"]);
  assert.match(meeting.state.resumo, /O cliente reclamou dos leads/);
  assert.equal(meeting.excerpt, "O cliente reclamou dos leads.");
  assert.match(wa.state.conversa, /\[time\] Make: Bom dia! Segue o relatório\./);
  assert.match(wa.state.conversa, /\[time\] Bruno: Qualquer dúvida/);
  assert.match(wa.state.conversa, /\[cliente\] Carlos: Não gostei dos resultados\./);
  assert.equal(wa.client_lines, 1);
  const w3 = (await sql(`select id from whatsapp_messages where wa_id = 'W3'`))[0].id;
  assert.equal(wa.message_id, w3);
  assert.equal(wa.state.grupo, "4282 - Tráfego");
  // Reservadas: não saem de novo.
  assert.deepEqual(await claim(), []);
});

let firstScore;
await check("as respostas do Jev viram a temperatura de hoje, sem aviso na primeira vez", async () => {
  await as(null);
  assert.equal(
    await rpc("ai_temperature_store", [SECRET, JSON.stringify([result(meetingSignal, 1, 80), result(whatsappSignal, 1, 70)])]),
    2,
  );
  await refresh();
  await as(member);
  const t = await rpc("client_temperature", [A, client, 180, 40]);
  // Reunião pesa 2, WhatsApp 1; engajamento sem evidência fica de fora.
  const sat = t.current.indicators.find((i) => i.key === "satisfacao");
  assert.equal(Math.round(sat.value * 10) / 10, 76.7);
  assert.equal(t.current.indicators.find((i) => i.key === "engajamento").value, null);
  firstScore = t.current.score;
  assert.ok(firstScore > 70 && firstScore < 85, String(firstScore));
  assert.equal(t.current.band, 3);
  assert.deepEqual(t.current.flags, []);
  assert.deepEqual(t.current.reasons.map((r) => [r.key, r.share]), [["resultados", 100]]);
  assert.equal(t.history.length, 1);
  assert.equal(t.signals.length, 2);
  assert.equal(t.jev, true);
  assert.equal(t.can_configure, false);
  assert.equal(t.pending, 0);
  assert.equal((await sql(`select count(*)::int as n from notifications where kind = 'temperature'`))[0].n, 0);
  const [st] = await sql(`select ready, alerted_band, summary_pending from mavi_private.temperature_state where client_id = $1`, [client]);
  assert.deepEqual([st.ready, st.alerted_band, st.summary_pending], [true, 3, true]);
  const [usage] = await sql(`select * from ai_usage where kind = 'temperature'`);
  assert.equal(usage.client_id, client);
  assert.equal(Number(usage.cost_usd), 0.0004);
  assert.equal(usage.input_tokens, 8000);
});

await check("as leituras do WhatsApp mostram o grupo e as mensagens do cliente", async () => {
  await as(member);
  const t = await rpc("client_temperature", [A, client, 30, 40]);
  const wa = t.signals.find((s) => s.type === "whatsapp");
  assert.equal(wa.group, "4282 - Tráfego");
  assert.equal(typeof wa.client_lines, "number");
  assert.deepEqual(t.sources.whatsapp, { read: 1, pending: 0, failed: 0, skipped: 1, groups: 1 });
  assert.deepEqual(t.sources.meeting, { read: 1, pending: 0, failed: 0, skipped: 0 });
  // Uma fonte não esconde a outra: o limite vale por fonte.
  const one = await rpc("client_temperature", [A, client, 30, 1]);
  assert.deepEqual(one.signals.map((s) => s.type).sort(), ["meeting", "whatsapp"]);
  // Só o que o Jev leu como [cliente]: sem a agência e sem o Bruno do time.
  const m = await rpc("temperature_signal_messages", [A, whatsappSignal]);
  assert.equal(m.group_id, GROUP);
  assert.deepEqual(m.messages.map((x) => [x.who, x.text]), [["Carlos", "Não gostei dos resultados."]]);
  await rejects(() => rpc("temperature_signal_messages", [A, meetingSignal]), /Sem acesso/);
  await as(outsider);
  await rejects(() => rpc("temperature_signal_messages", [A, whatsappSignal]), /Sem acesso/);
});

await check("o texto da MAVI recebe o que mais pesou e fica guardado", async () => {
  await as(null);
  const [s] = await rpc("ai_temperature_summary_claim", [SECRET, 6]);
  assert.equal(s.client_id, client);
  assert.equal(s.client_name, "4282");
  assert.equal(s.band_name, "Quente");
  assert.equal(s.evidence.length, 2);
  assert.equal(s.evidence[0].type, "meeting");
  assert.equal(s.previous, null);
  assert.deepEqual(await rpc("ai_temperature_summary_claim", [SECRET, 6]), []);
  await rpc("ai_temperature_summary_store", [SECRET, client, "Cliente satisfeito com os resultados.",
    JSON.stringify({ model: "openai/gpt-5.6", input: 900, output: 60, cost: 0.001 })]);
  await as(member);
  const t = await rpc("client_temperature", [A, client, 30, 5]);
  assert.equal(t.summary.text, "Cliente satisfeito com os resultados.");
  assert.equal((await sql(`select count(*)::int as n from ai_usage where kind = 'temperature_text'`))[0].n, 1);
});

await check("esfriou: os supervisores do cliente recebem o aviso (e o sinal de alerta)", async () => {
  const MEET2 = uid(902);
  await sql(
    `insert into meeting_recordings(id, company_id, client_id, source_id, title, recorded_at, recorded_by_email, speakers,
      summary) values ($1,$2,$3,'m2','Crise',now(),'gabi@make.com','{Carlos Cliente}','{"overview":"Quer cancelar."}')`,
    [MEET2, A, client],
  );
  await index();
  const [c] = await claim();
  await as(null);
  await rpc("ai_temperature_store", [SECRET, JSON.stringify([
    result(c.id, 1, 0, {
      answers: {
        satisfacao: { v: 0, c: 1, e: 1 },
        permanencia: { v: 0, c: 1, e: 1 },
        relacao: { v: 0, c: 1, e: 1 },
      },
      flags: { cancelamento: 0.95 },
    }),
  ])]);
  // Com as reuniões pesando mais, a reunião muito ruim derruba a nota.
  await sql(`update temperature_settings set meeting_weight = 6`);
  await sql(`update mavi_private.temperature_state set refresh_from = current_date`);
  await refresh();
  const [st] = await sql(`select score, band from mavi_private.temperature_state where client_id = $1`, [client]);
  assert.ok(Number(st.score) < 50, String(st.score));
  const notes = await sql(`select user_id, title, body, link from notifications where kind = 'temperature' order by title`);
  assert.deepEqual([...new Set(notes.map((n) => n.user_id))], [manager], "só a supervisora da equipe");
  assert.equal(notes.length, 2);
  assert.match(notes.find((n) => /esfriou/.test(n.title)).title, /^Cliente 4282 esfriou: (Gelado|Frio) \(\d+\)$/);
  assert.match(notes.find((n) => /esfriou/.test(n.title)).body, /^Antes: Quente/);
  assert.equal(notes.find((n) => /Fala em cancelar/.test(n.title)).title, "Cliente 4282: Fala em cancelar");
  assert.equal(notes[0].link, `/drive?termometro=${client}`);
  // Com o módulo escondido, a supervisora não receberia; sem supervisor com
  // o módulo, vão os administradores (que o têm).
  await as(admin);
  await rpc("set_member_pages", [A, manager, ["temperature"]]);
  const [{ r }] = await sql(`select mavi_private.temperature_recipients($1, $2) as r`, [A, client]);
  assert.deepEqual(r, [admin]);
  await as(admin);
  await rpc("set_member_pages", [A, manager, []]);
  // A mesma situação no dia seguinte não avisa de novo.
  await sql(`update mavi_private.temperature_state set refresh_from = current_date`);
  await refresh();
  assert.equal((await sql(`select count(*)::int as n from notifications where kind = 'temperature'`))[0].n, 2);
  // O texto pede para ser refeito (a faixa mudou).
  assert.equal((await sql(`select summary_pending from mavi_private.temperature_state where client_id = $1`, [client]))[0].summary_pending, true);
  await as(manager);
  const inbox = (await db.query(`select * from public.my_notifications($1, 10)`, [A])).rows;
  assert.ok(inbox.some((n) => n.kind === "temperature" && n.link.startsWith("/drive?termometro=")));
});

await check("quem não atende o cliente não vê o termômetro; a carteira filtra", async () => {
  await as(outsider);
  await rejects(() => rpc("client_temperature", [A, client, 30, 5]), /Sem acesso/);
  await as(outsider);
  assert.deepEqual((await rpc("clients_temperature", [A])).clients, []);
  await as(member);
  const mine = await rpc("clients_temperature", [A]);
  assert.deepEqual(mine.clients.map((c) => c.name), ["4282"]);
  assert.ok(mine.clients[0].score !== null);
  assert.equal(mine.clients[0].teams[0], team);
  await as(admin);
  const all = await rpc("clients_temperature", [A]);
  assert.deepEqual(all.clients.map((c) => c.name), ["4282", "9001"]);
  assert.equal(all.clients[1].score, null);
  await as(outsider);
  await rejects(() => db.query(`select * from temperature_days`), /permission denied/);
});

await check("falhas tentam de novo até 5 vezes; versão velha fica pendente", async () => {
  await sql(`update temperature_signals set status = 'pending', dirty_at = now() - interval '1 hour', claimed_until = null
    where id = $1`, [whatsappSignal]);
  await as(null);
  for (let i = 0; i < 5; i++) {
    await sql(`update temperature_signals set claimed_until = null where id = $1`, [whatsappSignal]);
    await as(null);
    await rpc("ai_temperature_fail", [SECRET, whatsappSignal, "Jev fora do ar"]);
  }
  const [g] = await sql(`select status, attempts, last_error from temperature_signals where id = $1`, [whatsappSignal]);
  assert.deepEqual([g.status, g.attempts, g.last_error], ["failed", 5, "Jev fora do ar"]);
  await sql(`update temperature_signals set status = 'pending', attempts = 0, claimed_until = null where id = $1`, [whatsappSignal]);
  const [c] = await claim();
  await as(null);
  assert.equal(await rpc("ai_temperature_store", [SECRET, JSON.stringify([result(c.id, 99, 50)])]), 0);
  const [g2] = await sql(`select status, claimed_until from temperature_signals where id = $1`, [c.id]);
  assert.deepEqual([g2.status, g2.claimed_until], ["pending", null]);
  await as(null);
  await rpc("ai_temperature_store", [SECRET, JSON.stringify([result(c.id, 1, 70)])]);
});

await check("ajuste por produto, indicador próprio e nova versão relendo o histórico", async () => {
  await as(manager);
  const cfg = await rpc("temperature_settings", [A]);
  const engaj = cfg.indicators.find((i) => i.key === "engajamento");
  const config = {
    ...cfg.settings,
    indicators: [
      ...cfg.indicators,
      {
        product_id: product,
        kind: "score",
        name: "Confiança nas campanhas",
        description: "O quanto o cliente confia nas campanhas de tráfego pago da agência.",
        levels: ["Nenhuma", "Pouca", "Muita"],
        weight: 2,
        sources: ["meeting"],
        active: true,
      },
    ],
    rules: [{ product_id: product, indicator_id: engaj.id, active: false, weight: null }],
  };
  const saved = await rpc("save_temperature_settings", [A, JSON.stringify(config)]);
  assert.equal(saved.settings.version, 2);
  const mine = saved.indicators.find((i) => i.name === "Confiança nas campanhas");
  assert.equal(mine.key, "confianca_nas_campanhas");
  assert.deepEqual(mine.sources, ["meeting"]);
  assert.equal(saved.rules.length, 1);
  assert.deepEqual(
    (await sql(`select distinct status from temperature_signals where status <> 'skipped'`)).map((s) => s.status),
    ["pending"],
  );
  assert.equal((await sql(`select ready from mavi_private.temperature_state where client_id = $1`, [client]))[0].ready, false);
  await as(member);
  const t = await rpc("client_temperature", [A, client, 30, 5]);
  const keys = t.indicators.map((i) => i.key);
  assert.ok(!keys.includes("engajamento"), "desligado no produto do cliente");
  assert.ok(keys.includes("confianca_nas_campanhas"));
  // Só peso muda: sem nova versão.
  await as(manager);
  const again = await rpc("save_temperature_settings", [A, JSON.stringify({
    ...saved.settings,
    meeting_weight: 3,
    indicators: saved.indicators,
    rules: saved.rules,
  })]);
  assert.equal(again.settings.version, 2);
  assert.equal(Number(again.settings.meeting_weight), 3);
  // Validações.
  await as(manager);
  await rejects(() => rpc("save_temperature_settings", [A, JSON.stringify({ ...again.settings,
    bands: [{ name: "A", min: 10, color: "#000000" }, { name: "B", min: 50, color: "#ffffff" }],
    indicators: again.indicators, rules: [] })]), /começam em 0/);
  await as(manager);
  await rejects(() => rpc("save_temperature_settings", [A, JSON.stringify({ ...again.settings,
    indicators: again.indicators.filter((i) => i.kind === "flag"), rules: [] })]), /indicador de nota/);
  await as(manager);
  await rejects(() => rpc("save_temperature_settings", [A, JSON.stringify({ ...again.settings,
    indicators: [...again.indicators, { kind: "score", name: "Novo", description: "Um indicador novo qualquer", levels: ["só um"] }],
    rules: [] })]), /2 a 10 níveis/);
  await as(member);
  await rejects(() => rpc("save_temperature_settings", [A, JSON.stringify(again.settings)]), /Sem permissão/);
});

await check("o histórico relido volta a calcular e o aviso só volta depois dele", async () => {
  const claimed = await claim();
  assert.equal(claimed.length, 3);
  assert.ok(claimed.every((c) => c.version === 2));
  await as(null);
  await rpc("ai_temperature_store", [SECRET, JSON.stringify(claimed.map((c) => result(c.id, 2, 5)))]);
  await refresh();
  const [st] = await sql(`select ready, band from mavi_private.temperature_state where client_id = $1`, [client]);
  assert.equal(st.ready, true);
  assert.equal((await sql(`select count(*)::int as n from notifications where kind = 'temperature'`))[0].n, 2,
   "a nova base não avisa");
});

await check("grupo muda de cliente e reunião apagada: as leituras acompanham", async () => {
  await sql(`update whatsapp_groups set client_id = $1 where id = $2`, [other, GROUP]);
  await index();
  // Os dois dias do grupo (inclusive o que só tinha o time) vão para o outro cliente.
  const wa = await sql(`select client_id, status from temperature_signals where source_type = 'whatsapp'`);
  assert.deepEqual(wa.map((w) => [w.client_id, w.status]), [[other, "pending"], [other, "pending"]]);
  await sql(`delete from meeting_recordings where id = $1`, [MEET1]);
  await index();
  assert.equal((await sql(`select count(*)::int as n from temperature_signals where source_id = $1`, [MEET1]))[0].n, 0);
  const [st] = await sql(`select refresh_from from mavi_private.temperature_state where client_id = $1`, [client]);
  assert.ok(st.refresh_from);
});

await check("o telefone novo do time faz o grupo ser lido de novo", async () => {
  await sql(`update temperature_signals set status = 'done' where source_type = 'whatsapp' and status = 'pending'`);
  await as(admin);
  await rpc("set_member_phones", [A, outsider, ["11 91111-2222"]]);
  // Só o dia em que o número falou.
  const days = await sql(`select status from temperature_signals where source_type = 'whatsapp' order by day`);
  assert.deepEqual(days.map((d) => d.status), ["done", "pending"]);
  // Agora o Carlos é do time: o dia fica sem fala do cliente e sai sem ir ao Jev.
  const claimed = await claim();
  assert.equal(claimed.filter((c) => c.source_type === "whatsapp").length, 0);
});

await check("somar um número que não falou não lê o grupo de novo", async () => {
  await sql(`update temperature_signals set status = 'done' where source_type = 'whatsapp'`);
  await as(admin);
  await rpc("set_member_phones", [A, outsider, ["11 91111-2222", "21 97777-6666"]]);
  const days = await sql(`select status from temperature_signals where source_type = 'whatsapp' order by day`);
  assert.deepEqual(days.map((d) => d.status), ["done", "done"]);
});

await check("reservar é leve e o material de uma reunião grande cabe no tempo da API", async () => {
  // 80 pessoas na empresa e uma reunião de 3.000 falas com 12 falantes.
  const people = Array.from({ length: 80 }, (_, i) => uid(2000 + i));
  await sql(`insert into auth.users select unnest($1::uuid[])`, [people]);
  await sql(
    `insert into memberships(company_id,user_id,name,email,role,active)
     select $1, u, 'Pessoa ' || n || ' Silva', 'p' || n || '@make.com', 'member', true
     from unnest($2::uuid[]) with ordinality x(u, n)`,
    [A, people],
  );
  const BIG = uid(950);
  await sql(
    `insert into meeting_recordings(id, company_id, client_id, source_id, title, recorded_at, recorded_by_email, summary)
     values ($1,$2,$3,'big','Grande',now(),'gabi@make.com','{"overview":"Longa."}')`,
    [BIG, A, client],
  );
  await sql(
    `insert into meeting_transcripts(recording_id, company_id, speakers, segments)
     select $1, $2, array(select 'Falante Nome ' || i from generate_series(1, 12) i),
      jsonb_agg(jsonb_build_array(n, n + 1, n % 12, 'Uma fala qualquer sobre a campanha e os leads do mês ' || n))
     from generate_series(1, 3000) n`,
    [BIG, A],
  );
  await index();
  await due();
  await as(null);
  let t = performance.now();
  const list = await rpc("ai_temperature_claim", [SECRET, 60]);
  const claimMs = performance.now() - t;
  const big = list.find((c) => c.source_type === "meeting");
  assert.ok(big && !("state" in big), "a reserva não traz material");
  await as(null);
  t = performance.now();
  const m = await rpc("ai_temperature_material", [SECRET, big.id]);
  const materialMs = performance.now() - t;
  assert.ok(m.state.transcricao.length > 50000);
  console.log(`   reserva ${Math.round(claimMs)} ms · material da reunião grande ${Math.round(materialMs)} ms (PGlite)`);
  assert.ok(claimMs < 1500 && materialMs < 2500, `${claimMs} / ${materialMs}`);
  await sql(`delete from meeting_recordings where id = $1`, [BIG]);
  await index();
});

await check("o pg_cron só acorda o worker quando há trabalho", async () => {
  await sql(`delete from net.requests`);
  await refresh();
  await sql(`update mavi_private.temperature_state set summary_pending = false`);
  await sql(`update temperature_signals set status = 'done' where status = 'pending'`);
  await sql(`select mavi_private.ai_temperature_kick()`);
  assert.equal((await sql(`select count(*)::int as n from net.requests`))[0].n, 0);
  // A leitura pendente de cliente arquivado: a reserva não entrega, o acordar não chama.
  const [{ id: old }] = await sql(
    `update temperature_signals set status = 'pending', dirty_at = now() - interval '1 hour', claimed_until = null
     where id = (select id from temperature_signals limit 1) returning id`,
  );
  const [{ client_id: gone }] = await sql(`select client_id from temperature_signals where id = $1`, [old]);
  await sql(`update clients set archived = true where id = $1`, [gone]);
  await sql(`select mavi_private.ai_temperature_kick()`);
  assert.equal((await sql(`select count(*)::int as n from net.requests`))[0].n, 0, "cliente arquivado não acorda");
  await as(null);
  assert.ok(!(await rpc("ai_temperature_claim", [SECRET, 60])).some((c) => c.id === old));
  await sql(`update clients set archived = false where id = $1`, [gone]);
  await sql(`update temperature_signals set status = 'done' where id = $1`, [old]);
  await sql(`select mavi_private.temperature_daily()`);
  await sql(`select mavi_private.ai_temperature_kick()`);
  const [req] = await sql(`select body, headers from net.requests`);
  assert.equal(req.body.action, "ai-temperature");
  assert.equal(req.headers.Authorization, `Bearer ${SECRET}`);
});

await check("Dashboards: temperatura média, por faixa, por cliente e clientes em alerta", async () => {
  await refresh();
  await as(admin);
  const spec = (q, groupBy = "none") => JSON.stringify({ viz: "stat", groupBy, queries: [{ ref: "A", filters: [], ...q }] });
  const today = (await sql(`select (now() at time zone 'America/Sao_Paulo')::date::text as d`))[0].d;
  const run = (q, g) => rpc("dashboard_preview", [A, spec({ source: "temperature", ...q }, g), today, today, "{}"]);
  const total = await run({ metric: "score" });
  assert.equal(typeof total.series.A[0].v, "number");
  const byBand = await run({ metric: "clients" }, "band");
  assert.ok(byBand.series.A.every((p) => /Gelado|Frio|Morno|Quente|Fervendo|Sem nota/.test(p.l)));
  const byClient = await run({ metric: "indicator", indicator: "satisfacao" }, "client");
  assert.equal(byClient.series.A[0].l, "4282");
  const alert = await run({ metric: "alert_rate" });
  assert.ok(alert.series.A[0].v >= 0);
  const filtered = await rpc("dashboard_preview", [A, spec({ source: "temperature", metric: "clients",
    filters: [{ field: "team", values: [team] }] }), today, today, "{}"]);
  assert.equal(filtered.series.A[0].v, 1);
  await as(admin);
  await rejects(() => run({ metric: "indicator" }), /Escolha o indicador/);
  await as(admin);
  await rejects(() => run({ metric: "score" }, "person"), /Agrupamento inválido/);
});

console.log(`\n${passed} checks passed`);

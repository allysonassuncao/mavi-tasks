// Radar: excluir casos, a base dos Agentes Conversacionais e o aprendizado
// por produto (migration 20270512090000_radar_agents_learning): quem exclui,
// o Termômetro lido de novo sem as falas, os casos excluídos para a leitura,
// a base inteira ou em trechos, a conferência gravada (e o caso já resolvido
// fechado), o produto da situação, os exemplos parecidos e as lições do
// produto sugeridas pela MAVI, conferidas pelo Jev e aprovadas por um líder.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, member, manager, other] = [1, 10, 11, 13, 14].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, member, manager, other]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,email,role,active) values
   ($1,$2,'Ana Admin','ana@make.com','admin',true),($1,$3,'Bruno Tráfego','bruno@make.com','member',true),
   ($1,$4,'Gabi Gestora','gabi@make.com','manager',true),($1,$5,'Duda Design','duda@make.com','member',true)`,
  [A, admin, member, manager, other],
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

await sql(`insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`, [SECRET]);
await as(admin);
const team = await rpc("create_team", [A, "Tráfego", [member, other], [manager]]);
const client = await rpc("create_client", [A, "Clínica Sorriso", "", [team]]);
const mavi = await rpc("create_product", [A, "MAVI"]);
const ads = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [A, client, mavi, "MAVI · Clínica", team]);
await rpc("create_contract", [A, client, ads, "Make Ads · Clínica", team]);
const GROUP = uid(900);
const DAY = uid(950);
await sql(
  `insert into whatsapp_groups(id, company_id, jid, title, client_id, synced_until) values ($1,$2,'1@g.us','Clínica Sorriso',$3, now())`,
  [GROUP, A, client],
);
const today = (await sql(`select (now() at time zone 'America/Sao_Paulo')::date::text as d`))[0].d;
await sql(`insert into mavi_private.whatsapp_ai_days(id, company_id, group_id, day) values ($1,$2,$3,$4)`, [DAY, A, GROUP, today]);
const [M1, M2, M3] = [1001, 1002, 1003].map(uid);
await sql(
  `insert into whatsapp_messages(id, company_id, group_id, wa_id, sent_at, sender, sender_phone, sender_name, from_me, kind, body) values
   ($1,$4,$5,'W1', now() - interval '3 minutes','c@lid','5511911112222','Carla',false,'text','O robô está passando o preço errado da limpeza!'),
   ($2,$4,$5,'W2', now() - interval '2 minutes','c@lid','5511911112222','Carla',false,'text','Vocês são ótimos, obrigada.'),
   ($3,$4,$5,'W3', now() - interval '1 minute','c@lid','5511911112222','Carla',false,'text','Agora abrimos sábado de manhã.')`,
  [M1, M2, M3, A, GROUP],
);
// A leitura do Termômetro do dia do grupo (já lida pelo Jev).
const TEMP = uid(960);
await sql(
  `insert into temperature_signals(id, company_id, client_id, source_type, source_id, group_id, title, occurred_at, day, status, evaluated_at)
   values ($1,$2,$3,'whatsapp',$4,$5,'Clínica Sorriso', now(), $6, 'done', now())`,
  [TEMP, A, client, DAY, GROUP, today],
);
// O robô do cliente (Agente Conversacional).
const VPS = uid(970);
const FLOW = uid(971);
const PROMPT = uid(972);
const OTHER_PROMPT = uid(973);
await sql(`insert into agent_instances(id, company_id, name, base_url, key_cipher) values ($1,$2,'VPS 1','https://n8n.example.com','v1:abc')`, [VPS, A]);
await sql(
  `insert into agent_workflows(id, company_id, instance_id, n8n_id, name, active, role, client_id, contract_id) values
   ($1,$2,$3,'w1','Clínica Sorriso - Atendimento',true,'main',$4,$5), ($6,$2,$3,'w2','Outro cliente',true,'main',null,null)`,
  [FLOW, A, VPS, client, contract, uid(974)],
);
const FILLER = "Regras gerais de atendimento educado e cordial. ".repeat(34).trim();
const PROMPT_TEXT = `Você é a Bia, da Clínica Sorriso.\n\nHorário: segunda a sexta, das 8h às 18h.\n\n${FILLER}\n\n${FILLER}\n\nLimpeza custa R$ 150.`;
await sql(
  `insert into agent_prompts(id, company_id, workflow_id, node_id, node_name, prompt) values
   ($1,$2,$3,'n1','AI Agent',$4), ($5,$2,$6,'n2','AI Agent','Prompt de outro cliente.')`,
  [PROMPT, A, FLOW, PROMPT_TEXT, OTHER_PROMPT, uid(974)],
);

// ------------------------------------------------------------ Radar do cliente
await as(admin);
await rpc("radar_overview", [A]);
const [topic] = await sql(`select id, statuses from radar_topics where company_id = $1 and key = 'problemas'`, [A]);
const SIGNAL = uid(980);
await sql(
  `insert into radar_signals(id, company_id, client_id, source_type, source_id, group_id, title, occurred_at, day, status)
   values ($1,$2,$3,'whatsapp',$4,$5,'Clínica Sorriso', now(), $6, 'done')`,
  [SIGNAL, A, client, DAY, GROUP, today],
);
const newItem = async (title, mentions) => {
  const [i] = await sql(
    `insert into radar_items(company_id, client_id, topic_id, product_id, title, status, mentions)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [A, client, topic.id, mavi, title, topic.statuses[0].key, mentions.length],
  );
  for (const m of mentions)
    await sql(
      `insert into radar_mentions(company_id, item_id, signal_id, source_type, source_id, group_id, message_id, quote, speaker, role, occurred_at)
       values ($1,$2,$3,'whatsapp',$4,$5,$6,$7,'Carla',$8, now())`,
      [A, i.id, SIGNAL, DAY, GROUP, m.message, m.quote, m.role ?? "client"],
    );
  return i.id;
};

await check("base do robô: inteira quando cabe, os trechos do caso quando não; só do cliente e para quem vê", async () => {
  await as(null);
  const full = await rpc("agent_knowledge_for_worker", [SECRET, A, client, "preço da limpeza", 24000]);
  assert.equal(full.length, 1);
  assert.deepEqual([full[0].id, full[0].full, full[0].text, full[0].product], [PROMPT, true, PROMPT_TEXT, "MAVI"]);
  const pieces = await rpc("agent_knowledge_for_worker", [SECRET, A, client, "quanto custa a limpeza", 2000]);
  assert.equal(pieces[0].full, false);
  assert.ok(pieces[0].pieces.some((p) => p.includes("Limpeza custa")));
  assert.ok(pieces[0].pieces[0].startsWith("Você é a Bia"), "o começo do prompt sempre entra");
  await rejects(() => rpc("agent_knowledge_for_worker", ["errado".repeat(8), A, client, "", 2000]), /Sem permissão/);
  await as(member);
  assert.equal((await rpc("agent_knowledge", [A, client, "limpeza", 16000])).length, 1);
  await as(admin);
  assert.deepEqual(await rpc("agent_knowledge", [A, uid(999), "limpeza", 16000]), []);
});

let wrong;
let saturday;
await check("a conferência entra no item pela fala; prompt de outro cliente sai; o que já estava resolvido fecha", async () => {
  wrong = await newItem("Robô passa o preço errado", [{ message: M1, quote: "preço errado da limpeza" }]);
  saturday = await newItem("Novo horário de sábado", [{ message: M3, quote: "abrimos sábado de manhã" }]);
  await as(null);
  const n = await rpc("ai_radar_agent_store", [SECRET, SIGNAL, JSON.stringify([
    {
      message_id: M1,
      check: {
        status: "conflict", note: "O robô fala R$ 150.", done: false,
        evidence: [{ prompt_id: PROMPT, workflow: "Clínica", node: "AI Agent", excerpt: "Limpeza custa R$ 150." },
          { prompt_id: OTHER_PROMPT, workflow: "Outro", node: "AI Agent", excerpt: "Prompt de outro cliente." }],
        suggestion: { prompt_id: PROMPT, before: "Limpeza custa R$ 150.", after: "Limpeza custa R$ 180.", why: "Preço novo" },
      },
    },
    { message_id: M3, check: { status: "covered", note: "Já está.", done: true, evidence: [{ prompt_id: PROMPT, excerpt: "Horário" }] } },
    { message_id: uid(1999), check: { status: "missing" } },
  ]), JSON.stringify({ model: "claude-haiku-4-5", input: 900, output: 100, cost: 0.003 })]);
  assert.equal(n, 2);
  const [w] = await sql(`select agent_check, status from radar_items where id = $1`, [wrong]);
  assert.equal(w.agent_check.status, "conflict");
  assert.deepEqual(w.agent_check.evidence.map((e) => e.prompt_id), [PROMPT]);
  assert.equal(w.agent_check.suggestion.after, "Limpeza custa R$ 180.");
  assert.equal(w.status, topic.statuses[0].key);
  const [s] = await sql(`select status, status_by from radar_items where id = $1`, [saturday]);
  const closed = topic.statuses.find((x) => x.kind === "closed" && x.reopen) ?? topic.statuses.find((x) => x.kind === "closed");
  assert.deepEqual([s.status, s.status_by], [closed.key, null]);
  const [u] = await sql(`select kind, cost_usd::float as cost from ai_usage where module = 'radar' and kind = 'radar_agent'`);
  assert.equal(u.cost, 0.003);
  await as(member);
  await rejects(() => rpc("radar_item_extras", [A, wrong]), /não encontrado/);
  await as(manager);
  const extras = await rpc("radar_item_extras", [A, wrong]);
  assert.deepEqual([extras.can_remove, extras.has_agent, extras.agent_check.status], [true, true, "conflict"]);
});

await check("excluir um caso do Radar do cliente: só líderes, motivo guardado, Termômetro lido de novo sem a fala", async () => {
  // Outro caso com a mesma mensagem continua: essa fala segue no Termômetro.
  const kept = await newItem("Elogio", [{ message: M2, quote: "Vocês são ótimos" }]);
  const twin = await newItem("Elogio repetido", [{ message: M2, quote: "Vocês são ótimos" }]);
  const [pi] = await sql(
    `insert into personal_radar_items(company_id, client_id, group_id, kind, title, first_at, last_at, radar_item_id)
     values ($1,$2,$3,'complaint','Preço errado no robô', now(), now(), $4) returning id`,
    [A, client, GROUP, wrong],
  );
  await as(member);
  await rejects(() => rpc("remove_radar_item", [A, wrong, "mavi_error", ""]), /Só administradores e gestores/);
  await as(admin);
  await rejects(() => rpc("remove_radar_item", [A, wrong, "outro", ""]), /Escolha o motivo/);
  await rejects(() => rpc("remove_radar_item", [A, wrong, "other", " "]), /Conte o motivo/);
  const before = (await sql(`select mavi_private.temperature_material($1) as m`, [TEMP]))[0].m;
  assert.match(before.state.conversa, /preço errado/);
  const r = await rpc("remove_radar_item", [A, wrong, "mavi_error", "Era elogio, não reclamação."]);
  assert.deepEqual(r, { removed: true, temperature: 1 });
  assert.equal((await sql(`select count(*)::int as n from radar_items where id = $1`, [wrong]))[0].n, 0);
  assert.equal((await sql(`select radar_item_id from personal_radar_items where id = $1`, [pi.id]))[0].radar_item_id, null);
  const [rem] = await sql(`select radar, reason, note, title, temperature, quotes, removed_by from radar_removals where item_id = $1`, [wrong]);
  assert.deepEqual([rem.radar, rem.reason, rem.title, rem.temperature, rem.removed_by], ["client", "mavi_error", "Robô passa o preço errado", 1, admin]);
  assert.equal(rem.quotes[0].quote, "preço errado da limpeza");
  const [sig] = await sql(`select status, attempts, dirty_at < now() - interval '20 minutes' as due from temperature_signals where id = $1`, [TEMP]);
  assert.deepEqual([sig.status, sig.due], ["pending", true]);
  const after = (await sql(`select mavi_private.temperature_material($1) as m`, [TEMP]))[0].m;
  assert.doesNotMatch(after.state.conversa, /preço errado/);
  assert.match(after.state.conversa, /Vocês são ótimos/);
  // "Duplicado": nada muda no Termômetro; a fala de outro caso não sai.
  await sql(`update temperature_signals set status = 'done' where id = $1`, [TEMP]);
  assert.deepEqual(await rpc("remove_radar_item", [A, twin, "duplicate", ""]), { removed: true, temperature: 0 });
  assert.equal((await sql(`select status from temperature_signals where id = $1`, [TEMP]))[0].status, "done");
  await as(manager);
  assert.deepEqual(await rpc("remove_radar_item", [A, kept, "not_client", ""]), { removed: true, temperature: 1 });
  const last = (await sql(`select mavi_private.temperature_material($1) as m`, [TEMP]))[0].m;
  assert.doesNotMatch(last.state.conversa, /Vocês são ótimos/);
  // Para a leitura seguinte: os excluídos do cliente (o "outro motivo" não vai).
  await as(null);
  const removed = await rpc("radar_removed_for_worker", [SECRET, client]);
  assert.deepEqual(removed.map((x) => x.reason).sort(), ["duplicate", "mavi_error", "not_client"]);
  assert.equal(removed.find((x) => x.reason === "mavi_error").quote, "preço errado da limpeza");
});

await check("reunião: a fala excluída sai pelo segundo dela", async () => {
  const REC = uid(990);
  await sql(
    `insert into meeting_recordings(id, company_id, client_id, source_id, title, recorded_at) values ($1,$2,$3,'rec-1','Alinhamento', now())`,
    [REC, A, client],
  );
  await sql(
    `insert into meeting_transcripts(company_id, recording_id, speakers, segments) values ($1,$2,$3,$4)`,
    [A, REC, ["Carla"], JSON.stringify([[0, 5, 0, "O robô errou o preço."], [12.6, 15, 0, "Mas no geral está bom."]])],
  );
  const MEET = uid(991);
  await sql(
    `insert into temperature_signals(id, company_id, client_id, source_type, source_id, title, occurred_at, day, status)
     values ($1,$2,$3,'meeting',$4,'Alinhamento', now(), $5, 'done')`,
    [MEET, A, client, REC, today],
  );
  const RS = uid(992);
  await sql(
    `insert into radar_signals(id, company_id, client_id, source_type, source_id, title, occurred_at, day, status)
     values ($1,$2,$3,'meeting',$4,'Alinhamento', now(), $5, 'done')`,
    [RS, A, client, REC, today],
  );
  const [i] = await sql(
    `insert into radar_items(company_id, client_id, topic_id, title, status) values ($1,$2,$3,'Robô errou',$4) returning id`,
    [A, client, topic.id, topic.statuses[0].key],
  );
  await sql(
    `insert into radar_mentions(company_id, item_id, signal_id, source_type, source_id, at_seconds, quote, speaker, role, occurred_at)
     values ($1,$2,$3,'meeting',$4,0,'O robô errou o preço.','Carla','client', now())`,
    [A, i.id, RS, REC],
  );
  await as(admin);
  assert.equal((await rpc("remove_radar_item", [A, i.id, "mavi_error", ""])).temperature, 1);
  const m = (await sql(`select mavi_private.temperature_material($1) as m`, [MEET]))[0].m;
  assert.doesNotMatch(m.state.transcricao, /errou o preço/);
  assert.match(m.state.transcricao, /Mas no geral está bom/);
});

// ------------------------------------------------------------ Radar pessoal
const personal = async (title, message, kind = "question") => {
  const [i] = await sql(
    `insert into personal_radar_items(company_id, client_id, group_id, kind, title, first_at, last_at)
     values ($1,$2,$3,$4,$5, now(), now()) returning id`,
    [A, client, GROUP, kind, title],
  );
  await sql(`insert into personal_radar_owners(company_id, item_id, user_id, reason) values ($1,$2,$3,'role'),($1,$2,$4,'role')`, [A, i.id, member, other]);
  await sql(
    `insert into personal_radar_mentions(company_id, item_id, message_id, role, speaker, quote, at) values ($1,$2,$3,'client','Carla','x', now())`,
    [A, i.id, message],
  );
  return i.id;
};

let hours;
await check("produto e conferência no Radar pessoal: produto do cliente, a pessoa corrige, já resolvido fecha", async () => {
  hours = await personal("Horário de sábado", M3, "request");
  const price = await personal("Preço da limpeza", M1);
  await as(null);
  const n = await rpc("ai_personal_radar_extras_store", [SECRET, GROUP, JSON.stringify([
    { message_ids: [M3], product: "mavi", check: { status: "covered", note: "Já está.", done: true, evidence: [{ prompt_id: PROMPT, excerpt: "Horário" }] } },
    { message_ids: [M1], product: "Produto que não existe" },
  ]), JSON.stringify({ model: "x", input: 10, output: 1, cost: 0.001 })]);
  assert.equal(n, 2);
  const [h] = await sql(`select product_id, status, resolved_how, agent_check from personal_radar_items where id = $1`, [hours]);
  assert.deepEqual([h.product_id, h.status, h.resolved_how, h.agent_check.status], [mavi, "resolved", "knowledge", "covered"]);
  assert.equal((await sql(`select product_id from personal_radar_items where id = $1`, [price]))[0].product_id, null);
  await as(member);
  const j = await rpc("personal_radar_set_product", [A, price, ads]);
  assert.deepEqual([j.product.name, j.product_person], ["Make Ads", true]);
  assert.deepEqual(j.products.map((p) => p.name).sort(), ["MAVI", "Make Ads"]);
  await rejects(() => rpc("personal_radar_set_product", [A, price, uid(999)]), /não contrata/);
  // A MAVI não troca o que a pessoa escolheu.
  await as(null);
  await rpc("ai_personal_radar_extras_store", [SECRET, GROUP, JSON.stringify([{ message_ids: [M1], product: "MAVI" }]), "{}"]);
  assert.equal((await sql(`select product_id from personal_radar_items where id = $1`, [price]))[0].product_id, ads);
  await as(manager);
  await rejects(() => rpc("personal_radar_set_product", [A, price, mavi]), /não encontrado/);
});

await check("excluir uma situação do Radar pessoal: some para os dois, ensina a pessoa e desfaz o Termômetro", async () => {
  const M4 = uid(1004);
  await sql(
    `insert into whatsapp_messages(id, company_id, group_id, wa_id, sent_at, sender, sender_phone, sender_name, from_me, kind, body)
     values ($1,$2,$3,'W4', now(),'c@lid','5511911112222','Carla',false,'text','Que dia lindo hoje!')`,
    [M4, A, GROUP],
  );
  const chat = await personal("Cliente comentou o dia", M4);
  await sql(`update temperature_signals set status = 'done' where id = $1`, [TEMP]);
  await as(manager);
  await rejects(() => rpc("personal_radar_remove", [A, chat, "mavi_error", ""]), /não encontrado/);
  await as(member);
  const r = await rpc("personal_radar_remove", [A, chat, "mavi_error", "Só um comentário."]);
  assert.deepEqual(r, { removed: true, temperature: 1 });
  assert.equal((await sql(`select count(*)::int as n from personal_radar_items where id = $1`, [chat]))[0].n, 0);
  const [fb] = await sql(`select action, note, snapshot->>'title' as title from personal_radar_feedback where user_id = $1 order by created_at desc limit 1`, [member]);
  assert.deepEqual([fb.action, fb.title], ["not_situation", "Cliente comentou o dia"]);
  assert.match(fb.note, /^Excluída: a MAVI leu errado\. — Só um comentário\.$/);
  const m = (await sql(`select mavi_private.temperature_material($1) as m`, [TEMP]))[0].m;
  assert.doesNotMatch(m.state.conversa, /dia lindo/);
  const [b] = await sql(`select payload from realtime.messages where payload->>'kind' = 'personal_radar' order by id desc limit 1`);
  assert.deepEqual(b.payload.people.sort(), [member, other].sort());
});

await check("exemplos da resposta: os da pessoa mais parecidos primeiro e os aprovados do produto por colegas", async () => {
  const twin = await personal("Horário de domingo", M2, "request");
  await sql(`update personal_radar_items set product_id = $1 where id in ($2, $3)`, [mavi, twin, hours]);
  const other1 = await personal("Arte nova", M2, "question");
  const add = (user, itemId, final, ago) =>
    sql(
      `insert into personal_radar_feedback(company_id, item_id, user_id, action, snapshot, created_at)
       values ($1,$2,$3,'approved',jsonb_build_object('final',$4::text), now() - $5::interval)`,
      [A, itemId, user, final, ago],
    );
  await add(member, other1, "Resposta sobre arte (recente)", "1 minute");
  await add(member, hours, "Resposta sobre horário (antiga)", "3 days");
  await add(other, hours, "Duda: horário ajustado no robô", "1 day");
  await as(member);
  const ex = await rpc("personal_radar_reply_examples", [A, twin]);
  assert.equal(ex.product, "MAVI");
  assert.equal(ex.product_id, mavi);
  assert.equal(ex.mine[0], "Resposta sobre horário (antiga)");
  assert.deepEqual(ex.team, ["Duda: horário ajustado no robô"]);
  await as(manager);
  await rejects(() => rpc("personal_radar_reply_examples", [A, twin]), /não encontrado/);
});

// ------------------------------------------------------------ lições por produto
let suggestion;
await check("aprendizado por produto: fila pelos retornos, sugestão conferida pelo Jev espera um líder", async () => {
  // Já há 2 retornos (aprovados) em itens do MAVI; com 5 a fila anda na hora.
  for (let n = 0; n < 3; n++)
    await sql(
      `insert into personal_radar_feedback(company_id, item_id, user_id, action, note, snapshot) values ($1,$2,$3,'edited','',
       jsonb_build_object('draft','Vamos ver.','final','Ajustado, entra no ar às 18h.'))`,
      [A, hours, other],
    );
  const [q] = await sql(`select product_id from personal_radar_product_learning where company_id = $1`, [A]);
  assert.equal(q.product_id, mavi);
  await sql(`delete from net.requests`);
  await sql(`select mavi_private.personal_radar_kick()`);
  assert.equal((await sql(`select count(*)::int as n from net.requests where body->>'action' = 'ai-personal-radar'`))[0].n, 1);
  await as(null);
  const c = await rpc("ai_personal_radar_product_claim", [SECRET]);
  assert.deepEqual([c.product, c.product_name, c.clients], [mavi, "MAVI", 1]);
  assert.equal(c.feedback.length, 5);
  assert.ok(c.feedback.every((f) => !("user" in f) && !("user_id" in f) && !("client" in f)), "sem quem nem o cliente");
  assert.equal(await rpc("ai_personal_radar_product_claim", [SECRET]), null, "reservado");
  const n = await rpc("ai_personal_radar_product_store", [SECRET, A, mavi, JSON.stringify([
    { op: "add", kind: "reply", text: "Em ajuste no robô, diga quando entra no ar.", feedback: [] },
    { op: "add", kind: "reply", text: "Em ajuste no robô, diga quando entra no ar." },
    { op: "add", kind: "outro", text: "Tipo inválido." },
  ]), JSON.stringify({ model: "x", input: 100, cost: 0.002 })]);
  assert.equal(n, 1);
  const [l] = await sql(`select id, status, origin, scope from personal_radar_lessons where product_id = $1`, [mavi]);
  assert.deepEqual([l.status, l.origin, l.scope], ["checking", "mavi", "product"]);
  suggestion = l.id;
  const chk = await rpc("ai_personal_radar_check_claim", [SECRET]);
  assert.deepEqual([chk.id, chk.scope, chk.target], [suggestion, "product", "MAVI"]);
  await rpc("ai_personal_radar_check_store", [SECRET, suggestion, true, null, "{}"]);
  assert.equal((await sql(`select status from personal_radar_lessons where id = $1`, [suggestion]))[0].status, "suggested");
  // Esperando o líder: ainda não vale na resposta.
  await as(member);
  assert.deepEqual(await rpc("personal_radar_reply_lessons", [A, client, mavi]), []);
});

await check("líderes aprovam, escrevem e pausam; os demais só veem as em uso dos produtos que atendem", async () => {
  await as(member);
  let view = await rpc("personal_radar_product_lessons", [A]);
  assert.equal(view.can_edit, false);
  assert.deepEqual(view.products.find((p) => p.id === mavi).lessons, []);
  await rejects(() => rpc("set_personal_radar_product_lesson", [A, suggestion, "active"]), /Só administradores e gestores/);
  await rejects(() => rpc("save_personal_radar_product_lesson", [A, null, mavi, "reply", "Lição de quem não pode."]), /Só administradores/);
  await as(manager);
  view = await rpc("personal_radar_product_lessons", [A]);
  const p = view.products.find((x) => x.id === mavi);
  assert.deepEqual([p.suggested, p.lessons[0].status, p.lessons[0].product.name], [1, "suggested", "MAVI"]);
  const ok = await rpc("set_personal_radar_product_lesson", [A, suggestion, "active"]);
  assert.match(ok.check_note, /Aprovada por Gabi Gestora/);
  const own = await rpc("save_personal_radar_product_lesson", [A, null, ads, "reply", "Traga o CPL do período."]);
  assert.deepEqual([own.status, own.origin, own.scope], ["active", "leader", "product"]);
  await as(member);
  const lessons = await rpc("personal_radar_reply_lessons", [A, client, mavi]);
  assert.deepEqual(lessons, [{ scope: "product", text: "Em ajuste no robô, diga quando entra no ar." }]);
  // Sem o produto do item: as dos produtos do cliente.
  assert.equal((await rpc("personal_radar_reply_lessons", [A, client, null])).length, 2);
  await as(manager);
  await rpc("set_personal_radar_product_lesson", [A, own.id, "paused"]);
  await as(member);
  assert.equal((await rpc("personal_radar_reply_lessons", [A, client, null])).length, 1);
  // A MAVI não sugere de novo o que já existe.
  await as(null);
  await sql(`update personal_radar_product_learning set claimed_until = null`);
  assert.equal(await rpc("ai_personal_radar_product_store", [SECRET, A, mavi, JSON.stringify([
    { op: "add", kind: "reply", text: "em ajuste no robô, diga quando entra no ar." },
    { op: "update", id: suggestion, text: "Mexendo na aprovada." },
  ]), "{}"]), 0);
});

console.log(`\n${passed} verificações passaram.`);

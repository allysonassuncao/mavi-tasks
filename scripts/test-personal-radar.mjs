// Radar pessoal (migration 20270304090000_personal_radar): o módulo liberado
// pelo administrador e ligado pela pessoa, os participantes dos grupos, o
// ritmo da varredura, quem a MAVI lê em cada grupo (participante + cliente da
// equipe + teto), o material com menções e respostas, os itens com donos e
// repetição, a resolução pela fala do time, a reabertura, as ações da pessoa,
// quem vê a lista de quem e a configuração.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, member, outsider, manager, other] = [1, 10, 11, 12, 13, 14].map(uid);
const SECRET = "s".repeat(40);
const WA_SECRET = "w".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, member, outsider, manager, other]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,email,role,active) values
   ($1,$2,'Ana Admin','ana@make.com','admin',true),($1,$3,'Bruno Tráfego','bruno@make.com','member',true),
   ($1,$4,'Carla Fora','carla@make.com','member',true),($1,$5,'Gabi Gestora','gabi@make.com','manager',true),
   ($1,$6,'Duda Design','duda@make.com','member',true)`,
  [A, admin, member, outsider, manager, other],
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
/** Funções que devolvem linhas (returns table). */
async function rows(name, args) {
  return (
    await db.query(
      `select coalesce(jsonb_agg(to_jsonb(t)), '[]') as result from public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) t`,
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
const claim = async () => {
  await as(null);
  return rpc("ai_personal_radar_claim", [SECRET, 10]);
};
const material = async (group) => {
  await as(null);
  return rpc("ai_personal_radar_material", [SECRET, group]);
};
const store = async (group, result) => {
  await as(null);
  return rpc("ai_personal_radar_store", [SECRET, group, JSON.stringify(result)]);
};
const lineOf = (m, text) => m.lines.find((l) => l.text.includes(text));
const touch = (group) => sql(`update whatsapp_groups set synced_until = now() where id = $1`, [group]);

await sql(`insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`, [SECRET]);
await sql(
  `insert into mavi_private.whatsapp_config(company_id, url, secret, last_sweep_at) values($1,'https://app.example/api/whatsapp',$2, now() - interval '20 minutes')`,
  [A, WA_SECRET],
);
await as(admin);
const team = await rpc("create_team", [A, "Tráfego", [member, other], [manager]]);
const client = await rpc("create_client", [A, "4282", "", [team]]);
const foreign = await rpc("create_client", [A, "9001", "", []]);
const product = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [A, client, product, "Make Ads · 4282", team]);
const GROUP = uid(900);
const FOREIGN_GROUP = uid(901);
await sql(
  `insert into whatsapp_groups(id, company_id, jid, title, client_id, synced_until) values
   ($1,$3,'1@g.us','4282 - Make Ads',$4, now()), ($2,$3,'2@g.us','9001 - Outro',$5, now())`,
  [GROUP, FOREIGN_GROUP, A, client, foreign],
);
await as(member);
await rpc("set_member_phones", [A, member, ["(11) 98765-4321"]]);
await as(other);
await rpc("set_member_phones", [A, other, ["(11) 97777-0000"]]);
await as(manager);
await rpc("set_member_phones", [A, manager, ["(11) 96666-0000"]]);

await check("o colaborador só liga depois que o administrador libera", async () => {
  await as(member);
  const s = await rpc("personal_radar_state", [A]);
  assert.equal(s.allowed, false);
  assert.equal(s.active, false);
  await rejects(() => rpc("set_personal_radar", [A, true, null]), /liberado/);
  await as(admin);
  // Liberar = tirar dos ocultos (a tela de Módulos manda a lista de ocultos).
  await rpc("set_member_pages", [A, member, ["overview", "campaigns", "radar", "dashboards", "financeMedia"]]);
  await rpc("set_member_pages", [A, other, ["overview", "campaigns", "radar", "dashboards", "financeMedia"]]);
  const [m] = await sql(`select shown_pages from memberships where user_id = $1`, [member]);
  assert.deepEqual(m.shown_pages, ["personalRadar"]);
  await as(member);
  assert.equal((await rpc("personal_radar_state", [A])).allowed, true);
  // Gestores têm por padrão; ocultado, não.
  await as(manager);
  assert.equal((await rpc("personal_radar_state", [A])).allowed, true);
  await as(outsider);
  assert.equal((await rpc("personal_radar_state", [A])).allowed, false);
});

await check("sem ninguém usando, nem participantes nem varredura de 15 minutos", async () => {
  await as(null);
  const st = await rpc("whatsapp_worker_state", [WA_SECRET]);
  assert.equal(st.sweep_due, false);
  assert.equal(st.members_due, false);
  assert.deepEqual(await rows("whatsapp_claim_members", [WA_SECRET, 10]), []);
});

await check("a pessoa liga: varredura no ritmo do Radar pessoal e participantes lidos", async () => {
  await as(member);
  const s = await rpc("set_personal_radar", [A, true, "Sou do tráfego: campanhas, verba, CPL e relatórios."]);
  assert.equal(s.active, true);
  assert.ok(s.started_at);
  await as(other);
  await rpc("set_personal_radar", [A, true, "Faço as artes e os criativos."]);
  await as(null);
  const st = await rpc("whatsapp_worker_state", [WA_SECRET]);
  assert.equal(st.sweep_due, true);
  assert.equal(st.members_due, true);
  const groups = await rows("whatsapp_claim_members", [WA_SECRET, 10]);
  assert.deepEqual(groups.map((g) => g.jid).sort(), ["1@g.us", "2@g.us"]);
  const n = await rpc("whatsapp_store_members", [WA_SECRET, GROUP, JSON.stringify([
    { jid: "5511987654321@s.whatsapp.net", lid: "184@lid", phone: "5511987654321", name: "Bruno", admin: false },
    { jid: "5511977770000@s.whatsapp.net", lid: "185@lid", phone: "5511977770000", name: "Duda" },
    { jid: "5511911112222@s.whatsapp.net", lid: "186@lid", phone: "5511911112222", name: "Carlos Cliente" },
    { jid: "999@lid", lid: "999@lid", name: "Sem número" },
    { jid: "5511911112222@s.whatsapp.net", phone: "5511911112222", name: "Carlos repetido" },
  ]), null]);
  assert.equal(n, 4);
  await rpc("whatsapp_store_members", [WA_SECRET, FOREIGN_GROUP, JSON.stringify([
    { jid: "5511987654321@s.whatsapp.net", phone: "5511987654321", name: "Bruno" },
  ]), null]);
  const [g] = await sql(`select member_count, members_at is not null as read from whatsapp_groups where id = $1`, [GROUP]);
  assert.deepEqual([g.member_count, g.read], [4, true]);
  // Leu de novo: quem saiu do grupo sai da lista.
  await rpc("whatsapp_store_members", [WA_SECRET, GROUP, JSON.stringify([
    { jid: "5511987654321@s.whatsapp.net", lid: "184@lid", phone: "5511987654321", name: "Bruno" },
    { jid: "5511977770000@s.whatsapp.net", lid: "185@lid", phone: "5511977770000", name: "Duda" },
    { jid: "5511911112222@s.whatsapp.net", lid: "186@lid", phone: "5511911112222", name: "Carlos Cliente" },
  ]), null]);
  assert.equal((await sql(`select count(*)::int as n from whatsapp_group_members where group_id = $1`, [GROUP]))[0].n, 3);
  await as(member);
  // Só o grupo do cliente da equipe (o outro também tem o Bruno, mas não é cliente dele).
  assert.equal((await rpc("personal_radar_state", [A])).groups, 1);
});

let first;
await check("o material: mensagens novas, quem é do time, menções e respostas", async () => {
  await sql(
    `insert into whatsapp_messages(id, company_id, group_id, wa_id, sent_at, sender, sender_phone, sender_name, from_me, kind, body, quoted_wa_id, extra) values
     ($1,$4,$5,'W1', now() - interval '2 hours','186@lid','5511911112222','Carlos',false,'text','Bom dia! O CPL subiu muito essa semana, o que houve?', null, '{}'),
     ($2,$4,$5,'W2', now() - interval '110 minutes','186@lid','5511911112222','Carlos',false,'text','@184 consegue ver hoje? E a arte nova do post, sai quando?', null, '{"mentions":["184@lid"]}'),
     ($3,$4,$5,'W3', now() - interval '100 minutes','185@lid','5511977770000','Duda',false,'text','Bom dia Carlos!', 'W2', '{}'),
     ($6,$4,$5,'W4', now() - interval '90 minutes','186@lid','5511911112222','Carlos',false,'reaction','👍', null, '{}'),
     ($7,$4,$5,'W0', now() - interval '45 days','186@lid','5511911112222','Carlos',false,'text','Mensagem velha demais', null, '{}')`,
    [uid(1001), uid(1002), uid(1003), A, GROUP, uid(1004), uid(1005)],
  );
  await touch(GROUP);
  const claimed = await claim();
  assert.deepEqual(claimed.map((c) => c.group_id), [GROUP]);
  // Reservado: não sai de novo.
  assert.deepEqual(await claim(), []);
  first = await material(GROUP);
  assert.equal(first.client_name, "4282");
  assert.deepEqual(first.lines.map((l) => l.text.slice(0, 9)), ["Bom dia! ", "@184 cons", "Bom dia C"]);
  const ask = lineOf(first, "@184");
  assert.equal(ask.role, "client");
  assert.deepEqual(ask.to, [member]);
  const reply = lineOf(first, "Bom dia Carlos");
  assert.equal(reply.role, "team");
  assert.equal(reply.who, "Duda Design");
  assert.equal(reply.reply_to, undefined); // respondeu ao cliente, não a alguém do time
  assert.match(reply.reply_text, /arte nova/);
  assert.equal(first.more, false);
  assert.equal(first.until_id, uid(1003));
  const people = Object.fromEntries(first.people.map((p) => [p.name, p]));
  assert.deepEqual(Object.keys(people).sort(), ["Bruno Tráfego", "Duda Design"]);
  assert.deepEqual(people["Bruno Tráfego"].teams, ["Tráfego"]);
  assert.match(people["Duda Design"].about, /artes/);
});

let cpl;
let art;
await check("os itens: donos conferidos, falas só do grupo e o custo dividido", async () => {
  const stored = await store(GROUP, {
    until_at: first.until_at,
    until_id: first.until_id,
    people: [member, other, outsider],
    items: [
      {
        item_id: null, kind: "complaint", title: "CPL subiu na semana", summary: "Cliente quer saber por que o CPL subiu.",
        urgency: 2, owners: [{ user_id: member, reason: "mention", why: "Te marcaram" }, { user_id: outsider, reason: "role" }],
        mentions: [{ message_id: uid(1001), quote: "O CPL subiu muito essa semana" }, { message_id: uid(1002) }, { message_id: uid(1005) }],
      },
      {
        item_id: null, kind: "question", title: "Quando sai a arte nova do post", urgency: 1,
        owners: [{ user_id: other, reason: "role", why: "Assunto de arte" }], mentions: [{ message_id: uid(1002), quote: "E a arte nova do post, sai quando?" }],
      },
      // Sem fala do cliente não vira item; mensagem de outro grupo também não.
      { item_id: null, kind: "request", title: "Só o time falando", owners: [], mentions: [{ message_id: uid(1003) }] },
      { item_id: null, kind: "bogus", title: "Tipo inválido", owners: [], mentions: [{ message_id: uid(1001) }] },
      { item_id: null, kind: "request", title: "Sem nenhuma fala", owners: [], mentions: [{ message_id: "nao-e-uuid" }] },
      // Ninguém indicado: vai para todos os lidos.
      { item_id: null, kind: "request", title: "Pedido geral do cliente", owners: [], mentions: [{ message_id: uid(1001) }] },
    ],
    resolved: [],
    usage: { model: "claude-haiku-4-5", input: 1000, output: 200, cost: 0.02 },
  });
  assert.equal(stored, 3);
  const items = await sql(`select id, title, asks, kind from personal_radar_items order by title`);
  assert.deepEqual(items.map((i) => i.title), ["CPL subiu na semana", "Pedido geral do cliente", "Quando sai a arte nova do post"]);
  cpl = items.find((i) => i.title.startsWith("CPL")).id;
  art = items.find((i) => i.title.startsWith("Quando")).id;
  // A mensagem velha (45 dias) era do grupo, então conta; foram 3 do cliente.
  assert.equal(items.find((i) => i.id === cpl).asks, 3);
  const owners = await sql(`select item_id, user_id, reason from personal_radar_owners order by item_id, user_id`);
  assert.ok(!owners.some((o) => o.user_id === outsider), "quem não foi lido não vira dono");
  assert.deepEqual(owners.filter((o) => o.item_id === cpl).map((o) => o.reason), ["mention"]);
  const general = items.find((i) => i.title.startsWith("Pedido")).id;
  assert.deepEqual(owners.filter((o) => o.item_id === general).map((o) => o.reason), ["general", "general"]);
  const usage = await sql(`select user_id, cost_usd::float as cost from ai_usage where module = 'personal_radar' order by user_id`);
  assert.deepEqual(usage.map((u) => [u.user_id, u.cost]), [[member, 0.01], [other, 0.01]]);
  const [q] = await sql(`select cursor_id, claimed_until from personal_radar_groups where group_id = $1`, [GROUP]);
  assert.deepEqual([q.cursor_id, q.claimed_until], [uid(1003), null]);
  const broadcast = await sql(`select payload from realtime.messages where payload->>'kind' = 'personal_radar'`);
  assert.equal(broadcast.length, 1);
});

await check("nada novo: o grupo fica em dia sem chamar a MAVI", async () => {
  await touch(GROUP);
  assert.equal((await claim()).length, 1);
  assert.equal(await material(GROUP), null);
  assert.deepEqual(await claim(), []);
});

await check("o cliente cobra de novo: soma no item; o time responde: resolvido por quem respondeu", async () => {
  await sql(
    `insert into whatsapp_messages(id, company_id, group_id, wa_id, sent_at, sender, sender_phone, sender_name, from_me, kind, body, quoted_wa_id) values
     ($1,$3,$4,'W5', now() - interval '30 minutes','186@lid','5511911112222','Carlos',false,'text','Pessoal, e o CPL??', null),
     ($2,$3,$4,'W6', now() - interval '20 minutes','184@lid','5511987654321','Bruno',false,'text','Carlos, ajustei o público, o CPL já voltou ao normal.', 'W5')`,
    [uid(1006), uid(1007), A, GROUP],
  );
  await touch(GROUP);
  await claim();
  const m = await material(GROUP);
  assert.deepEqual(m.lines.map((l) => l.role), ["client", "team"]);
  assert.equal(lineOf(m, "ajustei").who, "Bruno Tráfego");
  assert.ok(m.items.some((i) => i.id === cpl && i.asks === 3));
  assert.ok(m.context.length >= 3);
  await store(GROUP, {
    until_at: m.until_at, until_id: m.until_id, people: [member, other],
    items: [{ item_id: cpl, kind: "complaint", title: "", urgency: 3, owners: [], mentions: [{ message_id: uid(1006) }] }],
    // A fala do cliente não resolve; a do time, sim.
    resolved: [{ item_id: art, message_id: uid(1006) }, { item_id: cpl, message_id: uid(1007) }],
    usage: { cost: 0 },
  });
  const [i] = await sql(`select asks, urgency, status, resolved_how, resolved_by_name, resolved_by from personal_radar_items where id = $1`, [cpl]);
  assert.deepEqual([i.asks, i.urgency, i.status, i.resolved_how, i.resolved_by_name, i.resolved_by], [4, 3, "resolved", "auto", "Bruno Tráfego", member]);
  const [a] = await sql(`select status from personal_radar_items where id = $1`, [art]);
  assert.equal(a.status, "open");
});

await check("o cliente volta ao assunto resolvido: o item reabre", async () => {
  await sql(
    `insert into whatsapp_messages(id, company_id, group_id, wa_id, sent_at, sender, sender_phone, sender_name, from_me, kind, body) values
     ($1,$2,$3,'W7', now() - interval '5 minutes','186@lid','5511911112222','Carlos',false,'text','O CPL subiu de novo hoje.')`,
    [uid(1008), A, GROUP],
  );
  await touch(GROUP);
  await claim();
  const m = await material(GROUP);
  await store(GROUP, {
    until_at: m.until_at, until_id: m.until_id, people: [member],
    items: [{ item_id: cpl, owners: [], mentions: [{ message_id: uid(1008) }] }], resolved: [], usage: { cost: 0 },
  });
  const [i] = await sql(`select status, reopened_at is not null as reopened, resolved_by_name, asks from personal_radar_items where id = $1`, [cpl]);
  assert.deepEqual([i.status, i.reopened, i.resolved_by_name, i.asks], ["open", true, null, 5]);
});

await check("a lista da pessoa: só os itens dela, com motivo, falas e outros donos", async () => {
  await as(member);
  const r = await rpc("personal_radar_items", [A, null, JSON.stringify({ status: "open" })]);
  assert.deepEqual(r.items.map((i) => i.title), ["CPL subiu na semana", "Pedido geral do cliente"]);
  assert.deepEqual(r.counts, { open: 2, resolved: 0, dismissed: 0 });
  const c = r.items[0];
  assert.equal(c.reason, "mention");
  assert.equal(c.why, "Te marcaram");
  assert.equal(c.client.name, "4282");
  assert.equal(c.group.title, "4282 - Make Ads");
  assert.equal(c.mention_count, 6); // 5 do cliente + a resposta do Bruno
  assert.equal(c.mentions.length, 4);
  assert.deepEqual(r.items[1].others, ["Duda Design"]);
  await as(other);
  const d = await rpc("personal_radar_items", [A, null, JSON.stringify({ q: "arte" })]);
  assert.deepEqual(d.items.map((i) => i.title), ["Quando sai a arte nova do post"]);
});

await check("quem vê a lista de quem: gestor e supervisor, só leitura; colega não", async () => {
  await as(manager);
  assert.equal((await rpc("personal_radar_items", [A, member, "{}"])).items.length, 2);
  const s = await rpc("personal_radar_state", [A]);
  assert.deepEqual(s.viewable.map((p) => p.name), ["Bruno Tráfego", "Duda Design"]);
  await rejects(() => rpc("personal_radar_act", [A, cpl, "resolved", ""]), /não encontrado/);
  await as(other);
  await rejects(() => rpc("personal_radar_items", [A, member, "{}"]), /Sem permissão/);
  await as(member);
  await rejects(() => rpc("personal_radar_items", [A, manager, "{}"]), /Sem permissão/);
});

await check("não é comigo: sai da lista dela, fica no aprendizado e vira exemplo para a MAVI", async () => {
  await as(other);
  const general = (await rpc("personal_radar_items", [A, null, JSON.stringify({ q: "Pedido" })])).items[0];
  const r = await rpc("personal_radar_act", [A, general.id, "not_mine", "Isso é do tráfego."]);
  assert.equal(r.state, "dismissed");
  const list = await rpc("personal_radar_items", [A, null, "{}"]);
  assert.deepEqual(list.counts, { open: 1, resolved: 0, dismissed: 1 });
  const [f] = await sql(`select action, note, snapshot->>'title' as title from personal_radar_feedback`);
  assert.deepEqual([f.action, f.note, f.title], ["not_mine", "Isso é do tráfego.", "Pedido geral do cliente"]);
  // Continua aberto para o outro dono.
  await as(member);
  assert.equal((await rpc("personal_radar_items", [A, null, "{}"])).counts.open, 2);
  await sql(
    `insert into whatsapp_messages(id, company_id, group_id, wa_id, sent_at, sender, sender_phone, from_me, kind, body) values
     ($1,$2,$3,'W8', now() - interval '1 minute','186@lid','5511911112222',false,'text','Obrigado!')`,
    [uid(1009), A, GROUP],
  );
  await touch(GROUP);
  await claim();
  const m = await material(GROUP);
  const duda = m.people.find((p) => p.name === "Duda Design");
  assert.deepEqual(duda.not_mine, ["Pedido geral do cliente"]);
  await store(GROUP, { until_at: m.until_at, until_id: m.until_id, people: [member, other], items: [], resolved: [], usage: { cost: 0 } });
});

await check("resolver e reabrir à mão", async () => {
  await as(member);
  const r = await rpc("personal_radar_act", [A, cpl, "resolved", ""]);
  assert.equal(r.status, "resolved");
  assert.equal(r.resolved_how, "person");
  assert.equal(r.resolved_by_name, "Bruno Tráfego");
  const back = await rpc("personal_radar_act", [A, cpl, "reopened", ""]);
  assert.equal(back.status, "open");
  await rejects(() => rpc("personal_radar_act", [A, cpl, "apagar", ""]), /inválida/);
});

await check("teto do mês: quem chegou nele sai da leitura", async () => {
  await as(admin);
  await rpc("set_personal_radar_cap", [A, member, 0.01]);
  await rpc("set_personal_radar_cap", [A, other, 0.01]);
  const people = await rpc("personal_radar_people", [A]);
  const bruno = people.find((p) => p.name === "Bruno Tráfego");
  assert.deepEqual([bruno.active, bruno.allowed, bruno.cap, bruno.groups], [true, true, 0.01, 1]);
  assert.ok(bruno.spent >= 0.01);
  await sql(
    `insert into whatsapp_messages(id, company_id, group_id, wa_id, sent_at, sender, sender_phone, from_me, kind, body) values
     ($1,$2,$3,'W10', now(),'186@lid','5511911112222',false,'text','Mais uma dúvida')`,
    [uid(1010), A, GROUP],
  );
  await touch(GROUP);
  assert.deepEqual(await claim(), []);
  await as(admin);
  await rpc("set_personal_radar_cap", [A, member, null]);
  assert.equal((await claim()).length, 1);
  const m = await material(GROUP);
  assert.deepEqual(m.people.map((p) => p.name), ["Bruno Tráfego"]);
  await store(GROUP, { until_at: m.until_at, until_id: m.until_id, people: [member], items: [], resolved: [], usage: { cost: 0 } });
  await as(admin);
  await rejects(() => rpc("set_personal_radar_cap", [A, member, 5000]), /teto/);
  await as(manager);
  await rejects(() => rpc("personal_radar_people", [A]), /administradores/);
});

await check("configuração: ritmo para líderes, histórico e teto só para administradores", async () => {
  await as(member);
  await rejects(() => rpc("set_personal_radar_settings", [A, 10, null, null]), /administradores e gestores/);
  await as(manager);
  const s = await rpc("set_personal_radar_settings", [A, 10, null, null]);
  assert.equal(s.settings.interval_minutes, 10);
  await rejects(() => rpc("set_personal_radar_settings", [A, 10, null, 50]), /Só administradores/);
  await as(admin);
  await rejects(() => rpc("set_personal_radar_settings", [A, 2, null, null]), /entre 5 e 60/);
  const t = await rpc("set_personal_radar_settings", [A, 15, 20, 25]);
  assert.deepEqual(t.settings, { interval_minutes: 15, history_days: 20, monthly_cap_usd: 25 });
  assert.equal(t.can_configure, true);
});

await check("quem liga pela primeira vez traz o histórico dos grupos já lidos", async () => {
  await as(admin);
  await rpc("set_member_pages", [A, admin, []]);
  await sql(`insert into team_members(company_id, team_id, user_id) values ($1,$2,$3)`, [A, team, admin]);
  await rpc("set_member_phones", [A, admin, ["(11) 95555-0000"]]);
  // Lida a lista de participantes, ela vale (falar no grupo não basta).
  await as(null);
  await rpc("whatsapp_store_members", [WA_SECRET, GROUP, JSON.stringify([
    { jid: "5511987654321@s.whatsapp.net", lid: "184@lid", phone: "5511987654321", name: "Bruno" },
    { jid: "5511977770000@s.whatsapp.net", lid: "185@lid", phone: "5511977770000", name: "Duda" },
    { jid: "5511911112222@s.whatsapp.net", lid: "186@lid", phone: "5511911112222", name: "Carlos Cliente" },
  ]), null]);
  await as(admin);
  assert.equal((await rpc("personal_radar_state", [A])).groups, 0);
  await as(null);
  await rpc("whatsapp_store_members", [WA_SECRET, GROUP, JSON.stringify([
    { jid: "5511987654321@s.whatsapp.net", lid: "184@lid", phone: "5511987654321", name: "Bruno" },
    { jid: "5511977770000@s.whatsapp.net", lid: "185@lid", phone: "5511977770000", name: "Duda" },
    { jid: "5511911112222@s.whatsapp.net", lid: "186@lid", phone: "5511911112222", name: "Carlos Cliente" },
    { jid: "5511955550000@s.whatsapp.net", phone: "5511955550000", name: "Ana" },
  ]), null]);
  await as(admin);
  assert.equal((await rpc("personal_radar_state", [A])).groups, 1);
  await sql(
    `insert into whatsapp_messages(company_id, group_id, wa_id, sent_at, sender, sender_phone, from_me, kind, body) values
     ($1,$2,'W11', now() - interval '3 days','x','5511955550000',false,'text','Ana aqui, pessoal.')`,
    [A, GROUP],
  );
  const before = (await sql(`select cursor_at from personal_radar_groups where group_id = $1`, [GROUP]))[0].cursor_at;
  assert.ok(new Date(before) > new Date(Date.now() - 86400_000));
  await rpc("set_personal_radar", [A, true, ""]);
  const after = (await sql(`select cursor_at from personal_radar_groups where group_id = $1`, [GROUP]))[0].cursor_at;
  assert.ok(new Date(after) < new Date(Date.now() - 19 * 86400_000));
  // As falas já ligadas a um item vão marcadas: a MAVI só junta a nova dona.
  assert.equal((await claim()).length, 1);
  const m = await material(GROUP);
  assert.equal(lineOf(m, "O CPL subiu muito").item, cpl);
  assert.ok(m.people.some((p) => p.name === "Ana Admin"));
  // Desligar e ligar de novo não volta o histórico.
  await store(GROUP, { until_at: m.until_at, until_id: m.until_id, people: [admin], items: [], resolved: [], usage: { cost: 0 } });
  await as(admin);
  await rpc("set_personal_radar", [A, false, null]);
  await rpc("set_personal_radar", [A, true, null]);
  const again = (await sql(`select cursor_at from personal_radar_groups where group_id = $1`, [GROUP]))[0].cursor_at;
  assert.ok(new Date(again) > new Date(after));
});

await check("Quem usa qual modelo aceita as funcionalidades do Radar pessoal", async () => {
  await sql(
    `insert into mavi_private.ai_providers(id, company_id, name, kind, base_url, key_cipher, key_hint, models) values
     ($1,$2,'Claude','anthropic','https://api.anthropic.com','v1:x','abcd','[{"id":"claude-haiku-4-5"}]')`,
    [uid(800), A],
  );
  await as(admin);
  await rpc("ai_set_route", [A, "feature", null, uid(800), "claude-haiku-4-5", "personal_radar"]);
  await rpc("ai_set_route", [A, "feature", null, uid(800), "claude-haiku-4-5", "personal_assistant"]);
  const routes = await sql(`select feature from mavi_private.ai_routes where feature like 'personal%' order by feature`);
  assert.deepEqual(routes.map((r) => r.feature), ["personal_assistant", "personal_radar"]);
});

// ------------------------------------------------------------ Fase 2: a resposta
await check("a próxima resposta a escrever é a do item aberto mais urgente", async () => {
  await as(member);
  assert.equal(await rpc("personal_radar_draft_next", [A]), cpl);
  await as(outsider);
  assert.equal(await rpc("personal_radar_draft_next", [A]), null);
});

let draftMaterial;
await check("começar a resposta: reserva e devolve o material com o que dá para linkar", async () => {
  await sql(
    `insert into meeting_recordings(id, company_id, client_id, source_id, title, recorded_at, recorded_by_email, speakers)
     values ($1,$2,$3,'rec1','Alinhamento de setembro', now() - interval '5 days','bruno@make.com','{Bruno,Carlos}')`,
    [uid(1100), A, client],
  );
  await sql(
    `insert into drive_files(id, company_id, name, content_type, size_bytes, path, status, uploaded_by, client_id)
     values ($1,$2,'relatorio-setembro.pdf','application/pdf',1000,'drive/a/rel.pdf','ready',$3,$4)`,
    [uid(1101), A, admin, client],
  );
  await as(member);
  draftMaterial = await rpc("personal_radar_draft_start", [A, cpl, false, null]);
  assert.equal(draftMaterial.status, "claimed");
  assert.equal(draftMaterial.item.title, "CPL subiu na semana");
  assert.equal(draftMaterial.item.client_name, "4282");
  assert.ok(draftMaterial.quotes.some((q) => /CPL/.test(q.text)));
  assert.ok(draftMaterial.conversation.length >= 5);
  assert.equal(draftMaterial.person.name, "Bruno Tráfego");
  assert.match(draftMaterial.person.about, /tráfego/);
  assert.deepEqual(draftMaterial.shareables.recordings.map((r) => r.title), ["Alinhamento de setembro"]);
  assert.deepEqual(draftMaterial.shareables.files.map((f) => [f.name, f.can_share ?? false]), [["relatorio-setembro.pdf", false]]);
  // Colaborador sem Campanhas: as campanhas não entram.
  assert.deepEqual(draftMaterial.shareables.campaigns, []);
  // Sendo escrita: a segunda vez só diz o estado.
  assert.deepEqual(await rpc("personal_radar_draft_start", [A, cpl, false, null]), { status: "running" });
  // A fila passa para o próximo item.
  const next = await rpc("personal_radar_draft_next", [A]);
  assert.ok(next && next !== cpl);
  // Quem não é dona não começa.
  await as(other);
  await rejects(() => rpc("personal_radar_draft_start", [A, cpl, false, null]), /não encontrado/);
});

await check("gravar a resposta: aparece na lista, custo no teto da pessoa", async () => {
  await as(member);
  const item = await rpc("personal_radar_draft_store", [A, cpl, JSON.stringify({
    reply: "Oi Carlos! Ajustei o público ontem e o CPL já voltou para R$ 12. Segue o relatório: {{A1}}",
    evidence: [{ title: "Campanha de setembro", detail: "CPL caiu de R$ 19 para R$ 12 depois do ajuste", type: "campaign" }],
    actions: [{ key: "A1", kind: "file", id: uid(1101), label: "Link do relatório de setembro" }, { kind: "folder", id: "x" }],
    checks: ["Confira o CPL de hoje antes de mandar."],
    confidence: "high",
    model: "claude-sonnet-5-5",
  }), JSON.stringify({ model: "claude-sonnet-5-5", input: 9000, output: 400, embedding: 200, cost: 0.04 })]);
  assert.equal(item.reply.status, "done");
  assert.match(item.reply.text, /\{\{A1\}\}/);
  assert.deepEqual(item.reply.actions.map((a) => a.kind), ["file"]);
  assert.equal(item.reply.stale, false);
  assert.equal(item.reply.version, 1);
  const [u] = await sql(`select user_id, kind, cost_usd::float as cost from ai_usage where kind = 'reply'`);
  assert.deepEqual([u.user_id, u.kind, u.cost], [member, "reply", 0.04]);
  const list = await rpc("personal_radar_items", [A, null, "{}"]);
  assert.equal(list.items.find((i) => i.id === cpl).reply.confidence, "high");
  // Pronta e em dia: não escreve de novo (sem pedir).
  assert.deepEqual(await rpc("personal_radar_draft_start", [A, cpl, false, null]), { status: "done" });
  // O gestor vê a resposta do liderado; a dele, não existe.
  await as(manager);
  assert.equal((await rpc("personal_radar_items", [A, member, "{}"])).items.find((i) => i.id === cpl).reply.status, "done");
});

await check("o cliente fala de novo: a resposta fica velha e volta para a fila", async () => {
  await sql(`update personal_radar_items set last_at = now() + interval '1 minute' where id = $1`, [cpl]);
  await as(member);
  const list = await rpc("personal_radar_items", [A, null, "{}"]);
  assert.equal(list.items.find((i) => i.id === cpl).reply.stale, true);
  assert.equal(await rpc("personal_radar_draft_next", [A]), cpl);
  // "Refazer" com instrução: a instrução vai no material.
  const m = await rpc("personal_radar_draft_start", [A, cpl, true, "Seja mais curto e cite o relatório."]);
  assert.equal(m.guidance, "Seja mais curto e cite o relatório.");
  assert.match(m.previous, /Ajustei o público/);
  await rpc("personal_radar_draft_fail", [A, cpl, "O modelo demorou."]);
  const failed = (await rpc("personal_radar_items", [A, null, "{}"])).items.find((i) => i.id === cpl).reply;
  assert.deepEqual([failed.status, failed.error, failed.guidance], ["failed", "O modelo demorou.", "Seja mais curto e cite o relatório."]);
  await rpc("personal_radar_draft_start", [A, cpl, true, null]);
  await rpc("personal_radar_draft_store", [A, cpl, JSON.stringify({ reply: "Oi Carlos! O CPL já voltou ao normal. Relatório: {{A1}}" }), "{}"]);
});

await check("copiar aprova; editar guarda o texto final; reprovar pede motivo; ensinar guarda a instrução", async () => {
  await as(member);
  let item = await rpc("personal_radar_reply_feedback", [A, cpl, "edited", "Oi Carlos, tudo certo! O CPL voltou a R$ 12.", null]);
  assert.equal(item.reply.approved_text, "Oi Carlos, tudo certo! O CPL voltou a R$ 12.");
  assert.ok(item.reply.approved_at);
  // Aprovada, não fica velha nem volta para a fila.
  await sql(`update personal_radar_items set last_at = now() + interval '2 minutes' where id = $1`, [cpl]);
  assert.notEqual(await rpc("personal_radar_draft_next", [A]), cpl);
  await rejects(() => rpc("personal_radar_reply_feedback", [A, cpl, "rejected", "", null]), /motivo/);
  item = await rpc("personal_radar_reply_feedback", [A, cpl, "rejected", "O número está errado.", "wrong_info"]);
  assert.equal(item.reply.status, "rejected");
  await rejects(() => rpc("personal_radar_reply_feedback", [A, cpl, "training", " ", null]), /Escreva/);
  await rpc("personal_radar_reply_feedback", [A, cpl, "training", "Sempre cite o CPL com o período.", null]);
  const fb = await sql(`select action, note, snapshot->>'reason' as reason, snapshot->>'final' as final, snapshot->>'draft' as draft
    from personal_radar_feedback where action in ('edited','rejected','training') order by created_at`);
  assert.deepEqual(fb.map((f) => f.action), ["edited", "rejected", "training"]);
  assert.match(fb[0].draft, /voltou ao normal/);
  assert.match(fb[0].final, /R\$ 12/);
  assert.equal(fb[1].reason, "wrong_info");
  // As próximas respostas leem o que ela ensinou e o tom das aprovadas.
  const m = await rpc("personal_radar_draft_start", [A, cpl, true, null]);
  assert.deepEqual(m.feedback.map((f) => f.action), ["training", "rejected", "edited"]);
  assert.deepEqual(m.style, ["Oi Carlos, tudo certo! O CPL voltou a R$ 12."]);
  await rpc("personal_radar_draft_fail", [A, cpl, "teste"]);
  await as(other);
  await rejects(() => rpc("personal_radar_reply_feedback", [A, cpl, "approved", "", null]), /não encontrado/);
});

await check("no teto do mês, a MAVI não escreve", async () => {
  await as(admin);
  await rpc("set_personal_radar_cap", [A, member, 0.01]);
  await as(member);
  assert.equal(await rpc("personal_radar_draft_next", [A]), null);
  await rejects(() => rpc("personal_radar_draft_start", [A, cpl, true, null]), /teto/);
  await as(member);
  await as(admin);
  await rpc("set_personal_radar_cap", [A, member, null]);
});

// ------------------------------------------------------------ Fase 3: aprendizado, Jev e autonomia
let detectLesson;
let replyLesson;
await check("aprender: os retornos da pessoa viram lições dela (só uma vez)", async () => {
  await sql(`update personal_radar_learning set dirty_at = now() - interval '1 hour'`);
  await as(null);
  let claim = await rpc("ai_personal_radar_learning_claim", [SECRET]);
  // A primeira da fila: quem tem retornos novos (o Bruno tem vários).
  while (claim && claim.user !== member) {
    await as(null);
    await rpc("ai_personal_radar_learning_store", [SECRET, A, claim.user, "[]", claim.feedback.map((f) => f.id), "{}"]);
    claim = await rpc("ai_personal_radar_learning_claim", [SECRET]);
  }
  assert.ok(claim, "o Bruno tem retornos para aprender");
  assert.equal(claim.person.name, "Bruno Tráfego");
  const actions = claim.feedback.map((f) => f.action);
  assert.ok(actions.includes("edited") && actions.includes("rejected") && actions.includes("training"));
  const edited = claim.feedback.find((f) => f.action === "edited");
  assert.match(edited.final, /R\$ 12/);
  const n = await rpc("ai_personal_radar_learning_store", [SECRET, A, member, JSON.stringify([
    { op: "add", kind: "detection", text: "Pedidos de arte e criativo são da Duda, não seus.", feedback: [claim.feedback[0].id] },
    { op: "add", kind: "reply", text: "Cite o CPL sempre com o valor e o período.", feedback: [edited.id] },
    { op: "add", kind: "reply", text: "Cite o CPL sempre com o valor e o período." },
    { op: "add", kind: "outro", text: "Tipo inválido não entra." },
    { op: "update", id: uid(9999), text: "Não existe." },
  ]), claim.feedback.map((f) => f.id), JSON.stringify({ model: "claude-haiku-4-5", input: 3000, cost: 0.004 })]);
  assert.equal(n, 2);
  assert.equal(await rpc("ai_personal_radar_learning_claim", [SECRET]), null);
  const lessons = await sql(`select id, kind, origin, cardinality(feedback) as fb from personal_radar_lessons where user_id = $1 order by kind`, [member]);
  assert.deepEqual(lessons.map((l) => [l.kind, l.origin, l.fb]), [["detection", "mavi", 1], ["reply", "mavi", 1]]);
  detectLesson = lessons[0].id;
  replyLesson = lessons[1].id;
  const [u] = await sql(`select user_id, cost_usd::float as cost from ai_usage where kind = 'learning'`);
  assert.deepEqual([u.user_id, u.cost], [member, 0.004]);
  // Um retorno novo suja a fila de novo.
  await as(member);
  await rpc("personal_radar_reply_feedback", [A, cpl, "training", "Chame o cliente pelo primeiro nome.", null]);
  const [q] = await sql(`select dirty_at > learned_at as dirty from personal_radar_learning where user_id = $1`, [member]);
  assert.equal(q.dirty, true);
});

await check("as lições entram na leitura dos grupos e na resposta", async () => {
  await as(null);
  const byPerson = await rpc("ai_personal_radar_lessons", [SECRET, A, [member, other], client]);
  assert.deepEqual(byPerson[member].map((l) => l.text), ["Pedidos de arte e criativo são da Duda, não seus."]);
  assert.deepEqual(byPerson[other], []);
  await as(member);
  assert.deepEqual((await rpc("personal_radar_reply_lessons", [A, client])).map((l) => l.text), ["Cite o CPL sempre com o valor e o período."]);
});

await check("a pessoa edita, pausa e exclui as suas; a MAVI não mexe mais nelas", async () => {
  await as(member);
  const edited = await rpc("save_personal_radar_lesson", [A, replyLesson, "reply", "Cite o CPL com o valor, o período e a meta."]);
  assert.deepEqual([edited.origin, edited.status], ["person", "active"]);
  await rejects(() => rpc("save_personal_radar_lesson", [A, null, "reply", "oi"]), /5 a 400/);
  const own = await rpc("save_personal_radar_lesson", [A, null, "reply", "Não use emojis com a Clínica Vida."]);
  assert.equal(own.origin, "person");
  await rpc("set_personal_radar_lesson_status", [A, own.id, "paused"]);
  await as(null);
  await rpc("ai_personal_radar_learning_store", [SECRET, A, member, JSON.stringify([
    { op: "update", id: replyLesson, text: "A MAVI tentando mudar o que a pessoa escreveu." },
    { op: "retire", id: own.id },
  ]), [], "{}"]);
  const [l] = await sql(`select text from personal_radar_lessons where id = $1`, [replyLesson]);
  assert.equal(l.text, "Cite o CPL com o valor, o período e a meta.");
  assert.equal((await sql(`select status from personal_radar_lessons where id = $1`, [own.id]))[0].status, "paused");
  await as(member);
  const list = await rpc("personal_radar_lessons", [A, null]);
  assert.equal(list.mine.length, 3);
  assert.equal(list.can_promote, false);
  // A lição de outra pessoa não se edita.
  await as(other);
  await rejects(() => rpc("save_personal_radar_lesson", [A, replyLesson, "reply", "Mexendo no do Bruno."]), /não encontrada/);
  await rejects(() => rpc("set_personal_radar_lesson_status", [A, replyLesson, "dismissed"]), /não encontrada/);
});

let promoted;
await check("promover para a equipe: só líderes; o Jev confere antes de valer", async () => {
  await as(member);
  await rejects(() => rpc("promote_personal_radar_lesson", [A, replyLesson, "team", team]), /administradores e gestores/);
  await as(manager);
  const list = await rpc("personal_radar_lessons", [A, member]);
  assert.equal(list.can_promote, true);
  assert.deepEqual(list.teams.map((t) => t.name), ["Tráfego"]);
  promoted = await rpc("promote_personal_radar_lesson", [A, replyLesson, "team", team]);
  assert.deepEqual([promoted.scope, promoted.status, promoted.team.name], ["team", "checking", "Tráfego"]);
  await rejects(() => rpc("promote_personal_radar_lesson", [A, replyLesson, "team", team]), /já foi promovida/);
  // Esperando o Jev, não vale para ninguém.
  await as(other);
  assert.deepEqual(await rpc("personal_radar_reply_lessons", [A, client]), []);
  await as(null);
  const c = await rpc("ai_personal_radar_check_claim", [SECRET]);
  assert.deepEqual([c.id, c.scope, c.target, c.kind], [promoted.id, "team", "Tráfego", "reply"]);
  assert.equal(c.jev, null); // sem Jev cadastrado: o worker põe em uso sem conferir
  assert.equal(await rpc("ai_personal_radar_check_claim", [SECRET]), null);
  await rpc("ai_personal_radar_check_store", [SECRET, promoted.id, true, null, "{}"]);
  await as(other);
  assert.deepEqual((await rpc("personal_radar_reply_lessons", [A, client])).map((l) => [l.scope, l.text]),
    [["team", "Cite o CPL com o valor, o período e a meta."]]);
  const shared = (await rpc("personal_radar_lessons", [A, null])).shared;
  assert.deepEqual(shared.map((l) => l.scope), ["team"]);
});

await check("recusada pelo Jev: o líder vê o motivo e decide; editar volta para a conferência", async () => {
  await as(admin);
  const toClient = await rpc("promote_personal_radar_lesson", [A, detectLesson, "client", client]);
  await as(null);
  await rpc("ai_personal_radar_check_claim", [SECRET]);
  await rpc("ai_personal_radar_check_store", [SECRET, toClient.id, false, "Fala de uma pessoa específica, não do cliente.",
    JSON.stringify({ model: "~typesafe/jev-latest", input: 500, cost: 0.00002 })]);
  await as(admin);
  let l = (await rpc("personal_radar_lessons", [A, null])).shared.find((x) => x.id === toClient.id);
  assert.deepEqual([l.status, l.check_note], ["refused", "Fala de uma pessoa específica, não do cliente."]);
  l = await rpc("set_personal_radar_lesson_status", [A, toClient.id, "active"]);
  assert.deepEqual([l.status, l.check_note], ["active", "Posta em uso por um líder."]);
  l = await rpc("save_personal_radar_lesson", [A, toClient.id, "detection", "Pedidos de arte deste cliente são da equipe de criação."]);
  assert.deepEqual([l.status, l.origin], ["checking", "leader"]);
  // A original mostra para onde foi promovida.
  await as(member);
  const mine = (await rpc("personal_radar_lessons", [A, null])).mine.find((x) => x.id === detectLesson);
  assert.deepEqual(mine.promoted.map((p) => p.scope), ["client"]);
});

await check("autonomia: a taxa de copiadas sem edição por tipo e a regra da pessoa", async () => {
  await as(member);
  let a = await rpc("personal_radar_autonomy", [A, null]);
  const complaint = a.find((k) => k.kind === "complaint");
  assert.deepEqual([complaint.decided, complaint.edited, complaint.rejected, complaint.ready], [2, 1, 1, false]);
  await sql(
    `insert into personal_radar_feedback(company_id, item_id, user_id, action, snapshot)
     select $1, $2, $3, 'approved', '{"kind":"complaint"}' from generate_series(1, 18)`,
    [A, cpl, member],
  );
  a = await rpc("personal_radar_autonomy", [A, null]);
  assert.deepEqual([a.find((k) => k.kind === "complaint").rate, a.find((k) => k.kind === "complaint").ready], [0.9, true]);
  a = await rpc("set_personal_radar_autonomy", [A, "complaint", true, 30, 0.95, 10]);
  assert.equal(a.find((k) => k.kind === "complaint").ready, false);
  await rejects(() => rpc("set_personal_radar_autonomy", [A, "complaint", true, 2, 0.95, 10]), /7 a 180/);
  // O gestor vê os números do liderado.
  await as(manager);
  assert.equal((await rpc("personal_radar_autonomy", [A, member])).find((k) => k.kind === "complaint").decided, 20);
  await as(other);
  await rejects(() => rpc("personal_radar_autonomy", [A, member]), /Sem permissão/);
});

await check("Quem usa qual modelo: a conferência do Radar pessoal só aceita o Jev", async () => {
  await as(admin);
  await rejects(() => rpc("ai_set_route", [A, "feature", null, uid(800), "claude-haiku-4-5", "personal_radar_check"]), /Jev/);
});

// ------------------------------------------------------------ uma situação por demanda
const GROUP2 = uid(950);
let parts;
await check("três situações da mesma demanda num grupo: a consolidação junta numa só", async () => {
  await as(admin);
  await rpc("set_personal_radar_cap", [A, member, null]);
  await sql(`insert into whatsapp_groups(id, company_id, jid, title, client_id, synced_until) values ($1,$2,'3@g.us','4282 - Financeiro',$3, now())`,
    [GROUP2, A, client]);
  await as(null);
  await rpc("whatsapp_store_members", [WA_SECRET, GROUP2, JSON.stringify([
    { jid: "5511987654321@s.whatsapp.net", lid: "184@lid", phone: "5511987654321", name: "Bruno" },
    { jid: "5511911112222@s.whatsapp.net", lid: "186@lid", phone: "5511911112222", name: "Carlos" },
  ]), null]);
  await sql(
    `insert into whatsapp_messages(id, company_id, group_id, wa_id, sent_at, sender, sender_phone, from_me, kind, body) values
     ($1,$4,$5,'X1', now() - interval '20 minutes','186@lid','5511911112222',false,'text','Cobraram o CRM que nem ativamos.'),
     ($2,$4,$5,'X2', now() - interval '15 minutes','186@lid','5511911112222',false,'text','Os WhatsApps não funcionam até hoje.'),
     ($3,$4,$5,'X3', now() - interval '10 minutes','186@lid','5511911112222',false,'text','Quero o cancelamento total ainda hoje.')`,
    [uid(1201), uid(1202), uid(1203), A, GROUP2],
  );
  const claimed = await claim();
  assert.ok(claimed.some((c) => c.group_id === GROUP2));
  const m = await material(GROUP2);
  const own = [{ user_id: member, reason: "role", why: "Financeiro" }];
  await store(GROUP2, {
    until_at: m.until_at, until_id: m.until_id, people: [member],
    items: [
      { kind: "complaint", title: "Cobrança do CRM contestada", urgency: 2, owners: own, mentions: [{ message_id: uid(1201) }] },
      { kind: "complaint", title: "WhatsApps sem funcionar", urgency: 3, owners: own, mentions: [{ message_id: uid(1202) }] },
      { kind: "request", title: "Pedido de cancelamento", urgency: 2, owners: own, mentions: [{ message_id: uid(1203) }] },
    ],
    resolved: [], usage: { cost: 0 },
  });
  parts = (await sql(`select id, title from personal_radar_items where group_id = $1 order by first_at`, [GROUP2])).map((r) => r.id);
  assert.equal(parts.length, 3);
  // Uma resposta já escrita para uma delas some (vai ser escrita de novo com tudo).
  await as(member);
  await rpc("personal_radar_draft_start", [A, parts[2], true, null]);
  await rpc("personal_radar_draft_store", [A, parts[2], JSON.stringify({ reply: "Oi Carlos, vamos ver o cancelamento." }), "{}"]);
  await as(null);
  const groups = await rpc("ai_personal_radar_consolidate_claim", [SECRET, 10]);
  const g = groups.find((x) => x.group_id === GROUP2);
  assert.deepEqual(g.items.map((i) => i.title), ["Cobrança do CRM contestada", "WhatsApps sem funcionar", "Pedido de cancelamento"]);
  assert.equal(g.client_name, "4282");
  const merged = await rpc("ai_personal_radar_consolidate_store", [SECRET, GROUP2, JSON.stringify([
    { into: parts[2], items: [parts[0], parts[1], uid(9999)], kind: "complaint", title: "Cancelamento com cobranças contestadas",
      summary: "O cliente pede o cancelamento total: contesta a cobrança do CRM e diz que os WhatsApps não funcionam." },
  ]), JSON.stringify({ model: "claude-sonnet-5-5", input: 2000, cost: 0.003 })]);
  assert.equal(merged, 1);
  const items = await sql(`select id, title, kind, urgency, asks, reopened_at from personal_radar_items where group_id = $1`, [GROUP2]);
  assert.deepEqual(items.map((i) => [i.id, i.title, i.kind, i.urgency, i.asks]),
    [[parts[2], "Cancelamento com cobranças contestadas", "complaint", 3, 3]]);
  assert.equal((await sql(`select count(*)::int as n from personal_radar_mentions where item_id = $1`, [parts[2]]))[0].n, 3);
  assert.equal((await sql(`select count(*)::int as n from personal_radar_replies where item_id = $1`, [parts[2]]))[0].n, 0);
  assert.equal((await sql(`select count(*)::int as n from ai_usage where kind = 'consolidate'`))[0].n, 1);
  // Consolidado e sem mudança: não volta.
  assert.ok(!(await rpc("ai_personal_radar_consolidate_claim", [SECRET, 10])).some((x) => x.group_id === GROUP2));
});

await check("as falas já juntadas não viram situação de novo", async () => {
  await touch(GROUP2);
  await claim();
  const m = await material(GROUP2);
  // Nada novo depois da leitura: o material volta nulo.
  assert.equal(m, null);
});

await check("Juntar com…: a pessoa junta à mão e isso vira aprendizado", async () => {
  await sql(
    `insert into whatsapp_messages(id, company_id, group_id, wa_id, sent_at, sender, sender_phone, from_me, kind, body) values
     ($1,$2,$3,'X4', now() - interval '1 minute','186@lid','5511911112222',false,'text','E a devolutiva por e-mail?')`,
    [uid(1204), A, GROUP2],
  );
  await touch(GROUP2);
  await claim();
  const m = await material(GROUP2);
  await store(GROUP2, {
    until_at: m.until_at, until_id: m.until_id, people: [member],
    items: [{ kind: "deadline", title: "Devolutiva por e-mail", owners: [{ user_id: member, reason: "role" }], mentions: [{ message_id: uid(1204) }] }],
    resolved: [], usage: { cost: 0 },
  });
  const extra = (await sql(`select id from personal_radar_items where group_id = $1 and id <> $2`, [GROUP2, parts[2]]))[0].id;
  await as(other);
  await rejects(() => rpc("personal_radar_join", [A, parts[2], [extra], null]), /não encontrado/);
  await as(member);
  await rejects(() => rpc("personal_radar_join", [A, parts[2], [cpl], null]), /mesmo grupo/);
  const item = await rpc("personal_radar_join", [A, parts[2], [extra], null]);
  assert.equal(item.mention_count, 4);
  assert.equal(item.asks, 4);
  const [f] = await sql(`select action, snapshot->>'summary' as summary from personal_radar_feedback where action = 'merged'`);
  assert.match(f.summary, /juntou nesta situação: "Devolutiva por e-mail"/);
});

await check("a lista vem por ordem de chegada (a mais recente primeiro), não pela urgência", async () => {
  await sql(`update personal_radar_items set urgency = 3, last_at = now() - interval '3 days' where id = $1`, [cpl]);
  await sql(`update personal_radar_items set urgency = 0, last_at = now() where id = $1`, [parts[2]]);
  await as(member);
  const r = await rpc("personal_radar_items", [A, null, JSON.stringify({ status: "open" })]);
  const at = r.items.map((i) => i.last_at);
  assert.deepEqual(at, [...at].sort().reverse());
  assert.equal(r.items[0].id, parts[2]);
  assert.ok(r.items.findIndex((i) => i.id === cpl) > 0);
});

await check("o número do menu é o mesmo da aba Em aberto", async () => {
  for (const u of [member, other, outsider]) {
    await as(u);
    const open = (await rpc("personal_radar_items", [A, null, JSON.stringify({ status: "open" })])).counts.open;
    assert.equal(await rpc("personal_radar_open_count", [A]), open);
  }
  await as(member);
  assert.ok((await rpc("personal_radar_open_count", [A])) > 0);
});

await check("filtro por período: pela chegada, e as contagens seguem o período", async () => {
  await sql(`update personal_radar_items set last_at = now() - interval '10 days' where id = $1`, [cpl]);
  await sql(`update personal_radar_items set last_at = now() where id = $1`, [parts[2]]);
  const day = (offset) => {
    const d = new Date(Date.now() + offset * 86400_000);
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d);
  };
  await as(member);
  const today = await rpc("personal_radar_items", [A, null, JSON.stringify({ status: "open", from: day(0), to: day(0) })]);
  assert.ok(today.items.some((i) => i.id === parts[2]));
  assert.ok(!today.items.some((i) => i.id === cpl));
  const all = await rpc("personal_radar_items", [A, null, JSON.stringify({ status: "open" })]);
  assert.ok(today.counts.open < all.counts.open);
  const old = await rpc("personal_radar_items", [A, null, JSON.stringify({ status: "open", from: day(-11), to: day(-9) })]);
  assert.deepEqual(old.items.map((i) => i.id), [cpl]);
  // Data inválida é ignorada.
  const bad = await rpc("personal_radar_items", [A, null, JSON.stringify({ status: "open", from: "ontem" })]);
  assert.equal(bad.counts.open, all.counts.open);
});

// ------------------------------------------------------------ a fila não gira em falso
await check("grupo nunca lido e sem mensagem no histórico: conferido, não volta até chegar mensagem", async () => {
  const EMPTY = uid(960);
  // Os outros grupos em dia.
  await sql(`update whatsapp_groups set synced_until = now() - interval '1 day' where company_id = $1`, [A]);
  await sql(`update personal_radar_groups set checked_until = now(), claimed_until = null, retry_at = null`);
  await sql(`insert into whatsapp_groups(id, company_id, jid, title, client_id, synced_until) values ($1,$2,'4@g.us','4282 - Suporte',$3, now())`,
    [EMPTY, A, client]);
  await as(null);
  await rpc("whatsapp_store_members", [WA_SECRET, EMPTY, JSON.stringify([
    { jid: "5511987654321@s.whatsapp.net", lid: "184@lid", phone: "5511987654321", name: "Bruno" },
  ]), null]);
  assert.equal((await sql(`select mavi_private.personal_radar_due($1) as due`, [A]))[0].due, true);
  assert.deepEqual((await claim()).map((c) => c.group_id), [EMPTY]);
  assert.equal(await material(EMPTY), null);
  // Antes: o material soltava a reserva e o grupo voltava na mesma hora, sem fim.
  assert.deepEqual(await claim(), []);
  assert.equal((await sql(`select mavi_private.personal_radar_due($1) as due`, [A]))[0].due, false);
  const [q] = await sql(`select cursor_at, checked_until is not null as checked from personal_radar_groups where group_id = $1`, [EMPTY]);
  assert.deepEqual([q.cursor_at, q.checked], [null, true]);
  // Chegou mensagem: volta para a fila.
  await sql(
    `insert into whatsapp_messages(id, company_id, group_id, wa_id, sent_at, sender, sender_phone, from_me, kind, body) values
     ($1,$2,$3,'E1', now(),'186@lid','5511911112222',false,'text','Oi, alguém pode me ajudar?')`,
    [uid(1301), A, EMPTY],
  );
  await touch(EMPTY);
  assert.deepEqual((await claim()).map((c) => c.group_id), [EMPTY]);
  assert.equal((await material(EMPTY)).lines.length, 1);
});

console.log(`\n${passed} verificações do Radar pessoal passaram.`);

// MAVI · memória, Fase 3 (migration 20270614090000_mavi_memory_review): a
// configuração (só líderes), a autonomia por tipo (acerto e contestações), o
// "Ainda vale?" do histórico antigo, a revisão da ficha da pessoa, o "Isso
// ainda vale?" na conversa, o resumo da semana, a rotina nos Avisos de
// falhas e a medição.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, member, outsider, manager] = [1, 10, 11, 12, 13].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, member, outsider, manager]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Bruno Equipe','member',true),
   ($1,$4,'Carla Fora','member',true),($1,$5,'Gabi Gestora','manager',true)`,
  [A, admin, member, outsider, manager],
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

await sql(`insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`, [SECRET]);
await as(admin);
const team = await rpc("create_team", [A, "Equipe A", [member]]);
const client = await rpc("create_client", [A, "4282", "", [team]]);
const other = await rpc("create_client", [A, "5017", "", [team]]);
await as(member);
await rpc("client_dossier", [A, client]);
await as(member);
await rpc("client_dossier", [A, other]);
const store = async (target, ops) => {
  await as(null);
  return rpc("ai_dossier_store", [SECRET, target, null, null, false, JSON.stringify(ops), null]);
};
const autonomy = async (kind) => (await sql(`select mavi_private.dossier_autonomy($1, $2) a`, [A, kind]))[0].a;
const decided = (kind, n, status) =>
  sql(
    `insert into client_dossier_proposals(company_id, client_id, op, kind, text, status, decided_at, created_at)
     select $1, $2, 'add', $3, 'Decidida ' || $3 || ' ' || $4 || ' ' || g, $4, now() - g * interval '1 minute', now() - interval '1 day'
     from generate_series(1, $5) g`,
    [A, other, kind, status, n],
  );

await check("a configuração: só líderes veem e salvam, dentro dos limites", async () => {
  await as(member);
  await rejects(() => rpc("mavi_memory_settings", [A]), /Só administradores e gestores/);
  await as(manager);
  const s = await rpc("mavi_memory_settings", [A]);
  assert.deepEqual([s.dossier_autonomy, s.autonomy_window, Number(s.autonomy_rate), s.contest_limit, s.history_days, s.summary_leaders], [
    true, 20, 0.9, 3, 120, false,
  ]);
  await as(manager);
  const saved = await rpc("save_mavi_memory_settings", [A, JSON.stringify({ summary_leaders: true })]);
  assert.equal(saved.summary_leaders, true);
  assert.equal(saved.updated_by, manager);
  await as(manager);
  await rejects(() => rpc("save_mavi_memory_settings", [A, JSON.stringify({ autonomy_rate: 0.2 })]), /check/);
});

await check("autonomia: 18 de 20 confirmadas e poucas contestações; só os motivos que ela pode pular", async () => {
  await decided("style", 17, "confirmed");
  await decided("style", 3, "refused");
  assert.equal((await autonomy("style")).auto, false);
  await sql(`update client_dossier_proposals set status = 'confirmed' where text = 'Decidida style refused 1'`);
  const a = await autonomy("style");
  assert.deepEqual([a.decided, a.confirmed, Number(a.rate), a.auto], [20, 18, 0.9, true]);
  // Entra direto, registrada como auto (e continua contestável).
  assert.equal(await store(client, [{ op: "add", kind: "style", text: "Fotos claras, fundo branco.", route: "suggest", reasons: ["pouca evidência"] }]), 1);
  assert.equal((await sql(`select status, decided_at is not null d from client_dossier_proposals where text = 'Fotos claras, fundo branco.'`))[0].status, "auto");
  const [item] = await sql(`select id, origin from client_dossier_items where text = 'Fotos claras, fundo branco.'`);
  assert.equal(item.origin, "mavi");
  // Condição comercial e contradição sempre pedem confirmação.
  await store(client, [
    { op: "add", kind: "style", text: "Desconto só com aval da Joana.", route: "suggest", reasons: ["condição comercial"] },
    { op: "add", kind: "style", text: "Tom sério.", route: "suggest", reasons: ["contradiz o dossiê"] },
  ]);
  assert.deepEqual((await sql(`select status from client_dossier_proposals where text in ('Desconto só com aval da Joana.', 'Tom sério.')`)).map((r) => r.status), [
    "suggested",
    "suggested",
  ]);
  // Outro tipo, sem histórico: pede confirmação.
  await store(client, [{ op: "add", kind: "avoids", text: "Não usar vermelho.", route: "suggest", reasons: ["pouca evidência"] }]);
  assert.equal((await sql(`select status from client_dossier_proposals where text = 'Não usar vermelho.'`))[0].status, "suggested");
  // Três itens da MAVI contestados em 30 dias: perde a autonomia.
  for (const t of ["C1.", "C2.", "C3."]) {
    await store(client, [{ op: "add", kind: "style", text: `Item ${t}`, route: "apply" }]);
    const [i] = await sql(`select id from client_dossier_items where text = $1`, [`Item ${t}`]);
    await as(member);
    await rpc("client_dossier_contest", [A, i.id, ""]);
  }
  assert.equal((await autonomy("style")).contests, 3);
  assert.equal((await autonomy("style")).auto, false);
  // E desligar no painel desliga para todos os tipos.
  await sql(`delete from client_dossier_proposals where op = 'contest'`);
  assert.equal((await autonomy("style")).auto, true);
  await as(admin);
  await rpc("save_mavi_memory_settings", [A, JSON.stringify({ dossier_autonomy: false })]);
  assert.equal((await autonomy("style")).auto, false);
  await as(admin);
  await rpc("save_mavi_memory_settings", [A, JSON.stringify({ dossier_autonomy: true })]);
});

await check("histórico antigo vira “Ainda vale?”: confirmar mantém, recusar tira; não repete", async () => {
  await store(client, [
    { op: "add", kind: "history", text: "Reclamou do atraso em março.", route: "apply", seen_at: "2026-01-10" },
    { op: "add", kind: "history", text: "Pediu relatório semanal em fevereiro.", route: "apply", seen_at: "2026-01-12" },
    { op: "add", kind: "history", text: "Aprovou a campanha nova.", route: "apply" },
  ]);
  await sql(`select mavi_private.memory_review_company($1)`, [A]);
  const reviews = await sql(`select id, text, status, reasons from client_dossier_proposals where op = 'review' order by text`);
  assert.deepEqual(reviews.map((r) => r.text), ["Pediu relatório semanal em fevereiro.", "Reclamou do atraso em março."]);
  assert.deepEqual(reviews[0].reasons, ["histórico antigo: ainda vale?"]);
  await as(member);
  assert.equal((await rpc("client_dossier_decide", [A, reviews[0].id, "confirm"])).status, "confirmed");
  const [kept] = await sql(`select seen_at > now() - interval '1 minute' fresh from client_dossier_items where text = 'Pediu relatório semanal em fevereiro.'`);
  assert.equal(kept.fresh, true);
  await as(member);
  await rpc("client_dossier_decide", [A, reviews[1].id, "refuse"]);
  assert.equal((await sql(`select count(*)::int n from client_dossier_items where text = 'Reclamou do atraso em março.'`))[0].n, 0);
  await sql(`select mavi_private.memory_review_company($1)`, [A]);
  assert.equal((await sql(`select count(*)::int n from client_dossier_proposals where op = 'review'`))[0].n, 2);
});

await check("a ficha da pessoa com muitos itens entra na revisão; a leitura diz que é revisão", async () => {
  for (let i = 0; i < 10; i++)
    await sql(`insert into mavi_person_traits(company_id, user_id, kind, text, origin) values ($1, $2, 'preference', $3, 'mavi')`, [
      A,
      member,
      `Preferência ${i}.`,
    ]);
  await sql(`insert into mavi_person_traits(company_id, user_id, kind, text, origin) values ($1, $2, 'preference', 'Só uma.', 'mavi')`, [A, outsider]);
  await sql(`update mavi_private.mavi_person_state set built_at = now(), dirty_at = null`);
  await sql(`select mavi_private.memory_review_company($1)`, [A]);
  const state = await sql(`select user_id, review_due from mavi_private.mavi_person_state where review_due`);
  assert.deepEqual(state.map((s) => s.user_id), [member]);
  await as(null);
  const claim = await rpc("mavi_person_claim", [SECRET]);
  assert.equal(claim.user, member);
  assert.equal(claim.review, true);
  assert.equal((await sql(`select review_due from mavi_private.mavi_person_state where user_id = $1`, [member]))[0].review_due, false);
});

await check("“Isso ainda vale?” na conversa: o vencido, uma vez a cada 14 dias", async () => {
  await as(member);
  const id = await rpc("mavi_person_trait_save", [A, null, null, "context", "Fecha o mês do 4282.", "situation"]);
  await sql(`update mavi_person_traits set valid_until = now() - interval '1 day' where id = $1`, [id]);
  await as(member);
  const next = await rpc("mavi_person_review_next", [A]);
  assert.equal(next.id, id);
  assert.equal(next.text, "Fecha o mês do 4282.");
  await as(member);
  assert.equal(await rpc("mavi_person_review_next", [A]), null);
  await sql(`update mavi_person_traits set review_asked_at = now() - interval '15 days' where id = $1`, [id]);
  await as(member);
  assert.equal((await rpc("mavi_person_review_next", [A])).id, id);
  await as(outsider);
  assert.equal(await rpc("mavi_person_review_next", [A]), null);
});

await check("o resumo da semana: quem atende o cliente recebe; o líder, só os contestados (se o painel deixar)", async () => {
  await sql(`delete from notifications`);
  await as(member);
  const [i] = await sql(`select id from client_dossier_items where text = 'Aprovou a campanha nova.'`);
  await as(member);
  await rpc("client_dossier_contest", [A, i.id, "Não aprovou"]);
  await store(other, [{ op: "add", kind: "prefers", text: "Gosta de vídeos curtos.", route: "apply" }]);
  const sent = (await sql(`select mavi_private.memory_review_run() n`))[0].n;
  assert.equal(sent, 3);
  const notes = await sql(`select user_id, kind, title, body, link, task_id from notifications order by user_id`);
  const mine = notes.find((n) => n.user_id === member);
  assert.equal(mine.kind, "memory_week");
  assert.equal(mine.title, "Dossiês da semana: 2 clientes com novidades");
  assert.match(mine.body, /4282 \(\d+ para confirmar, \d+ novos\) · 5017 \(1 novo\)/);
  assert.equal(mine.link, `/drive/cliente/${client}/dossie`);
  assert.equal(mine.task_id, null);
  // Os líderes (summary_leaders) recebem só os contestados de quem não atendem.
  const lead = notes.find((n) => n.user_id === manager);
  assert.equal(lead.body, "4282 (1 contestado)");
  assert.ok(!notes.some((n) => n.user_id === outsider));
  // A rotina nos Avisos de falhas.
  const [job] = await sql(`select last_ok_at is not null ok from mavi_private.job_status where company_id = $1 and job = 'memory'`, [A]);
  assert.equal(job.ok, true);
  assert.ok((await sql(`select 1 from mavi_private.job_catalog() where job = 'memory'`)).length);
});

await check("a medição: com e sem memória, sugestões, autonomia, contestados e custo (só líderes)", async () => {
  await as(member);
  const conv = await rpc("ai_save_turn", [A, null, JSON.stringify({ client }), "assistant", "Como é o tom?", "Leve.", "[]", "[]"]);
  await as(member);
  await rpc("ai_save_turn", [A, conv, "{}", "assistant", "E o prazo?", "Sexta.", "[]", "[]"]);
  const msgs = await sql(`select id from ai_messages where conversation_id = $1 and role = 'assistant' order by id`, [conv]);
  const ids = (await sql(`select id from client_dossier_items where client_id = $1 and not dismissed limit 2`, [client])).map((r) => r.id);
  await as(member);
  await rpc("mavi_dossier_used", [Number(msgs[0].id), ids]);
  await as(member);
  await rpc("mavi_feedback_vote", [Number(msgs[0].id), "up", null, null]);
  await as(member);
  await rpc("mavi_feedback_vote", [Number(msgs[1].id), "down", "format", ""]);
  await sql(`insert into ai_usage(company_id, kind, model, cost_usd) values ($1, 'dossier_check', 'jev', 0.003), ($1, 'dossier', 'm', 0.02)`, [A]);
  await as(member);
  await rejects(() => rpc("mavi_memory_stats", [A, 30]), /Só administradores e gestores/);
  await as(admin);
  const s = await rpc("mavi_memory_stats", [A, 30]);
  assert.deepEqual([s.answers.with.answers, s.answers.with.up, s.answers.without.answers, s.answers.without.down], [1, 1, 1, 1]);
  assert.equal(s.autonomy.length, 6);
  assert.equal(s.autonomy.find((a) => a.kind === "style").auto, true);
  assert.ok(s.proposals.auto >= 1 && s.proposals.suggested >= 1 && s.proposals.contested >= 1);
  assert.equal(s.contested[0].text, "Aprovou a campanha nova.");
  assert.equal(s.contested[0].client, "4282");
  assert.deepEqual([Number(s.cost.dossier_check), Number(s.cost.dossier)], [0.003, 0.02]);
  assert.ok(s.person.people >= 2);
  assert.equal(s.settings.dossier_autonomy, true);
});

console.log(`\n${passed} verificações da revisão e da medição da memória passaram.`);

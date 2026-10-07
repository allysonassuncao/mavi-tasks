// MAVI · memória por cliente, Fase 2 (migration 20270613090000_mavi_memory_client):
// a rotina do dossiê com rota por risco (apply, suggest, refuse), as sugestões
// que quem vê o dossiê confirma ou recusa (e vencem em 14 dias), o que não
// volta, o cartão do chat (cada pessoa vê uma vez), contestar (sai na hora)
// e o líder restaurar ou descartar, o contexto do chat e a memória usada.
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
await as(member);
await rpc("client_dossier", [A, client]);
const store = async (ops, usage = null) => {
  await as(null);
  return rpc("ai_dossier_store", [SECRET, client, null, null, false, JSON.stringify(ops), usage && JSON.stringify(usage)]);
};
const items = () => sql(`select id, text, kind, origin, dismissed from client_dossier_items where client_id = $1 order by text`, [client]);
const proposals = () => sql(`select id, op, text, status, reasons, expires_at from client_dossier_proposals order by created_at, text`);

let tone;
let budget;
await check("a rotina: apply entra direto, suggest vira sugestão (14 dias), refuse fica registrada", async () => {
  const n = await store(
    [
      { op: "add", kind: "style", text: "Tom leve, sem gírias.", route: "apply", sources: [{ type: "meeting", title: "Alinhamento", date: "2026-10-01" }] },
      { op: "add", kind: "rule", text: "Toda peça passa pela Joana antes de publicar.", route: "suggest", reasons: ["regra ou combinado"], checks: { supported: 0.9 } },
      { op: "add", kind: "context", text: "Está insatisfeito com o CPL.", route: "refuse", note: "Assunto do Termômetro." },
      { op: "add", kind: "prefers", text: "Sem rota: entra como antes." },
      { op: null, kind: "prefers", text: "Op nulo não entra.", route: "suggest" },
    ],
    { model: "m", input: 10, cost: 0.01, jev: { model: "jev", input: 50, cost: 0.002 } },
  );
  assert.equal(n, 3);
  assert.deepEqual((await items()).map((i) => i.text), ["Sem rota: entra como antes.", "Tom leve, sem gírias."]);
  const p = await proposals();
  assert.deepEqual(p.map((x) => [x.text, x.status]), [
    ["Está insatisfeito com o CPL.", "rejected"],
    ["Toda peça passa pela Joana antes de publicar.", "suggested"],
  ]);
  const days = (new Date(p[1].expires_at) - Date.now()) / 86400000;
  assert.ok(days > 13.9 && days <= 14);
  assert.deepEqual(p[1].reasons, ["regra ou combinado"]);
  assert.deepEqual((await sql(`select kind, model from ai_usage order by kind`)).map((u) => [u.kind, u.model]), [
    ["dossier", "m"],
    ["dossier_check", "jev"],
  ]);
  tone = (await items()).find((i) => i.text.startsWith("Tom")).id;
  // Sugestão de mudar ou tirar um item da MAVI (o antigo vai junto).
  await store([
    { op: "update", id: tone, kind: "style", text: "Tom leve e direto, sem gírias.", route: "suggest", reasons: ["contradiz o dossiê"] },
    { op: "remove", id: tone, route: "suggest", reasons: ["tira uma regra"] },
    { op: "update", id: uid(999), text: "Item que não existe.", route: "suggest" },
  ]);
  const [up, rm] = (await sql(`select op, item_id, text, previous from client_dossier_proposals where op in ('update','remove') order by op desc`));
  assert.deepEqual([up.op, up.item_id, up.previous], ["update", tone, "Tom leve, sem gírias."]);
  assert.deepEqual([rm.op, rm.text], ["remove", "Tom leve, sem gírias."]);
  budget = (await proposals()).find((x) => x.text.startsWith("Toda peça")).id;
});

await check("o que não volta: o mesmo texto esperando, recusado ou descartado; o recusado pelo Jev pode entrar direto depois", async () => {
  assert.equal(await store([{ op: "add", kind: "rule", text: "toda peça passa pela Joana antes de publicar.", route: "suggest" }]), 0);
  assert.equal(await store([{ op: "add", kind: "rule", text: "Toda peça passa pela Joana antes de publicar.", route: "apply" }]), 0);
  assert.equal(await store([{ op: "add", kind: "context", text: "Está insatisfeito com o CPL.", route: "refuse" }]), 0);
  assert.equal((await sql(`select count(*)::int n from client_dossier_proposals where text = 'Está insatisfeito com o CPL.'`))[0].n, 1);
  // Mais evidência depois: entra direto.
  assert.equal(await store([{ op: "add", kind: "context", text: "Está insatisfeito com o CPL.", route: "apply" }]), 1);
  await sql(`delete from client_dossier_items where text = 'Está insatisfeito com o CPL.'`);
  // A rotina sabe o que está esperando e o que foi recusado.
  await as(null);
  const seen = await rpc("ai_dossier_proposals", [SECRET, client]);
  assert.ok(seen.waiting.includes("Toda peça passa pela Joana antes de publicar."));
  assert.ok(seen.refused.includes("Está insatisfeito com o CPL."));
});

await check("confirmar e recusar: quem vê o dossiê decide; quem não vê, não", async () => {
  await as(member);
  const d = await rpc("client_dossier", [A, client]);
  assert.equal(d.can_confirm, true);
  assert.equal(d.can_edit, false);
  assert.equal(d.proposals.length, 3);
  assert.deepEqual(d.contested, []);
  assert.ok(d.items.every((i) => "created_at" in i));
  await as(outsider);
  await rejects(() => rpc("client_dossier_decide", [A, budget, "confirm"]), /não encontrada/);
  await as(member);
  assert.equal((await rpc("client_dossier_decide", [A, budget, "confirm"])).status, "confirmed");
  const [rule] = (await items()).filter((i) => i.kind === "rule");
  assert.equal(rule.text, "Toda peça passa pela Joana antes de publicar.");
  assert.equal(rule.origin, "mavi");
  // Decidir de novo: devolve o estado, não muda.
  await as(member);
  assert.equal((await rpc("client_dossier_decide", [A, budget, "refuse"])).status, "confirmed");
  // O update confirmado muda o item; o remove recusado não tira.
  const [up] = await sql(`select id from client_dossier_proposals where op = 'update'`);
  const [rm] = await sql(`select id from client_dossier_proposals where op = 'remove'`);
  await as(member);
  await rpc("client_dossier_decide", [A, up.id, "confirm"]);
  await as(member);
  assert.equal((await rpc("client_dossier_decide", [A, rm.id, "refuse"])).status, "refused");
  assert.equal((await sql(`select text from client_dossier_items where id = $1`, [tone]))[0].text, "Tom leve e direto, sem gírias.");
  await as(member);
  assert.deepEqual((await rpc("client_dossier_proposal_state", [A, [budget, rm.id]])).map((x) => x.status).sort(), ["confirmed", "refused"]);
  await as(outsider);
  assert.deepEqual(await rpc("client_dossier_proposal_state", [A, [budget]]), []);
});

await check("14 dias sem resposta: a sugestão vence e não passa a valer", async () => {
  await store([{ op: "add", kind: "avoids", text: "Não usar vermelho.", route: "suggest" }]);
  const [p] = await sql(`select id from client_dossier_proposals where text = 'Não usar vermelho.'`);
  await sql(`update client_dossier_proposals set expires_at = now() - interval '1 minute' where id = $1`, [p.id]);
  await as(member);
  assert.equal((await rpc("client_dossier_decide", [A, p.id, "confirm"])).status, "expired");
  await as(member);
  const d = await rpc("client_dossier", [A, client]);
  assert.ok(!d.proposals.some((x) => x.id === p.id));
  assert.equal((await sql(`select status from client_dossier_proposals where id = $1`, [p.id]))[0].status, "expired");
  assert.ok(!(await items()).some((i) => i.text === "Não usar vermelho."));
});

await check("no chat: cada pessoa vê o cartão de cada sugestão uma vez; o contexto traz os itens ativos", async () => {
  await store([{ op: "add", kind: "avoids", text: "Não citar a concorrente.", route: "suggest", sources: [{ type: "whatsapp", title: "Grupo", date: "2026-10-02" }] }]);
  await as(member);
  const card = await rpc("client_dossier_ask", [A, client]);
  assert.equal(card.text, "Não citar a concorrente.");
  assert.equal(card.client, "4282");
  await as(member);
  assert.equal(await rpc("client_dossier_ask", [A, client]), null);
  // Outra pessoa (gestora) ainda vê.
  await as(manager);
  assert.equal((await rpc("client_dossier_ask", [A, client])).text, "Não citar a concorrente.");
  await as(outsider);
  assert.equal(await rpc("client_dossier_ask", [A, client]), null);
  await as(member);
  const ctx = await rpc("client_dossier_context", [A, client]);
  assert.deepEqual(ctx.map((i) => i.text).sort(), [
    "Sem rota: entra como antes.",
    "Toda peça passa pela Joana antes de publicar.",
    "Tom leve e direto, sem gírias.",
  ]);
  await as(outsider);
  assert.equal(await rpc("client_dossier_context", [A, client]), null);
});

let contest;
await check("contestar: o item sai na hora; o líder restaura ou descarta (o da MAVI não volta)", async () => {
  const rule = (await items()).find((i) => i.kind === "rule");
  await as(outsider);
  await rejects(() => rpc("client_dossier_contest", [A, rule.id, "não é assim"]), /não encontrado/);
  await as(member);
  contest = await rpc("client_dossier_contest", [A, rule.id, "Quem aprova agora é o Pedro"]);
  assert.ok(!(await items()).some((i) => i.id === rule.id));
  await as(member);
  assert.ok(!(await rpc("client_dossier_context", [A, client])).some((i) => i.id === rule.id));
  await as(member);
  assert.deepEqual((await rpc("client_dossier", [A, client])).contested, []);
  await as(manager);
  const d = await rpc("client_dossier", [A, client]);
  assert.equal(d.contested[0].contest_reason, "Quem aprova agora é o Pedro");
  assert.equal(d.contested[0].created_by, member);
  // Só líderes decidem.
  await as(member);
  await rejects(() => rpc("client_dossier_resolve", [A, contest, "restore"]), /Só administradores e gestores/);
  // Restaurar: volta igual (o mesmo id).
  await as(manager);
  await rpc("client_dossier_resolve", [A, contest, "restore"]);
  const back = (await items()).find((i) => i.id === rule.id);
  assert.equal(back.text, "Toda peça passa pela Joana antes de publicar.");
  // De novo, e agora descartar: o da MAVI fica como removido.
  await as(member);
  const again = await rpc("client_dossier_contest", [A, rule.id, ""]);
  await as(manager);
  await rpc("client_dossier_resolve", [A, again, "discard"]);
  assert.equal((await items()).find((i) => i.id === rule.id).dismissed, true);
  await as(manager);
  await rejects(() => rpc("client_dossier_resolve", [A, again, "restore"]), /não encontrada/);
  // Uma pessoa contestou o item escrito por um líder: descartar tira de vez.
  await as(admin);
  const own = await rpc("client_dossier_save", [A, client, null, "context", "Vende para clínicas."]);
  await as(member);
  const c3 = await rpc("client_dossier_contest", [A, own, "Agora vende para academias"]);
  await as(admin);
  await rpc("client_dossier_resolve", [A, c3, "discard"]);
  assert.ok(!(await items()).some((i) => i.id === own));
  // A rotina não traz de volta o texto descartado.
  assert.equal(await store([{ op: "add", kind: "context", text: "Vende para clínicas.", route: "apply" }]), 0);
});

await check("memória usada: a resposta guarda os ids do dossiê; os textos só para quem vê", async () => {
  await as(member);
  const conv = await rpc("ai_save_turn", [A, null, JSON.stringify({ client }), "assistant", "Como é o tom?", "Leve.", "[]", "[]"]);
  const [m] = await sql(`select id from ai_messages where conversation_id = $1 and role = 'assistant'`, [conv]);
  await as(member);
  const ids = (await rpc("client_dossier_context", [A, client])).map((i) => i.id);
  await as(member);
  await rpc("mavi_dossier_used", [Number(m.id), [...ids, uid(998)]]);
  assert.deepEqual([...(await sql(`select dossier from ai_messages where id = $1`, [m.id]))[0].dossier].sort(), [...ids].sort());
  await as(outsider);
  await rejects(() => rpc("mavi_dossier_used", [Number(m.id), ids]), /não encontrada/);
  await as(member);
  assert.equal((await rpc("client_dossier_lookup", [A, ids])).length, ids.length);
  await as(outsider);
  assert.deepEqual(await rpc("client_dossier_lookup", [A, ids]), []);
  await as(member);
  await assert.rejects(() => db.query("select * from client_dossier_proposals"), /permission denied/);
  await db.exec("reset role");
});

console.log(`\n${passed} verificações da memória por cliente passaram.`);

// MAVI · memória por pessoa, Fase 1 (migration 20270611090000_mavi_memory_person):
// estável × situação (60 dias; vencido não entra na pergunta nem no juiz;
// renovar), de onde veio cada item, a anotação na conversa (add, replace,
// forget, com teto por hora), a memória usada por resposta (só os ids; os
// textos só para quem vê a base) e o histórico de quem mudou.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, gil, ana, bia] = [1, 10, 11, 12, 13].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, gil, ana, bia]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Gil Gestor','manager',true),($1,$4,'Ana Equipe','member',true),($1,$5,'Bia Equipe','member',true)`,
  [A, admin, gil, ana, bia],
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
const contextTexts = async (user) => {
  await as(user);
  return (await rpc("mavi_person_context", [A])).items.map((i) => i.text).sort();
};

await sql(`insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`, [SECRET]);
await as(ana);
const conv = await rpc("ai_save_turn", [A, null, "{}", "assistant", "Quero tudo em tabela daqui pra frente", "Combinado.", "[]", "[]"]);
const [m] = await sql(`select id from ai_messages where conversation_id = $1 and role = 'assistant'`, [conv]);
const message = Number(m.id);

let situation;
await check("situação vale 60 dias: vencida sai da pergunta e do juiz; renovar e corrigir trazem de volta", async () => {
  await as(ana);
  const stable = await rpc("mavi_person_trait_save", [A, null, null, "preference", "Responda em tabela."]);
  await as(ana);
  situation = await rpc("mavi_person_trait_save", [A, null, null, "context", "Está fechando o mês do cliente 5022.", "situation"]);
  let [row] = await sql(`select durability, valid_until > now() + interval '59 days' ok from mavi_person_traits where id = $1`, [situation]);
  assert.deepEqual([row.durability, row.ok], ["situation", true]);
  assert.equal((await sql(`select valid_until from mavi_person_traits where id = $1`, [stable]))[0].valid_until, null);
  assert.deepEqual(await contextTexts(ana), ["Está fechando o mês do cliente 5022.", "Responda em tabela."]);
  // Venceu.
  await sql(`update mavi_person_traits set valid_until = now() - interval '1 day' where id = $1`, [situation]);
  assert.deepEqual(await contextTexts(ana), ["Responda em tabela."]);
  await as(null);
  assert.deepEqual((await rpc("mavi_judge_person", [SECRET, message])).map((t) => t.text), ["Responda em tabela."]);
  await as(ana);
  const mine = await rpc("mavi_person_profile", [A, null]);
  assert.equal(mine.valid_days, 60);
  assert.equal(mine.items.find((i) => i.id === situation).expired, true);
  // Renovar: mais 60 dias.
  await as(ana);
  await rpc("mavi_person_trait_set", [A, situation, "renew"]);
  assert.deepEqual(await contextTexts(ana), ["Está fechando o mês do cliente 5022.", "Responda em tabela."]);
  // Renovar um item estável não muda nada.
  await as(ana);
  await rpc("mavi_person_trait_set", [A, stable, "renew"]);
  assert.equal((await sql(`select valid_until from mavi_person_traits where id = $1`, [stable]))[0].valid_until, null);
  // Virar estável tira a validade.
  await as(ana);
  await rpc("mavi_person_trait_save", [A, null, situation, "context", "Cuida do fechamento do mês do 5022.", "stable"]);
  [row] = await sql(`select durability, valid_until from mavi_person_traits where id = $1`, [situation]);
  assert.deepEqual([row.durability, row.valid_until], ["stable", null]);
  await rejects(
    () => sql(`update mavi_person_traits set durability = 'situation' where id = $1`, [situation]),
    /mavi_person_traits_validity/,
  );
});

let noted;
await check("na conversa: a MAVI anota, corrige e esquece o que a pessoa disse, com a conversa como fonte", async () => {
  await as(ana);
  const add = await rpc("mavi_person_note", [A, "add", null, "frustration", "Não abra com introdução.", "stable", conv, "Para de enrolar no começo"]);
  noted = add.id;
  assert.deepEqual([add.op, add.text], ["add", "Não abra com introdução."]);
  let [row] = await sql(`select origin, pinned, sources from mavi_person_traits where id = $1`, [noted]);
  assert.deepEqual([row.origin, row.pinned], ["person", true]);
  assert.equal(row.sources[0].type, "chat");
  assert.equal(row.sources[0].conversation, conv);
  assert.equal(row.sources[0].said, "Para de enrolar no começo");
  // Corrigir: o antigo sai, o novo entra.
  await as(ana);
  const rep = await rpc("mavi_person_note", [A, "replace", noted, "frustration", "Vá direto ao ponto, sem introdução.", "stable", conv, ""]);
  assert.equal(rep.previous, "Não abra com introdução.");
  assert.equal((await sql(`select dismissed from mavi_person_traits where id = $1`, [noted]))[0].dismissed, true);
  // Dizer de novo o que foi removido traz de volta (sem duplicar).
  await as(ana);
  const again = await rpc("mavi_person_note", [A, "add", null, "frustration", "não abra com introdução.", "stable", conv, ""]);
  assert.equal(again.id, noted);
  assert.equal((await sql(`select dismissed from mavi_person_traits where id = $1`, [noted]))[0].dismissed, false);
  assert.equal((await sql(`select jsonb_array_length(sources) n from mavi_person_traits where id = $1`, [noted]))[0].n, 2);
  // Esquecer.
  await as(ana);
  const gone = await rpc("mavi_person_note", [A, "forget", rep.id, null, null, null, conv, ""]);
  assert.equal(gone.op, "forget");
  assert.ok(!(await contextTexts(ana)).includes("Vá direto ao ponto, sem introdução."));
  // A conversa de outra pessoa não vira fonte; o item de outra pessoa não é dela.
  await as(bia);
  const other = await rpc("mavi_person_note", [A, "add", null, "preference", "Use emojis.", "stable", conv, ""]);
  assert.equal((await sql(`select sources->0->>'conversation' c from mavi_person_traits where id = $1`, [other.id]))[0].c, null);
  await as(bia);
  await rejects(() => rpc("mavi_person_note", [A, "forget", noted, null, null, null, null, ""]), /não encontrado/);
  await as(ana);
  await rejects(() => rpc("mavi_person_note", [A, "add", null, "humor", "Algo aqui", "stable", null, ""]), /Tipo inválido/);
});

await check("no máximo 6 anotações por hora (esquecer não conta)", async () => {
  // Até aqui: add, replace (novo), add (de volta) = 3.
  for (let i = 0; i < 3; i++) {
    await as(ana);
    await rpc("mavi_person_note", [A, "add", null, "preference", `Preferência número ${i}.`, "stable", null, ""]);
  }
  await as(ana);
  await rejects(() => rpc("mavi_person_note", [A, "add", null, "preference", "Mais uma.", "stable", null, ""]), /bastante nesta hora/);
  await as(ana);
  assert.equal((await rpc("mavi_person_note", [A, "forget", noted, null, null, null, null, ""])).op, "forget");
  // O que a pessoa escreve na tela não tem esse teto.
  await as(ana);
  assert.ok(await rpc("mavi_person_trait_save", [A, null, null, "preference", "Escrito na tela."]));
});

await check("o histórico: quem mudou (MAVI na conversa, a pessoa, um líder, a rotina) e o quê", async () => {
  await as(gil);
  await rpc("mavi_person_trait_save", [A, ana, null, "context", "Atende o Squad Primogênito."]);
  await as(null);
  await rpc("mavi_person_store", [SECRET, A, ana, JSON.stringify([{ op: "add", kind: "preference", text: "Traga a temperatura junto." }]), null]);
  await as(ana);
  const log = (await rpc("mavi_person_profile", [A, null])).log;
  const find = (after) => log.find((l) => l.after === after);
  assert.equal(find("Não abra com introdução.").actor, "mavi");
  assert.equal(find("Escrito na tela.").actor, "person");
  assert.equal(find("Atende o Squad Primogênito.").actor, "leader");
  assert.equal(find("Atende o Squad Primogênito.").by, gil);
  assert.equal(find("Traga a temperatura junto.").actor, "mavi");
  assert.equal(find("Traga a temperatura junto.").by, null);
  assert.ok(log.some((l) => l.action === "renew"));
  assert.ok(log.some((l) => l.action === "dismiss" && l.before === "Não abra com introdução."));
  assert.ok(log.some((l) => l.action === "edit" && l.before === "Está fechando o mês do cliente 5022."));
  // Ninguém lê a tabela direto.
  await as(ana);
  await assert.rejects(() => db.query("select * from mavi_person_trait_log"), /permission denied/);
  await db.exec("reset role");
});

await check("a rotina: fontes e situação; atualizar um item de situação renova", async () => {
  await as(null);
  await rpc("mavi_person_store", [
    SECRET,
    A,
    ana,
    JSON.stringify([
      {
        op: "add",
        kind: "context",
        text: "Está montando o relatório trimestral.",
        durability: "situation",
        sources: [{ type: "feedback", id: 1 }, { type: "question", message: message }, { type: "hack" }, "x"],
      },
    ]),
    null,
  ]);
  let [row] = await sql(`select id, durability, valid_until > now() ok, sources from mavi_person_traits where text = 'Está montando o relatório trimestral.'`);
  assert.deepEqual([row.durability, row.ok], ["situation", true]);
  assert.deepEqual(row.sources.map((s) => s.type), ["feedback", "question"]);
  await sql(`update mavi_person_traits set valid_until = now() - interval '1 day' where id = $1`, [row.id]);
  await as(null);
  await rpc("mavi_person_store", [SECRET, A, ana, JSON.stringify([{ op: "update", id: row.id, sources: [{ type: "check", message }] }]), null]);
  [row] = await sql(`select valid_until > now() ok, sources, text from mavi_person_traits where id = $1`, [row.id]);
  assert.equal(row.ok, true);
  assert.equal(row.text, "Está montando o relatório trimestral.");
  assert.deepEqual(row.sources.map((s) => s.type), ["check", "feedback", "question"]);
  // A leitura da rotina: ids das avaliações, conferências e perguntas; vencidos marcados.
  await as(ana);
  await rpc("mavi_feedback_vote", [message, "down", "format", "Sempre em tabela"]);
  await sql(`update mavi_private.mavi_person_state set dirty_at = now() - interval '20 minutes', built_at = null`);
  await as(null);
  const claim = await rpc("mavi_person_claim", [SECRET]);
  assert.equal(claim.user, ana);
  assert.equal(typeof claim.feedback[0].id, "number");
  assert.equal(claim.question_ids.length, claim.questions.length);
  assert.ok(claim.items.every((i) => "expired" in i && "durability" in i));
});

await check("memória usada: a resposta guarda só os ids; os textos só para quem vê a base", async () => {
  await as(ana);
  const ids = (await rpc("mavi_person_context", [A])).items.map((i) => i.id);
  assert.ok(ids.length >= 2);
  await as(ana);
  await rpc("mavi_person_used", [message, [...ids, uid(999)]]);
  const [row] = await sql(`select memory from ai_messages where id = $1`, [message]);
  assert.deepEqual([...row.memory].sort(), [...ids].sort());
  // Só quem fez a pergunta grava.
  await as(bia);
  await rejects(() => rpc("mavi_person_used", [message, ids]), /não encontrada/);
  // A conversa compartilhada mostra os ids, mas os textos não.
  await sql(`insert into ai_conversation_shares(company_id, conversation_id, user_id, shared_by) values ($1,$2,$3,$4)`, [A, conv, bia, ana]);
  await as(bia);
  assert.equal((await db.query(`select memory from ai_messages where id = $1`, [message])).rows[0].memory.length, ids.length);
  await as(bia);
  assert.deepEqual(await rpc("mavi_person_lookup", [A, ids]), []);
  await as(ana);
  assert.equal((await rpc("mavi_person_lookup", [A, ids])).length, ids.length);
  await as(gil);
  assert.equal((await rpc("mavi_person_lookup", [A, ids])).length, ids.length);
});

console.log(`\n${passed} verificações da memória por pessoa passaram.`);

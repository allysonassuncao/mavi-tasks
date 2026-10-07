// MAVI · edição direta no canvas (migration 20270610090000_canvas_edits): a
// versão editada vira uma mensagem da pessoa na conversa, só de quem começou
// a conversa, sem repetir referência e só com um documento válido.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, ana, bia] = [1, 12, 13].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[ana, bia]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values ($1,$2,'Ana','member',true),($1,$3,'Bia','member',true)`,
  [A, ana, bia],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user ?? ""]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
const q = async (user, text, args = []) => {
  await as(user);
  return (await db.query(text, args)).rows;
};
const one = async (user, text, args = []) => Object.values((await q(user, text, args))[0])[0];
let passed = 0;
async function check(title, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${title}`);
  } catch (e) {
    console.error(`FAIL ${title}`, String(e?.message ?? e).slice(0, 300));
    throw e;
  }
}

const doc = (ref, title) => ({
  id: `canvas-${ref}`,
  ref,
  type: "canvas",
  canvas: { kind: "document", title, markdown: "Um texto longo o bastante." },
});
const conv = await one(ana, "select public.ai_save_turn($1,null,'{}'::jsonb,'assistant','Faça a proposta','[[D1]]','[]'::jsonb,'[]'::jsonb,$2::jsonb)", [
  A,
  JSON.stringify([doc("D1", "Proposta")]),
]);

await check("quem começou a conversa salva a versão editada como mensagem dela", async () => {
  const id = await one(ana, "select public.ai_canvas_edit($1,$2,$3::jsonb)", [
    conv,
    "Editei o D1 no canvas: versão D2.",
    JSON.stringify({ ...doc("D2", "Proposta v2"), revision_of: "D1", edited: true }),
  ]);
  assert.ok(Number(id) > 0);
  const rows = await q(ana, "select role, content, artifacts from ai_messages where conversation_id = $1 order by id", [conv]);
  assert.deepEqual(rows.map((r) => r.role), ["user", "assistant", "user"]);
  assert.equal(rows[2].content, "Editei o D1 no canvas: versão D2.");
  assert.equal(rows[2].artifacts[0].ref, "D2");
});

await check("sem repetir referência, só documento válido, só a dona da conversa", async () => {
  await assert.rejects(() => q(ana, "select public.ai_canvas_edit($1,'x',$2::jsonb)", [conv, JSON.stringify(doc("D1", "x"))]), /já tem um D1/);
  await assert.rejects(
    () => q(ana, "select public.ai_canvas_edit($1,'x',$2::jsonb)", [conv, JSON.stringify({ id: "img-1", ref: "I1", type: "image", path: "x" })]),
    /Documento inválido/,
  );
  await assert.rejects(() => q(ana, "select public.ai_canvas_edit($1,'x',$2::jsonb)", [conv, JSON.stringify(doc("X9", "x"))]), /Referência inválida/);
  await assert.rejects(() => q(bia, "select public.ai_canvas_edit($1,'x',$2::jsonb)", [conv, JSON.stringify(doc("D3", "x"))]), /Só quem começou/);
});

console.log(`\n${passed} verificações passaram.`);

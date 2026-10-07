// MAVI · o trecho de cada fonte citada pelos índices (migration
// 20270603120000_ai_source_excerpt_fast): reunião pelo momento, PDF pela
// página, WhatsApp pela mensagem (ou o bloco que a contém), só da empresa, e
// rápido com milhares de documentos (antes, cada fonte varria a base).
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, meeting, file, group, day, m1, m2, m3] = [1, 2, 20, 21, 30, 31, 41, 42, 43].map(uid);
const q = (text, args = []) => db.query(text, args);
await q(`insert into companies(id,name) values($1,'Make'),($2,'Outra')`, [A, B]);
await q(`set session_replication_role = replica`);
const doc = async (company, type, source) =>
  (await q(`insert into ai_documents(company_id, source_type, source_id, access, content_hash) values($1,$2,$3,'client','h') returning id`,
    [company, type, source])).rows[0].id;
const chunk = (company, d, ord, content, type, meta) =>
  q(`insert into ai_chunks(company_id, document_id, ord, content, source_type, access, meta) values($1,$2,$3,$4,$5,'client',$6)`,
    [company, d, ord, content, type, JSON.stringify(meta)]);
const dm = await doc(A, "meeting", meeting);
for (const [i, s] of [0, 60, 120].entries()) await chunk(A, dm, i, `fala aos ${s}s`, "meeting", { start: s });
const df = await doc(A, "drive_file", file);
for (const p of [1, 2, 3]) await chunk(A, df, p, `página ${p}`, "drive_file", { page: p });
await q(`insert into whatsapp_messages(id, company_id, group_id, wa_id, sent_at, kind) values
  ($1,$4,$5,'a','2026-10-06 13:00:00+00','text'),($2,$4,$5,'b','2026-10-06 13:05:00+00','text'),($3,$4,$5,'c','2026-10-06 15:00:00+00','text')`,
  [m1, m2, m3, A, group]);
await q(`insert into mavi_private.whatsapp_ai_days(id, company_id, group_id, day) values($1,$2,$3,'2026-10-06')`, [day, A, group]);
const dw = await doc(A, "whatsapp", day);
await chunk(A, dw, 0, "10:00 Ana: oi\n10:05 Bia: tudo certo", "whatsapp", { message: m1, at: "2026-10-06T13:00:00+00:00" });
await chunk(A, dw, 1, "12:00 Ana: fechado", "whatsapp", { message: m3, at: "2026-10-06T15:00:00+00:00" });
// Milhares de documentos de outros assuntos.
await q(`insert into ai_documents(company_id, source_type, source_id, access, content_hash)
  select $1, 'task', gen_random_uuid(), 'client', 'h' from generate_series(1, 4000)`, [A]);
await q(`insert into ai_chunks(company_id, document_id, ord, content, source_type, access, meta)
  select d.company_id, d.id, g, 'texto', 'task', 'client', '{}' from ai_documents d, generate_series(0, 2) g where d.source_type = 'task'`);
await q(`set session_replication_role = origin`);
const ex = async (company, src) =>
  (await q(`select mavi_private.ai_source_excerpt($1, $2::jsonb) as t`, [company, JSON.stringify(src)])).rows[0].t;

assert.equal(await ex(A, { type: "meeting", id: meeting, start: 65 }), "fala aos 60s");
assert.equal(await ex(A, { type: "meeting", id: meeting }), "fala aos 0s");
assert.equal(await ex(A, { type: "file", id: file, page: 3 }), "página 3");
assert.equal(await ex(A, { type: "whatsapp", id: m1 }), "10:00 Ana: oi\n10:05 Bia: tudo certo");
// A mensagem dentro de um bloco: o bloco que começou antes dela.
assert.equal(await ex(A, { type: "whatsapp", id: m2 }), "10:00 Ana: oi\n10:05 Bia: tudo certo");
assert.equal(await ex(A, { type: "whatsapp", id: m3 }), "12:00 Ana: fechado");
console.log("PASS reunião pelo momento, PDF pela página, WhatsApp pela mensagem ou pelo bloco");

assert.equal(await ex(B, { type: "meeting", id: meeting }), null);
assert.equal(await ex(B, { type: "whatsapp", id: m1 }), null);
assert.equal(await ex(A, { type: "meeting", id: "nao-e-uuid" }), null);
assert.equal(await ex(A, { type: "file", id: meeting }), null);
console.log("PASS só da empresa; id inválido ou tipo errado não acha");

const started = Date.now();
for (let i = 0; i < 20; i++) {
  await ex(A, { type: "meeting", id: meeting, start: 65 });
  await ex(A, { type: "whatsapp", id: m2 });
}
const ms = Date.now() - started;
assert.ok(ms < 1500, `40 buscas em ${ms} ms`);
const plan = (await q(`explain select d.id from ai_documents d where d.company_id = $1 and d.source_type = any(array['meeting']) and d.source_id = $2`, [A, meeting])).rows.map((r) => r["QUERY PLAN"]).join("\n");
assert.match(plan, /Index/);
console.log(`PASS rápido com 4.000 documentos e 12.000 trechos (40 buscas em ${ms} ms), pelo índice`);
console.log("\n3 verificações do trecho das fontes passaram.");

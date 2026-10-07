// MAVI · roteador de modelos, fase 3 (migration 20270530090000_ai_router_tools):
// as ferramentas que a conversa usou há pouco (só as que deram certo, só na
// conversa de quem pergunta; para os outros, nada).
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, ana, bia] = [1, 11, 12].map(uid);
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
async function rpc(name, args) {
  return (
    await db.query(`select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})) as result`, args)
  ).rows[0].result;
}
const sql = async (text, args = []) => {
  await db.exec("reset role");
  return (await db.query(text, args)).rows;
};

await as(ana);
const conv = await rpc("ai_save_turn", [A, null, "{}", "assistant", "Leads?", "3 leads", "[]", "[]"]);
await sql(
  `insert into ai_tool_calls(company_id, user_id, conversation_id, tool, ok) values
   ($1,$2,$3,'mcp:crm/list_leads',true),($1,$2,$3,'mcp:crm/list_leads',true),($1,$2,$3,'campaign_results',true),
   ($1,$2,$3,'mcp:crm/invoice',false)`,
  [A, ana, conv],
);
await as(ana);
assert.deepEqual((await rpc("ai_recent_tools", [conv, 30])).sort(), ["campaign_results", "mcp:crm/list_leads"]);
await as(bia);
assert.deepEqual(await rpc("ai_recent_tools", [conv, 30]), []);
console.log("PASS as ferramentas usadas há pouco: só as que deram certo, só na conversa de quem pergunta");
console.log("\n1 verificação das ferramentas por intenção passou.");

// Agenda / Google Calendar (migration 20260930160000_google_calendar): the
// connection belongs to one person, states are single-use and short-lived,
// and nobody else — nor the browser without the server's key — gets tokens.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, ana, bia] = [1, 10, 11].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [ana, bia],
]);
await db.query(`insert into companies(id,name) values($1,'Empresa A')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values ($1,$2,'Ana','admin'),($1,$3,'Bia','member')`,
  [A, ana, bia],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [
    user ?? "",
  ]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
const call = async (fn, args = []) =>
  (
    await db.query(
      `select * from public.${fn}(${args.map((_, i) => `$${i + 1}`).join(",")})`,
      args,
    )
  ).rows;
const sql = async (text, args = []) => {
  await db.exec("reset role");
  return (await db.query(text, args)).rows;
};
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
const complete = (state, email = "ana@gmail.com") =>
  as(null).then(() =>
    call("google_complete_connect", [
      state,
      email,
      "https://www.googleapis.com/auth/calendar",
      "v1:refresh",
      "v1:access",
      new Date(Date.now() + 3600e3).toISOString(),
    ]),
  );

await check("anônimo não começa uma conexão", async () => {
  await as(null);
  await assert.rejects(call("google_begin_connect"));
});

let state;
await check("o estado liga os tokens a quem começou, uma vez só", async () => {
  await as(ana);
  [{ google_begin_connect: state }] = await call("google_begin_connect");
  assert.match(state, /^[0-9a-f]{64}$/);
  await complete(state);
  await as(ana);
  const [conn] = await call("google_connection");
  assert.equal(conn.account_email, "ana@gmail.com");
  await assert.rejects(complete(state), /expirada/, "estado já usado");
  await assert.rejects(
    complete("f".repeat(64)),
    /expirada/,
    "estado inventado",
  );
});

await check("estado velho não serve", async () => {
  await as(bia);
  const [{ google_begin_connect: old }] = await call("google_begin_connect");
  await sql(
    "update mavi_private.google_oauth_states set created_at = now() - interval '20 minutes'",
  );
  await assert.rejects(complete(old, "bia@gmail.com"), /expirada/);
});

await check(
  "cada pessoa só vê a própria conexão e os próprios tokens",
  async () => {
    await as(bia);
    assert.equal((await call("google_connection")).length, 0);
    assert.equal((await call("google_tokens")).length, 0);
    await as(ana);
    const [tokens] = await call("google_tokens");
    assert.equal(tokens.refresh_token_cipher, "v1:refresh");
    await as(null);
    await assert.rejects(call("google_tokens"));
    await assert.rejects(call("google_connection"));
    // The tables themselves are out of reach.
    await as(ana);
    await assert.rejects(
      db.query("select * from mavi_private.google_connections"),
    );
  },
);

await check("renovar o token e desconectar", async () => {
  await as(ana);
  await call("google_save_access", ["v1:novo", new Date().toISOString()]);
  await as(bia);
  await call("google_save_access", ["v1:bia", new Date().toISOString()]);
  await as(ana);
  assert.equal((await call("google_tokens"))[0].access_token_cipher, "v1:novo");
  await as(bia);
  await call("google_disconnect");
  await as(ana);
  assert.equal(
    (await call("google_connection")).length,
    1,
    "a de Bia não afeta a de Ana",
  );
  await call("google_disconnect");
  assert.equal((await call("google_connection")).length, 0);
});

await check("sem token de renovação, nada é salvo", async () => {
  await as(ana);
  const [{ google_begin_connect: s }] = await call("google_begin_connect");
  await as(null);
  await assert.rejects(
    call("google_complete_connect", [s, "ana@gmail.com", "", null, null, null]),
    /incompleta/,
  );
});

console.log(`\n${passed} verificações da agenda passaram.`);

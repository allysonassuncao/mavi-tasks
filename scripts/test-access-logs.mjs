// Logs de login e acesso (migration 20261112090000_access_logs): o Auth
// registra logins e saídas, o app registra os acessos, e só administradores e
// gestores leem — gestores, sem os administradores.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, admin2, manager, member, outsider] = [
  1, 2, 10, 11, 12, 13, 14,
].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, admin2, manager, member, outsider],
]);
await db.query(
  `insert into companies(id,name) values($1,'Empresa A'),($2,'Empresa B')`,
  [A, B],
);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$3,'Ana Admin','admin'),($1,$4,'Beto Admin','admin'),
   ($1,$5,'Gabi Gestora','manager'),($1,$6,'Caio Colaborador','member'),
   ($2,$6,'Caio em B','member'),($2,$7,'Fora','admin')`,
  [A, B, admin, admin2, manager, member, outsider],
);
async function as(user, headers = {}) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [
    user ?? "",
  ]);
  await db.query(`select set_config('request.headers',$1,false)`, [
    JSON.stringify(headers),
  ]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
const logs = async (viewer, target, args = {}) => {
  await as(viewer);
  return (
    await db.query("select public.member_access_logs($1,$2,$3,$4,$5) as r", [
      A,
      target,
      args.kind ?? null,
      args.before ?? null,
      args.limit ?? null,
    ])
  ).rows[0].r;
};
// What the Supabase Auth does on sign-in and sign-out.
async function signIn(user, method = "password") {
  await db.exec("reset role");
  const { rows } = await db.query(
    `insert into auth.sessions(user_id,ip,user_agent) values($1,'203.0.113.7','Mozilla/5.0 (Macintosh) Chrome/140.0') returning id`,
    [user],
  );
  await db.query(
    `insert into auth.mfa_amr_claims(session_id,authentication_method) values($1,$2)`,
    [rows[0].id, method],
  );
  return rows[0].id;
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

await check(
  "login pelo Auth fica registrado com IP, navegador e método",
  async () => {
    await signIn(member, "password");
    const { items, summary } = await logs(admin, member);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "login");
    assert.equal(items[0].method, "password");
    assert.equal(items[0].ip, "203.0.113.7");
    assert.match(items[0].user_agent, /Chrome/);
    assert.equal(summary.logins_30d, 1);
    assert.ok(summary.last_login);
  },
);

await check("saída encerra a sessão e mostra quando ela começou", async () => {
  const session = await signIn(member, "recovery");
  await db.exec("reset role");
  await db.query("delete from auth.sessions where id=$1", [session]);
  const { items } = await logs(admin, member, { kind: "logout" });
  assert.equal(items.length, 1);
  assert.ok(items[0].session_started_at);
  const login = (await logs(admin, member, { kind: "login" })).items[0];
  assert.equal(login.method, "recovery");
});

await check(
  "acesso ao espaço: IP do gateway, um a cada 30 minutos",
  async () => {
    const headers = {
      "x-forwarded-for": "198.51.100.4, 10.0.0.1",
      "user-agent": "Mozilla/5.0 (iPhone) Safari/605.1",
    };
    await as(member, headers);
    await db.query("select public.log_access($1)", [A]);
    await db.query("select public.log_access($1)", [A]);
    const access = (await logs(admin, member, { kind: "access" })).items;
    assert.equal(access.length, 1);
    assert.equal(access[0].ip, "198.51.100.4");
    assert.match(access[0].user_agent, /iPhone/);
  },
);

await check("acesso em outro espaço não aparece neste", async () => {
  await as(member, { "x-forwarded-for": "192.0.2.1" });
  await db.query("select public.log_access($1)", [B]);
  const ips = (await logs(admin, member)).items.map((i) => i.ip);
  assert.ok(!ips.includes("192.0.2.1"));
  // …mas quem não é do espaço não registra nada.
  await as(outsider);
  await db.query("select public.log_access($1)", [A]);
  await db.exec("reset role");
  const { rows } = await db.query(
    "select count(*)::int n from access_logs where user_id=$1",
    [outsider],
  );
  assert.equal(rows[0].n, 0);
});

await check(
  "gestor vê colaboradores e a si mesmo, não administradores",
  async () => {
    assert.ok((await logs(manager, member)).items.length);
    await logs(manager, manager);
    await assert.rejects(logs(manager, admin), /outro administrador/);
    // Administrador vê outro administrador.
    await logs(admin, admin2);
  },
);

await check("colaborador e gente de fora não leem", async () => {
  await assert.rejects(logs(member, member), /administradores e gestores/);
  await assert.rejects(logs(outsider, member), /administradores e gestores/);
  await assert.rejects(logs(admin, outsider), /não encontrado/);
  await as(member);
  await assert.rejects(db.query("select * from access_logs"), /permission/);
});

await check(
  "paginação pelo último id, sem resumo nas páginas seguintes",
  async () => {
    for (let i = 0; i < 4; i++) await signIn(member);
    const first = await logs(admin, member, { limit: 3 });
    assert.equal(first.items.length, 3);
    const next = await logs(admin, member, {
      limit: 3,
      before: first.items.at(-1).id,
    });
    assert.equal(next.summary, null);
    assert.ok(next.items.every((i) => i.id < first.items.at(-1).id));
    await assert.rejects(logs(admin, member, { kind: "x" }), /inválido/);
  },
);

await check("falha no log nunca impede o login", async () => {
  await db.exec("reset role");
  await db.exec(
    "alter table access_logs add constraint no_ip check (ip is null) not valid",
  );
  const session = await signIn(member);
  const { rows } = await db.query("select 1 from auth.sessions where id=$1", [
    session,
  ]);
  assert.equal(rows.length, 1);
  await db.exec("alter table access_logs drop constraint no_ip");
});

console.log(`${passed} checks passed`);

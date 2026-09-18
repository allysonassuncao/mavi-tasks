import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create schema auth; create schema storage;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema auth,public,storage to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
alter table storage.objects enable row level security;grant select,insert,update,delete on storage.objects to authenticated;`);
for (const file of (await readdir("supabase/migrations")).sort())
  await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, member, foreignUser, manager, isolated] = [
  1, 2, 10, 11, 12, 13, 14,
].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, member, foreignUser, manager, isolated],
]);
await db.query(
  `insert into companies(id,name) values($1,'Empresa A'),($2,'Empresa B')`,
  [A, B],
);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values($1,$3,'Admin A','admin'),($1,$4,'Membro A','member'),($2,$5,'Admin B','admin'),($1,$6,'Gestor A','manager'),($1,$7,'Isolado A','member')`,
  [A, B, admin, member, foreignUser, manager, isolated],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [
    user ?? "",
  ]);
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
async function denied(fn) {
  await assert.rejects(fn);
}
await as(admin);
const team = await rpc("create_team", [A, "Equipe A", [manager, member]]);
const client = await rpc("create_client", [A, "Cliente A", ""]);
const product = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [
  A,
  client,
  product,
  "Contrato A",
  team,
]);
const task = await rpc("create_task", [
  A,
  contract,
  "Tarefa protegida",
  member,
  "2026-10-01",
  null,
  team,
  "",
  "normal",
  60,
  true,
]);
await check("administrador lê a própria empresa", async () =>
  assert.equal((await db.query("select * from companies")).rows.length, 1),
);
await check("criação em outra empresa é bloqueada", () =>
  denied(() => rpc("create_client", [B, "Intruso", ""])),
);
await as(foreignUser);
const clientB = await rpc("create_client", [B, "Cliente B", ""]);
const productB = await rpc("create_product", [B, "Make CRM"]);
const contractB = await rpc("create_contract", [
  B,
  clientB,
  productB,
  "Contrato B",
  null,
]);
await check("outra empresa não vê tarefas por ID", async () =>
  assert.equal(
    (await db.query("select * from tasks where id=$1", [task])).rows.length,
    0,
  ),
);
await check("outra empresa não comenta por ID", () =>
  denied(() => rpc("add_comment", [task, "Tentativa"])),
);
await check("outra empresa não prepara arquivo", () =>
  denied(() => rpc("prepare_attachment", [task, "arquivo.pdf", 10])),
);
await check("outra empresa não obtém totais", async () =>
  assert.equal(
    (await rpc("report_summary", [A, "2026-01-01", "2027-01-01"])).total,
    0,
  ),
);
await as(admin);
await check("chave composta impede associação entre empresas", () =>
  denied(() => rpc("create_contract", [A, clientB, product, "Inválido", null])),
);
await check("tarefa não pode apontar para contrato de outra empresa", () =>
  denied(() =>
    rpc("create_task", [A, contractB, "Inválida", member, "2026-10-01"]),
  ),
);
await as(isolated);
await check("membro sem equipe não vê contrato ou tarefa", async () => {
  assert.equal((await db.query("select * from tasks")).rows.length, 0);
  assert.equal((await db.query("select * from contracts")).rows.length, 0);
});
await as(member);
await check("membro da equipe lê tarefa", async () =>
  assert.equal((await db.query("select * from tasks")).rows.length, 1),
);
await check("escrita direta não permite entregar sem aprovação", () =>
  denied(() => db.query(`update tasks set status='done' where id=$1`, [task])),
);
await check("escrita direta não permite elevar papel", () =>
  denied(() =>
    db.query(`update memberships set role='admin' where user_id=$1`, [member]),
  ),
);
await check("executor pode iniciar e enviar para validação", async () => {
  await rpc("transition_task", [task, 1, "start", ""]);
  await rpc("transition_task", [task, 2, "submit", ""]);
});
await check("executor não aprova internamente", () =>
  denied(() => rpc("transition_task", [task, 3, "approve_internal", ""])),
);
await as(manager);
await check("gestor da equipe aprova mas aguarda cliente", async () => {
  await rpc("transition_task", [task, 3, "approve_internal", ""]);
  assert.equal(
    (await db.query("select status from tasks where id=$1", [task])).rows[0]
      .status,
    "review",
  );
});
await check("evidência do cliente é obrigatória", () =>
  denied(() => rpc("transition_task", [task, 4, "approve_client", ""])),
);
await check("duas aprovações permitem entregar", async () => {
  await rpc("transition_task", [
    task,
    4,
    "approve_client",
    "Aprovado por Ana em reunião",
  ]);
  assert.equal(
    (await db.query("select status from tasks where id=$1", [task])).rows[0]
      .status,
    "done",
  );
});
await check("versão antiga é rejeitada", () =>
  denied(() => rpc("transition_task", [task, 4, "reopen", "Ajustes"])),
);
await check("reabrir invalida aprovações", async () => {
  await rpc("transition_task", [task, 5, "reopen", "Ajustes solicitados"]);
  const t = (await db.query("select * from tasks where id=$1", [task])).rows[0];
  assert.equal(t.internal_approved_by, null);
  assert.equal(t.client_approved_by, null);
  assert.equal(t.revision, 2);
});
await as(member);
let timer;
await check("iniciar cronômetro é idempotente", async () => {
  timer = await rpc("start_timer", [task]);
  assert.equal(await rpc("start_timer", [task]), timer);
});
await check("parar cronômetro é idempotente", async () => {
  await rpc("stop_timer", [timer]);
  const old = (
    await db.query("select ended_at from time_entries where id=$1", [timer])
  ).rows[0].ended_at;
  await rpc("stop_timer", [timer]);
  assert.deepEqual(
    (await db.query("select ended_at from time_entries where id=$1", [timer]))
      .rows[0].ended_at,
    old,
  );
});
await check("horas negativas rejeitadas", () =>
  denied(() =>
    rpc("log_time", [task, "2026-09-01T12:00:00Z", "2026-09-01T11:00:00Z", ""]),
  ),
);
await check("períodos sobrepostos rejeitados", async () => {
  await rpc("log_time", [
    task,
    "2026-09-01T12:00:00Z",
    "2026-09-01T13:00:00Z",
    "",
  ]);
  await denied(() =>
    rpc("log_time", [task, "2026-09-01T12:30:00Z", "2026-09-01T13:30:00Z", ""]),
  );
});
const attachment = await rpc("prepare_attachment", [task, "briefing.pdf", 100]);
await check("upload autorizado pelo registro e autor", async () => {
  await db.query("insert into storage.objects(bucket_id,name) values($1,$2)", [
    "mavi-attachments",
    attachment.path,
  ]);
  assert.equal(
    (await db.query("select * from storage.objects")).rows.length,
    1,
  );
});
await check("upload sem registro autorizado é bloqueado", () =>
  denied(() =>
    db.query("insert into storage.objects(bucket_id,name) values($1,$2)", [
      "mavi-attachments",
      `${A}/${task}/${uid(99)}`,
    ]),
  ),
);
await as(foreignUser);
await check("arquivo de outra empresa é invisível", async () =>
  assert.equal(
    (await db.query("select * from storage.objects")).rows.length,
    0,
  ),
);
await as(null);
await check("anônimo não consulta dados nem RPCs", async () => {
  await denied(() => db.query("select * from tasks"));
  await denied(() => rpc("create_client", [A, "Visitante", ""]));
});
await db.exec("reset role");
await db.query(
  "update memberships set active=false where company_id=$1 and user_id=$2",
  [A, member],
);
await as(member);
await check("revogar vínculo bloqueia sessão existente", async () => {
  assert.equal((await db.query("select * from tasks")).rows.length, 0);
  assert.equal(
    (await db.query("select * from storage.objects")).rows.length,
    0,
  );
  await denied(() => rpc("add_comment", [task, "Tentativa"]));
});
await db.exec('reset role');
const bootstrapCompany=uid(30), bootstrapUser=uid(31);
await db.query("insert into companies(id,name) values($1,'Bootstrap')",[bootstrapCompany]);
await db.query("insert into mavi_private.admin_provisioning(company_id,email,name) values($1,'owner@example.test','Owner')",[bootstrapCompany]);
await db.query("insert into auth.users(id,email) values($1,'owner@example.test')",[bootstrapUser]);
await check('e-mail não confirmado não recebe administração',async()=>assert.equal((await db.query('select * from memberships where company_id=$1',[bootstrapCompany])).rows.length,0));
await db.query('update auth.users set email_confirmed_at=now() where id=$1',[bootstrapUser]);
await check('e-mail confirmado consome provisionamento uma única vez',async()=>{
 assert.equal((await db.query('select role from memberships where company_id=$1 and user_id=$2',[bootstrapCompany,bootstrapUser])).rows[0].role,'admin');
 await db.query('update auth.users set email_confirmed_at=now() where id=$1',[bootstrapUser]);
 assert.equal((await db.query('select * from memberships where company_id=$1',[bootstrapCompany])).rows.length,1);
});
await as(bootstrapUser);
await check('administrador não consulta allowlist interna',()=>denied(()=>db.query('select * from mavi_private.admin_provisioning')));
await db.close();
console.log(
  `\n${passed} verificações de banco aprovadas (PostgreSQL embarcado; Auth e Storage simulados).`,
);

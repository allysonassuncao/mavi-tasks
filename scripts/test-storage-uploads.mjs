// Armazenamento (migration 20260930100000_storage_uploads): every upload is
// recorded, deletions keep history, and only leaders see everyone's usage.
// Arquivar cliente (migration 20260930110000_archive_client).
// Uso por cliente (migration 20260930120000_storage_by_client).
// Excluir e compartilhar (migration 20260930130000_storage_file_actions).
// Logo da empresa (migration 20260930150000_company_logo).
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, manager, member, outsider] = [1, 2, 10, 11, 12, 13].map(
  uid,
);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, manager, member, outsider],
]);
await db.query(
  `insert into companies(id,name) values($1,'Empresa A'),($2,'Empresa B')`,
  [A, B],
);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$3,'Ana Admin','admin'),($1,$4,'Gil Gestor','manager'),
   ($1,$5,'Bia Membro','member'),($2,$6,'Outra Empresa','admin')`,
  [A, B, admin, manager, member, outsider],
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
const rows = async (name, args) =>
  (
    await db.query(
      `select * from public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})`,
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
const ledger = (kind) =>
  sql(
    `select user_id,name,size_bytes,completed_at,deleted_at from storage_uploads
     where kind=$1 order by created_at`,
    [kind],
  );

await as(admin);
const team = await rpc("create_team", [A, "Equipe", [member]]);
const client = await rpc("create_client", [A, "Cliente A", "", [team]]);
const product = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [
  A,
  client,
  product,
  "Contrato",
  team,
]);
const due = "2026-10-10";
const task = await rpc("create_task", [A, contract, "Tarefa", member, due]);

await check("arquivo do Drive conta só depois de confirmado", async () => {
  await as(member);
  const file = await rpc("prepare_drive_file", [
    A,
    "briefing.pdf",
    1000,
    "application/pdf",
    "private",
    null,
    contract,
    null,
  ]);
  let [row] = await ledger("drive");
  assert.equal(row.user_id, member);
  assert.equal(Number(row.size_bytes), 1000);
  assert.equal(row.completed_at, null);
  await as(member);
  await rpc("confirm_drive_file", [file]);
  [row] = await ledger("drive");
  assert.ok(row.completed_at);
  await as(member);
  await rpc("rename_drive_file", [file, "briefing-final.pdf"]);
  [row] = await ledger("drive");
  assert.equal(row.name, "briefing-final.pdf");
  await as(member);
  await rpc("delete_drive_file", [file]);
  [row] = await ledger("drive");
  assert.ok(row.deleted_at, "exclusão mantém o histórico com deleted_at");
});

await check("anexo e imagem de texto são registrados", async () => {
  await as(member);
  const attachment = await rpc("prepare_attachment", [task, "foto.png", 2048]);
  await as(member);
  await rpc("prepare_inline_image", [A, "print.png", 512]);
  const [a] = await ledger("attachment");
  const [i] = await ledger("inline_image");
  assert.equal(Number(a.size_bytes), 2048);
  assert.ok(a.completed_at);
  assert.equal(Number(i.size_bytes), 512);
  // A failed upload is discarded: it stops counting.
  await as(member);
  await rpc("discard_pending_attachment", [attachment.id]);
  const [after] = await ledger("attachment");
  assert.ok(after.deleted_at);
});

await check(
  "foto de perfil registra o tamanho e troca a anterior",
  async () => {
    const url = (id) =>
      `https://storage.googleapis.com/b/avatars/${member}/${id}.webp`;
    await as(member);
    await rpc("set_my_avatar", [url(uid(900)), 30000]);
    await as(member);
    await rpc("set_my_avatar", [url(uid(901)), 9_999_999]);
    const photos = await ledger("avatar");
    assert.equal(photos.length, 2);
    assert.ok(photos[0].deleted_at, "a foto anterior deixa de contar");
    assert.equal(photos[1].deleted_at, null);
    assert.equal(Number(photos[1].size_bytes), 524288, "limitado a 512 KB");
    await as(member);
    await rpc("set_my_avatar", [null]);
    assert.ok((await ledger("avatar")).every((p) => p.deleted_at));
  },
);

await check("uso por pessoa soma só o que existe", async () => {
  await as(member);
  const file = await rpc("prepare_drive_file", [
    A,
    "video.mp4",
    5000,
    "video/mp4",
    "private",
    null,
    contract,
    null,
  ]);
  await as(member);
  await rpc("confirm_drive_file", [file]);
  await as(member);
  await rpc("prepare_drive_file", [
    A,
    "pendente.mp4",
    7000,
    "video/mp4",
    "private",
    null,
    contract,
    null,
  ]);
  await as(manager);
  const usage = await rows("storage_usage", [A]);
  const of = (kind) =>
    usage.find((u) => u.user_id === member && u.kind === kind);
  assert.equal(Number(of("drive").bytes), 5000, "pendente e excluído fora");
  assert.equal(Number(of("drive").files), 1);
  assert.equal(Number(of("inline_image").bytes), 512);
  assert.equal(of("attachment"), undefined);
  assert.equal(of("avatar"), undefined);
});

await check("somente gestores veem o uso de todos", async () => {
  await as(member);
  await assert.rejects(rows("storage_usage", [A]), /Sem permissão/);
  await as(outsider);
  await assert.rejects(rows("storage_usage", [A]), /Sem permissão/);
  await as(member);
  const own = (await db.query(`select user_id from storage_uploads`)).rows;
  assert.ok(own.length > 0 && own.every((r) => r.user_id === member));
  await as(outsider);
  assert.equal(
    (await db.query(`select 1 from storage_uploads`)).rows.length,
    0,
  );
  await as(admin);
  assert.ok((await db.query(`select 1 from storage_uploads`)).rows.length >= 4);
  await as(member);
  await assert.rejects(
    db.query(
      `insert into storage_uploads(company_id,user_id,kind,source_id,size_bytes)
       values($1,$2,'drive',$3,1)`,
      [A, member, uid(999)],
    ),
  );
});

await check("gestores arquivam e desarquivam clientes", async () => {
  await as(member);
  await assert.rejects(
    rpc("set_client_archived", [client, true]),
    /Sem permissão/,
  );
  await as(outsider);
  await assert.rejects(
    rpc("set_client_archived", [client, true]),
    /Sem permissão/,
  );
  await as(manager);
  await rpc("set_client_archived", [client, true]);
  let [c] = await sql("select archived from clients where id=$1", [client]);
  assert.equal(c.archived, true);
  // History stays: the task and its contract are untouched.
  const [t] = await sql("select archived from tasks where id=$1", [task]);
  assert.equal(t.archived, false);
  await as(manager);
  await rpc("set_client_archived", [client, false]);
  [c] = await sql("select archived from clients where id=$1", [client]);
  assert.equal(c.archived, false);
});

await check("cliente arquivado não recebe nada novo", async () => {
  await as(admin);
  await rpc("set_client_archived", [client, true]);
  await as(admin);
  await assert.rejects(
    rpc("create_task", [A, contract, "Nova", member, due]),
    /arquivado/,
  );
  await as(admin);
  await assert.rejects(
    rpc("create_project", [A, contract, "Projeto", null]),
    /arquivado/,
  );
  await as(admin);
  const other = await rpc("create_product", [A, "SEO"]);
  await as(admin);
  await assert.rejects(
    rpc("create_contract", [A, client, other, "SEO", null]),
    /arquivado/,
  );
  // Existing work can still be updated (e.g. closing open tasks).
  await as(admin);
  await rpc("set_client_archived", [client, false]);
  await as(admin);
  await rpc("create_task", [A, contract, "Depois de reativar", member, due]);
});

await check("uso por cliente segue onde o arquivo está", async () => {
  // So far: a 5000-byte Drive file in the client's product folder and a
  // 512-byte image not yet in any task.
  await as(member);
  await rpc("prepare_attachment", [task, "contrato.pdf", 3000]);
  await as(admin);
  await rpc("prepare_drive_file", [
    A,
    "manual-da-agencia.pdf",
    800,
    "application/pdf",
    "private",
    null,
    null,
    null,
  ]);
  await sql(
    "update drive_files set status='ready' where name='manual-da-agencia.pdf'",
  );
  await as(manager);
  let usage = await rows("storage_usage_by_client", [A]);
  const bytes = (id, kind) =>
    Number(
      usage.find((u) => u.client_id === id && u.kind === kind)?.bytes ?? 0,
    );
  assert.equal(bytes(client, "drive"), 5000);
  assert.equal(bytes(client, "attachment"), 3000);
  assert.equal(bytes(null, "inline_image"), 512, "imagem solta: sem cliente");
  assert.equal(bytes(null, "drive"), 800, "Drive geral: sem cliente");
  // The image joins a task: it now counts for that task's client.
  await sql("update inline_images set task_id=$1", [task]);
  await as(manager);
  usage = await rows("storage_usage_by_client", [A]);
  assert.equal(bytes(client, "inline_image"), 512);
  assert.equal(bytes(null, "inline_image"), 0);
});

await check("maiores arquivos de um cliente, só para gestores", async () => {
  await as(admin);
  const files = await rows("storage_client_files", [A, client, 50]);
  assert.deepEqual(
    files.map((f) => f.name),
    ["video.mp4", "contrato.pdf", "print.png"],
  );
  assert.ok(files.every((f) => f.contract_id === contract));
  await as(admin);
  const loose = await rows("storage_client_files", [A, null, 50]);
  assert.deepEqual(
    loose.map((f) => f.name),
    ["manual-da-agencia.pdf"],
  );
  await as(member);
  await assert.rejects(
    rows("storage_client_files", [A, client, 50]),
    /Sem permissão/,
  );
  await as(member);
  await assert.rejects(rows("storage_usage_by_client", [A]), /Sem permissão/);
});

await check("lista do cliente traz o registro de origem", async () => {
  await as(admin);
  const files = await rows("storage_client_files", [A, client, 50]);
  const [drive] = await sql(
    "select id from drive_files where name='video.mp4'",
  );
  assert.equal(files.find((f) => f.name === "video.mp4").source_id, drive.id);
});

await check(
  "anexo: só gestor ou quem enviou exclui, e fica no histórico",
  async () => {
    const [a] = await sql(
      "select id,path from attachments where name='contrato.pdf'",
    );
    await as(outsider);
    await assert.rejects(rpc("delete_attachment", [a.id]), /Sem permissão/);
    // Another collaborator of the same company, without being the uploader.
    await sql("insert into auth.users(id) values($1)", [uid(14)]);
    await sql(
      `insert into memberships(company_id,user_id,name,role) values($1,$2,'Outro Membro','member')`,
      [A, uid(14)],
    );
    await as(uid(14));
    await assert.rejects(rpc("delete_attachment", [a.id]), /Sem permissão/);
    await as(manager);
    assert.equal(await rpc("delete_attachment", [a.id]), a.path);
    assert.equal(
      (await sql("select 1 from attachments where id=$1", [a.id])).length,
      0,
    );
    const [event] = await sql(
      "select actor_id,detail from task_events where action='attachment_deleted'",
    );
    assert.equal(event.actor_id, manager);
    assert.equal(event.detail.name, "contrato.pdf");
    const [row] = await sql(
      "select deleted_at from storage_uploads where source_id=$1",
      [a.id],
    );
    assert.ok(row.deleted_at, "deixa de contar no armazenamento");
  },
);

await check(
  "gestor torna público e exclui arquivo de outra pessoa",
  async () => {
    const [f] = await sql("select id from drive_files where name='video.mp4'");
    await as(manager);
    await rpc("set_drive_file_visibility", [f.id, "public"]);
    const [after] = await sql(
      "select visibility from drive_files where id=$1",
      [f.id],
    );
    assert.equal(after.visibility, "public");
    await as(manager);
    await rpc("delete_drive_file", [f.id]);
    const [row] = await sql(
      "select deleted_at from storage_uploads where source_id=$1",
      [f.id],
    );
    assert.ok(row.deleted_at);
  },
);

await check(
  "logo da empresa: só administradores, na pasta da empresa, registrado",
  async () => {
    const url = (company, id) =>
      `https://storage.googleapis.com/b/company-logos/${company}/${id}.webp`;
    await as(manager);
    await assert.rejects(
      rpc("company_logo_upload_path", [A, "webp"]),
      /Sem permissão/,
    );
    await as(admin);
    const path = await rpc("company_logo_upload_path", [A, "webp"]);
    assert.match(path, new RegExp(`^company-logos/${A}/[0-9a-f-]{36}\\.webp$`));
    await as(admin);
    await assert.rejects(
      rpc("set_company_logo", [A, url(B, uid(950)), 1000]),
      /Imagem inválida/,
    );
    await as(outsider);
    await assert.rejects(
      rpc("set_company_logo", [A, url(A, uid(950)), 1000]),
      /Sem permissão/,
    );
    await as(admin);
    await rpc("set_company_logo", [A, url(A, uid(950)), 40000]);
    await as(admin);
    await rpc("set_company_logo", [A, url(A, uid(951)), 30000]);
    const [company] = await sql("select logo_url from companies where id=$1", [
      A,
    ]);
    assert.equal(company.logo_url, url(A, uid(951)));
    const logos = await ledger("logo");
    assert.equal(logos.length, 2);
    assert.ok(logos[0].deleted_at, "o logo anterior deixa de contar");
    assert.equal(Number(logos[1].size_bytes), 30000);
    await as(admin);
    await rpc("set_company_logo", [A, null, null]);
    assert.ok((await ledger("logo")).every((l) => l.deleted_at));
    // Members read the logo with the company.
    await as(member);
    assert.equal(
      (await db.query("select logo_url from companies where id=$1", [A]))
        .rows[0].logo_url,
      null,
    );
  },
);

console.log(
  `\n${passed} verificações de armazenamento e arquivamento passaram.`,
);

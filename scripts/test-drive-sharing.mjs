// Drive folder sharing (migration 20260929120000_drive_folder_sharing):
// people, public link, who may share, and what stays out of reach.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, teamMember, outsider, inactive] = [1, 10, 11, 12, 13].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, teamMember, outsider, inactive],
]);
await db.query(`insert into companies(id,name) values($1,'Empresa A')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Bruno Equipe','member',true),
   ($1,$4,'Carla Fora','member',true),($1,$5,'Davi Inativo','member',false)`,
  [A, admin, teamMember, outsider, inactive],
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

await as(admin);
const team = await rpc("create_team", [A, "Equipe A", [teamMember]]);
const client = await rpc("create_client", [A, "Cliente A", "", [team]]);
const product = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [
  A,
  client,
  product,
  "Contrato A",
  team,
]);
const folder = (name, parent = null, where = { contract }) =>
  rpc("create_drive_folder", [
    A,
    name,
    where.client ?? null,
    where.contract ?? null,
    parent,
  ]);
await as(admin);
const deliveries = await folder("Entregas");
await as(admin);
const photos = await folder("Fotos", deliveries);
await as(admin);
const sibling = await folder("Contratos");
await as(admin);
const clientLevel = await folder("Geral do cliente", null, { client });
const file = async (name, folderId, visibility = "private") =>
  (
    await sql(
      `insert into drive_files(company_id,name,content_type,size_bytes,path,visibility,status,uploaded_by,client_id,contract_id,folder_id)
     values($1,$2,'image/jpeg',100,'drive/'||gen_random_uuid(),$3,'ready',$4,$5,$6,$7) returning id`,
      [A, name, visibility, admin, client, contract, folderId],
    )
  )[0].id;
const deliveryFile = await file("briefing.pdf", deliveries);
const photoFile = await file("foto.jpg", photos, "private");
const siblingFile = await file("contrato.pdf", sibling);

const sees = async (user, table, id) => {
  await as(user);
  return (await db.query(`select 1 from ${table} where id=$1`, [id])).rows
    .length;
};

await check("a equipe do cliente continua vendo tudo como antes", async () => {
  for (const id of [deliveries, photos, sibling, clientLevel])
    assert.equal(await sees(teamMember, "drive_folders", id), 1);
  for (const id of [deliveryFile, photoFile, siblingFile])
    assert.equal(await sees(teamMember, "drive_files", id), 1);
});

await check("quem é de fora da equipe não vê a pasta", async () => {
  assert.equal(await sees(outsider, "drive_folders", deliveries), 0);
  assert.equal(await sees(outsider, "drive_files", deliveryFile), 0);
});

await check("só quem criou a pasta ou um gestor compartilha", async () => {
  await as(teamMember);
  await assert.rejects(
    () => rpc("set_drive_folder_sharing", [deliveries, false, [outsider]]),
    /Sem permissão/,
  );
});

await check("pasta fora de um produto não pode ser compartilhada", async () => {
  await as(admin);
  await assert.rejects(
    () => rpc("set_drive_folder_sharing", [clientLevel, true, []]),
    /dentro de um produto/,
  );
});

await check("pessoa inativa não recebe compartilhamento", async () => {
  await as(admin);
  await assert.rejects(
    () => rpc("set_drive_folder_sharing", [deliveries, false, [inactive]]),
    /ativas/,
  );
});

await as(admin);
await rpc("set_drive_folder_sharing", [deliveries, false, [outsider]]);

await check(
  "compartilhada, a pessoa vê a pasta, subpastas e arquivos",
  async () => {
    assert.equal(await sees(outsider, "drive_folders", deliveries), 1);
    assert.equal(await sees(outsider, "drive_folders", photos), 1);
    assert.equal(await sees(outsider, "drive_files", deliveryFile), 1);
    assert.equal(await sees(outsider, "drive_files", photoFile), 1);
  },
);

await check("…mas não o resto do produto", async () => {
  assert.equal(await sees(outsider, "drive_folders", sibling), 0);
  assert.equal(await sees(outsider, "drive_files", siblingFile), 0);
});

await check("a pessoa baixa arquivos da pasta compartilhada", async () => {
  await as(outsider);
  assert.equal((await rows("drive_download_target", [photoFile])).length, 1);
  await as(outsider);
  assert.equal((await rows("drive_download_target", [siblingFile])).length, 0);
});

await check("compartilhar não dá permissão de enviar ou criar", async () => {
  await as(outsider);
  await assert.rejects(() => folder("Invasão", deliveries));
});

await check("aparece em Compartilhadas comigo", async () => {
  await as(outsider);
  const mine = await rows("my_shared_drive_folders", [A]);
  assert.deepEqual(
    mine.map((f) => f.id),
    [deliveries],
  );
});

await check("remover a pessoa tira o acesso", async () => {
  await as(admin);
  await rpc("set_drive_folder_sharing", [deliveries, false, []]);
  assert.equal(await sees(outsider, "drive_folders", deliveries), 0);
});

await as(admin);
const shared = await rpc("set_drive_folder_sharing", [deliveries, true, []]);
const token = shared.share_token;

await check("link público abre a pasta para quem não entrou", async () => {
  await as(null);
  const root = await rpc("drive_public_folder", [token, null]);
  assert.equal(root.root.name, "Entregas");
  assert.deepEqual(
    root.folders.map((f) => f.name),
    ["Fotos"],
  );
  assert.deepEqual(
    root.files.map((f) => f.name),
    ["briefing.pdf"],
  );
  assert.equal(root.files[0].path, undefined, "sem caminho do arquivo");
});

await check("link público navega pelas subpastas com caminho", async () => {
  await as(null);
  const sub = await rpc("drive_public_folder", [token, photos]);
  assert.deepEqual(
    sub.path.map((p) => p.name),
    ["Entregas", "Fotos"],
  );
  assert.deepEqual(
    sub.files.map((f) => f.name),
    ["foto.jpg"],
    "inclui arquivos marcados como privados",
  );
});

await check("link público não alcança pastas fora dele", async () => {
  await as(null);
  assert.equal(await rpc("drive_public_folder", [token, sibling]), null);
  await as(null);
  assert.equal(
    (await rows("drive_public_folder_file", [token, siblingFile, false, "{}"]))
      .length,
    0,
  );
});

await check(
  "arquivo de subpasta baixa pelo link e fica registrado",
  async () => {
    await as(null);
    const [f] = await rows("drive_public_folder_file", [
      token,
      photoFile,
      false,
      "{}",
    ]);
    assert.equal(f.name, "foto.jpg");
    const logged = await sql(
      "select actor_id from drive_audit where action='public_downloaded' and file_id=$1",
      [photoFile],
    );
    assert.equal(logged.length, 1);
    assert.equal(logged[0].actor_id, null, "acesso anônimo");
  },
);

await check("desativar o link o invalida para sempre", async () => {
  await as(admin);
  const off = await rpc("set_drive_folder_sharing", [deliveries, false, []]);
  assert.notEqual(off.share_token, token);
  await as(null);
  assert.equal(await rpc("drive_public_folder", [token, null]), null);
  await as(admin);
  const again = await rpc("set_drive_folder_sharing", [deliveries, true, []]);
  assert.notEqual(again.share_token, token);
});

await check("cada mudança fica no histórico do Drive", async () => {
  const log = await sql(
    "select details from drive_audit where action='folder_shared' and folder_id=$1 order by id",
    [deliveries],
  );
  assert.ok(log.length >= 4);
  assert.deepEqual(log[0].details.added, [outsider]);
});

await db.close();
console.log(
  `\n${passed} verificações de compartilhamento de pastas aprovadas.`,
);

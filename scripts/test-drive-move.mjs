// Mover arquivos e pastas no Drive (migração 20270217090000_drive_move):
// quem move, para onde, o que vai junto, a MAVI, os links e o histórico.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, memberA, memberB, outsider] = [1, 10, 11, 12, 13].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, memberA, memberB, outsider],
]);
await db.query(`insert into companies(id,name) values($1,'Empresa A')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Bruno A','member',true),
   ($1,$4,'Carla B','member',true),($1,$5,'Davi Fora','member',true)`,
  [A, admin, memberA, memberB, outsider],
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
/** move(quem, {files, folders}, {client, contract, folder}) */
const move = async (user, items, to, preview = false) => {
  await as(user);
  return rpc(preview ? "drive_move_preview" : "move_drive_items", [
    A,
    items.files ?? [],
    items.folders ?? [],
    to.client ?? null,
    to.contract ?? null,
    to.folder ?? null,
  ]);
};

await as(admin);
const teamA = await rpc("create_team", [A, "Equipe A", [memberA]]);
const teamB = await rpc("create_team", [A, "Equipe B", [memberB]]);
const clientA = await rpc("create_client", [A, "Cliente A", "", [teamA]]);
const clientB = await rpc("create_client", [A, "Cliente B", "", [teamB]]);
const product = await rpc("create_product", [A, "Make Ads"]);
const contractA = await rpc("create_contract", [A, clientA, product, "A", teamA]);
const contractB = await rpc("create_contract", [A, clientB, product, "B", teamB]);
const folder = async (name, parent, contract) => {
  await as(admin);
  return rpc("create_drive_folder", [A, name, null, contract, parent]);
};
const deliveries = await folder("Entregas", null, contractA);
const photos = await folder("Fotos", deliveries, contractA);
const other = await folder("Outra", null, contractA);
const inB = await folder("Recebidos", null, contractB);
const file = async (name, folderId, contract, client) =>
  (
    await sql(
      `insert into drive_files(company_id,name,content_type,size_bytes,path,status,uploaded_by,client_id,contract_id,folder_id)
       values($1,$2,'application/pdf',100,'drive/'||gen_random_uuid(),'ready',$3,$4,$5,$6) returning id`,
      [A, name, admin, client, contract, folderId],
    )
  )[0].id;
const photo = await file("foto.pdf", photos, contractA, clientA);
const loose = await file("solto.pdf", null, contractA, clientA);
// O que a MAVI já tinha lido da foto.
const doc = (
  await sql(
    `insert into ai_documents(company_id,source_type,source_id,access,client_id,contract_id,title,content_hash)
     values($1,'drive_file',$2,'client',$3,$4,'foto.pdf','x') returning id`,
    [A, photo, clientA, contractA],
  )
)[0].id;
await sql(
  `insert into ai_chunks(company_id,document_id,ord,content,source_type,access,client_id,contract_id)
   values($1,$2,0,'texto','drive_file','client',$3,$4)`,
  [A, doc, clientA, contractA],
);
const sees = async (user, table, id) => {
  await as(user);
  return (await db.query(`select 1 from ${table} where id=$1`, [id])).rows
    .length;
};

await check("quem edita o produto move dentro dele, com histórico", async () => {
  const r = await move(memberA, { files: [loose] }, { folder: other });
  assert.equal(r.files, 1);
  const [f] = await sql(`select folder_id from drive_files where id=$1`, [loose]);
  assert.equal(f.folder_id, other);
  const [log] = await sql(
    `select * from drive_audit where action='file_moved' and file_id=$1`,
    [loose],
  );
  assert.equal(log.actor_id, memberA);
  assert.equal(log.details.from.label, "Drive › Cliente A › Make Ads");
  assert.equal(log.details.to.label, "Drive › Cliente A › Make Ads › Outra");
  assert.equal(log.details.to.folder_id, other);
});

await check("colaborador não leva para um cliente que não atende", async () => {
  await assert.rejects(
    () => move(memberA, { files: [loose] }, { contract: contractB }),
    /não pode colocar itens/,
  );
});

await check("colaborador não leva para fora das pastas de produto", async () => {
  await assert.rejects(
    () => move(memberA, { files: [loose] }, { client: clientA }),
    /não pode colocar itens/,
  );
});

await check("quem não edita na origem não move", async () => {
  await assert.rejects(
    () => move(memberB, { files: [loose] }, { folder: inB }),
    /Sem permissão para mover/,
  );
  await assert.rejects(
    () => move(outsider, { folders: [deliveries] }, { contract: contractA }),
    /não pode colocar itens/,
  );
});

await check("pasta não vai para dentro dela mesma", async () => {
  await assert.rejects(
    () => move(admin, { folders: [deliveries] }, { folder: photos }),
    /para dentro dela mesma/,
  );
  await assert.rejects(
    () => move(admin, { folders: [deliveries] }, { folder: deliveries }),
    /para dentro dela mesma/,
  );
});

await check("mover para onde já está avisa", async () => {
  await assert.rejects(
    () => move(admin, { files: [loose] }, { folder: other }),
    /Já está neste lugar/,
  );
});

await check("a prévia avisa a troca de cliente e não muda nada", async () => {
  const p = await move(admin, { folders: [deliveries] }, { folder: inB }, true);
  assert.deepEqual(p.from_clients, [clientA]);
  assert.equal(p.to.client_id, clientB);
  assert.equal(p.inner_folders, 1);
  assert.equal(p.inner_files, 1);
  const [f] = await sql(`select client_id from drive_files where id=$1`, [photo]);
  assert.equal(f.client_id, clientA);
});

await check("pasta vai para outro cliente com tudo dentro, e a MAVI troca de cliente", async () => {
  await sql(`delete from mavi_private.ai_queue`);
  const r = await move(admin, { folders: [deliveries] }, { folder: inB });
  assert.equal(r.folders, 1);
  const folders = await sql(
    `select id, parent_id, client_id, contract_id from drive_folders where id = any($1)`,
    [[deliveries, photos]],
  );
  for (const f of folders) {
    assert.equal(f.client_id, clientB);
    assert.equal(f.contract_id, contractB);
  }
  assert.equal(folders.find((f) => f.id === deliveries).parent_id, inB);
  assert.equal(folders.find((f) => f.id === photos).parent_id, deliveries);
  const [f] = await sql(
    `select client_id, contract_id, folder_id from drive_files where id=$1`,
    [photo],
  );
  assert.deepEqual(f, { client_id: clientB, contract_id: contractB, folder_id: photos });
  const [d] = await sql(`select client_id, contract_id from ai_documents where id=$1`, [doc]);
  assert.deepEqual(d, { client_id: clientB, contract_id: contractB });
  const [c] = await sql(`select client_id from ai_chunks where document_id=$1`, [doc]);
  assert.equal(c.client_id, clientB);
  const queued = await sql(
    `select source_id from mavi_private.ai_queue where source_type='drive_file'`,
  );
  assert.ok(queued.some((q) => q.source_id === photo));
  const [log] = await sql(
    `select * from drive_audit where action='folder_moved' and folder_id=$1`,
    [deliveries],
  );
  assert.equal(log.client_id, clientB);
  assert.equal(log.details.from.client_id, clientA);
  assert.equal(log.details.files, 1);
  assert.equal(log.details.folders, 1);
});

await check("quem atendia o cliente antigo deixa de ver; o novo passa a ver", async () => {
  assert.equal(await sees(memberA, "drive_files", photo), 0);
  assert.equal(await sees(memberA, "drive_folders", photos), 0);
  assert.equal(await sees(memberB, "drive_files", photo), 1);
});

await check("a prévia avisa a entrada e a saída de um link público", async () => {
  await as(admin);
  await rpc("set_drive_folder_sharing", [inB, true, [outsider]]);
  const p = await move(admin, { files: [loose] }, { folder: inB }, true);
  assert.deepEqual(p.enter_public, ["Recebidos"]);
  assert.deepEqual(p.enter_people, ["Recebidos"]);
  const out = await move(admin, { files: [photo] }, { folder: other }, true);
  assert.deepEqual(out.leave_public, ["Recebidos"]);
  assert.deepEqual(out.enter_public, []);
});

await check("pasta compartilhada fora de um produto perde o compartilhamento", async () => {
  const [before] = await sql(`select share_token from drive_folders where id=$1`, [inB]);
  const p = await move(admin, { folders: [inB] }, { client: clientB }, true);
  assert.deepEqual(p.unshare, ["Recebidos"]);
  await move(admin, { folders: [inB] }, { client: clientB });
  const [after] = await sql(
    `select visibility, public_upload, share_token, contract_id from drive_folders where id=$1`,
    [inB],
  );
  assert.equal(after.visibility, "private");
  assert.equal(after.public_upload, false);
  assert.equal(after.contract_id, null);
  assert.notEqual(after.share_token, before.share_token);
  assert.equal(
    (await sql(`select 1 from drive_folder_members where folder_id=$1`, [inB])).length,
    0,
  );
  const [log] = await sql(
    `select details from drive_audit where action='folder_shared' and folder_id=$1 order by id desc limit 1`,
    [inB],
  );
  assert.equal(log.details.via, "move");
  assert.deepEqual(log.details.removed, [outsider]);
  // Tudo dentro dela também fica sem produto.
  const [f] = await sql(`select contract_id, client_id from drive_files where id=$1`, [photo]);
  assert.deepEqual(f, { contract_id: null, client_id: clientB });
});

await check("a pasta da marca não sai do lugar nem recebe itens", async () => {
  const [{ brand }] = await sql(
    `select mavi_private.brand_folder($1,$2) as brand`,
    [A, clientA],
  );
  await assert.rejects(
    () => move(admin, { files: [loose] }, { folder: brand }),
    /pela tela Drive › cliente › Marca/,
  );
  await assert.rejects(
    () => move(admin, { folders: [brand] }, { contract: contractA }),
    /sistema/,
  );
  const logo = await file("logo.pdf", brand, null, clientA);
  await assert.rejects(
    () => move(admin, { files: [logo] }, { folder: other }),
    /arquivos da marca/,
  );
});

await check("a prova social do Social Leads fica no produto", async () => {
  const proof = await folder("Prova social", null, contractA);
  await sql(
    `insert into social_leads_briefings(company_id, contract_id, proof_folder, created_by) values($1,$2,$3,$4)`,
    [A, contractA, proof, admin],
  );
  await assert.rejects(
    () => move(admin, { folders: [proof] }, { contract: contractB }),
    /prova social/,
  );
  // Dentro do mesmo produto, pode.
  await move(admin, { folders: [proof] }, { folder: other });
});

await check("o histórico do item mostra por onde passou, sem IP", async () => {
  await as(memberA);
  const h = await rows("drive_item_history", [A, loose, null]);
  const moved = h.find((e) => e.action === "file_moved");
  assert.ok(moved);
  assert.equal(moved.details.origin, undefined);
  assert.equal(moved.via_folder, false);
  // A foto foi junto com a pasta Entregas.
  await as(memberB);
  const p = await rows("drive_item_history", [A, photo, null]);
  const via = p.filter((e) => e.action === "folder_moved" && e.via_folder);
  assert.deepEqual(via.map((e) => e.item_name).sort(), ["Entregas", "Recebidos"]);
  await as(outsider);
  await assert.rejects(
    () => rows("drive_item_history", [A, loose, null]),
    /sem acesso/,
  );
});

await check("o histórico de pasta é só da pasta", async () => {
  await as(admin);
  const h = await rows("drive_item_history", [A, null, deliveries]);
  assert.ok(h.some((e) => e.action === "folder_created"));
  assert.ok(h.some((e) => e.action === "folder_moved" && !e.via_folder));
});

console.log(`${passed} checks passed`);

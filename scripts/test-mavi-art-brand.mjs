// MAVI · arte por código (migration 20261223090000_mavi_art_brand): a marca
// do cliente no Drive (quem atende edita; a pasta é do sistema), o que a
// MAVI lê e o esforço escolhido por administradores e gestores.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, ana, bia] = [1, 10, 12, 13].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, ana, bia]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values ($1,$2,'Ana Admin','admin',true),($1,$3,'Ana Souza','member',true),($1,$4,'Bia Lima','member',true)`,
  [A, admin, ana, bia],
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

const team = await one(admin, "select public.create_team($1,'Criação',$2)", [A, [ana]]);
const client = await one(admin, "select public.create_client($1,'MakeCRM','',$2)", [A, [team]]);

let logo, font;
await check("quem atende o cliente sobe arquivos na marca; quem não atende, não", async () => {
  logo = await one(ana, "select public.prepare_brand_file($1,$2,'logo.svg',2048,'image/svg+xml')", [A, client]);
  font = await one(ana, "select public.prepare_brand_file($1,$2,'TomatoGrotesk-Bold.otf',90000,'font/otf')", [A, client]);
  await q(ana, "select public.confirm_drive_file($1)", [logo]);
  await q(ana, "select public.confirm_drive_file($1)", [font]);
  await assert.rejects(
    () => q(bia, "select public.prepare_brand_file($1,$2,'x.png',10,'image/png')", [A, client]),
    /Só quem atende/,
  );
  await assert.rejects(
    () => q(ana, "select public.prepare_brand_file($1,$2,'script.exe',10,'application/x-msdownload')", [A, client]),
    /imagens .* fontes/,
  );
  // Uma pasta só, do sistema, com os dois arquivos.
  const folders = await q(ana, "select id, system, name from drive_folders where client_id = $1", [client]);
  assert.equal(folders.length, 1);
  assert.equal(folders[0].system, "brand");
  const files = await q(ana, "select name from drive_files where folder_id = $1 order by name", [folders[0].id]);
  assert.deepEqual(files.map((f) => f.name), ["TomatoGrotesk-Bold.otf", "logo.svg"]);
});

await check("cores, fontes e regras: salvas conferidas", async () => {
  await q(ana, "select public.save_client_brand($1,$2,$3::jsonb,$4::jsonb,$5)", [
    A,
    client,
    JSON.stringify([{ name: "Navy", hex: "#001119" }, { name: "Laranja", hex: "#ff8900" }]),
    JSON.stringify([{ file: font, family: "Tomato Grotesk", weight: "700", style: "normal", role: "Títulos" }]),
    "Laranja só em destaques. Nunca degradê no título.",
  ]);
  await assert.rejects(
    () => q(ana, "select public.save_client_brand($1,$2,$3::jsonb,'[]'::jsonb,'')", [A, client, JSON.stringify([{ hex: "laranja" }])]),
    /#RRGGBB/,
  );
  await assert.rejects(
    () => q(ana, "select public.save_client_brand($1,$2,'[]'::jsonb,$3::jsonb,'')", [A, client, JSON.stringify([{ file: uid(99), family: "X" }])]),
    /Confira as fontes/,
  );
  const kit = await one(ana, "select public.ai_brand_kit($1,$2)", [A, client]);
  assert.equal(kit.client_name, "MakeCRM");
  assert.deepEqual(kit.colors[1], { name: "Laranja", hex: "#FF8900" });
  assert.equal(kit.fonts[0].weight, 700);
  assert.equal(kit.files.length, 2);
  assert.equal(await one(bia, "select public.ai_brand_kit($1,$2)", [A, client]), null);
  // O servidor assina os links pelos caminhos.
  const targets = await q(ana, "select * from public.brand_asset_targets($1,$2)", [A, client]);
  assert.equal(targets.length, 2);
  assert.match(targets[0].path, /^drive\//);
  assert.equal((await q(bia, "select * from public.brand_asset_targets($1,$2)", [A, client])).length, 0);
});

await check("tirar a fonte tira o papel dela; a pasta da marca não se apaga", async () => {
  const path = await one(ana, "select public.delete_brand_file($1)", [font]);
  assert.match(path, /^drive\//);
  const kit = await one(ana, "select public.ai_brand_kit($1,$2)", [A, client]);
  assert.equal(kit.fonts.length, 0);
  assert.equal(kit.files.length, 1);
  await assert.rejects(() => q(admin, "select public.delete_drive_folder($1)", [kit.folder]), /./);
  await assert.rejects(() => q(admin, "select public.rename_drive_folder($1,'Outra')", [kit.folder]), /pasta da marca/);
});

await check("esforço: só gestores escolhem; a MAVI lê; skill apagada leva o dela", async () => {
  await q(admin, "select public.ai_set_effort($1,'mavi_page','xhigh')", [A]);
  await assert.rejects(() => q(ana, "select public.ai_set_effort($1,'mavi_page','low')", [A]), /administradores e gestores/);
  await assert.rejects(() => q(admin, "select public.ai_set_effort($1,'task_copilot','high')", [A]), /não tem esforço/);
  await assert.rejects(() => q(admin, "select public.ai_set_effort($1,'assistant','turbo')", [A]), /inválido/);
  assert.deepEqual(await one(ana, "select public.ai_efforts($1)", [A]), { mavi_page: "xhigh" });
  const list = await one(admin, "select public.ai_provider_list($1)", [A]);
  assert.deepEqual(list.efforts, { mavi_page: "xhigh" });
  await q(admin, "select public.ai_set_effort($1,'mavi_page',null)", [A]);
  assert.deepEqual(await one(ana, "select public.ai_efforts($1)", [A]), {});
  await assert.rejects(() => q(admin, "select public.ai_set_effort($1,$2,'high')", [A, `skill:${uid(77)}`]), /Skill não encontrada/);
});

console.log(`\n${passed} verificações passaram.`);

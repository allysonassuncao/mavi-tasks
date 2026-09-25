// Campanhas: import of the MASO's Facebook lead forms (scripts/import-maso-lead-forms.mjs),
// run for real against the migrations, with made-up tokens.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createTestDatabase } from "./database-fixture.mjs";
import { parseSqlDump } from "./import-maso-campaigns.mjs";
import { buildLinks, renderSql } from "./import-maso-lead-forms.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin] = [1, 10].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values ($1,$2,'Ana Admin','admin')`,
  [A, admin],
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

// "Vittalium" runs a Meta campaign whose cycle sends to capture page 12345;
// client "2600" was created by the MASO import (named with its MASO id).
await as(admin);
const vittalium = await rpc("create_client", [A, "Vittalium", ""]);
const c2600 = await rpc("create_client", [A, "2600", ""]);
const makeAds = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [
  A,
  vittalium,
  makeAds,
  "Make Ads",
  null,
]);
const campaign = await rpc("create_ad_campaign", [
  A,
  contract,
  "Vittalium - Lead",
  "meta",
  "",
  "",
  "",
]);
await rpc("create_ad_cycle", [
  campaign,
  "2026-09-01",
  "2026-09-01",
  "2026-09-30",
  "lead",
  100,
  3000,
  2,
  "make_landing_page",
  ["12345"],
  "",
  "[]",
  true,
]);
// A form linked in MAVI already: the import leaves it be.
await as(admin);
await rpc("ad_save_lead_form", [
  A,
  vittalium,
  "9003",
  "Página",
  "v1:mavi",
  "5003",
  "Form MAVI",
  "999",
  "2477",
]);

const tok = (n) => `EAA${String(n).repeat(30)}`;
const tables = parseSqlDump(`
INSERT INTO \`produto_capture_formulario_facebook\` (\`id\`, \`id_usuario\`, \`id_capture\`, \`id_page_facebook\`, \`id_form_facebook\`) VALUES
(1, 2477, '12345', '9001', '5001'),
(2, 2600, '555', '9002', '5002'),
(3, 2477, '999', '9003', '5003'),
(4, 2477, '0', '9001', '5004'),
(5, 2477, '12346', '9009', '5005'),
(6, 2477, '77', '9001', '5001');
INSERT INTO \`usuarios_make_facebook_page\` (\`id\`, \`id_usuario\`, \`id_page\`, \`access_token_page_facebook\`) VALUES
(1, 2477, '9001', '${tok(1)}'),
(2, 2477, '9001', '${tok(2)}'),
(3, 2600, '9002', '${tok(3)}'),
(4, 2477, '9003', '${tok(4)}');
`);
const key = crypto.randomBytes(32);
const unseal = (sealed) => {
  const raw = Buffer.from(sealed.slice(3), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString();
};

await check(
  "lê os vínculos: um por formulário, o mais recente, com página e token",
  async () => {
    const built = buildLinks(tables);
    assert.deepEqual(built.links.map((l) => [l.form, l.capture]).sort(), [
      ["5001", "77"],
      ["5002", "555"],
      ["5003", "999"],
    ]);
    assert.deepEqual(built.report.skipped, {
      "sem página de captura": 1,
      "página do Facebook sem token no MASO (integre de novo no MAVI)": 1,
      "formulário repetido (vale o vínculo mais recente)": 1,
    });
    assert.equal(built.pages.find((p) => p.page === "9001").token, tok(2));
  },
);

await check(
  "importa: cliente pelo ciclo ou pelo id do MASO; o do MAVI fica",
  async () => {
    const built = buildLinks(tables);
    // The capture page of 5001 is 77 (the newest link): make it the cycle's.
    await sql(
      "update ad_cycles set landing_pages = '{77}' where campaign_id = $1",
      [campaign],
    );
    const text = renderSql(built, { company: A, author: admin, key });
    for (const n of [1, 2, 3, 4]) assert.ok(!text.includes(tok(n)));
    await db.exec("reset role");
    const results = await db.exec(text);
    const summary = results.at(-2).rows[0];
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(summary).map(([k, v]) => [k, Number(v)]),
      ),
      {
        formularios_no_arquivo: 3,
        importados_com_cliente: 2,
        importados_sem_cliente: 0,
        ja_integrados_no_mavi_mantidos: 1,
      },
    );
    const forms = await sql(
      `select form_id, landing_page_id, make_user_id, source, (select name from clients where id = f.client_id) as client
     from ad_lead_forms f where company_id = $1 order by form_id`,
      [A],
    );
    assert.deepEqual(forms, [
      {
        form_id: "5001",
        landing_page_id: "77",
        make_user_id: "2477",
        source: "maso",
        client: "Vittalium",
      },
      {
        form_id: "5002",
        landing_page_id: "555",
        make_user_id: "2600",
        source: "maso",
        client: "2600",
      },
      {
        form_id: "5003",
        landing_page_id: "999",
        make_user_id: "2477",
        source: "mavi",
        client: "Vittalium",
      },
    ]);
    const pages = await sql(
      "select page_id, token_cipher from mavi_private.ad_meta_pages where company_id = $1 order by page_id",
      [A],
    );
    assert.equal(
      unseal(pages.find((p) => p.page_id === "9001").token_cipher),
      tok(2),
    );
    assert.equal(
      pages.find((p) => p.page_id === "9003").token_cipher,
      "v1:mavi",
    );
    void c2600;
  },
);

await check("rodar de novo não duplica nada", async () => {
  await db.exec("reset role");
  await db.exec(
    renderSql(buildLinks(tables), { company: A, author: admin, key }),
  );
  assert.equal(
    (await sql("select count(*)::int as n from ad_lead_forms"))[0].n,
    3,
  );
  assert.equal(
    (await sql("select count(*)::int as n from mavi_private.ad_meta_pages"))[0]
      .n,
    3,
  );
});

await check(
  "o webhook entrega os cadastros dos formulários importados",
  async () => {
    const secret = "s".repeat(40);
    await sql(
      "insert into mavi_private.ad_sync_config(url, secret) values ('https://app.example/api/ads-sync', $1)",
      [secret],
    );
    await as(null);
    const t = await rpc("ad_leadgen_claim", [secret, "8001", "9001", "5001"]);
    assert.equal(t.skip, false);
    assert.equal(t.landing_page_id, "77");
    assert.equal(t.make_user_id, "2477");
    assert.equal(unseal(t.page_token_cipher), tok(2));
  },
);

console.log(
  `\n${passed} verificações da importação dos formulários do MASO passaram.`,
);

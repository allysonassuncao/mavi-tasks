// Campanhas: Facebook lead forms linked to Make capture pages (migration
// 20261010090000_ad_lead_forms) — linking, who may, and the webhook's
// claim/finish (each lead once, retried only after an error).
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
  `insert into companies(id,name) values($1,'Make'),($2,'Outra')`,
  [A, B],
);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$3,'Ana Admin','admin'),($1,$4,'Gabi Gestora','manager'),
   ($1,$5,'Caio Colaborador','member'),($2,$6,'Fora','admin')`,
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
const client = await rpc("create_client", [A, "2477", ""]);
const secret = "s".repeat(40);
await sql(
  "insert into mavi_private.ad_sync_config(url, secret) values ('https://app.example/api/ads-sync', $1)",
  [secret],
);
// The client's ad account (its token helps to find the ad's names).
await sql(
  `insert into mavi_private.ad_meta_accounts(company_id, account_id, token_cipher, connected_by, client_id)
   values ($1, '111', 'v1:account', $2, $3)`,
  [A, admin, client],
);
const save = (who, over = {}) =>
  as(who).then(() =>
    rpc("ad_save_lead_form", [
      over.company ?? A,
      over.client === undefined ? client : over.client,
      over.page ?? "9001",
      "Página Vittalium",
      over.token ?? "v1:page",
      over.form ?? "5001",
      "Formulário Avaliação",
      over.lp ?? "12345",
      over.make ?? "2477",
    ]),
  );
const claim = (leadgen, form = "5001", page = "9001", s = secret) =>
  as(null).then(() => rpc("ad_leadgen_claim", [s, leadgen, page, form]));
const finish = (leadgen, status, message = "") =>
  as(null).then(() =>
    rpc("ad_leadgen_finish", [secret, leadgen, status, message]),
  );

await check(
  "administradores e gestores ligam formulários; colaborador não",
  async () => {
    const f = await save(admin);
    assert.equal(f.landing_page_id, "12345");
    assert.equal(f.make_user_id, "2477");
    assert.equal(f.source, "mavi");
    await save(manager, { form: "5002", lp: "12346" });
    for (const who of [member, outsider])
      await assert.rejects(save(who, { form: "5003" }), /Sem permissão/);
    const [page] = await sql(
      "select name, token_cipher from mavi_private.ad_meta_pages where company_id=$1 and page_id='9001'",
      [A],
    );
    assert.deepEqual(page, {
      name: "Página Vittalium",
      token_cipher: "v1:page",
    });
  },
);

await check("valida página de captura, cliente da Make e ids", async () => {
  await assert.rejects(save(admin, { lp: "" }), /página de captura/);
  await assert.rejects(save(admin, { make: "abc" }), /ID do cliente na Make/);
  await assert.rejects(
    save(admin, { form: "x1" }),
    /Formulário do Facebook inválido/,
  );
  await assert.rejects(save(admin, { token: "aberto" }), /Acesso à página/);
  await assert.rejects(save(admin, { client: uid(99) }), /Cliente inválido/);
});

await check(
  "ligar de novo move o formulário para outra página de captura",
  async () => {
    await save(admin, { lp: "777" });
    const rows = await sql(
      "select landing_page_id from ad_lead_forms where company_id=$1 and form_id='5001'",
      [A],
    );
    assert.deepEqual(rows, [{ landing_page_id: "777" }]);
    await save(admin, { lp: "12345" });
  },
);

await check(
  "só administradores e gestores leem; ninguém lê o token",
  async () => {
    for (const [who, n] of [
      [admin, 2],
      [manager, 2],
      [member, 0],
      [outsider, 0],
    ]) {
      await as(who);
      assert.equal(
        (await db.query("select * from ad_lead_forms")).rows.length,
        n,
        who,
      );
    }
    await as(admin);
    await assert.rejects(
      db.query("select * from mavi_private.ad_meta_pages"),
      /permission denied/,
    );
    await assert.rejects(
      db.query(
        "insert into ad_lead_forms(company_id, page_id, form_id, landing_page_id, make_user_id, created_by) values ($1,'1','2','3','4',$2)",
        [A, admin],
      ),
      /permission denied/,
    );
  },
);

await check(
  "webhook: cada cadastro uma vez, com o destino e os tokens",
  async () => {
    await assert.rejects(
      claim("7001", "5001", "9001", "errado".repeat(8)),
      /Sem permissão/,
    );
    const t = await claim("7001");
    assert.equal(t.skip, false);
    assert.equal(t.landing_page_id, "12345");
    assert.equal(t.make_user_id, "2477");
    assert.equal(t.page_token_cipher, "v1:page");
    assert.deepEqual(t.account_token_ciphers, ["v1:account"]);
    // Facebook sends it again while it is processing: skipped.
    assert.deepEqual(await claim("7001"), { skip: true, reason: "already" });
    await finish("7001", "sent");
    assert.deepEqual(await claim("7001"), { skip: true, reason: "already" });
  },
);

await check(
  "webhook: um erro deixa tentar de novo; formulário sem vínculo não sai",
  async () => {
    await claim("7002");
    await finish("7002", "error", "Make fora do ar");
    const again = await claim("7002");
    assert.equal(again.skip, false);
    const [row] = await sql(
      "select status, attempts from ad_lead_deliveries where leadgen_id='7002'",
    );
    assert.deepEqual(row, { status: "processing", attempts: 2 });
    await finish("7002", "sent");
    assert.deepEqual(await claim("7003", "5999"), {
      skip: true,
      reason: "no_link",
    });
    await assert.rejects(
      as(null).then(() =>
        rpc("ad_leadgen_finish", [secret, "7003", "processing", ""]),
      ),
      /Status inválido/,
    );
  },
);

await check(
  "visão geral: último cadastro, total em 30 dias e último erro",
  async () => {
    await claim("7004");
    await finish("7004", "error", "Campos obrigatórios faltando");
    await as(manager);
    const list = await rpc("ad_lead_forms_overview", [A, client]);
    const f = list.find((x) => x.form_id === "5001");
    assert.equal(f.client, "2477");
    assert.equal(f.sent_30d, 2);
    assert.ok(f.last_lead_at);
    assert.equal(f.last_error.message, "Campos obrigatórios faltando");
    await as(member);
    await assert.rejects(rpc("ad_lead_forms_overview", [A, null]), /exclusivo/);
  },
);

await check("remover o vínculo: só líderes; o histórico fica", async () => {
  const [{ id }] = await sql(
    "select id from ad_lead_forms where company_id=$1 and form_id='5002'",
    [A],
  );
  await as(member);
  await assert.rejects(rpc("ad_delete_lead_form", [id]), /exclusivo/);
  await as(admin);
  await rpc("ad_delete_lead_form", [id]);
  assert.equal(
    (
      await sql(
        "select count(*)::int as n from ad_lead_forms where form_id='5002'",
      )
    )[0].n,
    0,
  );
  assert.ok(
    (await sql("select count(*)::int as n from ad_lead_deliveries"))[0].n >= 3,
  );
});

console.log(`\n${passed} verificações dos formulários do Facebook passaram.`);

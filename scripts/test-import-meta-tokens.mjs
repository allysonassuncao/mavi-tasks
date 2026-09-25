// Campanhas: import of the MASO's Facebook access (scripts/import-maso-meta-tokens.mjs),
// run for real against the migrations, with made-up tokens.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createTestDatabase } from "./database-fixture.mjs";
import { parseSqlDump } from "./import-maso-campaigns.mjs";
import {
  IMPORTED_PROFILE,
  buildRows,
  readKey,
  renderSql,
} from "./import-maso-meta-tokens.mjs";

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

const today = (
  await sql("select mavi_private.company_today($1)::text as d", [A])
)[0].d;
const shift = (n) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
// Two clients: Vittalium with an active Meta campaign on account 111 (and an
// old inactive one of another client on the same account), and Nexo with an
// ended one on 444.
await as(admin);
const vittalium = await rpc("create_client", [A, "Vittalium", ""]);
const nexo = await rpc("create_client", [A, "Nexo", ""]);
const makeAds = await rpc("create_product", [A, "Make Ads"]);
const contract = async (client) =>
  rpc("create_contract", [A, client, makeAds, "Make Ads", null]);
const [kv, kn] = [await contract(vittalium), await contract(nexo)];
const campaign = async (k, name, account, start, end, active) => {
  await as(admin);
  const id = await rpc("create_ad_campaign", [A, k, name, "meta", "", "", ""]);
  const cycle = await rpc("create_ad_cycle", [
    id,
    start,
    start,
    end,
    "message",
    100,
    3000,
    2,
    "external_page",
    [],
    "",
    JSON.stringify([
      {
        account_id: account,
        campaign_id: `c-${name}`,
        account_name: `Conta ${name}`,
      },
    ]),
    true,
  ]);
  if (active)
    await rpc("set_ad_campaign_status", [id, "active", "Começou a rodar"]);
  return { id, cycle };
};
await campaign(kn, "Antiga da Nexo", "111", "2025-01-01", "2025-01-31", false);
await campaign(kv, "Vittalium", "111", shift(-10), shift(20), true);
await campaign(kn, "Nexo", "444", shift(-60), shift(-30), false);
// Account 222 was connected in MAVI by a person: the import leaves it be.
await sql(
  `insert into mavi_private.ad_meta_accounts(company_id, account_id, name, fb_user_id, fb_user_name, token_cipher,
   token_expires_at, connected_by, client_id) values ($1,'222','Conta MAVI','fb-9','Beto','v1:mavi','2026-11-01',$2,$3)`,
  [A, admin, nexo],
);

const tok = (n) => `EAA${String(n).repeat(30)}`;
const dump = (profiles, accounts) =>
  parseSqlDump(`
INSERT INTO \`usuarios_make_facebook\` (\`id\`, \`id_usuario\`, \`usuario\`, \`facebook_access_token\`, \`facebook_user_id\`, \`bornlogic_access_token\`, \`owner\`, \`gerado_em\`, \`valido_ate\`) VALUES
${profiles.map((p, i) => `(${i + 1}, 101, '', '${p.token}', '${p.fb}', '', 'INTERNO', '${p.day}', '0000-00-00')`).join(",\n")};
INSERT INTO \`usuarios_make_facebook_accounts_makeads\` (\`id\`, \`id_usuario\`, \`id_account\`, \`owner\`, \`access_token\`) VALUES
${accounts.map((a, i) => `(${i + 1}, '${a.fb}', '${a.account}', 'INTERNO', '${a.token}')`).join(",\n")};
`);
const key = crypto.randomBytes(32);
const run = async (tables) => {
  const { rows, report } = buildRows(tables);
  const text = renderSql(rows, { company: A, author: admin, key });
  await db.exec("reset role");
  const results = await db.exec(text);
  return { report, text, summary: results.at(-2)?.rows?.[0] };
};
const unseal = (sealed) => {
  const raw = Buffer.from(sealed.slice(3), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString();
};
const accounts = async () =>
  sql(
    `select account_id, name, fb_user_id, fb_user_name, token_cipher, token_expires_at::date::text as expires,
     (select name from clients where id = m.client_id) as client
     from mavi_private.ad_meta_accounts m where company_id = $1 order by account_id`,
    [A],
  );

await check("a chave precisa ter 32 bytes em base64", async () => {
  assert.throws(() => readKey(""), /Defina GOOGLE_TOKEN_KEY_ADS/);
  assert.throws(() => readKey("abc"), /32 bytes/);
  assert.equal(readKey(key.toString("base64")).length, 32);
});

await check(
  "importa cada conta com o token cifrado, o perfil e o cliente do MAVI",
  async () => {
    const { report, text, summary } = await run(
      dump(
        [
          { fb: "700", token: tok(1), day: shift(-5) },
          { fb: "800", token: tok(2), day: shift(-100) },
        ],
        [
          { fb: "700", account: "111", token: tok(1) },
          { fb: "700", account: "act_222", token: tok(1) },
          { fb: "800", account: "333", token: tok(2) },
          // A token of its own: expiry unknown.
          { fb: "800", account: "444", token: tok(3) },
          { fb: "800", account: "555", token: "" },
          { fb: "800", account: "abc", token: tok(4) },
        ],
      ),
    );
    assert.equal(report.rows, 4);
    assert.deepEqual(report.skipped, {
      "sem token do Facebook válido": 1,
      "conta de anúncio com ID inválido": 1,
    });
    // Never a token in the clear in the file.
    for (const n of [1, 2, 3]) assert.ok(!text.includes(tok(n)));
    assert.deepEqual(
      {
        ...summary,
        contas_no_arquivo: Number(summary.contas_no_arquivo),
        importadas_com_cliente: Number(summary.importadas_com_cliente),
        importadas_sem_cliente: Number(summary.importadas_sem_cliente),
        ja_conectadas_no_mavi_mantidas: Number(
          summary.ja_conectadas_no_mavi_mantidas,
        ),
        token_possivelmente_vencido: Number(
          summary.token_possivelmente_vencido,
        ),
      },
      {
        contas_no_arquivo: 4,
        importadas_com_cliente: 2,
        importadas_sem_cliente: 1,
        ja_conectadas_no_mavi_mantidas: 1,
        token_possivelmente_vencido: 1,
      },
    );
    const list = await accounts();
    const by = Object.fromEntries(list.map((a) => [a.account_id, a]));
    // 111: the active campaign's client wins over the old one's.
    assert.equal(by["111"].client, "Vittalium");
    assert.equal(by["111"].name, "Conta Vittalium");
    assert.equal(by["111"].fb_user_id, "700");
    assert.equal(by["111"].fb_user_name, IMPORTED_PROFILE);
    assert.equal(by["111"].expires, shift(55));
    assert.equal(unseal(by["111"].token_cipher), tok(1));
    // 222: connected in MAVI, untouched.
    assert.equal(by["222"].token_cipher, "v1:mavi");
    assert.equal(by["222"].fb_user_name, "Beto");
    // 333: no campaign uses it: kept without a client.
    assert.equal(by["333"].client, null);
    assert.equal(by["333"].expires, shift(-40));
    // 444: the ended campaign's client; its own token, expiry unknown.
    assert.equal(by["444"].client, "Nexo");
    assert.equal(by["444"].expires, null);
    assert.equal(unseal(by["444"].token_cipher), tok(3));
  },
);

await check(
  "rodar de novo: só um token mais novo substitui; o do MAVI fica",
  async () => {
    await run(
      dump(
        [
          { fb: "700", token: tok(5), day: shift(-1) },
          { fb: "800", token: tok(6), day: shift(-150) },
        ],
        [
          { fb: "700", account: "111", token: tok(5) },
          { fb: "700", account: "222", token: tok(5) },
          { fb: "800", account: "333", token: tok(6) },
        ],
      ),
    );
    const by = Object.fromEntries(
      (await accounts()).map((a) => [a.account_id, a]),
    );
    assert.equal(unseal(by["111"].token_cipher), tok(5));
    assert.equal(by["111"].expires, shift(59));
    assert.equal(by["111"].client, "Vittalium");
    // Older than what is there: kept.
    assert.equal(unseal(by["333"].token_cipher), tok(2));
    assert.equal(by["222"].token_cipher, "v1:mavi");
    assert.equal((await accounts()).length, 4);
  },
);

await check("a sincronização encontra o token importado", async () => {
  const secret = "s".repeat(40);
  await sql(
    "insert into mavi_private.ad_sync_config(url, secret) values ('https://app.example/api/ads-sync', $1)",
    [secret],
  );
  await as(null);
  const targets = await rpc("ad_sync_targets", [secret, null, 50]);
  const t = targets.find((x) => x.links?.some((l) => l.account_id === "111"));
  assert.ok(t, "the running Vittalium cycle is due");
  assert.equal(unseal(t.meta_tokens["111"].token_cipher), tok(5));
});

console.log(
  `\n${passed} verificações da importação dos acessos do Meta passaram.`,
);

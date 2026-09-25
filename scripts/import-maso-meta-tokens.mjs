// Campanhas: brings the MASO's Facebook (Meta Ads) access over to MAVI, so
// nobody has to connect client by client again. Reads two phpMyAdmin dumps
//   usuarios_make_facebook                   (a Facebook profile, its token
//                                             and when it was generated)
//   usuarios_make_facebook_accounts_makeads  (each ad account, the profile
//                                             that reaches it and the token)
// and writes one SQL file for pgAdmin / the SQL editor (runs as postgres).
//
//   GOOGLE_TOKEN_KEY_ADS=… node scripts/import-maso-meta-tokens.mjs \
//     --input usuarios_make_facebook.sql \
//     --input usuarios_make_facebook_accounts_makeads.sql \
//     --company <uuid> --author <uuid> --out meta-tokens.sql
//
// Tokens never appear in the file in the clear: each is sealed here with
// GOOGLE_TOKEN_KEY_ADS (AES-256-GCM, the format api/_google.ts reads), the
// same key the server uses. The client of each account comes from MAVI
// itself: the Meta campaigns whose cycles are linked to it (the MASO's
// history, imported by scripts/import-maso-campaigns.mjs) — the active
// campaign first, then the latest cycle. Accounts no campaign uses are
// kept without a client (the sync still finds them by account).
//
// Safe to run again: an account connected in MAVI (by a person, after the
// Facebook login) is never touched; one imported before only gets a newer
// token.
import crypto from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  UsageError,
  readExports,
  sqlString,
} from "./import-maso-campaigns.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The profile name of the imported rows (the MASO kept none). */
export const IMPORTED_PROFILE = "Perfil importado do MASO";
/** A long-lived Meta user token lasts about 60 days from when it's issued. */
const TOKEN_DAYS = 60;

const USAGE = `Uso:
  GOOGLE_TOKEN_KEY_ADS=… node scripts/import-maso-meta-tokens.mjs \\
    --input usuarios_make_facebook.sql \\
    --input usuarios_make_facebook_accounts_makeads.sql \\
    --company <uuid da empresa> --author <uuid de quem importa> --out meta-tokens.sql

A chave é a mesma GOOGLE_TOKEN_KEY_ADS da Vercel (32 bytes em base64). Para
não deixá-la no histórico do terminal:  read -s GOOGLE_TOKEN_KEY_ADS && export GOOGLE_TOKEN_KEY_ADS`;

/** Seals a token as api/_google.ts does: v1:base64(iv · tag · body). */
export function seal(key, text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`;
}

export function readKey(value) {
  if (!value)
    throw new UsageError(
      "Defina GOOGLE_TOKEN_KEY_ADS (a mesma chave da Vercel) antes de rodar.",
    );
  const key = Buffer.from(value.trim(), "base64");
  if (key.length !== 32)
    throw new UsageError(
      "GOOGLE_TOKEN_KEY_ADS inválida: precisa ter 32 bytes em base64.",
    );
  return key;
}

const addDays = (day, n) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const validDay = (v) =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && v > "2000-01-01";

/**
 * One row per ad account: its token, the profile that reaches it and an
 * estimated expiry (the profile's token generation + 60 days; unknown when
 * the account's token isn't the profile's). Returns the rows and a report
 * (counts only: nothing here may print a token).
 */
export function buildRows(tables) {
  const profiles = tables.get("usuarios_make_facebook") ?? [];
  const accounts = tables.get("usuarios_make_facebook_accounts_makeads") ?? [];
  if (!accounts.length)
    throw new UsageError(
      "A exportação não tem a tabela usuarios_make_facebook_accounts_makeads.",
    );
  // The newest row of each profile.
  const profileOf = new Map();
  for (const p of profiles) {
    const id = String(p.facebook_user_id ?? "").trim();
    const prev = profileOf.get(id);
    if (!prev || String(p.gerado_em ?? "") > String(prev.gerado_em ?? ""))
      profileOf.set(id, p);
  }
  const report = { accounts: accounts.length, skipped: {}, estimated: 0 };
  const skip = (why) => (report.skipped[why] = (report.skipped[why] ?? 0) + 1);
  const rows = new Map();
  for (const a of accounts) {
    const account = String(a.id_account ?? "")
      .trim()
      .replace(/^act_/i, "");
    const token = String(a.access_token ?? "").trim();
    const fbUser = String(a.id_usuario ?? "").trim();
    if (!/^\d{1,30}$/.test(account)) {
      skip("conta de anúncio com ID inválido");
      continue;
    }
    if (!/^EAA[A-Za-z0-9]{20,}$/.test(token)) {
      skip("sem token do Facebook válido");
      continue;
    }
    const profile = profileOf.get(fbUser);
    const generated =
      profile && String(profile.facebook_access_token ?? "").trim() === token
        ? profile.gerado_em
        : null;
    const expires = validDay(generated)
      ? `${addDays(generated, TOKEN_DAYS)}T00:00:00Z`
      : null;
    if (expires) report.estimated++;
    const row = {
      account,
      fbUser: /^\d{1,40}$/.test(fbUser) ? fbUser : "",
      token,
      expires,
    };
    // The same account twice: the one with the later expiry wins.
    const prev = rows.get(account);
    if (!prev || String(row.expires ?? "") > String(prev.expires ?? ""))
      rows.set(account, row);
    else skip("conta repetida");
  }
  report.rows = rows.size;
  return { rows: [...rows.values()], report };
}

/** The SQL: sealed tokens into a temporary table, then into MAVI. */
export function renderSql(rows, { company, author, key, now = new Date() }) {
  const values = rows
    .map(
      (r) =>
        ` (${sqlString(r.account)}, ${sqlString(r.fbUser)}, ${sqlString(seal(key, r.token))}, ${
          r.expires
            ? `${sqlString(r.expires)}::timestamptz`
            : "null::timestamptz"
        })`,
    )
    .join(",\n");
  const c = sqlString(company);
  return `-- Campanhas: acessos do Facebook (Meta Ads) importados do MASO.
-- Gerado por scripts/import-maso-meta-tokens.mjs em ${now.toISOString()}.
-- ${rows.length} contas de anúncio. Os tokens estão cifrados com a
-- GOOGLE_TOKEN_KEY_ADS (o banco nunca vê o token aberto). Apague este
-- arquivo depois de rodar.
-- No pgAdmin: Query Tool → abrir este arquivo → Execute script (F5).
begin;

create temporary table maso_meta_tokens (
 account_id text primary key,
 fb_user_id text not null,
 token_cipher text not null,
 expires_at timestamptz
) on commit drop;

insert into maso_meta_tokens(account_id, fb_user_id, token_cipher, expires_at) values
${values};

-- The client (and the account's name) from the Meta campaigns linked to
-- the account: the active campaign first, then the latest cycle.
create temporary table maso_meta_import on commit drop as
select t.*, owner.client_id, coalesce(owner.account_name, '') as account_name,
 exists (select 1 from mavi_private.ad_meta_accounts m where m.company_id = ${c} and m.account_id = t.account_id
  and m.fb_user_name <> ${sqlString(IMPORTED_PROFILE)}) as connected_in_mavi
from maso_meta_tokens t
left join lateral (
 select k2.client_id, k2.account_name from (
  select c.client_id, nullif(k.account_name, '') as account_name, a.status, y.end_date
  from public.ad_cycle_links k
  join public.ad_cycles y on y.company_id = k.company_id and y.id = k.cycle_id
  join public.ad_campaigns a on a.company_id = y.company_id and a.id = y.campaign_id and a.platform = 'meta'
  join public.contracts c on c.company_id = a.company_id and c.id = a.contract_id
  where k.company_id = ${c} and k.account_id = t.account_id
 ) k2 order by (k2.status = 'active') desc, k2.end_date desc, k2.account_name is null limit 1
) owner on true;

insert into mavi_private.ad_meta_accounts(company_id, account_id, name, fb_user_id, fb_user_name, token_cipher,
 token_expires_at, connected_by, client_id)
select ${c}, account_id, left(account_name, 200), fb_user_id, ${sqlString(IMPORTED_PROFILE)}, token_cipher,
 expires_at, ${sqlString(author)}, client_id
from maso_meta_import where not connected_in_mavi
on conflict (company_id, account_id) do update set token_cipher = excluded.token_cipher,
 token_expires_at = excluded.token_expires_at, fb_user_id = excluded.fb_user_id,
 name = case when excluded.name <> '' then excluded.name else ad_meta_accounts.name end,
 client_id = coalesce(ad_meta_accounts.client_id, excluded.client_id), updated_at = now()
-- Imported before: only a newer token replaces it.
where ad_meta_accounts.fb_user_name = ${sqlString(IMPORTED_PROFILE)}
 and coalesce(ad_meta_accounts.token_expires_at, '-infinity') <= coalesce(excluded.token_expires_at, 'infinity');

-- Summary (shown by pgAdmin after the script).
select count(*) as contas_no_arquivo,
 count(*) filter (where not connected_in_mavi and client_id is not null) as importadas_com_cliente,
 count(*) filter (where not connected_in_mavi and client_id is null) as importadas_sem_cliente,
 count(*) filter (where connected_in_mavi) as ja_conectadas_no_mavi_mantidas,
 count(*) filter (where expires_at < now()) as token_possivelmente_vencido
from maso_meta_import;

commit;
`;
}

export function parseArgs(argv) {
  const opts = { input: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v == null || v.startsWith("--"))
        throw new UsageError(`Faltou o valor de ${a}.`);
      return v;
    };
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--input") opts.input.push(next());
    else if (a === "--company") opts.company = next();
    else if (a === "--author") opts.author = next();
    else if (a === "--out") opts.out = next();
    else throw new UsageError(`Opção desconhecida: ${a}`);
  }
  return opts;
}

export async function main(argv, env = process.env, log = console.log) {
  const opts = parseArgs(argv);
  if (opts.help) {
    log(USAGE);
    return;
  }
  if (!opts.input.length) throw new UsageError("Informe os --input.");
  if (!UUID.test(opts.company ?? ""))
    throw new UsageError("Informe --company com o UUID da empresa.");
  if (!UUID.test(opts.author ?? ""))
    throw new UsageError(
      "Informe --author com o UUID de quem importa (um administrador).",
    );
  if (!opts.out) throw new UsageError("Informe --out com o arquivo .sql.");
  const key = readKey(env.GOOGLE_TOKEN_KEY_ADS);
  const tables = await readExports(opts.input);
  const { rows, report } = buildRows(tables);
  await writeFile(
    opts.out,
    renderSql(rows, { company: opts.company, author: opts.author, key }),
    { encoding: "utf8", mode: 0o600 },
  );
  log(
    `${report.rows} contas de anúncio com token (de ${report.accounts} no arquivo); validade estimada em ${report.estimated}.`,
  );
  for (const [why, n] of Object.entries(report.skipped))
    log(`  ignoradas: ${n} — ${why}`);
  log(
    `SQL gravado em ${resolve(opts.out)}. Rode no pgAdmin (Execute script) e apague o arquivo depois.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof UsageError ? e.message : e);
    process.exit(1);
  });

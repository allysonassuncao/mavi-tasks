// Financeiro › Mídia: imports the MASO's media credits (usuarios_make_midia,
// a phpMyAdmin SQL dump) as entries of the media accounts, into SQL files for
// the Supabase SQL editor (runs as postgres, bypassing the RPCs; the tables'
// checks still apply). Migration 20270114090000_finance_media.
//
//   node scripts/import-maso-media.mjs --input usuarios_make_midia.sql
//     --out-dir maso-midia-import
//
// Writes two files:
//  * 01-conferencia.sql: read-only. Shows which MASO clients became which
//    account, and which were left out (and why), without changing anything.
//  * 02-importacao.sql: one transaction that adds the entries. Idempotent:
//    each entry carries its MASO id in the reason ("Importado do MASO #123"),
//    so running it again adds nothing.
//
// Rules agreed with the user (30/09/2026):
//  * tipo 2 and 3 are credits; the others (0, 1, 4, "-REMOVIDO"…) stay out;
//    so do the rows with somavel = 0 and the zero or unreadable values;
//  * the MAVI client's name is the MASO id_cliente ("774"); the account is its
//    "Make Ads" contracted product;
//  * who made it: the MASO user, by e-mail (USERS); the robot (75) and any
//    other user are financeiro@;
//  * the date is the day it was recorded (data), or the competence month when
//    the MASO has no date; the time of the record is kept as created_at;
//  * category "Depósito do cliente", or "Bônus ou cortesia" for vouchers.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  cleanText,
  parseDate,
  parseNumber,
  parseSqlDump,
  sqlString,
} from "./import-maso-campaigns.mjs";

export const TABLE = "usuarios_make_midia";
export const PRODUCT = "Make Ads";
export const CREDIT_TYPES = ["2", "3"];
export const USERS = {
  73: "financeiro@makevendas.com.br",
  196: "financeiro@makevendas.com.br",
  1: "allyson@makevendas.com.br",
  135: "andrey@makevendas.com.br",
};
export const DEFAULT_USER = "financeiro@makevendas.com.br";
export const CATEGORY = "Depósito do cliente";
export const VOUCHER_CATEGORY = "Bônus ou cortesia";
const BATCH = 500;

/** What of the dump becomes an entry, and why each other row stays out. */
export function buildEntries(rows) {
  const entries = [];
  const skipped = {};
  const skip = (why) => (skipped[why] = (skipped[why] ?? 0) + 1);
  for (const r of rows) {
    const tipo = cleanText(r.tipo);
    if (!CREDIT_TYPES.includes(tipo)) {
      skip(`tipo ${tipo || "vazio"}`);
      continue;
    }
    if (cleanText(r.somavel) === "0") {
      skip("não somável");
      continue;
    }
    const value = parseNumber(r.valor);
    if (value == null || Number.isNaN(value)) {
      skip("valor vazio ou ilegível");
      continue;
    }
    const amount = Math.round(value * 100) / 100;
    if (amount <= 0) {
      skip(amount < 0 ? "valor negativo" : "valor zero");
      continue;
    }
    const day = parseDate(r.data);
    const competence = parseDate(r.competencia);
    const occurred = day ?? competence;
    if (!occurred) {
      skip("sem data nem competência");
      continue;
    }
    const time = /^\d{1,2}:\d{2}(:\d{2})?$/.test(cleanText(r.hora))
      ? cleanText(r.hora)
      : "12:00:00";
    const id = cleanText(r.id);
    const user = cleanText(r.id_usuario_maso);
    const motivo = cleanText(r.motivo).replace(/\s+/g, " ");
    const reason = `Importado do MASO #${id} (tipo ${tipo})${motivo ? `: ${motivo}` : ""}`;
    entries.push({
      id: Number(id),
      client: cleanText(r.id_cliente),
      amount,
      occurred_on: occurred,
      // When it was recorded, in the company's time zone.
      registered_at: `${day ?? competence} ${day ? time : "12:00:00"}`,
      email: USERS[user] ?? DEFAULT_USER,
      voucher: cleanText(r.voucher) === "1",
      reason: reason.slice(0, 1000),
    });
  }
  return { entries, skipped };
}

function dataSql(entries) {
  const out = [
    "drop table if exists maso_midia;",
    "create temp table maso_midia(id integer primary key, id_cliente text not null, amount numeric(14,2) not null," +
      " occurred_on date not null, registered_at timestamp not null, email text not null, voucher boolean not null," +
      " reason text not null);",
  ];
  for (let i = 0; i < entries.length; i += BATCH) {
    const values = entries
      .slice(i, i + BATCH)
      .map(
        (e) =>
          `(${e.id},${sqlString(e.client)},${e.amount.toFixed(2)},'${e.occurred_on}','${e.registered_at}',` +
          `${sqlString(e.email)},${e.voucher},${sqlString(e.reason)})`,
      );
    out.push(
      `insert into maso_midia(id, id_cliente, amount, occurred_on, registered_at, email, voucher, reason) values\n${values.join(",\n")};`,
    );
  }
  return out.join("\n");
}

// The company (the one with the "Make Ads" product), each row's account and
// why a row has none. Shared by both files.
const MATCH_SQL = `
drop table if exists maso_midia_empresa;
create temp table maso_midia_empresa as
 select p.company_id from public.products p where lower(btrim(p.name)) = lower(${sqlString(PRODUCT)});
drop table if exists maso_midia_conta;
create temp table maso_midia_conta as
 with company as (select company_id from maso_midia_empresa limit 1),
 clientes as (
  select distinct m.id_cliente from maso_midia m
 ), achados as (
  select c.id_cliente, count(cl.id) as n_clientes, min(cl.id::text)::uuid as client_id
  from clientes c
  left join public.clients cl on cl.company_id = (select company_id from company) and btrim(cl.name) = c.id_cliente
  group by c.id_cliente
 ), contas as (
  select a.*, (select k.id from public.contracts k
    join public.products p on p.company_id = k.company_id and p.id = k.product_id
    where k.company_id = (select company_id from company) and k.client_id = a.client_id
     and lower(btrim(p.name)) = lower(${sqlString(PRODUCT)})
    order by k.archived, k.id limit 1) as contract_id
  from achados a where a.n_clientes = 1
  union all
  select a.*, null::uuid from achados a where a.n_clientes <> 1
 )
 select id_cliente, contract_id,
  case when n_clientes = 0 then 'sem cliente com esse nome no MAVI'
   when n_clientes > 1 then 'mais de um cliente com esse nome no MAVI'
   when contract_id is null then 'cliente sem o produto ${PRODUCT}' end as problema
 from contas;`;

const REPORT_SQL = `
select problema, count(distinct c.id_cliente) as clientes, count(m.id) as lancamentos, sum(m.amount) as valor,
 string_agg(distinct c.id_cliente, ', ' order by c.id_cliente) filter (where c.problema is not null) as ids_do_maso
from maso_midia m join maso_midia_conta c on c.id_cliente = m.id_cliente
group by problema order by problema nulls first;`;

export function renderPreview(entries, skipped, source) {
  return [
    "-- Financeiro › Mídia: CONFERÊNCIA da importação das entradas do MASO (não muda nada).",
    `-- Origem: ${source} · ${entries.length} entradas a importar.`,
    `-- Ficaram de fora já no arquivo: ${JSON.stringify(skipped)}`,
    "-- Resultado: uma linha por situação. problema vazio = entra na conta Make Ads do cliente.",
    "",
    dataSql(entries),
    MATCH_SQL,
    "",
    "do $$ begin",
    "  if (select count(*) from maso_midia_empresa) <> 1 then",
    `    raise exception 'Esperava uma empresa com o produto ${PRODUCT}; há %', (select count(*) from maso_midia_empresa);`,
    "  end if;",
    "end $$;",
    "",
    "-- Quem lançou: cada e-mail precisa ser de uma pessoa ativa da empresa.",
    "select m.email, count(*) as lancamentos,",
    "  exists (select 1 from auth.users u join public.memberships s on s.user_id = u.id",
    "   and s.company_id = (select company_id from maso_midia_empresa) and s.active",
    "   where lower(u.email) = lower(m.email)) as encontrado",
    "from maso_midia m group by m.email;",
    "",
    REPORT_SQL,
    "",
  ].join("\n");
}

export function renderImport(entries, skipped, source) {
  return [
    "-- Financeiro › Mídia: IMPORTAÇÃO das entradas do MASO (usuarios_make_midia).",
    `-- Origem: ${source} · ${entries.length} entradas no arquivo.`,
    `-- Ficaram de fora já no arquivo: ${JSON.stringify(skipped)}`,
    "-- Uma transação; idempotente (o id do MASO vai no motivo: rodar de novo não duplica).",
    "-- Clientes sem conta Make Ads ficam de fora (veja o resultado no fim e o 01-conferencia.sql).",
    "",
    dataSql(entries),
    MATCH_SQL,
    "",
    "begin;",
    "set local statement_timeout = 0;",
    "",
    "do $$",
    "declare v_company uuid; v_missing text; begin",
    "  if (select count(*) from maso_midia_empresa) <> 1 then",
    `    raise exception 'Esperava uma empresa com o produto ${PRODUCT}; há %', (select count(*) from maso_midia_empresa);`,
    "  end if;",
    "  select company_id into v_company from maso_midia_empresa;",
    "  select string_agg(distinct m.email, ', ') into v_missing from maso_midia m",
    "  where not exists (select 1 from auth.users u join public.memberships s on s.user_id = u.id",
    "   and s.company_id = v_company and s.active where lower(u.email) = lower(m.email));",
    "  if v_missing is not null then",
    "    raise exception 'Sem pessoa ativa na empresa para: %', v_missing;",
    "  end if;",
    "  if (select count(*) from public.media_categories where company_id = v_company and not archived",
    `    and name in (${sqlString(CATEGORY)}, ${sqlString(VOUCHER_CATEGORY)}) and kind in ('credit', 'both')) <> 2 then`,
    `    raise exception 'As categorias "${CATEGORY}" e "${VOUCHER_CATEGORY}" (de entradas) precisam existir.';`,
    "  end if;",
    "end $$;",
    "",
    "drop table if exists maso_midia_ja;",
    "create temp table maso_midia_ja as",
    " select distinct (regexp_match(e.reason, '^Importado do MASO #(\\d+) '))[1]::integer as id",
    " from public.media_entries e",
    " where e.company_id = (select company_id from maso_midia_empresa) and e.reason like 'Importado do MASO #%';",
    "",
    "with pessoas as (",
    " select distinct on (lower(u.email)) lower(u.email) as email, u.id",
    " from auth.users u join public.memberships s on s.user_id = u.id",
    "  and s.company_id = (select company_id from maso_midia_empresa) and s.active",
    " order by lower(u.email), u.id",
    "), categorias as (",
    " select name, id from public.media_categories where company_id = (select company_id from maso_midia_empresa)",
    ")",
    "insert into public.media_entries(company_id, contract_id, kind, amount, occurred_on, source, category_id, reason,",
    "  created_by, created_at)",
    " select (select company_id from maso_midia_empresa), c.contract_id, 'credit', m.amount, m.occurred_on, 'manual',",
    `  (select id from categorias where name = case when m.voucher then ${sqlString(VOUCHER_CATEGORY)} else ${sqlString(CATEGORY)} end),`,
    "  m.reason, p.id,",
    "  m.registered_at at time zone coalesce((select timezone from public.companies",
    "   where id = (select company_id from maso_midia_empresa)), 'America/Sao_Paulo')",
    " from maso_midia m",
    " join maso_midia_conta c on c.id_cliente = m.id_cliente and c.contract_id is not null",
    " join pessoas p on p.email = lower(m.email)",
    " where not exists (select 1 from maso_midia_ja j where j.id = m.id)",
    " order by m.registered_at, m.id;",
    "",
    "-- As contas que ficaram ok com as entradas não avisam ninguém; as que",
    "-- seguem negativas continuam como estavam (o aviso só sai quando piora).",
    "commit;",
    "",
    "-- Resultado: quantas entraram agora e, por situação, o que ficou de fora.",
    "select (select count(*) from maso_midia m where m.id not in (select id from maso_midia_ja)",
    "  and exists (select 1 from maso_midia_conta c where c.id_cliente = m.id_cliente and c.contract_id is not null))",
    "  as importadas_agora,",
    " (select count(*) from maso_midia_ja) as ja_estavam_importadas;",
    REPORT_SQL,
    "",
  ].join("\n");
}

export async function main(argv, log = console.log) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input" || a === "--out-dir") args[a.slice(2)] = argv[++i];
    else throw new Error(`Opção desconhecida: ${a}`);
  }
  if (!args.input || !args["out-dir"])
    throw new Error(
      "Uso: node scripts/import-maso-media.mjs --input usuarios_make_midia.sql --out-dir <pasta>",
    );
  const text = await readFile(args.input, "utf8");
  const rows = parseSqlDump(text, args.input).get(TABLE) ?? [];
  if (!rows.length) throw new Error(`Nenhuma linha de ${TABLE} em ${args.input}.`);
  const { entries, skipped } = buildEntries(rows);
  const dir = resolve(args["out-dir"]);
  await mkdir(dir, { recursive: true });
  const source = args.input.split("/").pop();
  await writeFile(join(dir, "01-conferencia.sql"), renderPreview(entries, skipped, source));
  await writeFile(join(dir, "02-importacao.sql"), renderImport(entries, skipped, source));
  const total = entries.reduce((s, e) => s + e.amount, 0);
  log(`${rows.length} linhas lidas; ${entries.length} entradas (R$ ${total.toFixed(2)}) de ${new Set(entries.map((e) => e.client)).size} clientes.`);
  log(`Fora: ${JSON.stringify(skipped)}`);
  log(`Arquivos em ${dir}: 01-conferencia.sql e 02-importacao.sql`);
  return { entries, skipped };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });

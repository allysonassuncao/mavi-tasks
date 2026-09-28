// Campanhas: fixes the destination of the cycles imported from the MASO
// whose Make capture page had letters in its id ("81895b88"). The import
// then took only numeric ids, so those cycles came in as "página externa"
// and the sync counted the site's pixel instead of the page's leads (the
// MASO counted dados_capture). Reads the phpMyAdmin dump
// maso_acompanhamento_ciclo.sql and writes one SQL file for pgAdmin:
//
//   node scripts/fix-maso-capture-pages.mjs \
//     --input maso_acompanhamento_ciclo.sql --company <uuid> --out fix-pages.sql
//
// Only cycles still as imported change (página externa with no pages, or
// only the page ids that were numbers): one edited in MAVI since keeps what
// someone chose. Safe to run again.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  UsageError,
  captureDestination,
  cleanText,
  readExports,
  sqlArray,
  sqlString,
} from "./import-maso-campaigns.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE = `Uso:
  node scripts/fix-maso-capture-pages.mjs \\
    --input maso_acompanhamento_ciclo.sql --company <uuid da empresa> --out fix-pages.sql`;

/** The MASO cycles whose pages the import dropped: { legacy, pages }. */
export function buildFixes(tables) {
  const cycles = tables.get("maso_acompanhamento_ciclo") ?? [];
  if (!cycles.length)
    throw new UsageError(
      "A exportação não tem a tabela maso_acompanhamento_ciclo.",
    );
  const fixes = [];
  for (const row of cycles) {
    const legacy = cleanText(row.id_ciclo);
    const { destination, pages } = captureDestination(row.id_capture);
    if (
      legacy &&
      destination === "make_landing_page" &&
      pages.some((p) => !/^\d+$/.test(p))
    )
      fixes.push({ legacy, pages });
  }
  return fixes;
}

export function renderSql(fixes, { company, now = new Date() }) {
  const c = sqlString(company);
  const values = fixes
    .map((f) => ` (${sqlString(f.legacy)}, ${sqlArray(f.pages)}::text[])`)
    .join(",\n");
  return `-- Campanhas: páginas de captura da Make com letras no id, perdidas no import do MASO.
-- Gerado por scripts/fix-maso-capture-pages.mjs em ${now.toISOString()}.
-- No pgAdmin: Query Tool → abrir este arquivo → Execute script (F5).
begin;

create temporary table maso_capture_fix (legacy_id text primary key, landing_pages text[] not null)
 on commit drop;
${fixes.length ? `insert into maso_capture_fix(legacy_id, landing_pages) values\n${values}\non conflict do nothing;` : ""}

-- Only cycles still as imported: página externa with no pages, or the Make
-- page with only the ids that were numbers.
with fixed as (
 update public.ad_cycles y set destination = 'make_landing_page', landing_pages = f.landing_pages,
  updated_at = now(), version = y.version + 1
 from maso_capture_fix f
 where y.company_id = ${c} and y.legacy_id = f.legacy_id
  and ((y.destination = 'external_page' and y.landing_pages = '{}')
   or (y.destination = 'make_landing_page' and y.landing_pages =
    array(select p from unnest(f.landing_pages) with ordinality u(p, n) where p ~ '^[0-9]+$' order by n)))
 returning y.id, y.end_date
)
select (select count(*) from maso_capture_fix) as ciclos_no_arquivo,
 count(*) as corrigidos,
 count(*) filter (where end_date >= current_date - 8) as corrigidos_em_andamento
from fixed;

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
    else if (a === "--out") opts.out = next();
    else throw new UsageError(`Opção desconhecida: ${a}`);
  }
  return opts;
}

export async function main(argv, log = console.log) {
  const opts = parseArgs(argv);
  if (opts.help) {
    log(USAGE);
    return;
  }
  if (!opts.input.length) throw new UsageError("Informe o --input.");
  if (!UUID.test(opts.company ?? ""))
    throw new UsageError("Informe --company com o UUID da empresa.");
  if (!opts.out) throw new UsageError("Informe --out com o arquivo .sql.");
  const fixes = buildFixes(await readExports(opts.input));
  await writeFile(opts.out, renderSql(fixes, { company: opts.company }), {
    encoding: "utf8",
  });
  log(
    `${fixes.length} ciclos do MASO com página de captura com letras no id. SQL gravado em ${resolve(opts.out)}.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof UsageError ? e.message : e);
    process.exit(1);
  });

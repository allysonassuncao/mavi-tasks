// Campanhas: brings the MASO's Facebook lead forms over to MAVI (the links
// "formulário do Facebook → página de captura da Make" made in the cycle, and
// the Pages' tokens), so the webhook /api/meta-leadgen keeps delivering
// them after the Meta app's callback moves to MAVI. Reads two phpMyAdmin
// dumps
//   produto_capture_formulario_facebook  (id_usuario, id_capture,
//                                         id_page_facebook, id_form_facebook)
//   usuarios_make_facebook_page          (id_page, access_token_page_facebook)
// and writes one SQL file for pgAdmin (runs as postgres).
//
//   GOOGLE_TOKEN_KEY_ADS=… node scripts/import-maso-lead-forms.mjs \
//     --input produto_capture_formulario_facebook.sql \
//     --input usuarios_make_facebook_page.sql \
//     --company <uuid> --author <uuid> --out lead-forms.sql
//
// Page tokens are sealed here (never in the clear in the file). The MAVI
// client of each form: the Meta campaigns whose cycles use its capture page
// (the active one first, then the latest cycle), else the client named with
// the MASO id (how scripts/import-maso-campaigns.mjs created them). A form
// or Page linked in MAVI already is never touched; running again adds only
// what is new.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  UsageError,
  readExports,
  sqlString,
} from "./import-maso-campaigns.mjs";
import { readKey, seal } from "./import-maso-meta-tokens.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS = /^[0-9]{1,30}$/;

const USAGE = `Uso:
  GOOGLE_TOKEN_KEY_ADS=… node scripts/import-maso-lead-forms.mjs \\
    --input produto_capture_formulario_facebook.sql \\
    --input usuarios_make_facebook_page.sql \\
    --company <uuid da empresa> --author <uuid de quem importa> --out lead-forms.sql`;

/** Pages (newest token of each) and links (one per form), with counts. */
export function buildLinks(tables) {
  const pageRows = tables.get("usuarios_make_facebook_page") ?? [];
  const linkRows = tables.get("produto_capture_formulario_facebook") ?? [];
  if (!linkRows.length)
    throw new UsageError(
      "A exportação não tem a tabela produto_capture_formulario_facebook.",
    );
  const report = { links: linkRows.length, skipped: {} };
  const skip = (why) => (report.skipped[why] = (report.skipped[why] ?? 0) + 1);
  const newer = (a, b) => Number(a.id ?? 0) >= Number(b.id ?? 0);

  const pages = new Map();
  for (const p of pageRows) {
    const page = String(p.id_page ?? "").trim();
    const token = String(p.access_token_page_facebook ?? "").trim();
    if (!DIGITS.test(page) || !/^EAA[A-Za-z0-9]{20,}$/.test(token)) continue;
    const prev = pages.get(page);
    if (!prev || newer(p, prev.row)) pages.set(page, { page, token, row: p });
  }

  const links = new Map();
  for (const l of linkRows) {
    const form = String(l.id_form_facebook ?? "").trim();
    const page = String(l.id_page_facebook ?? "").trim();
    const capture = String(l.id_capture ?? "").trim();
    const user = String(l.id_usuario ?? "").trim();
    if (!DIGITS.test(form) || !DIGITS.test(page)) {
      skip("formulário ou página do Facebook inválidos");
      continue;
    }
    if (!/^[0-9A-Za-z_-]{1,60}$/.test(capture) || capture === "0") {
      skip("sem página de captura");
      continue;
    }
    if (!/^[0-9]{1,20}$/.test(user)) {
      skip("sem cliente da Make");
      continue;
    }
    if (!pages.has(page)) {
      skip("página do Facebook sem token no MASO (integre de novo no MAVI)");
      continue;
    }
    const row = { form, page, capture, user, id: l.id };
    const prev = links.get(form);
    if (!prev || newer(row, prev)) {
      if (prev) skip("formulário repetido (vale o vínculo mais recente)");
      links.set(form, row);
    } else skip("formulário repetido (vale o vínculo mais recente)");
  }
  const used = new Set([...links.values()].map((l) => l.page));
  report.rows = links.size;
  report.pages = used.size;
  return {
    pages: [...pages.values()].filter((p) => used.has(p.page)),
    links: [...links.values()],
    report,
  };
}

export function renderSql(
  { pages, links },
  { company, author, key, now = new Date() },
) {
  const c = sqlString(company);
  const a = sqlString(author);
  const pageValues = pages
    .map((p) => ` (${sqlString(p.page)}, ${sqlString(seal(key, p.token))})`)
    .join(",\n");
  const linkValues = links
    .map(
      (l) =>
        ` (${sqlString(l.form)}, ${sqlString(l.page)}, ${sqlString(l.capture)}, ${sqlString(l.user)})`,
    )
    .join(",\n");
  return `-- Campanhas: formulários do Facebook integrados no MASO, trazidos para o MAVI.
-- Gerado por scripts/import-maso-lead-forms.mjs em ${now.toISOString()}.
-- ${links.length} formulários, ${pages.length} páginas. Os tokens das páginas
-- estão cifrados com a GOOGLE_TOKEN_KEY_ADS. Apague este arquivo depois de rodar.
-- No pgAdmin: Query Tool → abrir este arquivo → Execute script (F5).
begin;

create temporary table maso_pages (page_id text primary key, token_cipher text not null) on commit drop;
${pages.length ? `insert into maso_pages values\n${pageValues};` : "-- (nenhuma página)"}

create temporary table maso_forms (form_id text primary key, page_id text not null, landing_page_id text not null,
 make_user_id text not null) on commit drop;
insert into maso_forms values
${linkValues};

-- The client: the Meta campaigns whose cycles use the capture page, else
-- the client named with the MASO id.
create temporary table maso_forms_import on commit drop as
select f.*, coalesce(by_page.client_id, by_name.id) as client_id,
 exists (select 1 from public.ad_lead_forms x where x.company_id = ${c} and x.form_id = f.form_id) as linked_in_mavi
from maso_forms f
left join lateral (
 select k.client_id from public.ad_cycles y
 join public.ad_campaigns a on a.company_id = y.company_id and a.id = y.campaign_id and a.platform = 'meta'
 join public.contracts k on k.company_id = a.company_id and k.id = a.contract_id
 where y.company_id = ${c} and f.landing_page_id = any(y.landing_pages)
 order by (a.status = 'active') desc, y.end_date desc limit 1
) by_page on true
left join lateral (
 select cl.id from public.clients cl where cl.company_id = ${c} and cl.name = f.make_user_id
 order by cl.archived, cl.created_at limit 1
) by_name on true;

-- A Page connected in MAVI keeps its token.
insert into mavi_private.ad_meta_pages(company_id, page_id, token_cipher, connected_by)
select ${c}, p.page_id, p.token_cipher, ${a} from maso_pages p
on conflict (company_id, page_id) do nothing;

insert into public.ad_lead_forms(company_id, client_id, page_id, form_id, landing_page_id, make_user_id, source, created_by)
select ${c}, client_id, page_id, form_id, landing_page_id, make_user_id, 'maso', ${a}
from maso_forms_import where not linked_in_mavi
on conflict (company_id, form_id) do nothing;

-- Summary (shown by pgAdmin after the script).
select count(*) as formularios_no_arquivo,
 count(*) filter (where not linked_in_mavi and client_id is not null) as importados_com_cliente,
 count(*) filter (where not linked_in_mavi and client_id is null) as importados_sem_cliente,
 count(*) filter (where linked_in_mavi) as ja_integrados_no_mavi_mantidos
from maso_forms_import;

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
  const built = buildLinks(await readExports(opts.input));
  if (!built.links.length)
    throw new UsageError("Nenhum formulário com página e token para importar.");
  await writeFile(
    opts.out,
    renderSql(built, { company: opts.company, author: opts.author, key }),
    { encoding: "utf8", mode: 0o600 },
  );
  log(
    `${built.report.rows} formulários (de ${built.report.links} vínculos no arquivo), ${built.report.pages} páginas do Facebook.`,
  );
  for (const [why, n] of Object.entries(built.report.skipped))
    log(`  ignorados: ${n} — ${why}`);
  log(
    `SQL gravado em ${resolve(opts.out)}. Rode no pgAdmin (Execute script) e apague o arquivo depois.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof UsageError ? e.message : e);
    process.exit(1);
  });

// Onboarding › Social Leads: brings the briefings and plans of the
// "Briefing Social Leads" artifact (build B29) over to MAVI. Reads the
// artifact's database exported as JSON files
//   <input>/clients/<slug>.json                 (the briefing)
//   <input>/clients/<slug>/plans/<planId>.json  (one plan per month)
// and writes one SQL file for the SQL Editor (runs as postgres).
//
//   node scripts/import-social-leads-artifact.mjs --input <pasta> \
//     --company "Make Acelerador de Vendas" --author allyson@makevendas.com.br \
//     --out social-leads-import.sql
//
// The MAVI contract of each artifact client is found in the database: the
// Social Leads contract (social_leads_settings; when not configured yet, the
// product named "Social Leads" is chosen) of the client whose name is
// the artifact's clientName (accents and case ignored). A client not found
// is listed at the end and skipped; run again after fixing the name.
// The responsible comes from the member with the same name. Decisions
// (aprovado/reprovado/observação) and the plan's creation date are kept.
// Artwork files (posts[].artes) are not brought over: the blobs live inside
// the artifact; their names are listed so they can go to the Drive.
// Idempotent: a briefing or month already in MAVI is never touched.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE = `Uso:
  node scripts/import-social-leads-artifact.mjs --input <pasta da exportação> \\
    --company <uuid ou nome da empresa> --author <uuid ou e-mail de um administrador> \
    --out social-leads-import.sql`;

// The briefing fields MAVI keeps (the artifact's FIELD_IDS without accountManager).
const FIELDS = [
  "clientName",
  "segment",
  "contactName",
  "contactWhats",
  "briefingDate",
  "businessWhat",
  "positioning",
  "marketRegion",
  "competitors",
  "differentiators",
  "swotForcas",
  "swotFraquezas",
  "swotOportunidades",
  "swotAmeacas",
  "targetAudience",
  "socialProof",
  "igHandle",
  "fbHandle",
  "websiteUrl",
  "toneRefs",
  "featuredOffer",
  "averageTicket",
  "mediaBudget",
  "notes",
  "brandColors",
  "brandLogo",
  "brandVisualElements",
];

export class UsageError extends Error {}
const sql = (v) => (v == null ? "null" : `'${String(v).replace(/'/g, "''")}'`);
const json = (v) => `${sql(JSON.stringify(v))}::jsonb`;

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
async function list(dir) {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

/** Every client of the export, with its briefing and plans (oldest first). */
export async function readArtifact(input) {
  const base = join(input, "clients");
  const files = (await list(base)).filter((f) => f.endsWith(".json"));
  if (!files.length)
    throw new UsageError(
      `Nenhum cliente em ${base} (esperado clients/<slug>.json).`,
    );
  const clients = [];
  for (const f of files) {
    const slug = f.replace(/\.json$/, "");
    const doc = await readJson(join(base, f));
    const plans = [];
    for (const p of (await list(join(base, slug, "plans"))).filter((x) =>
      x.endsWith(".json"),
    ))
      plans.push({
        id: p.replace(/\.json$/, ""),
        ...(await readJson(join(base, slug, "plans", p))),
      });
    plans.sort((a, b) =>
      String(a.createdAt).localeCompare(String(b.createdAt)),
    );
    clients.push({ slug, doc, plans });
  }
  return clients;
}

export function briefingFields(doc) {
  const out = {};
  for (const k of FIELDS) {
    const v = doc[k];
    if (typeof v === "string" && v.trim()) out[k] = v;
  }
  return out;
}

/** The artifact plan as the database function expects it (artes dropped). */
export function planContent(plan) {
  const { id, artes, ...rest } = plan;
  return {
    ...rest,
    posts: (plan.posts ?? []).map(({ artes: _a, ...p }) => p),
  };
}

export function buildSql(clients, { company, author }) {
  if (!company?.trim())
    throw new UsageError("--company: o uuid ou o nome da empresa.");
  if (!author?.trim())
    throw new UsageError("--author: o uuid ou o e-mail de um administrador.");
  // By uuid, or looked up in the database (name of the company, e-mail of an admin).
  const companyExpr = UUID.test(company)
    ? `${sql(company)}::uuid`
    : `(select id from public.companies where name = ${sql(company)})`;
  const authorExpr = UUID.test(author)
    ? `${sql(author)}::uuid`
    : `(select m.user_id from public.memberships m where m.company_id = c and m.role = 'admin' and m.active and lower(m.email) = lower(${sql(author)}))`;
  const lines = [
    '-- Social Leads: importação do artefato "Briefing Social Leads" (B29).',
    "-- Rode no SQL Editor do Supabase. Pode rodar de novo: nada é duplicado.",
    "begin;",
    "create temporary table social_leads_import_report(client text, result text) on commit drop;",
    "create temporary table social_leads_import_who(company uuid, author uuid) on commit drop;",
    `do $sl$
declare c uuid; a uuid; pr uuid; tm uuid;
begin
 c := ${companyExpr};
 if c is null then raise exception 'Empresa não encontrada: %', ${sql(company)}; end if;
 a := ${authorExpr};
 if a is null then raise exception 'Administrador não encontrado: %', ${sql(author)}; end if;
 -- Not configured yet (the screen may not be published): the product named
 -- "Social Leads" becomes it, and the team with "social" in the name the squad.
 if not exists (select 1 from public.social_leads_settings where company_id = c) then
  select id into pr from public.products where company_id = c and mavi_private.fold(name) = 'social leads';
  if pr is null then
   raise exception 'Nenhum produto chamado "Social Leads" no catálogo. Crie o produto (ou escolha o produto em Onboarding › Social Leads) e rode de novo.';
  end if;
  select id into tm from public.teams where company_id = c and mavi_private.fold(name) like '%social%'
   and (select count(*) from public.teams t where t.company_id = c and mavi_private.fold(t.name) like '%social%') = 1;
  insert into public.social_leads_settings(company_id, product_id, team_id, updated_by) values (c, pr, tm, a);
  insert into social_leads_import_report values ('(configuração)', 'produto Social Leads escolhido'
   || case when tm is null then ', sem equipe do squad (escolha na tela)' else ', equipe do squad: ' || (select name from public.teams where id = tm) end);
 end if;
 insert into social_leads_import_who values (c, a);
end $sl$;`,
  ];
  const arts = [];
  for (const c of clients) {
    const name = c.doc.clientName || c.slug;
    const objective = ["form_nativo", "ctwa"].includes(c.doc.campaignObjective)
      ? c.doc.campaignObjective
      : null;
    for (const p of c.plans)
      for (const post of p.posts ?? [])
        for (const a of post.artes ?? [])
          arts.push(
            `${name} · ${p.label ?? p.id} · post ${post.numero}: ${a.nome}`,
          );
    const plans = c.plans.length ? c.plans : [null];
    lines.push(`do $sl$
declare k uuid; r uuid; p uuid; c uuid; a uuid;
begin
 select company, author into c, a from social_leads_import_who;
 select kk.id into k from public.contracts kk
 join public.clients cl on cl.company_id = kk.company_id and cl.id = kk.client_id
 join public.social_leads_settings s on s.company_id = kk.company_id and s.product_id = kk.product_id
 where kk.company_id = c and not kk.archived
  and mavi_private.fold(cl.name) in (mavi_private.fold(${sql(name)}), mavi_private.fold(${sql(c.slug.replace(/-/g, " "))}))
 order by kk.created_at limit 1;
 if k is null then
  insert into social_leads_import_report values (${sql(name)}, 'não encontrado: crie o cliente com o produto Social Leads (ou ajuste o nome) e rode de novo');
  return;
 end if;
 select m.user_id into r from public.memberships m
 where m.company_id = c and mavi_private.fold(m.name) = mavi_private.fold(${sql(c.doc.accountManager ?? "")}) limit 1;`);
    for (const p of plans)
      lines.push(` p := mavi_private.social_leads_import(c, k, a,
  ${json(briefingFields(c.doc))}, ${sql(objective)}, r,
  ${p ? json(planContent(p)) : "null"}, ${p?.createdAt ? `${sql(p.createdAt)}::timestamptz` : "null"});`);
    lines.push(` insert into social_leads_import_report values (${sql(name)}, 'importado (${c.plans.length} ${c.plans.length === 1 ? "plano" : "planos"})'
  || case when r is null and ${sql(c.doc.accountManager ?? "")} <> '' then ', sem responsável: ${String(c.doc.accountManager ?? "").replace(/'/g, "''")} não é membro' else '' end);
end $sl$;`);
  }
  lines.push(
    "select * from social_leads_import_report order by client;",
    "commit;",
  );
  if (arts.length)
    lines.push(
      "",
      "-- Artes que ficaram no artefato (suba no Drive do cliente):",
      ...arts.map((a) => `--   ${a}`),
    );
  return lines.join("\n") + "\n";
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, "");
    if (!k || argv[i + 1] == null) throw new UsageError(USAGE);
    out[k] = argv[i + 1];
  }
  if (!out.input || !out.out) throw new UsageError(USAGE);
  return out;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  try {
    const a = args(process.argv.slice(2));
    const clients = await readArtifact(a.input);
    await writeFile(a.out, buildSql(clients, a));
    console.log(
      `${a.out}: ${clients.length} clientes (${clients.reduce((n, c) => n + c.plans.length, 0)} planos). Rode no SQL Editor do Supabase.`,
    );
  } catch (e) {
    console.error(e instanceof UsageError ? e.message : e);
    process.exit(1);
  }
}

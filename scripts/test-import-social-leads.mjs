// Importação do artefato Social Leads (scripts/import-social-leads-artifact.mjs):
// acha o contrato pelo nome do cliente, o responsável pelo nome do membro,
// mantém as decisões e a data do plano, avisa quem não foi encontrado e não
// duplica ao rodar de novo.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase } from "./database-fixture.mjs";
import { buildSql, readArtifact } from "./import-social-leads-artifact.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, lorena, product, client, contract] = [
  1, 10, 12, 20, 23, 25,
].map(uid);
await db.query("insert into auth.users select unnest($1::uuid[])", [
  [admin, lorena],
]);
await db.exec(`insert into companies(id,name) values('${A}','Make');
insert into memberships(company_id,user_id,name,role) values('${A}','${admin}','Ana Admin','admin'),('${A}','${lorena}','Lorena Amaral','member');
insert into products(company_id,id,name) values('${A}','${product}','Social Leads');
insert into clients(company_id,id,name) values('${A}','${client}','Agente Stravitta');
insert into contracts(company_id,id,client_id,product_id,name) values('${A}','${contract}','${client}','${product}','Social Leads · Stravitta');
insert into teams(company_id,name) values('${A}','Squad Social Leads'),('${A}','Criação');`);
// Nothing configured yet: the import picks the product named "Social Leads".

const dir = await mkdtemp(join(tmpdir(), "sl-import-"));
await mkdir(join(dir, "clients", "agente-stravitta", "plans"), {
  recursive: true,
});
const posts = Array.from({ length: 8 }, (_, i) => ({
  numero: i + 1,
  badge: ["posicionar", "autoridade", "oferta"][i % 3],
  gancho: `Gancho ${i + 1}`,
  direcaoCopy: "Copy",
  direcaoVisual: "Visual",
  formato: "Imagem única",
  cta: "Seguir",
  ehAnuncio: i === 3,
  status: i < 2 ? "aprovado" : i === 2 ? "reprovado" : "pendente",
  observacao: i === 1 ? "show de bola" : "",
  ...(i === 0
    ? {
        artes: [
          {
            id: "x",
            url: "/_blob/x",
            nome: "post1-feed.png",
            tipo: "image/png",
            em: "2026-09-18T00:00:00Z",
          },
        ],
      }
    : {}),
}));
await writeFile(
  join(dir, "clients", "agente-stravitta.json"),
  JSON.stringify({
    clientName: "Agente Stravitta",
    accountManager: "Lorena Amaral",
    campaignObjective: "form_nativo",
    igHandle: "@orenatolive",
    notes: "Não gerar promessas.",
    status: "briefing",
    planCount: 1,
    createdAt: "2026-09-16T17:50:12.376Z",
  }),
);
await writeFile(
  join(dir, "clients", "agente-stravitta", "plans", "mes-1.json"),
  JSON.stringify({
    label: "Mês 1",
    createdAt: "2026-09-16T22:00:00.000Z",
    diagnostico: { negocio: "Rede", comoQuerSerVista: "Confiável" },
    swot: { forcas: "F", fraquezas: "Fr", oportunidades: "O", ameacas: "A" },
    pilares: [1, 2, 3, 4].map((n) => ({ titulo: `P${n}`, descricao: `D${n}` })),
    publico: "25 a 55",
    campanha: {
      objetivo: "Leads",
      regiao: "Brasil",
      idadeGenero: "25–55",
      segmentacao: "Interesses",
      posicionamentos: "Advantage+",
      orcamento: "R$ 500",
      perguntasFormulario: ["Nome"],
      roteamentoLead: "CRM",
    },
    alertas: ["Bloqueio: criar o Instagram"],
    posts,
  }),
);
await writeFile(
  join(dir, "clients", "teste.json"),
  JSON.stringify({
    clientName: "Cliente de teste",
    accountManager: "André Robusti",
  }),
);

const sql = buildSql(await readArtifact(dir), { company: A, author: admin });
assert.match(sql, /post 1: post1-feed\.png/);
assert.ok(!sql.includes("/_blob/"), "as artes não entram no banco");

// The report is the select before the commit.
const report = (await db.exec(sql)).findLast((r) => r.fields?.length)?.rows;
assert.deepEqual(report, [
  {
    client: "(configuração)",
    result:
      "produto Social Leads escolhido, equipe do squad: Squad Social Leads",
  },
  { client: "Agente Stravitta", result: "importado (1 plano)" },
  {
    client: "Cliente de teste",
    result:
      "não encontrado: crie o cliente com o produto Social Leads (ou ajuste o nome) e rode de novo",
  },
]);

const b = (
  await db.query(
    "select fields, campaign_objective, responsible_id from social_leads_briefings where contract_id=$1",
    [contract],
  )
).rows[0];
assert.equal(b.responsible_id, lorena);
assert.equal(b.campaign_objective, "form_nativo");
assert.deepEqual(Object.keys(b.fields).sort(), [
  "clientName",
  "igHandle",
  "notes",
]);
const p = (
  await db.query(
    "select id, month_number, source, created_at, content from social_leads_plans where contract_id=$1",
    [contract],
  )
).rows[0];
assert.equal(p.month_number, 1);
assert.equal(p.source, "artifact");
assert.equal(new Date(p.created_at).toISOString(), "2026-09-16T22:00:00.000Z");
assert.deepEqual(p.content.alertas, ["Bloqueio: criar o Instagram"]);
const decisions = (
  await db.query(
    "select number, decision, note from social_leads_posts where plan_id=$1 and number<=3 order by number",
    [p.id],
  )
).rows;
assert.deepEqual(decisions, [
  { number: 1, decision: "approved", note: "" },
  { number: 2, decision: "approved", note: "show de bola" },
  { number: 3, decision: "rejected", note: "" },
]);

// Rodar de novo não duplica.
await db.exec(sql);
assert.equal(
  (await db.query("select count(*)::int n from social_leads_plans")).rows[0].n,
  1,
);
assert.equal(
  (await db.query("select count(*)::int n from social_leads_posts")).rows[0].n,
  8,
);
// Pelo nome da empresa e o e-mail do administrador, sem uuids.
await db.query(
  "update memberships set email='ana@make.com.br' where user_id=$1",
  [admin],
);
const byName = buildSql(await readArtifact(dir), {
  company: "Make",
  author: "ANA@make.com.br",
});
await db.exec(byName);
assert.equal(
  (await db.query("select count(*)::int n from social_leads_plans")).rows[0].n,
  1,
);
await assert.rejects(
  db.exec(
    buildSql(await readArtifact(dir), {
      company: "Outra",
      author: "ana@make.com.br",
    }),
  ),
  /Empresa não encontrada/,
);
await db.exec("rollback");
console.log("PASS importação do artefato Social Leads");

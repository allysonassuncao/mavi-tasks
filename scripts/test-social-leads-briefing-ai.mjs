// Social Leads (migration 20261020150000_social_leads_briefing_ai): as
// reuniões do cliente em "Gravações da MAVI" para a IA preencher o briefing,
// só para quem edita, e o custo dessa leitura no registro de uso.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, lorena, outsider] = [1, 12, 13].map(uid);
const [product, squad, client, otherClient, contract] = [
  20, 22, 23, 24, 25,
].map(uid);
const [meeting, silent, foreign] = [60, 61, 62].map(uid);
await db.query("insert into auth.users select unnest($1::uuid[])", [
  [lorena, outsider],
]);
await db.exec(`insert into companies(id,name) values('${A}','Make');
insert into memberships(company_id,user_id,name,role) values('${A}','${lorena}','Lorena Amaral','member'),('${A}','${outsider}','Caio Fora','member');
insert into products(company_id,id,name) values('${A}','${product}','Social Leads');
insert into teams(company_id,id,name) values('${A}','${squad}','Squad');
insert into team_members(company_id,team_id,user_id) values('${A}','${squad}','${lorena}');
insert into clients(company_id,id,name) values('${A}','${client}','Agente Stravitta'),('${A}','${otherClient}','Outro');
insert into client_teams(company_id,client_id,team_id) values('${A}','${client}','${squad}'),('${A}','${otherClient}','${squad}');
insert into contracts(company_id,id,client_id,product_id,name) values('${A}','${contract}','${client}','${product}','Social Leads · Stravitta');
insert into social_leads_settings(company_id,product_id,team_id) values('${A}','${product}','${squad}');
insert into meeting_recordings(id,company_id,client_id,source_id,title,recorded_at,duration_seconds,summary) values
 ('${meeting}','${A}','${client}','bot-1','Onboarding','2026-09-12 14:00+00',1800,'{"topicos":["escola"]}'),
 ('${silent}','${A}','${client}','bot-2','','2026-09-20 14:00+00',600,'{"title":"Alinhamento de campanha","overview":"Ajustes na verba e no público."}'),
 ('${foreign}','${A}','${otherClient}','bot-3','Outro cliente','2026-09-21 14:00+00',600,'{}');
insert into meeting_transcripts(recording_id,company_id,speakers,segments) values
 ('${meeting}','${A}','{Lorena,Renato}','[[0,3,0,"Oi"],[4,8,1,"Somos uma escola de inglês"]]'),
 ('${foreign}','${A}','{X}','[[0,3,0,"Oi"]]');`);

async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [
    user ?? "",
  ]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
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

await check(
  "as reuniões do cliente, da mais nova para a mais antiga",
  async () => {
    await as(lorena);
    const list = (
      await one("select public.social_leads_meetings($1,$2) as r", [
        A,
        contract,
      ])
    ).r;
    assert.deepEqual(
      list.map((m) => [m.title, m.has_transcript]),
      [
        // The title of the recording's AI summary comes first.
        ["Alinhamento de campanha", false],
        ["Onboarding", true],
      ],
    );
    assert.equal(list[0].overview, "Ajustes na verba e no público.");
    assert.deepEqual(list[1].speakers, []);
    await as(outsider);
    await assert.rejects(
      db.query("select public.social_leads_meetings($1,$2)", [A, contract]),
      /Sem permissão/,
    );
  },
);

await check("o texto da reunião, só do cliente do produto", async () => {
  await as(lorena);
  const m = (
    await one("select public.social_leads_meeting_text($1,$2,$3) as r", [
      A,
      contract,
      meeting,
    ])
  ).r;
  assert.equal(m.title, "Onboarding");
  assert.deepEqual(m.speakers, ["Lorena", "Renato"]);
  assert.equal(m.segments[1][3], "Somos uma escola de inglês");
  assert.deepEqual(m.summary, { topicos: ["escola"] });
  await assert.rejects(
    db.query("select public.social_leads_meeting_text($1,$2,$3)", [
      A,
      contract,
      foreign,
    ]),
    /Reunião não encontrada/,
  );
  await assert.rejects(
    db.query("select public.social_leads_meeting_text($1,$2,$3)", [
      A,
      contract,
      silent,
    ]),
    /ainda não tem transcrição/,
  );
  await as(outsider);
  await assert.rejects(
    db.query("select public.social_leads_meeting_text($1,$2,$3)", [
      A,
      contract,
      meeting,
    ]),
    /Sem permissão/,
  );
});

await check("o custo da leitura entra como 'briefing'", async () => {
  await as(lorena);
  await db.query(
    "select public.social_leads_log_usage($1,$2,null,null,'briefing','claude-opus-5',9000,700,0,0,0.0625)",
    [A, contract],
  );
  await assert.rejects(
    db.query(
      "select public.social_leads_log_usage($1,$2,null,null,'outro','m',1,1,0,0,0.01)",
      [A, contract],
    ),
    /social_leads_ai_usage_kind_check/,
  );
  assert.equal(
    (
      await one(
        "select count(*)::int as n from social_leads_ai_usage where kind='briefing'",
      )
    ).n,
    1,
  );
});

console.log(`\n${passed} verificações do briefing pela IA passaram.`);

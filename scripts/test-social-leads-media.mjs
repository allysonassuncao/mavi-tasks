// Social Leads, segunda leva (migration 20261015090000_social_leads_media_usage):
// mídias do briefing lidas do Drive, custo da IA por plano e o aviso do fim
// da geração na caixa de entrada (e no push), sem quebrar os avisos de tarefa.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, lorena, outsider, product, squad, client, contract] = [
  1, 10, 12, 13, 20, 22, 23, 25,
].map(uid);
const [fileOk, filePending, otherFile] = [40, 41, 42].map(uid);
await db.query("insert into auth.users select unnest($1::uuid[])", [
  [admin, lorena, outsider],
]);
await db.exec(`insert into companies(id,name) values('${A}','Make');
insert into memberships(company_id,user_id,name,role) values('${A}','${admin}','Ana Admin','admin'),
 ('${A}','${lorena}','Lorena Amaral','member'),('${A}','${outsider}','Caio Fora','member');
insert into products(company_id,id,name) values('${A}','${product}','Social Leads');
insert into teams(company_id,id,name) values('${A}','${squad}','Squad');
insert into team_members(company_id,team_id,user_id) values('${A}','${squad}','${lorena}');
insert into clients(company_id,id,name) values('${A}','${client}','Agente Stravitta');
insert into client_teams(company_id,client_id,team_id) values('${A}','${client}','${squad}');
insert into contracts(company_id,id,client_id,product_id,name) values('${A}','${contract}','${client}','${product}','Social Leads · Stravitta');
insert into social_leads_settings(company_id,product_id,team_id) values('${A}','${product}','${squad}');
insert into drive_files(id,company_id,name,content_type,size_bytes,path,status,uploaded_by) values
 ('${fileOk}','${A}','depoimento.mp4','video/mp4',1000,'drive/a/1','ready','${lorena}'),
 ('${filePending}','${A}','logo.png','image/png',10,'drive/a/2','pending','${lorena}');
insert into mavi_private.push_config(url, secret) values ('https://app.test/api/push', '${"s".repeat(40)}');
insert into push_subscriptions(endpoint,user_id,p256dh,auth) values ('https://push.test/1','${lorena}','k','a');`);

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
const save = (media, version = null) =>
  one(
    "select public.save_social_leads_briefing($1,$2,$3,'ctwa',$4,$5,$6) as v",
    [
      A,
      contract,
      { clientName: "Agente Stravitta", igHandle: "@a" },
      lorena,
      version,
      media,
    ],
  ).then((r) => r.v);

await check(
  "mídias vêm do Drive, prontas, com nome e tipo do banco",
  async () => {
    await as(lorena);
    const v1 = await save({
      socialProof: [{ id: fileOk, name: "inventado.exe", type: "x" }],
    });
    const b = await one(
      "select media from social_leads_briefings where contract_id=$1",
      [contract],
    );
    assert.deepEqual(b.media, {
      socialProof: [
        { id: fileOk, name: "depoimento.mp4", type: "video/mp4", size: 1000 },
      ],
    });
    await assert.rejects(
      save({ brandLogo: [{ id: filePending }] }, v1),
      /Arquivo não encontrado/,
    );
    await assert.rejects(
      save({ brandLogo: [{ id: otherFile }] }, v1),
      /Arquivo não encontrado/,
    );
    await assert.rejects(
      save({ fotos: [] }, v1),
      /Campo de mídia desconhecido/,
    );
    // Sem p_media, as mídias ficam.
    const v2 = (
      await one(
        "select public.save_social_leads_briefing($1,$2,$3,'ctwa',$4,$5) as v",
        [
          A,
          contract,
          { clientName: "Agente Stravitta", igHandle: "@a" },
          lorena,
          v1,
        ],
      )
    ).v;
    assert.equal(v2, 2);
    const b2 = await one(
      "select media from social_leads_briefings where contract_id=$1",
      [contract],
    );
    assert.equal(b2.media.socialProof.length, 1);
    // Lista vazia remove.
    await save({ socialProof: [] }, v2);
    assert.deepEqual(
      (
        await one(
          "select media from social_leads_briefings where contract_id=$1",
          [contract],
        )
      ).media,
      {},
    );
  },
);

let job, planId;
await check(
  "custo da IA registrado por quem pode gravar, ligado à geração",
  async () => {
    await as(lorena);
    job = (
      await one("select public.social_leads_start_job($1,$2,null,'new') as r", [
        A,
        contract,
      ])
    ).r.job;
    await as(outsider);
    await assert.rejects(
      db.query(
        "select public.social_leads_log_usage($1,$2,null,null,'colors','claude-opus-5',1,1,0,0,0.01)",
        [A, contract],
      ),
      /Sem permissão/,
    );
    await as(lorena);
    await db.query(
      "select public.social_leads_log_usage($1,$2,null,$3,'generate','claude-opus-5',12000,9000,0,3000,0.2892)",
      [A, contract, job],
    );
    await assert.rejects(
      db.query(
        "select public.social_leads_log_usage($1,$2,null,null,'colors','m',1,1,0,0,-1)",
        [A, contract],
      ),
      /Custo inválido/,
    );
  },
);

await check(
  "fim da geração avisa quem pediu, com o custo e o endereço",
  async () => {
    await db.exec("reset role");
    // A plan the job produced (the server writes it before finishing).
    planId = (
      await one(
        `insert into social_leads_plans(company_id,contract_id,month_number,label,content) values($1,$2,1,'Mês 1','{}') returning id`,
        [A, contract],
      )
    ).id;
    await db.query(
      "update social_leads_ai_usage set plan_id=$1 where job_id=$2",
      [planId, job],
    );
    await as(lorena);
    await db.query("select public.social_leads_finish_job($1,$2,null)", [
      job,
      planId,
    ]);
    const inbox = (
      await db.query("select * from public.my_notifications($1)", [A])
    ).rows;
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].kind, "social_leads");
    assert.equal(inbox[0].task_id, null);
    assert.equal(
      inbox[0].task_title,
      "Plano do Mês 1 de Agente Stravitta pronto",
    );
    assert.equal(
      inbox[0].excerpt,
      "Revise os posts e envie para o cliente aprovar. Custo da IA: US$ 0,29.",
    );
    assert.equal(
      inbox[0].link,
      `/onboarding/social-leads?contrato=${contract}`,
    );
    await db.exec("reset role");
    const push = (
      await db.query("select body from net.requests order by id desc limit 1")
    ).rows[0].body;
    assert.equal(
      push.message.title,
      "Plano do Mês 1 de Agente Stravitta pronto",
    );
    assert.equal(
      push.message.url,
      `/onboarding/social-leads?contrato=${contract}`,
    );
    // Uma falha também avisa.
    await as(lorena);
    const j2 = (
      await one("select public.social_leads_start_job($1,$2,null,'new') as r", [
        A,
        contract,
      ])
    ).r.job;
    await db.query(
      "select public.social_leads_finish_job($1,null,'A chave da API foi recusada.')",
      [j2],
    );
    const last = (
      await db.query("select * from public.my_notifications($1)", [A])
    ).rows[0];
    assert.equal(
      last.task_title,
      "A geração do plano de Agente Stravitta falhou",
    );
    assert.equal(last.excerpt, "A chave da API foi recusada.");
    // Só a própria pessoa vê.
    await as(admin);
    assert.equal(
      (await db.query("select * from public.my_notifications($1)", [A])).rows
        .length,
      0,
    );
  },
);

await check("avisos de tarefa continuam iguais", async () => {
  await db.exec("reset role");
  await assert.rejects(
    db.query(
      "insert into notifications(company_id,user_id,kind) values($1,$2,'mention')",
      [A, lorena],
    ),
    /notifications_target_check/,
  );
  await assert.rejects(
    db.query(
      "insert into notifications(company_id,user_id,kind,title) values($1,$2,'social_leads','x')",
      [A, lorena],
    ),
    /notifications_target_check/,
  );
});

await check("o custo por plano é lido por quem vê o cliente", async () => {
  await as(lorena);
  const r = await one(
    "select sum(cost_usd)::float as total from social_leads_ai_usage where plan_id=$1",
    [planId],
  );
  assert.equal(r.total, 0.2892);
  await as(outsider);
  assert.equal(
    (await db.query("select * from social_leads_ai_usage")).rows.length,
    0,
  );
});

console.log(`\n${passed} verificações de mídias, custo e avisos passaram.`);

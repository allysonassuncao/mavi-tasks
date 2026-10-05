// Equipe e configurações › Avisos de falhas (migration 20270406090000_job_alerts):
// as rotinas contam cada execução (gatilhos nas tabelas delas), e a rodada
// avisa quem o admin escolheu: falhou N vezes seguidas, ainda falhando,
// voltou a funcionar e parada há X horas, juntando os itens da rotina.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, admin2, member, gone, otherAdmin] = [
  1, 2, 10, 11, 12, 13, 20,
].map(uid);
const SECRET = "w".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, admin2, member, gone, otherAdmin],
]);
await db.query(
  `insert into companies(id,name) values($1,'Make'),($2,'Outra')`,
  [A, B],
);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Beto Admin','admin',true),($1,$4,'Mel Membro','member',true),
   ($1,$5,'Gil Saiu','admin',false),($6,$7,'Oto Outra','admin',true)`,
  [A, admin, admin2, member, gone, B, otherAdmin],
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
  await db.query(`select set_config('request.jwt.claim.sub','',false)`);
  return (await db.query(text, args)).rows;
};
const run = async () =>
  (await sql(`select mavi_private.job_alerts_run() as n`))[0].n;
const report = (job, ok, error = null, subject = "", label = "") =>
  sql(`select mavi_private.job_report($1,$2,$3,$4,$5,$6)`, [
    A,
    job,
    ok,
    error,
    subject,
    label,
  ]);
const inbox = async (user) =>
  sql(
    `select title, body, link from notifications where kind = 'job_alert' and user_id = $1 order by created_at, id`,
    [user],
  );
const clear = () => sql(`delete from notifications where kind = 'job_alert'`);
const sweep = (error) =>
  sql(`select public.whatsapp_sweep($1, '[]'::jsonb, $2)`, [SECRET, error]);
let passed = 0;
async function check(title, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${title}`);
  } catch (e) {
    console.error(`FAIL ${title}: ${e.message}`);
    console.error(
      e.stack
        ?.split("\n")
        .filter((l) => l.includes("test-job-alerts"))
        .join("\n"),
    );
    process.exit(1);
  }
}

await sql(
  `insert into mavi_private.whatsapp_config(company_id,url,secret) values($1,'https://app.test/api/whatsapp',$2)`,
  [A, SECRET],
);

await check(
  "a varredura falha 3 vezes seguidas e os administradores ativos recebem um aviso",
  async () => {
    await sweep("whatsapp_sweep: canceling statement due to statement timeout");
    await sweep("whatsapp_sweep: canceling statement due to statement timeout");
    assert.equal(await run(), 0, "antes da 3ª falha não avisa");
    await sweep("whatsapp_sweep: canceling statement due to statement timeout");
    assert.equal(await run(), 2);
    const [n] = await inbox(admin);
    assert.equal(n.title, "Falhou: Varredura do WhatsApp");
    assert.equal(
      n.body,
      "3 vezes seguidas. Último erro: whatsapp_sweep: canceling statement due to statement timeout",
    );
    assert.equal(n.link, "/configuracoes#config-whatsapp");
    assert.equal((await inbox(admin2)).length, 1);
    assert.equal((await inbox(member)).length, 0, "membro não é administrador");
    assert.equal((await inbox(gone)).length, 0, "inativo não recebe");
    assert.equal(
      (await inbox(otherAdmin)).length,
      0,
      "outra empresa não recebe",
    );
  },
);

await check(
  "continua falhando: não repete; lembra depois do intervalo",
  async () => {
    await sweep("de novo");
    assert.equal(await run(), 0);
    await sql(
      `update mavi_private.job_failures set reminded_at = now() - interval '25 hours'`,
    );
    assert.equal(await run(), 2);
    const n = (await inbox(admin)).at(-1);
    assert.equal(n.title, "Ainda falhando: Varredura do WhatsApp");
    assert.match(
      n.body,
      /^Desde \d\d\/\d\d às \d\d:\d\d, 4 falhas seguidas\. Último erro: de novo$/,
    );
  },
);

await check("voltou a funcionar: um aviso, e a falha some", async () => {
  await clear();
  await sweep(null);
  assert.equal(await run(), 2);
  const [n] = await inbox(admin);
  assert.equal(n.title, "Voltou a funcionar: Varredura do WhatsApp");
  assert.match(n.body, /^Estava falhando desde /);
  assert.equal(
    (await sql(`select count(*)::int as n from mavi_private.job_failures`))[0]
      .n,
    0,
  );
  assert.equal(await run(), 0);
});

await check(
  "falha que se resolve antes de N não avisa nem deixa rastro",
  async () => {
    await clear();
    await sweep("passageira");
    await sweep(null);
    assert.equal(await run(), 0);
    assert.equal(
      (await sql(`select count(*)::int as n from mavi_private.job_failures`))[0]
        .n,
      0,
    );
  },
);

await check(
  "parada: sem sucesso há mais de X horas avisa uma vez, e avisa quando voltar",
  async () => {
    await sql(
      `update mavi_private.job_status set last_ok_at = now() - interval '7 hours' where job = 'whatsapp_sweep'`,
    );
    assert.equal(await run(), 2);
    const [n] = await inbox(admin);
    assert.equal(n.title, "Parada: Varredura do WhatsApp");
    assert.match(
      n.body,
      /^Nenhuma execução com sucesso há 7 h \(a última foi em \d\d\/\d\d às \d\d:\d\d\)\.$/,
    );
    assert.equal(await run(), 0, "não repete");
    await sql(
      `update mavi_private.job_status set stale_reminded_at = now() - interval '25 hours'`,
    );
    assert.equal(await run(), 2);
    assert.equal(
      (await inbox(admin)).at(-1).title,
      "Ainda parada: Varredura do WhatsApp",
    );
    await clear();
    await sweep(null);
    assert.equal(await run(), 2);
    const [back] = await inbox(admin);
    assert.equal(back.title, "Voltou a funcionar: Varredura do WhatsApp");
    assert.match(back.body, /^Estava parada desde /);
  },
);

await check(
  "itens da mesma rotina vão num aviso só, com o link da campanha quando é uma",
  async () => {
    await clear();
    const c1 = uid(901);
    const c2 = uid(902);
    await report("ads_sync", false, "Token expirado", c1, "Aurora · Leads");
    assert.equal(await run(), 2);
    let [n] = await inbox(admin);
    assert.equal(
      n.title,
      "Falhou: Sincronização diária das campanhas · Aurora · Leads",
    );
    assert.equal(n.body, "Erro: Token expirado");
    assert.equal(n.link, `/campanhas/${c1}`);
    await clear();
    await report("ads_sync", false, "Conta sem acesso", c2, "Boreal · Vendas");
    await report("ads_sync", false, "Cota", uid(903), "Celta · Topo");
    assert.equal(await run(), 2);
    [n] = await inbox(admin);
    assert.equal(
      n.title,
      "Falhou: Sincronização diária das campanhas em 2 campanhas",
    );
    assert.match(n.body, /Boreal · Vendas: Conta sem acesso/);
    assert.match(n.body, /Celta · Topo: Cota/);
    assert.equal(n.link, "/campanhas");
    await clear();
    await report("ads_sync", true, null, c1);
    await report("ads_sync", true, null, c2);
    assert.equal(await run(), 2);
    [n] = await inbox(admin);
    assert.equal(
      n.title,
      "Voltou a funcionar: Sincronização diária das campanhas em 2 campanhas",
    );
    assert.equal(n.body, "Voltaram: Aurora · Leads, Boreal · Vendas.");
  },
);

await check(
  "volta e falha antes da rodada: segue como a mesma falha, sem avisos",
  async () => {
    await clear();
    await report("ads_sync", true, null, uid(903));
    await report("ads_sync", false, "Cota de novo", uid(903), "Celta · Topo");
    assert.equal(await run(), 0);
    const [f] = await sql(
      `select streak, alerted_at is not null as alerted from mavi_private.job_failures where subject = $1`,
      [uid(903)],
    );
    assert.deepEqual(f, { streak: 2, alerted: true });
    await sql(`delete from mavi_private.job_failures`);
  },
);

await check("só administradores leem e salvam a configuração", async () => {
  await as(member);
  await assert.rejects(rpc("job_alerts", [A]), /Só administradores/);
  await assert.rejects(
    rpc("save_job_alert", [A, "ads_sync", { active: false }]),
    /Só administradores/,
  );
  await as(otherAdmin);
  await assert.rejects(rpc("job_alerts", [A]), /Só administradores/);
  await as(admin);
  const jobs = await rpc("job_alerts", [A]);
  assert.equal(jobs[0].job, "whatsapp_sweep");
  assert.equal(jobs.length, 12);
  const w = jobs[0];
  assert.deepEqual(w.settings, {
    active: true,
    fail_after: 3,
    stale_hours: 6,
    notify_recovery: true,
    remind_hours: 24,
    recipients: null,
  });
  assert.equal(w.custom, false);
  assert.equal(w.health.seen, true);
  assert.ok(w.health.last_ok_at);
  assert.equal(w.health.stale, false);
  const make = jobs.find((j) => j.job === "make_leads");
  assert.equal(make.fails, false);
  assert.equal(make.health.seen, false);
});

await check(
  "o admin escolhe quem recebe, N, parada, volta e lembrete",
  async () => {
    await clear();
    await as(admin);
    await assert.rejects(
      rpc("save_job_alert", [A, "ads_sync", { recipients: [gone] }]),
      /pessoas ativas/,
    );
    await assert.rejects(
      rpc("save_job_alert", [A, "ads_sync", { recipients: [] }]),
      /ao menos uma pessoa/,
    );
    await assert.rejects(
      rpc("save_job_alert", [A, "ads_sync", { fail_after: 0 }]),
      /1 a 50/,
    );
    await assert.rejects(
      rpc("save_job_alert", [A, "nada", {}]),
      /desconhecida/,
    );
    const jobs = await rpc("save_job_alert", [
      A,
      "task_recurrences",
      {
        active: true,
        fail_after: 2,
        stale_hours: 5,
        notify_recovery: false,
        remind_hours: null,
        recipients: [member],
      },
    ]);
    const t = jobs.find((j) => j.job === "task_recurrences");
    assert.equal(t.custom, true);
    assert.equal(
      t.settings.stale_hours,
      null,
      "parada não vale para a repetição de tarefas",
    );
    assert.deepEqual(t.settings.recipients, [member]);
    await report(
      "task_recurrences",
      false,
      "Sem responsável",
      uid(700),
      "Relatório semanal",
    );
    assert.equal(await run(), 0);
    await report(
      "task_recurrences",
      false,
      "Sem responsável",
      uid(700),
      "Relatório semanal",
    );
    assert.equal(await run(), 1);
    assert.equal(
      (await inbox(member))[0].title,
      "Falhou: Repetição de tarefas · Relatório semanal",
    );
    assert.equal((await inbox(admin)).length, 0);
    await sql(
      `update mavi_private.job_failures set reminded_at = now() - interval '200 hours'`,
    );
    assert.equal(await run(), 0, "sem lembrete");
    await report("task_recurrences", true, null, uid(700));
    assert.equal(await run(), 0, "sem aviso de volta");
    assert.equal(
      (await sql(`select count(*)::int as n from mavi_private.job_failures`))[0]
        .n,
      0,
    );
  },
);

await check(
  "rotina desligada não avisa; ao ligar, o que ainda falha avisa",
  async () => {
    await clear();
    await as(admin);
    await rpc("save_job_alert", [
      A,
      "radar",
      { active: false, fail_after: 1, remind_hours: 24 },
    ]);
    await report("radar", false, "Modelo fora do ar");
    assert.equal(await run(), 0);
    await as(admin);
    await rpc("save_job_alert", [A, "radar", null]);
    assert.equal(await run(), 0, "o padrão do Radar é 3 falhas");
    await report("radar", false, "Modelo fora do ar");
    await report("radar", false, "Modelo fora do ar");
    assert.equal(await run(), 2);
    assert.equal(
      (await inbox(admin))[0].title,
      "Falhou: Leituras do Radar do cliente",
    );
  },
);

await check("quem desligou o tipo nas preferências não recebe", async () => {
  await clear();
  await as(admin2);
  await rpc("save_notification_prefs", [A, { job_alert: false }]);
  await as(admin);
  assert.equal(await rpc("test_job_alert", [A, "agent_sync"]), 1);
  const [n] = await inbox(admin);
  assert.equal(n.title, "Teste: Leitura do Agente Conversacional (n8n)");
  assert.equal(n.link, "/agente-conversacional");
  assert.equal((await inbox(admin2)).length, 0);
});

await check("os gatilhos das rotinas contam sucesso e falha", async () => {
  await sql(`delete from mavi_private.job_failures`);
  await sql(`delete from mavi_private.job_status`);
  const group = uid(500);
  await sql(
    `insert into whatsapp_groups(id,company_id,jid,title) values($1,$2,'1203@g.us','AUR - Aurora')`,
    [group, A],
  );
  await sql(
    `update whatsapp_groups set sync_error = 'Uazapi 500' where id = $1`,
    [group],
  );
  let [f] = await sql(
    `select job, subject, label, streak, last_error from mavi_private.job_failures`,
  );
  assert.deepEqual(f, {
    job: "whatsapp_groups",
    subject: group,
    label: "AUR - Aurora",
    streak: 1,
    last_error: "Uazapi 500",
  });
  await sql(
    `update whatsapp_groups set sync_error = null, synced_at = now() where id = $1`,
    [group],
  );
  assert.equal(
    (await sql(`select count(*)::int as n from mavi_private.job_failures`))[0]
      .n,
    0,
  );
  const [s] = await sql(
    `select last_ok_at is not null as ok from mavi_private.job_status where job = 'whatsapp_groups'`,
  );
  assert.equal(s.ok, true);
  await sweep("falhou");
  [f] = await sql(`select job, streak from mavi_private.job_failures`);
  assert.deepEqual(f, { job: "whatsapp_sweep", streak: 1 });
  await sweep(null);
  assert.equal(
    (await sql(`select count(*)::int as n from mavi_private.job_failures`))[0]
      .n,
    0,
  );
});

console.log(`${passed} checks passed`);

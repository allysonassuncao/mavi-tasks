// Mural de avisos (migration 20261106090000_notice_board): quem pode avisar
// quem (gestor só no próprio escopo), público por pessoa, equipe, cliente e
// projeto (equipes e/ou responsáveis pelas tarefas abertas) com exclusões,
// público dinâmico (quem entra depois recebe na rotina), agendamento,
// repetição, "avisar de novo", Li e entendi / adiar / fechar a faixa, caixa
// de entrada, push em lotes, tempo real, anexos e o isolamento entre empresas.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, manager, ana, bia, caio, duda, edu, stranger] = [
  1, 2, 10, 11, 12, 13, 14, 15, 16, 17,
].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, manager, ana, bia, caio, duda, edu, stranger],
]);
await db.query(
  `insert into companies(id,name) values($1,'Make'),($2,'Outra')`,
  [A, B],
);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Gabi Gestora','manager',true),
   ($1,$4,'Ana Silva','member',true),($1,$5,'Bia Souza','member',true),
   ($1,$6,'Caio Lima','member',true),($1,$7,'Duda Reis','member',true),
   ($1,$8,'Edu Inativo','member',false),($9,$10,'Zé Outra','admin',true)`,
  [A, admin, manager, ana, bia, caio, duda, edu, B, stranger],
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
const rows = async (name, args) =>
  (
    await db.query(
      `select * from public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})`,
      args,
    )
  ).rows;
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
async function rejects(fn, pattern) {
  await assert.rejects(fn, pattern);
}
const receivers = async (notice) =>
  (
    await sql(
      `select user_id from notice_receipts where notice_id=$1 order by user_id`,
      [notice],
    )
  ).map((r) => r.user_id);
const content = (extra = {}) => ({
  title: "Não teremos expediente na sexta",
  body: "Feriado municipal. Voltamos na segunda.",
  level: "important",
  inbox: true,
  push: false,
  popup: false,
  banner: true,
  targets: [{ kind: "everyone" }],
  ...extra,
});
const save = async (who, notice, c, publish = true, renotify = false) => {
  await as(who);
  return rpc("save_notice", [A, notice, c, publish, renotify, null]);
};

// Equipe Criação (Ana, Bia e a gestora) atende o Cliente Sorriso; a Equipe
// Mídia (Caio) atende o Cliente Luz. A Duda não está em equipe nenhuma, mas é
// responsável por uma tarefa aberta do Sorriso.
await as(admin);
const criacao = await rpc("create_team", [A, "Criação", [ana, bia, manager]]);
const midia = await rpc("create_team", [A, "Mídia", [caio]]);
const sorriso = await rpc("create_client", [
  A,
  "Clínica Sorriso",
  "",
  [criacao],
]);
const luz = await rpc("create_client", [A, "Ótica Luz", "", [midia]]);
const product = await rpc("create_product", [A, "Social Leads"]);
const kSorriso = await rpc("create_contract", [
  A,
  sorriso,
  product,
  "Sorriso · Social Leads",
]);
const kLuz = await rpc("create_contract", [
  A,
  luz,
  product,
  "Luz · Social Leads",
]);
const pSorriso = await rpc("create_project", [
  A,
  kSorriso,
  "Lançamento de verão",
]);
const pLuz = await rpc("create_project", [A, kLuz, "Coleção nova"]);
const task = async (contract, project, assignee, status = "progress") =>
  (
    await sql(
      `insert into tasks(company_id,contract_id,project_id,title,creator_id,assignee_id,due_date,original_due_date,status,
        internal_approved_by)
       values($1,$2,$3,'Tarefa',$4,$5,'2099-01-01','2099-01-01',$6,case when $6='done' then $4::uuid end) returning id`,
      [A, contract, project, admin, assignee, status],
    )
  )[0].id;
await task(kSorriso, pSorriso, duda);
// Tarefa entregue não conta: o Caio não é "responsável por tarefa aberta" do Sorriso.
await task(kSorriso, null, caio, "done");
await sql(
  `insert into mavi_private.push_config(url, secret) values('https://app.example/api/push', $1)`,
  [SECRET],
);
await sql(
  `insert into push_subscriptions(endpoint,user_id,p256dh,auth)
   select 'https://push.example/' || u || '/' || g, u, 'k', 'a' from unnest($1::uuid[]) u, generate_series(1, 30) g`,
  [[ana, bia, caio]],
);

let everyone;
await check(
  "o administrador avisa todos: cada pessoa ativa recebe, menos quem criou",
  async () => {
    await sql(`delete from realtime.messages`);
    await sql(`delete from net.requests`);
    const r = await save(admin, null, content({ push: true }));
    assert.equal(r.status, "live");
    everyone = r.id;
    assert.deepEqual(
      await receivers(everyone),
      [manager, ana, bia, caio, duda].sort(),
    );
  },
);

await check(
  "a caixa de entrada ganha o aviso, sem um broadcast nem um push por pessoa",
  async () => {
    const inbox = await sql(
      `select user_id, kind, title, link, body from notifications where notice_id=$1`,
      [everyone],
    );
    assert.equal(inbox.length, 5);
    assert.ok(
      inbox.every(
        (n) => n.kind === "notice" && n.link === `/mural?aviso=${everyone}`,
      ),
    );
    assert.match(inbox[0].body, /Feriado municipal/);
    const personal = await sql(
      `select * from realtime.messages where topic like 'mavi:inbox:%'`,
    );
    assert.equal(personal.length, 0);
    const [live] = await sql(
      `select topic, payload from realtime.messages where payload->>'kind' = 'notice'`,
    );
    assert.equal(live.topic, `mavi:company:${A}`);
    assert.equal(live.payload.notice, everyone);
    assert.equal(live.payload.users.length, 5);
    // 90 navegadores (30 de cada uma de 3 pessoas): 2 lotes de até 50.
    const pushes = await sql(`select body from net.requests order by id`);
    assert.equal(pushes.length, 2);
    assert.deepEqual(
      pushes.map((p) => p.body.subscriptions.length).sort(),
      [40, 50],
    );
    assert.equal(
      pushes[0].body.message.title,
      "Importante: Não teremos expediente na sexta",
    );
    assert.equal(pushes[0].body.message.url, `/mural?aviso=${everyone}`);
    await as(ana);
    const mine = await rows("my_notifications", [A, 30]);
    assert.equal(mine[0].kind, "notice");
    assert.equal(mine[0].task_title, "Não teremos expediente na sexta");
  },
);

await check(
  "quem recebeu vê no ar e no Mural; quem criou vê nos enviados",
  async () => {
    await as(ana);
    const live = await rows("my_live_notices", [A]);
    assert.equal(live.length, 1);
    assert.equal(live[0].banner, true);
    assert.equal(live[0].author_name, "Ana Admin");
    assert.equal((await rows("my_notice_feed", [A, "", 20, 0])).length, 1);
    assert.equal(
      (await rows("my_notice_feed", [A, "expediente sexta", 20, 0])).length,
      1,
    );
    assert.equal(
      (await rows("my_notice_feed", [A, "EXPEDIENTE natal", 20, 0])).length,
      0,
    );
    assert.equal(
      (await rows("my_notice_feed", [A, "expedIente FERIÁDO municipal", 20, 0]))
        .length,
      1,
    );
    assert.equal((await rows("sent_notices", [A, "", 20, 0])).length, 0);
    await as(admin);
    const [sent] = await rows("sent_notices", [A, "", 20, 0]);
    assert.equal(sent.delivered, 5);
    assert.equal(sent.seen, 0);
    assert.equal((await rows("my_live_notices", [A])).length, 0);
    await as(stranger);
    assert.equal(await rpc("notice_detail", [everyone]), null);
    await rejects(
      () => rpc("mark_notice", [everyone, "seen"]),
      /não encontrado/,
    );
  },
);

await check("colaboradores não criam avisos", async () => {
  await rejects(() => save(ana, null, content()), /administradores e gestores/);
});

await check("o gestor só avisa dentro do escopo das equipes dele", async () => {
  await rejects(() => save(manager, null, content()), /não pode avisar/);
  await rejects(
    () =>
      save(manager, null, content({ targets: [{ kind: "team", id: midia }] })),
    /não pode avisar/,
  );
  await rejects(
    () =>
      save(
        manager,
        null,
        content({ targets: [{ kind: "client", id: luz, mode: "both" }] }),
      ),
    /não pode avisar/,
  );
  await rejects(
    () =>
      save(
        manager,
        null,
        content({ targets: [{ kind: "project", id: pLuz, mode: "teams" }] }),
      ),
    /não pode avisar/,
  );
  await rejects(
    () =>
      save(manager, null, content({ targets: [{ kind: "user", id: caio }] })),
    /não pode avisar/,
  );
  const ok = await save(
    manager,
    null,
    content({
      targets: [
        { kind: "team", id: criacao },
        { kind: "user", id: ana },
      ],
    }),
  );
  assert.deepEqual(await receivers(ok.id), [ana, bia].sort());
  // O administrador edita qualquer aviso; o gestor, só os dele.
  await rejects(() => save(manager, everyone, content()), /Sem permissão/);
});

await check(
  "cliente e projeto: equipes, responsáveis por tarefas abertas ou os dois",
  async () => {
    const teams = await save(
      admin,
      null,
      content({ targets: [{ kind: "client", id: sorriso, mode: "teams" }] }),
    );
    assert.deepEqual(await receivers(teams.id), [manager, ana, bia].sort());
    const assignees = await save(
      admin,
      null,
      content({
        targets: [{ kind: "client", id: sorriso, mode: "assignees" }],
      }),
    );
    assert.deepEqual(await receivers(assignees.id), [duda]);
    const both = await save(
      admin,
      null,
      content({ targets: [{ kind: "project", id: pSorriso, mode: "both" }] }),
    );
    assert.deepEqual(
      await receivers(both.id),
      [manager, ana, bia, duda].sort(),
    );
    const projectAssignees = await save(
      admin,
      null,
      content({ targets: [{ kind: "project", id: pLuz, mode: "assignees" }] }),
    );
    assert.deepEqual(await receivers(projectAssignees.id), []);
  },
);

let material;
await check("exclusões tiram pessoas do público somado", async () => {
  const r = await save(
    admin,
    null,
    content({
      title: "O Sorriso precisa do material da campanha",
      targets: [
        { kind: "team", id: criacao },
        { kind: "team", id: midia },
      ],
      exclude: [bia],
    }),
  );
  material = r.id;
  assert.deepEqual(await receivers(material), [manager, ana, caio].sort());
});

await check(
  "público dinâmico: quem entra na equipe depois recebe na rotina, uma vez só",
  async () => {
    await sql(`delete from net.requests`);
    await as(admin);
    await rpc("update_team", [midia, "Mídia", [caio, duda], []]);
    await sql(`select mavi_private.run_notices()`);
    assert.deepEqual(
      await receivers(material),
      [manager, ana, caio, duda].sort(),
    );
    assert.equal(
      (
        await sql(
          `select count(*)::int as n from notifications where notice_id=$1 and user_id=$2`,
          [material, duda],
        )
      )[0].n,
      1,
    );
    await sql(`select mavi_private.run_notices()`);
    assert.equal(
      (
        await sql(
          `select count(*)::int as n from notifications where notice_id=$1 and user_id=$2`,
          [material, duda],
        )
      )[0].n,
      1,
    );
  },
);

await check(
  "editar o público tira quem saiu, sem avisar de novo quem já viu",
  async () => {
    await as(ana);
    await rpc("mark_notice", [material, "seen"]);
    const detail = await rpc("notice_detail", [material]);
    assert.equal(detail.can_edit, false);
    assert.equal(detail.targets, null);
    await save(
      admin,
      material,
      content({
        title: "O Sorriso precisa do material Y",
        targets: [{ kind: "team", id: criacao }],
        exclude: [bia],
      }),
    );
    assert.deepEqual(await receivers(material), [manager, ana].sort());
    assert.equal(
      (
        await sql(
          `select count(*)::int as n from notifications where notice_id=$1`,
          [material],
        )
      )[0].n,
      2,
    );
    const [seen] = await sql(
      `select seen_at from notice_receipts where notice_id=$1 and user_id=$2`,
      [material, ana],
    );
    assert.ok(seen.seen_at);
    const [n] = await sql(
      `select title from notifications where notice_id=$1 and user_id=$2`,
      [material, ana],
    );
    assert.equal(n.title, "O Sorriso precisa do material Y");
  },
);

await check(
  "avisar de novo: rodada nova, volta como não visto e ao topo da caixa",
  async () => {
    await sql(`update notifications set read_at = now() where notice_id=$1`, [
      material,
    ]);
    await save(
      admin,
      material,
      content({
        title: "O Sorriso precisa do material Y",
        targets: [{ kind: "team", id: criacao }],
        exclude: [bia],
      }),
      true,
      true,
    );
    const [r] = await sql(
      `select round, seen_at from notice_receipts where notice_id=$1 and user_id=$2`,
      [material, ana],
    );
    assert.equal(r.round, 2);
    assert.equal(r.seen_at, null);
    const [n] = await sql(
      `select read_at from notifications where notice_id=$1 and user_id=$2`,
      [material, ana],
    );
    assert.equal(n.read_at, null);
  },
);

let critical;
await check("Li e entendi, lembrar amanhã e fechar a faixa", async () => {
  const r = await save(
    admin,
    null,
    content({
      title: "Nova política de férias",
      level: "critical",
      popup: true,
      require_ack: true,
    }),
  );
  critical = r.id;
  await as(bia);
  let [live] = (await rows("my_live_notices", [A])).filter(
    (x) => x.id === critical,
  );
  assert.equal(live.level, "critical");
  assert.equal((await rows("my_live_notices", [A]))[0].id, critical);
  await rpc("mark_notice", [critical, "snooze"]);
  [live] = (await rows("my_live_notices", [A])).filter(
    (x) => x.id === critical,
  );
  assert.ok(new Date(live.snoozed_until) > new Date());
  assert.ok(live.seen_at);
  assert.equal(live.acked_at, null);
  await rpc("mark_notice", [critical, "ack"]);
  await rpc("mark_notice", [critical, "close_banner"]);
  [live] = (await rows("my_live_notices", [A])).filter(
    (x) => x.id === critical,
  );
  assert.ok(live.acked_at && live.banner_closed_at);
  const [n] = await sql(
    `select read_at from notifications where notice_id=$1 and user_id=$2`,
    [critical, bia],
  );
  assert.ok(n.read_at);
  await rejects(
    () => rpc("mark_notice", [everyone, "ack"]),
    /não pede confirmação/,
  );
  await rejects(
    () => rpc("mark_notice", [critical, "delete"]),
    /Ação inválida/,
  );
  await as(admin);
  const [sent] = await rows("sent_notices", [A, "férias", 20, 0]);
  assert.equal(sent.acked, 1);
});

await check(
  "agendado: ninguém recebe antes; a rotina publica na hora",
  async () => {
    const later = new Date(Date.now() + 3600e3).toISOString();
    const r = await save(
      admin,
      null,
      content({
        title: "Treinamento amanhã",
        publish_at: later,
        targets: [{ kind: "user", id: caio }],
      }),
    );
    assert.equal(r.status, "scheduled");
    await sql(`select mavi_private.run_notices()`);
    assert.deepEqual(await receivers(r.id), []);
    await sql(
      `update notices set publish_at = now() - interval '1 minute' where id=$1`,
      [r.id],
    );
    await sql(`select mavi_private.run_notices()`);
    assert.deepEqual(await receivers(r.id), [caio]);
  },
);

await check("rascunho não entrega e não pode repetir", async () => {
  const r = await save(
    admin,
    null,
    content({ title: "Rascunho", repeat: "daily" }),
    false,
  );
  assert.equal(r.status, "draft");
  const [n] = await sql(`select publish_at, repeat from notices where id=$1`, [
    r.id,
  ]);
  assert.equal(n.publish_at, null);
  assert.equal(n.repeat, null);
  await sql(`select mavi_private.run_notices()`);
  assert.deepEqual(await receivers(r.id), []);
  await as(ana);
  assert.equal(await rpc("notice_detail", [r.id]), null);
});

await check(
  "repetição: cada vez é uma rodada nova, no horário da publicação",
  async () => {
    const r = await save(
      admin,
      null,
      content({
        title: "Reunião semanal",
        repeat: "weekly",
        targets: [{ kind: "user", id: ana }],
      }),
    );
    const [before] = await sql(
      `select next_repeat, publish_at from notices where id=$1`,
      [r.id],
    );
    const gap = new Date(before.next_repeat) - new Date(before.publish_at);
    assert.ok(
      Math.abs(gap - 7 * 86400e3) < 3600e3 * 2,
      `próxima em ${gap / 3600e3} h`,
    );
    await as(ana);
    await rpc("mark_notice", [r.id, "seen"]);
    await sql(
      `update notices set next_repeat = now() - interval '1 minute' where id=$1`,
      [r.id],
    );
    await sql(`select mavi_private.run_notices()`);
    const [rec] = await sql(
      `select round, seen_at from notice_receipts where notice_id=$1`,
      [r.id],
    );
    assert.equal(rec.round, 2);
    assert.equal(rec.seen_at, null);
    const [after] = await sql(`select next_repeat from notices where id=$1`, [
      r.id,
    ]);
    assert.ok(new Date(after.next_repeat) > new Date());
  },
);

await check("sai do ar na data e ao encerrar", async () => {
  await rejects(
    () =>
      save(
        admin,
        null,
        content({ expires_at: new Date(Date.now() - 60e3).toISOString() }),
      ),
    /depois da publicação/,
  );
  const r = await save(
    admin,
    null,
    content({
      title: "Some logo",
      expires_at: new Date(Date.now() + 60e3).toISOString(),
    }),
  );
  await sql(
    `update notices set expires_at = now() - interval '1 second', publish_at = now() - interval '1 hour' where id=$1`,
    [r.id],
  );
  await as(ana);
  assert.ok(!(await rows("my_live_notices", [A])).some((x) => x.id === r.id));
  assert.equal(
    (await rows("my_notice_feed", [A, "some logo", 20, 0]))[0].status,
    "ended",
  );
  await as(admin);
  await rpc("end_notice", [critical]);
  await as(bia);
  assert.ok(
    !(await rows("my_live_notices", [A])).some((x) => x.id === critical),
  );
  await rejects(() => save(admin, critical, content()), /encerrado/);
});

await check("anexos: envio, arquivo do Drive e quem pode abrir", async () => {
  await as(admin);
  const att = await rpc("prepare_notice_attachment", [
    material,
    "briefing.pdf",
    2048,
    "application/pdf",
  ]);
  const [target] = await rows("notice_upload_target", [att]);
  assert.equal(target.path, `notices/${A}/${material}/${att}`);
  await rpc("confirm_notice_attachment", [att]);
  const [file] = await sql(
    `insert into drive_files(company_id,name,content_type,size_bytes,path,status,uploaded_by,client_id)
     values($1,'logo.png','image/png',100,'drive/logo','ready',$2,$3) returning id`,
    [A, admin, sorriso],
  );
  const driveAtt = await rpc("add_notice_drive_file", [material, file.id]);
  assert.equal((await rpc("notice_detail", [material])).attachments.length, 2);
  // A Ana recebeu o aviso: abre os dois; o Caio (fora do público) e a outra empresa, nenhum.
  await as(ana);
  const mine = await rows("notice_attachment_targets", [[att, driveAtt]]);
  assert.deepEqual(
    mine.map((m) => m.path).sort(),
    ["drive/logo", `notices/${A}/${material}/${att}`].sort(),
  );
  await as(caio);
  assert.equal(
    (await rows("notice_attachment_targets", [[att, driveAtt]])).length,
    0,
  );
  await rejects(
    () =>
      rpc("prepare_notice_attachment", [
        material,
        "x.pdf",
        10,
        "application/pdf",
      ]),
    /Sem permissão/,
  );
  await as(stranger);
  assert.equal(
    (await rows("notice_attachment_targets", [[att, driveAtt]])).length,
    0,
  );
  // Tirar um anexo do Drive não apaga o arquivo do Drive.
  await as(admin);
  assert.equal(await rpc("delete_notice_attachment", [driveAtt]), null);
  const paths = await rpc("delete_notice", [material]);
  assert.deepEqual(paths, [`notices/${A}/${material}/${att}`]);
  assert.equal(
    (
      await sql(
        `select count(*)::int as n from notifications where notice_id=$1`,
        [material],
      )
    )[0].n,
    0,
  );
  assert.equal(
    (
      await sql(`select count(*)::int as n from drive_files where id=$1`, [
        file.id,
      ])
    )[0].n,
    1,
  );
});

await check("outra empresa não usa pessoas nem avisos daqui", async () => {
  await as(stranger);
  await rejects(
    () => rpc("save_notice", [A, null, content(), true, false, null]),
    /administradores e gestores/,
  );
  await rejects(
    () =>
      rpc("save_notice", [
        B,
        null,
        content({ targets: [{ kind: "user", id: ana }] }),
        true,
        false,
        null,
      ]),
    /não pode avisar/,
  );
  assert.equal((await rows("my_live_notices", [A])).length, 0);
  assert.equal((await rows("sent_notices", [A, "", 20, 0])).length, 0);
});

// ------------------------------------------------------------ fase 2
// (migration 20261107090000_notice_board_insights)
let policy;
await check(
  "quem recebeu: só quem edita vê a lista, com equipes e pendentes primeiro",
  async () => {
    const r = await save(
      admin,
      null,
      content({
        title: "Política de home office",
        level: "critical",
        popup: true,
        require_ack: true,
        push: true,
        targets: [{ kind: "team", id: criacao }],
      }),
    );
    policy = r.id;
    await as(ana);
    await rpc("mark_notice", [policy, "ack"]);
    await as(bia);
    await rpc("mark_notice", [policy, "snooze"]);
    await as(admin);
    const people = await rows("notice_people", [policy]);
    assert.deepEqual(
      people.map((p) => p.name),
      ["Bia Souza", "Gabi Gestora", "Ana Silva"],
    );
    assert.equal(people.find((p) => p.user_id === ana).teams, "Criação");
    assert.ok(people.find((p) => p.user_id === ana).acked_at);
    await as(manager);
    assert.equal((await rows("notice_people", [policy])).length, 0);
  },
);

await check(
  "cobrar pendentes: reenvia só a quem falta, pelos mesmos formatos, uma vez por hora",
  async () => {
    await sql(`delete from realtime.messages`);
    await sql(`delete from net.requests`);
    await sql(`update notifications set read_at = now() where notice_id=$1`, [
      policy,
    ]);
    await as(admin);
    assert.equal(await rpc("remind_notice", [policy]), 2);
    const [bias] = await sql(
      `select snoozed_until, reminders, seen_at from notice_receipts where notice_id=$1 and user_id=$2`,
      [policy, bia],
    );
    assert.equal(bias.snoozed_until, null);
    assert.equal(bias.reminders, 1);
    // O visto continua: o tempo até ver mede a entrega, não a cobrança.
    assert.ok(bias.seen_at);
    const inbox = await sql(
      `select user_id, title, read_at from notifications where notice_id=$1 order by user_id`,
      [policy],
    );
    assert.deepEqual(
      inbox
        .filter((n) => !n.read_at)
        .map((n) => n.user_id)
        .sort(),
      [manager, bia].sort(),
    );
    assert.match(inbox.find((n) => n.user_id === bia).title, /^Lembrete: /);
    const [push] = await sql(`select body from net.requests`);
    assert.match(push.body.message.title, /Lembrete: Política de home office/);
    const [live] = await sql(
      `select payload from realtime.messages where payload->>'kind' = 'notice'`,
    );
    assert.deepEqual(live.payload.users.sort(), [manager, bia].sort());
    await rejects(() => rpc("remind_notice", [policy]), /menos de uma hora/);
    await as(bia);
    assert.ok(
      (await rows("my_live_notices", [A])).find((n) => n.id === policy)
        .reminded_at,
    );
    await rejects(() => rpc("remind_notice", [policy]), /Sem permissão/);
  },
);

await check(
  "modelos: de todos os líderes; altera quem criou ou um administrador",
  async () => {
    await as(manager);
    const id = await rpc("save_notice_template", [
      A,
      null,
      "Novidades da semana",
      {
        title: "Novidades da semana",
        level: "info",
        inbox: true,
        targets: [{ kind: "team", id: criacao }],
        hack: "x",
      },
    ]);
    await as(admin);
    const [t] = await rows("notice_templates", [A]);
    assert.equal(t.name, "Novidades da semana");
    assert.equal(t.author_name, "Gabi Gestora");
    assert.equal(t.content.hack, undefined);
    assert.equal(t.can_edit, true);
    await rpc("save_notice_template", [
      A,
      id,
      "Novidades da semana (TI)",
      t.content,
    ]);
    await as(ana);
    assert.equal((await rows("notice_templates", [A])).length, 0);
    await rejects(
      () => rpc("save_notice_template", [A, null, "Meu", {}]),
      /administradores e gestores/,
    );
    await as(manager);
    await sql(
      `insert into memberships(company_id,user_id,name,role,active) values($1,$2,'Outro Gestor','manager',true)`,
      [A, stranger],
    );
    await as(stranger);
    assert.equal((await rows("notice_templates", [A]))[0].can_edit, false);
    await rejects(() => rpc("delete_notice_template", [id]), /Só quem criou/);
    await as(manager);
    await rpc("delete_notice_template", [id]);
    assert.equal((await rows("notice_templates", [A])).length, 0);
    await sql(`delete from memberships where company_id=$1 and user_id=$2`, [
      A,
      stranger,
    ]);
  },
);

await check(
  "a MAVI na escrita tem provedor próprio no Painel da MAVI",
  async () => {
    const [c] = await sql(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'ai_routes_feature_check'`,
    );
    assert.match(c.def, /notice_writer/);
  },
);

const range = ["2020-01-01", "2030-01-01"];
const byKey = (list) => Object.fromEntries(list.map((r) => [r.k, Number(r.v)]));
const preview = async (spec, filters = {}) => {
  await as(admin);
  return rpc("dashboard_preview", [A, spec, ...range, filters]);
};
const nq = (ref, metric, extra = {}) => ({
  ref,
  source: "notices",
  metric,
  filters: [],
  ...extra,
});

await check(
  "Dashboards · Avisos: entregas, vistos, pendentes e confirmações por pessoa",
  async () => {
    const res = await preview({
      viz: "table",
      groupBy: "person",
      queries: [
        nq("A", "delivered"),
        nq("B", "seen"),
        nq("C", "pending"),
        nq("D", "acked"),
        nq("E", "ack_rate"),
      ],
      formula: { expr: "" },
    });
    const delivered = await sql(
      `select user_id, count(*)::int as n from notice_receipts group by 1`,
    );
    assert.deepEqual(
      byKey(res.series.A),
      Object.fromEntries(delivered.map((d) => [d.user_id, d.n])),
    );
    assert.equal(byKey(res.series.D)[ana], 1);
    assert.equal(res.series.A.find((r) => r.k === ana).l, "Ana Silva");
    const pendingBia = (
      await sql(
        `select count(*)::int as n from notice_receipts r join notices n on n.id = r.notice_id
     where r.user_id=$1 and (r.seen_at is null or (n.require_ack and r.acked_at is null))`,
        [bia],
      )
    )[0].n;
    assert.equal(byKey(res.series.C)[bia], pendingBia);
  },
);

await check(
  "Dashboards · Avisos: por aviso, nível, equipe e autor; filtros de cliente não quebram",
  async () => {
    const byNotice = await preview({
      viz: "table",
      groupBy: "notice",
      queries: [nq("A", "seen_rate")],
    });
    assert.ok(byNotice.series.A.some((r) => r.l === "Política de home office"));
    const byLevel = await preview({
      viz: "bar",
      groupBy: "level",
      queries: [nq("A", "notices")],
    });
    assert.ok(byLevel.series.A.some((r) => r.l === "Crítico"));
    const byTeam = await preview({
      viz: "bar",
      groupBy: "team",
      queries: [nq("A", "delivered")],
    });
    assert.ok(byTeam.series.A.some((r) => r.l === "Criação"));
    const critical = await preview({
      viz: "stat",
      groupBy: "none",
      queries: [
        nq("A", "notices", {
          filters: [{ field: "level", op: "in", values: ["critical"] }],
        }),
      ],
    });
    assert.ok(Number(critical.series.A[0].v) >= 1);
    const hours = await preview({
      viz: "stat",
      groupBy: "none",
      queries: [nq("A", "hours_to_see")],
    });
    assert.ok(Number(hours.series.A[0].v) >= 0);
    const withClient = await preview(
      { viz: "stat", groupBy: "none", queries: [nq("A", "delivered")] },
      { clients: [sorriso], teams: [criacao] },
    );
    assert.ok(Number(withClient.series.A[0].v) > 0);
    await rejects(
      () =>
        preview({
          viz: "bar",
          groupBy: "client",
          queries: [nq("A", "delivered")],
        }),
      /Agrupamento inválido/,
    );
  },
);

// ------------------------------------------------------------ fase 3
// (migration 20261108090000_notice_animation)
const [claude, gpt] = (
  await sql(
    `insert into mavi_private.ai_providers(company_id,name,kind,key_cipher,models) values
     ($1,'Claude da Make','anthropic','v1:x','[{"id":"claude-sonnet-5","input":2,"output":10}]'),
     ($1,'OpenAI','openai','v1:y','[{"id":"gpt-5.6-luna","input":1,"output":8}]') returning id`,
    [A],
  )
).map((r) => r.id);
let launch, shot;
await check(
  "animação: o administrador libera modelos para todos ou para uma equipe",
  async () => {
    await as(manager);
    await rejects(
      () => rpc("set_notice_animation_admin", [A, true, []]),
      /Só administradores/,
    );
    await as(admin);
    await rejects(
      () =>
        rpc("set_notice_animation_admin", [
          A,
          true,
          [{ provider_id: claude, model: "inexistente" }],
        ]),
      /modelo cadastrado/,
    );
    await rpc("set_notice_animation_admin", [
      A,
      false,
      [
        { provider_id: claude, model: "claude-sonnet-5" },
        { provider_id: gpt, model: "gpt-5.6-luna", team_ids: [midia] },
      ],
    ]);
    const cfg = await rpc("notice_animation_admin", [A]);
    assert.equal(cfg.models.length, 2);
    assert.equal(cfg.knowledge, false);
    await as(manager);
    const opts = await rpc("notice_animation_options", [A]);
    assert.deepEqual(
      opts.models.map((m) => m.model),
      ["claude-sonnet-5"],
    );
    assert.equal(opts.models[0].price.output, 10);
    assert.equal(opts.can_manage, false);
    await as(ana);
    await rejects(
      () => rpc("notice_animation_options", [A]),
      /Somente administradores e gestores/,
    );
  },
);

await check(
  "animação: gerar confere modelo, prints e base de conhecimento; uma de cada vez",
  async () => {
    const r = await save(
      admin,
      null,
      content({
        title: "Nova funcionalidade: Mural",
        targets: [{ kind: "team", id: criacao }],
      }),
    );
    launch = r.id;
    await as(admin);
    shot = await rpc("prepare_notice_attachment", [
      launch,
      "tela.png",
      2048,
      "image/png",
    ]);
    await rpc("confirm_notice_attachment", [shot]);
    const pdf = await rpc("prepare_notice_attachment", [
      launch,
      "manual.pdf",
      2048,
      "application/pdf",
    ]);
    await rpc("confirm_notice_attachment", [pdf]);
    await as(manager);
    await rejects(
      () =>
        rpc("start_notice_animation", [
          launch,
          "Mostre como criar um aviso",
          claude,
          "claude-sonnet-5",
          [],
          false,
          null,
        ]),
      /Sem permissão/,
    );
    await as(admin);
    await rejects(
      () =>
        rpc("start_notice_animation", [
          launch,
          "x",
          null,
          null,
          [],
          false,
          null,
        ]),
      /Conte para a MAVI/,
    );
    await sql(`delete from realtime.messages`);
    const started = await rpc("start_notice_animation", [
      launch,
      "Mostre como criar um aviso",
      claude,
      "claude-sonnet-5",
      [shot, pdf],
      true,
      null,
    ]);
    assert.equal(started.version, 1);
    assert.equal(started.route.model, "claude-sonnet-5");
    assert.equal(started.route.key_cipher, "v1:x");
    assert.deepEqual(
      started.refs.map((x) => x.id),
      [shot],
    );
    assert.equal(started.refs[0].path, `notices/${A}/${launch}/${shot}`);
    // A base de conhecimento está desligada pelo administrador.
    assert.equal(started.knowledge, false);
    assert.equal(started.notice.title, "Nova funcionalidade: Mural");
    await rejects(
      () =>
        rpc("start_notice_animation", [
          launch,
          "De novo",
          null,
          null,
          [],
          false,
          null,
        ]),
      /já está criando/,
    );
    await rejects(
      () =>
        rpc("start_notice_animation", [
          launch,
          "Outro modelo",
          gpt,
          "gpt-5.6-luna",
          [],
          false,
          null,
        ]),
      /já está criando|não está liberado/,
    );
    const spec = {
      version: 1,
      theme: "light",
      scenes: [
        { layout: "title", duration: 3, heading: "Mural", transition: "fade" },
      ],
    };
    await as(manager);
    await rejects(
      () => rpc("finish_notice_animation", [started.id, spec, null, 0.02]),
      /não encontrada/,
    );
    await as(admin);
    await rpc("finish_notice_animation", [started.id, spec, null, 0.02]);
    const [n] = await sql(`select animation_id from notices where id=$1`, [
      launch,
    ]);
    assert.equal(n.animation_id, started.id);
    const [inbox] = await sql(
      `select title, link, body from notifications where kind='notice_animation' and user_id=$1`,
      [admin],
    );
    assert.equal(inbox.title, "Animação pronta: Nova funcionalidade: Mural");
    assert.equal(inbox.link, `/mural?aviso=${launch}&animacao=1`);
    assert.match(inbox.body, /US\$ 0,02/);
  },
);

await check(
  "animação: quem recebe vê a versão escolhida; ajustes e edições são versões novas",
  async () => {
    await as(ana);
    const [live] = (await rows("my_live_notices", [A])).filter(
      (x) => x.id === launch,
    );
    assert.equal(live.animation.scenes[0].heading, "Mural");
    assert.equal(
      (await rpc("notice_detail", [launch])).animation.scenes.length,
      1,
    );
    assert.equal((await rows("notice_animations", [launch])).length, 0);
    await rejects(
      () => rpc("save_notice_animation", [launch, { scenes: [] }, null]),
      /Sem permissão/,
    );
    await as(admin);
    const [v1] = await rows("notice_animations", [launch]);
    // Ajuste: a versão 2 fica pronta, mas o aviso no ar continua na 1 até escolherem.
    const adj = await rpc("start_notice_animation", [
      launch,
      "Mais curta",
      null,
      null,
      [],
      false,
      v1.id,
    ]);
    assert.equal(adj.base.scenes[0].heading, "Mural");
    assert.equal(adj.route, null);
    await rpc("finish_notice_animation", [
      adj.id,
      {
        version: 1,
        theme: "dark",
        scenes: [
          {
            layout: "title",
            duration: 2,
            heading: "Mural novo",
            transition: "zoom",
          },
        ],
      },
      null,
      0.01,
    ]);
    assert.equal(
      (await sql(`select animation_id from notices where id=$1`, [launch]))[0]
        .animation_id,
      v1.id,
    );
    await sql(`delete from realtime.messages`);
    await rpc("use_notice_animation", [launch, adj.id]);
    assert.equal(
      (await sql(`select animation_id from notices where id=$1`, [launch]))[0]
        .animation_id,
      adj.id,
    );
    const [msg] = await sql(
      `select payload from realtime.messages where payload->>'kind' = 'notice'`,
    );
    assert.equal(msg.payload.users, null);
    const manual = await rpc("save_notice_animation", [
      launch,
      {
        version: 1,
        theme: "dark",
        scenes: [
          {
            layout: "title",
            duration: 2,
            heading: "Editado à mão",
            transition: "zoom",
          },
        ],
      },
      adj.id,
    ]);
    const versions = await rows("notice_animations", [launch]);
    assert.deepEqual(
      versions.map((v) => [v.version, v.source, v.current]),
      [
        [3, "manual", false],
        [2, "mavi", true],
        [1, "mavi", false],
      ],
    );
    assert.ok(manual);
    // Uma falha não troca a versão e avisa com o erro.
    const bad = await rpc("start_notice_animation", [
      launch,
      "Mais cores",
      null,
      null,
      [],
      false,
      null,
    ]);
    await rpc("finish_notice_animation", [
      bad.id,
      null,
      "O provedor recusou a chave.",
      0,
    ]);
    const [failed] = await sql(
      `select status, error from notice_animations where id=$1`,
      [bad.id],
    );
    assert.deepEqual(
      [failed.status, failed.error],
      ["failed", "O provedor recusou a chave."],
    );
    // Presa há mais de 10 minutos conta como falha e libera uma nova.
    const stuck = await rpc("start_notice_animation", [
      launch,
      "Presa",
      null,
      null,
      [],
      false,
      null,
    ]);
    await sql(
      `update notice_animations set created_at = now() - interval '11 minutes' where id=$1`,
      [stuck.id],
    );
    const next = await rpc("start_notice_animation", [
      launch,
      "Depois",
      null,
      null,
      [],
      false,
      null,
    ]);
    assert.equal(
      (
        await sql(`select status from notice_animations where id=$1`, [
          stuck.id,
        ])
      )[0].status,
      "failed",
    );
    assert.ok(next.id);
    await rpc("use_notice_animation", [launch, null]);
    await as(ana);
    assert.equal((await rpc("notice_detail", [launch])).animation, null);
  },
);

console.log(`\n${passed} verificações do Mural de avisos aprovadas.`);

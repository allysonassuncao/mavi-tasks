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

console.log(`\n${passed} verificações do Mural de avisos aprovadas.`);

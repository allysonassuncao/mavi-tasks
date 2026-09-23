import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";
const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, member, foreignUser, manager, isolated] = [
  1, 2, 10, 11, 12, 13, 14,
].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, member, foreignUser, manager, isolated],
]);
await db.query(
  `insert into companies(id,name) values($1,'Empresa A'),($2,'Empresa B')`,
  [A, B],
);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values($1,$3,'Admin A','admin'),($1,$4,'Membro A','member'),($2,$5,'Admin B','admin'),($1,$6,'Gestor A','manager'),($1,$7,'Isolado A','member')`,
  [A, B, admin, member, foreignUser, manager, isolated],
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
async function denied(fn) {
  await assert.rejects(fn);
}
await as(admin);
const team = await rpc("create_team", [
  A,
  "Equipe A",
  [manager, member],
  [manager],
]);
const client = await rpc("create_client", [A, "Cliente A", ""]);
const product = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [
  A,
  client,
  product,
  "Contrato A",
  team,
]);
const task = await rpc("create_task", [
  A,
  contract,
  "Tarefa protegida",
  member,
  "2026-10-01",
  null,
  team,
  "",
  "normal",
  60,
  true,
]);
await check("administrador lê a própria empresa", async () =>
  assert.equal((await db.query("select * from companies")).rows.length, 1),
);
await check("criação em outra empresa é bloqueada", () =>
  denied(() => rpc("create_client", [B, "Intruso", ""])),
);
await as(foreignUser);
const clientB = await rpc("create_client", [B, "Cliente B", ""]);
const productB = await rpc("create_product", [B, "Make CRM"]);
const contractB = await rpc("create_contract", [
  B,
  clientB,
  productB,
  "Contrato B",
  null,
]);
await check("outra empresa não vê tarefas por ID", async () =>
  assert.equal(
    (await db.query("select * from tasks where id=$1", [task])).rows.length,
    0,
  ),
);
await check("outra empresa não comenta por ID", () =>
  denied(() => rpc("add_comment", [task, "Tentativa"])),
);
await check("outra empresa não prepara arquivo", () =>
  denied(() => rpc("prepare_attachment", [task, "arquivo.pdf", 10])),
);
await check("outra empresa não obtém totais", async () =>
  assert.equal(
    (await rpc("report_summary", [A, "2026-01-01", "2027-01-01"])).total,
    0,
  ),
);
await as(admin);
await check("chave composta impede associação entre empresas", () =>
  denied(() => rpc("create_contract", [A, clientB, product, "Inválido", null])),
);
const teamsOf = async (clientId) =>
  (
    await db.query(
      "select team_id from client_teams where client_id=$1 order by team_id",
      [clientId],
    )
  ).rows.map((r) => r.team_id);
await check("equipes responsáveis ficam no cliente, sem duplicar", async () => {
  const teamB = await rpc("create_team", [A, "Equipe B", [member]]);
  const served = await rpc("create_client", [
    A,
    "Cliente com equipes",
    "",
    [team, teamB, team],
  ]);
  assert.deepEqual(await teamsOf(served), [team, teamB].sort());
  await rpc("update_client", [served, "Cliente com equipes", "", null]);
  assert.deepEqual(await teamsOf(served), [team, teamB].sort());
  await rpc("update_client", [served, "Cliente com equipes", "", [teamB]]);
  assert.deepEqual(await teamsOf(served), [teamB]);
});
await check("equipe passada ao produto passa a atender o cliente", async () =>
  assert.deepEqual(await teamsOf(client), [team]),
);
await check("tarefa não pode apontar para contrato de outra empresa", () =>
  denied(() =>
    rpc("create_task", [A, contractB, "Inválida", member, "2026-10-01"]),
  ),
);
const servedClient = await rpc("create_client", [
  A,
  "Cliente da equipe",
  "",
  [team],
]);
await rpc("create_contract", [A, servedClient, product, "Serviço da equipe"]);
const sees = async (id) =>
  (await db.query("select id from clients where id=$1", [id])).rows.length;
await as(isolated);
await check("membro fora da equipe não vê cliente da equipe", async () =>
  assert.equal(await sees(servedClient), 0),
);
await as(member);
await check("membro da equipe vê cliente ainda sem tarefas", async () =>
  assert.equal(await sees(servedClient), 1),
);
await as(isolated);
await check("membro sem equipe não vê contrato ou tarefa", async () => {
  assert.equal((await db.query("select * from tasks")).rows.length, 0);
  assert.equal((await db.query("select * from contracts")).rows.length, 0);
});
await as(member);
await check("membro da equipe lê tarefa", async () =>
  assert.equal((await db.query("select * from tasks")).rows.length, 1),
);
await check("escrita direta não permite entregar sem aprovação", () =>
  denied(() => db.query(`update tasks set status='done' where id=$1`, [task])),
);
await check("escrita direta não permite elevar papel", () =>
  denied(() =>
    db.query(`update memberships set role='admin' where user_id=$1`, [member]),
  ),
);
await check("executor pode iniciar e enviar para validação", async () => {
  await rpc("transition_task", [task, 1, "start", ""]);
  await rpc("transition_task", [task, 2, "submit", ""]);
});
await check("executor não aprova internamente", () =>
  denied(() => rpc("transition_task", [task, 3, "approve_internal", ""])),
);
await as(manager);
await check("gestor da equipe aprova mas aguarda cliente", async () => {
  await rpc("transition_task", [task, 3, "approve_internal", ""]);
  assert.equal(
    (await db.query("select status from tasks where id=$1", [task])).rows[0]
      .status,
    "review",
  );
});
await check("evidência do cliente é obrigatória", () =>
  denied(() => rpc("transition_task", [task, 4, "approve_client", ""])),
);
await check("duas aprovações permitem entregar", async () => {
  await rpc("transition_task", [
    task,
    4,
    "approve_client",
    "Aprovado por Ana em reunião",
  ]);
  assert.equal(
    (await db.query("select status from tasks where id=$1", [task])).rows[0]
      .status,
    "done",
  );
});
await check("versão antiga é rejeitada", () =>
  denied(() => rpc("transition_task", [task, 4, "reopen", "Ajustes"])),
);
await check("reabrir invalida aprovações", async () => {
  await rpc("transition_task", [task, 5, "reopen", "Ajustes solicitados"]);
  const t = (await db.query("select * from tasks where id=$1", [task])).rows[0];
  assert.equal(t.internal_approved_by, null);
  assert.equal(t.client_approved_by, null);
  assert.equal(t.revision, 2);
});
const statusOf = async (id) =>
  (await db.query("select status from tasks where id=$1", [id])).rows[0].status;
async function projectTask(requiresReview, approver, creator) {
  await as(admin);
  const reviewProject = await rpc("create_project", [
    A,
    contract,
    `Validação ${approver} ${requiresReview}`,
    null,
    requiresReview,
    approver,
  ]);
  await as(creator);
  return rpc("create_task", [
    A,
    contract,
    "Tarefa com regra do projeto",
    member,
    "2026-10-01",
    reviewProject,
    team,
  ]);
}
await check("projeto sem validação conclui ao enviar", async () => {
  const id = await projectTask(false, "creator", admin);
  await as(member);
  await rpc("transition_task", [id, 1, "start", ""]);
  await rpc("transition_task", [id, 2, "submit", ""]);
  assert.equal(await statusOf(id), "done");
});
await check(
  "validação pelo supervisor: só gestor da equipe aprova",
  async () => {
    const id = await projectTask(true, "supervisor", member);
    await as(member);
    await rpc("transition_task", [id, 1, "start", ""]);
    await rpc("transition_task", [id, 2, "submit", ""]);
    await denied(() => rpc("transition_task", [id, 3, "approve_internal", ""]));
    await as(manager);
    await rpc("transition_task", [id, 3, "approve_internal", ""]);
    assert.equal(await statusOf(id), "done");
  },
);
await check("supervisores são escolhidos na equipe", async () => {
  const id = await projectTask(true, "supervisor", member);
  await as(member);
  await rpc("transition_task", [id, 1, "start", ""]);
  await rpc("transition_task", [id, 2, "submit", ""]);
  await as(admin);
  await rpc("update_team", [team, "Equipe A", [manager, member], []]);
  await as(manager);
  await denied(() => rpc("transition_task", [id, 3, "approve_internal", ""]));
  await as(admin);
  await rpc("update_team", [team, "Equipe A", [member], [manager]]);
  const people = (
    await db.query(
      "select user_id, supervisor from team_members where team_id=$1",
      [team],
    )
  ).rows;
  assert.equal(people.length, 2);
  assert.equal(people.find((p) => p.user_id === manager)?.supervisor, true);
  assert.equal(people.find((p) => p.user_id === member)?.supervisor, false);
  await as(manager);
  await rpc("transition_task", [id, 3, "approve_internal", ""]);
  assert.equal(await statusOf(id), "done");
});
await check("colaborador não pode ser supervisor", async () => {
  await as(admin);
  await denied(() =>
    rpc("update_team", [team, "Equipe A", [manager, member], [member]]),
  );
});
await check(
  "validação pelo criador: gestor não criador não aprova",
  async () => {
    const id = await projectTask(true, "creator", member);
    await as(member);
    await rpc("transition_task", [id, 1, "start", ""]);
    await rpc("transition_task", [id, 2, "submit", ""]);
    await as(manager);
    await denied(() => rpc("transition_task", [id, 3, "approve_internal", ""]));
    await as(member);
    await rpc("transition_task", [id, 3, "approve_internal", ""]);
    assert.equal(await statusOf(id), "done");
  },
);
await as(member);
await check(
  "colaborador não envia na raiz nem na pasta do cliente",
  async () => {
    await denied(() =>
      rpc("prepare_drive_file", [
        A,
        "raiz.pdf",
        10,
        "application/pdf",
        "private",
      ]),
    );
    await denied(() =>
      rpc("prepare_drive_file", [
        A,
        "cliente.pdf",
        10,
        "application/pdf",
        "private",
        client,
      ]),
    );
    await denied(() => rpc("create_drive_folder", [A, "Pasta", client]));
  },
);
const driveFile = await rpc("prepare_drive_file", [
  A,
  "briefing.pdf",
  2048,
  "application/pdf",
  "private",
  null,
  contract,
]);
const driveRows = async (id) =>
  (await db.query("select id from drive_files where id=$1", [id])).rows.length;
await check(
  "upload pendente do Drive é visível só para quem envia",
  async () => {
    assert.equal(await driveRows(driveFile), 1);
    assert.equal(
      (await db.query("select * from drive_upload_target($1)", [driveFile]))
        .rows.length,
      1,
    );
    await as(manager);
    assert.equal(await driveRows(driveFile), 0);
    assert.equal(
      (await db.query("select * from drive_upload_target($1)", [driveFile]))
        .rows.length,
      0,
    );
  },
);
await check("caminho do arquivo no bucket não é legível", async () => {
  await as(member);
  await denied(() => db.query("select path from drive_files"));
});
await check("arquivo do cliente: só quem atende o cliente baixa", async () => {
  await rpc("confirm_drive_file", [driveFile]);
  const downloads = async () =>
    (await db.query("select * from drive_download_target($1)", [driveFile]))
      .rows.length;
  await as(isolated);
  assert.equal(await downloads(), 0);
  assert.equal(await driveRows(driveFile), 0);
  await as(manager);
  assert.equal(await downloads(), 1);
  await as(foreignUser);
  assert.equal(
    (await db.query("select * from drive_download_target($1)", [driveFile]))
      .rows.length,
    0,
  );
});
await check("link público só funciona com o arquivo público", async () => {
  await as(member);
  const token = (
    await db.query("select share_token from drive_files where id=$1", [
      driveFile,
    ])
  ).rows[0].share_token;
  await as();
  const publicRows = async () =>
    (await db.query("select * from drive_public_target($1)", [token])).rows
      .length;
  assert.equal(await publicRows(), 0);
  await as(isolated);
  await denied(() => rpc("set_drive_file_visibility", [driveFile, "public"]));
  await as(member);
  await rpc("set_drive_file_visibility", [driveFile, "public"]);
  await as();
  assert.equal(await publicRows(), 1);
});
await check("só quem enviou ou gestores excluem arquivos", async () => {
  await as(isolated);
  await denied(() => rpc("delete_drive_file", [driveFile]));
  await as(admin);
  assert.equal(
    await rpc("delete_drive_file", [driveFile]),
    `drive/${A}/${driveFile}`,
  );
  assert.equal(await driveRows(driveFile), 0);
});
await check(
  "pastas: criadas no produto, herdam o local e só saem vazias",
  async () => {
    await as(member);
    const folder = await rpc("create_drive_folder", [
      A,
      "Criativos",
      null,
      contract,
    ]);
    const sub = await rpc("create_drive_folder", [
      A,
      "Aprovados",
      null,
      null,
      folder,
    ]);
    const row = (
      await db.query(
        "select client_id, contract_id, parent_id from drive_folders where id=$1",
        [sub],
      )
    ).rows[0];
    assert.deepEqual(row, {
      client_id: client,
      contract_id: contract,
      parent_id: folder,
    });
    await rpc("rename_drive_folder", [sub, "Aprovados pelo cliente"]);
    await denied(() => rpc("delete_drive_folder", [folder]));
    await rpc("delete_drive_folder", [sub]);
    await rpc("delete_drive_folder", [folder]);
    await as(isolated);
    await denied(() =>
      rpc("create_drive_folder", [A, "Intruso", null, contract]),
    );
  },
);
await check("gestores organizam a raiz, visível a toda a empresa", async () => {
  await as(manager);
  const shared = await rpc("create_drive_folder", [A, "Modelos da agência"]);
  await rpc("create_drive_folder", [A, "Contratos", client]);
  await as(isolated);
  assert.equal(
    (await db.query("select id from drive_folders where id=$1", [shared])).rows
      .length,
    1,
  );
  assert.equal(
    (
      await db.query("select id from drive_folders where client_id=$1", [
        client,
      ])
    ).rows.length,
    0,
  );
});
await check("cada pessoa altera só o próprio nome e foto", async () => {
  await as(member);
  await rpc("update_my_profile", ["Membro Renomeado"]);
  const names = (
    await db.query(
      "select user_id, name from memberships where user_id in ($1,$2)",
      [member, manager],
    )
  ).rows;
  assert.equal(
    names.find((r) => r.user_id === member).name,
    "Membro Renomeado",
  );
  assert.equal(names.find((r) => r.user_id === manager).name, "Gestor A");
  await denied(() => rpc("update_my_profile", [" "]));
  const path = await rpc("avatar_upload_path", ["webp"]);
  assert.match(
    await rpc("avatar_upload_path", ["jpg"]),
    new RegExp(`^avatars/${member}/[0-9a-f-]{36}\\.jpg$`),
  );
  await denied(() => rpc("avatar_upload_path", ["svg"]));
  assert.match(path, new RegExp(`^avatars/${member}/[0-9a-f-]{36}\\.webp$`));
  const url = `https://storage.googleapis.com/bucket/${path}`;
  await rpc("set_my_avatar", [url]);
  assert.equal(
    (
      await db.query("select avatar_url from memberships where user_id=$1", [
        member,
      ])
    ).rows[0].avatar_url,
    url,
  );
  await denied(() =>
    rpc("set_my_avatar", [
      `https://storage.googleapis.com/bucket/avatars/${manager}/${member}.webp`,
    ]),
  );
  await denied(() => rpc("set_my_avatar", ["https://evil.example/pixel.webp"]));
  await denied(() =>
    db.query("update memberships set name='x' where user_id=$1", [manager]),
  );
  await rpc("set_my_avatar", [null]);
  await rpc("update_my_profile", ["Membro A"]);
});
await check(
  "assinatura de upload só para o próprio registro recente",
  async () => {
    await as(member);
    const own = await rpc("prepare_attachment", [task, "entrega.pdf", 1234]);
    const image = await rpc("prepare_inline_image", [A, "print.png", 2048]);
    const target = async (fn, id) =>
      (await db.query(`select * from ${fn}($1)`, [id])).rows;
    assert.deepEqual(await target("attachment_upload_target", own.id), [
      { path: own.path, name: "entrega.pdf", size_bytes: 1234 },
    ]);
    assert.equal(
      (await target("inline_image_upload_target", image.id))[0].path,
      image.path,
    );
    await as(manager);
    assert.equal((await target("attachment_upload_target", own.id)).length, 0);
    assert.equal(
      (await target("inline_image_upload_target", image.id)).length,
      0,
    );
    await as();
    await denied(() => target("attachment_upload_target", own.id));
    // Records older than 15 minutes (or images already in a task) are closed.
    await db.exec("reset role");
    await db.query(
      "update attachments set created_at = now() - interval '20 minutes' where id=$1",
      [own.id],
    );
    await db.query("update inline_images set task_id=$1 where id=$2", [
      task,
      image.id,
    ]);
    await as(member);
    assert.equal((await target("attachment_upload_target", own.id)).length, 0);
    assert.equal(
      (await target("inline_image_upload_target", image.id)).length,
      0,
    );
  },
);
const memberRow = async (id) =>
  (
    await db.query(
      "select name, role, active from memberships where company_id=$1 and user_id=$2",
      [A, id],
    )
  ).rows[0];
const memberTeams = async (id) =>
  (
    await db.query(
      "select team_id, supervisor from team_members where company_id=$1 and user_id=$2",
      [A, id],
    )
  ).rows;
await check(
  "gestor edita colaborador: nome, perfil, equipes e status",
  async () => {
    await as(manager);
    await rpc("update_member", [
      A,
      member,
      "Membro Editado",
      "member",
      false,
      [],
    ]);
    assert.deepEqual(await memberRow(member), {
      name: "Membro Editado",
      role: "member",
      active: false,
    });
    assert.deepEqual(await memberTeams(member), []);
    await rpc("update_member", [A, member, "Membro A", "member", true, [team]]);
    assert.deepEqual(await memberRow(member), {
      name: "Membro A",
      role: "member",
      active: true,
    });
  },
);
await check(
  "gestor não edita administradores nem concede administrador",
  async () => {
    await as(manager);
    await denied(() =>
      rpc("update_member", [A, admin, "Admin A", "admin", true, []]),
    );
    await denied(() =>
      rpc("update_member", [A, member, "Membro A", "admin", true, [team]]),
    );
  },
);
await check("ninguém altera o próprio perfil nem se desativa", async () => {
  await as(manager);
  await denied(() =>
    rpc("update_member", [A, manager, "Gestor A", "member", true, [team]]),
  );
  await denied(() =>
    rpc("update_member", [A, manager, "Gestor A", "manager", false, [team]]),
  );
  await rpc("update_member", [A, manager, "Gestor A", "manager", true, [team]]);
});
await check("colaborador não edita pessoas", async () => {
  await as(member);
  await denied(() =>
    rpc("update_member", [A, isolated, "Isolado A", "member", true, []]),
  );
});
await check("quem deixa de ser gestor perde a supervisão", async () => {
  await as(admin);
  await rpc("update_team", [team, "Equipe A", [member], [manager]]);
  await rpc("update_member", [A, manager, "Gestor A", "member", true, [team]]);
  assert.deepEqual(await memberTeams(manager), [
    { team_id: team, supervisor: false },
  ]);
  await rpc("update_member", [A, manager, "Gestor A", "manager", true, [team]]);
  await rpc("update_team", [team, "Equipe A", [member], [manager]]);
});
await check(
  "toda ação no Drive fica no histórico, imutável e só para gestores",
  async () => {
    await as(member);
    const file = await rpc("prepare_drive_file", [
      A,
      "contrato.pdf",
      500,
      "application/pdf",
      "private",
      null,
      contract,
    ]);
    await rpc("confirm_drive_file", [file]);
    await rpc("rename_drive_file", [file, "contrato-assinado.pdf"]);
    await rpc("set_drive_file_visibility", [file, "public"]);
    await rpc("log_drive_link_copied", [file]);
    await db.query("select * from drive_download_target($1, $2, $3)", [
      file,
      false,
      { ip: "203.0.113.9", user_agent: "Teste/1.0" },
    ]);
    const token = (
      await db.query("select share_token from drive_files where id=$1", [file])
    ).rows[0].share_token;
    await as();
    await db.query("select * from drive_public_target($1, $2)", [token, true]);
    await as(member);
    const folder = await rpc("create_drive_folder", [
      A,
      "Jurídico",
      null,
      contract,
    ]);
    await rpc("rename_drive_folder", [folder, "Jurídico 2026"]);
    await rpc("delete_drive_folder", [folder]);
    await rpc("delete_drive_file", [file]);
    assert.equal(
      (await db.query("select * from drive_audit")).rows.length,
      0,
      "colaborador não lê o histórico",
    );
    await as(manager);
    const rows = (
      await db.query(
        "select action, actor_id, item_name, details from drive_audit where file_id=$1 or folder_id=$2 order by id",
        [file, folder],
      )
    ).rows;
    assert.deepEqual(
      rows.map((r) => r.action),
      [
        "upload_started",
        "upload_completed",
        "file_renamed",
        "visibility_changed",
        "link_copied",
        "file_downloaded",
        "public_viewed",
        "folder_created",
        "folder_renamed",
        "folder_deleted",
        "file_deleted",
      ],
    );
    const by = (action) => rows.find((r) => r.action === action);
    assert.equal(by("file_renamed").details.from, "contrato.pdf");
    assert.equal(by("visibility_changed").details.to, "public");
    assert.deepEqual(by("file_downloaded").details.origin, {
      ip: "203.0.113.9",
      user_agent: "Teste/1.0",
    });
    assert.equal(by("public_viewed").actor_id, null);
    assert.equal(by("file_deleted").item_name, "contrato-assinado.pdf");
    assert.equal(by("upload_started").actor_id, member);
    await denied(() => db.query("delete from drive_audit"));
    await db.exec("reset role");
    await denied(() => db.query("update drive_audit set action='x'"));
    await denied(() => db.query("delete from drive_audit"));
  },
);
await as(member);
let timer;
await check("iniciar cronômetro é idempotente", async () => {
  timer = (await rpc("start_timer", [task])).id;
  assert.equal((await rpc("start_timer", [task])).id, timer);
});
await check("parar cronômetro é idempotente", async () => {
  await rpc("stop_timer", [timer]);
  const old = (
    await db.query("select ended_at from time_entries where id=$1", [timer])
  ).rows[0].ended_at;
  await rpc("stop_timer", [timer]);
  assert.deepEqual(
    (await db.query("select ended_at from time_entries where id=$1", [timer]))
      .rows[0].ended_at,
    old,
  );
});
await check("horas negativas rejeitadas", () =>
  denied(() =>
    rpc("log_time", [task, "2026-09-01T12:00:00Z", "2026-09-01T11:00:00Z", ""]),
  ),
);
await check("períodos sobrepostos rejeitados", async () => {
  await rpc("log_time", [
    task,
    "2026-09-01T12:00:00Z",
    "2026-09-01T13:00:00Z",
    "",
  ]);
  await denied(() =>
    rpc("log_time", [task, "2026-09-01T12:30:00Z", "2026-09-01T13:30:00Z", ""]),
  );
});
const attachment = await rpc("prepare_attachment", [task, "briefing.pdf", 100]);
await check("upload autorizado pelo registro e autor", async () => {
  await db.query("insert into storage.objects(bucket_id,name) values($1,$2)", [
    "mavi-attachments",
    attachment.path,
  ]);
  assert.equal(
    (await db.query("select * from storage.objects")).rows.length,
    1,
  );
});
await check("upload sem registro autorizado é bloqueado", () =>
  denied(() =>
    db.query("insert into storage.objects(bucket_id,name) values($1,$2)", [
      "mavi-attachments",
      `${A}/${task}/${uid(99)}`,
    ]),
  ),
);
await as(foreignUser);
await check("arquivo de outra empresa é invisível", async () =>
  assert.equal(
    (await db.query("select * from storage.objects")).rows.length,
    0,
  ),
);
await as(null);
await check("anônimo não consulta dados nem RPCs", async () => {
  await denied(() => db.query("select * from tasks"));
  await denied(() => rpc("create_client", [A, "Visitante", ""]));
});
await db.exec("reset role");
await db.query(
  "update memberships set active=false where company_id=$1 and user_id=$2",
  [A, member],
);
await as(member);
await check("revogar vínculo bloqueia sessão existente", async () => {
  assert.equal((await db.query("select * from tasks")).rows.length, 0);
  assert.equal(
    (await db.query("select * from storage.objects")).rows.length,
    0,
  );
  await denied(() => rpc("add_comment", [task, "Tentativa"]));
});
await db.exec("reset role");
const bootstrapCompany = uid(30),
  bootstrapUser = uid(31);
await db.query("insert into companies(id,name) values($1,'Bootstrap')", [
  bootstrapCompany,
]);
await db.query(
  "insert into mavi_private.admin_provisioning(company_id,email,name) values($1,'owner@example.test','Owner')",
  [bootstrapCompany],
);
await db.query(
  "insert into auth.users(id,email) values($1,'owner@example.test')",
  [bootstrapUser],
);
await check("e-mail não confirmado não recebe administração", async () =>
  assert.equal(
    (
      await db.query("select * from memberships where company_id=$1", [
        bootstrapCompany,
      ])
    ).rows.length,
    0,
  ),
);
await db.query("update auth.users set email_confirmed_at=now() where id=$1", [
  bootstrapUser,
]);
await check(
  "e-mail confirmado consome provisionamento uma única vez",
  async () => {
    assert.equal(
      (
        await db.query(
          "select role from memberships where company_id=$1 and user_id=$2",
          [bootstrapCompany, bootstrapUser],
        )
      ).rows[0].role,
      "admin",
    );
    await db.query(
      "update auth.users set email_confirmed_at=now() where id=$1",
      [bootstrapUser],
    );
    assert.equal(
      (
        await db.query("select * from memberships where company_id=$1", [
          bootstrapCompany,
        ])
      ).rows.length,
      1,
    );
  },
);
await as(bootstrapUser);
await check("administrador não consulta allowlist interna", () =>
  denied(() => db.query("select * from mavi_private.admin_provisioning")),
);

await db.exec("reset role");
await db.query(
  "update memberships set active=true where company_id=$1 and user_id=$2",
  [A, member],
);
await as(admin);
const task2 = await rpc("create_task", [
  A,
  contract,
  "Segunda tarefa",
  member,
  "2026-10-15",
  null,
  team,
  "",
  "normal",
  60,
  false,
]);
const project = await rpc("create_project", [
  A,
  contract,
  "Projeto editável",
  null,
]);
await as(member);
await check("responsável não pode editar conteúdo da tarefa", () =>
  denied(() =>
    rpc("update_task", [task2, 1, "Alterado", "", "2026-10-15", 60, "normal"]),
  ),
);
await as(manager);
await check("gestor não criador não pode editar tarefa", () =>
  denied(() =>
    rpc("update_task", [task2, 1, "Alterado", "", "2026-10-15", 60, "normal"]),
  ),
);
await check("gestor não executa cadastros administrativos", async () => {
  await denied(() =>
    rpc("create_project", [A, contract, "Sem permissão", null]),
  );
  await denied(() => rpc("update_product", [product, "Sem permissão"]));
  await denied(() => rpc("update_client", [client, "Sem permissão", ""]));
  await denied(() =>
    rpc("update_contract", [contract, "Sem permissão", client, product]),
  );
  await denied(() => rpc("update_project", [project, "Sem permissão", null]));
});
await as(admin);
await check("administrador edita os quatro cadastros", async () => {
  await rpc("update_product", [product, "Produto revisado"]);
  await rpc("update_client", [
    client,
    "Cliente revisado",
    "contato@example.test",
  ]);
  await rpc("update_contract", [contract, "Serviço revisado", client, product]);
  await rpc("update_project", [
    project,
    "Projeto revisado",
    "2026-11-01",
    contract,
  ]);
  assert.equal(
    (await db.query("select name from products where id=$1", [product])).rows[0]
      .name,
    "Produto revisado",
  );
});
await check(
  "administrador edita tarefa e define início planejado",
  async () => {
    await rpc("update_task", [
      task2,
      1,
      "Segunda tarefa revisada",
      "Descrição",
      "2026-10-15",
      60,
      "normal",
      "2026-10-01",
    ]);
    assert.equal(
      (
        await db.query("select start_date::text from tasks where id=$1", [
          task2,
        ])
      ).rows[0].start_date,
      "2026-10-01",
    );
  },
);
await check("início posterior ao prazo é rejeitado", () =>
  denied(() =>
    rpc("update_task", [
      task2,
      2,
      "Inválida",
      "",
      "2026-10-15",
      60,
      "normal",
      "2026-10-20",
    ]),
  ),
);
await as(member);
const ownTask = await rpc("create_task", [
  A,
  contract,
  "Tarefa do colaborador",
  member,
  "2026-10-15",
  null,
  team,
]);
await check("criador colaborador pode editar sua tarefa", async () => {
  await rpc("update_task", [
    ownTask,
    1,
    "Criador editou",
    "texto",
    "2026-10-15",
    60,
    "normal",
  ]);
});
await check(
  "iniciar outra tarefa pausa a anterior sem sobrepor horas",
  async () => {
    const a = (await rpc("start_timer", [task])).id;
    const b = (await rpc("start_timer", [task2])).id;
    const rows = (
      await db.query("select * from time_entries where id in ($1,$2)", [a, b])
    ).rows;
    assert.deepEqual(
      rows.find((r) => r.id === a).ended_at,
      rows.find((r) => r.id === b).started_at,
    );
    assert.equal(
      (
        await db.query(
          "select * from time_entries where user_id=$1 and ended_at is null",
          [member],
        )
      ).rows.length,
      1,
    );
    await denied(() => rpc("start_timer", [uid(999)]));
    assert.equal(
      (
        await db.query(
          "select id from time_entries where user_id=$1 and ended_at is null",
          [member],
        )
      ).rows[0].id,
      b,
    );
    await rpc("stop_timer", [b]);
  },
);
const imageBody = (id) =>
  "mavi:richtext:v1:" +
  JSON.stringify({
    type: "doc",
    content: [{ type: "inlineImage", attrs: { imageId: id, alt: "Teste" } }],
  });
await as(admin);
const draft = await rpc("prepare_inline_image", [A, "teste.png", 100]);
await db.query(
  "insert into storage.objects(bucket_id,name) values('mavi-inline-images',$1)",
  [draft.path],
);
await as(member);
await check(
  "rascunho de imagem de outro usuário permanece privado",
  async () => {
    assert.equal(
      (await db.query("select * from inline_images where id=$1", [draft.id]))
        .rows.length,
      0,
    );
    assert.equal(
      (
        await db.query("select * from storage.objects where name=$1", [
          draft.path,
        ])
      ).rows.length,
      0,
    );
    await denied(() => rpc("add_comment", [task2, imageBody(draft.id)]));
  },
);
await as(admin);
await check(
  "salvar comentário vincula imagem à tarefa atomicamente",
  async () => {
    await rpc("add_comment", [task2, imageBody(draft.id)]);
    assert.equal(
      (
        await db.query("select task_id from inline_images where id=$1", [
          draft.id,
        ])
      ).rows[0].task_id,
      task2,
    );
  },
);
await as(member);
await check(
  "usuário autorizado lê imagem vinculada, mas não a move",
  async () => {
    assert.equal(
      (
        await db.query("select * from storage.objects where name=$1", [
          draft.path,
        ])
      ).rows.length,
      1,
    );
    await denied(() => rpc("add_comment", [ownTask, imageBody(draft.id)]));
  },
);
await as(foreignUser);
await check("imagem vinculada é isolada por empresa", async () => {
  assert.equal(
    (await db.query("select * from inline_images where id=$1", [draft.id])).rows
      .length,
    0,
  );
  assert.equal(
    (
      await db.query("select * from storage.objects where name=$1", [
        draft.path,
      ])
    ).rows.length,
    0,
  );
  await denied(() => rpc("prepare_inline_image", [A, "intruso.png", 10]));
  await denied(() => rpc("update_client", [client, "Intruso", ""]));
});
await as(admin);
const incomplete = await rpc("prepare_inline_image", [
  A,
  "incompleta.png",
  100,
]);
await check("imagem sem upload impede salvar conteúdo quebrado", () =>
  denied(() => rpc("add_comment", [task2, imageBody(incomplete.id)])),
);
await check("imagem pode ser incluída ao criar tarefa", async () => {
  const image = await rpc("prepare_inline_image", [A, "nova.png", 100]);
  await db.query(
    "insert into storage.objects(bucket_id,name) values('mavi-inline-images',$1)",
    [image.path],
  );
  const newTask = await rpc("create_task", [
    A,
    contract,
    "Com imagem",
    member,
    "2026-10-20",
    null,
    team,
    imageBody(image.id),
  ]);
  assert.equal(
    (
      await db.query("select task_id from inline_images where id=$1", [
        image.id,
      ])
    ).rows[0].task_id,
    newTask,
  );
});
await as(null);
await check("anônimo não prepara imagens nem edita cadastros", async () => {
  await denied(() => rpc("prepare_inline_image", [A, "anônimo.png", 100]));
  await denied(() => rpc("update_product", [product, "Intruso"]));
});

await as(admin);
await check(
  "task_extras retorna coleções ordenadas e limitadas a 100",
  async () => {
    await db.exec("reset role");
    await db.query(
      `insert into comments(company_id,task_id,author_id,body,created_at)
    select $1,$2,$3,'Comentário '||n,now()-n*interval '1 second' from generate_series(1,105) n`,
      [A, task, admin],
    );
    await as(admin);
    const extras = await rpc("task_extras", [task]);
    assert.equal(extras.comments.length, 100);
    assert.equal(extras.comments[0].body, "Comentário 1");
    assert.ok(extras.attachments.some((a) => a.id === attachment.id));
    assert.ok(extras.events.length > 0);
  },
);
await as(foreignUser);
await check(
  "task_extras bloqueia ID de outra empresa e ID inexistente",
  async () => {
    await denied(() => rpc("task_extras", [task]));
    await denied(() => rpc("task_extras", [uid(999)]));
  },
);
await as(isolated);
await check("task_extras bloqueia membro fora do escopo", () =>
  denied(() => rpc("task_extras", [task])),
);
await as(null);
await check("anônimo não chama RPC unificada", () =>
  denied(() => rpc("task_extras", [task])),
);
await as(admin);
await check(
  "clientes não executam manutenção ou rate limit privilegiados",
  async () => {
    for (const [name, args] of [
      ["claim_storage_cleanup", []],
      ["complete_storage_cleanup", ["mavi-inline-images", []]],
      ["consume_invite_limit", [A, admin]],
    ])
      await denied(() => rpc(name, args));
    await denied(() => db.query("select mavi_private.prune_task_events()"));
  },
);
await db.exec("reset role; set role service_role");
await check(
  "convites: cota por administrador rejeita a 11ª tentativa",
  async () => {
    for (let i = 0; i < 10; i++)
      assert.equal(
        (await rpc("consume_invite_limit", [A, admin])).allowed,
        true,
      );
    const blocked = await rpc("consume_invite_limit", [A, admin]);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retry_after > 0 && blocked.retry_after <= 3600);
  },
);
await check(
  "convites: não administrador e empresa alheia são rejeitados",
  async () => {
    await denied(() => rpc("consume_invite_limit", [A, member]));
    await denied(() => rpc("consume_invite_limit", [B, admin]));
  },
);
await db.exec("reset role");
await db.query(
  "update mavi_private.invite_limits set window_start=now()-interval '2 hours'",
);
await db.exec("set role service_role");
await check("convites: nova janela libera o envio", async () =>
  assert.equal((await rpc("consume_invite_limit", [A, admin])).allowed, true),
);
await db.exec("reset role");
await db.query(
  "update mavi_private.invite_limits set used=50 where company_id=$1 and scope='company'",
  [A],
);
await db.exec("set role service_role");
await check(
  "convites: limite da empresa bloqueia mesmo com cota pessoal",
  async () =>
    assert.equal(
      (await rpc("consume_invite_limit", [A, admin])).allowed,
      false,
    ),
);
await as(admin);
const abandoned = await rpc("prepare_inline_image", [A, "abandonada.png", 100]);
const freshDraft = await rpc("prepare_inline_image", [A, "recente.png", 100]);
const pendingFile = await rpc("prepare_attachment", [
  task,
  "pendente.pdf",
  100,
]);
await db.query(
  "insert into storage.objects(bucket_id,name) values('mavi-inline-images',$1)",
  [abandoned.path],
);
await db.exec("reset role");
await db.query(
  "update inline_images set created_at=now()-interval '2 days' where id in ($1,$2)",
  [abandoned.id, draft.id],
);
await db.query(
  "update attachments set created_at=now()-interval '2 days' where id in ($1,$2)",
  [pendingFile.id, attachment.id],
);
await db.query(
  "insert into storage.objects(bucket_id,name,created_at) values('mavi-attachments','orphan',now()-interval '2 days'),('mavi-inline-images','recent-orphan',now())",
);
await db.exec("set role service_role");
await check(
  "limpeza coleta abandonados, preserva vinculados e carência",
  async () => {
    const rows = (
      await db.query("select * from public.claim_storage_cleanup()")
    ).rows;
    assert.equal(rows.length, 3);
  },
);
await db.exec("reset role");
await check("fila inclui blob órfão e pendência sem upload", async () => {
  const rows = (await db.query("select * from mavi_private.storage_cleanup"))
    .rows;
  assert.deepEqual(
    new Set(rows.map((r) => r.path)),
    new Set([abandoned.path, pendingFile.path, "orphan"]),
  );
  assert.equal(
    (
      await db.query("select id from inline_images where id=$1", [
        freshDraft.id,
      ])
    ).rows.length,
    1,
  );
  assert.equal(
    (await db.query("select id from inline_images where id=$1", [draft.id]))
      .rows.length,
    1,
  );
  assert.equal(
    (await db.query("select id from attachments where id=$1", [attachment.id]))
      .rows.length,
    1,
  );
  assert.equal(
    (
      await db.query("select id from storage.objects where name=$1", [
        abandoned.path,
      ])
    ).rows.length,
    1,
  );
});
await as(admin);
await check(
  "imagem reclamada pela limpeza não pode ser vinculada nem reenviada",
  async () => {
    await denied(() => rpc("add_comment", [task, imageBody(abandoned.id)]));
    await denied(() =>
      db.query(
        "insert into storage.objects(bucket_id,name) values('mavi-inline-images',$1)",
        [abandoned.path],
      ),
    );
  },
);
await db.exec("reset role; set role service_role");
await check(
  "lease evita duplicar trabalho e conclusão libera fila",
  async () => {
    assert.equal(
      (await db.query("select * from public.claim_storage_cleanup()")).rows
        .length,
      0,
    );
    // Simulate the successful Storage API delete before acknowledging the queue.
    await db.exec("reset role");
    await db.query(
      "delete from storage.objects where bucket_id='mavi-attachments' and name='orphan'",
    );
    await db.exec("set role service_role");
    await rpc("complete_storage_cleanup", [
      "mavi-attachments",
      [pendingFile.path, "orphan"],
    ]);
  },
);
await db.exec("reset role");
await db.query(
  "update mavi_private.storage_cleanup set next_attempt_at=now()-interval '1 minute'",
);
await db.exec("set role service_role");
await check("falha do Storage é retomada após expiração do lease", async () => {
  const rows = (await db.query("select * from public.claim_storage_cleanup()"))
    .rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, abandoned.path);
});
await db.exec("reset role");
await check("retenção exclui só eventos anteriores a um mês", async () => {
  await db.query(
    `insert into task_events(company_id,task_id,actor_id,action,created_at)
    values($1,$2,$3,'expired',now()-interval '1 month'-interval '1 second'),
    ($1,$2,$3,'retained',now()-interval '1 month'+interval '1 minute')`,
    [A, task, admin],
  );
  const count = (await db.query("select mavi_private.prune_task_events() n"))
    .rows[0].n;
  assert.ok(count >= 1);
  assert.equal(
    (await db.query("select * from task_events where action='expired'")).rows
      .length,
    0,
  );
  assert.equal(
    (await db.query("select * from task_events where action='retained'")).rows
      .length,
    1,
  );
});
await db.close();
console.log(
  `\n${passed} verificações de banco aprovadas (PostgreSQL embarcado; Auth e Storage simulados).`,
);

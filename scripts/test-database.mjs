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
const team = await rpc("create_team", [A, "Equipe A", [manager, member]]);
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
await check("tarefa não pode apontar para contrato de outra empresa", () =>
  denied(() =>
    rpc("create_task", [A, contractB, "Inválida", member, "2026-10-01"]),
  ),
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

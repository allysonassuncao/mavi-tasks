// Checklist nas tarefas (migration 20270220090000_task_checklists): vários
// checklists com nome por tarefa, um nível de subitens, conclusão automática
// e pelo "Concluir checklist", o registro durável, quem renomeia e exclui, a
// exigência para entregar (gatilho em tasks), os modelos e a cópia na
// repetição.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, eva, bia, caio] = [1, 10, 11, 12, 13].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, eva, bia, caio],
]);
await db.query(`insert into companies(id,name) values($1,'Empresa A')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Eva Criadora','member'),($1,$4,'Bia Design','member'),
   ($1,$5,'Caio Fora','member')`,
  [A, admin, eva, bia, caio],
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
  await db.exec("reset role");
}
const today = (await sql("select current_date::text as d"))[0].d;

await as(admin);
const design = await rpc("create_team", [A, "Design", [eva, bia], []]);
const client = await rpc("create_client", [A, "Cliente X", "", [design]]);
const product = await rpc("create_product", [A, "Social"]);
const contract = await rpc("create_contract", [A, client, product, "Social X"]);

// Da Eva para a Bia, toda semana.
await as(eva);
const task = await rpc("create_task", [
  A,
  contract,
  "Post da semana",
  bia,
  today,
  null,
  null,
  "Arte",
  "normal",
  60,
  false,
  null,
  null,
  "{}",
  "weekly",
]);
const row = async (id = task) =>
  (await sql("select * from tasks where id=$1", [id]))[0];
const lists = async (user = bia, id = task) => {
  await as(user);
  return (await rpc("task_extras", [id])).checklists;
};
const log = async (id = task) =>
  sql(
    "select action, detail, actor_id from task_checklist_log where task_id=$1 order by created_at, id",
    [id],
  );

let briefing;
await check(
  "cria checklist com itens e subitens; quem vê a tarefa lê",
  async () => {
    await as(bia);
    const out = await rpc("add_task_checklist", [
      task,
      " Briefing ",
      JSON.stringify([
        { title: "Ler o pedido" },
        {
          title: "Separar referências",
          children: [{ title: "Instagram" }, { title: "Site" }],
        },
      ]),
    ]);
    assert.equal(out.length, 1);
    briefing = out[0];
    assert.equal(briefing.title, "Briefing");
    assert.equal(briefing.items.length, 4);
    const parent = briefing.items.find(
      (i) => i.title === "Separar referências",
    );
    assert.equal(
      briefing.items.filter((i) => i.parent_id === parent.id).length,
      2,
    );
    assert.equal((await lists(eva)).length, 1);
    // Quem não vê a tarefa não lê nem mexe.
    await as(caio);
    assert.equal(
      (await db.query("select count(*)::int as n from task_checklists")).rows[0]
        .n,
      0,
    );
    await rejects(
      () => rpc("add_task_checklist", [task, "Outro", "[]"]),
      /Sem acesso/,
    );
  },
);

const item = (l, title) => l.items.find((i) => i.title === title);

await check("subitem não tem subitem; item vazio é recusado", async () => {
  await as(bia);
  const insta = item(briefing, "Instagram");
  await rejects(
    () => rpc("add_checklist_item", [briefing.id, "Stories", insta.id]),
    /Subitens não têm/,
  );
  await as(bia);
  await rejects(
    () => rpc("add_checklist_item", [briefing.id, "   ", null]),
    /Escreva o item/,
  );
});

await check(
  "marcar todos os subitens marca o item; desmarcar um desmarca",
  async () => {
    await as(bia);
    let l = (
      await rpc("set_checklist_item_done", [
        item(briefing, "Instagram").id,
        true,
      ])
    )[0];
    assert.equal(item(l, "Separar referências").done, false);
    l = (
      await rpc("set_checklist_item_done", [item(briefing, "Site").id, true])
    )[0];
    assert.equal(item(l, "Separar referências").done, true);
    l = (
      await rpc("set_checklist_item_done", [item(briefing, "Site").id, false])
    )[0];
    assert.equal(item(l, "Separar referências").done, false);
    assert.equal(item(l, "Instagram").done, true);
  },
);

await check(
  "marcar o item leva os subitens junto, com quem e quando",
  async () => {
    await as(bia);
    const l = (
      await rpc("set_checklist_item_done", [
        item(briefing, "Separar referências").id,
        true,
      ])
    )[0];
    for (const t of ["Separar referências", "Instagram", "Site"]) {
      assert.equal(item(l, t).done, true);
      assert.equal(item(l, t).done_by, bia);
      assert.ok(item(l, t).done_at);
    }
    assert.equal(l.completed_at, null);
  },
);

await check(
  "último item marcado conclui o checklist; desmarcar reabre; tudo no registro",
  async () => {
    await as(bia);
    let l = (
      await rpc("set_checklist_item_done", [
        item(briefing, "Ler o pedido").id,
        true,
      ])
    )[0];
    assert.ok(l.completed_at);
    assert.equal(l.completed_by, bia);
    l = (
      await rpc("set_checklist_item_done", [
        item(briefing, "Ler o pedido").id,
        false,
      ])
    )[0];
    assert.equal(l.completed_at, null);
    // Adicionar item também reabre um concluído.
    await rpc("set_checklist_item_done", [
      item(briefing, "Ler o pedido").id,
      true,
    ]);
    l = (
      await rpc("add_checklist_item", [briefing.id, "Conferir prazo", null])
    )[0];
    assert.equal(l.completed_at, null);
    const actions = (await log()).map((x) => x.action);
    assert.deepEqual(
      actions.filter((a) => a.startsWith("checklist_")),
      [
        "checklist_added",
        "checklist_completed",
        "checklist_reopened",
        "checklist_completed",
        "checklist_reopened",
      ],
    );
    assert.ok(
      actions.includes("item_checked") &&
        actions.includes("item_unchecked") &&
        actions.includes("item_added"),
    );
  },
);

await check("Concluir checklist marca o que falta", async () => {
  await as(bia);
  const l = (await rpc("complete_task_checklist", [briefing.id]))[0];
  assert.ok(l.items.every((i) => i.done));
  assert.ok(l.completed_at);
  await as(bia);
  const [empty] = (
    await rpc("add_task_checklist", [task, "Vazio", "[]"])
  ).filter((x) => x.title === "Vazio");
  await rejects(
    () => rpc("complete_task_checklist", [empty.id]),
    /Adicione itens/,
  );
  await as(bia);
  await rpc("delete_task_checklist", [empty.id]);
});

await check(
  "renomear e excluir: quem criou, o criador da tarefa ou gestor",
  async () => {
    await as(eva);
    const [, revisao] = await rpc("add_task_checklist", [
      task,
      "Revisão",
      JSON.stringify([{ title: "Ortografia" }]),
    ]);
    // A Bia (responsável) não exclui nem renomeia o que a Eva criou...
    await as(bia);
    await rejects(
      () => rpc("delete_task_checklist", [revisao.id]),
      /Só quem criou/,
    );
    await as(bia);
    await rejects(
      () =>
        rpc("edit_checklist_item", [
          item(revisao, "Ortografia").id,
          "Ortografia e vírgulas",
        ]),
      /Só quem criou/,
    );
    await as(bia);
    await rejects(
      () => rpc("delete_checklist_item", [item(revisao, "Ortografia").id]),
      /Só quem criou/,
    );
    // ...mas marca, adiciona e mexe no que é dela.
    await as(bia);
    let l = await rpc("add_checklist_item", [revisao.id, "Cores", null]);
    const cores = item(l[1], "Cores");
    l = await rpc("edit_checklist_item", [cores.id, "Cores da marca"]);
    assert.equal(item(l[1], "Cores da marca").title, "Cores da marca");
    // A Eva (criadora da tarefa) renomeia o checklist da Bia; o gestor exclui o item.
    await as(eva);
    l = await rpc("rename_task_checklist", [briefing.id, "Briefing do post"]);
    assert.equal(l[0].title, "Briefing do post");
    await as(admin);
    l = await rpc("delete_checklist_item", [cores.id]);
    assert.equal(item(l[1], "Cores da marca"), undefined);
    const last = (await log()).at(-1);
    assert.equal(last.action, "item_deleted");
    assert.equal(last.actor_id, admin);
  },
);

await check("reordenar itens e checklists", async () => {
  await as(bia);
  let l = await lists();
  const ids = l[0].items
    .filter((i) => !i.parent_id)
    .map((i) => i.id)
    .reverse();
  l = await rpc("reorder_checklist_items", [l[0].id, null, ids]);
  assert.deepEqual(
    l[0].items.filter((i) => !i.parent_id).map((i) => i.id),
    ids,
  );
  l = await rpc("reorder_task_checklists", [task, [l[1].id, l[0].id]]);
  assert.equal(l[0].title, "Revisão");
});

await check(
  "a exigência é de quem edita a tarefa e trava Em validação e Entregue",
  async () => {
    await as(bia);
    await rejects(
      () => rpc("set_task_checklist_required", [task, true]),
      /Só quem edita/,
    );
    await as(eva);
    const updated = await rpc("set_task_checklist_required", [task, true]);
    assert.equal(updated.checklist_required, true);
    assert.equal((await row()).version, updated.version);
    // A Revisão tem "Ortografia" em aberto.
    await as(bia);
    await rejects(
      async () =>
        rpc("transition_task", [
          task,
          (await row()).version,
          "move",
          "",
          "review",
          eva,
        ]),
      /Conclua o checklist antes de entregar: 1 item em aberto/,
    );
    // Em andamento continua livre.
    await as(bia);
    const l = await lists();
    await as(bia);
    await rpc("set_checklist_item_done", [item(l[0], "Ortografia").id, true]);
    await as(bia);
    const moved = await rpc("transition_task", [
      task,
      (await row()).version,
      "move",
      "",
      "review",
      eva,
    ]);
    assert.equal(moved.status, "review");
    // Desmarcado em validação, a aprovação também espera.
    await as(bia);
    await rpc("set_checklist_item_done", [item(l[0], "Ortografia").id, false]);
    await as(eva);
    await rejects(
      async () =>
        rpc("transition_task", [
          task,
          (await row()).version,
          "approve_internal",
          "Tudo certo por aqui",
        ]),
      /Conclua o checklist/,
    );
    await as(bia);
    await rpc("set_checklist_item_done", [item(l[0], "Ortografia").id, true]);
    const actions = (await log()).map((x) => x.action);
    assert.ok(actions.includes("required_on"));
  },
);

await check(
  "Histórico mostra o principal do registro, com o tipo",
  async () => {
    await as(bia);
    const events = (await rpc("task_extras", [task])).events.filter(
      (e) => e.action === "checklist",
    );
    const kinds = new Set(events.map((e) => e.detail.kind));
    assert.ok(
      kinds.has("item_checked") &&
        kinds.has("checklist_completed") &&
        kinds.has("required_on"),
    );
    assert.ok(!kinds.has("item_added") && !kinds.has("item_edited"));
    await as(bia);
    const full = (
      await db.query("select * from public.task_checklist_history($1)", [task])
    ).rows;
    assert.ok(full.some((x) => x.action === "item_added"));
    // O aviso ao vivo vai para quem está na tarefa.
    const [notice] = await sql(
      "select payload from realtime.messages where payload->>'kind'='extras' and payload->>'task'=$1 order by id desc limit 1",
      [task],
    );
    assert.ok(notice.payload.users.includes(bia));
  },
);

let model;
await check(
  "modelos: só gestores montam; qualquer um aplica; Nova tarefa aplica junto com a exigência",
  async () => {
    await as(bia);
    await rejects(
      () =>
        rpc("save_checklist_template", [
          A,
          null,
          "Entrega",
          "[]",
          null,
          null,
          true,
        ]),
      /Somente administradores/,
    );
    await as(admin);
    await rejects(
      () =>
        rpc("save_checklist_template", [
          A,
          null,
          "Entrega",
          "[]",
          null,
          null,
          true,
        ]),
      /ao menos um item/,
    );
    await as(admin);
    model = await rpc("save_checklist_template", [
      A,
      null,
      "Entrega",
      JSON.stringify([
        { title: "Exportar PNG", children: [{ title: "1080x1080" }] },
        { title: "Subir no Drive" },
      ]),
      product,
      null,
      true,
    ]);
    await as(eva);
    const other = await rpc("create_task", [
      A,
      contract,
      "Outro post",
      bia,
      today,
      null,
      null,
      "Arte",
      "normal",
      60,
      false,
      null,
      null,
      "{}",
      null,
    ]);
    await as(eva);
    const l = await rpc("apply_checklist_templates", [other, [model], true]);
    assert.equal(l[0].title, "Entrega");
    assert.equal(l[0].template_id, model);
    assert.equal(l[0].items.length, 3);
    assert.equal((await row(other)).checklist_required, true);
    // A responsável aplica outro modelo, mas não mexe na exigência.
    await as(bia);
    assert.equal(
      (await rpc("apply_checklist_templates", [other, [model], null])).length,
      2,
    );
    await as(bia);
    await rejects(
      () => rpc("apply_checklist_templates", [other, [], false]),
      /Só quem edita/,
    );
    // O modelo pode sair: as tarefas ficam com a cópia.
    await as(admin);
    await rpc("delete_checklist_template", [model]);
    assert.equal((await lists(bia, other)).length, 2);
  },
);

await check(
  "modelos por cliente e projeto: o projeto precisa ser do cliente e do produto",
  async () => {
    await as(admin);
    const other = await rpc("create_client", [A, "Cliente Y", "", [design]]);
    const otherProduct = await rpc("create_product", [A, "Tráfego"]);
    const [{ id: project }] = await sql(
      "insert into projects(company_id,contract_id,name) values($1,$2,'Lançamento') returning id",
      [A, contract],
    );
    const items = JSON.stringify([{ title: "Conferir" }]);
    await as(admin);
    const id = await rpc("save_checklist_template", [
      A,
      null,
      "Lançamento",
      items,
      product,
      null,
      true,
      client,
      project,
    ]);
    const [row] = await sql(
      "select client_id, project_id from checklist_templates where id=$1",
      [id],
    );
    assert.deepEqual(row, { client_id: client, project_id: project });
    await as(admin);
    await rejects(
      () =>
        rpc("save_checklist_template", [
          A,
          null,
          "Errado",
          items,
          null,
          null,
          true,
          other,
          project,
        ]),
      /outro cliente ou produto/,
    );
    await as(admin);
    await rejects(
      () =>
        rpc("save_checklist_template", [
          A,
          null,
          "Errado",
          items,
          otherProduct,
          null,
          true,
          null,
          project,
        ]),
      /outro cliente ou produto/,
    );
    // Só o cliente, sem projeto, também vale.
    await as(admin);
    await rpc("save_checklist_template", [
      A,
      id,
      "Lançamento",
      items,
      null,
      null,
      true,
      client,
      null,
    ]);
    const [after] = await sql(
      "select client_id, project_id, product_id from checklist_templates where id=$1",
      [id],
    );
    assert.deepEqual(after, {
      client_id: client,
      project_id: null,
      product_id: null,
    });
    // O app da versão anterior (sem cliente e projeto) continua salvando.
    await as(admin);
    await rpc("save_checklist_template", [
      A,
      id,
      "Lançamento",
      items,
      product,
      null,
      true,
    ]);
  },
);

await check(
  "a repetição copia os checklists sem marcações, e a exigência",
  async () => {
    const src = await row();
    const next = (
      await sql(
        "select next_run::text as d from task_recurrences where id=$1",
        [src.recurrence_id],
      )
    )[0].d;
    assert.equal(
      (
        await sql("select mavi_private.run_task_recurrences($1::date) as n", [
          next,
        ])
      )[0].n,
      1,
    );
    const [copy] = await sql(
      "select * from tasks where recurrence_id=$1 and id<>$2",
      [src.recurrence_id, task],
    );
    assert.equal(copy.checklist_required, true);
    const original = await lists(bia, task);
    const copied = await lists(bia, copy.id);
    assert.deepEqual(
      copied.map((l) => l.title),
      original.map((l) => l.title),
    );
    for (const [i, l] of copied.entries()) {
      assert.equal(l.items.length, original[i].items.length);
      assert.ok(l.items.every((x) => !x.done && !x.done_by));
      assert.equal(l.completed_at, null);
      const parents = l.items.filter((x) => !x.parent_id).length;
      assert.equal(
        parents,
        original[i].items.filter((x) => !x.parent_id).length,
      );
    }
  },
);

console.log(`${passed} checks passed`);

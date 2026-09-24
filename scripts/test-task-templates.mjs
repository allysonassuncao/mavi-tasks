// Task templates (migration 20260929130000_task_templates): who configures
// them, which apply to a task, and how values are checked and kept.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, manager, designer, writer] = [1, 10, 11, 12, 13].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, manager, designer, writer],
]);
await db.query(`insert into companies(id,name) values($1,'Empresa A')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$2,'Ana Admin','admin'),($1,$3,'Gil Gestor','manager'),
   ($1,$4,'Dani Design','member'),($1,$5,'Rui Redação','member')`,
  [A, admin, manager, designer, writer],
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

await as(admin);
const design = await rpc("create_team", [A, "Design", [designer]]);
const copy = await rpc("create_team", [A, "Redação", [writer]]);
const client = await rpc("create_client", [A, "Cliente A", "", [design, copy]]);
const ads = await rpc("create_product", [A, "Make Ads"]);
const crm = await rpc("create_product", [A, "Make CRM"]);
const adsContract = await rpc("create_contract", [
  A,
  client,
  ads,
  "Ads A",
  null,
]);
const crmContract = await rpc("create_contract", [
  A,
  client,
  crm,
  "CRM A",
  null,
]);

const save = (name, product, team, fields, id = null) =>
  rpc("save_task_template", [
    A,
    id,
    name,
    product,
    team,
    JSON.stringify(fields),
    true,
  ]);
const briefing = [
  { id: "briefing", label: "Link do briefing", type: "url", required: true },
  {
    id: "formato",
    label: "Formato",
    type: "select",
    required: true,
    options: ["Feed", "Stories", "Reels"],
  },
  {
    id: "pecas",
    label: "Quantidade de peças",
    type: "number",
    required: false,
  },
];
const designOnly = [
  { id: "paleta", label: "Paleta aprovada", type: "checkbox", required: true },
  {
    id: "redes",
    label: "Redes",
    type: "multiselect",
    required: false,
    options: ["Instagram", "TikTok", "LinkedIn"],
  },
  { id: "entrega", label: "Entrega ao cliente", type: "date", required: false },
];

await check("colaborador não configura templates", async () => {
  await as(designer);
  await assert.rejects(
    () => save("Tentativa", ads, null, briefing),
    /administradores e gestores/,
  );
});

await check("template precisa de produto ou equipe", async () => {
  await as(admin);
  await assert.rejects(
    () => save("Solto", null, null, briefing),
    /produto, uma equipe/,
  );
});

await check("campos inválidos são recusados", async () => {
  await as(admin);
  await assert.rejects(
    () =>
      save("Sem opções", ads, null, [
        { id: "x", label: "Lista", type: "select", required: false },
      ]),
    /Revise os campos/,
  );
  await as(admin);
  await assert.rejects(
    () =>
      save("Repetido", ads, null, [
        { id: "a", label: "A", type: "text", required: false },
        { id: "a", label: "B", type: "text", required: false },
      ]),
    /Revise os campos/,
  );
});

await as(admin);
const adsTemplate = await save("Criativos de Ads", ads, null, briefing);
await as(manager);
const designTemplate = await save("Padrão Design", null, design, designOnly);

const fieldsFor = async (contract, assignee) =>
  (
    await sql("select mavi_private.template_fields_for($1,$2,$3) as f", [
      A,
      contract,
      assignee,
    ])
  )[0].f;

await check("gestor também configura; os dois templates se somam", async () => {
  const f = await fieldsFor(adsContract, designer);
  assert.deepEqual(
    f.map((x) => `${x.template_name}:${x.id}`),
    [
      "Criativos de Ads:briefing",
      "Criativos de Ads:formato",
      "Criativos de Ads:pecas",
      "Padrão Design:paleta",
      "Padrão Design:redes",
      "Padrão Design:entrega",
    ],
  );
});

await check("só o do produto vale para quem não é da equipe", async () => {
  const f = await fieldsFor(adsContract, writer);
  assert.deepEqual(
    [...new Set(f.map((x) => x.template_name))],
    ["Criativos de Ads"],
  );
});

await check("só o da equipe vale em outro produto", async () => {
  const f = await fieldsFor(crmContract, designer);
  assert.deepEqual(
    [...new Set(f.map((x) => x.template_name))],
    ["Padrão Design"],
  );
});

const create = (contract, assignee, custom) =>
  rpc("create_task", [
    A,
    contract,
    "Campanha de lançamento",
    assignee,
    "2026-10-10",
    null,
    null,
    "",
    "normal",
    0,
    false,
    null,
    null,
    JSON.stringify(custom),
  ]);
const key = (t, f) => `${t}.${f}`;

await check("campo obrigatório vazio impede criar a tarefa", async () => {
  await as(admin);
  await assert.rejects(
    () =>
      create(adsContract, writer, { [key(adsTemplate, "formato")]: "Feed" }),
    /Preencha o campo obrigatório "Link do briefing"/,
  );
});

await check("valores fora do tipo são recusados", async () => {
  await as(admin);
  await assert.rejects(
    () =>
      create(adsContract, writer, {
        [key(adsTemplate, "briefing")]: "sem-link",
        [key(adsTemplate, "formato")]: "Feed",
      }),
    /Informe um link/,
  );
  await as(admin);
  await assert.rejects(
    () =>
      create(adsContract, writer, {
        [key(adsTemplate, "briefing")]: "https://docs.example/b",
        [key(adsTemplate, "formato")]: "Outdoor",
      }),
    /Escolha uma opção da lista/,
  );
});

let task;
await check("tarefa guarda campos e valores preenchidos", async () => {
  await as(designer);
  task = await create(adsContract, designer, {
    [key(adsTemplate, "briefing")]: "https://docs.example/b",
    [key(adsTemplate, "formato")]: "Reels",
    [key(adsTemplate, "pecas")]: "3",
    [key(designTemplate, "paleta")]: true,
    [key(designTemplate, "redes")]: ["TikTok", "Instagram", "TikTok"],
    [key(designTemplate, "entrega")]: "2026-10-08",
    "chave.estranha": "ignorada",
  });
  const [{ custom_fields: cf }] = await sql(
    "select custom_fields from tasks where id=$1",
    [task],
  );
  const value = Object.fromEntries(cf.map((f) => [f.id, f.value]));
  assert.deepEqual(value, {
    briefing: "https://docs.example/b",
    formato: "Reels",
    pecas: 3,
    paleta: true,
    redes: ["Instagram", "TikTok"],
    entrega: "2026-10-08",
  });
  assert.equal(cf[0].template_name, "Criativos de Ads");
  assert.equal(cf[0].label, "Link do briefing");
});

await check("tarefas sem template continuam sem campos", async () => {
  await as(admin);
  await rpc("delete_task_template", [designTemplate]);
  await as(admin);
  const plain = await create(crmContract, writer, {});
  const [{ custom_fields }] = await sql(
    "select custom_fields from tasks where id=$1",
    [plain],
  );
  assert.deepEqual(custom_fields, []);
});

await check("mudar o template não altera tarefas já criadas", async () => {
  await as(admin);
  await save(
    "Criativos de Ads",
    ads,
    null,
    [{ id: "outro", label: "Campo novo", type: "text", required: true }],
    adsTemplate,
  );
  const [{ custom_fields: cf }] = await sql(
    "select custom_fields from tasks where id=$1",
    [task],
  );
  assert.equal(
    cf.length,
    6,
    "a tarefa mantém os 6 campos, inclusive do template removido",
  );
  assert.ok(!cf.some((f) => f.id === "outro"));
});

const version = async () =>
  (await sql("select version, status from tasks where id=$1", [task]))[0];

await check(
  "quem edita a tarefa altera os valores, sem mexer no status",
  async () => {
    const before = await version();
    await as(designer); // o criador desta tarefa
    const updated = await rpc("set_task_custom_fields", [
      task,
      before.version,
      JSON.stringify({
        [key(adsTemplate, "briefing")]: "https://docs.example/novo",
        [key(adsTemplate, "formato")]: "Feed",
        [key(designTemplate, "paleta")]: true,
      }),
    ]);
    assert.equal(updated.status, before.status);
    const v = Object.fromEntries(
      updated.custom_fields.map((f) => [f.id, f.value]),
    );
    assert.equal(v.briefing, "https://docs.example/novo");
    assert.equal(v.pecas, null, "campo não enviado fica vazio");
    const [ev] = await sql(
      "select action from task_events where task_id=$1 order by created_at desc limit 1",
      [task],
    );
    assert.equal(ev.action, "fields_edited");
  },
);

await check("a edição também respeita os obrigatórios", async () => {
  const { version: v } = await version();
  await as(designer);
  await assert.rejects(
    () =>
      rpc("set_task_custom_fields", [
        task,
        v,
        JSON.stringify({ [key(adsTemplate, "formato")]: "Feed" }),
      ]),
    /obrigatório/,
  );
});

await check("quem não edita a tarefa não altera os valores", async () => {
  const { version: v } = await version();
  await as(writer);
  await assert.rejects(
    () => rpc("set_task_custom_fields", [task, v, JSON.stringify({})]),
    /Sem permissão/,
  );
});

await check("apps antigos criam tarefas sem enviar campos", async () => {
  await as(admin);
  const legacy = await rpc("create_task", [
    A,
    crmContract,
    "Sem campos",
    writer,
    "2026-10-10",
    null,
    null,
    "",
    "normal",
    0,
    false,
    null,
    null,
  ]);
  assert.ok(legacy);
});

await db.close();
console.log(`\n${passed} verificações de templates de tarefa aprovadas.`);

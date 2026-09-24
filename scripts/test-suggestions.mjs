// Sugestões (migration 20260929170000_suggestions): anyone suggests a
// feature or reports a bug, and it becomes a task for the P&D team.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, dev, seller, outsider] = [1, 2, 10, 11, 12, 13].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, dev, seller, outsider],
]);
await db.query(
  `insert into companies(id,name) values($1,'Empresa A'),($2,'Empresa B')`,
  [A, B],
);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$3,'Ana Admin','admin'),($1,$4,'Davi Dev','member'),
   ($1,$5,'Sara Vendas','member'),($2,$6,'Outra Empresa','admin')`,
  [A, B, admin, dev, seller, outsider],
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

// P&D serves the internal client; sales serves a customer.
await as(admin);
const pd = await rpc("create_team", [A, "P&D", [dev]]);
const sales = await rpc("create_team", [A, "Comercial", [seller]]);
const internal = await rpc("create_client", [A, "Interno", ""]);
const customer = await rpc("create_client", [A, "Cliente X", ""]);
const product = await rpc("create_product", [A, "Plataforma"]);
const pdContract = await rpc("create_contract", [
  A,
  internal,
  product,
  "Produto interno",
  pd,
]);
const salesContract = await rpc("create_contract", [
  A,
  customer,
  product,
  "Contrato X",
  sales,
]);
const roadmap = await rpc("create_project", [A, pdContract, "Roadmap", null]);
const suggest = (user, kind, title, assignee = dev) =>
  as(user).then(() =>
    rpc("submit_suggestion", [A, kind, title, "Detalhes", assignee]),
  );

await check("sem configuração a sugestão explica o que falta", async () => {
  await assert.rejects(
    suggest(seller, "bug", "Botão quebrado"),
    /equipe de P&D/,
  );
});

await check("só gestores configuram as sugestões", async () => {
  await as(seller);
  await assert.rejects(
    rpc("save_suggestion_settings", [A, pd, pdContract, null]),
    /Sem permissão/,
  );
});

await check("P&D precisa atender o cliente do destino", async () => {
  await as(admin);
  await assert.rejects(
    rpc("save_suggestion_settings", [A, pd, salesContract, null]),
    /precisa atender/,
  );
});

await check("gestor escolhe equipe, produto e projeto", async () => {
  await as(admin);
  await rpc("save_suggestion_settings", [A, pd, pdContract, roadmap]);
  await as(seller);
  const { rows } = await db.query(
    "select team_id,contract_id,project_id from suggestion_settings",
  );
  assert.deepEqual(rows, [
    { team_id: pd, contract_id: pdContract, project_id: roadmap },
  ]);
});

await check(
  "qualquer membro cria a tarefa, mesmo sem acesso ao cliente",
  async () => {
    await as(seller);
    await assert.rejects(
      rpc("create_task", [
        A,
        pdContract,
        "Direto",
        dev,
        "2026-10-05",
        null,
        null,
        "",
        "normal",
        0,
        false,
      ]),
      /Sem acesso/,
    );
    const id = await suggest(seller, "bug", "  Relatório não abre  ");
    const [t] = await sql("select * from tasks where id=$1", [id]);
    assert.equal(t.title, "Relatório não abre");
    assert.equal(t.creator_id, seller);
    assert.equal(t.assignee_id, dev);
    assert.equal(t.team_id, pd);
    assert.equal(t.contract_id, pdContract);
    assert.equal(t.project_id, roadmap);
    assert.equal(t.priority, "high");
    assert.equal(t.description, "Detalhes");
  },
);

await check("bug vence em 2 dias; funcionalidade em 1 semana", async () => {
  const bug = await suggest(seller, "bug", "Erro ao salvar");
  const feature = await suggest(seller, "feature", "Exportar em PDF");
  const [b, f] = await sql(
    "select (due_date-current_date) as days,priority from tasks where id=any($1) order by priority",
    [[bug, feature]],
  );
  assert.deepEqual(b, { days: 2, priority: "high" });
  assert.deepEqual(f, { days: 7, priority: "normal" });
});

await check("quem sugeriu vê a tarefa e pode anexar arquivos", async () => {
  const id = await suggest(seller, "feature", "Modo escuro");
  await as(seller);
  const { rows } = await db.query("select id from tasks where id=$1", [id]);
  assert.equal(rows.length, 1);
  const file = await rpc("prepare_attachment", [id, "print.png", 1234]);
  assert.equal(file.task_id, id);
});

await check("responsável recebe o aviso de nova tarefa", async () => {
  const id = await suggest(seller, "feature", "Atalhos de teclado");
  const rows = await sql(
    "select actor_id from notifications where user_id=$1 and task_id=$2 and kind='assigned'",
    [dev, id],
  );
  assert.deepEqual(rows, [{ actor_id: seller }]);
});

await check("responsável precisa ser da equipe de P&D", async () => {
  await assert.rejects(
    suggest(seller, "bug", "Tela branca", admin),
    /equipe de P&D/,
  );
});

await check("tipo precisa ser funcionalidade ou bug", async () => {
  await assert.rejects(suggest(seller, "elogio", "Muito bom"), /Escolha/);
});

await check("quem é de outra empresa não envia", async () => {
  await assert.rejects(suggest(outsider, "bug", "Tentativa"), /Sem permissão/);
});

await check("histórico marca a tarefa como sugestão", async () => {
  const id = await suggest(seller, "bug", "Filtro some");
  const [e] = await sql(
    "select actor_id,action,detail from task_events where task_id=$1",
    [id],
  );
  assert.deepEqual(e, {
    actor_id: seller,
    action: "created",
    detail: { suggestion: "bug" },
  });
});

await check("campo obrigatório de template fica para o P&D", async () => {
  await as(admin);
  await rpc("save_task_template", [
    A,
    null,
    "Triagem",
    null,
    pd,
    JSON.stringify([
      { id: "impacto", label: "Impacto", type: "text", required: true },
    ]),
    true,
  ]);
  const id = await suggest(seller, "bug", "Lentidão no painel");
  const [t] = await sql("select custom_fields from tasks where id=$1", [id]);
  assert.equal(t.custom_fields.length, 1);
  assert.equal(t.custom_fields[0].required, true);
  assert.equal(t.custom_fields[0].value, null);
});

console.log(`\n${passed} verificações de sugestões passaram.`);

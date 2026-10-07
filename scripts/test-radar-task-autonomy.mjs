// Radar do cliente: a MAVI abre a tarefa sozinha (migration
// 20270609090000_radar_task_autonomy, Fase 4): a MAVI da empresa pelo e-mail,
// liberar por tópico × produto (só líderes), o acerto na janela e o limite, a
// tarefa criada em nome da MAVI (equipe, prazo, descrição, item, registro,
// aviso no sino), o teto por cliente por dia, desfazer em 24 h com motivo
// (arquiva, tira do item, conta como erro), a origem na tarefa e o que volta
// a ser só sugestão (campo obrigatório no modelo, sem a MAVI).
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, member, manager, other, mavi] = [1, 10, 11, 13, 14, 19].map(uid);
const SECRET = "s".repeat(40);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [[admin, member, manager, other, mavi]]);
await db.query(`insert into companies(id,name) values($1,'Make')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,email,role,active) values
   ($1,$2,'Ana Admin','ana@make.com','admin',true),($1,$3,'Bruno Tráfego','bruno@make.com','member',true),
   ($1,$4,'Gabi Gestora','gabi@make.com','manager',true),($1,$5,'Duda Design','duda@make.com','member',true),
   ($1,$6,'MAVI','MCC@makevendas.com.br','member',true)`,
  [A, admin, member, manager, other, mavi],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user ?? ""]);
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
async function rejects(fn, pattern) {
  await assert.rejects(fn, (e) => pattern.test(e.message));
  await db.exec("reset role");
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

await sql(`insert into mavi_private.ai_config(url, secret) values('https://app.example/api/ai', $1)`, [SECRET]);
await as(admin);
const traffic = await rpc("create_team", [A, "Tráfego", [member], [manager]]);
const design = await rpc("create_team", [A, "Design", [other], []]);
const client = await rpc("create_client", [A, "Clínica Sorriso", "", [traffic, design]]);
const client2 = await rpc("create_client", [A, "Padaria Pão Quente", "", [traffic]]);
const ads = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [A, client, ads, "Make Ads · Clínica", traffic]);
await rpc("create_contract", [A, client2, ads, "Make Ads · Padaria", traffic]);
await rpc("radar_overview", [A]);
const [topic] = await sql(`select id, statuses from radar_topics where company_id = $1 and key = 'problemas'`, [A]);
const newItem = async (title, c = client, assignee = null) =>
  (
    await sql(
      `insert into radar_items(company_id, client_id, topic_id, product_id, title, summary, status, severity, assignee_id)
       values ($1,$2,$3,$4,$5,'O cliente reclamou.',$6,2,$7) returning id`,
      [A, c, topic.id, ads, title, topic.statuses[0].key, assignee],
    )
  )[0].id;
const sug = async (item) => (await sql(`select * from radar_task_suggestions where item_id = $1`, [item]))[0];
// A MAVI decide "abrir tarefa" pela regra (como o worker faria).
async function decide(item, extra = {}) {
  await as(null);
  const claimed = await rpc("ai_radar_task_suggest_claim", [SECRET, 10]);
  assert.ok(claimed.some((c) => c.item === item), "o item estava na fila");
  return rpc("ai_radar_task_suggest_store", [SECRET, item, JSON.stringify({ decision: "task", rule_id: rule.id,
    title: "Corrigir o problema — Clínica Sorriso", description: "Refazer o que quebrou.\nTestar com o cliente.",
    team_id: traffic, due_days: 2, ...extra }), "{}"]);
}

await as(manager);
await rpc("set_radar_task_suggest", [A, true]);
await as(manager);
const rule = await rpc("save_radar_task_rule", [A, null, JSON.stringify({ topic_id: topic.id, product_id: ads, action: "task",
  condition: "Problema que trava a captação", team_id: traffic, due_days: 2, priority: "high" })]);

await check("a MAVI da empresa vem pelo e-mail; limites de fábrica", async () => {
  const [s] = await sql(`select mavi_user_id, autonomy_rate, autonomy_min, autonomy_days, autonomy_cap from radar_task_settings`);
  assert.equal(s.mavi_user_id, null, "a empresa foi criada depois da migração");
  assert.equal((await sql(`select mavi_private.radar_mavi_user($1) as u`, [A]))[0].u, mavi, "pelo e-mail, sem diferença de caixa");
  assert.deepEqual([s.autonomy_rate, s.autonomy_min, s.autonomy_days, s.autonomy_cap], [90, 10, 30, 3]);
});

await check("liberar: só líderes; sem acerto suficiente, continua só sugerindo (com o motivo)", async () => {
  await as(member);
  await rejects(() => rpc("set_radar_task_autonomy", [A, topic.id, ads, true]), /Só administradores e gestores/);
  await as(manager);
  await rpc("set_radar_task_autonomy", [A, topic.id, ads, true]);
  const item = await newItem("Pixel fora do ar");
  assert.equal(await decide(item), "open");
  const s = await sug(item);
  assert.match(s.auto_note, /Poucas sugestões decididas nos últimos 30 dias \(0 de 10\)/);
  await as(manager);
  assert.match((await rpc("radar_task_suggestion", [A, item])).auto_note, /Poucas sugestões/);
});

await check("o acerto: aceitas como vieram ÷ decididas; abaixo do limite não cria", async () => {
  await as(member);
  await rejects(() => rpc("save_radar_task_autonomy_settings", [A, 80, 3, 30, 2]), /Só administradores e gestores/);
  await as(admin);
  await rejects(() => rpc("save_radar_task_autonomy_settings", [A, 40, 3, 30, 2]), /50% a 100%/);
  // 3 aceitas como vieram e 1 recusada: 75% (com o mínimo de fábrica, 10, a MAVI só sugere).
  for (const [n, how] of [[1, "ok"], [2, "ok"], [3, "ok"], [4, "no"]]) {
    const item = await newItem(`Caso ${n}`);
    await decide(item);
    if (how === "ok") {
      const [t] = await sql(`insert into tasks(company_id, contract_id, title, creator_id, assignee_id, due_date, original_due_date, team_id, priority)
        values ($1,$2,'Tarefa aceita',$3,$4,$5,$5,$6,'high') returning id`,
        [A, contract, manager, member, (await sug(item)).due_date, traffic]);
      await as(manager);
      await rpc("radar_task_created", [A, item, t.id, JSON.stringify({ title: "Tarefa aceita", contract,
        due: (await sug(item)).due_date.toISOString().slice(0, 10), team: traffic, priority: "high", suggestion: "1" })]);
    } else {
      await as(manager);
      await rpc("radar_task_suggestion_dismiss", [A, item, "wrong_due", ""]);
    }
  }
  const [h] = await sql(`select * from mavi_private.radar_task_hit($1,$2,$3,30)`, [A, topic.id, ads]);
  assert.deepEqual([h.decided, h.hits, h.rate], [4, 3, 75]);
  await as(admin);
  await rpc("save_radar_task_autonomy_settings", [A, 75, 3, 30, 2]);
  await as(admin);
  await rpc("save_radar_task_autonomy_settings", [A, 80, 3, 30, 2]);
  const item = await newItem("Abaixo do limite");
  assert.equal(await decide(item), "open");
  assert.match((await sug(item)).auto_note, /Acerto de 75%, abaixo do limite de 80%/);
  await as(admin);
  await rpc("save_radar_task_autonomy_settings", [A, 75, 3, 30, 2]);
});

let auto;
await check("no limite: a MAVI cria a tarefa sozinha, em nome dela, ligada ao item, e avisa no sino", async () => {
  auto = await newItem("Formulário quebrado", client, other);
  assert.equal(await decide(auto, { priority: "urgent" }), "auto");
  const s = await sug(auto);
  assert.deepEqual([s.status, s.decided_by], ["auto", mavi]);
  const [t] = await sql(`select * from tasks where id = $1`, [s.task_id]);
  assert.deepEqual([t.creator_id, t.assignee_id, t.team_id, t.contract_id, t.priority, t.title, t.archived],
    [mavi, member, traffic, contract, "urgent", "Corrigir o problema — Clínica Sorriso", false]);
  assert.equal(t.due_date.toISOString().slice(0, 10), s.due_date.toISOString().slice(0, 10));
  assert.ok(t.description.startsWith("mavi:richtext:v1:"));
  const doc = JSON.parse(t.description.slice("mavi:richtext:v1:".length));
  const text = JSON.stringify(doc);
  assert.ok(text.includes("Refazer o que quebrou.") && text.includes("O cliente reclamou.") && text.includes(`/radar?item=${auto}`));
  const [link] = await sql(`select created_by from radar_item_tasks where item_id = $1 and task_id = $2`, [auto, t.id]);
  assert.equal(link.created_by, mavi);
  const [g] = await sql(`select kind, user_id, from_suggestion, rule_id from radar_task_signals where item_id = $1 and task_id = $2`, [auto, t.id]);
  assert.deepEqual([g.kind, g.user_id, g.from_suggestion, g.rule_id], ["created", mavi, true, rule.id]);
  const notes = await sql(`select user_id, actor_id, kind, title, link, task_id from notifications where company_id = $1 order by created_at`, [A]);
  const bell = notes.find((n) => n.kind === "radar_task_auto");
  assert.deepEqual([bell.user_id, bell.actor_id, bell.link], [other, mavi, `/radar?item=${auto}`], "ao responsável do item");
  assert.match(bell.title, /A MAVI criou uma tarefa pelo Radar/);
  const assigned = notes.find((n) => n.kind === "assigned" && n.task_id === t.id);
  assert.deepEqual([assigned.user_id, assigned.actor_id], [member, mavi], "quem recebe a tarefa é avisado como sempre");
  const [ev] = await sql(`select actor_id, detail from task_events where task_id = $1 and action = 'created'`, [t.id]);
  assert.deepEqual([ev.actor_id, ev.detail.auto, ev.detail.radar_item], [mavi, true, auto]);
});

await check("a origem na tarefa e o desfazer: quem pode, motivo, 24 h; arquiva e conta como erro", async () => {
  const s = await sug(auto);
  await as(member);
  const o = await rpc("radar_task_origin", [A, s.task_id]);
  assert.deepEqual([o.item_id, o.auto, o.can_undo, o.rule_condition], [auto, true, true, "Problema que trava a captação"]);
  await as(other);
  assert.equal(await rpc("radar_task_origin", [A, s.task_id]), null, "quem não vê a tarefa");
  await as(other);
  await rejects(() => rpc("radar_task_auto_undo", [A, auto, "not_needed", ""]), /Sem permissão/);
  await as(member);
  await rejects(() => rpc("radar_task_auto_undo", [A, auto, "other", ""]), /Conte o motivo/);
  await as(member);
  const r = await rpc("radar_task_auto_undo", [A, auto, "wrong_person", "É com o Design"]);
  assert.equal(r.status, "undone");
  const [t] = await sql(`select archived from tasks where id = $1`, [s.task_id]);
  assert.equal(t.archived, true);
  assert.equal((await sql(`select count(*)::int as n from radar_item_tasks where item_id = $1`, [auto]))[0].n, 0);
  const signals = await sql(`select kind, removed_reason, final from radar_task_signals where item_id = $1 order by created_at`, [auto]);
  assert.deepEqual(signals.map((x) => [x.kind, x.removed_reason]), [["created", "undone"], ["dismissed", null]]);
  assert.equal(signals[1].final.auto, true);
  await as(member);
  await rejects(() => rpc("radar_task_auto_undo", [A, auto, "not_needed", ""]), /Não há tarefa criada pela MAVI/);
  const [h] = await sql(`select * from mavi_private.radar_task_hit($1,$2,$3,30)`, [A, topic.id, ads]);
  assert.deepEqual([h.decided, h.hits, h.rate], [5, 3, 60], "a desfeita conta como erro");
});

await check("depois de 24 h não desfaz; a criada sozinha que ficou conta como acerto", async () => {
  await as(admin);
  await rpc("save_radar_task_autonomy_settings", [A, 50, 3, 30, 5]);
  const item = await newItem("Página fora do ar");
  assert.equal(await decide(item), "auto");
  await sql(`update radar_task_suggestions set decided_at = now() - interval '25 hours' where item_id = $1`, [item]);
  await as(manager);
  await rejects(() => rpc("radar_task_auto_undo", [A, item, "not_needed", ""]), /24 horas/);
  await as(manager);
  const o = await rpc("radar_task_origin", [A, (await sug(item)).task_id]);
  assert.equal(o.can_undo, undefined);
  const [h] = await sql(`select * from mavi_private.radar_task_hit($1,$2,$3,30)`, [A, topic.id, ads]);
  assert.deepEqual([h.decided, h.hits], [6, 4]);
});

await check("teto por cliente por dia; outro cliente segue", async () => {
  await as(admin);
  await rpc("save_radar_task_autonomy_settings", [A, 50, 3, 30, 2]);
  // Hoje, Clínica Sorriso já tem 1 criada (a desfeita conta) — e a de 25 h atrás não.
  const a = await newItem("Mais um");
  assert.equal(await decide(a), "auto");
  const b = await newItem("Mais outro");
  assert.equal(await decide(b), "open");
  assert.match((await sug(b)).auto_note, /Teto de 2 tarefa/);
  const c = await newItem("Na padaria", client2);
  assert.equal(await decide(c), "auto");
});

await check("campo obrigatório no modelo, sem equipe ou sem a MAVI: fica para uma pessoa, com o motivo", async () => {
  await as(admin);
  await rpc("save_radar_task_autonomy_settings", [A, 50, 3, 30, 50]);
  await sql(`insert into task_templates(company_id, team_id, name, fields) values ($1,$2,'Briefing',
    '[{"id":"f1","label":"Link do briefing","type":"text","required":true}]')`, [A, traffic]);
  const item = await newItem("Precisa de briefing");
  assert.equal(await decide(item), "open");
  assert.match((await sug(item)).auto_note, /A MAVI não criou sozinha: .*Link do briefing/);
  assert.equal((await sql(`select count(*)::int as n from tasks where title = 'Corrigir o problema — Clínica Sorriso' and archived = false
    and id not in (select task_id from radar_task_suggestions where task_id is not null)`))[0].n, 0, "nada ficou pela metade");
  await sql(`delete from task_templates where company_id = $1`, [A]);
  const noTeam = await newItem("Sem equipe");
  assert.equal(await decide(noTeam, { team_id: null }), "open");
  assert.match((await sug(noTeam)).auto_note, /não tem equipe nem pessoa/);
  await sql(`update memberships set active = false where user_id = $1`, [mavi]);
  const off = await newItem("Sem a MAVI");
  assert.equal(await decide(off), "open");
  assert.match((await sug(off)).auto_note, /A MAVI não é membro ativo/);
  await sql(`update memberships set active = true where user_id = $1`, [mavi]);
  // Desligado no grupo: só sugere, sem motivo.
  await as(manager);
  await rpc("set_radar_task_autonomy", [A, topic.id, ads, false]);
  const quiet = await newItem("Desligado");
  assert.equal(await decide(quiet), "open");
  assert.equal((await sug(quiet)).auto_note, null);
});

await check("os números do Painel: criadas sozinhas, desfeitas e a autonomia de cada grupo", async () => {
  await as(manager);
  await rpc("set_radar_task_autonomy", [A, topic.id, ads, true]);
  await as(member);
  await rejects(() => rpc("radar_task_suggestion_stats", [A, "{}"]), /Sem permissão/);
  await as(manager);
  const r = await rpc("radar_task_suggestion_stats", [A, "{}"]);
  assert.deepEqual([r.settings.mavi_name, r.settings.autonomy_rate, r.settings.autonomy_cap], ["MAVI", 50, 50]);
  const g = r.groups.find((x) => x.topic_id === topic.id);
  assert.deepEqual([g.auto, g.undone], [3, 1]);
  assert.equal(g.autonomy.enabled, true);
  assert.equal(g.autonomy.enabled_by_name, "Gabi Gestora");
  assert.equal(g.autonomy.active, true);
  assert.ok(g.autonomy.decided >= 6);
});

console.log(`\n${passed} checks passed`);
await db.close?.();

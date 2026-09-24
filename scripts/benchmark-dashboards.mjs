// Dashboards under load: one company with 150k tasks and 400k time entries
// (plus another company of the same size that must not slow it down).
// Times each kind of panel through dashboard_preview, as a leader.
// PGlite runs PostgreSQL in WebAssembly on one thread: absolute times are
// several times slower than a hosted database; compare them with each other.
import { createTestDatabase } from "./database-fixture.mjs";

const TASKS = Number(process.env.TASKS ?? 150000);
const ENTRIES = Number(process.env.ENTRIES ?? 400000);
const db = await createTestDatabase();
const id = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin] = [id(1), id(2), id(10)];
const started = Date.now();
await db.query(`insert into auth.users(id) select $1::uuid`, [admin]);
await db.query(
  `insert into auth.users(id) select ('30000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,50) n`,
);
await db.query(
  `insert into companies(id,name) values($1,'Carga A'),($2,'Carga B')`,
  [A, B],
);
await db.query(
  `insert into memberships(company_id,user_id,name,role)
   select c, $3::uuid, 'Admin', 'admin' from unnest(array[$1::uuid,$2::uuid]) c
   union all
   select c, ('30000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid, 'Pessoa '||n, 'member'
   from unnest(array[$1::uuid,$2::uuid]) c cross join generate_series(1,50) n`,
  [A, B, admin],
);
await db.exec(`
insert into clients(company_id,name) select c.id,'Cliente '||n from companies c cross join generate_series(1,200) n;
insert into products(company_id,name) select c.id,'Produto '||n from companies c cross join generate_series(1,5) n;
insert into teams(company_id,name) select c.id,'Equipe '||n from companies c cross join generate_series(1,8) n;
insert into contracts(company_id,client_id,product_id,name)
 select l.company_id,l.id,(select p.id from products p where p.company_id=l.company_id order by p.name limit 1 offset (abs(hashtext(l.id::text)) % 5)),'Contrato'
 from clients l cross join generate_series(1,2);`);
await db.query(
  `insert into tasks(company_id,contract_id,team_id,title,creator_id,assignee_id,due_date,original_due_date,status,internal_approved_by,delivered_at,created_at,estimated_minutes)
   select c.id, x.ks[1 + n % cardinality(x.ks)], x.ts[1 + n % cardinality(x.ts)], 'Tarefa',
     x.p[1 + n % cardinality(x.p)], x.p[1 + (n * 7) % cardinality(x.p)],
     d::date + (n % 20), d::date + (n % 20),
     case when n % 3 = 0 then 'done' else 'progress' end,
     case when n % 3 = 0 then x.p[1] end,
     case when n % 3 = 0 then d + ((n % 25) || ' days')::interval end,
     d, (n % 8) * 30
   from companies c
   cross join lateral (select
     (select array_agg(user_id order by user_id) from memberships where company_id = c.id) p,
     (select array_agg(id order by id) from contracts where company_id = c.id) ks,
     (select array_agg(id order by id) from teams where company_id = c.id) ts) x
   cross join lateral generate_series(1, $1::int) n
   cross join lateral (select now() - ((n % 730) || ' days')::interval - ((n % 24) || ' hours')::interval as d) dd`,
  [TASKS],
);
await db.query(
  `insert into time_entries(company_id,task_id,user_id,started_at,ended_at,source)
   select t.company_id, t.id, t.assignee_id, t.created_at + ((n % 5) || ' hours')::interval,
     t.created_at + ((n % 5) || ' hours')::interval + ((15 + n % 180) || ' minutes')::interval,
     case when n % 2 = 0 then 'timer' else 'manual' end
   from (select t.*, row_number() over (partition by company_id order by id) rn from tasks t) t
   cross join generate_series(1, 3) n
   where t.rn * 3 <= $1::int`,
  [ENTRIES],
);
await db.exec("analyze");
const counts = (
  await db.query(
    `select (select count(*) from tasks where company_id=$1)::int tasks, (select count(*) from time_entries where company_id=$1)::int entries`,
    [A],
  )
).rows[0];
console.log(
  `Carga: ${counts.tasks} tarefas e ${counts.entries} lançamentos na empresa A (e o mesmo na B), em ${Math.round((Date.now() - started) / 1000)} s.\n`,
);

await db.exec("reset role");
await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [admin]);
await db.exec("set role authenticated");
const today = new Date().toISOString().slice(0, 10);
const ago = (days) =>
  new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
const q = (ref, source, metric, extra = {}) => ({
  ref,
  source,
  metric,
  filters: [],
  ...extra,
});
const panels = [
  [
    "Stat: tarefas criadas em 30 dias + comparação",
    {
      viz: "stat",
      groupBy: "none",
      compare: true,
      queries: [q("A", "tasks", "count")],
    },
    30,
  ],
  [
    "Linha: entregas por dia, 30 dias",
    {
      viz: "line",
      groupBy: "time",
      interval: "day",
      queries: [q("A", "tasks", "count", { dateField: "delivered_at" })],
    },
    30,
  ],
  [
    "Barras: horas por semana, 1 ano",
    {
      viz: "bar",
      groupBy: "time",
      interval: "week",
      queries: [q("A", "hours", "hours")],
    },
    365,
  ],
  [
    "Top 10 clientes por horas, 1 ano",
    {
      viz: "hbar",
      groupBy: "client",
      limit: 10,
      queries: [q("A", "hours", "hours")],
    },
    365,
  ],
  [
    "Atrasadas por pessoa, 2 anos",
    {
      viz: "table",
      groupBy: "person",
      limit: 20,
      queries: [q("A", "tasks", "late", { dateField: "due_date" })],
    },
    730,
  ],
  [
    "Fórmula horas ÷ entregas por cliente (todos os grupos), 1 ano",
    {
      viz: "table",
      groupBy: "client",
      formula: { expr: "A / B", label: "Horas por entrega" },
      queries: [
        q("A", "hours", "hours"),
        q("B", "tasks", "count", { dateField: "delivered_at" }),
      ],
    },
    365,
  ],
  [
    "Prazo médio por mês, 2 anos",
    {
      viz: "line",
      groupBy: "time",
      interval: "month",
      queries: [
        q("A", "tasks", "lead_time_days", { dateField: "delivered_at" }),
      ],
    },
    730,
  ],
];
const results = [];
for (const [title, spec, days] of panels) {
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    await db.query(`select public.dashboard_preview($1,$2,$3,$4,'{}')`, [
      A,
      spec,
      ago(days - 1),
      today,
    ]);
    runs.push(performance.now() - t0);
  }
  const best = Math.min(...runs);
  results.push({ painel: title, "melhor (ms)": Math.round(best) });
}
console.table(results);

import { createTestDatabase } from "./database-fixture.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const db = await createTestDatabase();
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const company = id(1),
  other = id(2),
  admin = id(10),
  member = id(11),
  outsider = id(12);
await db.query(
  `insert into auth.users(id) select unnest($1::uuid[]);
`,
  [[admin, member, outsider]],
);
await db.query(
  `insert into companies(id,name) values($1,'Benchmark A'),($2,'Benchmark B')`,
  [company, other],
);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values($1,$3,'Admin','admin'),($1,$4,'Member','member'),($1,$5,'Isolated','member'),($2,$3,'Admin','admin')`,
  [company, other, admin, member, outsider],
);
await db.exec(`insert into clients(company_id,name) select id,'Client' from companies;
insert into products(company_id,name) select id,'Product' from companies;
insert into teams(company_id,name) select id,'Team' from companies;
insert into contracts(company_id,client_id,product_id,name) select c.id,l.id,p.id,'Contract '||n
from companies c join clients l on l.company_id=c.id join products p on p.company_id=c.id cross join generate_series(1,100) n;
insert into contract_teams(company_id,contract_id,team_id) select k.company_id,k.id,t.id from contracts k join teams t on t.company_id=k.company_id where k.name in ('Contract 1','Contract 2');`);
await db.query(
  `insert into team_members select company_id,id,$1 from teams where company_id=$2`,
  [member, company],
);
await db.query(
  `insert into tasks(company_id,contract_id,title,creator_id,assignee_id,due_date,original_due_date,status,internal_approved_by)
 select c.company_id,c.id,'Load task '||n,$1,$1,current_date-(n%90),current_date-(n%90),case when n%4=0 then 'done' else 'open' end,
 case when n%4=0 then $1::uuid else null end from contracts c cross join generate_series(1,250) n`,
  [admin],
);
await db.exec(`insert into task_events(company_id,task_id,actor_id,action,detail,created_at)
select company_id,id,creator_id,'benchmark',jsonb_build_object('to','done'),now()-n*interval '1 day' from tasks cross join generate_series(1,2) n;
analyze;`);
const newPolicy = (
  await db.query(
    "select qual from pg_policies where schemaname='public' and tablename='tasks' and policyname='tasks_read'",
  )
).rows[0].qual;
const results = [];
const queries = {
  list: `select id,due_date from tasks where company_id=$1 and not archived and status<>'done' and due_date<current_date order by due_date,id limit 50`,
  count: `select count(*) from tasks where company_id=$1 and not archived and status<>'done' and due_date<current_date`,
};
for (const phase of ["before", "after"]) {
  await db.exec(
    `reset role; alter policy tasks_read on tasks using (${phase === "before" ? "mavi_private.task_access(company_id,id)" : newPolicy});`,
  );
  for (const [role, user] of [
    ["admin", admin],
    ["member", member],
    ["isolated", outsider],
  ]) {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      user,
    ]);
    await db.exec("set role authenticated");
    for (const [query, sql] of Object.entries(queries)) {
      const output = (await db.query(sql, [company])).rows;
      const plan = (
        await db.query(`explain (analyze,buffers,format json) ${sql}`, [
          company,
        ])
      ).rows[0]["QUERY PLAN"][0];
      const result = {
        phase,
        role,
        query,
        result: output,
        execution_ms: plan["Execution Time"],
        plan,
      };
      results.push(result);
      console.log(
        `${phase} ${role} ${query}: ${result.execution_ms.toFixed(2)} ms`,
      );
    }
  }
}
for (const row of results.filter((r) => r.phase === "after")) {
  const previous = results.find(
    (r) => r.phase === "before" && r.role === row.role && r.query === row.query,
  );
  assert.deepEqual(row.result, previous.result, "RLS must preserve visibility");
}
await mkdir("docs", { recursive: true });
await writeFile(
  "docs/rls-benchmark.json",
  JSON.stringify(
    {
      environment:
        "Local PGlite PostgreSQL, synthetic data; not hosted production latency",
      tasks: 50000,
      events: 100000,
      companies: 2,
      contracts: 200,
      method:
        "Warm query then EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) as authenticated, same dataset and indexes, only tasks_read policy changed",
      results,
    },
    null,
    2,
  ) + "\n",
);
await db.close();

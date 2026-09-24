import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFile, readdir } from "node:fs/promises";

/**
 * PostgreSQL with every migration applied — or only those named before
 * `until` (e.g. to insert data a later migration must convert).
 */
export async function createTestDatabase({ until } = {}) {
  const db = new PGlite({ extensions: { pg_trgm, pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create schema storage; create schema extensions;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema auth,public,storage to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,created_at timestamptz not null default now());
alter table storage.objects enable row level security;grant select,insert,update,delete on storage.objects to authenticated;`);
  // Supabase Realtime, reduced to what migrations use: broadcast messages
  // land in realtime.messages, realtime.topic() is the topic being joined,
  // and supabase_realtime is the publication postgres_changes reads.
  await db.exec(`create schema realtime;
create table realtime.messages(id bigserial primary key,topic text not null,extension text not null default 'broadcast',event text,payload jsonb,private boolean,inserted_at timestamptz not null default now());
alter table realtime.messages enable row level security;
create function realtime.topic() returns text language sql stable as $$ select nullif(current_setting('realtime.topic',true),'') $$;
create function realtime.send(payload jsonb,event text,topic text,private boolean default true) returns void language sql as $$ insert into realtime.messages(topic,event,payload,private) values(topic,event,payload,private) $$;
grant usage on schema realtime to authenticated,anon;grant select on realtime.messages to authenticated;grant execute on function realtime.topic() to authenticated,anon;
create publication supabase_realtime;`);
  // pg_net, reduced to a log of the requests it would send.
  await db.exec(`create schema net;
create table net.requests(id bigserial primary key,url text,body jsonb,headers jsonb);
create function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds integer default 5000) returns bigint language sql as $$ insert into net.requests(url,body,headers) values(url,body,headers) returning id $$;`);
  for (const file of (await readdir("supabase/migrations")).sort())
    if (!until || file < until)
      await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
  return db;
}

/** Applies one migration file (see `until` above). */
export async function applyMigration(db, name) {
  const file = (await readdir("supabase/migrations")).find((f) =>
    f.startsWith(name),
  );
  await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
}

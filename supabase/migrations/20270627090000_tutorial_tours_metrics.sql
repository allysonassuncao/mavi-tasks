begin;

-- Onboarding, Fase 4: métricas por passo e "Isso ajudou?".
--
-- - Alcance: cada pessoa que chega a um passo (por versão) fica numa linha
--   de tutorial_tour_reach. Daí sai o funil: quantas chegaram a cada passo,
--   quantas pararam nele (fecharam o tour ali) e quantas vezes o elemento
--   não apareceu.
-- - "Isso ajudou?": um voto por pessoa (pode trocar), com motivo no 👎 (os
--   mesmos dos tutoriais) e um comentário; marcado com a versão.
-- - Métricas (tutorial_tour_metrics): só quem edita o onboarding, por versão
--   (a atual, se nenhuma for pedida).

create table public.tutorial_tour_reach (
 company_id uuid not null,
 tour_id uuid not null,
 version integer not null,
 step_id text not null,
 user_id uuid not null,
 first_at timestamptz not null default now(),
 primary key(tour_id, version, step_id, user_id),
 foreign key(company_id, tour_id) references public.tutorial_tours(company_id, id) on delete cascade
);
alter table public.tutorial_tour_reach enable row level security;
revoke all on public.tutorial_tour_reach from public, anon, authenticated;

create table public.tutorial_tour_feedback (
 company_id uuid not null,
 tour_id uuid not null,
 user_id uuid not null,
 version integer not null,
 vote text not null check (vote in ('up', 'down')),
 reason text check (reason in ('outdated', 'confusing', 'missing_step', 'not_what_i_wanted', 'other')),
 comment text not null default '' check (length(comment) <= 1000),
 updated_at timestamptz not null default now(),
 primary key(tour_id, user_id),
 check (vote = 'down' or reason is null),
 foreign key(company_id, tour_id) references public.tutorial_tours(company_id, id) on delete cascade
);
alter table public.tutorial_tour_feedback enable row level security;
revoke all on public.tutorial_tour_feedback from public, anon, authenticated;

-- ------------------------------------------------------------ progresso (com o alcance)
create or replace function public.set_tutorial_tour_progress(p_tour uuid, p_action text, p_step integer default 0,
 p_step_id text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.tutorial_tours; pr public.tutorial_tour_progress; v_step integer; v_id text; begin
 select * into t from public.tutorial_tours where id = p_tour;
 if not found or not mavi_private.member(t.company_id) or not mavi_private.tour_for_me(t) then return null; end if;
 if p_action not in ('start', 'step', 'complete', 'dismiss') then raise exception 'Ação inválida' using errcode = '22023'; end if;
 v_step := least(greatest(coalesce(p_step, 0), 0), greatest(jsonb_array_length(t.steps) - 1, 0));
 if p_action = 'start' then v_step := 0; end if;
 insert into public.tutorial_tour_progress as x(company_id, tour_id, user_id, version, status, step, step_id,
  completed_at, times_completed)
 values (t.company_id, t.id, auth.uid(), t.version,
  case p_action when 'complete' then 'completed' when 'dismiss' then 'dismissed' else 'started' end,
  v_step, left(coalesce(p_step_id, ''), 24),
  case when p_action = 'complete' then now() end, case when p_action = 'complete' then 1 else 0 end)
 on conflict (tour_id, user_id) do update set
  version = excluded.version,
  status = case when p_action = 'step' and x.status = 'completed' then 'completed' else excluded.status end,
  step = excluded.step, step_id = excluded.step_id,
  started_at = case when p_action = 'start' then now() else x.started_at end,
  completed_at = case when p_action = 'complete' then now() else x.completed_at end,
  times_completed = x.times_completed + case when p_action = 'complete' then 1 else 0 end,
  updated_at = now()
 returning * into pr;
 -- O passo a que a pessoa chegou (o id vem do onboarding, não de quem chama).
 if p_action in ('start', 'step', 'complete') then
  v_id := t.steps->v_step->>'id';
  if v_id is not null then
   insert into public.tutorial_tour_reach(company_id, tour_id, version, step_id, user_id)
   values (t.company_id, t.id, t.version, v_id, auth.uid()) on conflict do nothing;
  end if;
 end if;
 return jsonb_build_object('status', pr.status, 'step', pr.step, 'step_id', pr.step_id, 'version', pr.version,
  'completed_at', pr.completed_at);
end $$;

-- ------------------------------------------------------------ "Isso ajudou?"
-- p_vote nulo tira o voto. Devolve o voto (ou nulo).
create function public.vote_tutorial_tour(p_tour uuid, p_vote text, p_reason text default null,
 p_comment text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.tutorial_tours; f public.tutorial_tour_feedback; begin
 select * into t from public.tutorial_tours where id = p_tour;
 if not found or not mavi_private.member(t.company_id) or not mavi_private.tour_for_me(t) then
  raise exception 'Este onboarding não está disponível para você.' using errcode = '42501';
 end if;
 if p_vote is null then
  delete from public.tutorial_tour_feedback where tour_id = t.id and user_id = auth.uid();
  return null;
 end if;
 if p_vote not in ('up', 'down') then raise exception 'Voto inválido' using errcode = '22023'; end if;
 if p_reason is not null and p_reason not in ('outdated', 'confusing', 'missing_step', 'not_what_i_wanted', 'other') then
  raise exception 'Motivo inválido' using errcode = '22023';
 end if;
 insert into public.tutorial_tour_feedback as x(company_id, tour_id, user_id, version, vote, reason, comment)
 values (t.company_id, t.id, auth.uid(), t.version, p_vote, case when p_vote = 'down' then p_reason end,
  left(btrim(coalesce(p_comment, '')), 1000))
 on conflict (tour_id, user_id) do update set version = excluded.version, vote = excluded.vote,
  reason = excluded.reason, comment = excluded.comment, updated_at = now()
 returning * into f;
 return jsonb_build_object('vote', f.vote, 'reason', f.reason, 'comment', f.comment, 'version', f.version);
end $$;

-- ------------------------------------------------------------ métricas
create function public.tutorial_tour_metrics(p_tour uuid, p_version integer default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.tutorial_tours; v integer; v_steps jsonb; begin
 select * into t from public.tutorial_tours where id = p_tour;
 if not found or not mavi_private.tour_can_edit(t) then return null; end if;
 v := coalesce(p_version, t.version);
 -- Os passos daquela versão (a atual está na linha; as antigas, nas versões).
 v_steps := case when v = t.version then t.steps
  else (select x.content->'steps' from public.tutorial_tour_versions x where x.tour_id = t.id and x.version = v) end;
 if v_steps is null then return null; end if;
 return jsonb_build_object(
  'version', v,
  'versions', coalesce((select jsonb_agg(x.version order by x.version desc) from public.tutorial_tour_versions x
   where x.tour_id = t.id), '[]'),
  'started', (select count(distinct r.user_id) from public.tutorial_tour_reach r where r.tour_id = t.id and r.version = v),
  'completed', (select count(*) from public.tutorial_tour_progress p
   where p.tour_id = t.id and p.version = v and p.status = 'completed'),
  'dismissed', (select count(*) from public.tutorial_tour_progress p
   where p.tour_id = t.id and p.version = v and p.status = 'dismissed'),
  'in_progress', (select count(*) from public.tutorial_tour_progress p
   where p.tour_id = t.id and p.version = v and p.status = 'started'),
  'steps', coalesce((select jsonb_agg(jsonb_build_object(
    'step_id', s.st->>'id', 'n', s.n, 'title', s.st->>'title', 'kind', s.st->>'kind', 'page', s.st->>'page',
    'reached', (select count(*) from public.tutorial_tour_reach r
     where r.tour_id = t.id and r.version = v and r.step_id = s.st->>'id'),
    'stopped', (select count(*) from public.tutorial_tour_progress p
     where p.tour_id = t.id and p.version = v and p.status = 'dismissed' and p.step_id = s.st->>'id'),
    'misses', coalesce((select m.misses from public.tutorial_tour_misses m
     where m.tour_id = t.id and m.version = v and m.step_id = s.st->>'id'), 0)) order by s.n)
   from jsonb_array_elements(v_steps) with ordinality s(st, n)), '[]'),
  'up', (select count(*) from public.tutorial_tour_feedback f where f.tour_id = t.id and f.version = v and f.vote = 'up'),
  'down', (select count(*) from public.tutorial_tour_feedback f where f.tour_id = t.id and f.version = v and f.vote = 'down'),
  'feedback', coalesce((select jsonb_agg(jsonb_build_object('vote', f.vote, 'reason', f.reason, 'comment', f.comment,
    'name', mavi_private.member_name(t.company_id, f.user_id), 'at', f.updated_at) order by f.updated_at desc)
   from public.tutorial_tour_feedback f
   where f.tour_id = t.id and f.version = v and (f.vote = 'down' or f.comment <> '')), '[]'));
end $$;

revoke all on function public.vote_tutorial_tour(uuid, text, text, text), public.tutorial_tour_metrics(uuid, integer)
 from public, anon, authenticated;
grant execute on function public.vote_tutorial_tour(uuid, text, text, text), public.tutorial_tour_metrics(uuid, integer)
 to authenticated;

commit;

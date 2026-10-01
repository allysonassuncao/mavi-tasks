begin;

-- Avisos de novos aprendizados na caixa de entrada (Painel da MAVI › Copiloto
-- e › Aprendizado da MAVI).
--
-- 1. memberships.lesson_alerts_copilot / lesson_alerts_mavi: recursos extras,
--    um para cada aba, que administradores e gestores ligam por pessoa
--    (set_member_lesson_alerts; gestor só nas pessoas das suas equipes e não
--    mexe em administradores; um líder liga para si mesmo). Só
--    administradores e gestores podem ter: são os que abrem o Painel da
--    MAVI. Quem deixa de ser líder para de receber, mesmo ligado.
-- 2. O que avisa: aprendizado criado pela MAVI, ou já conferido por um líder
--    e reescrito por ela (volta para "Novos" do Painel). Reescrever um que
--    ainda está em "Novos" não avisa de novo; os ensinados ou editados por
--    uma pessoa não avisam.
-- 3. Um aviso por lote: a MAVI grava os aprendizados de uma vez
--    (ai_learning_store, mavi_learning_store). Um gatilho marca os da
--    transação e outro, adiado para o fim dela, manda um aviso só para cada
--    pessoa: quantos foram, o começo do primeiro e o link da aba
--    (/mavi#copiloto, /mavi#aprendizado), que abre em "Novos".

-- ------------------------------------------------------------ recurso por pessoa
alter table public.memberships add column lesson_alerts_copilot boolean not null default false,
 add column lesson_alerts_mavi boolean not null default false;

create function public.set_member_lesson_alerts(p_company uuid, p_user uuid, p_copilot boolean, p_mavi boolean)
 returns void
language plpgsql security definer set search_path = '' as $$
declare target public.memberships; begin
 select * into target from public.memberships where company_id = p_company and user_id = p_user;
 if not found then raise exception 'Pessoa não encontrada'; end if;
 if not mavi_private.leader(p_company)
  or not (p_user = auth.uid() or mavi_private.can_manage_person(p_company, p_user))
  or (target.role = 'admin' and not mavi_private.admin(p_company)) then
  raise exception 'Administradores liberam para todos; gestores, para as pessoas das suas equipes' using errcode = '42501';
 end if;
 if (coalesce(p_copilot, false) or coalesce(p_mavi, false)) and target.role not in ('admin', 'manager') then
  raise exception 'Os avisos de aprendizados são só para administradores e gestores, que abrem o Painel da MAVI'
   using errcode = '22023';
 end if;
 update public.memberships set lesson_alerts_copilot = coalesce(p_copilot, false),
  lesson_alerts_mavi = coalesce(p_mavi, false)
 where company_id = p_company and user_id = p_user;
end $$;
revoke all on function public.set_member_lesson_alerts(uuid, uuid, boolean, boolean) from public, anon;
grant execute on function public.set_member_lesson_alerts(uuid, uuid, boolean, boolean) to authenticated;

-- ------------------------------------------------------------ avisos
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
 check (kind in ('mention', 'assigned', 'reply', 'social_leads', 'ai_share', 'success_case', 'notice',
  'notice_animation', 'temperature', 'tasks_assigned', 'due_risk', 'status', 'review', 'ai_skill', 'ai_answer',
  'radar_report', 'radar_alert', 'media_balance', 'priority', 'tasks_priority', 'copilot_lessons', 'mavi_lessons'));
alter table public.notifications drop constraint notifications_target_check;
alter table public.notifications add constraint notifications_target_check
 check ((kind in ('social_leads', 'ai_share', 'success_case', 'notice', 'notice_animation', 'temperature',
   'tasks_assigned', 'due_risk', 'ai_skill', 'ai_answer', 'radar_report', 'radar_alert', 'media_balance',
   'tasks_priority', 'copilot_lessons', 'mavi_lessons')) = (task_id is null)
  and (task_id is not null or (title is not null and link is not null))
  and ((kind = 'notice') = (notice_id is not null)));

-- A marca: os aprendizados novos ou reescritos pela MAVI nesta transação
-- (ids separados por vírgula, numa configuração local à transação).
create function mavi_private.lesson_alert_mark() returns trigger
language plpgsql security definer set search_path = '' as $$
declare k text := 'mavi.lesson_alert_' || tg_table_name; begin
 perform set_config(k, coalesce(current_setting(k, true), '') || new.id::text || ',', true);
 return null;
end $$;
revoke all on function mavi_private.lesson_alert_mark() from public, anon, authenticated;

-- O aviso, no fim da transação: o primeiro disparo leva todos os marcados e
-- limpa a marca; os outros não acham nada. Conta só os que continuam novos
-- (um retirado na mesma gravação não entra).
create function mavi_private.lesson_alert_send() returns trigger
language plpgsql security definer set search_path = '' as $$
declare k text := 'mavi.lesson_alert_' || tg_table_name; v text := current_setting(k, true);
 copilot boolean := tg_table_name = 'copilot_lessons'; r record; begin
 if coalesce(v, '') = '' then return null; end if;
 perform set_config(k, '', true);
 for r in execute format(
  'select l.company_id, count(*)::int as n, (array_agg(l.text order by m.ord))[1] as first_text
   from (select distinct on (x) x::uuid as id, ord
         from unnest(string_to_array(rtrim($1, '',''), '','')) with ordinality as u(x, ord)
         order by x, ord) m
   join public.%I l on l.id = m.id
   where l.origin = ''mavi'' and l.status in (''active'', ''candidate'') and l.reviewed_at is null
   group by l.company_id', tg_table_name) using v loop
  insert into public.notifications(company_id, user_id, kind, title, body, link)
  select r.company_id, m.user_id, case when copilot then 'copilot_lessons' else 'mavi_lessons' end,
   case when copilot then 'Copiloto: ' else 'Aprendizado da MAVI: ' end
    || case when r.n = 1 then '1 aprendizado novo para conferir'
       else r.n || ' aprendizados novos para conferir' end,
   left(r.first_text, 200) || case when r.n > 1 then ' · e mais ' || (r.n - 1) else '' end,
   case when copilot then '/mavi#copiloto' else '/mavi#aprendizado' end
  from public.memberships m
  where m.company_id = r.company_id and m.active and m.role in ('admin', 'manager')
   and case when copilot then m.lesson_alerts_copilot else m.lesson_alerts_mavi end;
 end loop;
 return null;
end $$;
revoke all on function mavi_private.lesson_alert_send() from public, anon, authenticated;

create trigger lesson_alert_new after insert on public.copilot_lessons
 for each row when (new.origin = 'mavi') execute function mavi_private.lesson_alert_mark();
create trigger lesson_alert_rewritten after update of text on public.copilot_lessons
 for each row when (new.origin = 'mavi' and new.text is distinct from old.text
  and old.reviewed_at is not null and new.reviewed_at is null)
 execute function mavi_private.lesson_alert_mark();
create constraint trigger lesson_alert_send after insert or update of text on public.copilot_lessons
 deferrable initially deferred for each row when (new.origin = 'mavi')
 execute function mavi_private.lesson_alert_send();

create trigger lesson_alert_new after insert on public.mavi_lessons
 for each row when (new.origin = 'mavi') execute function mavi_private.lesson_alert_mark();
create trigger lesson_alert_rewritten after update of text on public.mavi_lessons
 for each row when (new.origin = 'mavi' and new.text is distinct from old.text
  and old.reviewed_at is not null and new.reviewed_at is null)
 execute function mavi_private.lesson_alert_mark();
create constraint trigger lesson_alert_send after insert or update of text on public.mavi_lessons
 deferrable initially deferred for each row when (new.origin = 'mavi')
 execute function mavi_private.lesson_alert_send();

commit;

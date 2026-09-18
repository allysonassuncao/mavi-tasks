begin;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('mavi-attachments','mavi-attachments',false,20971520,array['application/pdf','image/jpeg','image/png','image/webp','text/plain','text/csv','application/zip','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.openxmlformats-officedocument.presentationml.presentation']);
create policy mavi_files_read on storage.objects for select to authenticated using(bucket_id='mavi-attachments' and exists(
 select 1 from public.attachments a where a.path=storage.objects.name and mavi_private.task_access(a.company_id,a.task_id)));
create policy mavi_files_insert on storage.objects for insert to authenticated with check(bucket_id='mavi-attachments' and exists(
 select 1 from public.attachments a where a.path=storage.objects.name and a.uploaded_by=auth.uid() and mavi_private.task_access(a.company_id,a.task_id)));
-- No overwrite or direct deletion of attachments in this foundation.

create function public.report_summary(p_company uuid,p_start timestamptz,p_end timestamptz) returns jsonb
language sql stable security invoker set search_path = '' as $$
 with visible_tasks as (select * from public.tasks where company_id=p_company and not archived),
 hours as (select e.*,greatest(0,extract(epoch from (least(coalesce(e.ended_at,now()),p_end)-greatest(e.started_at,p_start)))/60) as minutes
 from public.time_entries e where company_id=p_company and e.started_at<p_end and coalesce(e.ended_at,now())>p_start),
 by_project as (select project_id as id,count(*) as total,count(*) filter(where status='done') as done from visible_tasks where project_id is not null group by project_id),
 by_client as (select c.id,c.name,sum(h.minutes) as minutes from hours h join visible_tasks t on t.id=h.task_id
 join public.contracts k on k.id=t.contract_id join public.clients c on c.id=k.client_id group by c.id,c.name),
 by_person as (select m.user_id as id,m.name,count(t.id) as tasks,coalesce(sum(t.estimated_minutes),0) as estimated
 from public.memberships m left join visible_tasks t on t.assignee_id=m.user_id and t.status<>'done'
 where m.company_id=p_company and m.active group by m.user_id,m.name),
 delivery as (select count(*) as n from public.task_events where company_id=p_company and detail->>'to'='done' and created_at>=p_start and created_at<p_end)
 select jsonb_build_object('total',(select count(*) from visible_tasks),
 'late',(select count(*) from visible_tasks where status<>'done' and due_date<(now() at time zone (select timezone from public.companies where id=p_company))::date),
 'review',(select count(*) from visible_tasks where status='review'),'done',(select n from delivery),
 'minutes',coalesce((select sum(minutes) from hours),0),'by_client',coalesce((select jsonb_agg(by_client) from by_client),'[]'),
 'by_project',coalesce((select jsonb_agg(by_project) from by_project),'[]'),
 'by_person',coalesce((select jsonb_agg(by_person) from by_person),'[]'))
$$;
revoke all on function public.report_summary(uuid,timestamptz,timestamptz) from public,anon;
grant execute on function public.report_summary(uuid,timestamptz,timestamptz) to authenticated;
commit;

-- Executes only temporary fixtures, fully rolled back. No email is sent.
begin;
select set_config('mavi.test.company_a',gen_random_uuid()::text,true),
 set_config('mavi.test.company_b',gen_random_uuid()::text,true),
 set_config('mavi.test.user_a',gen_random_uuid()::text,true),
 set_config('mavi.test.user_b',gen_random_uuid()::text,true),
 set_config('mavi.test.member',gen_random_uuid()::text,true);
insert into auth.users(id,email) values
 (current_setting('mavi.test.user_a')::uuid,current_setting('mavi.test.user_a')||'@mavi-test.example'),
 (current_setting('mavi.test.user_b')::uuid,current_setting('mavi.test.user_b')||'@mavi-test.example'),
 (current_setting('mavi.test.member')::uuid,current_setting('mavi.test.member')||'@mavi-test.example');
insert into public.companies(id,name) values
 (current_setting('mavi.test.company_a')::uuid,'MAVI TEST A'),
 (current_setting('mavi.test.company_b')::uuid,'MAVI TEST B');
insert into public.memberships(company_id,user_id,name,role) values
 (current_setting('mavi.test.company_a')::uuid,current_setting('mavi.test.user_a')::uuid,'Admin A','admin'),
 (current_setting('mavi.test.company_b')::uuid,current_setting('mavi.test.user_b')::uuid,'Admin B','admin'),
 (current_setting('mavi.test.company_a')::uuid,current_setting('mavi.test.member')::uuid,'Executor','member');
select set_config('request.jwt.claim.sub',current_setting('mavi.test.user_a'),true);
set local role authenticated;
do $$ declare c uuid; p uuid; k uuid; t uuid; begin
 if (select count(*) from public.companies)<>1 then raise exception 'RLS company isolation failed'; end if;
 c:=public.create_client(current_setting('mavi.test.company_a')::uuid,'Client test','');
 p:=public.create_product(current_setting('mavi.test.company_a')::uuid,'Product test');
 k:=public.create_contract(current_setting('mavi.test.company_a')::uuid,c,p,'Contract test');
 t:=public.create_task(current_setting('mavi.test.company_a')::uuid,k,'Task test',current_setting('mavi.test.member')::uuid,current_date+1);
 perform set_config('mavi.test.task',t::text,true);
 perform public.transition_task(t,1,'submit');
end $$;
select set_config('request.jwt.claim.sub',current_setting('mavi.test.member'),true);
do $$ begin
 if (select count(*) from public.tasks)<>1 then raise exception 'Assignee cannot read task'; end if;
 begin
  update public.tasks set status='done';
  raise exception 'Direct update unexpectedly allowed';
 exception when insufficient_privilege then null;
 end;
 begin
  perform public.transition_task(current_setting('mavi.test.task')::uuid,2,'approve_internal');
  raise exception 'Assignee approval unexpectedly allowed';
 exception when insufficient_privilege then null;
 end;
end $$;
select set_config('request.jwt.claim.sub',current_setting('mavi.test.user_b'),true);
do $$ begin
 if (select count(*) from public.tasks)<>0 then raise exception 'Cross-company tasks leaked'; end if;
 if (public.report_summary(current_setting('mavi.test.company_a')::uuid,now()-interval '1 day',now()+interval '1 day')->>'total')::int<>0 then raise exception 'Cross-company report leaked'; end if;
 begin
  perform public.add_comment(current_setting('mavi.test.task')::uuid,'Forbidden');
  raise exception 'Cross-company comment unexpectedly allowed';
 exception when insufficient_privilege then null;
 end;
end $$;
select set_config('request.jwt.claim.sub',current_setting('mavi.test.user_a'),true);
do $$ begin
 perform public.transition_task(current_setting('mavi.test.task')::uuid,2,'approve_internal');
 if (select status from public.tasks where id=current_setting('mavi.test.task')::uuid)<>'done' then raise exception 'Creator approval failed'; end if;
end $$;
set local role anon;
do $$ begin
 begin
  perform 1 from public.tasks;
  raise exception 'Anonymous read unexpectedly allowed';
 exception when insufficient_privilege then null;
 end;
end $$;
rollback;
select 'PASS: remote RLS, roles, approval flow and reporting; fixtures rolled back' as result;

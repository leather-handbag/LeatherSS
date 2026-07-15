-- Leather Algorithm Expedition phase 2C: private, immutable monthly learning
-- reports generated after delayed AtCoder data has had time to settle.

create table if not exists public.monthly_learning_reports(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  report_month date not null check(extract(day from report_month)=1),
  period_start date not null,
  period_end date not null,
  generated_at timestamptz not null default now(),
  data_through timestamptz,
  model_version integer not null references public.mastery_model_versions(version) on delete restrict,
  summary jsonb not null default '{}'::jsonb,
  difficulty jsonb not null default '{}'::jsonb,
  activity jsonb not null default '{}'::jsonb,
  skill_changes jsonb not null default '[]'::jsonb,
  strengths jsonb not null default '[]'::jsonb,
  weaknesses jsonb not null default '[]'::jsonb,
  next_month_goals jsonb not null default '[]'::jsonb,
  data_quality jsonb not null default '{}'::jsonb,
  unique(user_id,report_month),
  check(period_start=report_month),
  check(period_end=(report_month+interval '1 month')::date)
);
create index if not exists monthly_learning_reports_user_month_idx on public.monthly_learning_reports(user_id,report_month desc);
alter table public.monthly_learning_reports enable row level security;
drop policy if exists monthly_learning_reports_own_read on public.monthly_learning_reports;
create policy monthly_learning_reports_own_read on public.monthly_learning_reports for select to authenticated using(user_id=auth.uid());
revoke all on public.monthly_learning_reports from public,anon,authenticated;
grant select on public.monthly_learning_reports to authenticated;

create table if not exists public.monthly_skill_snapshots(
  user_id uuid not null references public.profiles(id) on delete cascade,
  report_month date not null,
  region_code text not null references public.map_regions(code) on delete cascade,
  model_version integer not null references public.mastery_model_versions(version) on delete restrict,
  mastery_percent integer not null check(mastery_percent between 0 and 100),
  confidence text not null,
  evidence numeric(8,3) not null default 0,
  captured_at timestamptz not null default now(),
  primary key(user_id,report_month,region_code)
);
alter table public.monthly_skill_snapshots enable row level security;
drop policy if exists monthly_skill_snapshots_client_deny on public.monthly_skill_snapshots;
create policy monthly_skill_snapshots_client_deny on public.monthly_skill_snapshots for all to anon,authenticated using(false) with check(false);
revoke all on public.monthly_skill_snapshots from public,anon,authenticated;

insert into public.training_feature_flags(key,enabled,config,updated_at)
values('monthly_learning_reports_enabled',true,'{"timezone":"Asia/Shanghai","day":2,"time":"00:20","pdf":false}'::jsonb,now())
on conflict(key) do update set enabled=excluded.enabled,config=excluded.config,updated_at=now();

create or replace function private.longest_training_streak(target_user uuid,range_start date,range_end date)
returns integer language sql stable security definer set search_path=public,pg_catalog
as $$
  with days as (
    select distinct activity_date d from public.training_daily_stats
    where user_id=target_user and platform in ('codeforces','atcoder') and activity_date>=range_start and activity_date<range_end
  ),islands as (select d,d-(row_number() over(order by d))::integer grp from days)
  select coalesce(max(n),0)::integer from (select count(*) n from islands group by grp)x;
$$;

create or replace function private.generate_monthly_learning_report(target_user uuid,target_month date)
returns uuid language plpgsql security definer set search_path=public,private,pg_catalog
as $$
declare
  v_month date:=date_trunc('month',target_month)::date;v_end date;v_prev date;v_model integer;v_id uuid;v_existing uuid;
  v_submissions integer:=0;v_accepts integer:=0;v_solved integer:=0;v_days integer:=0;v_streak integer:=0;
  v_avg numeric;v_hard_avg numeric;v_max integer;v_k integer:=0;v_prev_report public.monthly_learning_reports;
  v_summary jsonb;v_difficulty jsonb;v_activity jsonb;v_changes jsonb;v_strengths jsonb;v_weaknesses jsonb;v_goals jsonb;v_quality jsonb;
  v_difficulty_coverage numeric:=0;v_tag_coverage numeric:=0;v_data_through timestamptz;v_primary record;v_progress record;v_review record;
begin
  if target_user is null then return null; end if;
  select id into v_existing from public.monthly_learning_reports where user_id=target_user and report_month=v_month;
  if v_existing is not null then return v_existing; end if;
  v_end:=(v_month+interval '1 month')::date;v_prev:=(v_month-interval '1 month')::date;
  select version into v_model from public.mastery_model_versions where active order by version desc limit 1;

  select count(*),count(*) filter(where is_accepted),count(distinct (submitted_at at time zone 'Asia/Shanghai')::date),max(submitted_at)
  into v_submissions,v_accepts,v_days,v_data_through from public.submission_events
  where user_id=target_user and platform in ('codeforces','atcoder') and submitted_at>=(v_month::timestamp at time zone 'Asia/Shanghai') and submitted_at<(v_end::timestamp at time zone 'Asia/Shanghai');

  with month_solves as (
    select distinct coalesce(a.canonical_problem_id,p.problem_id) canonical_id,max(c.normalized_difficulty) difficulty
    from public.user_problem_progress p join public.problem_catalog c on c.id=p.problem_id left join public.problem_aliases a on a.problem_id=p.problem_id
    where p.user_id=target_user and p.is_solved and p.platform in ('codeforces','atcoder')
      and p.first_accepted_at>=(v_month::timestamp at time zone 'Asia/Shanghai') and p.first_accepted_at<(v_end::timestamp at time zone 'Asia/Shanghai')
    group by coalesce(a.canonical_problem_id,p.problem_id)
  ) select count(*),round(avg(difficulty),2),max(difficulty),least(20,greatest(5,ceil(count(*)*.25)::integer))
    into v_solved,v_avg,v_max,v_k from month_solves;

  with month_solves as (
    select distinct coalesce(a.canonical_problem_id,p.problem_id) canonical_id,max(c.normalized_difficulty) difficulty
    from public.user_problem_progress p join public.problem_catalog c on c.id=p.problem_id left join public.problem_aliases a on a.problem_id=p.problem_id
    where p.user_id=target_user and p.is_solved and p.platform in ('codeforces','atcoder')
      and p.first_accepted_at>=(v_month::timestamp at time zone 'Asia/Shanghai') and p.first_accepted_at<(v_end::timestamp at time zone 'Asia/Shanghai')
    group by coalesce(a.canonical_problem_id,p.problem_id)
  ),hard as (select difficulty from month_solves where difficulty is not null order by difficulty desc limit v_k)
  select round(avg(difficulty),2) into v_hard_avg from hard;
  v_streak:=private.longest_training_streak(target_user,v_month,v_end);
  select * into v_prev_report from public.monthly_learning_reports where user_id=target_user and report_month=v_prev;

  v_summary:=jsonb_build_object(
    'report_type',case when v_solved=0 then 'rest_month' when v_prev_report.id is null then 'baseline' else 'monthly' end,
    'independent_ac',v_solved,'submissions',v_submissions,'accepted_submissions',v_accepts,
    'accepted_ratio',case when v_submissions=0 then 0 else round(100.0*v_accepts/v_submissions,1) end,
    'active_days',v_days,'longest_streak',v_streak,
    'comparison',case when v_prev_report.id is null then jsonb_build_object('baseline',true) else jsonb_build_object(
      'baseline',false,'independent_ac_delta',v_solved-coalesce((v_prev_report.summary->>'independent_ac')::integer,0),
      'submissions_delta',v_submissions-coalesce((v_prev_report.summary->>'submissions')::integer,0),
      'active_days_delta',v_days-coalesce((v_prev_report.summary->>'active_days')::integer,0)) end,
    'maps_unlocked',coalesce((select jsonb_agg(jsonb_build_object('code',m.code,'name',m.name,'reason',u.detail->>'reason','at',u.unlocked_at) order by u.unlocked_at)
      from public.map_unlocks u join public.training_maps m on m.code=u.map_code where u.user_id=target_user and u.unlocked_at>=(v_month::timestamp at time zone 'Asia/Shanghai') and u.unlocked_at<(v_end::timestamp at time zone 'Asia/Shanghai')),'[]'::jsonb));
  v_difficulty:=jsonb_build_object('average',v_avg,'hard_problem_average',v_hard_avg,'hard_sample_size',least(v_solved,v_k),'maximum',v_max);

  select jsonb_build_object(
    'weekday_distribution',coalesce((select jsonb_object_agg(isodow,solved order by isodow) from (select extract(isodow from activity_date)::integer isodow,sum(solved_count)::integer solved from public.training_daily_stats where user_id=target_user and platform in ('codeforces','atcoder') and activity_date>=v_month and activity_date<v_end group by 1)x),'{}'::jsonb),
    'platform_distribution',coalesce((select jsonb_object_agg(platform,jsonb_build_object('submissions',submissions,'solved',solved)) from (select platform,sum(submission_count)::integer submissions,sum(solved_count)::integer solved from public.training_daily_stats where user_id=target_user and platform in ('codeforces','atcoder') and activity_date>=v_month and activity_date<v_end group by platform)x),'{}'::jsonb),
    'training_style',case when v_days=0 then 'rest' when v_days>=12 then 'steady' when v_submissions>=20 and v_days<=4 then 'burst' else 'mixed' end,
    'longest_gap_days',coalesce((select max(gap)::integer from (select activity_date-lag(activity_date) over(order by activity_date)-1 gap from (select distinct activity_date from public.training_daily_stats where user_id=target_user and platform in ('codeforces','atcoder') and activity_date>=v_month and activity_date<v_end)d)x),(v_end-v_month))
  ) into v_activity;

  insert into public.monthly_skill_snapshots(user_id,report_month,region_code,model_version,mastery_percent,confidence,evidence,captured_at)
  select target_user,v_month,s.region_code,v_model,s.mastery_percent,s.confidence,s.evidence,now() from public.skill_mastery s
  where s.user_id=target_user and s.model_version=v_model
  on conflict(user_id,report_month,region_code) do nothing;

  select coalesce(jsonb_agg(jsonb_build_object('region_code',region_code,'region_name',name,'map_code',map_code,'mastery_percent',mastery_percent,
    'previous_percent',previous_percent,'mastery_delta',mastery_percent-previous_percent,'reached_80',mastery_percent>=80 and previous_percent<80,
    'reached_100',mastery_percent=100 and previous_percent<100,'confidence',confidence) order by mastery_percent-previous_percent desc,evidence desc),'[]'::jsonb)
  into v_changes from (
    select cur.region_code,r.name,r.map_code,cur.mastery_percent,coalesce(prev.mastery_percent,case when v_prev_report.id is null then cur.mastery_percent else 0 end) previous_percent,cur.confidence,cur.evidence
    from public.monthly_skill_snapshots cur join public.map_regions r on r.code=cur.region_code
    left join public.monthly_skill_snapshots prev on prev.user_id=cur.user_id and prev.region_code=cur.region_code and prev.report_month=v_prev
    where cur.user_id=target_user and cur.report_month=v_month and r.is_core
    order by cur.mastery_percent-coalesce(prev.mastery_percent,case when v_prev_report.id is null then cur.mastery_percent else 0 end) desc,cur.evidence desc limit 3
  )x;

  select coalesce(jsonb_agg(jsonb_build_object('region_code',region_code,'name',name,'map_code',map_code,'percent',mastery_percent,'confidence',confidence,'reason',explanation) order by mastery_percent desc),'[]'::jsonb)
  into v_strengths from (select s.*,r.name from public.skill_mastery s join public.map_regions r on r.code=s.region_code where s.user_id=target_user and s.model_version=v_model and r.is_core and s.assessment='strength' order by s.mastery_percent desc limit 3)x;
  select coalesce(jsonb_agg(jsonb_build_object('region_code',region_code,'name',name,'map_code',map_code,'percent',mastery_percent,'confidence',confidence,'assessment',assessment,'reason',explanation) order by case assessment when 'weakness' then 1 when 'rusty' then 2 else 3 end,mastery_percent),'[]'::jsonb)
  into v_weaknesses from (select s.*,r.name from public.skill_mastery s join public.map_regions r on r.code=s.region_code where s.user_id=target_user and s.model_version=v_model and r.is_core and s.assessment in ('weakness','rusty') order by case s.assessment when 'weakness' then 1 else 2 end,s.mastery_percent limit 3)x;

  select s.region_code,r.name,s.mastery_percent into v_primary from public.skill_mastery s join public.map_regions r on r.code=s.region_code
    where s.user_id=target_user and s.model_version=v_model and r.is_core and s.assessment='weakness' order by s.mastery_percent,s.evidence desc limit 1;
  select s.region_code,r.name,s.mastery_percent into v_progress from public.skill_mastery s join public.map_regions r on r.code=s.region_code join public.training_maps m on m.code=r.map_code join public.map_unlocks u on u.map_code=m.code and u.user_id=target_user
    where s.user_id=target_user and s.model_version=v_model and r.is_core and s.mastery_percent<100 order by m.position desc,s.mastery_percent limit 1;
  select s.region_code,r.name,s.mastery_percent into v_review from public.skill_mastery s join public.map_regions r on r.code=s.region_code
    where s.user_id=target_user and s.model_version=v_model and r.is_core and s.assessment='rusty' order by s.mastery_percent desc limit 1;
  v_goals:=jsonb_build_array(
    jsonb_build_object('type','weakness','region_code',v_primary.region_code,'region_name',coalesce(v_primary.name,'待探索算法'),'problem_count',case when v_solved=0 then 3 else 5 end,'difficulty_min',greatest(800,coalesce(round(v_avg)::integer,1100)-100),'difficulty_max',coalesce(round(v_avg)::integer,1100)+200),
    jsonb_build_object('type','map_progress','region_code',v_progress.region_code,'region_name',coalesce(v_progress.name,'当前地图核心区域'),'problem_count',5,'difficulty_min',greatest(800,coalesce(round(v_hard_avg)::integer,1200)-200),'difficulty_max',coalesce(round(v_hard_avg)::integer,1200)+100),
    jsonb_build_object('type','review','region_code',v_review.region_code,'region_name',coalesce(v_review.name,'历史强项复习'),'problem_count',3,'difficulty_min',greatest(800,coalesce(round(v_avg)::integer,1100)-200),'difficulty_max',coalesce(round(v_avg)::integer,1100)+100));

  with month_solves as (
    select distinct coalesce(a.canonical_problem_id,p.problem_id) canonical_id,p.problem_id,c.normalized_difficulty
    from public.user_problem_progress p join public.problem_catalog c on c.id=p.problem_id left join public.problem_aliases a on a.problem_id=p.problem_id
    where p.user_id=target_user and p.is_solved and p.platform in ('codeforces','atcoder') and p.first_accepted_at>=(v_month::timestamp at time zone 'Asia/Shanghai') and p.first_accepted_at<(v_end::timestamp at time zone 'Asia/Shanghai')
  ) select coalesce(round(100.0*count(*) filter(where normalized_difficulty is not null)/nullif(count(*),0),1),0),
      coalesce(round(100.0*count(*) filter(where exists(select 1 from public.problem_skill_tags t where t.problem_id=month_solves.problem_id and t.confidence>=.7))/nullif(count(*),0),1),0)
    into v_difficulty_coverage,v_tag_coverage from month_solves;
  v_quality:=jsonb_build_object('difficulty_coverage',v_difficulty_coverage,'reliable_tag_coverage',v_tag_coverage,'data_through',v_data_through,
    'source_status',coalesce((select jsonb_agg(jsonb_build_object('platform',platform,'status',status,'last_success_at',last_success_at,'data_through',data_through) order by platform) from public.external_accounts where user_id=target_user and platform in ('codeforces','atcoder')),'[]'::jsonb),
    'warning',case when exists(select 1 from public.external_accounts where user_id=target_user and platform in ('codeforces','atcoder') and status<>'active') then '部分平台数据可能延迟；缺失数据不视为退步。' else null end);

  insert into public.monthly_learning_reports(user_id,report_month,period_start,period_end,data_through,model_version,summary,difficulty,activity,skill_changes,strengths,weaknesses,next_month_goals,data_quality)
  values(target_user,v_month,v_month,v_end,v_data_through,v_model,v_summary,v_difficulty,v_activity,v_changes,v_strengths,v_weaknesses,v_goals,v_quality)
  on conflict(user_id,report_month) do nothing returning id into v_id;
  if v_id is null then select id into v_id from public.monthly_learning_reports where user_id=target_user and report_month=v_month;return v_id;end if;
  perform private.push_notification(target_user,null,'system','monthly_learning_reports',v_id,to_char(v_month,'YYYY-MM')||' 学习报告已生成');
  return v_id;
end $$;

create or replace function public.generate_due_learning_reports()
returns integer language plpgsql security definer set search_path=public,private,pg_catalog
as $$
declare v_month date;v_user record;v_count integer:=0;v_before uuid;v_after uuid;
begin
  if current_user not in ('postgres','service_role','supabase_admin') then raise exception 'service role required'; end if;
  if extract(day from (now() at time zone 'Asia/Shanghai'))::integer<>2 then return 0; end if;
  if not coalesce((select enabled from public.training_feature_flags where key='monthly_learning_reports_enabled'),false) then return 0; end if;
  v_month:=date_trunc('month',(now() at time zone 'Asia/Shanghai')-interval '1 month')::date;
  for v_user in select p.id from public.profiles p where p.banned_at is null and (
    exists(select 1 from public.external_accounts a where a.user_id=p.id and a.platform in ('codeforces','atcoder')) or
    exists(select 1 from public.submission_events e where e.user_id=p.id and e.platform in ('codeforces','atcoder')))
  loop
    select id into v_before from public.monthly_learning_reports where user_id=v_user.id and report_month=v_month;
    v_after:=private.generate_monthly_learning_report(v_user.id,v_month);
    if v_before is null and v_after is not null then v_count:=v_count+1;end if;
    v_before:=null;v_after:=null;
  end loop;
  return v_count;
end $$;

create or replace function public.get_my_learning_reports(limit_count integer default 24)
returns table(id uuid,report_month date,generated_at timestamptz,data_through timestamptz,model_version integer,summary jsonb,difficulty jsonb,data_quality jsonb)
language sql stable security definer set search_path=public,pg_catalog
as $$
  select r.id,r.report_month,r.generated_at,r.data_through,r.model_version,r.summary,r.difficulty,r.data_quality
  from public.monthly_learning_reports r where r.user_id=auth.uid() order by r.report_month desc limit least(greatest(coalesce(limit_count,24),1),120);
$$;

create or replace function public.get_my_learning_report(report_month date)
returns jsonb language sql stable security definer set search_path=public,pg_catalog
as $$ select to_jsonb(r)-'user_id' from public.monthly_learning_reports r where r.user_id=auth.uid() and r.report_month=date_trunc('month',$1)::date $$;

create or replace function public.get_training_admin_metrics()
returns jsonb language plpgsql security definer set search_path=public,private,pg_catalog
as $$
begin
  if not private.is_staff(auth.uid()) then raise exception 'permission denied'; end if;
  return jsonb_build_object(
    'generated_at',now(),
    'queue',jsonb_build_object('queued',(select count(*) from public.training_sync_jobs where status='queued'),'running',(select count(*) from public.training_sync_jobs where status='running'),'failed_24h',(select count(*) from public.training_sync_jobs where status='failed' and finished_at>now()-interval '24 hours')),
    'sources',coalesce((select jsonb_agg(x) from (select platform,status,count(*) accounts,max(last_success_at) last_success_at from public.external_accounts group by platform,status order by platform,status)x),'[]'::jsonb),
    'errors',coalesce((select jsonb_agg(x) from (select platform,error_code,count(*) occurrences,max(created_at) latest from public.training_sync_runs where outcome='failed' and created_at>now()-interval '24 hours' group by platform,error_code order by count(*) desc limit 12)x),'[]'::jsonb),
    'recent_private_access',coalesce((select jsonb_agg(x) from (select a.actor_id,p.handle actor_handle,a.target_user_id,a.resource,a.created_at from private.training_access_audit a join public.profiles p on p.id=a.actor_id order by a.created_at desc limit 20)x),'[]'::jsonb),
    'monthly_reports',jsonb_build_object('total',(select count(*) from public.monthly_learning_reports),'latest_month',(select max(report_month) from public.monthly_learning_reports),'latest_generated_at',(select max(generated_at) from public.monthly_learning_reports),'enabled',coalesce((select enabled from public.training_feature_flags where key='monthly_learning_reports_enabled'),false)),
    'ability',jsonb_build_object('calculated',(select count(*) from public.user_ability_estimates),'stale',(select count(*) from public.user_ability_estimates where calculated_at<now()-interval '7 days')),
    'luogu',jsonb_build_object('enabled',false,'disabled_accounts',(select count(*) from public.external_accounts where platform='luogu' and status='disabled'))
  );
end $$;

grant execute on function public.get_my_learning_reports(integer),public.get_my_learning_report(date),public.get_training_admin_metrics() to authenticated;
revoke execute on function public.get_my_learning_reports(integer),public.get_my_learning_report(date) from public,anon;
revoke execute on function public.generate_due_learning_reports(),private.generate_monthly_learning_report(uuid,date),private.longest_training_streak(uuid,date,date) from public,anon,authenticated;

do $$
declare v_job bigint;
begin
  select jobid into v_job from cron.job where jobname='leather-monthly-learning-reports';
  if v_job is not null then perform cron.unschedule(v_job);end if;
  perform cron.schedule('leather-monthly-learning-reports','20 16 * * *',$job$ select public.generate_due_learning_reports(); $job$);
end $$;

comment on table public.monthly_learning_reports is 'Private immutable monthly reports; no public or ordinary admin read path.';
comment on table public.monthly_skill_snapshots is 'Service-only per-region snapshot backing month-over-month mastery deltas.';
comment on function public.generate_due_learning_reports() is 'Service-only idempotent generator; daily 16:20 UTC cron acts only on China-time day 2.';

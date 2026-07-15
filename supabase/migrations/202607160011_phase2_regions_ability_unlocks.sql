-- Leather Algorithm Expedition phase 2B:
-- readable algorithm region names and evidence-backed direct map access.

update public.map_regions r set name=v.name,description=v.description
from (values
('plains_implementation','模拟、枚举与排序','模拟、枚举、排序与复杂度入门'),
('plains_prefix','前缀和与差分','前缀和、差分与基础区间优化'),
('plains_greedy','贪心与构造','基础贪心与构造策略'),
('plains_math','基础数学','基础数学、计数与简单公式'),
('plains_relic','基础计算几何','遗迹：基础计算几何'),
('bronze_binary','二分与双指针','二分答案、二分查找与双指针'),
('bronze_search','BFS/DFS 与剪枝','图搜索、回溯与基础剪枝'),
('bronze_structure','栈与队列','栈、队列与基础线性结构'),
('bronze_dp','基础动态规划','线性 DP 与常见状态设计'),
('bronze_math','基础数论','质数、因数、同余与最大公约数'),
('bronze_relic','折半搜索','遗迹：折半搜索'),
('silver_structure','并查集、堆与 ST 表','并查集、优先队列与稀疏表'),
('silver_graph','最短路与树','最短路、树遍历与基础图论'),
('silver_dp','背包动态规划','背包模型与常用动态规划'),
('silver_string','哈希与 Trie','字符串哈希、字典树与基础字符串结构'),
('silver_relic','图遍历进阶','遗迹：图遍历的综合应用'),
('gold_structure','树状数组与线段树','区间查询、修改与懒标记'),
('gold_graph','MST、SCC 与 LCA','最小生成树、强连通分量与最近公共祖先'),
('gold_dp','树形/状压/数位 DP','树形、状态压缩与数位动态规划'),
('gold_string','KMP、Z 与哈希','模式匹配、Z 函数与字符串哈希'),
('gold_math','组合数学','组合计数、容斥与基础生成函数'),
('gold_relic','计算几何进阶','遗迹：几何模型与精度处理'),
('platinum_structure','高级数据结构','分块、平衡结构与复杂区间结构'),
('platinum_graph','网络流与匹配','最大流、最小割与二分图匹配'),
('platinum_dp','动态规划优化','单调队列、斜率与数据结构优化 DP'),
('platinum_string','后缀结构与自动机','后缀数组、后缀自动机与字符串自动机'),
('platinum_math','进阶数论与计算几何','进阶数论方法与计算几何'),
('platinum_relic','线性代数','遗迹：矩阵、线性基与高斯消元'),
('master_structure','可持久化与动态树','可持久化结构、Link-Cut Tree 等动态树'),
('master_graph','复杂图论','支配树、仙人掌等复杂图模型'),
('master_math','多项式与线性代数','多项式算法、卷积与线性代数'),
('master_probability','概率期望与随机化','概率、期望与随机化算法'),
('master_geometry','高级计算几何','半平面交、凸几何等高级几何'),
('master_relic','高级动态规划','遗迹：高维与复杂状态动态规划'),
('legend_cross','跨领域综合','多个算法领域的综合建模与实现'),
('legend_proof','证明与构造','严谨证明、反例分析与困难构造'),
('legend_opt','极限优化','复杂度、常数与工程实现的极限优化'),
('legend_structure','困难数据结构与图论','困难动态结构与图论综合'),
('legend_math','困难数学与几何','高阶数学、数论与几何综合'),
('legend_string','困难字符串与综合 DP','困难字符串算法与综合动态规划'),
('legend_relic','跨领域极限挑战','遗迹：最终跨领域挑战')
) as v(code,name,description)
where r.code=v.code;

create table if not exists public.user_ability_estimates(
  user_id uuid primary key references public.profiles(id) on delete cascade,
  model_version integer not null references public.mastery_model_versions(version) on delete restrict,
  known_solved_count integer not null default 0,
  hard_problem_average numeric(8,2),
  sample_size integer not null default 0,
  max_difficulty integer,
  recent_90d_average numeric(8,2),
  direct_unlock_map text references public.training_maps(code) on delete set null,
  evidence jsonb not null default '{}'::jsonb,
  calculated_at timestamptz not null default now()
);
alter table public.user_ability_estimates enable row level security;
drop policy if exists user_ability_estimates_own_read on public.user_ability_estimates;
create policy user_ability_estimates_own_read on public.user_ability_estimates for select to authenticated using(user_id=auth.uid());
revoke all on public.user_ability_estimates from public,anon,authenticated;
grant select on public.user_ability_estimates to authenticated;

create or replace function private.refresh_ability_unlocks(target_user uuid,target_model integer)
returns void language plpgsql security definer set search_path=public,private,pg_catalog
as $$
declare v_n integer:=0;v_k integer:=0;v_sample integer:=0;v_average numeric;v_max integer;v_recent numeric;v_target text;v_threshold integer;v_extra integer;v_map record;v_inserted uuid;
begin
  if target_user is null or target_model is null then return; end if;
  with solved as (
    select distinct on (coalesce(a.canonical_problem_id,p.problem_id)) coalesce(a.canonical_problem_id,p.problem_id) canonical_id,
      c.normalized_difficulty,p.first_accepted_at
    from public.user_problem_progress p join public.problem_catalog c on c.id=p.problem_id
    left join public.problem_aliases a on a.problem_id=p.problem_id
    where p.user_id=target_user and p.is_solved and p.platform in ('codeforces','atcoder') and c.normalized_difficulty is not null
    order by coalesce(a.canonical_problem_id,p.problem_id),c.normalized_difficulty desc,p.first_accepted_at
  ) select count(*),max(normalized_difficulty),round(avg(normalized_difficulty) filter(where first_accepted_at>=now()-interval '90 days'),2)
    into v_n,v_max,v_recent from solved;
  v_k:=least(20,greatest(5,ceil(v_n*.25)::integer));
  with solved as (
    select distinct on (coalesce(a.canonical_problem_id,p.problem_id)) coalesce(a.canonical_problem_id,p.problem_id) canonical_id,c.normalized_difficulty
    from public.user_problem_progress p join public.problem_catalog c on c.id=p.problem_id
    left join public.problem_aliases a on a.problem_id=p.problem_id
    where p.user_id=target_user and p.is_solved and p.platform in ('codeforces','atcoder') and c.normalized_difficulty is not null
    order by coalesce(a.canonical_problem_id,p.problem_id),c.normalized_difficulty desc
  ),top_sample as (select normalized_difficulty from solved order by normalized_difficulty desc limit v_k)
  select count(*),round(avg(normalized_difficulty),2) into v_sample,v_average from top_sample;

  if v_n>=12 and v_average>=2800 then
    select count(distinct coalesce(a.canonical_problem_id,p.problem_id)) into v_extra from public.user_problem_progress p join public.problem_catalog c on c.id=p.problem_id left join public.problem_aliases a on a.problem_id=p.problem_id
      where p.user_id=target_user and p.is_solved and p.platform in ('codeforces','atcoder') and c.normalized_difficulty>=2800;
    if v_extra>=3 then v_target:='legend';v_threshold:=2800;end if;
  end if;
  if v_target is null and v_n>=10 and v_average>=2400 then
    select count(distinct coalesce(a.canonical_problem_id,p.problem_id)) into v_extra from public.user_problem_progress p join public.problem_catalog c on c.id=p.problem_id left join public.problem_aliases a on a.problem_id=p.problem_id
      where p.user_id=target_user and p.is_solved and p.platform in ('codeforces','atcoder') and c.normalized_difficulty>=2400;
    if v_extra>=3 then v_target:='master';v_threshold:=2400;end if;
  end if;
  if v_target is null and v_n>=8 and v_average>=2000 then
    select count(distinct coalesce(a.canonical_problem_id,p.problem_id)) into v_extra from public.user_problem_progress p join public.problem_catalog c on c.id=p.problem_id left join public.problem_aliases a on a.problem_id=p.problem_id
      where p.user_id=target_user and p.is_solved and p.platform in ('codeforces','atcoder') and c.normalized_difficulty>=2000;
    if v_extra>=2 then v_target:='platinum';v_threshold:=2000;end if;
  end if;
  if v_target is null and v_n>=6 and v_average>=1700 then
    select count(distinct coalesce(a.canonical_problem_id,p.problem_id)) into v_extra from public.user_problem_progress p join public.problem_catalog c on c.id=p.problem_id left join public.problem_aliases a on a.problem_id=p.problem_id
      where p.user_id=target_user and p.is_solved and p.platform in ('codeforces','atcoder') and c.normalized_difficulty>=1700;
    if v_extra>=2 then v_target:='gold';v_threshold:=1700;end if;
  end if;
  if v_target is null and v_n>=5 and v_average>=1400 then
    select count(distinct coalesce(a.canonical_problem_id,p.problem_id)) into v_extra from public.user_problem_progress p join public.problem_catalog c on c.id=p.problem_id left join public.problem_aliases a on a.problem_id=p.problem_id
      where p.user_id=target_user and p.is_solved and p.platform in ('codeforces','atcoder') and c.normalized_difficulty>=1400;
    if v_extra>=2 then v_target:='silver';v_threshold:=1400;end if;
  end if;
  if v_target is null and v_n>=5 and v_average>=1100 then
    select count(distinct coalesce(a.canonical_problem_id,p.problem_id)) into v_extra from public.user_problem_progress p join public.problem_catalog c on c.id=p.problem_id left join public.problem_aliases a on a.problem_id=p.problem_id
      where p.user_id=target_user and p.is_solved and p.platform in ('codeforces','atcoder') and c.normalized_difficulty>=1100;
    if v_extra>=2 then v_target:='bronze';v_threshold:=1100;end if;
  end if;

  insert into public.user_ability_estimates(user_id,model_version,known_solved_count,hard_problem_average,sample_size,max_difficulty,recent_90d_average,direct_unlock_map,evidence,calculated_at)
  values(target_user,target_model,v_n,v_average,v_sample,v_max,v_recent,v_target,
    jsonb_build_object('formula','top min(20, max(5, ceil(n*25%)))','threshold',v_threshold,'threshold_solves',coalesce(v_extra,0)),now())
  on conflict(user_id) do update set model_version=excluded.model_version,known_solved_count=excluded.known_solved_count,
    hard_problem_average=excluded.hard_problem_average,sample_size=excluded.sample_size,max_difficulty=excluded.max_difficulty,
    recent_90d_average=excluded.recent_90d_average,direct_unlock_map=excluded.direct_unlock_map,evidence=excluded.evidence,calculated_at=now();

  if v_target is null then return; end if;
  for v_map in select m.* from public.training_maps m where m.position<=(select position from public.training_maps where code=v_target) order by m.position loop
    v_inserted:=null;
    insert into public.map_unlocks(user_id,map_code,model_version,detail)
    values(target_user,v_map.code,target_model,jsonb_build_object('reason','ability_average','hard_problem_average',v_average,'sample_size',v_sample,'known_solved_count',v_n,'threshold',v_threshold,'model_version',target_model))
    on conflict(user_id,map_code) do nothing returning target_user into v_inserted;
    if v_inserted is not null and v_map.code=v_target then
      insert into public.expedition_logs(user_id,type,title,message,detail)
      values(target_user,'map_unlocked','能力直达：'||v_map.name,
        format('高难过题平均难度 %s（%s 道样本），已开放本地图及之前地图；区域掌握度仍按证据独立计算。',round(v_average),v_sample),
        jsonb_build_object('map',v_target,'reason','ability_average','average',v_average,'sample_size',v_sample));
    end if;
  end loop;
end $$;

create or replace function private.build_ability_estimate(target_user uuid)
returns jsonb language sql stable security definer set search_path=public,pg_catalog
as $$
  select coalesce((select jsonb_build_object('hard_problem_average',hard_problem_average,'sample_size',sample_size,'known_solved_count',known_solved_count,
    'max_difficulty',max_difficulty,'recent_90d_average',recent_90d_average,'direct_unlock_map',direct_unlock_map,'evidence',evidence,'calculated_at',calculated_at)
    from public.user_ability_estimates where user_id=target_user),'{}'::jsonb);
$$;

create or replace function public.refresh_training_user(target_user uuid)
returns void language plpgsql security definer set search_path=private,public,pg_catalog
as $$
declare v_model integer;
begin
  if current_user not in ('postgres','service_role','supabase_admin') then raise exception 'service role required'; end if;
  perform private.refresh_training_aggregates(target_user);
  perform private.refresh_training_mastery(target_user);
  select version into v_model from public.mastery_model_versions where active order by version desc limit 1;
  perform private.refresh_ability_unlocks(target_user,v_model);
  perform private.refresh_training_recommendations(target_user);
end $$;

create or replace function private.build_training_map(target_user uuid)
returns jsonb language sql stable security definer set search_path=public,pg_catalog
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'code',m.code,'name',m.name,'subtitle',m.subtitle,'icon',m.icon,'position',m.position,'color',m.color,'description',m.description,
    'unlocked',u.map_code is not null,'unlocked_at',u.unlocked_at,'unlock_reason',u.detail->>'reason','unlock_detail',u.detail,
    'mastered',not exists(select 1 from public.map_regions mr left join public.skill_mastery ms on ms.region_code=mr.code and ms.user_id=target_user and ms.model_version=(select version from public.mastery_model_versions where active limit 1) where mr.map_code=m.code and mr.is_core and coalesce(ms.mastery_percent,0)<100),
    'algorithms',coalesce((select jsonb_agg(r.name order by r.position) from public.map_regions r where r.map_code=m.code and r.is_core),'[]'::jsonb),
    'progress',coalesce((select round(avg(s.mastery_percent)) from public.map_regions r join public.skill_mastery s on s.region_code=r.code and s.user_id=target_user and s.model_version=(select version from public.mastery_model_versions where active limit 1) where r.map_code=m.code and r.is_core),0),
    'regions',coalesce((select jsonb_agg(jsonb_build_object('code',r.code,'name',r.name,'icon',r.icon,'description',r.description,'core',r.is_core,
      'percent',coalesce(s.mastery_percent,0),'confidence',coalesce(s.confidence,'low'),'assessment',coalesce(s.assessment,'unexplored'),
      'evidence',coalesce(s.evidence,0),'evidence_target',r.breadth_target,'upper_evidence',coalesce(s.upper_evidence,0),'upper_target',r.upper_target,
      'solved',coalesce(s.solved_count,0),'attempted',coalesce(s.attempted_count,0),'covered_skills',coalesce(s.covered_skills,0),'required_skills',coalesce(s.required_skills,0),
      'active_days',coalesce(s.active_days,0),'required_days',r.required_days,'active_weeks',coalesce(s.active_weeks,0),'required_weeks',r.required_weeks,
      'last_trained_at',s.last_trained_at,'explanation',coalesce(s.explanation,'尚无可靠训练证据。')) order by r.position)
      from public.map_regions r left join public.skill_mastery s on s.region_code=r.code and s.user_id=target_user and s.model_version=(select version from public.mastery_model_versions where active limit 1)
      where r.map_code=m.code),'[]'::jsonb)
  ) order by m.position),'[]'::jsonb)
  from public.training_maps m left join public.map_unlocks u on u.map_code=m.code and u.user_id=target_user;
$$;

-- Rebuild the dashboard/profile DTOs with the ability estimate and safe frame.
create or replace function public.get_my_training_dashboard()
returns jsonb language plpgsql stable security definer set search_path=public,private,pg_catalog
as $$
declare v_user uuid:=auth.uid();v_result jsonb;v_model integer;
begin
  if v_user is null then raise exception 'authentication required'; end if;
  select version into v_model from public.mastery_model_versions where active limit 1;
  select jsonb_build_object(
    'generated_at',now(),'data_through',(select max(data_through) from public.external_accounts where user_id=v_user and platform in ('codeforces','atcoder')),
    'model_version',v_model,'classification_coverage',coalesce((select round(100.0*count(*) filter(where exists(select 1 from public.problem_skill_tags t where t.problem_id=p.problem_id and t.confidence>=.7))/nullif(count(*),0)) from public.user_problem_progress p where p.user_id=v_user and p.is_solved),0),
    'summary',jsonb_build_object('solved',(select count(*) from public.user_problem_progress where user_id=v_user and is_solved),'attempts',(select coalesce(sum(attempt_count),0) from public.user_problem_progress where user_id=v_user),'active_days',(select count(distinct activity_date) from public.training_daily_stats where user_id=v_user),'freshness',coalesce((select least(100,round(100.0*count(distinct activity_date)/30)) from public.training_daily_stats where user_id=v_user and activity_date>=private.china_today()-89),0),'maps_unlocked',(select count(*) from public.map_unlocks where user_id=v_user)),
    'ability_estimate',private.build_ability_estimate(v_user),'accounts',private.build_training_accounts(v_user),'maps',private.build_training_map(v_user),
    'privacy',coalesce((select to_jsonb(p)-'user_id' from public.training_privacy p where p.user_id=v_user),'{}'::jsonb),
    'logs',coalesce((select jsonb_agg(x order by (x->>'created_at')::timestamptz desc) from (select jsonb_build_object('type',type,'title',title,'message',message,'created_at',created_at) x from public.expedition_logs where user_id=v_user order by created_at desc limit 20) q),'[]'::jsonb)
  ) into v_result;return v_result;
end $$;

create or replace function public.get_training_profile(target_user uuid)
returns jsonb language plpgsql security definer set search_path=public,private,pg_catalog
as $$
declare v_viewer uuid:=auth.uid();v_priv public.training_privacy;v_self boolean;v_profile record;v_model integer;
begin
  select * into v_priv from public.training_privacy where user_id=target_user;
  if not found then v_priv:=row(target_user,true,true,true,true,now())::public.training_privacy; end if;
  v_self:=v_viewer=target_user;select * into v_profile from public.public_profile_stats where id=target_user;
  if v_profile.id is null then return null; end if;select version into v_model from public.mastery_model_versions where active limit 1;
  return jsonb_build_object('generated_at',now(),'model_version',v_model,
    'user',jsonb_build_object('id',v_profile.id,'handle',v_profile.handle,'display_name',v_profile.display_name,'avatar_url',v_profile.avatar_url,'role',v_profile.role,'name_color',v_profile.name_color,'avatar_frame',v_profile.avatar_frame),
    'visibility',jsonb_build_object('accounts',v_self or v_priv.accounts_public,'heatmap',v_self or v_priv.heatmap_public,'map',v_self or v_priv.map_public,'recent',v_self or v_priv.recent_public),
    'accounts',case when v_self then private.build_training_accounts(target_user) when v_priv.accounts_public then private.build_public_training_accounts(target_user) else null end,
    'maps',case when v_self or v_priv.map_public then private.build_training_map(target_user) else null end,
    'ability_estimate',case when v_self or v_priv.map_public then private.build_ability_estimate(target_user) else null end,
    'summary',case when v_self or v_priv.map_public then jsonb_build_object('solved',(select count(*) from public.user_problem_progress where user_id=target_user and is_solved),'active_days',(select count(distinct activity_date) from public.training_daily_stats where user_id=target_user),'maps_unlocked',(select count(*) from public.map_unlocks where user_id=target_user)) else null end,
    'recent',case when v_self or v_priv.recent_public then coalesce((select jsonb_agg(x) from (select activity_date,sum(solved_count) solved,sum(submission_count) attempts from public.training_daily_stats where user_id=target_user and platform in ('codeforces','atcoder') group by activity_date order by activity_date desc limit 14) x),'[]'::jsonb) else null end);
end $$;

drop function if exists public.get_explorer_leaderboard(integer);
create function public.get_explorer_leaderboard(limit_count integer default 100)
returns table(user_id uuid,handle text,display_name text,avatar_url text,role text,name_color text,maps_unlocked bigint,mastery_total bigint,last_unlocked_at timestamptz,mastered_maps bigint,direct_unlocks bigint,avatar_frame jsonb)
language sql stable security definer set search_path=public,pg_catalog
as $$
  select p.id,p.handle,p.display_name,p.avatar_url,p.role,p.name_color,coalesce(u.maps_unlocked,0),coalesce(s.mastery_total,0),u.last_unlocked_at,
    coalesce(s.mastered_maps,0),coalesce(u.direct_unlocks,0),p.avatar_frame
  from public.public_profile_stats p join public.training_privacy v on v.user_id=p.id and v.map_public
  left join lateral(select count(*) maps_unlocked,count(*) filter(where detail->>'reason'='ability_average') direct_unlocks,max(unlocked_at) last_unlocked_at from public.map_unlocks where user_id=p.id)u on true
  left join lateral(select coalesce(sum(sm.mastery_percent),0)::bigint mastery_total,
    count(distinct r.map_code) filter(where not exists(select 1 from public.map_regions mr left join public.skill_mastery mx on mx.region_code=mr.code and mx.user_id=p.id and mx.model_version=(select version from public.mastery_model_versions where active limit 1) where mr.map_code=r.map_code and mr.is_core and coalesce(mx.mastery_percent,0)<100)) mastered_maps
    from public.skill_mastery sm join public.map_regions r on r.code=sm.region_code and r.is_core where sm.user_id=p.id and sm.model_version=(select version from public.mastery_model_versions where active limit 1))s on true
  order by coalesce(s.mastered_maps,0) desc,coalesce(s.mastery_total,0) desc,coalesce(u.maps_unlocked,0) desc,u.last_unlocked_at
  limit least(greatest(coalesce(limit_count,100),1),200);
$$;

grant execute on function public.get_explorer_leaderboard(integer) to anon,authenticated;
revoke execute on function private.refresh_ability_unlocks(uuid,integer),private.build_ability_estimate(uuid) from public,anon,authenticated;

-- Recalculate all existing active training users under the phase-2 model.
select public.refresh_training_user(p.id) from public.profiles p
where exists(select 1 from public.external_accounts a where a.user_id=p.id and a.platform in ('codeforces','atcoder'))
   or exists(select 1 from public.submission_events e where e.user_id=p.id and e.platform in ('codeforces','atcoder'));

comment on table public.user_ability_estimates is 'Precomputed, alias-deduplicated high-problem difficulty estimate used only for permanent map access.';

-- Leather Algorithm Expedition phase 2A:
-- disable the unapproved Luogu provider, harden display-name changes, and add
-- achievement-backed avatar frames.  This migration is intentionally additive.

-- ---------------------------------------------------------------------------
-- Luogu provider shutdown. Schema enum/check compatibility is retained so an
-- approved provider can be restored in a future migration.
-- ---------------------------------------------------------------------------
insert into public.training_feature_flags(key,enabled,config,updated_at)
values('luogu_sync_enabled',false,'{"status":"awaiting_official_permission","public_message":"洛谷暂未提供允许使用的提交记录接口，Leather 已暂停相关功能。"}'::jsonb,now())
on conflict(key) do update set enabled=false,config=excluded.config,updated_at=now();

update public.binding_challenges
set status='cancelled',code_hash=''
where platform='luogu' and status='pending';

update public.training_sync_jobs
set status='cancelled',finished_at=coalesce(finished_at,now()),locked_at=null,locked_by=null,
    error_code='platform_unavailable',error_message='Provider disabled pending official permission'
where platform='luogu' and status in ('queued','running');

update public.external_accounts
set status='disabled',next_sync_at='infinity',last_error_code='platform_unavailable',
    last_error_message='洛谷暂未提供允许使用的提交记录接口，Leather 已暂停相关功能。',updated_at=now()
where platform='luogu';

update public.problem_catalog set is_available=false,updated_at=now() where platform='luogu';
delete from public.training_recommendations r using public.problem_catalog p
where r.problem_id=p.id and p.platform='luogu';
-- This achievement explicitly depended on all three active providers, so it
-- must not remain awarded while one provider is unavailable.
delete from public.user_achievements where code='training_three_platforms';

do $$
declare v_users uuid[]; v_user uuid;
begin
  select array_agg(distinct user_id) into v_users from public.submission_events where platform='luogu';
  delete from public.submission_events where platform='luogu';
  if v_users is not null then
    foreach v_user in array v_users loop
      perform public.refresh_training_user(v_user);
    end loop;
  end if;
end $$;

create or replace function private.build_training_accounts(target_user uuid)
returns jsonb language sql stable security definer set search_path=public,pg_catalog
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'platform',a.platform,'handle',a.handle,'avatar_url',a.avatar_url,'profile_url',a.profile_url,'status',a.status,'verified_at',a.verified_at,'last_success_at',a.last_success_at,'data_through',a.data_through,'last_error',a.last_error_message) order by a.platform),'[]'::jsonb)
  from public.external_accounts a
  where a.user_id=target_user and a.platform in ('codeforces','atcoder') and a.status<>'disabled';
$$;

create or replace function private.build_public_training_accounts(target_user uuid)
returns jsonb language sql stable security definer set search_path=public,pg_catalog
as $$
  select coalesce(jsonb_agg(jsonb_build_object('platform',a.platform,'handle',a.handle,'avatar_url',a.avatar_url,'profile_url',a.profile_url,'status',a.status,'verified_at',a.verified_at,'last_success_at',a.last_success_at,'data_through',a.data_through) order by a.platform),'[]'::jsonb)
  from public.external_accounts a
  where a.user_id=target_user and a.platform in ('codeforces','atcoder') and a.status<>'disabled';
$$;

create or replace function public.get_training_heatmap(target_user uuid,from_date date default null,to_date date default null,platform_name text default null)
returns table(activity_date date,platform text,submission_count bigint,accepted_submissions bigint,solved_count bigint)
language plpgsql security definer set search_path=public,private,pg_catalog
as $$
declare v_public boolean;v_viewer uuid:=auth.uid();v_staff boolean:=false;
begin
  if platform_name='luogu' then raise exception 'platform unavailable'; end if;
  if platform_name is not null and platform_name not in ('codeforces','atcoder') then raise exception 'invalid platform'; end if;
  select heatmap_public into v_public from public.training_privacy where user_id=target_user;
  if v_viewer is not null then v_staff:=private.is_staff(v_viewer);end if;
  if v_viewer is distinct from target_user and not coalesce(v_public,true) and not v_staff then raise exception 'training heatmap is private';end if;
  if v_viewer is distinct from target_user and not coalesce(v_public,true) and v_staff then
    insert into private.training_access_audit(actor_id,target_user_id,resource,context)
    values(v_viewer,target_user,'private_heatmap',jsonb_build_object('from',from_date,'to',to_date,'platform',platform_name));
  end if;
  return query select d.activity_date,d.platform,sum(d.submission_count),sum(d.accepted_submissions),sum(d.solved_count)
  from public.training_daily_stats d where d.user_id=target_user and d.platform in ('codeforces','atcoder')
    and d.activity_date>=coalesce(from_date,private.china_today()-364) and d.activity_date<=coalesce(to_date,private.china_today())
    and (platform_name is null or d.platform=platform_name)
  group by d.activity_date,d.platform order by d.activity_date,d.platform;
end $$;

create or replace function public.enqueue_training_sync(platform_name text default null)
returns jsonb language plpgsql security definer set search_path=public,private,pg_catalog
as $$
declare v_user uuid:=auth.uid();v_account record;v_job uuid;v_jobs jsonb:='[]'::jsonb;v_existing record;
begin
  if v_user is null then raise exception 'authentication required'; end if;
  if private.is_banned(v_user) then raise exception 'account banned'; end if;
  if platform_name='luogu' then
    return jsonb_build_object('error','platform_unavailable','message','洛谷暂未提供允许使用的提交记录接口，Leather 已暂停相关功能。','jobs','[]'::jsonb);
  end if;
  if platform_name is not null and platform_name not in ('codeforces','atcoder') then raise exception 'invalid platform'; end if;
  for v_account in select * from public.external_accounts where user_id=v_user
    and platform in ('codeforces','atcoder') and status in ('active','degraded','reverify_required')
    and (platform_name is null or platform=platform_name) order by platform
  loop
    v_existing:=null;
    select id,status,created_at into v_existing from public.training_sync_jobs
    where external_account_id=v_account.id and status in ('queued','running') order by created_at desc limit 1;
    if v_existing.id is not null then
      v_jobs:=v_jobs||jsonb_build_array(jsonb_build_object('id',v_existing.id,'platform',v_account.platform,'status',v_existing.status,'cooldown',false));
      continue;
    end if;
    v_existing:=null;
    select id,status,created_at into v_existing from public.training_sync_jobs
    where external_account_id=v_account.id and requested_by='manual' and created_at>now()-interval '15 minutes'
    order by created_at desc limit 1;
    if v_existing.id is not null then
      v_jobs:=v_jobs||jsonb_build_array(jsonb_build_object('id',v_existing.id,'platform',v_account.platform,'status',v_existing.status,'cooldown',true));
      continue;
    end if;
    insert into public.training_sync_jobs(user_id,external_account_id,platform,kind,requested_by,priority)
    values(v_user,v_account.id,v_account.platform,case when v_account.last_success_at is null then 'initial' else 'incremental' end,'manual',50)
    returning id into v_job;
    v_jobs:=v_jobs||jsonb_build_array(jsonb_build_object('id',v_job,'platform',v_account.platform,'status','queued','cooldown',false));
  end loop;
  return jsonb_build_object('jobs',v_jobs,'queued_at',now());
end $$;

create or replace function public.enqueue_due_training_syncs(limit_count integer default 50)
returns integer language plpgsql security definer set search_path=public,pg_catalog
as $$
declare v_count integer;
begin
  insert into public.training_sync_jobs(user_id,external_account_id,platform,kind,requested_by,priority)
  select a.user_id,a.id,a.platform,case when a.last_success_at is null then 'initial' else 'incremental' end,'automatic',0
  from public.external_accounts a
  where a.platform in ('codeforces','atcoder') and a.status in ('active','degraded') and a.next_sync_at<=now()
    and not exists(select 1 from public.training_sync_jobs j where j.external_account_id=a.id and j.status in ('queued','running'))
  order by a.next_sync_at limit least(greatest(coalesce(limit_count,50),1),200) on conflict do nothing;
  get diagnostics v_count=row_count;return v_count;
end $$;

create or replace function public.claim_training_sync_job(worker_name text)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog
as $$
declare v_job public.training_sync_jobs;
begin
  update public.training_sync_jobs set status='queued',locked_at=null,locked_by=null,run_after=now(),error_code='stale_lock',error_message='Worker lease expired'
  where status='running' and platform in ('codeforces','atcoder') and locked_at<now()-interval '10 minutes';
  update public.training_sync_jobs set status='cancelled',finished_at=coalesce(finished_at,now()),locked_at=null,locked_by=null,error_code='platform_unavailable'
  where status in ('queued','running') and platform='luogu';
  select * into v_job from public.training_sync_jobs
  where status='queued' and platform in ('codeforces','atcoder') and run_after<=now()
  order by priority desc,created_at for update skip locked limit 1;
  if v_job.id is null then return null; end if;
  update public.training_sync_jobs set status='running',locked_at=now(),locked_by=left(coalesce(worker_name,'worker'),80),started_at=coalesce(started_at,now()),attempts=attempts+1
  where id=v_job.id returning * into v_job;
  return to_jsonb(v_job);
end $$;

-- ---------------------------------------------------------------------------
-- Safe email-prefix initialization and atomic display-name moderation.
-- ---------------------------------------------------------------------------
create or replace function private.profile_name_violation(input_text text)
returns text language plpgsql stable security definer set search_path=private,pg_catalog
as $$
declare v text; v_reason text;
begin
  v:=normalize(coalesce(input_text,''),NFKC);
  if char_length(v)<1 or char_length(v)>30 or octet_length(v)>120 then return '名字长度不符合规则'; end if;
  if v ~ '[[:cntrl:]]' or position(chr(8203) in v)>0 or position(chr(8204) in v)>0 or position(chr(8205) in v)>0
    or position(chr(8234) in v)>0 or position(chr(8235) in v)>0 or position(chr(8236) in v)>0 or position(chr(8237) in v)>0 or position(chr(8238) in v)>0
    or position(chr(8288) in v)>0 or position(chr(65279) in v)>0 then return '名字包含不可见控制字符'; end if;
  v_reason:=private.content_violation(v);
  if v_reason is not null then return v_reason; end if;
  if v ~* '(https?://|www\.|t\.me/|discord\.gg|vx[:：]?|v信|微信|qq[:：]?)' then return '名字包含导流信息'; end if;
  if regexp_replace(v,'[^0-9]','','g') ~ '1[3-9][0-9]{9}' then return '名字包含手机号'; end if;
  return null;
end $$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path=public,private,pg_catalog
as $$
declare v_base text;v_handle text;v_name text;
begin
  v_name:=trim(regexp_replace(normalize(coalesce(split_part(new.email,'@',1),''),NFKC),'[[:cntrl:]]','','g'));
  v_name:=left(v_name,30);
  if v_name='' or private.profile_name_violation(v_name) is not null then
    v_name:='user_'||substr(replace(new.id::text,'-',''),1,8);
  end if;
  v_base:=lower(regexp_replace(normalize(coalesce(split_part(new.email,'@',1),''),NFKC),'[^a-zA-Z0-9_-]','','g'));
  if char_length(v_base)<3 or v_base='leather-handbag' then v_base:='user_'||substr(replace(new.id::text,'-',''),1,8); end if;
  v_handle:=left(v_base,20)||'_'||substr(replace(new.id::text,'-',''),1,6);
  insert into public.profiles(id,handle,display_name,avatar_url) values(new.id,v_handle,v_name,null);
  return new;
end $$;

drop function if exists public.update_my_profile(text,text,text);
create function public.update_my_profile(p_display_name text,p_handle text,p_bio text)
returns jsonb language plpgsql security definer set search_path=public,private,pg_catalog
as $$
declare v_user uuid:=auth.uid();v_name text;v_handle text;v_bio text;v_reason text;v_profile jsonb;
begin
  if v_user is null then raise exception 'authentication required'; end if;
  if private.is_banned(v_user) then
    select jsonb_build_object('id',p.id,'handle',p.handle,'display_name',p.display_name,'avatar_url',p.avatar_url,'bio',p.bio,'role',p.role,'banned_at',p.banned_at,'ban_reason',p.ban_reason)
    into v_profile from public.profiles p where p.id=v_user;
    return jsonb_build_object('ok',false,'banned',true,'reason',coalesce(v_profile->>'ban_reason','account banned'),'profile',v_profile);
  end if;
  v_name:=trim(normalize(coalesce(p_display_name,''),NFKC));
  v_handle:=lower(trim(normalize(coalesce(p_handle,''),NFKC)));
  v_bio:=trim(normalize(coalesce(p_bio,''),NFKC));
  v_reason:=private.profile_name_violation(v_name);
  if v_reason is not null then
    if private.is_owner(v_user) then
      return jsonb_build_object('ok',false,'banned',false,'reason','站长账号已受防误封保护，违规名字未写入。','profile',null);
    end if;
    perform set_config('app.privileged_profile_write','true',true);
    update public.profiles set handle='user_'||substr(replace(id::text,'-',''),1,12),display_name='已封禁用户',bio='',avatar_url=null,
      banned_at=coalesce(banned_at,now()),ban_reason=left('名字违规：'||v_reason,500),updated_at=now() where id=v_user;
    insert into private.moderation_events(user_id,source_table,reason,actor_id)
    values(v_user,'profile_display_name','名字违规：'||v_reason,v_user);
    select jsonb_build_object('id',p.id,'handle',p.handle,'display_name',p.display_name,'avatar_url',p.avatar_url,'bio',p.bio,'role',p.role,'banned_at',p.banned_at,'ban_reason',p.ban_reason)
    into v_profile from public.profiles p where p.id=v_user;
    return jsonb_build_object('ok',false,'banned',true,'reason','名字违规：'||v_reason,'profile',v_profile);
  end if;
  update public.profiles set display_name=v_name,handle=v_handle,bio=v_bio,updated_at=now() where id=v_user;
  select jsonb_build_object('id',p.id,'handle',p.handle,'display_name',p.display_name,'avatar_url',p.avatar_url,'bio',p.bio,'role',p.role,'banned_at',p.banned_at,'ban_reason',p.ban_reason)
  into v_profile from public.profiles p where p.id=v_user;
  if (v_profile->>'banned_at') is not null then
    return jsonb_build_object('ok',false,'banned',true,'reason',v_profile->>'ban_reason','profile',v_profile);
  end if;
  return jsonb_build_object('ok',true,'banned',false,'reason',null,'profile',v_profile);
end $$;

create or replace function private.moderate_profile()
returns trigger language plpgsql security definer set search_path=public,private,pg_catalog
as $$
declare v_reason text;
begin
  v_reason:=private.profile_name_violation(new.display_name);
  if v_reason is null and (char_length(new.bio)>300 or char_length(new.handle)>30) then v_reason:='超大资料输入资源攻击'; end if;
  if v_reason is null then v_reason:=private.content_violation(concat_ws(' ',new.handle,new.bio)); end if;
  if v_reason is not null and new.role<>'owner' then
    new.handle:='user_'||substr(replace(new.id::text,'-',''),1,12);new.display_name:='已封禁用户';new.bio:='';new.avatar_url:=null;
    new.banned_at:=coalesce(new.banned_at,now());new.ban_reason:=v_reason;
    if tg_op='INSERT' then
      insert into private.moderation_events(user_id,source_table,reason,actor_id) values(null,'profiles',v_reason||' / user='||new.id::text,new.id);
    else
      insert into private.moderation_events(user_id,source_table,reason,actor_id) values(new.id,'profiles',v_reason,new.id);
    end if;
  end if;
  return new;
end $$;

grant execute on function public.update_my_profile(text,text,text) to authenticated;
revoke execute on function public.update_my_profile(text,text,text) from public,anon;
revoke execute on function private.profile_name_violation(text) from public,anon,authenticated;

-- ---------------------------------------------------------------------------
-- Achievement avatar frames.
-- ---------------------------------------------------------------------------
insert into public.achievement_definitions(code,name,description,icon,sort_order) values
('luck_chromatic','炫彩天选','签到抽中 111101','✺',115)
on conflict(code) do update set name=excluded.name,description=excluded.description,icon=excluded.icon,sort_order=excluded.sort_order;

create table if not exists public.avatar_frame_definitions(
  code text primary key,
  name text not null,
  description text not null,
  rarity text not null check(rarity in ('common','rare','epic','legendary','chromatic')),
  style_class text not null unique check(style_class ~ '^frame-[a-z0-9-]{2,40}$'),
  achievement_code text not null unique references public.achievement_definitions(code) on delete restrict,
  sort_order integer not null default 0,
  is_hidden boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.user_avatar_frames(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  frame_code text not null references public.avatar_frame_definitions(code) on delete restrict,
  source_achievement text not null references public.achievement_definitions(code) on delete restrict,
  unlocked_at timestamptz not null default now(),
  unique(user_id,frame_code)
);
create index if not exists user_avatar_frames_user_idx on public.user_avatar_frames(user_id,unlocked_at);

insert into public.avatar_frame_definitions(code,name,description,rarity,style_class,achievement_code,sort_order) values
('expedition_bronze','远征铜环','完成第一个 Codeforces 或 AtCoder 绑定','common','frame-expedition-bronze','training_first_bind',10),
('laurel_streak','月桂恒心','连续签到 30 天','rare','frame-laurel-streak','streak_30',20),
('ink_author','墨羽作者','发布 20 篇公开文章','rare','frame-ink-author','posts_20',30),
('community_crown','社区星冠','获得 50 位粉丝','epic','frame-community-crown','followers_50',40),
('balanced_emerald','均衡翡翠','一张地图全部核心区域达到 80%','epic','frame-balanced-emerald','training_balanced',50),
('map_conqueror','地图征服者','完整点亮一张算法地图','legendary','frame-map-conqueror','training_map_master',60),
('chromatic_chosen','炫彩天选','签到抽中 111101','chromatic','frame-chromatic-chosen','luck_chromatic',70)
on conflict(code) do update set name=excluded.name,description=excluded.description,rarity=excluded.rarity,style_class=excluded.style_class,achievement_code=excluded.achievement_code,sort_order=excluded.sort_order;

alter table public.profiles add column if not exists equipped_avatar_frame text references public.avatar_frame_definitions(code) on delete set null;

create or replace function private.unlock_achievement_frame()
returns trigger language plpgsql security definer set search_path=public,private,pg_catalog
as $$
declare v_frame text;v_id uuid;v_name text;
begin
  select code,name into v_frame,v_name from public.avatar_frame_definitions where achievement_code=new.code;
  if v_frame is null then return new; end if;
  insert into public.user_avatar_frames(user_id,frame_code,source_achievement,unlocked_at)
  values(new.user_id,v_frame,new.code,new.achieved_at) on conflict(user_id,frame_code) do nothing returning id into v_id;
  if v_id is not null then
    perform private.push_notification(new.user_id,null,'achievement','user_avatar_frames',v_id,'解锁头像框：'||v_name);
  end if;
  return new;
end $$;
drop trigger if exists zz_unlock_achievement_frame on public.user_achievements;
create trigger zz_unlock_achievement_frame after insert on public.user_achievements for each row execute function private.unlock_achievement_frame();

create or replace function private.award_chromatic_checkin()
returns trigger language plpgsql security definer set search_path=public,private,pg_catalog
as $$
begin
  if new.number=111101 then perform private.award_achievement(new.user_id,'luck_chromatic','111101'); end if;
  return new;
end $$;
drop trigger if exists zz_award_chromatic_checkin on public.daily_checkins;
create trigger zz_award_chromatic_checkin after insert on public.daily_checkins for each row execute function private.award_chromatic_checkin();

select private.award_achievement(user_id,'luck_chromatic','111101') from public.daily_checkins where number=111101;
insert into public.user_avatar_frames(user_id,frame_code,source_achievement,unlocked_at)
select a.user_id,f.code,a.code,a.achieved_at from public.user_achievements a join public.avatar_frame_definitions f on f.achievement_code=a.code
on conflict(user_id,frame_code) do nothing;

create or replace function public.equip_avatar_frame(frame_code text default null)
returns jsonb language plpgsql security definer set search_path=public,private,pg_catalog
as $$
declare v_user uuid:=auth.uid();v_frame record;
begin
  if v_user is null then raise exception 'authentication required'; end if;
  if private.is_banned(v_user) then raise exception 'account banned'; end if;
  if nullif(trim(coalesce(frame_code,'')),'') is null then
    update public.profiles set equipped_avatar_frame=null,updated_at=now() where id=v_user;
    return null;
  end if;
  select d.* into v_frame from public.avatar_frame_definitions d join public.user_avatar_frames u on u.frame_code=d.code
  where u.user_id=v_user and d.code=frame_code;
  if v_frame.code is null then raise exception 'avatar frame is not unlocked'; end if;
  update public.profiles set equipped_avatar_frame=v_frame.code,updated_at=now() where id=v_user;
  return jsonb_build_object('code',v_frame.code,'name',v_frame.name,'rarity',v_frame.rarity,'style_class',v_frame.style_class);
end $$;

create or replace function public.get_my_avatar_frames()
returns table(code text,name text,description text,rarity text,style_class text,unlocked boolean,equipped boolean,unlocked_at timestamptz)
language sql stable security definer set search_path=public,pg_catalog
as $$
  select d.code,d.name,case when d.is_hidden and u.frame_code is null then '隐藏成就' else d.description end,d.rarity,d.style_class,
    u.frame_code is not null,p.equipped_avatar_frame=d.code,u.unlocked_at
  from public.avatar_frame_definitions d cross join public.profiles p
  left join public.user_avatar_frames u on u.frame_code=d.code and u.user_id=p.id
  where p.id=auth.uid() order by d.sort_order,d.code;
$$;

alter table public.avatar_frame_definitions enable row level security;
alter table public.user_avatar_frames enable row level security;
drop policy if exists avatar_frame_definitions_read on public.avatar_frame_definitions;
create policy avatar_frame_definitions_read on public.avatar_frame_definitions for select to anon,authenticated using(not is_hidden);
drop policy if exists user_avatar_frames_own_read on public.user_avatar_frames;
create policy user_avatar_frames_own_read on public.user_avatar_frames for select to authenticated using(user_id=auth.uid());
revoke all on public.avatar_frame_definitions,public.user_avatar_frames from public,anon,authenticated;
grant select on public.avatar_frame_definitions to anon,authenticated;
grant select on public.user_avatar_frames to authenticated;
grant execute on function public.equip_avatar_frame(text),public.get_my_avatar_frames() to authenticated;
revoke execute on function public.equip_avatar_frame(text),public.get_my_avatar_frames() from public,anon;
revoke execute on function private.unlock_achievement_frame(),private.award_chromatic_checkin() from public,anon,authenticated;

-- Append a privacy-safe frame object to the public profile DTO.
create or replace view public.public_profile_stats as
select p.id,p.handle,p.display_name,p.avatar_url,p.bio,p.role,p.joined_on,
       coalesce(c.total,0)::integer as checkin_count,
       (5*coalesce(c.total,0)-greatest(0,(private.china_today()-p.joined_on)-coalesce(c.past,0)))::integer as score,
       c.last_checkin_date,
       case when p.role in ('admin','owner') then 'purple'
            when (5*coalesce(c.total,0)-greatest(0,(private.china_today()-p.joined_on)-coalesce(c.past,0)))<0 then 'gray'
            when (5*coalesce(c.total,0)-greatest(0,(private.china_today()-p.joined_on)-coalesce(c.past,0)))<5 then 'blue'
            when (5*coalesce(c.total,0)-greatest(0,(private.china_today()-p.joined_on)-coalesce(c.past,0)))<10 then 'green'
            when (5*coalesce(c.total,0)-greatest(0,(private.china_today()-p.joined_on)-coalesce(c.past,0)))<30 then 'orange' else 'red' end as name_color,
       coalesce(f.followers,0)::integer as follower_count,coalesce(g.following,0)::integer as following_count,
       case when fd.code is null then null else jsonb_build_object('code',fd.code,'name',fd.name,'rarity',fd.rarity,'style_class',fd.style_class) end as avatar_frame
from public.profiles p
left join lateral(select count(*) total,count(*) filter(where d.checkin_date<private.china_today()) past,max(d.checkin_date) last_checkin_date from public.daily_checkins d where d.user_id=p.id)c on true
left join lateral(select count(*) followers from public.user_follows u where u.following_id=p.id)f on true
left join lateral(select count(*) following from public.user_follows u where u.follower_id=p.id)g on true
left join public.avatar_frame_definitions fd on fd.code=p.equipped_avatar_frame
where p.banned_at is null;

comment on table public.avatar_frame_definitions is 'Server-owned allowlist of achievement avatar frames; style_class is safe for public DTOs.';
comment on column public.profiles.equipped_avatar_frame is 'Currently equipped frame; entitlement is enforced by equip_avatar_frame().';

drop function if exists public.get_luck_leaderboard(text);
create function public.get_luck_leaderboard(period_name text default 'week')
returns table(user_id uuid,handle text,display_name text,avatar_url text,role text,name_color text,number integer,rarity text,rarity_label text,achieved_at timestamptz,rarity_rank integer,avatar_frame jsonb)
language plpgsql stable security definer set search_path=public,private,pg_catalog
as $$
begin
  return query with ranked as (
    select d.*,case d.rarity when 'chromatic' then 6 when 'legendary' then 5 when 'epic' then 4 when 'rare' then 3 when 'uncommon' then 2 else 1 end rr,
      row_number() over(partition by d.user_id order by case d.rarity when 'chromatic' then 6 when 'legendary' then 5 when 'epic' then 4 when 'rare' then 3 when 'uncommon' then 2 else 1 end desc,d.created_at asc) own_rank
    from public.daily_checkins d where period_name='history' or d.checkin_date>=private.china_today()-(extract(isodow from private.china_today())::integer-1)
  )
  select s.id,s.handle,s.display_name,s.avatar_url,s.role,s.name_color,r.number,r.rarity,r.rarity_label,r.created_at,r.rr,s.avatar_frame
  from ranked r join public.public_profile_stats s on s.id=r.user_id where r.own_rank=1
  order by r.rr desc,r.created_at asc limit 100;
end $$;
grant execute on function public.get_luck_leaderboard(text) to anon,authenticated;

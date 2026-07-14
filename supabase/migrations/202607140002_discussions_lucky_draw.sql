-- Leather discussions, mention notifications, blog autosave and transparent lucky draw.

alter table public.profiles
  add column if not exists blog_autosave_minutes integer not null default 10;
alter table public.profiles drop constraint if exists profiles_blog_autosave_minutes_check;
alter table public.profiles
  add constraint profiles_blog_autosave_minutes_check check (blog_autosave_minutes in (5,10,30));

alter table public.daily_checkins
  add column if not exists draw_count smallint not null default 1;
alter table public.daily_checkins drop constraint if exists daily_checkins_draw_count_check;
alter table public.daily_checkins
  add constraint daily_checkins_draw_count_check check (draw_count between 1 and 3);

alter table public.station_comments drop constraint if exists station_comments_kind_check;
alter table public.station_comments alter column kind drop default;
update public.station_comments
set kind = case kind when 'bug' then 'site' when 'suggestion' then 'site' else 'water' end
where kind not in ('water','academic','site');
alter table public.station_comments alter column kind set default 'water';
alter table public.station_comments
  add constraint station_comments_kind_check check (kind in ('water','academic','site'));
alter table public.station_comments
  add column if not exists reply_to uuid references public.station_comments(id) on delete set null;
create index if not exists station_comments_kind_created_idx on public.station_comments(kind, created_at desc);
create index if not exists station_comments_reply_idx on public.station_comments(reply_to) where reply_to is not null;

create or replace function private.normalize_discussion_kind()
returns trigger language plpgsql set search_path = pg_catalog
as $$
begin
  new.kind := case new.kind when 'bug' then 'site' when 'suggestion' then 'site' when 'other' then 'water' else new.kind end;
  return new;
end $$;
drop trigger if exists b_normalize_discussion_kind on public.station_comments;
create trigger b_normalize_discussion_kind before insert or update of kind on public.station_comments
for each row execute function private.normalize_discussion_kind();

create table if not exists public.mention_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid not null references public.profiles(id) on delete cascade,
  discussion_id uuid not null references public.station_comments(id) on delete cascade,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique(recipient_id, discussion_id)
);
create index if not exists mention_notifications_recipient_idx
  on public.mention_notifications(recipient_id, created_at desc);
create index if not exists mention_notifications_unread_idx
  on public.mention_notifications(recipient_id, created_at desc) where read_at is null;

create or replace function private.sync_discussion_mentions()
returns trigger language plpgsql security definer set search_path = public, private, pg_catalog
as $$
declare v_recipient uuid;
begin
  delete from public.mention_notifications where discussion_id = new.id;
  for v_recipient in
    select distinct target_id from (
      select p.id as target_id
      from regexp_matches(lower(coalesce(new.content,'')), '(?:^|[^a-z0-9_-])@([a-z0-9][a-z0-9_-]{2,29})', 'g') as hit
      join public.profiles p on lower(p.handle) = hit[1]
      union
      select parent.user_id
      from public.station_comments parent
      where parent.id = new.reply_to
    ) targets
    where target_id <> new.user_id
  loop
    insert into public.mention_notifications(recipient_id, actor_id, discussion_id)
    values(v_recipient, new.user_id, new.id)
    on conflict(recipient_id, discussion_id) do nothing;
  end loop;
  return new;
end $$;

drop trigger if exists a_sync_discussion_mentions on public.station_comments;
create trigger a_sync_discussion_mentions
after insert or update of content, reply_to on public.station_comments
for each row execute function private.sync_discussion_mentions();

create or replace function public.get_mention_notifications(limit_count integer default 30)
returns table(
  id uuid, discussion_id uuid, actor_id uuid, actor_handle text, actor_name text,
  actor_avatar text, discussion_kind text, discussion_content text,
  created_at timestamptz, is_read boolean
)
language plpgsql stable security definer set search_path = public, private, pg_catalog
as $$
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  return query
  select n.id, n.discussion_id, n.actor_id, p.handle, p.display_name, p.avatar_url,
         d.kind, d.content, n.created_at, n.read_at is not null
  from public.mention_notifications n
  join public.profiles p on p.id = n.actor_id
  join public.station_comments d on d.id = n.discussion_id
  where n.recipient_id = auth.uid()
  order by n.created_at desc
  limit least(greatest(coalesce(limit_count,30),1),100);
end $$;

create or replace function public.mark_mention_notifications_read()
returns integer language plpgsql security definer set search_path = public, pg_catalog
as $$
declare v_count integer;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  update public.mention_notifications set read_at = coalesce(read_at, now())
  where recipient_id = auth.uid() and read_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create or replace function public.get_blog_autosave_minutes()
returns integer language sql stable security definer set search_path = public, pg_catalog
as $$ select coalesce((select blog_autosave_minutes from public.profiles where id = auth.uid()),10) $$;

create or replace function public.set_blog_autosave_minutes(p_minutes integer)
returns void language plpgsql security definer set search_path = public, private, pg_catalog
as $$
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if private.is_banned(auth.uid()) then raise exception 'account banned'; end if;
  if p_minutes not in (5,10,30) then raise exception 'invalid autosave interval'; end if;
  update public.profiles set blog_autosave_minutes = p_minutes, updated_at = now()
  where id = auth.uid();
end $$;

create or replace function private.rate_checkin(number_value integer)
returns table(rarity text, label text) language plpgsql immutable set search_path = pg_catalog
as $$
declare s text := lpad(number_value::text, 6, '0');
begin
  if s ~ '^([0-9])\1{5}$' or s in ('012345','123456','234567','345678','456789','987654','876543','765432','654321','543210') then return query select 'legendary','传说';
  elsif s = reverse(s) or substring(s,1,3) = substring(s,4,3) or s ~ '^([0-9])\1{3,}' then return query select 'epic','史诗';
  elsif s ~ '([0-9])\1{2}' or s ~ '^([0-9])\1([0-9])\2([0-9])\3$' then return query select 'rare','稀有';
  elsif s ~ '([0-9])\1' or s ~ '(012|123|234|345|456|567|678|789|987|876|765|654|543|432|321|210)' then return query select 'uncommon','少见';
  else return query select 'common','普通'; end if;
end $$;

create or replace function private.random_six_digit()
returns integer language plpgsql volatile security definer set search_path = extensions, pg_catalog
as $$
declare v_bytes bytea; v_raw bigint;
begin
  loop
    v_bytes := extensions.gen_random_bytes(4);
    v_raw := get_byte(v_bytes,0)::bigint * 16777216 + get_byte(v_bytes,1)::bigint * 65536 + get_byte(v_bytes,2)::bigint * 256 + get_byte(v_bytes,3)::bigint;
    exit when v_raw < 4294000000;
  end loop;
  return (v_raw % 1000000)::integer;
end $$;

create or replace function public.daily_checkin()
returns public.daily_checkins language plpgsql security definer set search_path = public, private, pg_catalog
as $$
declare
  v_user uuid := auth.uid(); v_day date := private.china_today();
  v_candidate integer; v_candidate_rarity text; v_candidate_label text; v_candidate_rank integer;
  v_best_number integer := 0; v_best_rarity text := 'common'; v_best_label text := '普通'; v_best_rank integer := -1;
  v_row public.daily_checkins; i integer;
begin
  if v_user is null then raise exception 'authentication required'; end if;
  if private.is_banned(v_user) then raise exception 'account banned'; end if;
  perform pg_advisory_xact_lock(hashtext(v_user::text || ':' || v_day::text));
  select * into v_row from public.daily_checkins where user_id = v_user and checkin_date = v_day;
  if found then return v_row; end if;
  for i in 1..3 loop
    v_candidate := private.random_six_digit();
    select rarity, label into v_candidate_rarity, v_candidate_label from private.rate_checkin(v_candidate);
    v_candidate_rank := case v_candidate_rarity when 'legendary' then 5 when 'epic' then 4 when 'rare' then 3 when 'uncommon' then 2 else 1 end;
    if v_candidate_rank > v_best_rank then
      v_best_number := v_candidate; v_best_rarity := v_candidate_rarity;
      v_best_label := v_candidate_label; v_best_rank := v_candidate_rank;
    end if;
  end loop;
  insert into public.daily_checkins(user_id, checkin_date, number, rarity, rarity_label, draw_count)
  values(v_user, v_day, v_best_number, v_best_rarity, v_best_label, 3)
  returning * into v_row;
  return v_row;
end $$;

insert into private.sensitive_terms(category, term)
select category, term from (
  values
  ('abuse', array[
    '废物','蠢货','蠢猪','弱智','智障','白痴','低能儿','脑瘫','脑子有病','有病吧','神经病','狗东西','狗杂种','狗娘养的','杂种','畜生','禽兽','人渣','败类','贱人','贱货','婊子','臭婊子','母狗','骚货','死全家','全家死光','户口本死光','不得好死','去你妈的','滚你妈的','你妈死了','你爹死了','操你全家','草你全家','干你妈','日你全家','我操你妈','卧槽尼玛','曹尼玛','草泥马','操尼玛','cnm','nmsl','nmgb','mmp','sb东西','傻叉','傻x','沙雕','死妈','司马','4000妈','孤儿东西','祝你暴毙','赶紧去死','怎么不去死','弄死你','杀了你','砍死你','打死你','弄残你','找人打你','开盒你','人肉你','曝光隐私','网络暴力','恶意辱骂','种族歧视','地域黑','支那人','黑鬼','尼哥','猴子国','小日本鬼子','棒子国','死基佬','娘炮去死','荡妇羞辱','肥猪','丑八怪'
  ]::text[]),
  ('adult', array[
    '成人视频网','成人网站','成人直播','色情直播','色情网站','情色网站','色情网','黄色网站','黄色视频','黄色小说','黄色图片','激情视频','激情电影','激情聊天','激情裸聊','裸照交易','私密照','私房照交易','成人视频下载','看片网站','看片资源','在线看片','福利姬','福利资源','福利视频','萝莉资源','幼女资源','未成年色情','儿童色情','恋童癖','炼铜','迷奸','迷药强奸','强暴','性侵','性骚扰','性交易','性服务','特殊服务','上门服务','包夜服务','一夜情','找炮友','炮友群','同城约炮','线下约炮','卖春','买春','招嫖','外围女','会所嫩模','楼凤','小姐上门','桑拿全套','大保健','援助交际','包养学生妹','包养大学生','包养少妇','裸贷','肉偿','卖身','成人视频会员','成人视频群','看片群','色情群','裸聊群','成人视频链接','色情链接','强奸视频','乱伦视频','兽交','人兽','群交','换妻','性虐待','调教奴隶','口交视频','肛交视频','自慰视频','偷拍裙底','偷拍视频','厕所偷拍','更衣室偷拍','迷奸偷拍视频','春药','催情药','迷情药','苍蝇水','听话水','成人视频资源'
  ]::text[]),
  ('illegal', array[
    '赌场代理','赌博平台','赌博网站','博彩平台','博彩网站','棋牌赌博','真人赌博','线上赌场','地下赌场','百家乐','北京赛车','重庆时时彩','时时彩','快三投注平台','彩票内幕','彩票代投','赌球平台','足球下注','电竞下注','跑分平台','跑分兼职','洗黑钱','地下钱庄','换汇洗钱','代收黑钱','银行卡四件套','银行卡出租','银行卡出售','收银行卡','收手机卡','电话卡出售','实名认证代办','非法套现','信用卡套现','花呗套现','白条套现','黑户贷款','高利贷','校园贷','套路贷','裸条贷款','暴力催收','出售毒品','购买毒品','毒品交易','大麻交易','可卡因','芬太尼','氯胺酮','k粉','麻古','致幻剂','笑气配送','上头电子烟','依托咪酯','制毒教程','种植大麻','枪械交易','枪支交易','手枪出售','步枪出售','气枪改装','仿真枪出售','子弹出售','弹药出售','军火交易','黑市军火','管制刀具出售','弩出售','电击枪出售','开锁工具出售','万能钥匙出售','撬锁教程','盗窃教程','入室盗窃','抢劫教程','绑架勒索','雇凶杀人','买凶杀人','职业杀手','人体器官交易','卖肾','买肾','代考','替考','考试作弊','作弊设备','无线耳机作弊','考题答案出售','论文代写','毕业证代办','学历证代办','驾驶证代办','身份证代办','假币出售','假钞出售','伪造公章','刻章办证','偷渡服务','非法移民中介','护照造假','签证造假','黑客接单','攻击网站','ddos服务','盗号服务','撞库数据','社工库查询','开盒服务','个人信息出售','身份证信息出售','手机定位服务','监听软件','木马免杀','勒索病毒','钓鱼网站搭建','恶意软件出售'
  ]::text[]),
  ('fraud', array[
    '刷单兼职','刷单赚钱','刷信誉','刷销量','刷好评','点赞返现','关注返现','垫付返利','充值返利','投资返利','高额返利','稳赚不赔','保本高收益','内幕消息','内部渠道赚钱','快速翻倍','日赚过万','月入十万','躺着赚钱','零风险投资','带你赚钱','老师带单','导师带单','投资导师','股票群老师','荐股群','杀猪盘','虚拟币带单','合约带单','外汇带单','黄金带单','期货带单','彩票导师','博彩导师','资金盘','拆分盘','互助盘','传销项目','拉人头赚钱','发展下线','静态收益','动态收益','空气币','山寨币','虚拟币私募','币圈内幕','代币预售','稳赚项目','养老项目投资','民族资产解冻','扶贫款发放','国家项目分钱','冒充客服','冒充公检法','安全账户转账','退款理赔诈骗','快递丢失赔偿','航班取消退款','医保卡异常','社保卡异常','征信修复','征信洗白','消除逾期','网贷注销','学生账号注销','中奖领奖','免费领取手机','免费领取红包','扫码领红包','砍价助力返现','游戏充值折扣','低价充值','代充退款','账号解封收费','代办退款','平台漏洞套利','薅羊毛项目','套取补贴','发票代开','虚开发票','收购发票','出售发票','兼职打字员','手工活外发','小说录入兼职'
  ]::text[]),
  ('spam', array[
    '加我微信','私加微信','微信联系','联系微信','微信咨询','微信详聊','薇信联系','威信联系','微亻言','v信联系','vx联系','加我vx','加v详聊','加我qq','qq联系','扣扣联系','企鹅联系','加群领取','进群领取','扫码进群','扫码添加','私聊拿资源','私信拿资源','私聊发链接','评论区留联系方式','留下手机号','拨打电话咨询','电话联系购买','电报联系','telegram联系','飞机群','纸飞机群','tg群','频道订阅','推广引流','网站推广','灰产引流','色流引流','菠菜引流','兼职代理','招募代理','诚招代理','代理加盟','招商加盟','日结兼职','在家兼职','手机兼职','学生兼职赚钱','免费送','限时领取','内部名额','最后名额','点击链接注册','复制链接打开','下载指定app','安装指定软件','验证码发我','短信验证码','共享屏幕操作','远程协助转账','群发广告','广告位招租','出售账号','批量注册账号','养号工作室','接码平台','验证码平台','短信轰炸','呼死你','轰炸机软件'
  ]::text[]),
  ('extremism', array[
    '恐怖组织招募','加入恐怖组织','圣战招募','极端组织宣传','恐怖袭击策划','实施恐怖袭击','自杀式袭击','人体炸弹','汽车炸弹制作','炸弹制作教程','爆炸物配方','简易爆炸装置','燃烧瓶制作','袭击政府机关','袭击公共场所','袭击学校','袭击地铁','劫持飞机','劫持人质','传播极端思想','种族灭绝','纳粹万岁','希特勒万岁','白人至上组织','新纳粹组织','分裂国家组织','暴力推翻政府','武装暴乱','煽动暴乱','招募暴徒','非法宗教募捐','邪教招募','邪教洗脑','法轮大法好','全能神教会','东突恐怖组织','伊斯兰国招募','isis招募','基地组织招募','塔利班招募'
  ]::text[]),
  ('violence', array[
    '自杀教程','自杀方法','无痛自杀','如何自杀','相约自杀','一起自杀','直播自杀','割腕教程','跳楼地点推荐','服药自杀','烧炭自杀','上吊教程','杀人教程','分尸教程','抛尸教程','毁尸灭迹','制作毒药杀人','下毒方法','校园袭击计划','随机杀人','报复社会计划','虐杀动物视频','虐猫视频','虐狗视频','血腥虐杀视频','肢解视频','斩首视频','枪击视频资源','儿童虐待视频','家暴教学','殴打老人','霸凌同学','校园霸凌组织'
  ]::text[]),
  ('variant', array[
    'cao你妈','cao尼玛','caonima','caonmb','nima死了','nimabi','wocnima','fuckyou','fucku','fuckyourmother','motherfucker','sonofabitch','bitch','shithead','dumbass','retard','idiot去死','pornhub','xvideos','xnxx','javbus','missav','麻豆传媒','国产自拍','国产自拍资源','国产自拍网站','91pron','91porn','pronhub','se情','瑟情','黄网资源','huang片','luo聊','yue炮','yuan交','du博','bo彩','六he彩','bing毒','hai洛因','摇tou丸','mai枪','shua单','xi钱','jia微信','wei信号','加v心','加微x','weixin联系','wechat联系','telegram群','t.me链接','bit.ly推广','tinyurl推广','高收yi','赚kuai钱','free money','easy money','double your money','guaranteed profit','crypto giveaway','airdrop scam','代充zhi','办jia证','假zheng','枪zhi弹药','恐bu主义','制造zha弹','fa轮功','台du','港du','纳cui','开he服务','社gong库','ddos attack','botnet rental','ransomware service','malware for sale','stolen accounts','carding service','credit card dump','cvv出售','色情zhibo','luoli资源','迷jian药','春yao出售','裸liao群','援jiao','嫖chang','卖yin'
  ]::text[])
) as groups(category, terms)
cross join lateral unnest(groups.terms) as term
on conflict(term) do nothing;

create or replace function private.normalize_text(input_text text)
returns text language plpgsql immutable set search_path = pg_catalog
as $$
declare v text := lower(coalesce(input_text, ''));
begin
  v := translate(v, '０１２３４５６７８９ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ', '0123456789abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz');
  v := replace(v, '0', 'o'); v := replace(v, '1', 'i'); v := replace(v, '3', 'e');
  v := replace(v, '4', 'a'); v := replace(v, '5', 's'); v := replace(v, '7', 't');
  v := replace(v, '8', 'b'); v := replace(v, '@', 'a'); v := replace(v, '$', 's');
  v := replace(v, 'а', 'a'); v := replace(v, 'е', 'e'); v := replace(v, 'і', 'i');
  v := replace(v, 'о', 'o'); v := replace(v, 'с', 'c'); v := replace(v, 'х', 'x');
  return regexp_replace(v, '[^[:alnum:]一-龥]', '', 'g');
end $$;

create or replace function private.content_violation(input_text text)
returns text language plpgsql stable security definer set search_path = private, pg_catalog
as $$
declare v_normal text := private.normalize_text(input_text); v_term record; v_links integer;
begin
  for v_term in select category, term from private.sensitive_terms loop
    if position(private.normalize_text(v_term.term) in v_normal) > 0 then return '敏感内容/' || v_term.category; end if;
  end loop;
  if lower(coalesce(input_text,'')) ~ '(<\s*script|javascript\s*:|vbscript\s*:|on(error|load|click|focus|mouseover)\s*=|data\s*:\s*text/html|document\s*\.\s*cookie|window\s*\.\s*location|<\s*iframe|<\s*object)' then return '疑似脚本注入'; end if;
  if coalesce(input_text,'') ~ '(.)\1{39,}' then return '重复字符资源滥用'; end if;
  if coalesce(input_text,'') ~ '(1[3-9][0-9][ -]?[0-9]{4}[ -]?[0-9]{4})' then return '疑似公开手机号导流'; end if;
  if lower(coalesce(input_text,'')) ~ '((微信|微.?信|v.?x|w.?e.?c.?h.?a.?t|q.?q|扣.?扣|telegram|t\.me|纸飞机).{0,12}(号|群|联系|添加|咨询|详聊|私聊))' then return '疑似站外导流'; end if;
  select count(*) into v_links from regexp_matches(coalesce(input_text,''), 'https?://', 'gi');
  if v_links > 3 then return '垃圾链接资源滥用'; end if;
  return null;
end $$;

alter table public.mention_notifications enable row level security;
drop policy if exists mention_notifications_read on public.mention_notifications;
create policy mention_notifications_read on public.mention_notifications for select to authenticated
using(recipient_id = auth.uid());

revoke all on public.mention_notifications from public, anon, authenticated;
grant execute on function public.get_mention_notifications(integer), public.mark_mention_notifications_read(),
  public.get_blog_autosave_minutes(), public.set_blog_autosave_minutes(integer) to authenticated;
revoke execute on function public.get_mention_notifications(integer), public.mark_mention_notifications_read(),
  public.get_blog_autosave_minutes(), public.set_blog_autosave_minutes(integer) from public, anon;

revoke execute on function private.sync_discussion_mentions(), private.normalize_discussion_kind(), private.random_six_digit() from public, anon, authenticated;

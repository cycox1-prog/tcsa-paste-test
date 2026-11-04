-- =====================================================================
-- Participation race: monthly points per business, calculated live.
-- =====================================================================

insert into private.settings(key, value) values ('season_goal', '150')
on conflict (key) do nothing;

-- p_offset: 0 = this month, -1 = last month. Months run on Florida (Eastern) time.
create or replace function public.leaderboard(p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  tz constant text := 'America/New_York';
  m timestamp; s timestamptz; e timestamptz; goal int; out jsonb;
begin
  if not public.is_member() then raise exception 'Members only'; end if;
  m := date_trunc('month', now() at time zone tz) + make_interval(months => p_offset);
  s := m at time zone tz;
  e := (m + interval '1 month') at time zone tz;
  select coalesce(nullif(value, '')::int, 150) into goal from private.settings where key = 'season_goal';

  with logs as (           -- 10 pts: one scoring referral per post per person, never for your own business
    select distinct on (lower(r.post_url), r.created_by) r.id, r.created_by, r.referrer_business_id
    from referrals r
    where r.created_at >= s and r.created_at < e
      and r.referred_business_id <> r.referrer_business_id
    order by lower(r.post_url), r.created_by, r.created_at
  ),
  backs as (               -- 3 pts, +2 within 15 minutes; not your own referral, not your own business
    select b.user_id, b.business_id, (b.done_at - r.created_at) <= interval '15 minutes' as fast
    from backups b join referrals r on r.id = b.referral_id
    where b.done_at >= s and b.done_at < e
      and b.user_id <> r.created_by
      and b.business_id <> r.referred_business_id
  ),
  biz as (
    select x.id, x.name, x.category, x.artwork_path,
      (select count(*) from logs l where l.referrer_business_id = x.id) as logged,
      (select count(*) from backs k where k.business_id = x.id) as backed,
      (select count(*) from backs k where k.business_id = x.id and k.fast) as fast
    from businesses x where x.active
  ),
  scored as (
    select *, logged * 10 + backed * 3 + fast * 2 as points from biz
  ),
  ranked as (
    select *, rank() over (order by points desc) as place from scored
  ),
  people as (
    select p.id, p.full_name, p.business_id,
      (select count(*) from logs l where l.created_by = p.id) * 10
      + (select count(*) from backs k where k.user_id = p.id) * 3
      + (select count(*) from backs k where k.user_id = p.id and k.fast) * 2 as points
    from profiles p where p.active
  )
  select jsonb_build_object(
    'season_start', s, 'season_end', e,
    'label', to_char(m, 'FMMonth YYYY'),
    'goal', goal,
    'total_referrals', (select count(*) from logs),
    'businesses', coalesce((select jsonb_agg(to_jsonb(r) order by r.points desc, r.logged desc, r.name) from ranked r), '[]'::jsonb),
    'mvp', (select jsonb_build_object('name', full_name, 'business_id', business_id, 'points', points)
            from people where points > 0 order by points desc, full_name limit 1)
  ) into out;
  return out;
end $$;

revoke all on function public.leaderboard(int) from public, anon;
grant execute on function public.leaderboard(int) to authenticated;

-- Admins can set the group goal.
create or replace function public.get_settings() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return jsonb_build_object(
    'join_code',   (select value from private.settings where key = 'join_code'),
    'app_url',     (select value from private.settings where key = 'app_url'),
    'season_goal', (select value from private.settings where key = 'season_goal'),
    'slack_set',   coalesce((select value from private.settings where key = 'slack_webhook_url'), '') <> ''
  );
end $$;

create or replace function public.set_setting(p_key text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if p_key not in ('join_code', 'app_url', 'slack_webhook_url', 'season_goal') then
    raise exception 'Unknown setting %', p_key;
  end if;
  if p_key = 'slack_webhook_url' and coalesce(p_value, '') <> ''
     and p_value not like 'https://hooks.slack.com/%' then
    raise exception 'A Slack webhook URL starts with https://hooks.slack.com/';
  end if;
  if p_key = 'season_goal' and (p_value !~ '^\d+$' or p_value::int < 1) then
    raise exception 'The group goal must be a whole number above zero';
  end if;
  update private.settings set value = btrim(coalesce(p_value, '')) where key = p_key;
end $$;

-- Live updates for the race board.
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'referrals') then
    alter publication supabase_realtime add table public.referrals;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'backups') then
    alter publication supabase_realtime add table public.backups;
  end if;
end $$;

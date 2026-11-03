\set ON_ERROR_STOP 1
-- Supabase grants table privileges to these roles by default; mirror that.
grant usage on schema public to anon, authenticated;
grant all on all tables in schema public to authenticated;

insert into auth.users values
 ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-00000000000b'),
 ('00000000-0000-0000-0000-00000000000c');
insert into businesses(id, name, category) values
 ('10000000-0000-0000-0000-000000000001', 'Shark Pressure Washing', 'Pressure washing'),
 ('10000000-0000-0000-0000-000000000002', 'Gulf Coast Plumbing', 'Plumbing');
insert into blurbs(business_id, body) values
 ('10000000-0000-0000-0000-000000000001', 'Shark blurb 1'),
 ('10000000-0000-0000-0000-000000000001', 'Shark blurb 2'),
 ('10000000-0000-0000-0000-000000000002', 'Plumbing blurb 1');
update private.settings set value = 'TEST1' where key = 'join_code';

set role authenticated;

-- A: joins first -> admin
set test.uid = '00000000-0000-0000-0000-00000000000a';
select join_group('test1', 'Cy', '10000000-0000-0000-0000-000000000001');
select 'A is admin: ' || is_admin();

-- B: wrong code fails, right code works, not admin
set test.uid = '00000000-0000-0000-0000-00000000000b';
do $$ begin perform join_group('nope', 'Pat', '10000000-0000-0000-0000-000000000002');
  raise exception 'wrong code accepted'; exception when others then
  if sqlerrm like 'wrong code%' then raise; end if; raise notice 'wrong code rejected: %', sqlerrm; end $$;
select count(*) as blurbs_before_join from blurbs;
select join_group('TEST1', 'Pat', '10000000-0000-0000-0000-000000000002');
select 'B is admin: ' || is_admin();
select count(*) as blurbs_after_join from blurbs;

-- B logs a referral for Shark, trying to spoof the creator
insert into referrals(referred_business_id, post_url, created_by, referrer_business_id)
values ('10000000-0000-0000-0000-000000000001', ' https://facebook.com/groups/x/posts/1 ',
        '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001');
select (created_by = '00000000-0000-0000-0000-00000000000b') as creator_stamped,
       (referrer_business_id = '10000000-0000-0000-0000-000000000002') as business_stamped,
       post_url from referrals;
select count(*) as auto_backups from backups;

-- duplicate post for the same business is rejected
do $$ begin
  insert into referrals(referred_business_id, post_url)
  values ('10000000-0000-0000-0000-000000000001', 'HTTPS://facebook.com/groups/x/posts/1');
  raise exception 'duplicate accepted';
exception when unique_violation then raise notice 'duplicate rejected'; end $$;

-- B can't change settings or businesses
do $$ begin perform set_setting('join_code', 'X'); raise exception 'non-admin changed setting';
exception when others then if sqlerrm like 'non-admin%' then raise; end if; raise notice 'setting blocked: %', sqlerrm; end $$;
update businesses set name = 'hacked';
select count(*) filter (where name = 'hacked') as hacked_rows from businesses;

-- A backs up the referral
set test.uid = '00000000-0000-0000-0000-00000000000a';
insert into backups(referral_id, blurb_id) select id, null from referrals;
select count(*) as backups_now from backups;

-- Admin sets Slack, next referral sends one notice
select set_setting('slack_webhook_url', 'https://hooks.slack.com/services/T/B/x');
select set_setting('app_url', 'https://cycox1-prog.github.io/tcsa-paste-test/hub/');
select get_settings();
insert into referrals(referred_business_id, post_url)
values ('10000000-0000-0000-0000-000000000002', 'https://facebook.com/groups/x/posts/2');
reset role;
select url, body->>'text' as text from net.calls;

-- C: signed in but not joined sees nothing private
set role authenticated;
set test.uid = '00000000-0000-0000-0000-00000000000c';
select (select count(*) from businesses) as c_businesses, (select count(*) from referrals) as c_referrals,
       (select count(*) from blurbs) as c_blurbs, (select count(*) from profiles) as c_profiles;
-- C can't read private settings
do $$ begin perform * from private.settings; raise exception 'settings readable';
exception when insufficient_privilege then raise notice 'private settings blocked'; end $$;

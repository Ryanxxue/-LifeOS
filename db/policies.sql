-- 生活记录面板 · 行级安全（RLS）
-- 关键约定：策略只授予 authenticated。未登录请求（anon）必须被拒绝，
-- 否则任何拿到 publishableKey + 分享链接的人都能往你的库里写数据。
-- 线上实测：匿名 POST 返回 401 / DATABASE_42501；该断言由 tests/anon_probe.py 固化。

alter table public.habits       enable row level security;
alter table public.checkins     enable row level security;
alter table public.health_daily enable row level security;
alter table public.activities   enable row level security;
alter table public.books        enable row level security;
alter table public.notes        enable row level security;
alter table public.study_plans  enable row level security;
alter table public.study_logs   enable row level security;
alter table public.app_kv       enable row level security;

drop policy if exists habits_owner on public.habits;
create policy habits_owner on public.habits for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists checkins_owner on public.checkins;
create policy checkins_owner on public.checkins for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists health_daily_owner on public.health_daily;
create policy health_daily_owner on public.health_daily for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists activities_owner on public.activities;
create policy activities_owner on public.activities for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists books_owner on public.books;
create policy books_owner on public.books for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists notes_owner on public.notes;
create policy notes_owner on public.notes for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists study_plans_owner on public.study_plans;
create policy study_plans_owner on public.study_plans for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists study_logs_owner on public.study_logs;
create policy study_logs_owner on public.study_logs for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists app_kv_owner on public.app_kv;
create policy app_kv_owner on public.app_kv for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

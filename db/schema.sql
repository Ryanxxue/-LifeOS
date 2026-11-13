-- 生活记录面板 · 数据库结构（以线上实际结构为准，2026-11-13 校对）
-- 用途：换环境时可直接重建；schema 与代码的一致性由 tests/schema_check.py 校验。
-- 约定：
--   * 每张表都有 owner_id，默认 auth.uid()，RLS 一律按 owner_id 隔离；
--   * id 为 GENERATED ALWAYS AS IDENTITY，导入备份时不要带 id；
--   * 软删除（deleted_at / archived）保留历史，不物理删除。

create table if not exists public.habits (
  id            bigint generated always as identity primary key,
  owner_id      text        not null default auth.uid(),
  name          text        not null,
  icon          text        not null default 'circle',
  color         text        not null default '#0A84FF',
  target        text        not null default '每天',
  sort_order    integer     not null default 0,
  archived      boolean     not null default false,
  created_at    timestamptz not null default now(),
  archived_at   timestamptz
);

create table if not exists public.checkins (
  id            bigint generated always as identity primary key,
  owner_id      text        not null default auth.uid(),
  habit_id      bigint      not null references public.habits(id) on delete cascade,
  day           date        not null,
  note          text,
  created_at    timestamptz not null default now(),
  constraint checkins_owner_id_habit_id_day_key unique (owner_id, habit_id, day)
);

create table if not exists public.health_daily (
  id            bigint generated always as identity primary key,
  owner_id      text        not null default auth.uid(),
  day           date        not null,
  sleep_total   numeric,
  sleep_deep    numeric,
  sleep_rem     numeric,
  sleep_light   numeric,
  hrv           integer,
  resting_hr    integer,
  stress        integer,
  training_load integer,
  steps         integer,
  source        text        not null default 'coros',
  updated_at    timestamptz not null default now(),
  constraint health_daily_owner_id_day_key unique (owner_id, day)
);

create table if not exists public.activities (
  id            bigint generated always as identity primary key,
  owner_id      text        not null default auth.uid(),
  external_id   text        not null,
  day           date        not null,
  type          text,
  name          text,
  duration_sec  integer,
  distance_m    numeric,
  avg_hr        integer,
  calories      integer,
  created_at    timestamptz not null default now(),
  constraint activities_owner_id_external_id_key unique (owner_id, external_id)
);

create table if not exists public.books (
  id            bigint generated always as identity primary key,
  owner_id      text        not null default auth.uid(),
  title         text        not null,
  author        text,
  status        text        not null default 'reading',
  progress      integer     not null default 0,
  total_pages   integer,
  cover_a       text,
  cover_b       text,
  source        text        not null default 'manual',
  external_id   text,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create table if not exists public.notes (
  id            bigint generated always as identity primary key,
  owner_id      text        not null default auth.uid(),
  book_id       bigint      not null references public.books(id) on delete cascade,
  chapter       text,
  content       text        not null,
  page          integer,
  external_id   text,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index if not exists notes_book_idx on public.notes (book_id);
-- 同一本书内完全相同的划线只留一条（软删除的除外）
create unique index if not exists notes_dedupe_idx
  on public.notes (owner_id, book_id, md5(content)) where deleted_at is null;

create table if not exists public.study_plans (
  id              bigint generated always as identity primary key,
  owner_id        text        not null default auth.uid(),
  title           text        not null,
  target_per_week integer     not null default 3,
  total_weeks     integer,
  sort_order      integer     not null default 0,
  archived        boolean     not null default false,
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create table if not exists public.study_logs (
  id            bigint generated always as identity primary key,
  owner_id      text        not null default auth.uid(),
  plan_id       bigint      not null references public.study_plans(id) on delete cascade,
  day           date        not null,
  note          text,
  created_at    timestamptz not null default now()
);
create unique index if not exists study_logs_dedupe_idx on public.study_logs (owner_id, plan_id, day);
create index if not exists study_logs_plan_idx on public.study_logs (plan_id, day);

-- 键值表：微信读书 Key、COROS 令牌、上次同步诊断等
create table if not exists public.app_kv (
  id            bigint generated always as identity primary key,
  owner_id      text        not null default auth.uid(),
  k             text        not null,
  v             jsonb       not null default '{}'::jsonb,
  updated_at    timestamptz not null default now(),
  constraint app_kv_owner_id_k_key unique (owner_id, k)
);

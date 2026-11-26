-- Lift Together: database setup
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- It creates 4 tables and the security rules ("row level security"):
--   * anyone who is signed in can READ everything (so you can compare with your friend)
--   * you can only ADD / CHANGE / DELETE your own rows

-- 1) People ---------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users on delete cascade,
  display_name text not null,
  created_at   timestamptz not null default now()
);

-- 2) A workout = one person on one day -------------------------------------
create table if not exists public.workouts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  date       date not null default current_date,
  notes      text,
  created_at timestamptz not null default now()
);

-- 3) Every set you do (exercise, weight, reps) ----------------------------
create table if not exists public.sets (
  id         uuid primary key default gen_random_uuid(),
  workout_id uuid not null references public.workouts on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  exercise   text not null,
  reps       int  not null check (reps > 0),
  weight     numeric not null default 0 check (weight >= 0),
  position   int  not null default 0,
  created_at timestamptz not null default now()
);

-- 4) Body stats over time ---------------------------------------------------
create table if not exists public.body_stats (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  date       date not null default current_date,
  bodyweight numeric,
  waist      numeric,
  chest      numeric,
  arms       numeric,
  body_fat   numeric,
  created_at timestamptz not null default now()
);

create index if not exists workouts_user_date on public.workouts (user_id, date);
create index if not exists sets_workout on public.sets (workout_id);
create index if not exists body_user_date on public.body_stats (user_id, date);

-- Let signed-in users reach these tables through the API at all.
-- (The rules below then decide exactly which rows each person may touch.)
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.profiles, public.workouts, public.sets, public.body_stats to authenticated;

-- Security rules -------------------------------------------------------------
alter table public.profiles   enable row level security;
alter table public.workouts   enable row level security;
alter table public.sets       enable row level security;
alter table public.body_stats enable row level security;

create policy "read profiles"   on public.profiles   for select to authenticated using (true);
create policy "add my profile"  on public.profiles   for insert to authenticated with check (id = auth.uid());
create policy "edit my profile" on public.profiles   for update to authenticated using (id = auth.uid());

create policy "read workouts"   on public.workouts   for select to authenticated using (true);
create policy "add my workouts" on public.workouts   for insert to authenticated with check (user_id = auth.uid());
create policy "edit my workouts" on public.workouts  for update to authenticated using (user_id = auth.uid());
create policy "delete my workouts" on public.workouts for delete to authenticated using (user_id = auth.uid());

create policy "read sets"       on public.sets       for select to authenticated using (true);
create policy "add my sets"     on public.sets       for insert to authenticated with check (
  user_id = auth.uid()
  and exists (select 1 from public.workouts w where w.id = workout_id and w.user_id = auth.uid())
);
create policy "edit my sets"    on public.sets       for update to authenticated using (user_id = auth.uid());
create policy "delete my sets"  on public.sets       for delete to authenticated using (user_id = auth.uid());

create policy "read body"       on public.body_stats for select to authenticated using (true);
create policy "add my body"     on public.body_stats for insert to authenticated with check (user_id = auth.uid());
create policy "edit my body"    on public.body_stats for update to authenticated using (user_id = auth.uid());
create policy "delete my body"  on public.body_stats for delete to authenticated using (user_id = auth.uid());

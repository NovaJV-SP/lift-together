-- Lift Together, update 3: goals, manually-entered PRs, and saved workouts/exercises
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run more than once.
-- Same security idea as before: signed-in people can SEE everyone's rows (for competing),
-- but can only ADD / CHANGE / DELETE their own.

-- 🎯 Goals: "Bench 225 × 1" or "Reach 180 lb bodyweight"
create table if not exists public.goals (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users on delete cascade,
  kind          text not null check (kind in ('lift', 'bodyweight')),
  exercise      text,
  target_weight numeric not null check (target_weight > 0),
  target_reps   int not null default 1 check (target_reps > 0),
  start_value   numeric,          -- bodyweight when the goal was set
  deadline      date,
  created_at    timestamptz not null default now()
);

-- 🏆 PRs you enter by hand (e.g. lifts from before you used the app)
create table if not exists public.manual_prs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  exercise   text not null,
  weight     numeric not null check (weight >= 0),
  reps       int not null default 1 check (reps > 0),
  date       date not null default current_date,
  note       text,
  created_at timestamptz not null default now()
);

-- ⭐ Saved exercises / whole workouts, so you don't retype them
--   items = [{ "exercise": "Bench Press", "sets": [{ "weight": 135, "reps": 10 }, ...] }, ...]
create table if not exists public.templates (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  name       text not null,
  kind       text not null check (kind in ('exercise', 'workout')),
  items      jsonb not null,
  created_at timestamptz not null default now()
);

grant select, insert, update, delete on public.goals, public.manual_prs, public.templates to authenticated;

alter table public.goals      enable row level security;
alter table public.manual_prs enable row level security;
alter table public.templates  enable row level security;

drop policy if exists "read goals" on public.goals;
drop policy if exists "add my goals" on public.goals;
drop policy if exists "edit my goals" on public.goals;
drop policy if exists "delete my goals" on public.goals;
create policy "read goals"      on public.goals for select to authenticated using (true);
create policy "add my goals"    on public.goals for insert to authenticated with check (user_id = auth.uid());
create policy "edit my goals"   on public.goals for update to authenticated using (user_id = auth.uid());
create policy "delete my goals" on public.goals for delete to authenticated using (user_id = auth.uid());

drop policy if exists "read prs" on public.manual_prs;
drop policy if exists "add my prs" on public.manual_prs;
drop policy if exists "edit my prs" on public.manual_prs;
drop policy if exists "delete my prs" on public.manual_prs;
create policy "read prs"      on public.manual_prs for select to authenticated using (true);
create policy "add my prs"    on public.manual_prs for insert to authenticated with check (user_id = auth.uid());
create policy "edit my prs"   on public.manual_prs for update to authenticated using (user_id = auth.uid());
create policy "delete my prs" on public.manual_prs for delete to authenticated using (user_id = auth.uid());

drop policy if exists "read templates" on public.templates;
drop policy if exists "add my templates" on public.templates;
drop policy if exists "edit my templates" on public.templates;
drop policy if exists "delete my templates" on public.templates;
create policy "read templates"      on public.templates for select to authenticated using (true);
create policy "add my templates"    on public.templates for insert to authenticated with check (user_id = auth.uid());
create policy "edit my templates"   on public.templates for update to authenticated using (user_id = auth.uid());
create policy "delete my templates" on public.templates for delete to authenticated using (user_id = auth.uid());

-- in case update 2 wasn't run yet
alter table public.profiles add column if not exists schedule jsonb;

notify pgrst, 'reload schema';

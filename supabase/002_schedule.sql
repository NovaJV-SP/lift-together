-- Lift Together, update 2: workout schedules
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run more than once.
-- Adds a "schedule" column to each person's profile (which days are Push, Pull, Rest, etc.).
-- The existing security rules already let you edit only your own profile, and friends can read it.

alter table public.profiles add column if not exists schedule jsonb;

-- tell the API about the new column right away
notify pgrst, 'reload schema';

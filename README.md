# 💪 Lift Together

A shared workout tracker for you and your friends. You can:
- log your lifts set by set
- see each other's workouts
- chart your progress
- track bodyweight
- compete on a weekly scoreboard

## What's in here
| File | What it does |
|---|---|
| `index.html` | The page skeleton |
| `style.css` | How everything looks (built for phones first) |
| `app.js` | Everything the app does |
| `config.js` | Your database address and public key. While empty, the app runs in **demo mode** |
| `supabase/schema.sql` | Creates the database tables and security rules |

## How it works
- **Website files** are hosted for free on **GitHub Pages**.
- **Data** lives in **Supabase**, a free online database with built-in logins.
- **Security rules** in `schema.sql`: everyone who's signed in can *see* everyone's workouts, but each person can only *change* their own.

## Going live (one-time setup)

### 1. Supabase (the database)
1. Sign up at **supabase.com** and click **New project**. Pick any name and a strong database password, and choose the region closest to you.
2. Open **SQL Editor → New query**, paste in all of `supabase/schema.sql`, and click **Run**. (Run it only once. Running it a second time gives "already exists" errors.)
3. Go to **Authentication → Sign In / Providers → Email** and turn **off** "Confirm email". This keeps sign-up simple, and you'll close sign-ups in step 5.
4. Go to **Project Settings → API** and copy the **Project URL** and the **anon public** key into `config.js`. Never use the `service_role` key.

### 2. GitHub (code + hosting)
1. Create a repository on github.com. It must be **public** to use free GitHub Pages hosting.
2. Push this folder to it.
3. Go to the repository's **Settings → Pages**, set Source to **Deploy from a branch**, choose **main** and **/ (root)**, and save.
4. After about a minute, your app is live at `https://<your-username>.github.io/<repo-name>/`.

### 3. Supabase: allow your live address
**Authentication → URL Configuration**: set **Site URL** to your GitHub Pages address.

### 4. Sign up
You and your friend each open the link and click **Create account**. On a phone, use the browser's **Add to Home Screen** to get an app icon.

### 5. Lock it down
Once you've both signed up, go to **Authentication → Sign In / Providers** and turn **off** "Allow new users to sign up". Now nobody else can create an account.

## Database updates
New features sometimes need new tables or columns. Run each file once, in order, in **Supabase → SQL Editor**:
1. `supabase/schema.sql`: the starting tables
2. `supabase/002_schedule.sql`: workout schedules
3. `supabase/003_goals_prs_templates.sql`: goals, hand-entered PRs, saved workouts/exercises

Files 002 and 003 are safe to run again if you're not sure whether you already did.

## Demo mode
Add `?demo` to the address (e.g. `…/lift-together/?demo`) to try the app with sample data. Nothing is saved to the real database.

## Updating the app later
Change the files, commit, and push. GitHub Pages republishes automatically within about a minute.

'use strict';
/* =====================================================================
   Lift Together: a shared workout tracker for you and your friends.
   Data lives in Supabase (or in this browser while in demo mode).
   ===================================================================== */

const cfg = window.APP_CONFIG || {};
// Demo mode: no database configured, or "?demo" added to the address (handy for showing people the app)
const DEMO = new URLSearchParams(location.search).has('demo') || !(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
const UNIT = cfg.UNIT || 'lb';
const STREAK_MIN = 2; // workouts per week that keep a streak alive
const COLORS = ['var(--p0)', 'var(--p1)', 'var(--p2)'];
const HEX = ['#4f8cff', '#ff9f43', '#2ecc71'];
const COMMON_EXERCISES = ['Bench Press', 'Squat', 'Deadlift', 'Overhead Press', 'Barbell Row', 'Pull-up', 'Incline Dumbbell Press',
  'Romanian Deadlift', 'Leg Press', 'Lat Pulldown', 'Bicep Curl', 'Tricep Pushdown', 'Lateral Raise', 'Hip Thrust', 'Dip'];

/* ---------- small helpers ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
const z = n => String(n).padStart(2, '0');
const dstr = d => `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
const today = () => dstr(new Date());
const parseD = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtD = s => parseD(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const weekStart = s => { const d = parseD(s); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return dstr(d); };
const e1rm = (w, r) => r === 1 ? +w : +w * (1 + r / 30);   // Epley estimated one-rep max
const r1 = v => Math.round(v * 10) / 10;
const norm = s => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
const fmtNum = v => (v == null || v === '' || isNaN(v)) ? '–' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 });
function toast(msg, gold) {
  const t = $('#toast'); t.textContent = msg; t.classList.toggle('gold', !!gold); t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600);
}
async function safely(fn) { try { return await fn(); } catch (e) { console.error(e); toast('⚠ ' + (e.message || 'Something went wrong')); } }

/* =====================================================================
   DATA STORES: same interface for Supabase and demo mode
   ===================================================================== */
const TABLE_KEY = { profiles: 'profiles', workouts: 'workouts', sets: 'sets', body_stats: 'body' };

function supabaseStore() {
  // persistSession: stay signed in on this device until you press "Sign out"
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  sb.auth.onAuthStateChange(event => { // e.g. the session expired or was revoked elsewhere
    if (event === 'SIGNED_OUT' && data.me) { data.me = null; renderAuth('in', '<p class="muted">You were signed out. Sign in again below.</p>'); }
  });
  async function all(table) { // Supabase returns max 1000 rows per request, so page through
    let out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from(table).select('*').order('created_at').range(from, from + 999);
      if (error) throw error;
      out = out.concat(data);
      if (data.length < 1000) return out;
    }
  }
  return {
    sb,
    async session() { const { data } = await sb.auth.getSession(); return data.session ? data.session.user : null; },
    async signIn(email, password) { const { data, error } = await sb.auth.signInWithPassword({ email, password }); if (error) throw error; return data.user; },
    async signUp(email, password, name) {
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { display_name: name }, emailRedirectTo: location.href.split('#')[0] } });
      if (error) throw error;
      return data.session ? data.user : null; // null → they must confirm their email first
    },
    // scope 'local' = sign out on THIS device only (the default signed you out everywhere)
    async signOut() { await sb.auth.signOut({ scope: 'local' }); location.reload(); },
    async loadAll() {
      const [profiles, workouts, sets, body] = await Promise.all(['profiles', 'workouts', 'sets', 'body_stats'].map(all));
      return { profiles, workouts, sets, body };
    },
    async insert(t, row) { const { data, error } = await sb.from(t).insert(row).select().single(); if (error) throw error; return data; },
    async update(t, id, patch) { const { data, error } = await sb.from(t).update(patch).eq('id', id).select().single(); if (error) throw error; return data; },
    async remove(t, id) { const { error } = await sb.from(t).delete().eq('id', id); if (error) throw error; },
    async ensureProfile(user) {
      const { data, error } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
      if (error) throw error;
      if (data) return data;
      const name = (user.user_metadata && user.user_metadata.display_name) || user.email.split('@')[0];
      return this.insert('profiles', { id: user.id, display_name: name });
    },
  };
}

function demoStore() {
  const KEY = 'lift-together-demo-v1';
  let db = null;
  try { db = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
  if (!db || !db.profiles) db = seedDemo();
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} };
  persist();
  const copy = x => JSON.parse(JSON.stringify(x));
  return {
    async session() { return { id: 'demo-me', email: 'you@demo' }; },
    async signIn() {}, async signUp() {},
    async signOut() { if (confirm('Reset the demo data back to the samples?')) { try { localStorage.removeItem(KEY); } catch (e) {} location.reload(); } },
    async loadAll() { return copy({ profiles: db.profiles, workouts: db.workouts, sets: db.sets, body: db.body }); },
    async insert(t, row) { const r = { created_at: new Date().toISOString(), ...row }; db[TABLE_KEY[t]].push(r); persist(); return copy(r); },
    async update(t, id, patch) { const r = db[TABLE_KEY[t]].find(x => x.id === id); Object.assign(r, patch); persist(); return copy(r); },
    async remove(t, id) {
      db[TABLE_KEY[t]] = db[TABLE_KEY[t]].filter(x => x.id !== id);
      if (t === 'workouts') db.sets = db.sets.filter(s => s.workout_id !== id);
      persist();
    },
    async ensureProfile(u) { return copy(db.profiles.find(p => p.id === u.id)); },
  };
}
function seedDemo() {
  const profiles = [{ id: 'demo-me', display_name: 'You' }, { id: 'demo-friend', display_name: 'Your friend' }];
  const workouts = [], sets = [], body = [];
  let t = Date.now() - 1e9; const stamp = () => new Date(t += 1000).toISOString();
  const plan = [['Bench Press', 135, 8], ['Squat', 185, 6], ['Deadlift', 225, 5], ['Overhead Press', 85, 8], ['Barbell Row', 115, 10]];
  const dayOfWeek = (new Date().getDay() + 6) % 7;
  profiles.forEach((p, pi) => {
    for (let wk = 6; wk >= 0; wk--) {
      [0, 2, 4].forEach((off, di) => {
        if (wk === 0 && off > dayOfWeek) return;
        if ((wk + di + pi * 2) % 7 === 3) return; // the odd missed workout
        const d = new Date(); d.setDate(d.getDate() - dayOfWeek - wk * 7 + off);
        const w = { id: uuid(), user_id: p.id, date: dstr(d), notes: '', created_at: stamp() };
        workouts.push(w);
        [[0, 3], [1, 4], [2, 0]][di].forEach((ix, pos) => {
          const [ex, base, reps] = plan[ix];
          const wt = Math.round((base * (pi ? 1.1 : 1) + (6 - wk) * (ix === 2 ? 10 : 5) * (pi ? 0.8 : 1)) / 5) * 5;
          for (let k = 0; k < 3; k++) sets.push({ id: uuid(), workout_id: w.id, user_id: p.id, exercise: ex, reps: reps - (k === 2 ? 1 : 0), weight: wt, position: pos * 3 + k, created_at: stamp() });
        });
      });
    }
    for (let wk = 6; wk >= 0; wk--) {
      const d = new Date(); d.setDate(d.getDate() - wk * 7);
      body.push({ id: uuid(), user_id: p.id, date: dstr(d), bodyweight: r1(pi ? 168 + (6 - wk) * 0.7 : 186 - (6 - wk) * 0.9), waist: pi ? null : r1(36 - (6 - wk) * 0.15), chest: null, arms: null, body_fat: null, created_at: stamp() });
    }
  });
  return { profiles, workouts, sets, body };
}

const store = DEMO ? demoStore() : supabaseStore();

/* =====================================================================
   STATE
   ===================================================================== */
const data = { me: null, profiles: [], workouts: [], sets: [], body: [] };
const ui = { tab: 'log', logDate: today(), histWho: 'all', histLimit: 30, progEx: null, progMetric: 'e1rm', bodyMetric: 'bodyweight', openWorkout: null };
let D = {}; // derived data, rebuilt by derive()

function people() { // me first, then everyone else, each with a colour
  const others = data.profiles.filter(p => p.id !== data.me.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return [data.profiles.find(p => p.id === data.me.id) || data.me, ...others].map((p, i) => ({ ...p, color: COLORS[i % 3], hex: HEX[i % 3] }));
}
const person = id => people().find(p => p.id === id) || { display_name: '?', color: 'var(--muted)', hex: '#999' };

function derive() {
  const wById = new Map(data.workouts.map(w => [w.id, w]));
  const sets = data.sets.filter(s => wById.has(s.workout_id))
    .map(s => ({ ...s, weight: +s.weight, reps: +s.reps, date: wById.get(s.workout_id).date, e: e1rm(+s.weight, +s.reps) }))
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.created_at).localeCompare(String(b.created_at)));
  const best = {};
  for (const s of sets) {   // a PR = beating your previous best estimated 1RM for that exercise
    const k = s.user_id + '|' + norm(s.exercise);
    s.isPR = best[k] !== undefined && s.e > best[k] + 0.01;
    if (best[k] === undefined || s.e > best[k]) best[k] = s.e;
  }
  const names = new Map();
  sets.forEach(s => { if (!names.has(norm(s.exercise))) names.set(norm(s.exercise), s.exercise); });
  const setsByWorkout = new Map();
  sets.forEach(s => { if (!setsByWorkout.has(s.workout_id)) setsByWorkout.set(s.workout_id, []); setsByWorkout.get(s.workout_id).push(s); });
  D = { wById, sets, best, exercises: [...names.values()].sort((a, b) => a.localeCompare(b)), setsByWorkout };
}
function canonicalExercise(name) { // reuse an existing spelling so "bench press" and "Bench Press" are the same
  const n = norm(name);
  return D.exercises.find(e => norm(e) === n) || COMMON_EXERCISES.find(e => norm(e) === n) || name.trim().replace(/\s+/g, ' ');
}

async function reload() {
  const all = await store.loadAll();
  Object.assign(data, all);
  if (!data.profiles.find(p => p.id === data.me.id)) data.profiles.push(data.me);
  derive();
}

/* =====================================================================
   RENDER: shell
   ===================================================================== */
let chart = null;
function render() {
  if (!data.me) return renderAuth(); // never show app pages to someone who isn't signed in
  if (chart) { chart.destroy(); chart = null; }
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === ui.tab));
  const v = $('#view');
  try {
    ({ log: renderLog, history: renderHistory, progress: renderProgress, body: renderBody, compete: renderCompete })[ui.tab](v);
  } catch (e) { // show the problem instead of silently leaving the old page up
    console.error(e);
    v.innerHTML = `<div class="card"><b>⚠ This page hit a problem.</b><p class="muted">${esc(e.message || e)}</p><button id="retry">Try again</button></div>`;
    $('#retry').onclick = () => safely(async () => { await reload(); render(); });
  }
}
function renderHeader() {
  const me = people()[0];
  $('#who').innerHTML = `
    <button class="small" id="refreshBtn" title="Get the latest from your friends">⟳</button>
    <button class="small acct" id="acctBtn" aria-haspopup="true"><span class="dot" style="background:${me.color}"></span><span class="acct-name">${esc(me.display_name)}</span> ▾</button>
    <div class="menu" id="acctMenu" hidden>
      <div class="menu-head"><b>${esc(me.display_name)}</b><span class="muted small">${esc(data.email || '')}</span></div>
      <button data-act="name">✏️ Change my name</button>
      <button data-act="schedule">📅 My workout schedule</button>
      <button data-act="out" class="danger">${DEMO ? '↺ Reset demo data' : '🚪 Sign out'}</button>
      ${DEMO ? '' : '<p class="muted small" style="margin:6px 10px 2px">To use a different account, sign out, then sign in with the other one.</p>'}
    </div>`;
  const menu = $('#acctMenu');
  $('#refreshBtn').onclick = () => safely(async () => { await reload(); renderHeader(); render(); toast('Up to date.'); });
  $('#acctBtn').onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  menu.onclick = e => e.stopPropagation();
  $$('#acctMenu [data-act]').forEach(b => b.onclick = () => {
    menu.hidden = true;
    if (b.dataset.act === 'out') return store.signOut();
    if (b.dataset.act === 'schedule') return openSchedule(data.me.schedule ? 'week' : 'plan');
    if (b.dataset.act === 'name') return safely(async () => {
      const name = (prompt('What name should your friends see?', data.me.display_name) || '').trim();
      if (!name || name === data.me.display_name) return;
      const r = await store.update('profiles', data.me.id, { display_name: name.slice(0, 40) });
      Object.assign(data.me, r); Object.assign(data.profiles.find(p => p.id === data.me.id) || {}, r);
      renderHeader(); render(); toast('Name updated.');
    });
  });
}
document.addEventListener('click', () => { const m = $('#acctMenu'); if (m) m.hidden = true; });
$$('#nav button').forEach(b => b.onclick = () => { if (!data.me) return; ui.tab = b.dataset.tab; render(); window.scrollTo(0, 0); });

/* =====================================================================
   LOG: today's workout, set by set
   ===================================================================== */
function myWorkoutOn(date) { return data.workouts.find(w => w.user_id === data.me.id && w.date === date); }
function groupByExercise(sets) {
  const groups = new Map();
  sets.slice().sort((a, b) => a.position - b.position || String(a.created_at).localeCompare(String(b.created_at)))
    .forEach(s => { const k = norm(s.exercise); if (!groups.has(k)) groups.set(k, { name: s.exercise, sets: [] }); groups.get(k).sets.push(s); });
  return [...groups.values()];
}
function renderLog(v) {
  const w = myWorkoutOn(ui.logDate);
  const groups = w ? groupByExercise(D.setsByWorkout.get(w.id) || []) : [];
  const allNames = [...new Set([...D.exercises, ...COMMON_EXERCISES])];
  const last = groups.length ? groups[groups.length - 1].sets.slice(-1)[0] : null;
  v.innerHTML = `
    <div class="card">
      <div class="row">
        <div class="grow"><label for="logDate">Workout date</label><input type="date" id="logDate" value="${ui.logDate}" max="${today()}"></div>
        ${ui.logDate !== today() ? '<button id="toToday" style="align-self:flex-end">Today</button>' : ''}
      </div>
    </div>
    ${planCard(groups)}
    <div class="card">
      <h2>Add a set</h2>
      <datalist id="exList">${allNames.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
      <div class="grid3">
        <div><label for="exName">Exercise</label><input id="exName" list="exList" autocomplete="off" placeholder="Bench Press" value="${esc(last ? last.exercise : '')}"></div>
        <div><label for="exWeight">Weight (${UNIT})</label><input id="exWeight" type="number" inputmode="decimal" min="0" step="any" value="${last ? last.weight : ''}"></div>
        <div><label for="exReps">Reps</label><input id="exReps" type="number" inputmode="numeric" min="1" step="1" value="${last ? last.reps : ''}"></div>
      </div>
      <button class="primary" id="addSet" style="width:100%;margin-top:12px">Add set</button>
      <div class="hint" id="exHint"></div>
    </div>
    ${groups.map(g => `
      <div class="card">
        <div class="ex-head"><h3>${esc(g.name)}</h3><span class="muted small">${g.sets.length} set${g.sets.length === 1 ? '' : 's'}</span></div>
        <div class="chips">${g.sets.map(s => `<span class="chip ${s.isPR ? 'pr' : ''}">${s.isPR ? '🏆 ' : ''}${fmtNum(s.weight)} × ${s.reps}<button data-del-set="${s.id}" title="Delete set">×</button></span>`).join('')}</div>
      </div>`).join('')}
    ${w ? `
      <div class="card">
        <label for="wNotes">Notes</label>
        <textarea id="wNotes" rows="2" placeholder="How did it feel?">${esc(w.notes || '')}</textarea>
        <div class="row" style="margin-top:10px;justify-content:flex-end"><button class="small danger" id="delWorkout">Delete this workout</button></div>
      </div>` : `<p class="muted center">No sets logged for ${ui.logDate === today() ? 'today' : fmtD(ui.logDate)} yet.</p>`}`;

  $$('[data-suggest]').forEach(b => b.onclick = () => {
    $('#exName').value = b.dataset.suggest; $('#exWeight').value = ''; $('#exReps').value = '';
    const prev = D.sets.filter(s => s.user_id === data.me.id && norm(s.exercise) === norm(b.dataset.suggest)).pop();
    if (prev) { $('#exWeight').value = prev.weight; $('#exReps').value = prev.reps; } // start from last time
    $('#exHint').innerHTML = exerciseHint(b.dataset.suggest); $('#exWeight').focus();
  });
  const ps = $('#planSetup'); if (ps) ps.onclick = () => openSchedule(data.me.schedule ? 'week' : 'welcome');
  $('#logDate').onchange = e => { ui.logDate = e.target.value || today(); render(); };
  const tt = $('#toToday'); if (tt) tt.onclick = () => { ui.logDate = today(); render(); };
  const updateHint = () => { $('#exHint').innerHTML = exerciseHint($('#exName').value); };
  $('#exName').oninput = updateHint; updateHint();
  $('#exReps').onkeydown = e => { if (e.key === 'Enter') $('#addSet').click(); };
  $('#addSet').onclick = () => safely(addSet);
  $$('[data-del-set]').forEach(b => b.onclick = () => safely(async () => {
    await store.remove('sets', b.dataset.delSet);
    data.sets = data.sets.filter(s => s.id !== b.dataset.delSet); derive(); render();
  }));
  if (w) {
    $('#wNotes').onchange = e => safely(async () => { const r = await store.update('workouts', w.id, { notes: e.target.value }); Object.assign(w, r); toast('Notes saved.'); });
    $('#delWorkout').onclick = () => safely(async () => {
      if (!confirm(`Delete your whole workout from ${fmtD(w.date)}?`)) return;
      await store.remove('workouts', w.id);
      data.workouts = data.workouts.filter(x => x.id !== w.id); data.sets = data.sets.filter(s => s.workout_id !== w.id); derive(); render();
    });
  }
}
function planCard(groups) { // "Today's plan: Push" with tap-to-fill exercise suggestions
  const plan = planFor(data.me, ui.logDate);
  const when = ui.logDate === today() ? 'Today' : WEEKDAYS[weekdayIndex(ui.logDate)];
  if (plan === undefined) return `<div class="card today-plan row" style="justify-content:space-between"><span class="muted">📅 No workout schedule yet.</span><button class="small" id="planSetup">Set it up</button></div>`;
  if (plan === null) return `<div class="card today-plan row" style="justify-content:space-between"><span>😴 <b>${when}: rest day.</b> <span class="muted">Training anyway? Log it below.</span></span><button class="small" id="planSetup">Edit</button></div>`;
  const doneNames = new Set(groups.map(g => norm(g.name)));
  return `<div class="card today-plan">
    <div class="row" style="justify-content:space-between;margin-bottom:6px">
      <span>📅 <b>${when}: ${esc(plan.name)}</b> <span class="muted small">${esc(plan.muscles.join(' · '))}</span></span>
      <button class="small" id="planSetup">Edit</button>
    </div>
    ${plan.ex.length ? `<div class="muted small" style="margin-bottom:6px">Tap an exercise to start logging it:</div>
    <div class="chips">${plan.ex.map(e => `<button data-suggest="${esc(e)}" class="${doneNames.has(norm(e)) ? 'done' : ''}">${doneNames.has(norm(e)) ? '✓ ' : ''}${esc(e)}</button>`).join('')}</div>` : ''}
  </div>`;
}
function exerciseHint(name) {
  if (!name.trim()) return '';
  const n = norm(name), lines = [];
  for (const p of people()) {
    const mine = D.sets.filter(s => s.user_id === p.id && norm(s.exercise) === n && !(p.id === data.me.id && s.date === ui.logDate));
    if (!mine.length) continue;
    const top = mine.reduce((a, b) => b.e > a.e ? b : a);
    if (p.id === data.me.id) {
      const lastDate = mine[mine.length - 1].date, lastSets = mine.filter(s => s.date === lastDate);
      lines.push(`<b>Last time</b> (${fmtD(lastDate)}): ${lastSets.map(s => `${fmtNum(s.weight)}×${s.reps}`).join(', ')}`);
      lines.push(`<b>Your best:</b> ${fmtNum(top.weight)}×${top.reps} (est. 1-rep max ${Math.round(top.e)} ${UNIT}). Beat it for a 🏆`);
    } else lines.push(`<span class="dot" style="background:${p.color}"></span><b>${esc(p.display_name)}'s best:</b> ${fmtNum(top.weight)}×${top.reps} (est. ${Math.round(top.e)} ${UNIT})`);
  }
  return lines.join('<br>');
}
async function addSet() {
  const name = $('#exName').value.trim(), weight = parseFloat($('#exWeight').value || '0'), reps = parseInt($('#exReps').value, 10);
  if (!name) return toast('Type the exercise name.');
  if (!(reps > 0)) return toast('Enter how many reps.');
  if (!(weight >= 0)) return toast('Weight can\'t be negative.');
  const btn = $('#addSet'); btn.disabled = true;
  try {
    let w = myWorkoutOn(ui.logDate);
    if (!w) { w = await store.insert('workouts', { id: uuid(), user_id: data.me.id, date: ui.logDate, notes: '' }); data.workouts.push(w); }
    const position = (D.setsByWorkout.get(w.id) || []).length;
    const s = await store.insert('sets', { id: uuid(), workout_id: w.id, user_id: data.me.id, exercise: canonicalExercise(name), reps, weight, position });
    data.sets.push(s); derive();
    const added = D.sets.find(x => x.id === s.id);
    render();
    if (added && added.isPR) toast(`🏆 New personal record on ${added.exercise}!`, true);
  } finally { const b = $('#addSet'); if (b) b.disabled = false; }
}

/* =====================================================================
   HISTORY: everyone's workouts
   ===================================================================== */
function whoPicker(id, value, includeAll = true) {
  return `<div class="seg" id="${id}">${includeAll ? `<button data-v="all" class="${value === 'all' ? 'on' : ''}">Everyone</button>` : ''}
    ${people().map(p => `<button data-v="${p.id}" class="${value === p.id ? 'on' : ''}"><span class="dot" style="background:${p.color}"></span>${esc(p.id === data.me.id ? 'Me' : p.display_name)}</button>`).join('')}</div>`;
}
function workoutSummary(w) {
  const groups = groupByExercise(D.setsByWorkout.get(w.id) || []);
  if (!groups.length) return '<ul><li>No sets</li></ul>';
  return '<ul>' + groups.map(g => {
    const top = g.sets.reduce((a, b) => b.e > a.e ? b : a);
    return `<li>${esc(g.name)}: ${g.sets.length} set${g.sets.length === 1 ? '' : 's'}, top ${fmtNum(top.weight)}×${top.reps}${g.sets.some(s => s.isPR) ? ' 🏆' : ''}</li>`;
  }).join('') + '</ul>';
}
function renderHistory(v) {
  const list = data.workouts.filter(w => ui.histWho === 'all' || w.user_id === ui.histWho)
    .sort((a, b) => b.date.localeCompare(a.date) || String(b.created_at).localeCompare(String(a.created_at)));
  v.innerHTML = `
    <div class="card">${whoPicker('histWho', ui.histWho)}</div>
    ${list.slice(0, ui.histLimit).map(w => {
      const p = person(w.user_id), mine = w.user_id === data.me.id;
      return `<div class="card wcard" style="border-left-color:${p.color}">
        <div class="row" style="justify-content:space-between">
          <div><b>${esc(mine ? 'You' : p.display_name)}</b> <span class="muted">· ${fmtD(w.date)}</span></div>
          ${mine ? `<button class="small" data-edit="${w.date}">Edit</button>` : ''}
        </div>
        ${workoutSummary(w)}
        ${w.notes ? `<div class="muted small" style="margin-top:6px">📝 ${esc(w.notes)}</div>` : ''}
      </div>`;
    }).join('') || '<p class="muted center">No workouts yet.</p>'}
    ${list.length > ui.histLimit ? '<button id="more" style="width:100%">Show more</button>' : ''}`;
  $$('#histWho button').forEach(b => b.onclick = () => { ui.histWho = b.dataset.v; ui.histLimit = 30; render(); });
  $$('[data-edit]').forEach(b => b.onclick = () => { ui.logDate = b.dataset.edit; ui.tab = 'log'; render(); window.scrollTo(0, 0); });
  const m = $('#more'); if (m) m.onclick = () => { ui.histLimit += 30; render(); };
}

/* =====================================================================
   PROGRESS: one exercise over time, everyone on the same chart
   ===================================================================== */
const METRICS = {
  e1rm: { label: `Est. 1-rep max (${UNIT})`, agg: ss => Math.max(...ss.map(s => s.e)) },
  top: { label: `Heaviest weight (${UNIT})`, agg: ss => Math.max(...ss.map(s => s.weight)) },
  volume: { label: `Volume (${UNIT} × reps)`, agg: ss => ss.reduce((a, s) => a + s.weight * s.reps, 0) },
};
function lineChart(canvas, series, yLabel) {
  if (!window.Chart) { canvas.parentElement.innerHTML = '<p class="muted center">Charts need an internet connection.</p>'; return; }
  chart = new Chart(canvas, {
    type: 'line',
    data: { datasets: series.map(s => ({ label: s.label, data: s.points.map(p => ({ x: parseD(p.date).getTime(), y: r1(p.y) })), borderColor: s.hex, backgroundColor: s.hex, tension: .25, pointRadius: 3 })) },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'nearest', intersect: false },
      scales: {
        x: { type: 'linear', ticks: { color: '#9aa3b5', maxTicksLimit: 6, callback: v => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }, grid: { color: '#232a3a' } },
        y: { title: { display: true, text: yLabel, color: '#9aa3b5' }, ticks: { color: '#9aa3b5' }, grid: { color: '#232a3a' } },
      },
      plugins: { legend: { labels: { color: '#e8ebf2' } }, tooltip: { callbacks: { title: items => new Date(items[0].parsed.x).toLocaleDateString() } } },
    },
  });
}
function renderProgress(v) {
  if (!D.exercises.length) { v.innerHTML = '<div class="card center muted">Log a few workouts and your progress charts show up here.</div>'; return; }
  if (!ui.progEx || !D.exercises.includes(ui.progEx)) {
    const mine = D.sets.filter(s => s.user_id === data.me.id);
    ui.progEx = mine.length ? mine[mine.length - 1].exercise : D.exercises[0];
    ui.progEx = canonicalExercise(ui.progEx);
  }
  const n = norm(ui.progEx), M = METRICS[ui.progMetric];
  const series = people().map(p => {
    const byDate = new Map();
    D.sets.filter(s => s.user_id === p.id && norm(s.exercise) === n).forEach(s => { if (!byDate.has(s.date)) byDate.set(s.date, []); byDate.get(s.date).push(s); });
    return { ...p, label: p.id === data.me.id ? 'You' : p.display_name, points: [...byDate].map(([date, ss]) => ({ date, y: M.agg(ss), sets: ss })) };
  }).filter(s => s.points.length);
  v.innerHTML = `
    <div class="card">
      <div class="grid2">
        <div><label for="progEx">Exercise</label><select id="progEx">${D.exercises.map(e => `<option ${e === ui.progEx ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select></div>
        <div><label for="progMetric">Measure</label><select id="progMetric">${Object.entries(METRICS).map(([k, m]) => `<option value="${k}" ${k === ui.progMetric ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></div>
      </div>
    </div>
    <div class="card"><div class="chart-box"><canvas id="progChart"></canvas></div></div>
    ${series.map(s => {
      const all = s.points.flatMap(p => p.sets), top = all.reduce((a, b) => b.e > a.e ? b : a);
      const first = s.points[0].y, lastY = s.points[s.points.length - 1].y, diff = lastY - first;
      const prs = all.filter(x => x.isPR).length;
      return `<div class="card wcard" style="border-left-color:${s.color}">
        <b>${esc(s.label)}</b>
        <div class="muted small" style="margin-top:4px">
          Best set: <b style="color:var(--text)">${fmtNum(top.weight)} × ${top.reps}</b> (est. 1-rep max ${Math.round(top.e)} ${UNIT})<br>
          ${s.points.length} session${s.points.length === 1 ? '' : 's'} · ${prs} PR${prs === 1 ? '' : 's'} ·
          ${s.points.length > 1 ? `<span style="color:${diff >= 0 ? 'var(--good)' : 'var(--bad)'}">${diff >= 0 ? '▲' : '▼'} ${fmtNum(Math.abs(diff))}</span> since ${fmtD(s.points[0].date)}` : 'first session'}
        </div></div>`;
    }).join('')}`;
  $('#progEx').onchange = e => { ui.progEx = e.target.value; render(); };
  $('#progMetric').onchange = e => { ui.progMetric = e.target.value; render(); };
  lineChart($('#progChart'), series, M.label);
}

/* =====================================================================
   BODY: bodyweight and measurements
   ===================================================================== */
const BODY = {
  bodyweight: { label: `Bodyweight (${UNIT})` },
  waist: { label: `Waist (${UNIT === 'kg' ? 'cm' : 'in'})` },
  chest: { label: `Chest (${UNIT === 'kg' ? 'cm' : 'in'})` },
  arms: { label: `Arms (${UNIT === 'kg' ? 'cm' : 'in'})` },
  body_fat: { label: 'Body fat (%)' },
};
function renderBody(v) {
  const mine = data.body.filter(b => b.user_id === data.me.id).sort((a, b) => b.date.localeCompare(a.date));
  const key = ui.bodyMetric;
  const series = people().map(p => ({ ...p, label: p.id === data.me.id ? 'You' : p.display_name,
    points: data.body.filter(b => b.user_id === p.id && b[key] != null && b[key] !== '').sort((a, b) => a.date.localeCompare(b.date)).map(b => ({ date: b.date, y: +b[key] })) }))
    .filter(s => s.points.length);
  v.innerHTML = `
    <div class="card">
      <h2>Log body stats</h2>
      <div class="grid2">
        <div><label for="bDate">Date</label><input type="date" id="bDate" value="${today()}" max="${today()}"></div>
        ${Object.entries(BODY).map(([k, m]) => `<div><label for="b_${k}">${esc(m.label)}</label><input id="b_${k}" type="number" inputmode="decimal" step="any" min="0" placeholder="optional"></div>`).join('')}
      </div>
      <button class="primary" id="saveBody" style="width:100%;margin-top:12px">Save</button>
    </div>
    <div class="card">
      <label for="bodyMetric">Chart</label>
      <select id="bodyMetric" style="margin-bottom:12px">${Object.entries(BODY).map(([k, m]) => `<option value="${k}" ${k === key ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
      ${series.length ? '<div class="chart-box"><canvas id="bodyChart"></canvas></div>' : '<p class="muted center">Nothing logged for this yet.</p>'}
    </div>
    ${mine.length ? `<div class="card"><h2>My entries</h2>
      ${mine.slice(0, 20).map(b => `<div class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)">
        <span><b>${fmtD(b.date)}</b> <span class="muted small">${Object.keys(BODY).filter(k => b[k] != null && b[k] !== '').map(k => `${BODY[k].label.split(' (')[0]} ${fmtNum(b[k])}`).join(' · ')}</span></span>
        <button class="link" data-del-body="${b.id}" title="Delete">×</button></div>`).join('')}
    </div>` : ''}`;
  $('#bodyMetric').onchange = e => { ui.bodyMetric = e.target.value; render(); };
  $('#saveBody').onclick = () => safely(async () => {
    const row = { id: uuid(), user_id: data.me.id, date: $('#bDate').value || today() }; let any = false;
    for (const k of Object.keys(BODY)) { const val = $('#b_' + k).value; row[k] = val === '' ? null : parseFloat(val); if (val !== '') any = true; }
    if (!any) return toast('Fill in at least one number.');
    data.body.push(await store.insert('body_stats', row)); render(); toast('Saved.');
  });
  $$('[data-del-body]').forEach(b => b.onclick = () => safely(async () => {
    if (!confirm('Delete this entry?')) return;
    await store.remove('body_stats', b.dataset.delBody); data.body = data.body.filter(x => x.id !== b.dataset.delBody); render();
  }));
  if (series.length) lineChart($('#bodyChart'), series, BODY[key].label);
}

/* =====================================================================
   COMPETE: friendly scoreboard
   ===================================================================== */
function weeklyStreak(uid) {
  const counts = {};
  data.workouts.filter(w => w.user_id === uid).forEach(w => { const k = weekStart(w.date); counts[k] = (counts[k] || 0) + 1; });
  const d = parseD(weekStart(today()));
  if ((counts[dstr(d)] || 0) < STREAK_MIN) d.setDate(d.getDate() - 7); // this week isn't over yet
  let n = 0;
  while ((counts[dstr(d)] || 0) >= STREAK_MIN) { n++; d.setDate(d.getDate() - 7); }
  return n;
}
function renderCompete(v) {
  const ps = people();
  if (ps.length < 2) {
    v.innerHTML = `<div class="card center"><h2>Waiting for your friend 👀</h2><p class="muted">Send them this app's link. Once they create an account, your scoreboard appears here.</p></div>`;
    return;
  }
  const ws = weekStart(today()), month = today().slice(0, 7);
  const stat = p => {
    const wk = data.workouts.filter(w => w.user_id === p.id && weekStart(w.date) === ws);
    const wkSets = D.sets.filter(s => s.user_id === p.id && weekStart(s.date) === ws);
    const bw = data.body.filter(b => b.user_id === p.id && b.bodyweight != null).sort((a, b) => a.date.localeCompare(b.date));
    return {
      workouts: wk.length, sets: wkSets.length, volume: wkSets.reduce((a, s) => a + s.weight * s.reps, 0),
      streak: weeklyStreak(p.id), prs: D.sets.filter(s => s.user_id === p.id && s.isPR && s.date.startsWith(month)).length,
      total: data.workouts.filter(w => w.user_id === p.id).length,
      bw: bw.length > 1 ? +bw[bw.length - 1].bodyweight - +bw[0].bodyweight : null,
    };
  };
  const S = ps.map(stat);
  const row = (label, key, fmt = fmtNum) => {
    const vals = S.map(s => s[key]), max = Math.max(...vals);
    const lead = max > 0 && vals.filter(x => x === max).length === 1;
    return `<tr><td>${label}</td>${vals.map(x => `<td class="${lead && x === max ? 'lead' : ''}">${lead && x === max ? '👑 ' : ''}${fmt(x)}</td>`).join('')}</tr>`;
  };
  const head = `<tr><th></th>${ps.map(p => `<th><span class="dot" style="background:${p.color}"></span>${esc(p.id === data.me.id ? 'You' : p.display_name)}</th>`).join('')}</tr>`;
  const shared = D.exercises.filter(ex => ps.every(p => D.best[p.id + '|' + norm(ex)] !== undefined));
  v.innerHTML = `
    <div class="card"><h2>Today's plan</h2><table class="score">${head}
      <tr><td>${WEEKDAYS[weekdayIndex(today())]}</td>${ps.map(p => { const pl = planFor(p, today()); return `<td>${pl === undefined ? '<span class="muted">No schedule</span>' : pl === null ? '😴 Rest' : esc(pl.name)}</td>`; }).join('')}</tr>
    </table></div>
    <div class="card"><h2>This week</h2><table class="score">${head}
      ${row('Workouts', 'workouts')}${row('Sets', 'sets')}${row(`Volume (${UNIT})`, 'volume', x => Math.round(x).toLocaleString())}
    </table></div>
    <div class="card"><h2>Consistency</h2><table class="score">${head}
      ${row(`Week streak (${STREAK_MIN}+ workouts)`, 'streak')}${row('PRs this month', 'prs')}${row('All-time workouts', 'total')}
    </table></div>
    <div class="card"><h2>Head to head</h2>
      ${shared.length ? `<p class="muted small" style="margin-top:-6px">Best estimated 1-rep max (${UNIT}) on lifts you've all done</p><table class="score">${head}
        ${shared.map(ex => {
          const vals = ps.map(p => D.best[p.id + '|' + norm(ex)]), max = Math.max(...vals);
          return `<tr><td>${esc(ex)}</td>${vals.map(x => `<td class="${x === max ? 'lead' : ''}">${x === max ? '👑 ' : ''}${Math.round(x)}</td>`).join('')}</tr>`;
        }).join('')}</table>` : '<p class="muted">Once you\'ve both logged the same exercise, it shows up here.</p>'}
    </div>
    <div class="card"><h2>Bodyweight change</h2><table class="score">${head}
      <tr><td>Since first entry</td>${S.map(s => `<td>${s.bw == null ? '–' : (s.bw > 0 ? '+' : '') + fmtNum(s.bw) + ' ' + UNIT}</td>`).join('')}</tr>
    </table></div>`;
}

/* =====================================================================
   WORKOUT SCHEDULE: pick a plan, then adjust your week
   Saved on your profile as { plan, days: [Mon..Sun] } where each day is
   null (rest), { type: 'push' } or { type: 'custom', name, muscles: [...] }
   ===================================================================== */
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const weekdayIndex = s => (parseD(s).getDay() + 6) % 7; // Monday = 0
const MUSCLE_EX = {
  Chest: ['Bench Press', 'Incline Dumbbell Press', 'Chest Fly', 'Dip'],
  Back: ['Pull-up', 'Barbell Row', 'Lat Pulldown', 'Seated Cable Row'],
  Shoulders: ['Overhead Press', 'Lateral Raise', 'Face Pull'],
  Biceps: ['Bicep Curl', 'Hammer Curl'],
  Triceps: ['Tricep Pushdown', 'Skull Crusher', 'Dip'],
  Legs: ['Squat', 'Leg Press', 'Romanian Deadlift', 'Leg Curl', 'Calf Raise'],
  Glutes: ['Hip Thrust', 'Romanian Deadlift'],
  Core: ['Plank', 'Hanging Leg Raise', 'Cable Crunch'],
};
const DAY_TYPES = {
  push:       { name: 'Push', muscles: ['Chest', 'Shoulders', 'Triceps'], ex: ['Bench Press', 'Overhead Press', 'Incline Dumbbell Press', 'Lateral Raise', 'Tricep Pushdown'] },
  pull:       { name: 'Pull', muscles: ['Back', 'Biceps'], ex: ['Deadlift', 'Pull-up', 'Barbell Row', 'Lat Pulldown', 'Bicep Curl'] },
  legs:       { name: 'Legs', muscles: ['Legs', 'Glutes'], ex: ['Squat', 'Romanian Deadlift', 'Leg Press', 'Leg Curl', 'Calf Raise'] },
  upper:      { name: 'Upper Body', muscles: ['Chest', 'Back', 'Shoulders', 'Arms'], ex: ['Bench Press', 'Barbell Row', 'Overhead Press', 'Pull-up', 'Bicep Curl', 'Tricep Pushdown'] },
  lower:      { name: 'Lower Body', muscles: ['Legs', 'Glutes'], ex: ['Squat', 'Romanian Deadlift', 'Leg Press', 'Leg Curl', 'Calf Raise'] },
  chest_tri:  { name: 'Chest & Triceps', muscles: ['Chest', 'Triceps'], ex: ['Bench Press', 'Incline Dumbbell Press', 'Chest Fly', 'Dip', 'Tricep Pushdown'] },
  back_bi:    { name: 'Back & Biceps', muscles: ['Back', 'Biceps'], ex: ['Deadlift', 'Pull-up', 'Barbell Row', 'Lat Pulldown', 'Bicep Curl', 'Hammer Curl'] },
  legs_sh:    { name: 'Legs & Shoulders', muscles: ['Legs', 'Shoulders'], ex: ['Squat', 'Leg Press', 'Romanian Deadlift', 'Overhead Press', 'Lateral Raise'] },
  chest_back: { name: 'Chest & Back', muscles: ['Chest', 'Back'], ex: ['Bench Press', 'Barbell Row', 'Incline Dumbbell Press', 'Pull-up', 'Seated Cable Row'] },
  arms_sh:    { name: 'Arms & Shoulders', muscles: ['Biceps', 'Triceps', 'Shoulders'], ex: ['Overhead Press', 'Lateral Raise', 'Bicep Curl', 'Tricep Pushdown', 'Hammer Curl', 'Skull Crusher'] },
  full:       { name: 'Full Body', muscles: ['Chest', 'Back', 'Legs', 'Shoulders'], ex: ['Squat', 'Bench Press', 'Barbell Row', 'Overhead Press', 'Romanian Deadlift'] },
};
const PLANS = {
  ppl:    { name: 'Push / Pull / Legs', blurb: '6 days a week: Push, Pull, Legs, then repeat. Sunday off.', days: ['push', 'pull', 'legs', 'push', 'pull', 'legs', null] },
  ul:     { name: 'Upper / Lower', blurb: '4 days a week: Upper, Lower, rest, Upper, Lower.', days: ['upper', 'lower', null, 'upper', 'lower', null, null] },
  split5: { name: '5-Day Split', blurb: 'One or two muscle groups a day, Monday to Friday.', days: ['chest_tri', 'back_bi', 'legs_sh', 'chest_back', 'arms_sh', null, null] },
  custom: { name: 'Custom', blurb: 'Build your own week, day by day.', days: [null, null, null, null, null, null, null] },
};
function dayInfo(d) { // → { name, muscles, ex } or null for a rest day
  if (!d) return null;
  if (d.type === 'custom') {
    const muscles = d.muscles || [];
    return { name: d.name || 'Workout', muscles, ex: [...new Set(muscles.flatMap(m => MUSCLE_EX[m] || []))].slice(0, 8) };
  }
  return DAY_TYPES[d.type] || null;
}
function planFor(profile, date) {
  const s = profile && profile.schedule;
  if (!s || !Array.isArray(s.days)) return undefined;  // no schedule set up
  return dayInfo(s.days[weekdayIndex(date)]);          // null = rest day
}
const skipKey = () => 'lt-schedule-skipped-' + (data.me && data.me.id);
function skippedSchedule() { try { return localStorage.getItem(skipKey()) === '1'; } catch (e) { return false; } }

let sched = null; // pop-up state while it's open
function openSchedule(step) {
  const cur = data.me.schedule;
  sched = { step, plan: (cur && cur.plan) || null, days: cur ? JSON.parse(JSON.stringify(cur.days)) : PLANS.custom.days.slice() };
  renderSchedule();
}
function closeSchedule() { sched = null; const m = $('#modal'); if (m) m.remove(); }
function renderSchedule() {
  let m = $('#modal');
  if (!m) { m = document.createElement('div'); m.id = 'modal'; m.className = 'modal-bg'; document.body.appendChild(m); }
  const me = data.me;
  let body = '';
  if (sched.step === 'welcome') {
    body = `
      <div class="center" style="font-size:44px">💪</div>
      <h2 class="center">Welcome, ${esc(me.display_name)}!</h2>
      <p class="muted center">Let's set up your weekly workout schedule. Each day, Lift Together will show what's planned and suggest exercises, so logging is quicker.</p>
      <button class="primary" data-go="plan" style="width:100%">Set up my schedule</button>
      <button class="link" data-skip style="width:100%;margin-top:6px">Skip for now</button>`;
  } else if (sched.step === 'plan') {
    body = `
      <h2>Pick a plan</h2>
      <p class="muted small" style="margin-top:-6px">You can change any day on the next screen.</p>
      ${Object.entries(PLANS).map(([k, p]) => `
        <button class="plan ${sched.plan === k ? 'on' : ''}" data-plan="${k}">
          <b>${esc(p.name)}</b><span class="muted small">${esc(p.blurb)}</span>
          ${k === 'custom' ? '' : `<span class="plan-days">${p.days.map((d, i) => `<span>${WEEKDAYS[i].slice(0, 3)} <b>${d ? esc(DAY_TYPES[d].name) : '–'}</b></span>`).join('')}</span>`}
        </button>`).join('')}
      <div class="row" style="justify-content:space-between;margin-top:6px">
        <button class="link" data-skip>${me.schedule ? 'Cancel' : 'Skip for now'}</button>
        ${me.schedule ? '<button data-go="week">Back to my week</button>' : ''}
      </div>`;
  } else {
    body = `
      <h2>Your week</h2>
      <p class="muted small" style="margin-top:-6px">${sched.plan && sched.plan !== 'custom' ? esc(PLANS[sched.plan].name) + '. ' : ''}Change any day, or choose <b>Custom…</b> to name your own.</p>
      ${sched.days.map((d, i) => {
        const val = !d ? 'rest' : d.type;
        return `<div class="dayrow">
          <div class="row" style="flex-wrap:nowrap">
            <b style="width:92px;flex:none">${WEEKDAYS[i]}</b>
            <select data-day="${i}">
              <option value="rest" ${val === 'rest' ? 'selected' : ''}>😴 Rest</option>
              ${Object.entries(DAY_TYPES).map(([k, t]) => `<option value="${k}" ${val === k ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
              <option value="custom" ${val === 'custom' ? 'selected' : ''}>✏️ Custom…</option>
            </select>
          </div>
          ${val === 'custom' ? `
            <input data-cname="${i}" placeholder="Name this day, e.g. Glutes & Core" value="${esc(d.name || '')}" maxlength="40" style="margin-top:8px">
            <div class="chips" style="margin-top:8px">${Object.keys(MUSCLE_EX).map(mu => `<button class="tog ${(d.muscles || []).includes(mu) ? 'on' : ''}" data-mus="${i}|${mu}">${mu}</button>`).join('')}</div>` : ''}
        </div>`;
      }).join('')}
      <div class="row" style="justify-content:space-between;margin-top:14px">
        <button data-go="plan">← Plans</button>
        <button class="primary" data-save>Save schedule</button>
      </div>`;
  }
  m.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${body}</div>`;
  m.onclick = e => { if (e.target === m && data.me.schedule) closeSchedule(); };
  m.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { sched.step = b.dataset.go; renderSchedule(); });
  m.querySelectorAll('[data-skip]').forEach(b => b.onclick = () => {
    if (!data.me.schedule) { try { localStorage.setItem(skipKey(), '1'); } catch (e) {} toast('No problem. Set it up any time from the menu under your name.'); }
    closeSchedule();
  });
  m.querySelectorAll('[data-plan]').forEach(b => b.onclick = () => {
    sched.plan = b.dataset.plan;
    sched.days = PLANS[sched.plan].days.map(t => t ? { type: t } : null);
    sched.step = 'week'; renderSchedule();
  });
  m.querySelectorAll('[data-day]').forEach(s => s.onchange = () => {
    const i = +s.dataset.day, v = s.value;
    sched.days[i] = v === 'rest' ? null : v === 'custom' ? { type: 'custom', name: '', muscles: [] } : { type: v };
    renderSchedule();
  });
  m.querySelectorAll('[data-cname]').forEach(inp => inp.oninput = () => { sched.days[+inp.dataset.cname].name = inp.value; });
  m.querySelectorAll('[data-mus]').forEach(b => b.onclick = () => {
    const [i, mu] = b.dataset.mus.split('|'), d = sched.days[+i];
    d.muscles = d.muscles.includes(mu) ? d.muscles.filter(x => x !== mu) : [...d.muscles, mu];
    renderSchedule();
  });
  const saveBtn = m.querySelector('[data-save]');
  if (saveBtn) saveBtn.onclick = () => safely(async () => {
    const bad = sched.days.findIndex(d => d && d.type === 'custom' && !d.name.trim());
    if (bad >= 0) return toast(`Give ${WEEKDAYS[bad]}'s custom day a name.`);
    if (!sched.days.some(Boolean)) return toast('Pick at least one workout day.');
    const schedule = { plan: sched.plan || 'custom', days: sched.days.map(d => d && d.type === 'custom' ? { ...d, name: d.name.trim() } : d) };
    saveBtn.disabled = true;
    try {
      const r = await store.update('profiles', data.me.id, { schedule });
      Object.assign(data.me, r); Object.assign(data.profiles.find(p => p.id === data.me.id) || {}, r);
    } catch (e) {
      saveBtn.disabled = false;
      if (/schedule/i.test(e.message || '')) throw new Error('The database needs the schedule update first: run supabase/002_schedule.sql in Supabase.');
      throw e;
    }
    closeSchedule(); render(); toast('📅 Schedule saved!');
  });
}

/* =====================================================================
   SIGN IN / CREATE ACCOUNT
   ===================================================================== */
function renderAuth(mode = 'in', msg = '') {
  $('#nav').hidden = true; $('#who').innerHTML = ''; closeSchedule();
  $('#view').innerHTML = `
    <div class="auth">
      <h1>💪 Lift Together</h1>
      <p class="muted center" style="margin-top:0">Track your lifts. Beat your friends.</p>
      <form class="card" id="authForm" autocomplete="on">
        <div class="seg"><button type="button" data-m="in" class="${mode === 'in' ? 'on' : ''}">Sign in</button><button type="button" data-m="up" class="${mode === 'up' ? 'on' : ''}">Create account</button></div>
        ${mode === 'up' ? '<div><label for="aName">Your name (what your friends see)</label><input id="aName" name="nickname" autocomplete="nickname"></div>' : ''}
        <div><label for="aEmail">Email</label><input id="aEmail" name="email" type="email" autocomplete="username" required></div>
        <div><label for="aPass">Password</label><input id="aPass" name="password" type="password" autocomplete="${mode === 'up' ? 'new-password' : 'current-password'}" minlength="6" required></div>
        <button type="submit" class="primary" id="aGo" style="width:100%">${mode === 'up' ? 'Create account' : 'Sign in'}</button>
        <p class="muted small center" style="margin:0">You'll stay signed in on this device until you tap <b>Sign out</b>.</p>
        <div id="aMsg">${msg}</div>
      </form>
    </div>`;
  $$('.auth .seg button').forEach(b => b.onclick = () => renderAuth(b.dataset.m));
  $('#authForm').onsubmit = async ev => {
    ev.preventDefault(); // stay on the page (the browser still offers to save the password)
    const email = $('#aEmail').value.trim(), pass = $('#aPass').value, name = mode === 'up' ? $('#aName').value.trim() : '';
    const say = (t, cls = 'err') => { $('#aMsg').innerHTML = `<p class="${cls}">${esc(t)}</p>`; };
    if (mode === 'up' && !name) return say('Enter your name.');
    if (!email || !pass) return say('Enter your email and password.');
    $('#aGo').disabled = true;
    try {
      const user = mode === 'up' ? await store.signUp(email, pass, name) : await store.signIn(email, pass);
      if (!user) { renderAuth('in', '<p class="ok">Account created! Check your email for a confirmation link, then sign in here.</p>'); return; }
      await start(user);
    } catch (e) { say(e.message || 'That didn\'t work.'); $('#aGo').disabled = false; }
  };
}

/* =====================================================================
   START-UP
   ===================================================================== */
async function start(user) {
  $('#view').innerHTML = '<p class="muted center" style="margin-top:40px">Loading your workouts…</p>';
  data.me = await store.ensureProfile(user);
  data.email = user.email;
  await reload();
  data.me = data.profiles.find(p => p.id === data.me.id) || data.me;
  $('#nav').hidden = false;
  renderHeader(); render();
  if (!data.me.schedule && !skippedSchedule()) openSchedule('welcome'); // first sign-in: set up your week
}
let lastSync = Date.now();
window.addEventListener('focus', () => { // pick up your friend's new workouts when you come back to the app
  if (!data.me || Date.now() - lastSync < 30000) return;
  lastSync = Date.now(); safely(async () => { await reload(); render(); });
});
(async function boot() {
  $('#demoBanner').hidden = !DEMO;
  if (!DEMO && !window.supabase) { $('#view').innerHTML = '<div class="card center">Couldn\'t load. Check your internet connection and refresh.</div>'; return; }
  try {
    const user = await store.session();
    if (user) await start(user); else renderAuth();
  } catch (e) {
    console.error(e);
    $('#view').innerHTML = `<div class="card"><b>Couldn't connect to the database.</b><p class="muted">${esc(e.message || e)}</p></div>`;
  }
})();

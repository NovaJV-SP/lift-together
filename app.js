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
const PALETTE = ['#4f8cff', '#ff9f43', '#2ecc71', '#e056fd', '#ff6b81', '#22d3ee', '#fbc531', '#a3e635'];
const COMMON_EXERCISES = ['Bench Press', 'Squat', 'Deadlift', 'Overhead Press', 'Barbell Row', 'Pull-up', 'Incline Dumbbell Press',
  'Romanian Deadlift', 'Leg Press', 'Lat Pulldown', 'Bicep Curl', 'Tricep Pushdown', 'Lateral Raise', 'Hip Thrust', 'Dip'];
const MIGRATION_3 = 'supabase/003_goals_prs_templates.sql';

/* ---------- small helpers ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
const z = n => String(n).padStart(2, '0');
const dstr = d => `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
const today = () => dstr(new Date());
const parseD = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseD(s); d.setDate(d.getDate() + n); return dstr(d); };
const daysBetween = (a, b) => Math.round((parseD(b) - parseD(a)) / 864e5);
const fmtD = s => parseD(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const weekStart = s => { const d = parseD(s); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return dstr(d); };
const e1rm = (w, r) => r === 1 ? +w : +w * (1 + r / 30);   // Epley estimated one-rep max
const r1 = v => Math.round(v * 10) / 10;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const norm = s => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
const fmtNum = v => (v == null || v === '' || isNaN(v)) ? '–' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function toast(msg, gold) {
  const t = $('#toast'); t.textContent = msg; t.classList.toggle('gold', !!gold); t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3000);
}
async function safely(fn) { try { return await fn(); } catch (e) { console.error(e); toast('⚠ ' + (e.message || 'Something went wrong')); } }

/* =====================================================================
   DATA STORES: same interface for Supabase and demo mode
   ===================================================================== */
const TABLE_KEY = { profiles: 'profiles', workouts: 'workouts', sets: 'sets', body_stats: 'body', goals: 'goals', manual_prs: 'prs', templates: 'templates' };
const OPTIONAL_TABLES = ['goals', 'manual_prs', 'templates']; // added in update 3, may not exist yet

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
      const { data: rows, error } = await sb.from(table).select('*').order('created_at').range(from, from + 999);
      if (error) throw error;
      out = out.concat(rows);
      if (rows.length < 1000) return out;
    }
  }
  return {
    sb,
    async session() { const { data: d } = await sb.auth.getSession(); return d.session ? d.session.user : null; },
    async signIn(email, password) { const { data: d, error } = await sb.auth.signInWithPassword({ email, password }); if (error) throw error; return d.user; },
    async signUp(email, password, name) {
      const { data: d, error } = await sb.auth.signUp({ email, password, options: { data: { display_name: name }, emailRedirectTo: location.href.split('#')[0] } });
      if (error) throw error;
      return d.session ? d.user : null; // null → they must confirm their email first
    },
    // scope 'local' = sign out on THIS device only
    async signOut() { await sb.auth.signOut({ scope: 'local' }); location.reload(); },
    async loadAll() {
      const [profiles, workouts, sets, body] = await Promise.all(['profiles', 'workouts', 'sets', 'body_stats'].map(all));
      const missing = [];
      const [goals, prs, templates] = await Promise.all(OPTIONAL_TABLES.map(t => all(t).catch(e => { console.warn(t, e.message); missing.push(t); return []; })));
      return { profiles, workouts, sets, body, goals, prs, templates, missing };
    },
    async insert(t, row) { const { data: r, error } = await sb.from(t).insert(row).select().single(); if (error) throw error; return r; },
    async insertMany(t, rows) { const { data: r, error } = await sb.from(t).insert(rows).select(); if (error) throw error; return r; },
    async update(t, id, patch) { const { data: r, error } = await sb.from(t).update(patch).eq('id', id).select().single(); if (error) throw error; return r; },
    async remove(t, id) { const { error } = await sb.from(t).delete().eq('id', id); if (error) throw error; },
    async ensureProfile(user) {
      const { data: p, error } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
      if (error) throw error;
      if (p) return p;
      const name = (user.user_metadata && user.user_metadata.display_name) || user.email.split('@')[0];
      return this.insert('profiles', { id: user.id, display_name: name });
    },
  };
}

function demoStore() {
  const KEY = 'lift-together-demo-v2';
  let db = null;
  try { db = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
  if (!db || !db.profiles || !db.templates) db = seedDemo();
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} };
  persist();
  const copy = x => JSON.parse(JSON.stringify(x));
  const store = {
    async session() { return { id: 'demo-me', email: 'you@demo' }; },
    async signIn() {}, async signUp() {},
    async signOut() { if (confirm('Reset the demo data back to the samples?')) { try { localStorage.removeItem(KEY); } catch (e) {} location.reload(); } },
    async loadAll() { return copy({ profiles: db.profiles, workouts: db.workouts, sets: db.sets, body: db.body, goals: db.goals, prs: db.prs, templates: db.templates, missing: [] }); },
    async insert(t, row) { const r = { created_at: new Date().toISOString(), ...row }; db[TABLE_KEY[t]].push(r); persist(); return copy(r); },
    async insertMany(t, rows) { const out = []; for (const r of rows) out.push(await store.insert(t, r)); return out; },
    async update(t, id, patch) { const r = db[TABLE_KEY[t]].find(x => x.id === id); Object.assign(r, patch); persist(); return copy(r); },
    async remove(t, id) {
      db[TABLE_KEY[t]] = db[TABLE_KEY[t]].filter(x => x.id !== id);
      if (t === 'workouts') db.sets = db.sets.filter(s => s.workout_id !== id);
      persist();
    },
    async ensureProfile(u) { return copy(db.profiles.find(p => p.id === u.id)); },
  };
  return store;
}
function seedDemo() {
  const profiles = [{ id: 'demo-me', display_name: 'You' }, { id: 'demo-friend', display_name: 'Your friend' }, { id: 'demo-alex', display_name: 'Alex' }];
  const workouts = [], sets = [], body = [];
  let t = Date.now() - 1e9; const stamp = () => new Date(t += 1000).toISOString();
  profiles.forEach(p => p.created_at = stamp());
  profiles[1].schedule = { plan: 'ppl', mode: 'cycle', cycle: ['push', 'pull', 'legs', null, 'push', 'pull', 'legs', null], start: addDays(today(), -1) };
  const plan = [['Bench Press', 135, 8], ['Squat', 185, 6], ['Deadlift', 225, 5], ['Overhead Press', 85, 8], ['Barbell Row', 115, 10]];
  const dayOfWeek = (new Date().getDay() + 6) % 7, strength = [1, 1.1, 0.9];
  profiles.forEach((p, pi) => {
    for (let wk = 6; wk >= 0; wk--) {
      [0, 2, 4].forEach((off, di) => {
        if (wk === 0 && off > dayOfWeek) return;
        if ((wk + di + pi * 2) % 7 === 3 || (pi === 2 && di === 1)) return; // the odd missed workout
        const d = new Date(); d.setDate(d.getDate() - dayOfWeek - wk * 7 + off);
        const w = { id: uuid(), user_id: p.id, date: dstr(d), notes: '', created_at: stamp() };
        workouts.push(w);
        [[0, 3], [1, 4], [2, 0]][di].forEach((ix, pos) => {
          const [ex, base, reps] = plan[ix];
          const wt = Math.round((base * strength[pi] + (6 - wk) * (ix === 2 ? 10 : 5) * (pi === 1 ? 0.8 : 1)) / 5) * 5;
          for (let k = 0; k < 3; k++) sets.push({ id: uuid(), workout_id: w.id, user_id: p.id, exercise: ex, reps: reps - (k === 2 ? 1 : 0), weight: wt, position: pos * 3 + k, created_at: stamp() });
        });
      });
    }
    for (let wk = 6; wk >= 0; wk--) {
      const d = new Date(); d.setDate(d.getDate() - wk * 7);
      const bw = [186 - (6 - wk) * 0.9, 168 + (6 - wk) * 0.7, 175 - (6 - wk) * 0.3][pi];
      body.push({ id: uuid(), user_id: p.id, date: dstr(d), bodyweight: r1(bw), waist: null, chest: null, arms: null, body_fat: null, created_at: stamp() });
    }
  });
  const goals = [
    { id: uuid(), user_id: 'demo-friend', kind: 'lift', exercise: 'Bench Press', target_weight: 225, target_reps: 1, deadline: addDays(today(), 60), start_value: null, created_at: stamp() },
    { id: uuid(), user_id: 'demo-alex', kind: 'bodyweight', exercise: null, target_weight: 170, target_reps: 1, deadline: null, start_value: 175, created_at: stamp() },
  ];
  return { profiles, workouts, sets, body, goals, prs: [], templates: [] };
}

const store = DEMO ? demoStore() : supabaseStore();

/* =====================================================================
   STATE
   ===================================================================== */
const data = { me: null, email: '', profiles: [], workouts: [], sets: [], body: [], goals: [], prs: [], templates: [], missing: [] };
const ui = { tab: 'log', logDate: today(), histWho: 'all', histLimit: 30, progEx: null, progMetric: 'e1rm', bodyMetric: 'bodyweight', compMetric: 'workouts', h2hEx: null };
let D = {}; // derived data, rebuilt by derive()

function people() { // me first, then everyone else in the order they joined, each with a colour
  const others = data.profiles.filter(p => p.id !== data.me.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return [data.profiles.find(p => p.id === data.me.id) || data.me, ...others].map((p, i) => ({ ...p, color: PALETTE[i % PALETTE.length] }));
}
const person = id => people().find(p => p.id === id) || { display_name: '?', color: '#999' };
const nameOf = p => p.id === data.me.id ? 'You' : p.display_name;

function derive() {
  const wById = new Map(data.workouts.map(w => [w.id, w]));
  const sets = data.sets.filter(s => wById.has(s.workout_id))
    .map(s => ({ ...s, weight: +s.weight, reps: +s.reps, date: wById.get(s.workout_id).date, e: e1rm(+s.weight, +s.reps) }));
  const manual = data.prs.map(p => ({ ...p, weight: +p.weight, reps: +p.reps, e: e1rm(+p.weight, +p.reps), manual: true }));
  const events = [...sets, ...manual].sort((a, b) => a.date.localeCompare(b.date) || String(a.created_at).localeCompare(String(b.created_at)));
  const best = {}, bestSet = {};
  for (const ev of events) {   // a PR = beating your previous best estimated 1RM (logged or entered by hand)
    const k = ev.user_id + '|' + norm(ev.exercise);
    if (!ev.manual) ev.isPR = best[k] !== undefined && ev.e > best[k] + 0.01;
    if (best[k] === undefined || ev.e > best[k]) { best[k] = ev.e; bestSet[k] = ev; }
  }
  const loggedSets = events.filter(e => !e.manual);
  const names = new Map();
  events.forEach(s => { if (!names.has(norm(s.exercise))) names.set(norm(s.exercise), s.exercise); });
  const setsByWorkout = new Map();
  loggedSets.forEach(s => { if (!setsByWorkout.has(s.workout_id)) setsByWorkout.set(s.workout_id, []); setsByWorkout.get(s.workout_id).push(s); });
  D = { wById, sets: loggedSets, events, best, bestSet, exercises: [...names.values()].sort((a, b) => a.localeCompare(b)), setsByWorkout };
}
function canonicalExercise(name) { // reuse an existing spelling so "bench press" and "Bench Press" are the same
  const n = norm(name);
  return D.exercises.find(e => norm(e) === n) || COMMON_EXERCISES.find(e => norm(e) === n) || name.trim().replace(/\s+/g, ' ');
}
function needsUpdate(table) { // true (and a message) if this feature's database table doesn't exist yet
  if (!data.missing.includes(table)) return false;
  toast(`This needs a database update first: run ${MIGRATION_3} in Supabase.`);
  return true;
}

async function reload() {
  const all = await store.loadAll();
  Object.assign(data, all);
  if (!data.profiles.find(p => p.id === data.me.id)) data.profiles.push(data.me);
  data.me = data.profiles.find(p => p.id === data.me.id);
  derive();
}

/* =====================================================================
   RENDER: shell, header, pop-up helper
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
      Object.assign(data.me, r);
      renderHeader(); render(); toast('Name updated.');
    });
  });
}
document.addEventListener('click', () => { const m = $('#acctMenu'); if (m) m.hidden = true; });
$$('#nav button').forEach(b => b.onclick = () => { if (!data.me) return; ui.tab = b.dataset.tab; render(); window.scrollTo(0, 0); });

function openModal(html, bind, { dismissable = true } = {}) {
  let m = $('#modal');
  if (!m) { m = document.createElement('div'); m.id = 'modal'; m.className = 'modal-bg'; document.body.appendChild(m); }
  m.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  m.onclick = e => { if (e.target === m && dismissable) closeModal(); };
  m.querySelectorAll('[data-close]').forEach(b => b.onclick = closeModal);
  if (bind) bind(m);
  return m;
}
function closeModal() { const m = $('#modal'); if (m) m.remove(); sched = null; }
function bar(pct, color) { return `<div class="pbar"><div style="width:${Math.round(clamp(pct, 0, 1) * 100)}%;background:${color || 'var(--accent)'}"></div></div>`; }

/* =====================================================================
   LOG: today's workout
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
  const mine = data.templates.filter(t => t.user_id === data.me.id).sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'workout' ? -1 : 1));
  v.innerHTML = `
    <div class="card">
      <div class="row">
        <div class="grow"><label for="logDate">Workout date</label><input type="date" id="logDate" value="${ui.logDate}" max="${today()}"></div>
        ${ui.logDate !== today() ? '<button id="toToday" style="align-self:flex-end">Today</button>' : ''}
      </div>
    </div>
    ${planCard(groups)}
    <div class="card">
      <h2>Log sets</h2>
      <datalist id="exList">${allNames.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
      <label for="exName">Exercise</label>
      <input id="exName" list="exList" autocomplete="off" placeholder="Bench Press" value="${esc(last ? last.exercise : '')}">
      <div class="grid-sets">
        <div><label for="exWeight">Weight (${UNIT})</label><input id="exWeight" type="number" inputmode="decimal" min="0" step="any" value="${last ? last.weight : ''}"></div>
        <div><label for="exReps">Reps</label><input id="exReps" type="number" inputmode="numeric" min="1" step="1" value="${last ? last.reps : ''}"></div>
        <div><label for="exSets">Sets</label>
          <div class="stepper"><button type="button" id="setsMinus" aria-label="Fewer sets">−</button><input id="exSets" type="number" inputmode="numeric" min="1" max="20" value="1"><button type="button" id="setsPlus" aria-label="More sets">+</button></div>
        </div>
      </div>
      <button class="primary" id="addSet" style="width:100%;margin-top:12px">Add 1 set</button>
      <div class="hint" id="exHint"></div>
      ${mine.length ? `<div class="saved"><div class="muted small" style="margin-bottom:6px">⭐ Your saved workouts & exercises (tap to log)</div>
        <div class="chips">${mine.map(t => `<button class="tchip" data-tpl="${t.id}">${t.kind === 'workout' ? '📋' : '🏋️'} ${esc(t.name)}</button>`).join('')}</div></div>`
        : '<p class="muted small" style="margin:10px 0 0">Tip: tap ⭐ <b>Save</b> on an exercise or a whole workout below to reuse it next time.</p>'}
    </div>
    ${groups.map((g, gi) => `
      <div class="card">
        <div class="ex-head"><h3>${esc(g.name)}</h3>
          <span class="row" style="gap:6px"><span class="muted small">${plural(g.sets.length, 'set')}</span><button class="small" data-save-ex="${gi}">⭐ Save</button></span></div>
        <div class="chips">${g.sets.map(s => `<span class="chip ${s.isPR ? 'pr' : ''}"><button class="chip-edit" data-edit-set="${s.id}" title="Tap to change">${s.isPR ? '🏆 ' : ''}${fmtNum(s.weight)} × ${s.reps}</button><button data-del-set="${s.id}" title="Delete set">×</button></span>`).join('')}</div>
      </div>`).join('')}
    ${w ? `
      <div class="card">
        <label for="wNotes">Notes</label>
        <textarea id="wNotes" rows="2" placeholder="How did it feel?">${esc(w.notes || '')}</textarea>
        <div class="row" style="margin-top:10px;justify-content:space-between">
          ${groups.length ? '<button class="small" id="saveWorkout">⭐ Save whole workout</button>' : '<span></span>'}
          <button class="small danger" id="delWorkout">Delete this workout</button>
        </div>
      </div>` : `<p class="muted center">Nothing logged for ${ui.logDate === today() ? 'today' : fmtD(ui.logDate)} yet.</p>`}`;

  $('#logDate').onchange = e => { ui.logDate = e.target.value || today(); render(); };
  const tt = $('#toToday'); if (tt) tt.onclick = () => { ui.logDate = today(); render(); };
  const updateHint = () => { $('#exHint').innerHTML = exerciseHint($('#exName').value); };
  $('#exName').oninput = updateHint; updateHint();
  const setsInput = $('#exSets');
  const syncSets = () => { const n = clamp(parseInt(setsInput.value, 10) || 1, 1, 20); $('#addSet').textContent = `Add ${plural(n, 'set')}`; return n; };
  setsInput.oninput = syncSets;
  $('#setsMinus').onclick = () => { setsInput.value = clamp((parseInt(setsInput.value, 10) || 1) - 1, 1, 20); syncSets(); };
  $('#setsPlus').onclick = () => { setsInput.value = clamp((parseInt(setsInput.value, 10) || 1) + 1, 1, 20); syncSets(); };
  $('#exReps').onkeydown = e => { if (e.key === 'Enter') $('#addSet').click(); };
  $('#addSet').onclick = () => safely(addSets);
  $$('[data-suggest]').forEach(b => b.onclick = () => {
    $('#exName').value = b.dataset.suggest; $('#exWeight').value = ''; $('#exReps').value = '';
    const prev = D.sets.filter(s => s.user_id === data.me.id && norm(s.exercise) === norm(b.dataset.suggest)).pop();
    if (prev) { // start from last time, including how many sets you did
      $('#exWeight').value = prev.weight; $('#exReps').value = prev.reps;
      setsInput.value = D.sets.filter(s => s.workout_id === prev.workout_id && norm(s.exercise) === norm(prev.exercise)).length || 1; syncSets();
    }
    updateHint(); $('#exWeight').focus();
  });
  const ps = $('#planSetup'); if (ps) ps.onclick = () => openSchedule(data.me.schedule ? 'week' : 'welcome');
  $$('[data-tpl]').forEach(b => b.onclick = () => openTemplate(data.templates.find(t => t.id === b.dataset.tpl)));
  $$('[data-save-ex]').forEach(b => b.onclick = () => safely(() => saveTemplate('exercise', [groups[+b.dataset.saveEx]], groups[+b.dataset.saveEx].name)));
  $$('[data-edit-set]').forEach(b => b.onclick = () => safely(() => editSet(b.dataset.editSet)));
  $$('[data-del-set]').forEach(b => b.onclick = () => safely(async () => {
    await store.remove('sets', b.dataset.delSet);
    data.sets = data.sets.filter(s => s.id !== b.dataset.delSet); derive(); render();
  }));
  if (w) {
    $('#wNotes').onchange = e => safely(async () => { const r = await store.update('workouts', w.id, { notes: e.target.value }); Object.assign(w, r); toast('Notes saved.'); });
    const sw = $('#saveWorkout');
    if (sw) sw.onclick = () => safely(() => { const pl = planFor(data.me, ui.logDate); return saveTemplate('workout', groups, pl ? pl.name : 'My workout'); });
    $('#delWorkout').onclick = () => safely(async () => {
      if (!confirm(`Delete your whole workout from ${fmtD(w.date)}?`)) return;
      await store.remove('workouts', w.id);
      data.workouts = data.workouts.filter(x => x.id !== w.id); data.sets = data.sets.filter(s => s.workout_id !== w.id); derive(); render();
    });
  }
}
function planCard(groups) { // "Today: Push" with tap-to-fill exercise suggestions
  const plan = planFor(data.me, ui.logDate);
  const when = ui.logDate === today() ? 'Today' : WEEKDAYS[weekdayIndex(ui.logDate)];
  const cyc = cyclePos(data.me, ui.logDate), cycLabel = cyc ? `<span class="muted small"> · day ${cyc.k + 1} of ${cyc.n}</span>` : '';
  if (plan === undefined) return `<div class="card today-plan row" style="justify-content:space-between"><span class="muted">📅 No workout schedule yet.</span><button class="small" id="planSetup">Set it up</button></div>`;
  if (plan === null) return `<div class="card today-plan row" style="justify-content:space-between"><span>😴 <b>${when}: rest day</b>${cycLabel} <span class="muted small">Training anyway? Log it below.</span></span><button class="small" id="planSetup">Edit</button></div>`;
  const doneNames = new Set(groups.map(g => norm(g.name)));
  return `<div class="card today-plan">
    <div class="row" style="justify-content:space-between;margin-bottom:6px">
      <span>📅 <b>${when}: ${esc(plan.name)}</b>${cycLabel} <span class="muted small">${esc(plan.muscles.join(' · '))}</span></span>
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
    const top = D.bestSet[p.id + '|' + n];
    if (!top) continue;
    if (p.id === data.me.id) {
      const mine = D.sets.filter(s => s.user_id === p.id && norm(s.exercise) === n && s.date !== ui.logDate);
      if (mine.length) {
        const lastDate = mine[mine.length - 1].date, lastSets = mine.filter(s => s.date === lastDate);
        lines.push(`<b>Last time</b> (${fmtD(lastDate)}): ${lastSets.map(s => `${fmtNum(s.weight)}×${s.reps}`).join(', ')}`);
      }
      lines.push(`<b>Your PR:</b> ${fmtNum(top.weight)}×${top.reps} (est. 1-rep max ${Math.round(top.e)} ${UNIT}). Beat it for a 🏆`);
    } else if (lines.length < 6) lines.push(`<span class="dot" style="background:${p.color}"></span><b>${esc(p.display_name)}'s PR:</b> ${fmtNum(top.weight)}×${top.reps} (est. ${Math.round(top.e)} ${UNIT})`);
  }
  return lines.join('<br>');
}
async function logSets(rows) { // rows: [{exercise, weight, reps}] → added to your workout on ui.logDate
  let w = myWorkoutOn(ui.logDate);
  if (!w) { w = await store.insert('workouts', { id: uuid(), user_id: data.me.id, date: ui.logDate, notes: '' }); data.workouts.push(w); derive(); }
  const base = (D.setsByWorkout.get(w.id) || []).length;
  const ins = await store.insertMany('sets', rows.map((r, i) => ({
    id: uuid(), workout_id: w.id, user_id: data.me.id, exercise: canonicalExercise(r.exercise), reps: r.reps, weight: r.weight, position: base + i,
  })));
  data.sets.push(...ins); derive(); render();
  const prs = ins.map(r => D.sets.find(x => x.id === r.id)).filter(x => x && x.isPR);
  if (prs.length) toast(`🏆 New personal record on ${[...new Set(prs.map(p => p.exercise))].join(', ')}!`, true);
  return ins;
}
async function addSets() {
  const name = $('#exName').value.trim(), weight = parseFloat($('#exWeight').value || '0'), reps = parseInt($('#exReps').value, 10);
  const n = clamp(parseInt($('#exSets').value, 10) || 1, 1, 20);
  if (!name) return toast('Type the exercise name.');
  if (!(reps > 0)) return toast('Enter how many reps.');
  if (!(weight >= 0)) return toast('Weight can\'t be negative.');
  const btn = $('#addSet'); btn.disabled = true;
  try {
    const ins = await logSets(Array.from({ length: n }, () => ({ exercise: name, weight, reps })));
    if (!$('#toast').classList.contains('show')) toast(`Added ${plural(ins.length, 'set')}.`);
  } finally { const b = $('#addSet'); if (b) b.disabled = false; }
}
async function editSet(id) {
  const s = D.sets.find(x => x.id === id); if (!s) return;
  const ans = prompt(`Change this ${s.exercise} set (weight × reps):`, `${fmtNum(s.weight)} x ${s.reps}`);
  if (ans == null) return;
  const m = ans.replace(/,/g, '').match(/^\s*([\d.]+)\s*[x×*\s]\s*(\d+)\s*$/i);
  if (!m) return toast('Type it like "135 x 8".');
  const r = await store.update('sets', id, { weight: parseFloat(m[1]), reps: parseInt(m[2], 10) });
  Object.assign(data.sets.find(x => x.id === id), r); derive(); render(); toast('Set updated.');
}

/* ---------- ⭐ saved exercises & workouts ---------- */
async function saveTemplate(kind, groups, defaultName) {
  if (needsUpdate('templates')) return;
  const name = (prompt(kind === 'workout' ? 'Name this workout so you can log it again in one tap:' : 'Name this saved exercise:', defaultName) || '').trim();
  if (!name) return;
  const items = groups.map(g => ({ exercise: g.name, sets: g.sets.map(s => ({ weight: s.weight, reps: s.reps })) }));
  const t = await store.insert('templates', { id: uuid(), user_id: data.me.id, name: name.slice(0, 60), kind, items });
  data.templates.push(t); render();
  toast(`⭐ Saved "${t.name}". It's under Log sets now.`);
}
function openTemplate(t) {
  if (!t) return;
  const total = t.items.reduce((a, i) => a + i.sets.length, 0);
  const day = ui.logDate === today() ? 'today' : fmtD(ui.logDate);
  openModal(`
    <h2>${t.kind === 'workout' ? '📋' : '🏋️'} ${esc(t.name)}</h2>
    <p class="muted small" style="margin-top:-6px">${t.kind === 'workout' ? `Saved workout · ${plural(t.items.length, 'exercise')}` : 'Saved exercise'} · ${plural(total, 'set')}</p>
    ${t.items.map(i => `<div style="margin:10px 0"><b>${esc(i.exercise)}</b>
      <div class="chips" style="margin-top:4px">${i.sets.map(s => `<span class="chip" style="padding-right:12px">${fmtNum(s.weight)} × ${s.reps}</span>`).join('')}</div></div>`).join('')}
    <p class="muted small">These get added to your workout for ${day}. Tap any set afterwards to change the weight or reps.</p>
    <button class="primary" data-log style="width:100%">Log all ${plural(total, 'set')}</button>
    <div class="row" style="justify-content:space-between;margin-top:10px">
      <button class="link danger" data-del>Delete this saved ${t.kind}</button><button data-close>Cancel</button>
    </div>`, m => {
    m.querySelector('[data-log]').onclick = () => safely(async () => {
      closeModal();
      const ins = await logSets(t.items.flatMap(i => i.sets.map(s => ({ exercise: i.exercise, weight: +s.weight, reps: +s.reps }))));
      if (!$('#toast').classList.contains('show')) toast(`Logged ${plural(ins.length, 'set')} from "${t.name}".`);
    });
    m.querySelector('[data-del]').onclick = () => safely(async () => {
      if (!confirm(`Delete the saved ${t.kind} "${t.name}"? (Workouts you already logged stay.)`)) return;
      await store.remove('templates', t.id); data.templates = data.templates.filter(x => x.id !== t.id);
      closeModal(); render(); toast('Deleted.');
    });
  });
}

/* =====================================================================
   HISTORY: everyone's workouts
   ===================================================================== */
function whoPicker(id, value) {
  const ps = people();
  if (ps.length > 4) return `<select id="${id}"><option value="all">Everyone</option>${ps.map(p => `<option value="${p.id}" ${value === p.id ? 'selected' : ''}>${esc(p.id === data.me.id ? 'Me' : p.display_name)}</option>`).join('')}</select>`;
  return `<div class="seg" id="${id}"><button data-v="all" class="${value === 'all' ? 'on' : ''}">Everyone</button>
    ${ps.map(p => `<button data-v="${p.id}" class="${value === p.id ? 'on' : ''}"><span class="dot" style="background:${p.color}"></span>${esc(p.id === data.me.id ? 'Me' : p.display_name)}</button>`).join('')}</div>`;
}
function bindWhoPicker(id, onPick) {
  const el = $('#' + id);
  if (el.tagName === 'SELECT') el.onchange = () => onPick(el.value);
  else el.querySelectorAll('button').forEach(b => b.onclick = () => onPick(b.dataset.v));
}
function workoutSummary(w) {
  const groups = groupByExercise(D.setsByWorkout.get(w.id) || []);
  if (!groups.length) return '<ul><li>No sets</li></ul>';
  return '<ul>' + groups.map(g => {
    const top = g.sets.reduce((a, b) => b.e > a.e ? b : a);
    return `<li>${esc(g.name)}: ${plural(g.sets.length, 'set')}, top ${fmtNum(top.weight)}×${top.reps}${g.sets.some(s => s.isPR) ? ' 🏆' : ''}</li>`;
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
  bindWhoPicker('histWho', v2 => { ui.histWho = v2; ui.histLimit = 30; render(); });
  $$('[data-edit]').forEach(b => b.onclick = () => { ui.logDate = b.dataset.edit; ui.tab = 'log'; render(); window.scrollTo(0, 0); });
  const m = $('#more'); if (m) m.onclick = () => { ui.histLimit += 30; render(); };
}

/* =====================================================================
   PROGRESS: goals, PRs, and charts
   ===================================================================== */
const METRICS = {
  e1rm: { label: `Est. 1-rep max (${UNIT})`, agg: ss => Math.max(...ss.map(s => s.e)) },
  top: { label: `Heaviest weight (${UNIT})`, agg: ss => Math.max(...ss.map(s => s.weight)) },
  volume: { label: `Volume (${UNIT} × reps)`, agg: ss => ss.reduce((a, s) => a + s.weight * s.reps, 0) },
};
function latestBodyweight(uid) {
  const bw = data.body.filter(b => b.user_id === uid && b.bodyweight != null && b.bodyweight !== '').sort((a, b) => a.date.localeCompare(b.date));
  return bw.length ? +bw[bw.length - 1].bodyweight : null;
}
function goalInfo(g) { // → { title, pct, done, detail }
  const tw = +g.target_weight, tr = +g.target_reps || 1;
  if (g.kind === 'bodyweight') {
    const cur = latestBodyweight(g.user_id), start = g.start_value != null ? +g.start_value : cur;
    const title = `Reach ${fmtNum(tw)} ${UNIT} bodyweight`;
    if (cur == null) return { title, pct: 0, done: false, detail: 'Log your bodyweight on the Body tab to track this.' };
    const span = Math.abs(start - tw);
    const pct = span === 0 ? 1 : (tw < start ? (start - cur) / span : (cur - start) / span);
    const done = tw < start ? cur <= tw : cur >= tw;
    return { title, pct: done ? 1 : clamp(pct, 0, 1), done, detail: `Now ${fmtNum(cur)} ${UNIT} · started at ${fmtNum(start)}` };
  }
  const k = g.user_id + '|' + norm(g.exercise), best = D.best[k] || 0, target = e1rm(tw, tr);
  const done = D.events.some(e => e.user_id === g.user_id && norm(e.exercise) === norm(g.exercise) && e.weight >= tw && e.reps >= tr);
  const top = D.bestSet[k];
  return {
    title: `${g.exercise}: ${fmtNum(tw)} ${UNIT} × ${tr}`, done, pct: done ? 1 : clamp(best / target, 0, 1),
    detail: top ? `Best so far ${fmtNum(top.weight)}×${top.reps} (est. ${Math.round(best)} of ${Math.round(target)})` : 'No sets logged for this yet.',
  };
}
function deadlineText(g) {
  if (!g.deadline) return '';
  const left = daysBetween(today(), g.deadline);
  return left >= 0 ? ` · ${plural(left, 'day')} left` : ' · deadline passed';
}
function goalRow(g, mine, color) {
  const gi = goalInfo(g);
  return `<div class="goal">
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap">
      <b>${gi.done ? '✅ ' : '🎯 '}${esc(gi.title)}</b>
      ${mine ? `<button class="link" data-del-goal="${g.id}" title="Delete goal">×</button>` : ''}
    </div>
    ${bar(gi.pct, gi.done ? 'var(--good)' : color)}
    <div class="muted small">${gi.done ? 'Goal reached! 🎉 ' : `${Math.round(gi.pct * 100)}% · `}${esc(gi.detail)}${g.deadline ? esc(deadlineText(g)) : ''}</div>
  </div>`;
}
function lineChart(canvas, series, yLabel) {
  if (!window.Chart) { canvas.parentElement.innerHTML = '<p class="muted center">Charts need an internet connection.</p>'; return; }
  chart = new Chart(canvas, {
    type: 'line',
    data: { datasets: series.map(s => ({ label: s.label, data: s.points.map(p => ({ x: parseD(p.date).getTime(), y: r1(p.y) })), borderColor: s.color, backgroundColor: s.color, tension: .25, pointRadius: 3 })) },
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
  const me = people()[0];
  const myGoals = data.goals.filter(g => g.user_id === me.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const myPRs = D.exercises.map(ex => D.bestSet[me.id + '|' + norm(ex)]).filter(Boolean).sort((a, b) => a.exercise.localeCompare(b.exercise));
  let html = `
    <div class="card">
      <div class="row" style="justify-content:space-between;margin-bottom:8px"><h2 style="margin:0">🎯 My goals</h2><button class="small" id="addGoal">+ New goal</button></div>
      ${myGoals.length ? myGoals.map(g => goalRow(g, true, me.color)).join('') : '<p class="muted small" style="margin:0">Set a target like <b>Bench 225 × 1</b> or <b>reach 180 lb</b>, and the bar fills as you get closer.</p>'}
    </div>
    <div class="card">
      <div class="row" style="justify-content:space-between;margin-bottom:8px"><h2 style="margin:0">🏆 My PRs</h2><button class="small" id="addPR">+ Add a PR</button></div>
      ${myPRs.length ? myPRs.map(p => `<div class="pr-row">
          <span class="grow"><b>${esc(p.exercise)}</b> <span class="muted small">· ${fmtD(p.date)}${p.manual ? ' · entered by hand' : ''}</span></span>
          <span>${fmtNum(p.weight)} × ${p.reps} <span class="muted small">(est. ${Math.round(p.e)})</span></span>
          ${p.manual ? `<button class="link" data-del-pr="${p.id}" title="Delete">×</button>` : ''}
        </div>`).join('') : '<p class="muted small" style="margin:0">Your best lift per exercise shows up here automatically. Add PRs from before you used the app with <b>+ Add a PR</b>.</p>'}
    </div>`;
  if (D.exercises.length) {
    if (!ui.progEx || !D.exercises.includes(ui.progEx)) {
      const mine = D.sets.filter(s => s.user_id === me.id);
      ui.progEx = canonicalExercise(mine.length ? mine[mine.length - 1].exercise : D.exercises[0]);
    }
    const n = norm(ui.progEx), M = METRICS[ui.progMetric];
    var series = people().map(p => {
      const byDate = new Map();
      D.sets.filter(s => s.user_id === p.id && norm(s.exercise) === n).forEach(s => { if (!byDate.has(s.date)) byDate.set(s.date, []); byDate.get(s.date).push(s); });
      return { ...p, label: nameOf(p), points: [...byDate].map(([date, ss]) => ({ date, y: M.agg(ss), sets: ss })) };
    }).filter(s => s.points.length);
    html += `
      <div class="card">
        <h2>📈 Progress chart</h2>
        <div class="grid2">
          <div><label for="progEx">Exercise</label><select id="progEx">${D.exercises.map(e => `<option ${e === ui.progEx ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select></div>
          <div><label for="progMetric">Measure</label><select id="progMetric">${Object.entries(METRICS).map(([k, m]) => `<option value="${k}" ${k === ui.progMetric ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></div>
        </div>
        ${series.length ? '<div class="chart-box" style="margin-top:12px"><canvas id="progChart"></canvas></div>' : '<p class="muted center">No logged sets for this exercise yet.</p>'}
      </div>
      ${series.map(s => {
        const all = s.points.flatMap(p => p.sets), top = all.reduce((a, b) => b.e > a.e ? b : a);
        const diff = s.points[s.points.length - 1].y - s.points[0].y, prs = all.filter(x => x.isPR).length;
        return `<div class="card wcard" style="border-left-color:${s.color}">
          <b>${esc(s.label)}</b>
          <div class="muted small" style="margin-top:4px">
            Best set: <b style="color:var(--text)">${fmtNum(top.weight)} × ${top.reps}</b> (est. 1-rep max ${Math.round(top.e)} ${UNIT})<br>
            ${plural(s.points.length, 'session')} · ${plural(prs, 'PR')} ·
            ${s.points.length > 1 ? `<span style="color:${diff >= 0 ? 'var(--good)' : 'var(--bad)'}">${diff >= 0 ? '▲' : '▼'} ${fmtNum(Math.abs(diff))}</span> since ${fmtD(s.points[0].date)}` : 'first session'}
          </div></div>`;
      }).join('')}`;
  }
  v.innerHTML = html;
  $('#addGoal').onclick = openGoalForm;
  $('#addPR').onclick = openPRForm;
  $$('[data-del-goal]').forEach(b => b.onclick = () => safely(async () => {
    if (!confirm('Delete this goal?')) return;
    await store.remove('goals', b.dataset.delGoal); data.goals = data.goals.filter(g => g.id !== b.dataset.delGoal); render();
  }));
  $$('[data-del-pr]').forEach(b => b.onclick = () => safely(async () => {
    if (!confirm('Delete this PR you entered?')) return;
    await store.remove('manual_prs', b.dataset.delPr); data.prs = data.prs.filter(p => p.id !== b.dataset.delPr); derive(); render();
  }));
  if (D.exercises.length) {
    $('#progEx').onchange = e => { ui.progEx = e.target.value; render(); };
    $('#progMetric').onchange = e => { ui.progMetric = e.target.value; render(); };
    if (series.length) lineChart($('#progChart'), series, METRICS[ui.progMetric].label);
  }
}
const exDatalist = id => `<datalist id="${id}">${[...new Set([...D.exercises, ...COMMON_EXERCISES])].map(n => `<option value="${esc(n)}">`).join('')}</datalist>`;
function openGoalForm() {
  if (needsUpdate('goals')) return;
  let kind = 'lift';
  openModal(`
    <h2>🎯 New goal</h2>
    <div class="seg" id="gKind" style="margin-bottom:12px"><button data-k="lift" class="on">🏋️ A lift</button><button data-k="bodyweight">⚖️ Bodyweight</button></div>
    ${exDatalist('goalEx')}
    <div id="gLift">
      <label for="gEx">Exercise</label><input id="gEx" list="goalEx" placeholder="Bench Press" autocomplete="off">
      <div class="grid2" style="margin-top:10px">
        <div><label for="gW">Target weight (${UNIT})</label><input id="gW" type="number" inputmode="decimal" min="0" step="any" placeholder="225"></div>
        <div><label for="gR">For how many reps</label><input id="gR" type="number" inputmode="numeric" min="1" value="1"></div>
      </div>
    </div>
    <div id="gBody" hidden>
      <label for="gBW">Target bodyweight (${UNIT})</label><input id="gBW" type="number" inputmode="decimal" min="0" step="any" placeholder="180">
      <p class="muted small">Starting point: ${latestBodyweight(data.me.id) != null ? `${fmtNum(latestBodyweight(data.me.id))} ${UNIT} (your latest entry)` : 'your next bodyweight entry'}</p>
    </div>
    <label for="gDate" style="margin-top:10px">Deadline (optional)</label><input id="gDate" type="date" min="${today()}">
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button data-close>Cancel</button><button class="primary" id="gSave">Save goal</button></div>`, m => {
    m.querySelectorAll('#gKind button').forEach(b => b.onclick = () => {
      kind = b.dataset.k; m.querySelectorAll('#gKind button').forEach(x => x.classList.toggle('on', x === b));
      $('#gLift').hidden = kind !== 'lift'; $('#gBody').hidden = kind !== 'bodyweight';
    });
    $('#gSave').onclick = () => safely(async () => {
      const row = { id: uuid(), user_id: data.me.id, kind, deadline: $('#gDate').value || null, target_reps: 1 };
      if (kind === 'lift') {
        const ex = $('#gEx').value.trim(), w = parseFloat($('#gW').value), r = parseInt($('#gR').value, 10) || 1;
        if (!ex || !(w > 0)) return toast('Enter the exercise and a target weight.');
        Object.assign(row, { exercise: canonicalExercise(ex), target_weight: w, target_reps: r, start_value: null });
      } else {
        const w = parseFloat($('#gBW').value);
        if (!(w > 0)) return toast('Enter your target bodyweight.');
        Object.assign(row, { exercise: null, target_weight: w, start_value: latestBodyweight(data.me.id) });
      }
      data.goals.push(await store.insert('goals', row)); closeModal(); render(); toast('🎯 Goal set. Go get it!');
    });
  });
}
function openPRForm() {
  if (needsUpdate('manual_prs')) return;
  openModal(`
    <h2>🏆 Add a PR</h2>
    <p class="muted small" style="margin-top:-6px">For lifts you did before using the app, or anywhere you didn't log. Lifts you log here are tracked automatically.</p>
    ${exDatalist('prExList')}
    <label for="pEx">Exercise</label><input id="pEx" list="prExList" placeholder="Deadlift" autocomplete="off">
    <div class="grid2" style="margin-top:10px">
      <div><label for="pW">Weight (${UNIT})</label><input id="pW" type="number" inputmode="decimal" min="0" step="any"></div>
      <div><label for="pR">Reps</label><input id="pR" type="number" inputmode="numeric" min="1" value="1"></div>
    </div>
    <label for="pD" style="margin-top:10px">Date</label><input id="pD" type="date" value="${today()}" max="${today()}">
    <label for="pN" style="margin-top:10px">Note (optional)</label><input id="pN" placeholder="e.g. at the meet, with a belt" maxlength="100">
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button data-close>Cancel</button><button class="primary" id="pSave">Save PR</button></div>`, () => {
    $('#pSave').onclick = () => safely(async () => {
      const ex = $('#pEx').value.trim(), w = parseFloat($('#pW').value), r = parseInt($('#pR').value, 10) || 1;
      if (!ex || !(w >= 0) || isNaN(w)) return toast('Enter the exercise and weight.');
      const row = { id: uuid(), user_id: data.me.id, exercise: canonicalExercise(ex), weight: w, reps: r, date: $('#pD').value || today(), note: $('#pN').value.trim() || null };
      data.prs.push(await store.insert('manual_prs', row)); derive(); closeModal(); render(); toast('🏆 PR saved.', true);
    });
  });
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
  const series = people().map(p => ({ ...p, label: nameOf(p),
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
   COMPETE: leaderboards that work for 2 people or 20
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
function leaderboard(entries, fmt = fmtNum) { // entries: [{ p, val }] → ranked rows with 🥇🥈🥉
  const sorted = entries.slice().sort((a, b) => b.val - a.val);
  let rank = 0, prev = null;
  return sorted.map((e, i) => {
    if (e.val !== prev) { rank = i + 1; prev = e.val; }
    const medal = e.val > 0 ? (['🥇', '🥈', '🥉'][rank - 1] || `#${rank}`) : '–';
    return `<div class="lb-row ${e.p.id === data.me.id ? 'me' : ''}"><span class="rank">${medal}</span>
      <span class="dot" style="background:${e.p.color}"></span><span class="grow">${esc(nameOf(e.p))}</span><b>${fmt(e.val)}</b></div>`;
  }).join('');
}
const COMPETE_METRICS = [
  { k: 'workouts', label: 'Workouts this week' },
  { k: 'sets', label: 'Sets this week' },
  { k: 'volume', label: `Volume this week (${UNIT})`, fmt: x => Math.round(x).toLocaleString() },
  { k: 'streak', label: `Week streak (${STREAK_MIN}+ workouts a week)` },
  { k: 'prs', label: 'PRs this month' },
  { k: 'total', label: 'All-time workouts' },
];
function renderCompete(v) {
  const ps = people();
  if (ps.length < 2) {
    v.innerHTML = `<div class="card center"><h2>Waiting for friends 👀</h2><p class="muted">Send people this app's link. As soon as someone creates an account, the leaderboards show up here, for 2 people or 20.</p></div>`;
    return;
  }
  const ws = weekStart(today()), month = today().slice(0, 7);
  const stat = p => {
    const wkSets = D.sets.filter(s => s.user_id === p.id && weekStart(s.date) === ws);
    return {
      workouts: data.workouts.filter(w => w.user_id === p.id && weekStart(w.date) === ws).length,
      sets: wkSets.length, volume: wkSets.reduce((a, s) => a + s.weight * s.reps, 0),
      streak: weeklyStreak(p.id), prs: D.sets.filter(s => s.user_id === p.id && s.isPR && s.date.startsWith(month)).length,
      total: data.workouts.filter(w => w.user_id === p.id).length,
    };
  };
  const S = new Map(ps.map(p => [p.id, stat(p)]));
  const M = COMPETE_METRICS.find(m => m.k === ui.compMetric) || COMPETE_METRICS[0];
  const shared = D.exercises.filter(ex => ps.filter(p => D.best[p.id + '|' + norm(ex)] !== undefined).length >= 2);
  if (!shared.includes(ui.h2hEx)) ui.h2hEx = shared[0] || null;
  const goals = data.goals.slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const bwChange = p => {
    const bw = data.body.filter(b => b.user_id === p.id && b.bodyweight != null).sort((a, b) => a.date.localeCompare(b.date));
    return bw.length > 1 ? +bw[bw.length - 1].bodyweight - +bw[0].bodyweight : null;
  };
  v.innerHTML = `
    <div class="card"><h2>📅 Today's plan</h2>
      ${ps.map(p => { const pl = planFor(p, today()); return `<div class="lb-row ${p.id === data.me.id ? 'me' : ''}"><span class="dot" style="background:${p.color}"></span><span class="grow">${esc(nameOf(p))}</span><span>${pl === undefined ? '<span class="muted">No schedule</span>' : pl === null ? '😴 Rest' : esc(pl.name)}</span></div>`; }).join('')}
    </div>
    <div class="card"><h2>🏆 Leaderboard</h2>
      <select id="compMetric" style="margin-bottom:10px">${COMPETE_METRICS.map(m => `<option value="${m.k}" ${m.k === M.k ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
      ${leaderboard(ps.map(p => ({ p, val: S.get(p.id)[M.k] })), M.fmt)}
    </div>
    <div class="card"><h2>💪 Strongest lift</h2>
      ${shared.length ? `<select id="h2hEx" style="margin-bottom:10px">${shared.map(ex => `<option ${ex === ui.h2hEx ? 'selected' : ''}>${esc(ex)}</option>`).join('')}</select>
        <p class="muted small" style="margin:-4px 0 6px">Best estimated 1-rep max (${UNIT})</p>
        ${leaderboard(ps.filter(p => D.best[p.id + '|' + norm(ui.h2hEx)] !== undefined).map(p => ({ p, val: Math.round(D.best[p.id + '|' + norm(ui.h2hEx)]) })))}`
        : '<p class="muted">Once two people have logged the same exercise, you can compare it here.</p>'}
    </div>
    <div class="card"><h2>🎯 Everyone's goals</h2>
      ${goals.length ? ps.filter(p => goals.some(g => g.user_id === p.id)).map(p => `
        <div class="muted small" style="margin:8px 0 2px"><span class="dot" style="background:${p.color}"></span>${esc(nameOf(p))}</div>
        ${goals.filter(g => g.user_id === p.id).map(g => goalRow(g, false, p.color)).join('')}`).join('')
        : '<p class="muted">Nobody has set a goal yet. Add one on the Progress tab.</p>'}
    </div>
    <div class="card"><h2>⚖️ Bodyweight change</h2>
      ${ps.map(p => { const c = bwChange(p); return `<div class="lb-row"><span class="dot" style="background:${p.color}"></span><span class="grow">${esc(nameOf(p))}</span><span>${c == null ? '<span class="muted">–</span>' : (c > 0 ? '+' : '') + fmtNum(c) + ' ' + UNIT}</span></div>`; }).join('')}
      <p class="muted small" style="margin:6px 0 0">Since each person's first entry</p>
    </div>`;
  $('#compMetric').onchange = e => { ui.compMetric = e.target.value; render(); };
  const h = $('#h2hEx'); if (h) h.onchange = e => { ui.h2hEx = e.target.value; render(); };
}

/* =====================================================================
   WORKOUT SCHEDULE
   Two kinds, saved on your profile:
   • weekly: { plan, days: [Mon..Sun] }            each day null (rest) | {type} | {type:'custom', name, muscles}
   • cycle:  { plan, mode:'cycle', cycle:[...], start }  repeats every N days no matter the weekday
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
  ppl:    { name: 'Push / Pull / Legs', mode: 'cycle', blurb: 'Push, Pull, Legs, rest, then again: an 8-day cycle that keeps rolling no matter the weekday.',
            cycle: ['push', 'pull', 'legs', null, 'push', 'pull', 'legs', null], allowed: ['push', 'pull', 'legs'] },
  ul:     { name: 'Upper / Lower', mode: 'cycle', blurb: 'Upper, Lower, rest, then repeat: a 3-day cycle.',
            cycle: ['upper', 'lower', null], allowed: ['upper', 'lower'] },
  split5: { name: '5-Day Split', mode: 'weekly', blurb: 'One or two muscle groups a day, Monday to Friday.', days: ['chest_tri', 'back_bi', 'legs_sh', 'chest_back', 'arms_sh', null, null] },
  custom: { name: 'Custom', mode: 'weekly', blurb: 'Build your own week, day by day.', days: [null, null, null, null, null, null, null] },
};
function dayInfo(d) { // → { name, muscles, ex } or null for a rest day
  if (!d) return null;
  if (d.type === 'custom') {
    const muscles = d.muscles || [];
    return { name: d.name || 'Workout', muscles, ex: [...new Set(muscles.flatMap(m => MUSCLE_EX[m] || []))].slice(0, 8) };
  }
  return DAY_TYPES[d.type] || null;
}
function cyclePos(profile, date) { // where a date falls in a rotating schedule → { k, n } or null
  const s = profile && profile.schedule;
  if (!s || s.mode !== 'cycle' || !Array.isArray(s.cycle) || !s.cycle.length || !s.start) return null;
  const n = s.cycle.length;
  return { k: ((daysBetween(s.start, date) % n) + n) % n, n };
}
function planFor(profile, date) {
  const s = profile && profile.schedule;
  if (!s) return undefined;                               // no schedule set up
  const cp = cyclePos(profile, date);
  if (cp) { const t = s.cycle[cp.k]; return t ? dayInfo({ type: t }) : null; }
  if (!Array.isArray(s.days)) return undefined;
  return dayInfo(s.days[weekdayIndex(date)]);             // null = rest day
}
const skipKey = () => 'lt-schedule-skipped-' + (data.me && data.me.id);
function skippedSchedule() { try { return localStorage.getItem(skipKey()) === '1'; } catch (e) { return false; } }

let sched = null; // pop-up state while it's open
function openSchedule(step) {
  const cur = data.me.schedule;
  sched = { step, plan: (cur && cur.plan) || null, mode: 'weekly', days: PLANS.custom.days.slice(), cycle: [], todayDay: 1 };
  if (cur && cur.mode === 'cycle' && Array.isArray(cur.cycle)) {
    sched.mode = 'cycle'; sched.cycle = cur.cycle.slice(); sched.todayDay = (cyclePos(data.me, today()) || { k: 0 }).k + 1;
  } else if (cur && Array.isArray(cur.days)) sched.days = JSON.parse(JSON.stringify(cur.days));
  renderSchedule();
}
function closeSchedule() { closeModal(); }
const typeName = t => t ? DAY_TYPES[t].name : 'Rest';
function renderSchedule() {
  const me = data.me;
  let body = '';
  if (sched.step === 'welcome') {
    body = `
      <div class="center" style="font-size:44px">💪</div>
      <h2 class="center">Welcome, ${esc(me.display_name)}!</h2>
      <p class="muted center">Let's set up your workout schedule. Each day, Lift Together will show what's planned and suggest exercises, so logging is quicker.</p>
      <button class="primary" data-go="plan" style="width:100%">Set up my schedule</button>
      <button class="link" data-skip style="width:100%;margin-top:6px">Skip for now</button>`;
  } else if (sched.step === 'plan') {
    body = `
      <h2>Pick a plan</h2>
      <p class="muted small" style="margin-top:-6px">You can adjust it on the next screen.</p>
      ${Object.entries(PLANS).map(([k, p]) => `
        <button class="plan ${sched.plan === k ? 'on' : ''}" data-plan="${k}">
          <b>${esc(p.name)}</b><span class="muted small">${esc(p.blurb)}</span>
          ${p.mode === 'cycle' ? `<span class="plan-days">${p.cycle.map(t => `<b>${esc(typeName(t))}</b>`).join(' → ')} → repeat</span>`
            : k === 'custom' ? '' : `<span class="plan-days">${p.days.map((d, i) => `<span>${WEEKDAYS[i].slice(0, 3)} <b>${d ? esc(DAY_TYPES[d].name) : '–'}</b></span>`).join('')}</span>`}
        </button>`).join('')}
      <div class="row" style="justify-content:space-between;margin-top:6px">
        <button class="link" data-skip>${me.schedule ? 'Cancel' : 'Skip for now'}</button>
        ${me.schedule ? '<button data-go="week">Back to my schedule</button>' : ''}
      </div>`;
  } else if (sched.mode === 'cycle') {
    const P = PLANS[sched.plan] || PLANS.ppl, n = sched.cycle.length;
    const start = addDays(today(), -(sched.todayDay - 1));
    body = `
      <h2>${esc(P.name)} cycle</h2>
      <p class="muted small" style="margin-top:-6px">Repeats every ${n} days, whatever the weekday. Change any day if you like.</p>
      ${sched.cycle.map((t, i) => `<div class="dayrow row" style="flex-wrap:nowrap">
        <b style="width:70px;flex:none">Day ${i + 1}</b>
        <select data-cyc="${i}">${[...P.allowed, null].map(o => `<option value="${o || 'rest'}" ${t === o ? 'selected' : ''}>${o ? esc(DAY_TYPES[o].name) : '😴 Rest'}</option>`).join('')}</select>
      </div>`).join('')}
      <label for="todayDay" style="margin-top:14px">Which day of the cycle are you on today?</label>
      <select id="todayDay">${sched.cycle.map((t, i) => `<option value="${i + 1}" ${sched.todayDay === i + 1 ? 'selected' : ''}>Day ${i + 1} (${esc(typeName(t))})</option>`).join('')}</select>
      <div class="muted small" style="margin-top:10px"><b>Coming up:</b> ${Array.from({ length: 7 }, (_, i) => {
        const d = addDays(today(), i), t = sched.cycle[((daysBetween(start, d) % n) + n) % n];
        return `${i === 0 ? 'Today' : WEEKDAYS[weekdayIndex(d)].slice(0, 3)} <b style="color:var(--text)">${esc(typeName(t))}</b>`;
      }).join(' · ')}</div>
      <div class="row" style="justify-content:space-between;margin-top:14px">
        <button data-go="plan">← Plans</button>
        <button class="primary" data-save>Save schedule</button>
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
  openModal(body, m => {
    m.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { sched.step = b.dataset.go; renderSchedule(); });
    m.querySelectorAll('[data-skip]').forEach(b => b.onclick = () => {
      if (!data.me.schedule) { try { localStorage.setItem(skipKey(), '1'); } catch (e) {} toast('No problem. Set it up any time from the menu under your name.'); }
      closeSchedule();
    });
    m.querySelectorAll('[data-plan]').forEach(b => b.onclick = () => {
      const P = PLANS[b.dataset.plan];
      sched.plan = b.dataset.plan; sched.mode = P.mode;
      if (P.mode === 'cycle') { sched.cycle = P.cycle.slice(); sched.todayDay = 1; }
      else sched.days = P.days.map(t => t ? { type: t } : null);
      sched.step = 'week'; renderSchedule();
    });
    m.querySelectorAll('[data-cyc]').forEach(s => s.onchange = () => { sched.cycle[+s.dataset.cyc] = s.value === 'rest' ? null : s.value; renderSchedule(); });
    const td = m.querySelector('#todayDay'); if (td) td.onchange = () => { sched.todayDay = +td.value; renderSchedule(); };
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
      let schedule;
      if (sched.mode === 'cycle') {
        if (!sched.cycle.some(Boolean)) return toast('Your cycle needs at least one workout day.');
        schedule = { plan: sched.plan, mode: 'cycle', cycle: sched.cycle.slice(), start: addDays(today(), -(sched.todayDay - 1)) };
      } else {
        const bad = sched.days.findIndex(d => d && d.type === 'custom' && !d.name.trim());
        if (bad >= 0) return toast(`Give ${WEEKDAYS[bad]}'s custom day a name.`);
        if (!sched.days.some(Boolean)) return toast('Pick at least one workout day.');
        schedule = { plan: sched.plan || 'custom', mode: 'weekly', days: sched.days.map(d => d && d.type === 'custom' ? { ...d, name: d.name.trim() } : d) };
      }
      saveBtn.disabled = true;
      try {
        const r = await store.update('profiles', data.me.id, { schedule });
        Object.assign(data.me, r);
      } catch (e) {
        saveBtn.disabled = false;
        if (/schedule/i.test(e.message || '')) throw new Error('The database needs an update first: run supabase/002_schedule.sql in Supabase.');
        throw e;
      }
      closeSchedule(); render(); toast('📅 Schedule saved!');
    });
  }, { dismissable: !!me.schedule });
}

/* =====================================================================
   SIGN IN / CREATE ACCOUNT
   ===================================================================== */
function renderAuth(mode = 'in', msg = '') {
  $('#nav').hidden = true; $('#who').innerHTML = ''; closeModal();
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
  $('#nav').hidden = false;
  renderHeader(); render();
  if (!data.me.schedule && !skippedSchedule()) openSchedule('welcome'); // first sign-in: set up your schedule
}
let lastSync = Date.now();
window.addEventListener('focus', () => { // pick up your friends' new workouts when you come back to the app
  if (!data.me || $('#modal') || Date.now() - lastSync < 30000) return;
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

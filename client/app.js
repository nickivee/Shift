import { h, mount, icon } from './lib/dom.js';
import { get, post, setSignedOutHandler } from './lib/api.js';
import { showError } from './lib/ui.js';
import { entryView, signInView, contextView } from './views/entry.js';
import { homeView } from './views/home.js';
import { recordsView, searchView } from './views/records.js';
import { workstationView } from './views/workstation.js';
import { tasksView, receivedView, handoverView } from './views/coordination.js';
import { knowledgeView, questionView } from './views/knowledge.js';
import { notesView } from './views/notes.js';
import { rosteringView } from './views/rostering.js';
import { transfersView, flowView } from './views/transfers.js';
import { dischargesView } from './views/discharges.js';
import { escalationsView } from './views/escalations.js';
import { consultationsView } from './views/consultations.js';
import { woundReviewsView } from './views/wounds.js';
import { carePlanReviewsView } from './views/careplans.js';
import { referralsView } from './views/referrals.js';
import { appointmentsView } from './views/appointments.js';
import { alertsView } from './views/alerts.js';
import { communicationsView } from './views/communications.js';
import { monitoringView } from './views/monitoring.js';
import { restrictionsView } from './views/restrictions.js';
import { mealsView } from './views/diets.js';
import { equipmentView } from './views/equipment.js';
import { movesView } from './views/locations.js';
import { leaveView } from './views/leave.js';
import { preferencesView } from './views/preferences.js';
import { capacityView } from './views/capacity.js';
import { whanauView } from './views/whanau.js';
import { interpretersView } from './views/access.js';
import { externalView } from './views/external.js';
import { codingView, codingCaseView, codingQueriesView } from './views/coding.js';
import { personalView, personalFunctionView } from './views/personal.js';

// Application state shared by views. The server is the source of truth for authority;
// the client only mirrors what it was told so it can draw the right screens.
export const state = { me: null };

export function go(path) {
  if (location.hash === `#${path}`) render();
  else location.hash = path;
}

export async function refreshMe() {
  try {
    state.me = await get('/api/me');
  } catch {
    state.me = null;
  }
  return state.me;
}

export async function signOut() {
  try { await post('/api/auth/logout'); } catch { /* already signed out */ }
  state.me = null;
  go('/');
}

// A session that ends mid-use (idle timeout, sign-out elsewhere) returns you to sign-in.
setSignedOutHandler(() => {
  if (!state.me) return;
  state.me = null;
  const next = location.hash.startsWith('#/personal') ? 'personal' : 'work';
  if (!location.hash.startsWith('#/signin')) go(`/signin?next=${next}`);
});

const routes = [
  [/^\/$/, () => entryView(), { public: true }],
  [/^\/signin$/, (_m, q) => signInView(q.get('next') ?? 'work'), { public: true }],
  [/^\/work\/context$/, () => contextView()],
  [/^\/work\/home$/, () => homeView(), { work: true }],
  [/^\/work\/records$/, (_m, q) => recordsView(q.get('open')), { work: true }],
  [/^\/work\/search$/, () => searchView(), { work: true }],
  [/^\/work\/patient\/([^/]+)(?:\/([a-z]+))?$/, (m) => workstationView(m[1], m[2]), { work: true }],
  [/^\/work\/tasks$/, () => tasksView(), { work: true }],
  [/^\/work\/received$/, () => receivedView(), { work: true }],
  [/^\/work\/handover$/, () => handoverView(), { work: true }],
  [/^\/work\/knowledge$/, () => knowledgeView(), { work: true }],
  [/^\/work\/knowledge\/([^/]+)$/, (m) => questionView(m[1]), { work: true }],
  [/^\/work\/rostering\/([a-z]+)$/, (m) => rosteringView(m[1]), { work: true }],
  [/^\/work\/transfers$/, () => transfersView(), { work: true }],
  [/^\/work\/flow$/, () => flowView(), { work: true }],
  [/^\/work\/discharges$/, () => dischargesView(), { work: true }],
  [/^\/work\/escalations$/, () => escalationsView(), { work: true }],
  [/^\/work\/consultations$/, () => consultationsView(), { work: true }],
  [/^\/work\/wounds$/, () => woundReviewsView(), { work: true }],
  [/^\/work\/careplans$/, () => carePlanReviewsView(), { work: true }],
  [/^\/work\/referrals$/, () => referralsView(), { work: true }],
  [/^\/work\/appointments$/, () => appointmentsView(), { work: true }],
  [/^\/work\/alerts$/, () => alertsView(), { work: true }],
  [/^\/work\/communications$/, () => communicationsView(), { work: true }],
  [/^\/work\/monitoring$/, () => monitoringView(), { work: true }],
  [/^\/work\/restrictions$/, () => restrictionsView(), { work: true }],
  [/^\/work\/meals$/, () => mealsView(), { work: true }],
  [/^\/work\/equipment$/, () => equipmentView(), { work: true }],
  [/^\/work\/moves$/, () => movesView(), { work: true }],
  [/^\/work\/leave$/, () => leaveView(), { work: true }],
  [/^\/work\/preferences$/, () => preferencesView(), { work: true }],
  [/^\/work\/capacity$/, () => capacityView(), { work: true }],
  [/^\/work\/whanau$/, () => whanauView(), { work: true }],
  [/^\/work\/interpreters$/, () => interpretersView(), { work: true }],
  [/^\/work\/external$/, () => externalView(), { work: true }],
  [/^\/work\/coding$/, () => codingView(), { work: true }],
  [/^\/work\/coding-questions$/, () => codingQueriesView(), { work: true }],
  [/^\/work\/coding\/([^/]+)$/, (m) => codingCaseView(m[1]), { work: true }],
  [/^\/notes$/, () => notesView()],
  [/^\/personal$/, () => personalView()],
  [/^\/personal\/([a-z-]+)$/, (m) => personalFunctionView(m[1])],
];

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  const query = new URLSearchParams(qs ?? '');
  const app = document.getElementById('app');
  const match = routes.find(([re]) => re.test(path));
  if (!match) return go('/');
  const [re, view, opts = {}] = match;

  if (!opts.public) {
    if (!state.me) await refreshMe();
    if (!state.me) return go(`/signin?next=${path.startsWith('/personal') ? 'personal' : 'work'}`);
    if (opts.work && !state.me.context) return go('/work/context');
  }
  try {
    const el = await view(re.exec(path), query);
    if (seq !== renderSeq) return;
    mount(app, el);
    renderNav(path, opts.public);
    window.scrollTo(0, 0);
  } catch (err) {
    if (seq !== renderSeq) return;
    if (err?.code === 'NO_CONTEXT') { await refreshMe(); return go('/work/context'); }
    if (err?.status === 401) return;
    showError(err);
    mount(app, h('div', { class: 'card empty' }, err?.message ?? 'This screen could not be opened.'));
    renderNav(path, opts.public);
  }
}

// Fixed bottom navigation: Home | Notes | Personal | Sign out.
function renderNav(path, isPublic) {
  const nav = document.getElementById('nav');
  if (isPublic || !state.me) { nav.hidden = true; return; }
  nav.hidden = false;
  const home = state.me.context ? '/work/home' : '/';
  const item = (label, ic, target, active, onClick) =>
    h('button', { class: active ? 'active' : '', 'aria-current': active ? 'page' : null, onclick: onClick ?? (() => go(target)) }, icon(ic), label);
  mount(nav,
    item('Home', 'home', home, path.startsWith('/work') && !path.startsWith('/work/context') || path === '/'),
    item('Notes', 'notes', '/notes', path === '/notes'),
    item('Personal', 'person', '/personal', path.startsWith('/personal')),
    item('Sign out', 'signout', null, false, signOut),
  );
}

window.addEventListener('hashchange', render);
render();

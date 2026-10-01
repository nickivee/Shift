import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDate, fmtDateTime } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Rehab episode: readiness → baseline, goals linked to the care plan, plan → sessions delivered or
// not → reassessment, equipment and support → handed on and accepted → finished. The physio runs it;
// ward nurses and doctors see it.
const LABEL = { ready: 'Check readiness', session: 'Record a session', review: 'Reassess', handover: 'Hand on', accepted: 'They accepted', back: 'Not taken over', close: 'Finish' };
const pad = (n) => String(n).padStart(2, '0');
const inDays = (n) => { const d = new Date(Date.now() + n * 86_400_000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function goalRow(carePlan) {
  const goal = h('input', { 'aria-label': 'Goal', placeholder: 'e.g. Walk to the bathroom with her frame on her own' });
  const link = select(carePlan.map((c) => [c.id, c.label]), 'Care plan goal it helps', 'Not linked');
  return { el: h('div', { class: 'tile stack' }, field('Goal', goal), carePlan.length ? field('Care plan goal it helps', link) : null), value: () => ({ goal: goal.value, carePlanItem: link.value }) };
}

function readyDialog(x, o, reload) {
  const ready = select([['yes', 'Yes'], ['no', 'Not yet']], 'Ready for rehab');
  const reason = h('input', { 'aria-label': 'Why not yet', placeholder: 'e.g. On 4 L oxygen and drowsy' });
  const recheck = h('input', { type: 'date', 'aria-label': 'Check again on', value: inDays(1) });
  const baseline = h('textarea', { 'aria-label': 'How they manage now', placeholder: 'e.g. Walks 10 m with a frame and help of one; stands from a high chair' });
  const rows = [goalRow(o.carePlan)];
  const goals = h('div', { class: 'stack' }, rows[0].el);
  const more = h('button', { class: 'btn small', type: 'button', onclick: () => { const r = goalRow(o.carePlan); rows.push(r); goals.append(r.el); } }, 'Add another goal');
  const plan = h('input', { 'aria-label': 'Plan', placeholder: 'e.g. Walking practice, leg strength, stairs before home' });
  const perWeek = select([1, 2, 3, 4, 5, 6, 7, 10, 14].map((n) => [String(n), String(n)]), 'Sessions a week', null);
  perWeek.value = '5';
  const yesPart = h('div', { class: 'stack' }, field('How they manage now', baseline), h('h3', {}, 'Goals'), goals, more, field('Plan', plan), field('Sessions a week', perWeek));
  const noPart = h('div', { class: 'stack' }, field('Why not yet', reason), field('Check again on', recheck));
  const show = () => { yesPart.hidden = ready.value !== 'yes'; noPart.hidden = ready.value !== 'no'; };
  ready.addEventListener('change', show);
  show();
  dialog('Ready for rehab?', h('div', { class: 'stack' }, field('Ready for rehab', ready), yesPart, noPart), 'Save', async () => {
    await post(`/api/work/rehab/${x.id}/ready`, { ready: ready.value, reason: reason.value, recheck: recheck.value, baseline: baseline.value, goals: rows.map((r) => r.value()), plan: plan.value, perWeek: Number(perWeek.value) });
    toast('Saved.');
    reload();
  }, { wide: true });
}

function sessionDialog(x, o, reload) {
  const delivered = select([['yes', 'Yes'], ['no', 'No']], 'Did the session happen');
  const done = h('textarea', { 'aria-label': 'What was done', placeholder: 'e.g. Walked 20 m with frame; stairs x 4 with rail' });
  const response = h('input', { 'aria-label': 'How they responded', placeholder: 'Optional, e.g. Tired after; SpO2 held 94%' });
  const reason = select(Object.entries(o.notDelivered), 'Why not');
  const note = h('input', { 'aria-label': 'Note', placeholder: 'Optional' });
  const yes = h('div', { class: 'stack' }, field('What was done', done), field('How they responded', response));
  const no = h('div', { class: 'stack' }, field('Why not', reason), field('Note', note));
  const show = () => { yes.hidden = delivered.value !== 'yes'; no.hidden = delivered.value !== 'no'; };
  delivered.addEventListener('change', show);
  show();
  dialog('Record a session', h('div', { class: 'stack' }, field('Did the session happen', delivered), yes, no), 'Save', async () => {
    await post(`/api/work/rehab/${x.id}/session`, { delivered: delivered.value, done: done.value, response: response.value, reason: reason.value, note: note.value });
    toast('Saved.');
    reload();
  });
}

function reviewDialog(x, o, reload) {
  const note = h('textarea', { 'aria-label': 'How they are going', placeholder: 'e.g. Now walking 30 m with frame, supervision only' });
  const states = x.goals.map((g) => { const s = select(Object.entries(o.goal), g.goal, null); s.value = g.state; return { id: g.id, s, el: field(g.goal, s) }; });
  const needs = h('input', { 'aria-label': 'Equipment and support needed', placeholder: 'e.g. Frame; rail by the back steps; shower stool', value: x.needs ?? '' });
  dialog('Reassess', h('div', { class: 'stack' }, field('How they are going', note), h('h3', {}, 'Goals'), states.map((g) => g.el), field('Equipment and support needed', needs)), 'Save', async () => {
    await post(`/api/work/rehab/${x.id}/review`, { note: note.value, goalStates: Object.fromEntries(states.map((g) => [g.id, g.s.value])), needs: needs.value });
    toast('Saved.');
    reload();
  });
}

function handoverDialog(x, o, reload) {
  const kind = select(Object.entries(o.next).filter(([k]) => k !== 'NONE'), 'Who takes over');
  const to = h('input', { 'aria-label': 'Team or person', placeholder: 'e.g. Kapiti community physio team' });
  const summary = h('textarea', { 'aria-label': 'Summary for them', placeholder: 'Where they are up to, goals still open, equipment, and what is next' });
  dialog('Hand on', h('div', { class: 'stack' }, field('Who takes over', kind), field('Team or person', to), field('Summary for them', summary),
    h('p', { class: 'small muted' }, 'The episode stays with you until they accept.')), 'Hand on', async () => {
    await post(`/api/work/rehab/${x.id}/handover`, { nextKind: kind.value, nextTo: to.value, summary: summary.value });
    toast('Handed on. It stays with you until they accept.');
    reload();
  });
}

function finishDialog(x, action, o, reload) {
  const note = h('textarea', { 'aria-label': 'Note' });
  if (action === 'back') {
    note.placeholder = `e.g. ${x.nextTo} cannot take them until next month`;
    return dialog('Not taken over', h('div', { class: 'stack' }, field('What happened', note)), 'Save', async () => { await post(`/api/work/rehab/${x.id}/back`, { note: note.value }); toast('Saved.'); reload(); });
  }
  const outcome = select(Object.entries(o.outcome), 'Outcome');
  note.placeholder = action === 'accepted' ? 'e.g. Sam at Kapiti community physio, by phone; first visit Tuesday' : 'e.g. Home with frame; managing stairs with the rail';
  return dialog(action === 'accepted' ? `${x.nextTo} accepted` : 'Finish the rehab episode', h('div', { class: 'stack' },
    field(action === 'accepted' ? 'Who accepted, and when' : 'Summary', note), field('Outcome', outcome)), action === 'accepted' ? 'Save' : 'Finish', async () => {
    await post(`/api/work/rehab/${x.id}/${action}`, { note: note.value, outcome: outcome.value });
    toast('Finished.');
    reload();
  });
}

function sessionItem(s) {
  return h('li', { class: 'det-step' },
    h('div', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`),
    s.delivered ? h('div', { class: 'small' }, s.done, s.response ? h('span', { class: 'muted' }, ` · ${s.response}`) : null)
      : h('div', { class: 'small warn-text' }, `Did not happen: ${s.reasonLabel}${s.note ? `. ${s.note}` : ''}`));
}

function episodeCard(x, s, reload) {
  const o = s.options;
  const tone = x.state === 'ACTIVE' ? 'ok' : x.state === 'CLOSED' ? '' : 'warn';
  const run = (a) => ({ ready: readyDialog, session: sessionDialog, review: reviewDialog, handover: handoverDialog }[a] ?? ((ep, opts, rl) => finishDialog(ep, a, opts, rl)))(x, o, reload);
  return h('div', { class: 'tile stack rehab' },
    h('div', { class: 'spread' }, h('b', {}, `${x.service} · since ${fmtDate(x.startedAt)}`), h('span', { class: `tag ${tone}` }, x.stateLabel)),
    x.state === 'NOT_READY' ? h('div', { class: 'small' }, h('b', {}, 'Not ready: '), `${x.notReadyReason} · check again ${fmtDate(x.recheckOn)}`) : null,
    x.baseline ? h('div', { class: 'small' }, h('b', {}, 'When they started: '), x.baseline) : null,
    x.goals.length ? h('ul', { class: 'stack rehab-goals' }, x.goals.map((g) => h('li', { class: 'small' },
      h('span', { class: `tag${g.state === 'MET' ? ' ok' : ''}` }, g.stateLabel), ` ${g.goal}`, g.carePlan ? h('span', { class: 'muted' }, ` · care plan: ${g.carePlan}`) : null))) : null,
    x.plan ? h('div', { class: 'small' }, h('b', {}, 'Plan: '), `${x.plan} · ${x.perWeek} a week`) : null,
    x.state === 'ACTIVE' ? h('div', { class: `small${x.week.missed ? ' warn-text' : ''}` },
      `Last 7 days: ${x.week.delivered} of ${x.week.planned} sessions${x.week.missed ? `, ${x.week.missed} did not happen` : ''}`) : null,
    x.needs ? h('div', { class: 'small' }, h('b', {}, 'Equipment and support: '), x.needs) : null,
    x.nextTo ? h('div', { class: 'small' }, h('b', {}, `Handed on to ${x.nextTo} (${x.nextLabel}): `), x.nextSummary) : null,
    x.outcomeLabel ? h('div', { class: 'small' }, h('b', {}, `${x.outcomeLabel}: `), x.closeNote) : null,
    x.sessions.length ? h('details', {}, h('summary', { class: 'small' }, `Sessions (${x.sessionCount})`), h('ol', { class: 'det-steps' }, x.sessions.map(sessionItem))) : null,
    x.acts.length ? h('div', { class: 'row' }, x.acts.map((a) => h('button', { class: `btn small${a === 'ready' || a === 'session' || a === 'accepted' ? ' primary' : ''}`, onclick: () => run(a) }, LABEL[a]))) : null,
    h('details', {}, h('summary', { class: 'small' }, `History (${x.steps.length})`),
      h('ol', { class: 'det-steps' }, x.steps.map((st) => h('li', { class: 'det-step' },
        h('div', { class: 'small muted' }, `${st.by} · ${fmtDateTime(st.at)}`), h('div', { class: 'small' }, st.body))))),
  );
}

// At the top of the physio's Treatment; in the ward's Care Plan and the doctor's Review.
export function rehabPanel(personId, s, reload) {
  if (!s) return null;
  return h('section', { class: 'stack' },
    h('div', { class: 'spread' }, h('h3', {}, s.title),
      s.canStart ? h('button', { class: 'btn small', onclick: async () => { await post(`/api/work/patients/${personId}/rehab`, {}); toast('Rehab episode started.'); reload(); } }, 'Start a rehab episode') : null),
    s.current ? episodeCard(s.current, s, reload) : h('div', { class: 'empty' }, s.physio ? 'No rehab episode open.' : 'Not seeing physio now.'),
    s.past.length ? h('details', {}, h('summary', { class: 'small' }, `Earlier episodes (${s.past.length})`), h('div', { class: 'stack' }, s.past.map((x) => episodeCard(x, s, reload)))) : null,
  );
}

import { h } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';

// Follow-ups: needed → someone takes responsibility → arranged (referral, appointment, task or letter) → scheduled → happened → outcome → closed or further follow-up.
const TONE = { REQUIRED: 'warn', DECLINED: 'danger', ACCEPTED: 'ok', ARRANGED: 'ok', SCHEDULED: 'ok', COMPLETED: 'warn', CLOSED: 'muted', CANCELLED: 'muted', ENTERED_IN_ERROR: 'muted' };

function dialog(title, body, submitLabel, onSubmit) {
  const error = h('p', { class: 'small notice', hidden: true });
  const dlg = h('dialog', {},
    h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      try { await onSubmit(); dlg.close(); dlg.remove(); } catch (err) { error.textContent = err?.message ?? 'Something went wrong.'; error.hidden = false; }
    } },
      h('h2', {}, title), body, error,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'submit' }, submitLabel),
        h('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); dlg.remove(); } }, 'Cancel')),
    ),
  );
  dlg.addEventListener('cancel', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

const field = (label, el) => h('label', { class: 'field' }, label, el);
const select = (entries, label, blank = 'Choose…') => h('select', { 'aria-label': label }, blank === null ? null : h('option', { value: '' }, blank), entries.map(([k, v]) => h('option', { value: k }, v)));
const pad = (n) => String(n).padStart(2, '0');
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const send = (x, action, body) => post(`/api/work/followups/${x.id}/${action}`, body);

function makeDialog(personId, o, reload) {
  const what = h('input', { type: 'text', 'aria-label': 'Follow-up needed', placeholder: 'e.g. GP to recheck potassium within a week' });
  const reason = h('textarea', { 'aria-label': 'Why', placeholder: 'Optional, e.g. Potassium 3.1; on oral replacement' });
  const by = h('input', { type: 'date', 'aria-label': 'Needed by', min: addDays(0) });
  const to = select([...o.responsibles.map((r) => [r.id, r.label]), ['EXTERNAL', 'An outside provider (GP, clinic)…']], 'Responsible');
  const ext = h('input', { type: 'text', 'aria-label': 'Outside provider', placeholder: 'e.g. Dr Priya Nair, Onehunga Health (GP)' });
  const extField = field('Outside provider', ext);
  extField.hidden = true;
  to.addEventListener('change', () => { extField.hidden = to.value !== 'EXTERNAL'; });
  dialog('Follow-up needed', h('div', { class: 'stack' }, field('Follow-up needed', what), field('Why', reason), field('Needed by', by), field('Responsible', to), extField),
    'Save', async () => {
      await post(`/api/work/patients/${personId}/followups`, { what: what.value, reason: reason.value, dueBy: by.value, to: to.value, externalName: ext.value });
      toast('Follow-up saved.');
      reload();
    });
}

function acceptDialog(x, o, reload) {
  const ext = x.respKind === 'EXTERNAL';
  const told = select(Object.entries(o.told), 'How they were told');
  const note = h('textarea', { 'aria-label': ext ? 'Who agreed' : 'Note', placeholder: ext ? 'e.g. Practice nurse Sue confirmed Dr Nair will see him' : 'Optional' });
  dialog(ext ? `Responsibility confirmed: ${x.externalName}` : `Take on: ${x.what}`, h('div', { class: 'stack' },
    ext ? field(`How ${x.externalName} was told`, told) : null, field(ext ? 'Who agreed to take it on' : 'Note', note)), 'Save', async () => {
    await send(x, 'accept', { told: told.value, note: note.value });
    reload();
  });
}

function arrangeDialog(x, o, reload) {
  const link = select(Object.entries(o.links), 'How');
  const ref = h('input', { type: 'text', 'aria-label': 'What was sent or booked', placeholder: 'e.g. eReferral to Cardiology, 25 Sept' });
  dialog(`Arrange: ${x.what}`, h('div', { class: 'stack' }, field('How it was arranged', link), field('What was sent or booked', ref)), 'Save', async () => {
    await send(x, 'arrange', { link: link.value, ref: ref.value });
    reload();
  });
}

function scheduleDialog(x, reload) {
  const when = h('input', { type: 'datetime-local', 'aria-label': 'When' });
  const where = h('input', { type: 'text', 'aria-label': 'Where', placeholder: 'e.g. Physiotherapy outpatients, Gym 2', value: x.scheduledWhere ?? '' });
  dialog(`Scheduled: ${x.what}`, h('div', { class: 'stack' }, field('When', when), field('Where', where)), 'Save', async () => {
    await send(x, 'schedule', { when: when.value ? new Date(when.value).toISOString() : '', where: where.value });
    reload();
  });
}

function closeDialog(x, o, reload) {
  const outcome = select(Object.entries(o.outcomes), 'Outcome');
  const note = h('textarea', { 'aria-label': 'What the outcome was', placeholder: 'e.g. Potassium 4.0; replacement stopped' });
  const fWhat = h('input', { type: 'text', 'aria-label': 'Further follow-up', placeholder: 'e.g. Repeat memory assessment in 6 months' });
  const fDue = h('input', { type: 'date', 'aria-label': 'Further follow-up by', min: addDays(0) });
  const further = h('div', { class: 'stack' }, field('Further follow-up', fWhat), field('Needed by', fDue));
  further.hidden = true;
  outcome.addEventListener('change', () => { further.hidden = outcome.value !== 'FURTHER'; });
  dialog(`Outcome: ${x.what}`, h('div', { class: 'stack' }, field('Outcome', outcome), field('What the outcome was', note), further), 'Save', async () => {
    await send(x, 'close', { outcome: outcome.value, note: note.value, furtherWhat: fWhat.value, furtherDue: fDue.value });
    reload();
  });
}

const NOTE_ACTIONS = {
  decline: ['Decline', 'Why, and who should do it instead', 'e.g. Community physio is closer to home; ask the GP to refer', 'Decline'],
  complete: ['It happened', 'What happened', 'e.g. Seen in clinic; letter received', 'Save'],
  cancel: ['Cancel', 'Why it is no longer needed', 'e.g. Moving to Christchurch; GP there will follow up', 'Cancel follow-up'],
  error: ['Entered in error', 'Why', 'e.g. Recorded on the wrong person', 'Mark as error'],
};
function noteDialog(x, action, reload) {
  const [title, label, placeholder, button] = NOTE_ACTIONS[action];
  const note = h('textarea', { 'aria-label': label, placeholder });
  dialog(`${title}: ${x.what}`, field(label, note), button, async () => {
    await send(x, action, { note: note.value });
    reload();
  });
}

const LABELS = {
  accept: 'Take responsibility', decline: 'Decline', arrange: 'Arrange', schedule: 'Scheduled', complete: 'It happened', close: 'Record outcome',
  cancel: 'Cancel', error: 'Entered in error',
};
const PRIMARY = ['accept', 'arrange', 'complete', 'close'];

function followupCard(x, d, reload, showPatient = false) {
  const o = d.options;
  const handler = (a) => () => (a === 'accept' ? acceptDialog(x, o, reload) : a === 'arrange' ? arrangeDialog(x, o, reload) : a === 'schedule' ? scheduleDialog(x, reload)
    : a === 'close' ? closeDialog(x, o, reload) : noteDialog(x, a, reload));
  return h('div', { class: `tile stack followup followup-${x.state.toLowerCase()}${x.overdue ? ' followup-overdue' : ''}` },
    showPatient ? h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/followups`) }, h('b', {}, x.patient)),
      x.location ? h('span', { class: 'small muted' }, ` · ${x.location}`) : null) : null,
    h('div', { class: 'spread' }, h('h3', {}, x.what), h('span', { class: `tag ${x.overdue ? 'danger' : TONE[x.state]}` }, x.overdue ? 'Overdue' : x.stateLabel)),
    h('div', { class: 'small' }, h('b', {}, 'Responsible: '), `${x.responsible} · by ${x.dueBy}`),
    x.reason ? h('div', { class: 'small' }, x.reason) : null,
    h('div', { class: 'small muted' }, `Asked for by ${x.madeBy}, ${x.fromRole}, ${x.fromService} · ${fmtDateTime(x.madeAt)}`),
    x.acceptedBy ? h('div', { class: 'small' }, h('b', {}, x.state === 'DECLINED' ? `Declined (${x.acceptedBy}): ` : `Responsibility (${x.acceptedBy}${x.toldLabel ? `, ${x.toldLabel.toLowerCase()}` : ''}): `),
      x.acceptNote ?? 'Taken on.') : null,
    x.linkRef ? h('div', { class: 'small' }, h('b', {}, `${x.linkLabel}: `), x.linkRef) : null,
    x.scheduledFor ? h('div', { class: 'small' }, h('b', {}, 'Booked: '), `${fmtDateTime(x.scheduledFor)} · ${x.scheduledWhere}`) : null,
    x.completedNote ? h('div', { class: 'small' }, h('b', {}, `Happened (${x.completedBy}): `), x.completedNote) : null,
    x.outcomeLabel ? h('div', { class: 'small' }, h('b', {}, `Outcome (${x.closedBy}, ${fmtDateTime(x.closedAt)}): `), [x.outcomeLabel, x.outcomeNote].filter(Boolean).join('. ')) : null,
    x.endedNote ? h('div', { class: 'small' }, h('b', {}, `${x.stateLabel}: `), x.endedNote) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${PRIMARY.includes(a) ? ' primary' : ''}`, onclick: handler(a) },
      a === 'accept' && x.respKind === 'EXTERNAL' ? 'Responsibility confirmed' : LABELS[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// The person's Follow-ups view in the Live Workstation.
export function followupsPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canMake ? h('div', {}, h('button', { class: 'btn primary', onclick: () => makeDialog(personId, d.options, reload) }, 'Follow-up needed')) : null,
    d.open.length ? d.open.map((x) => followupCard(x, d, reload)) : h('div', { class: 'card empty' }, 'No follow-ups.'),
    d.ended.length ? h('details', {}, h('summary', {}, `Closed (${d.ended.length})`), h('div', { class: 'stack' }, d.ended.map((x) => followupCard(x, d, reload)))) : null,
  );
}

// Home → Follow-ups.
export async function followupsView() {
  const d = await get('/api/work/followups');
  const view = { options: { responsibles: [], links: {}, told: {}, outcomes: {} } };
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map((x) => followupCard({ ...x, actions: [] }, view, () => go('/work/followups'), true)) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Follow-ups', () => go('/work/home')),
    h('div', { class: 'banner' }, 'Follow-ups your service asked for or has been asked to do: waiting for someone to take responsibility, to arrange, arranged or booked, and needing an outcome. Open the person to act.'),
    section('Waiting for responsibility', d.toTake, 'Nothing waiting.'),
    section('To arrange', d.toArrange, 'Nothing to arrange.'),
    section('Arranged or booked', d.scheduled, 'Nothing arranged.'),
    section('Needs an outcome', d.outcome, 'Nothing needs an outcome.'),
  );
}

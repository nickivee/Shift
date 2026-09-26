import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, pageTitle, fmtDateTime, titleCase } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';

// Appointment: requested (the waitlist) → offered → booked → confirmed → arrived → started →
// completed, or cancelled / did not attend / unable to complete, each with a follow-up
// decision. Booking an appointment for a referral schedules the referral.
const STEPS = ['REQUESTED', 'OFFERED', 'BOOKED', 'CONFIRMED', 'ARRIVED', 'COMMENCED', 'COMPLETED'];
const LABEL = {
  REQUESTED: 'Waitlist', OFFERED: 'Offered', BOOKED: 'Booked', CONFIRMED: 'Confirmed', ARRIVED: 'Arrived', COMMENCED: 'Started', COMPLETED: 'Completed',
  CANCELLED: 'Cancelled', DID_NOT_ATTEND: 'Did not attend', UNABLE_TO_COMPLETE: 'Not completed',
};
const TONE = { CANCELLED: 'muted', DID_NOT_ATTEND: 'danger', UNABLE_TO_COMPLETE: 'danger', COMPLETED: 'ok', ARRIVED: 'warn', COMMENCED: 'warn' };
const PRIORITY = { URGENT: 'Urgent', SEMI_URGENT: 'Semi-urgent', ROUTINE: 'Routine' };
const MODE = { IN_PERSON: 'In person', PHONE: 'Phone', VIDEO: 'Video' };
const ENDED = ['COMPLETED', 'CANCELLED', 'DID_NOT_ATTEND', 'UNABLE_TO_COMPLETE'];

function steps(a) {
  if (ENDED.includes(a.state) && a.state !== 'COMPLETED') return null;
  const list = STEPS.filter((s) => s !== 'OFFERED' || a.state === 'OFFERED' || a.history.some((x) => x.to_state === 'OFFERED'))
    .filter((s) => s !== 'CONFIRMED' || a.state === 'CONFIRMED' || a.history.some((x) => x.to_state === 'CONFIRMED') || ['REQUESTED', 'OFFERED', 'BOOKED'].includes(a.state));
  const at = list.indexOf(a.state);
  return h('ol', { class: 'steps' }, list.map((s, i) => h('li', { class: i < at || a.state === 'COMPLETED' ? 'done' : i === at ? 'now' : '' }, LABEL[s])));
}

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
        h('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); dlg.remove(); } }, 'Cancel'),
      ),
    ),
  );
  dlg.addEventListener('cancel', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

const select = (options, value) => {
  const s = h('select', {}, Object.entries(options).map(([k, v]) => h('option', { value: k }, v)));
  if (value) s.value = value;
  return s;
};

function slotDialog(a, action, send) {
  const when = h('input', { type: 'datetime-local' });
  if (a.startAt) when.value = a.startAt;
  const duration = select({ 15: '15 minutes', 30: '30 minutes', 45: '45 minutes', 60: '1 hour', 90: '1½ hours' }, String(a.duration ?? 45));
  const mode = select(MODE, a.mode);
  const place = h('input', { type: 'text', placeholder: 'Clinic room, ward bed, or phone number to call' });
  place.value = a.place ?? a.location ?? '';
  const title = { offer: 'Offer a time', book: 'Book a time', reschedule: 'Move the appointment' }[action];
  const hint = { offer: 'The patient still has to accept it.', book: 'Use this when the patient has agreed the time.', reschedule: 'The patient needs to know the new time.' }[action];
  dialog(title, h('div', { class: 'stack' },
    h('p', { class: 'muted' }, hint),
    h('label', { class: 'field' }, 'When', when),
    h('label', { class: 'field' }, 'How long', duration),
    h('label', { class: 'field' }, 'How', mode),
    h('label', { class: 'field' }, 'Where', place),
  ), { offer: 'Offer', book: 'Book', reschedule: 'Move' }[action], () => send({ when: when.value, duration: duration.value, mode: mode.value, place: place.value }));
}

function endDialog(a, action, send) {
  const note = h('textarea', { placeholder: action === 'complete' || action === 'dna' ? 'Optional' : '' });
  const another = h('input', { type: 'checkbox' });
  if (action === 'dna' || action === 'unable') another.checked = true;
  const title = { complete: 'Finish the appointment', unable: 'Could not complete', dna: 'Did not attend', cancel: 'Cancel the appointment' }[action];
  const label = { complete: 'Summary', unable: 'Why', dna: 'What was tried', cancel: 'Reason' }[action];
  dialog(title, h('div', { class: 'stack' },
    h('label', { class: 'field' }, label, note),
    h('label', { class: 'check' }, another, 'Needs another appointment (goes back on the waitlist)'),
  ), { complete: 'Finish', unable: 'Save', dna: 'Save', cancel: 'Cancel appointment' }[action], () => send({ note: note.value, another: another.checked }));
}

const DONE = {
  offer: 'Offer recorded.', book: 'Booked.', reschedule: 'Moved.', accepted: 'Booked.', declined: 'Back on the waitlist.', confirm: 'Confirmed.',
  arrive: 'Arrived.', start: 'Started.', complete: 'Finished.', unable: 'Recorded.', dna: 'Recorded as did not attend.', cancel: 'Cancelled.',
};

function doAction(a, action, reload) {
  const send = async (body = {}) => {
    await post(`/api/work/appointments/${a.id}/${action}`, body);
    toast(DONE[action]);
    reload();
  };
  if (['offer', 'book', 'reschedule'].includes(action)) return slotDialog(a, action, send);
  if (['complete', 'unable', 'dna', 'cancel'].includes(action)) return endDialog(a, action, send);
  if (action === 'declined') {
    const note = h('textarea', {});
    return dialog('Patient declined the offer', h('label', { class: 'field' }, 'What they said', note), 'Back to waitlist', () => send({ note: note.value }));
  }
  send().catch(showError);
}

const ACTION = {
  offer: ['Offer a time', true], book: ['Book', false], accepted: ['Patient accepted', true], declined: ['Patient declined', false],
  confirm: ['Confirm', false], arrive: ['Arrived', true], reschedule: ['Move', false], dna: ['Did not attend', false],
  start: ['Start', true], complete: ['Finish', true], unable: ['Could not complete', false], cancel: ['Cancel', false],
};

export function appointmentCard(a, reload, { showPatient = true } = {}) {
  return h('div', { class: 'tile stack' },
    h('div', { class: 'spread' },
      h('div', {},
        showPatient ? h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${a.personId}/appointments`) }, h('b', {}, a.patient)) : h('b', {}, a.service),
        h('div', { class: 'muted' }, [a.location, a.reason].filter(Boolean).join(' · ')),
      ),
      h('div', { class: 'row' },
        a.priority !== 'ROUTINE' && !ENDED.includes(a.state) ? h('span', { class: 'tag warn' }, PRIORITY[a.priority]) : null,
        h('span', { class: `tag ${TONE[a.state] ?? ''}` }, LABEL[a.state] ?? titleCase(a.state)),
      ),
    ),
    a.startAt ? h('div', {}, h('b', {}, a.state === 'OFFERED' ? 'Offered: ' : 'When: '), `${fmtDateTime(a.startAt)}, ${a.duration} min · ${MODE[a.mode]}${a.place ? ` · ${a.place}` : ''}`) : null,
    a.referredFrom ? h('div', { class: 'small muted' }, `Referral from ${a.referredFrom}`) : null,
    steps(a),
    a.responseNote ? h('div', { class: 'small' }, h('b', {}, 'Patient said: '), a.responseNote) : null,
    a.endNote ? h('div', { class: 'small' }, h('b', {}, `${LABEL[a.state]} (${a.endedBy}): `), a.endNote) : null,
    ENDED.includes(a.state) ? h('div', { class: 'small muted' }, a.followUp === 'ANOTHER' ? 'Another appointment is on the waitlist.' : 'No further appointment needed.') : null,
    h('div', { class: 'small muted' }, [a.clinician ? `With ${a.clinician}` : null, `requested by ${a.requestedBy} ${fmtDateTime(a.requestedAt)}`, a.confirmedBy ? `confirmed by ${a.confirmedBy}` : null].filter(Boolean).join(' · ')),
    a.actions.length ? h('div', { class: 'row' }, a.actions.map((x) =>
      h('button', { class: `btn small${ACTION[x][1] ? ' primary' : ''}`, onclick: () => doAction(a, x, reload) }, ACTION[x][0]))) : null,
  );
}

// The patient's Appointments view inside the Live Workstation.
export function appointmentsPanel(personId, d, reload) {
  const form = () => {
    const reason = h('input', { type: 'text', placeholder: 'What the appointment is for' });
    const priority = select(PRIORITY, 'ROUTINE');
    const mode = select(MODE, 'IN_PERSON');
    return h('form', { class: 'tile stack', onsubmit: async (e) => {
      e.preventDefault();
      try {
        await post(`/api/work/patients/${personId}/appointments`, { reason: reason.value, priority: priority.value, mode: mode.value });
        toast(`On the ${d.service} waitlist.`);
        reload();
      } catch (err) { showError(err); }
    } },
      h('h3', {}, `Add to the ${d.service} waitlist`),
      h('label', { class: 'field' }, 'For', reason),
      h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Priority', priority), h('label', { class: 'field grow' }, 'How', mode)),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Add to waitlist')),
    );
  };
  return h('div', { class: 'stack' },
    d.canRequest ? form() : null,
    d.appointments.length ? d.appointments.map((a) => appointmentCard(a, reload, { showPatient: false }))
      : h('div', { class: 'empty' }, 'No appointments for this patient.'),
  );
}

// Home → Appointments: today's diary, the waitlist, and what is coming up.
export async function appointmentsView() {
  const root = h('div');
  const load = async () => {
    const { today, appointments: rows } = await get('/api/work/appointments');
    const day = (a) => (a.startAt ?? '').slice(0, 10);
    const todays = rows.filter((a) => day(a) === today || (ENDED.includes(a.state) && !a.startAt));
    const waiting = rows.filter((a) => a.state === 'REQUESTED' || (a.state === 'OFFERED' && day(a) !== today));
    const later = rows.filter((a) => a.startAt && day(a) > today && !waiting.includes(a));
    const overdue = rows.filter((a) => a.startAt && day(a) < today && !ENDED.includes(a.state));
    const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, title),
      list.length ? list.map((a) => appointmentCard(a, load)) : h('div', { class: 'card empty' }, empty));
    const rank = { URGENT: 0, SEMI_URGENT: 1, ROUTINE: 2 };
    waiting.sort((x, y) => rank[x.priority] - rank[y.priority] || x.requestedAt.localeCompare(y.requestedAt));
    mount(root,
      workHeader(),
      pageTitle('Appointments', () => go('/work/home')),
      overdue.length ? section('Still open from earlier days', overdue, '') : null,
      section('Today', todays, 'Nothing booked today.'),
      section('Waitlist', waiting, 'No one is waiting for an appointment.'),
      later.length ? section('Coming up', later, '') : null,
    );
  };
  await load();
  return root;
}

import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, ask, pageTitle, fmtDate, fmtDateTime } from '../lib/ui.js';
import { go, state } from '../app.js';
import { workHeader } from './entry.js';

// Interpreters and communication needs: need identified → requirement recorded → interpreter or
// support arranged → booked → provided → outcome → the need reviewed.
const RIGHT = 'Everyone has the right to effective communication, and to a competent interpreter where necessary and reasonably practicable (Code of Rights, Right 5).';
const BOOKING_TONE = { REQUESTED: 'danger', BOOKED: 'warn', PROVIDED: 'ok', NOT_PROVIDED: 'danger', CANCELLED: 'muted' };

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
  if (value !== undefined && value !== null) s.value = value;
  return s;
};

const localInput = (d) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// The fields that describe a need, shared by recording and reviewing.
function needFields(options, n = {}) {
  const f = {
    kind: select({ '': 'Choose…', ...options.kinds }, n.kind ?? ''),
    language: h('input', { type: 'text', value: n.language ?? '', placeholder: 'e.g. Tongan, Samoan, Mandarin' }),
    detail: h('textarea', { placeholder: 'What helps, e.g. "hearing aid in the left ear, face him when speaking"' }),
    whenNeeded: select(options.when, n.whenNeeded ?? 'ALWAYS'),
    reviewDate: h('input', { type: 'date', value: n.reviewDate ?? '' }),
  };
  f.detail.value = n.detail ?? '';
  const languageField = h('label', { class: 'field' }, 'Language', f.language);
  const sync = () => { languageField.hidden = f.kind.value !== 'INTERPRETER'; };
  f.kind.addEventListener('change', sync);
  sync();
  const body = h('div', { class: 'stack' },
    n.kind ? null : h('label', { class: 'field' }, 'Kind of need', f.kind),
    languageField,
    h('label', { class: 'field' }, 'What helps', f.detail),
    h('label', { class: 'field' }, 'When it is needed', f.whenNeeded),
    h('label', { class: 'field' }, 'Review by (optional)', f.reviewDate),
  );
  const values = () => Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
  return { body, values };
}

function bookDialog(n, reload) {
  const purpose = h('input', { type: 'text', placeholder: 'e.g. family meeting about going home' });
  const mode = select(n.options.modes, 'IN_PERSON');
  const soon = new Date(Date.now() + 24 * 3600_000); soon.setMinutes(0, 0, 0);
  const at = h('input', { type: 'datetime-local', value: localInput(soon) });
  dialog(`Book a ${n.label.toLowerCase()}`, h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'What for', purpose),
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'How', mode), h('label', { class: 'field grow' }, 'When', at)),
  ), 'Ask for an interpreter', async () => {
    await post(`/api/work/needs/${n.id}/book`, { purpose: purpose.value, mode: mode.value, neededAt: at.value ? new Date(at.value).toISOString() : '' });
    toast('Asked for. It shows under Interpreters until it is booked.');
    reload();
  });
}

function reviewDialog(n, reload) {
  const f = needFields(n.options, n);
  dialog(`Review: ${n.label}`, f.body, 'Save review', async () => {
    await post(`/api/work/needs/${n.id}/review`, f.values());
    toast('Reviewed.');
    reload();
  });
}

async function needAction(n, action, reload) {
  if (action === 'book') return bookDialog(n, reload);
  if (action === 'review') return reviewDialog(n, reload);
  const note = await ask({ title: `${n.label} no longer needed`, label: 'Why, and who said so', confirm: 'No longer needed', multiline: true, minLength: 3 });
  if (!note) return;
  try {
    await post(`/api/work/needs/${n.id}/end`, { note });
    toast('Recorded. Earlier bookings are kept.');
    reload();
  } catch (err) { showError(err); }
}

const NEED_ACTION = { book: ['Book interpreter', true], review: ['Review', false], end: ['No longer needed', false] };

function needCard(n, reload) {
  const ended = n.state === 'ENDED';
  return h('div', { class: `tile stack need${n.interpreted ? ' need-interpreter' : ''}` },
    h('div', { class: 'spread' },
      h('div', {}, h('b', {}, n.label), n.patient ? h('div', {}, h('button', { class: 'link-btn small', onclick: () => go(`/work/patient/${n.personId}/access`) }, n.patient)) : null),
      h('div', { class: 'row' },
        n.reviewDue ? h('span', { class: 'tag warn' }, 'Review due') : null,
        ended ? h('span', { class: 'tag muted' }, 'No longer needed') : h('span', { class: 'tag' }, n.whenLabel)),
    ),
    h('div', { class: 'small' }, n.detail),
    n.reviewDate && !ended ? h('div', { class: 'small muted' }, `Review by ${fmtDate(n.reviewDate)}`) : null,
    ended ? h('div', { class: 'small' }, h('b', {}, `Ended (${n.endedBy}): `), n.endReason) : null,
    n.changes?.length ? h('details', {}, h('summary', { class: 'small' }, `Changes (${n.changes.length})`), h('ul', { class: 'small stack' }, n.changes.map((c) =>
      h('li', {}, h('b', {}, `${c.actor ?? 'SHIFT'}, ${fmtDateTime(c.at)}: `), c.reason)))) : null,
    h('div', { class: 'small muted' }, [`Recorded by ${n.recordedBy} ${fmtDateTime(n.recordedAt)}`, n.reviewedBy ? `reviewed by ${n.reviewedBy} ${fmtDateTime(n.reviewedAt)}` : null].filter(Boolean).join(' · ')),
    n.actions?.length ? h('div', { class: 'row' }, n.actions.map((x) =>
      h('button', { class: `btn small${NEED_ACTION[x][1] ? ' primary' : ''}`, onclick: () => needAction(n, x, reload) }, NEED_ACTION[x][0]))) : null,
  );
}

function bookedDialog(b, reload) {
  const provider = h('input', { type: 'text', placeholder: 'e.g. Interpreting service name' });
  const reference = h('input', { type: 'text', placeholder: 'Booking reference (optional)' });
  const interpreter = h('input', { type: 'text', placeholder: "Interpreter's name, if known (optional)" });
  dialog(`Booked: ${b.label}`, h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'Service booked', provider),
    h('label', { class: 'field' }, 'Reference', reference),
    h('label', { class: 'field' }, 'Interpreter', interpreter),
  ), 'Save booking', async () => {
    await post(`/api/work/interpreters/${b.id}/booked`, { provider: provider.value, reference: reference.value, interpreter: interpreter.value });
    toast('Booked.');
    reload();
  });
}

function outcomeDialog(b, action, reload) {
  const provided = action === 'provided';
  const outcome = h('textarea', { placeholder: provided ? 'How it went, and whether they understood' : 'What happened instead, and what is next' });
  const family = h('input', { type: 'checkbox' });
  const note = h('p', { class: 'small notice', hidden: true }, 'Write why a professional interpreter was not used.');
  family.addEventListener('change', () => { note.hidden = !family.checked; });
  dialog(provided ? `Provided: ${b.label}` : `Did not happen: ${b.label}`, h('div', { class: 'stack' },
    h('label', { class: 'field' }, provided ? 'Outcome' : 'What happened', outcome),
    provided ? h('label', { class: 'check' }, family, ' Whānau or a friend interpreted instead') : null, note,
  ), 'Save', async () => {
    await post(`/api/work/interpreters/${b.id}/${action}`, { outcome: outcome.value, familyInterpreted: family.checked });
    toast('Recorded.');
    reload();
  });
}

async function bookingAction(b, action, reload) {
  if (action === 'booked') return bookedDialog(b, reload);
  if (action === 'provided' || action === 'notProvided') return outcomeDialog(b, action, reload);
  const note = await ask({ title: `Cancel: ${b.purpose}`, label: 'Why', confirm: 'Cancel booking', multiline: true, minLength: 3 });
  if (!note) return;
  try {
    await post(`/api/work/interpreters/${b.id}/cancel`, { note });
    toast('Cancelled.');
    reload();
  } catch (err) { showError(err); }
}

const BOOKING_ACTION = { booked: ['Booked', true], provided: ['Provided', false], notProvided: ['Did not happen', false], cancel: ['Cancel', false] };

function bookingCard(b, reload, showPatient) {
  return h('div', { class: `tile stack${b.due && b.state === 'REQUESTED' ? ' booking-due' : ''}` },
    h('div', { class: 'spread' },
      h('div', {},
        showPatient ? h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${b.personId}/access`) }, h('b', {}, b.patient)) : h('b', {}, b.label),
        h('div', { class: 'small muted' }, [showPatient ? b.label : null, b.modeLabel, fmtDateTime(b.neededAt), showPatient ? b.location : null].filter(Boolean).join(' · '))),
      h('span', { class: `tag ${BOOKING_TONE[b.state] ?? ''}` }, b.stateLabel),
    ),
    h('div', { class: 'small' }, h('b', {}, 'For: '), b.purpose),
    b.provider ? h('div', { class: 'small' }, h('b', {}, 'Booked with: '), [b.provider, b.reference, b.interpreter].filter(Boolean).join(', ')) : null,
    b.outcome ? h('div', { class: 'small' }, h('b', {}, b.state === 'CANCELLED' ? 'Why cancelled: ' : 'Outcome: '), b.outcome) : null,
    b.familyInterpreted ? h('div', { class: 'small notice' }, 'Whānau interpreted, not a professional interpreter.') : null,
    h('div', { class: 'small muted' }, [`Asked for by ${b.requestedBy} (${b.service}) ${fmtDateTime(b.requestedAt)}`, b.bookedBy ? `booked by ${b.bookedBy}` : null, b.closedBy ? `closed by ${b.closedBy} ${fmtDateTime(b.closedAt)}` : null].filter(Boolean).join(' · ')),
    b.actions.length ? h('div', { class: 'row' }, b.actions.map((x) =>
      h('button', { class: `btn small${BOOKING_ACTION[x][1] ? ' primary' : ''}`, onclick: () => bookingAction(b, x, reload) }, BOOKING_ACTION[x][0]))) : null,
  );
}

function addForm(personId, d, reload) {
  const f = needFields(d.options);
  return h('form', { class: 'tile stack', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await post(`/api/work/patients/${personId}/needs`, f.values());
      toast('Recorded. Every service caring for them will see it.');
      reload();
    } catch (err) { showError(err); }
  } }, h('h3', {}, 'Record a communication need'), f.body, h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Record')));
}

// The person's Communication needs view inside the Live Workstation.
export function accessPanel(personId, d, reload) {
  const subject = state.me.context.subjectLabel.toLowerCase();
  const needs = d.needs.map((n) => ({ ...n, options: d.options }));
  const open = d.bookings.filter((b) => ['REQUESTED', 'BOOKED'].includes(b.state));
  const past = d.bookings.filter((b) => !['REQUESTED', 'BOOKED'].includes(b.state));
  return h('div', { class: 'stack' },
    h('p', { class: 'small muted' }, RIGHT),
    needs.length ? needs.map((n) => needCard(n, reload))
      : h('div', { class: 'empty' }, `No communication needs recorded for this ${subject}. Ask what language they prefer and whether anything makes talking or reading hard.`),
    open.length ? h('section', { class: 'stack' }, h('h3', {}, 'Interpreters'), open.map((b) => bookingCard(b, reload, false))) : null,
    d.canManage ? h('details', {}, h('summary', {}, 'Record a communication need'), addForm(personId, d, reload)) : null,
    past.length ? h('details', {}, h('summary', {}, `Past interpreters (${past.length})`), h('div', { class: 'stack' }, past.map((b) => bookingCard(b, reload, false)))) : null,
    d.ended.length ? h('details', {}, h('summary', {}, `No longer needed (${d.ended.length})`), h('div', { class: 'stack' }, d.ended.map((n) => needCard(n, reload)))) : null,
  );
}

// Home → Interpreters.
export async function interpretersView() {
  const root = h('div');
  const load = async () => {
    const { bookings, needs, options } = await get('/api/work/interpreters');
    const toBook = bookings.filter((b) => b.state === 'REQUESTED');
    const booked = bookings.filter((b) => b.state === 'BOOKED');
    const done = bookings.filter((b) => !['REQUESTED', 'BOOKED'].includes(b.state));
    mount(root,
      workHeader(),
      pageTitle('Interpreters', () => go('/work/home')),
      h('div', { class: 'banner' }, 'Interpreters to book and coming up, and every communication need in this service. ', RIGHT),
      h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `To book (${toBook.length})`),
        toBook.length ? toBook.map((b) => bookingCard(b, load, true)) : h('div', { class: 'card empty' }, 'Nothing waiting to be booked.')),
      h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `Booked (${booked.length})`),
        booked.length ? booked.map((b) => bookingCard(b, load, true)) : h('div', { class: 'card empty' }, 'No interpreters booked.')),
      h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `Communication needs (${needs.length})`),
        needs.length ? needs.map((n) => needCard({ ...n, options }, load)) : h('div', { class: 'card empty' }, 'None recorded.')),
      done.length ? h('details', {}, h('summary', {}, `Closed in the last day (${done.length})`), h('div', { class: 'stack' }, done.map((b) => bookingCard(b, load, true)))) : null,
    );
  };
  await load();
  return root;
}

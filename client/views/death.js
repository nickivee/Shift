import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';

// Death: died or found → verified → certificate or coroner → who was told → donation → wishes → released → stay ended.
const TONE = { IDENTIFIED: 'danger', VERIFIED: 'warn', CLOSED: 'muted', ENTERED_IN_ERROR: 'muted' };

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

const select = (entries, label) => h('select', { 'aria-label': label }, h('option', { value: '' }, 'Choose…'), entries.map(([k, v]) => h('option', { value: k }, v)));
const localInput = (d) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const iso = (v) => (v ? new Date(v).toISOString() : '');

function identifyDialog(personId, o, reload) {
  const when = h('input', { type: 'datetime-local', value: localInput(new Date()), 'aria-label': 'When' });
  const expected = select(Object.entries(o.expected), 'Expected');
  const place = h('input', { type: 'text', placeholder: 'e.g. In her room, Room 3' });
  const circumstances = h('textarea', { 'aria-label': 'What happened', placeholder: 'e.g. Found not breathing at the 03:00 check. Comfortable and settled at 01:00. Daughter was with her in the evening.' });
  dialog('They have died', h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'When they died, or were found', when), h('label', { class: 'field' }, 'Expected?', expected)),
    h('label', { class: 'field' }, 'Where', place),
    h('label', { class: 'field' }, 'What happened', circumstances),
    h('p', { class: 'small muted' }, 'A nurse or doctor then verifies the death.'),
  ), 'Record', async () => {
    await post(`/api/work/patients/${personId}/death`, { diedAt: iso(when.value), expected: expected.value, place: place.value, circumstances: circumstances.value });
    toast('Recorded.');
    reload();
  });
}

function verifyDialog(ev, reload) {
  const when = h('input', { type: 'datetime-local', value: localInput(new Date()), 'aria-label': 'When verified' });
  const note = h('textarea', { 'aria-label': 'What you checked', placeholder: 'e.g. No pulse or breath sounds for one minute, no heart sounds, pupils fixed and dilated, no response to pain' });
  dialog('Verify their death', h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'When you verified it', when),
    h('label', { class: 'field' }, 'What you checked and found', note),
    h('p', { class: 'small muted' }, 'Who may verify a death, and what must be checked, is still being researched for New Zealand. This organisation lets its nurses and doctors record it.'),
  ), 'Verify', async () => {
    await post(`/api/work/deaths/${ev.id}/verify`, { at: iso(when.value), note: note.value });
    reload();
  });
}

function certifyDialog(ev, o, reload) {
  const kind = select(Object.entries(o.cert), 'Certificate or coroner');
  const by = h('input', { type: 'text', 'aria-label': 'By whom', placeholder: 'e.g. Dr Hannah Li' });
  const ref = h('input', { type: 'text', 'aria-label': 'Reference', placeholder: 'Reference or case number, if there is one' });
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Optional' });
  dialog('Certificate or coroner', h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'What was done', kind),
    h('label', { class: 'field' }, 'By whom', by),
    h('label', { class: 'field' }, 'Reference', ref),
    h('label', { class: 'field' }, 'Note', note),
    h('p', { class: 'small muted' }, 'SHIFT holds a reference only. It does not issue the certificate or decide whether a death goes to the coroner.'),
  ), 'Save', async () => {
    await post(`/api/work/deaths/${ev.id}/certify`, { kind: kind.value, by: by.value, ref: ref.value, note: note.value });
    reload();
  });
}

function notifyDialog(ev, o, reload) {
  const kind = select(o.notify.map((n) => [n.id, n.label]), 'Who');
  const name = h('input', { type: 'text', 'aria-label': 'Name', placeholder: 'e.g. Mere Hēnare (daughter)' });
  const note = h('textarea', { 'aria-label': 'How', placeholder: 'e.g. Phoned at 03:40, she is coming in' });
  dialog('Who has been told', h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'Who', kind), h('label', { class: 'field' }, 'Name', name), h('label', { class: 'field' }, 'How and when', note),
  ), 'Save', async () => {
    await post(`/api/work/deaths/${ev.id}/notify`, { kind: kind.value, name: name.value, note: note.value });
    reload();
  });
}

function donationDialog(ev, o, reload) {
  const donation = select(Object.entries(o.donation), 'Donation');
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'e.g. Discussed with her son; not going ahead' });
  dialog('Organ and tissue donation', h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'What was decided', donation), h('label', { class: 'field' }, 'Note', note),
  ), 'Save', async () => {
    await post(`/api/work/deaths/${ev.id}/donation`, { donation: donation.value, note: note.value });
    reload();
  });
}

function wishesDialog(ev, reload) {
  const note = h('textarea', { 'aria-label': 'Wishes', placeholder: 'e.g. Whānau to stay with her overnight; karakia before she leaves; window opened' });
  if (ev.wishes) note.value = ev.wishes;
  dialog('Their wishes and whānau wishes', h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'Cultural, spiritual and whānau wishes', note),
  ), 'Save', async () => {
    await post(`/api/work/deaths/${ev.id}/wishes`, { note: note.value });
    reload();
  });
}

function releaseDialog(ev, o, reload) {
  const to = select(Object.entries(o.release), 'Released to');
  const name = h('input', { type: 'text', 'aria-label': 'Collected by', placeholder: 'e.g. Hope Funeral Services, J. Smith' });
  const when = h('input', { type: 'datetime-local', value: localInput(new Date()), 'aria-label': 'When they left' });
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'e.g. Wedding ring left on, as whānau asked; property list signed' });
  dialog('Released', h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Released to', to), h('label', { class: 'field' }, 'When they left', when)),
    h('label', { class: 'field' }, 'Collected by', name), h('label', { class: 'field' }, 'Property and anything else', note),
  ), 'Save', async () => {
    await post(`/api/work/deaths/${ev.id}/release`, { to: to.value, name: name.value, at: iso(when.value), note: note.value });
    reload();
  });
}

function closeDialog(ev, reload) {
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'Optional' });
  dialog('End their stay', h('div', { class: 'stack' },
    h('p', {}, 'This frees their bed and ends their allocation, care team and anything still open about getting worse.'),
    h('label', { class: 'field' }, 'Note', note),
  ), 'End their stay', async () => {
    await post(`/api/work/deaths/${ev.id}/close`, { note: note.value });
    toast('Their stay has ended.');
    reload();
  });
}

function errorDialog(ev, reload) {
  const note = h('textarea', { 'aria-label': 'Why', placeholder: 'e.g. Recorded on the wrong person' });
  dialog('Entered in error', h('label', { class: 'field' }, 'Why', note), 'Mark as error', async () => {
    await post(`/api/work/deaths/${ev.id}/error`, { note: note.value });
    reload();
  });
}

const LABELS = { verify: 'Verify', certify: 'Certificate or coroner', notify: 'Record who was told', donation: 'Donation', wishes: 'Wishes', release: 'Released', close: 'End their stay', error: 'Entered in error' };

function facts(ev) {
  return h('dl', { class: 'death-facts' }, [
    ['Died', `${fmtDateTime(ev.diedAt)}${ev.place ? `, ${ev.place}` : ''} · ${ev.expectedLabel}`],
    ['Verified', ev.verifiedAt ? `${ev.verifiedBy}, ${fmtDateTime(ev.verifiedAt)}` : 'Not yet'],
    ['Certificate', ev.certLabel ? `${ev.certLabel}: ${ev.certBy}${ev.certRef ? ` (${ev.certRef})` : ''}` : 'Not yet recorded'],
    ['Told', ev.notifications.length ? ev.notifications.map((n) => `${n.kindLabel}: ${n.name}`).join(' · ') : 'No one recorded yet'],
    ['Donation', ev.donationLabel ?? 'Not yet recorded'],
    ev.wishes ? ['Wishes', ev.wishes] : null,
    ['Released', ev.releasedAt ? `${ev.releasedToLabel}: ${ev.releasedName}, ${fmtDateTime(ev.releasedAt)}` : 'Not yet'],
  ].filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}

function card(ev, o, reload) {
  const handlers = {
    verify: () => verifyDialog(ev, reload), certify: () => certifyDialog(ev, o, reload), notify: () => notifyDialog(ev, o, reload),
    donation: () => donationDialog(ev, o, reload), wishes: () => wishesDialog(ev, reload), release: () => releaseDialog(ev, o, reload),
    close: () => closeDialog(ev, reload), error: () => errorDialog(ev, reload),
  };
  const primary = ev.state === 'IDENTIFIED' ? 'verify' : 'close';
  return h('div', { class: `tile stack death-event death-${ev.state.toLowerCase()}` },
    h('div', { class: 'spread' }, h('h3', {}, ev.state === 'ENTERED_IN_ERROR' ? 'Entered in error' : 'Died'),
      h('span', { class: `tag ${TONE[ev.state]}` }, ev.stateLabel)),
    h('div', { class: 'small muted' }, `Recorded by ${ev.identifiedBy} ${fmtDateTime(ev.identifiedAt)}`),
    h('p', {}, ev.circumstances),
    facts(ev),
    ev.outstanding.length ? h('div', { class: 'notice small' }, h('b', {}, 'Still to do: '), ev.outstanding.join(' · ')) : null,
    ev.state === 'CLOSED' ? h('div', { class: 'small muted' }, `Stay ended by ${ev.closedBy} ${fmtDateTime(ev.closedAt)}`) : null,
    ev.state === 'ENTERED_IN_ERROR' ? h('div', { class: 'small muted' }, ev.errorReason) : null,
    ev.can.length ? h('div', { class: 'row' }, ev.can.map((a) => h('button', {
      class: `btn small${a === primary ? ' primary' : ''}`, onclick: handlers[a],
    }, LABELS[a]))) : null,
    h('details', {}, h('summary', {}, `What happened, step by step (${ev.steps.length})`),
      h('ol', { class: 'det-steps' }, ev.steps.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// The person's Death view in the Live Workstation.
export function deathPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.event ? card(d.event, d.options, reload) : h('div', { class: 'card empty' }, 'No death recorded.'),
    d.canRecord ? h('div', {}, h('button', { class: 'btn', onclick: () => identifyDialog(personId, d.options, reload) }, 'They have died')) : null,
    d.errors.length ? h('details', {}, h('summary', {}, `Entered in error (${d.errors.length})`), h('div', { class: 'stack' }, d.errors.map((ev) => card(ev, d.options, reload)))) : null,
  );
}

function row(ev) {
  const name = h('b', {}, ev.patient);
  return h('div', { class: `tile stack death-${ev.state.toLowerCase()}` },
    h('div', { class: 'spread' },
      h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${ev.personId}/death`) }, name),
        ev.location ? h('span', { class: 'small muted' }, ` · ${ev.location}`) : null),
      h('span', { class: `tag ${TONE[ev.state]}` }, ev.stateLabel)),
    h('div', { class: 'small' }, `Died ${fmtDateTime(ev.diedAt)} · ${ev.expectedLabel}`),
    ev.outstanding.length ? h('div', { class: 'small muted' }, `Still to do: ${ev.outstanding.join(' · ')}`)
      : h('div', { class: 'small muted' }, ev.state === 'CLOSED' ? `Stay ended ${fmtDateTime(ev.closedAt)}` : 'Ready to end their stay'),
  );
}

// Home → Deaths.
export async function deathsView() {
  const root = h('div');
  const d = await get('/api/work/deaths');
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map(row) : h('div', { class: 'card empty' }, empty));
  mount(root,
    workHeader(),
    pageTitle('Deaths', () => go('/work/home')),
    h('div', { class: 'banner' }, 'People who have died in your service, from verification until their stay is ended.'),
    section('Still open', d.open, 'None.'),
    section('Stay ended in the last 30 days', d.closed, 'None.'),
  );
  return root;
}

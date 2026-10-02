import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, ask, confirmDialog, pageTitle, fmtDateTime, titleCase } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { expectedDischarges } from './discharges.js';

// Admission and transfer of care. Each step is its own act by the person who holds it:
// the receiving team accepts, a bed is allocated, arrival is confirmed, and only then does
// the receiving clinician take responsibility.
const STEPS = ['REQUESTED', 'ACCEPTED', 'BED_ALLOCATED', 'ARRIVED', 'RESPONSIBILITY_ACCEPTED'];
const STEP_LABEL = { REQUESTED: 'Requested', ACCEPTED: 'Accepted', BED_ALLOCATED: 'Bed allocated', ARRIVED: 'Arrived', RESPONSIBILITY_ACCEPTED: 'Responsibility accepted' };
const TONE = { REQUESTED: 'warn', ACCEPTED: '', BED_ALLOCATED: '', ARRIVED: 'warn', RESPONSIBILITY_ACCEPTED: 'ok', DECLINED: 'danger', CANCELLED: 'muted' };

export const transferTag = (state) => h('span', { class: `tag ${TONE[state] ?? ''}` }, STEP_LABEL[state] ?? titleCase(state));

function steps(t) {
  if (t.state === 'DECLINED' || t.state === 'CANCELLED') return null;
  const at = STEPS.indexOf(t.state);
  return h('ol', { class: 'steps' }, STEPS.map((s, i) => h('li', { class: i < at ? 'done' : i === at ? 'now' : '' }, STEP_LABEL[s])));
}

async function doAction(t, action, reload) {
  let body = {};
  if (action === 'decline' || action === 'cancel') {
    const note = await ask({
      title: action === 'decline' ? 'Decline this request' : 'Cancel this transfer',
      message: action === 'decline' ? `${t.fromService} will see your reason.` : `${t.toService} will see your reason.`,
      label: 'Reason', multiline: true, minLength: 5, confirm: action === 'decline' ? 'Decline' : 'Cancel transfer',
    });
    if (!note) return;
    body = { note };
  } else if (action === 'nobed') {
    const ok = await new Promise((resolve) => {
      const tried = h('textarea', { 'aria-label': 'What you tried', placeholder: 'e.g. Checked every Ward K bed; two being cleaned; asked the ward to review discharges' });
      const told = h('input', { 'aria-label': 'Who you told', placeholder: 'e.g. Duty nurse manager, 3.15pm' });
      const warn = h('p', { class: 'small warn-text', hidden: true }, 'Write what you tried and who you told.');
      const dlg = h('dialog', {}, h('h2', {}, `No bed for ${t.patient}`),
        h('label', { class: 'field' }, 'What you tried', tried), h('label', { class: 'field' }, 'Who you told', told), warn,
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => { if (tried.value.trim().length < 5 || told.value.trim().length < 3) { warn.hidden = false; return; } body = { tried: tried.value, told: told.value }; dlg.close(); dlg.remove(); resolve(true); } }, 'Save'),
          h('button', { class: 'btn', onclick: () => { dlg.close(); dlg.remove(); resolve(false); } }, 'Cancel')));
      dlg.addEventListener('cancel', () => { dlg.remove(); resolve(false); });
      document.body.append(dlg); dlg.showModal();
    });
    if (!ok) return;
  } else if (action === 'bed') {
    let beds;
    try { beds = await get(`/api/work/transfers/${t.id}/beds`); } catch (err) { showError(err); return; }
    const bedId = await pickBed(beds, t);
    if (!bedId) return;
    body = { bedId };
  } else {
    const text = {
      accept: [`Accept ${t.patient}`, `${t.toService} agrees to take ${t.patient}. A bed is allocated as a separate step.`, 'Accept'],
      arrive: [`${t.patient} has arrived`, `Confirms ${t.patient} is physically in ${t.bed}. ${t.fromService} stays responsible until a clinician here accepts responsibility.`, 'Confirm arrival'],
      responsibility: ['Take responsibility', `${t.toService} becomes responsible for ${t.patient}. The ${t.fromService} episode ends.`, 'Take responsibility'],
    }[action];
    if (!(await confirmDialog(...text))) return;
  }
  try {
    await post(`/api/work/transfers/${t.id}/${action}`, body);
    toast({ accept: 'Accepted.', decline: 'Declined.', bed: 'Bed allocated.', arrive: 'Arrival recorded.', nobed: 'Saved.', responsibility: 'Responsibility accepted.', cancel: 'Transfer cancelled.' }[action]);
    reload();
  } catch (err) { showError(err); }
}

function pickBed(beds, t) {
  return new Promise((resolve) => {
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    const dlg = h('dialog', {},
      h('h2', {}, `Bed for ${t.patient}`),
      beds.length
        ? h('div', { class: 'bed-pick' }, beds.map((b) => h('button', { class: 'btn', onclick: () => done(b.id) }, b.label)))
        : h('p', { class: 'muted' }, `No available beds in ${t.toService}. Beds being cleaned become available once marked clean.`),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => done(null) }, 'Cancel')),
    );
    dlg.addEventListener('cancel', () => { dlg.remove(); resolve(null); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

const ACTION_LABEL = { accept: 'Accept', decline: 'Decline', bed: 'Allocate bed', arrive: 'Confirm arrival', nobed: 'No bed found', responsibility: 'Take responsibility', cancel: 'Cancel transfer' };
const PRIMARY = new Set(['accept', 'arrive', 'responsibility']);

export function transferCard(t, reload, { showPatient = true } = {}) {
  const bedLabel = t.bed ? (t.state === 'BED_ALLOCATED' ? `Bed ${t.bed.replace(/^.*Bed /, '')} reserved` : t.bed) : null;
  return h('div', { class: 'tile stack' },
    h('div', { class: 'spread' },
      h('div', {},
        !showPatient ? null
          : t.incoming === null ? h('b', {}, t.patient)
          : h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${t.personId}/transfers`) }, h('b', {}, t.patient)),
        h('div', { class: showPatient ? 'muted' : '' }, h('b', {}, `${t.fromService} → ${t.toService}`), t.fromLocation ? ` · from ${t.fromLocation}` : ''),
      ),
      h('div', { class: 'row' }, t.priority === 'URGENT' ? h('span', { class: 'tag danger' }, 'Urgent') : null, transferTag(t.state)),
    ),
    h('div', {}, t.reason),
    steps(t),
    h('div', { class: 'small muted' }, [
      `${t.kind === 'ADMISSION' ? 'Admission' : 'Transfer'} requested by ${t.requestedBy}, ${fmtDateTime(t.requestedAt)}`,
      t.acceptedBy ? `accepted by ${t.acceptedBy}` : null,
      bedLabel,
      t.responsibleBy ? `responsible: ${t.responsibleBy}` : null,
    ].filter(Boolean).join(' · ')),
    t.note ? h('div', { class: 'small' }, h('b', {}, 'Note: '), t.note) : null,
    t.escalations?.length ? h('div', { class: 'stack no-bed' }, h('b', { class: 'small warn-text' }, 'No bed found yet'),
      t.escalations.map((e) => h('div', { class: 'small' }, h('b', {}, 'Tried: '), e.tried, h('b', {}, ' Told: '), e.told, h('span', { class: 'muted' }, ` (${e.by}, ${fmtDateTime(e.at)})`)))) : null,
    t.actions.length ? h('div', { class: 'row' }, t.actions.map((a) =>
      h('button', { class: `btn small${PRIMARY.has(a) ? ' primary' : ''}`, onclick: () => doAction(t, a, reload) }, ACTION_LABEL[a]))) : null,
  );
}

// The patient's own Admission/Transfer view inside the Live Workstation.
export function transfersPanel(personId, d, reload) {
  const form = () => {
    const to = h('select', {}, d.services.map((s) => h('option', { value: s.id }, s.name)));
    const reason = h('textarea', { placeholder: 'Why this patient needs to be admitted or transferred' });
    const urgent = h('input', { type: 'checkbox' });
    return h('form', { class: 'tile stack', onsubmit: async (e) => {
      e.preventDefault();
      try {
        await post(`/api/work/patients/${personId}/transfers`, { toServiceId: to.value, reason: reason.value, priority: urgent.checked ? 'URGENT' : 'ROUTINE' });
        toast('Request sent. The receiving team decides whether to accept.');
        reload();
      } catch (err) { showError(err); }
    } },
      h('h3', {}, 'Request admission or transfer'),
      h('label', { class: 'field' }, 'To', to),
      h('label', { class: 'field' }, 'Reason', reason),
      h('label', { class: 'check' }, urgent, 'Urgent'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Send request')),
    );
  };
  return h('div', { class: 'stack' },
    d.canRequest && d.services.length ? form() : null,
    d.transfers.length ? d.transfers.map((t) => transferCard(t, reload, { showPatient: false }))
      : h('div', { class: 'empty' }, 'No admission or transfer for this patient.'),
  );
}

// Home → Transfers: requests coming in to this service and going out from it.
export async function transfersView() {
  const root = h('div');
  const load = async () => {
    const rows = await get('/api/work/transfers');
    const incoming = rows.filter((t) => t.incoming);
    const outgoing = rows.filter((t) => t.incoming === false);
    mount(root,
      workHeader(),
      pageTitle('Transfers', () => go('/work/home')),
      h('div', { class: 'banner' }, 'Admission and transfer of care. Accepting a patient, allocating a bed, arrival and taking responsibility are separate steps, each recorded by the person who does it.'),
      ...(rows.some((t) => t.incoming === null)
        ? [section('Across the hospital', rows, load, '')]
        : [section('Coming to us', incoming, load, 'Nothing is waiting to come to this service.'),
          section('Leaving us', outgoing, load, 'No admissions or transfers out of this service.')]),
    );
  };
  await load();
  return root;
}

function section(title, rows, reload, empty) {
  return h('section', { class: 'stack' },
    h('h2', { class: 'section-title paua' }, title),
    rows.length ? rows.map((t) => transferCard(t, reload)) : h('div', { class: 'card empty' }, empty || 'No admissions or transfers in progress.'),
  );
}

// Home → Flow board: beds by service, with admissions still waiting for one.
export async function flowView() {
  const root = h('div');
  const load = async () => {
    const [beds, transfers, discharges] = await Promise.all([get('/api/work/beds'), get('/api/work/transfers'), get('/api/work/discharges')]);
    const services = [...new Set(beds.map((b) => b.service))];
    const waiting = transfers.filter((t) => ['REQUESTED', 'ACCEPTED'].includes(t.state));
    const count = (s) => beds.filter((b) => b.state === s).length;
    mount(root,
      workHeader(),
      pageTitle('Flow board', () => go('/work/home')),
      h('div', { class: 'flow-sum' },
        [['AVAILABLE', 'Available'], ['CLEANING', 'Being cleaned'], ['RESERVED', 'Reserved'], ['OCCUPIED', 'Occupied']].map(([s, l]) =>
          h('div', { class: `sum bed-${s.toLowerCase()}` }, h('b', {}, String(count(s))), h('span', {}, l))),
        h('div', { class: 'sum' }, h('b', {}, String(waiting.length)), h('span', {}, 'Waiting for a bed')),
      ),
      waiting.length ? h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, 'Waiting for a bed'), waiting.map((t) => transferCard(t, load))) : null,
      expectedDischarges(discharges),
      services.length ? services.map((s) => h('section', { class: 'stack' },
        h('h2', { class: 'section-title paua' }, s),
        h('div', { class: 'beds' }, beds.filter((b) => b.service === s).map((b) => bedTile(b, load))),
      )) : h('div', { class: 'card empty' }, 'No beds are set up yet.'),
    );
  };
  await load();
  return root;
}

function bedTile(b, reload) {
  const set = async (state) => {
    try { await post(`/api/work/beds/${b.id}/state`, { state }); toast(state === 'AVAILABLE' ? `${b.label} is available.` : `${b.label} marked for cleaning.`); reload(); } catch (err) { showError(err); }
  };
  return h('div', { class: `bed bed-${b.state.toLowerCase()}` },
    h('b', {}, b.label.replace(/^.*(Bed \d+)$/, '$1')),
    h('span', { class: 'small' }, titleCase(b.state)),
    b.patient ? h('span', { class: 'small' }, b.patient) : null,
    b.state === 'CLEANING' ? h('button', { class: 'btn small', onclick: () => set('AVAILABLE') }, 'Mark clean') : null,
  );
}

import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, pageTitle, fmtDate, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog } from '../lib/forms.js';

// Clinical equipment: on the register → available → set up for a patient after a check →
// in use → finished with, or a fault takes it out of use → repair → back in service → retired.
// Aids such as frames and crutches can also be lent to take home → returned → cleaned before reuse.
const TONE = { AVAILABLE: 'ok', IN_USE: 'warn', ON_LOAN: 'warn', CLEANING: 'warn', QUARANTINED: 'danger', IN_REPAIR: 'muted', RETIRED: 'muted' };
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };

const ACTION = {
  end: { label: 'Finished with', title: 'Finished with', field: 'Note (optional)', placeholder: 'Cleaned and returned', done: 'Returned to available.' },
  fault: { label: 'Report fault', title: 'Report a fault', field: 'What went wrong', placeholder: 'What happened, and any alarm or error shown', done: 'Taken out of use. Label it "do not use".' },
  repair: { label: 'Send for repair', title: 'Send for repair', field: 'Where and job number', placeholder: 'Who collected it and the job number', done: 'Sent for repair.' },
  clear: { label: 'No fault found', title: 'Back into use: no fault found', field: 'Who checked it', placeholder: 'Who checked it and what they found', done: 'Back in use.' },
  return: { label: 'Back from repair', title: 'Back from repair', field: 'What was repaired', placeholder: 'What was done', done: 'Back in service.', date: 'Next service due' },
  service: { label: 'Record service', title: 'Record a service', field: 'Who serviced it', placeholder: 'Who serviced it', done: 'Service recorded.', date: 'Next service due' },
  retire: { label: 'Retire', title: 'Retire from use', field: 'Why', placeholder: 'Why it is being retired', done: 'Retired.' },
  back: { label: 'Returned', title: 'Returned from loan', field: 'Note', placeholder: 'Needed if damaged or parts are missing: what is wrong', done: 'Recorded. Clean it before anyone else has it.', condition: true },
  cleaned: { label: 'Cleaned', title: 'Cleaned and checked', field: 'How it was cleaned and checked', placeholder: 'e.g. Detergent wipe then disinfectant; ferrules and brakes checked', done: 'Available again.' },
  lost: { label: 'Not coming back', title: 'Not coming back', field: 'What was tried', placeholder: 'e.g. Phoned twice and wrote; family say it was thrown out', done: 'Written off.' },
};

function actionDialog(q, action, reload) {
  const a = ACTION[action];
  const note = h('textarea', { placeholder: a.placeholder });
  const due = h('input', { type: 'date', value: inDays(365) });
  const affected = h('input', { type: 'checkbox' });
  const condition = h('select', { 'aria-label': 'Condition' }, h('option', { value: '' }, 'Choose…'), Object.entries(q.conditionOptions ?? {}).map(([k, t]) => h('option', { value: k }, t)));
  dialog(`${a.title}: ${q.assetTag}`, h('div', { class: 'stack' },
    h('p', { class: 'muted' }, `${q.kindLabel}, ${q.description}${q.use ? ` · with ${q.use.patient}` : ''}`),
    h('label', { class: 'field' }, a.field, note),
    action === 'fault' && q.use ? h('label', { class: 'check' }, affected, ' The patient was affected') : null,
    action === 'fault' && q.use ? h('p', { class: 'small muted' }, 'Taking it out of use also ends its use with the patient. Set up another one for them now.') : null,
    a.condition ? h('label', { class: 'field' }, 'Condition', condition) : null,
    a.date ? h('label', { class: 'field' }, a.date, due) : null,
  ), a.label, async () => {
    await post(`/api/work/equipment/${q.id}/${action}`, { note: note.value, patientAffected: affected.checked, serviceDue: due.value, condition: condition.value });
    toast(action === 'fault' && affected.checked ? 'Taken out of use. Tell the person in charge; the patient was affected.' : a.done);
    reload();
  });
}

function loanSummary(l, showPatient) {
  return h('div', { class: 'summary' },
    showPatient ? h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${l.personId}/equipment`) }, h('b', {}, l.patient)) : null,
    h('div', {}, h('b', {}, 'For: '), l.purpose),
    h('div', { class: 'small' }, `Lent by ${l.lentBy} ${fmtDateTime(l.lentAt)}: ${l.fitted}`),
    l.returnedAt ? h('div', { class: 'small' }, `${l.conditionLabel}, ${l.returnedBy} ${fmtDateTime(l.returnedAt)}${l.returnNote ? `: ${l.returnNote}` : ''}`)
      : h('div', { class: `small${l.overdue ? ' warn-text' : ''}` }, l.returnBy ? `Due back ${fmtDate(l.returnBy)}${l.overdue ? ' (overdue)' : ''}` : 'No return date'),
  );
}

export function equipmentCard(q, reload, { showPatient = true } = {}) {
  return h('div', { class: `tile stack${q.state === 'QUARANTINED' ? ' alert-raised' : ''}` },
    h('div', { class: 'spread' },
      h('div', {}, h('b', {}, `${q.assetTag} · ${q.kindLabel}`), h('div', { class: 'muted small' }, q.description)),
      h('div', { class: 'row' },
        q.serviceOverdue && q.state !== 'RETIRED' ? h('span', { class: 'tag danger' }, 'Service overdue') : q.serviceSoon && q.state !== 'RETIRED' ? h('span', { class: 'tag warn' }, 'Service due soon') : null,
        q.loan?.overdue && q.state === 'ON_LOAN' ? h('span', { class: 'tag danger' }, 'Overdue back') : null,
        h('span', { class: `tag ${TONE[q.state] ?? ''}` }, q.stateLabel),
      ),
    ),
    q.use ? h('div', { class: 'summary' },
      showPatient ? h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${q.use.personId}/equipment`) }, h('b', {}, q.use.patient)) : null,
      showPatient && q.use.location ? ` · ${q.use.location}` : '',
      h('div', {}, h('b', {}, 'For: '), q.use.purpose),
      q.use.settings ? h('div', {}, h('b', {}, 'Setup: '), q.use.settings) : null,
      h('div', { class: 'small' }, `Checked by ${q.use.startedBy} ${fmtDateTime(q.use.startedAt)}: ${q.use.checkedNote}`),
    ) : null,
    q.loan ? loanSummary(q.loan, showPatient) : null,
    q.events.length && ['QUARANTINED', 'IN_REPAIR'].includes(q.state) ? h('div', { class: 'small' }, h('b', {}, `${q.events[0].kindLabel} (${q.events[0].by}, ${fmtDateTime(q.events[0].at)}): `), q.events[0].note) : null,
    q.events.length ? h('details', {}, h('summary', {}, 'History'),
      h('ul', { class: 'small stack' }, q.events.map((v) => h('li', {}, h('b', {}, `${fmtDateTime(v.at)}, ${v.kindLabel} (${v.by}): `), v.note, v.patientAffected ? ' Patient affected.' : ''))))
      : null,
    h('div', { class: 'small muted' }, [q.service, q.serviceDue ? `service due ${fmtDate(q.serviceDue)}` : 'no service date'].join(' · ')),
    q.actions.length ? h('div', { class: 'row' }, q.actions.map((x) =>
      h('button', { class: `btn small${x === 'fault' ? ' danger' : x === 'end' ? ' primary' : ''}`, onclick: () => actionDialog(q, x, reload) }, ACTION[x].label))) : null,
  );
}

// The patient's Equipment view inside the Live Workstation.
export function equipmentPanel(personId, d, reload) {
  const form = () => {
    const pick = h('select', {}, d.available.map((a) => h('option', { value: a.id }, `${a.assetTag} · ${a.kindLabel}${a.serviceOverdue ? ' (service overdue)' : ''}`)));
    const purpose = h('input', { type: 'text', placeholder: 'What it is for' });
    const settings = h('input', { type: 'text', placeholder: 'Optional: settings, in your words' });
    const checked = h('input', { type: 'text', placeholder: 'e.g. tag in date, self-test passed, alarms on' });
    return h('form', { class: 'tile stack', onsubmit: async (e) => {
      e.preventDefault();
      try {
        await post(`/api/work/patients/${personId}/equipment`, { equipmentId: pick.value, purpose: purpose.value, settings: settings.value, checked: checked.value });
        toast('Set up and recorded.');
        reload();
      } catch (err) { showError(err); }
    } },
      h('h3', {}, 'Set up equipment'),
      h('label', { class: 'field' }, 'Equipment', pick),
      h('label', { class: 'field' }, 'For', purpose),
      h('label', { class: 'field' }, 'Setup', settings),
      h('label', { class: 'field' }, 'Check before use', checked),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Set up')),
    );
  };
  const lendForm = () => {
    const pick = h('select', { 'aria-label': 'Aid' }, d.lendable.map((a) => h('option', { value: a.id }, `${a.assetTag} · ${a.kindLabel}, ${a.description}${a.serviceOverdue ? ' (service overdue)' : ''}`)));
    const purpose = h('input', { type: 'text', 'aria-label': 'For at home', placeholder: 'e.g. Walking indoors until her knee settles' });
    const fitted = h('input', { type: 'text', 'aria-label': 'Fitted and shown', placeholder: 'e.g. Height set to wrist crease; practised stairs with her daughter' });
    const back = h('input', { type: 'date', 'aria-label': 'Due back', value: inDays(42) });
    return h('form', { class: 'tile stack', onsubmit: async (e) => {
      e.preventDefault();
      try {
        await post(`/api/work/patients/${personId}/loans`, { equipmentId: pick.value, purpose: purpose.value, fitted: fitted.value, returnBy: back.value });
        toast('Lent. Give them the return details.');
        reload();
      } catch (err) { showError(err); }
    } },
      h('h3', {}, 'Lend for home'),
      h('label', { class: 'field' }, 'Aid', pick),
      h('label', { class: 'field' }, 'For at home', purpose),
      h('label', { class: 'field' }, 'Fitted and shown', fitted),
      h('label', { class: 'field' }, 'Due back', back),
      h('p', { class: 'small muted' }, 'Funding and how long a loan can run are set nationally (RR-LOAN-001), not in SHIFT.'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Lend')),
    );
  };
  return h('div', { class: 'stack' },
    d.loans.length || d.canLend ? h('section', { class: 'stack' }, h('h3', {}, 'Lent for home'),
      d.loans.length ? d.loans.map((l) => equipmentCard(l.equipment, reload, { showPatient: false })) : h('div', { class: 'small muted' }, 'Nothing lent to take home.'),
      d.canLend && d.lendable.length ? lendForm() : d.canLend ? h('div', { class: 'small muted' }, 'No aids are available to lend.') : null,
      d.loansPast.length ? h('details', {}, h('summary', {}, `Lent before (${d.loansPast.length})`),
        h('ul', { class: 'small stack' }, d.loansPast.map((l) => h('li', {}, h('b', {}, `${l.equipment?.assetTag ?? ''}: `), `${l.purpose}. Lent ${fmtDate(l.lentAt)}, ${l.conditionLabel?.toLowerCase() ?? 'returned'} ${fmtDate(l.returnedAt)}.`)))) : null) : null,
    d.equipment.length ? d.equipment.map((q) => equipmentCard(q, reload, { showPatient: false })) : h('div', { class: 'empty' }, 'No equipment in use with this patient.'),
    d.canUse && d.available.length ? form() : d.canUse ? h('div', { class: 'small muted' }, 'No equipment is available to set up.') : null,
    d.past.length ? h('details', {}, h('summary', {}, `Used before (${d.past.length})`),
      h('ul', { class: 'small stack' }, d.past.map((u) => h('li', {}, h('b', {}, `${u.equipment?.assetTag ?? ''}: `), `${u.purpose}. ${fmtDateTime(u.startedAt)} to ${fmtDateTime(u.endedAt)}. ${u.endNote ?? ''}`)))) : null,
  );
}

function addDialog(options, reload) {
  const tag = h('input', { type: 'text', placeholder: 'e.g. IP-0420' });
  const kind = h('select', {}, Object.entries(options.kinds).map(([k, v]) => h('option', { value: k }, v)));
  const description = h('input', { type: 'text', placeholder: 'Make and model' });
  const due = h('input', { type: 'date', value: inDays(365) });
  dialog('Add to the register', h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Asset tag', tag), h('label', { class: 'field grow' }, 'Kind', kind)),
    h('label', { class: 'field' }, 'What it is', description),
    h('label', { class: 'field' }, 'Next service due', due),
  ), 'Add', async () => {
    await post('/api/work/equipment', { assetTag: tag.value, kind: kind.value, description: description.value, serviceDue: due.value });
    toast('Added.');
    reload();
  });
}

// Home → Equipment.
export async function equipmentView() {
  const root = h('div');
  const load = async () => {
    const { equipment: rows, canManage, options } = await get('/api/work/equipment');
    const out = rows.filter((q) => q.state === 'QUARANTINED' || q.state === 'IN_REPAIR');
    const clean = rows.filter((q) => q.state === 'CLEANING');
    const lent = rows.filter((q) => q.state === 'ON_LOAN').sort((a, b) => Number(!!b.loan?.overdue) - Number(!!a.loan?.overdue));
    const inUse = rows.filter((q) => q.state === 'IN_USE');
    const free = rows.filter((q) => q.state === 'AVAILABLE');
    const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, title),
      list.length ? list.map((q) => equipmentCard(q, load)) : h('div', { class: 'card empty' }, empty));
    mount(root,
      workHeader(),
      pageTitle('Equipment', () => go('/work/home')),
      h('div', { class: 'banner' }, 'Your service\'s equipment. A fault takes it out of use straight away, equipment past its service date is not set up or lent, and anything lent comes back to be cleaned before anyone else has it.'),
      canManage ? h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => addDialog(options, load) }, 'Add equipment')) : null,
      out.length ? section('Out of use', out, '') : null,
      clean.length ? section('To clean before reuse', clean, '') : null,
      section('In use', inUse, 'Nothing in use.'),
      lent.length ? section('Lent for home', lent, '') : null,
      section('Available', free, 'Nothing available.'),
    );
  };
  await load();
  return root;
}

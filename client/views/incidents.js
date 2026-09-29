import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDate, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog, select } from '../lib/forms.js';

// Incidents: reported → safety review → notified where required → investigation → findings → actions → closed.
const TONE = { REPORTED: 'danger', REVIEWED: 'warn', INVESTIGATING: 'warn', ACTIONS: 'warn', CLOSED: 'muted' };

const localInput = (d) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function reportDialog(personId, o, reload) {
  const category = select(Object.entries(o.categories), 'Kind');
  const when = h('input', { type: 'datetime-local', value: localInput(new Date()) });
  const place = h('input', { type: 'text', placeholder: 'e.g. Beside her bed, Room 3' });
  const what = h('textarea', { 'aria-label': 'What happened', placeholder: 'Facts only: what you saw and heard, e.g. "Found sitting on the floor beside her bed at 02:10. Said she tried to walk to the toilet."' });
  const harm = select(o.harms.map((x) => [x.id, x.label]), 'Harm');
  const immediate = h('textarea', { 'aria-label': 'Done straight away', placeholder: 'e.g. Checked for injury, full set of obs, nurse in charge and whānau told' });
  dialog('Report an incident', h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'What kind', category), h('label', { class: 'field' }, 'When', when)),
    h('label', { class: 'field' }, 'Where', place),
    h('label', { class: 'field' }, 'What happened', what),
    h('label', { class: 'field' }, 'Did it reach them? Any harm you can see?', harm),
    h('label', { class: 'field' }, 'What was done straight away', immediate),
    h('p', { class: 'small muted' }, 'Someone else will review it. Reporting is about learning, not blame.'),
  ), 'Report', async () => {
    await post(`/api/work/patients/${personId}/incidents`, {
      category: category.value, occurredAt: when.value ? new Date(when.value).toISOString() : '', place: place.value, what: what.value, harm: harm.value, immediate: immediate.value,
    });
    toast('Reported.');
    reload();
  });
}

function reviewDialog(i, o, reload) {
  const harm = select(o.harms.map((x) => [x.id, x.label]), 'Confirmed harm');
  harm.value = i.reportedHarm;
  const notify = select(Object.entries(o.notify), 'Notification');
  const notifyNote = h('input', { type: 'text', 'aria-label': 'Who must be told', placeholder: 'Who must be told, or who you asked' });
  const disclosure = select(Object.entries(o.disclosure), 'Open disclosure');
  const disclosureNote = h('input', { type: 'text', 'aria-label': 'Disclosure note', placeholder: 'e.g. Kate talked with her daughter by phone at 09:00' });
  const note = h('textarea', { 'aria-label': 'Review note', placeholder: 'Anything else (optional)' });
  dialog('Safety review', h('div', { class: 'stack' },
    h('div', { class: 'small' }, h('b', {}, `${i.categoryLabel}: `), i.what),
    h('label', { class: 'field' }, 'Harm', harm),
    h('div', { class: 'row' }, h('label', { class: 'field' }, 'Must it be notified outside the service?', notify), h('label', { class: 'field grow' }, 'To whom', notifyNote)),
    h('p', { class: 'small muted' }, 'SHIFT does not decide this. Which events must go to the Health Quality & Safety Commission, HealthCERT, WorkSafe or the coroner is still a research requirement (RR-INC-001).'),
    h('div', { class: 'row' }, h('label', { class: 'field' }, 'Talked with them or their whānau?', disclosure), h('label', { class: 'field grow' }, 'Note', disclosureNote)),
    h('label', { class: 'field' }, 'Note', note),
  ), 'Record review', async () => {
    await post(`/api/work/incidents/${i.id}/review`, { harm: harm.value, notify: notify.value, notifyNote: notifyNote.value, disclosure: disclosure.value, disclosureNote: disclosureNote.value, note: note.value });
    reload();
  });
}

function simpleDialog(i, action, o, reload) {
  const forms = {
    notified: () => { const ref = h('input', { type: 'text', 'aria-label': 'Notification', placeholder: 'e.g. HealthCERT emailed 27 Sept, reference 4471' }); return ['Record the notification', h('label', { class: 'field' }, 'Who was told, how, and any reference', ref), 'Save', () => ({ ref: ref.value })]; },
    'notify-decide': () => {
      const d = select([['REQUIRED', o.notify.REQUIRED], ['NOT_REQUIRED', o.notify.NOT_REQUIRED]], 'Decision');
      const n = h('input', { type: 'text', 'aria-label': 'Decision note', placeholder: 'Who must be told, or who advised it is not needed' });
      return ['Decide on notification', h('div', { class: 'stack' }, h('label', { class: 'field' }, 'Decision', d), h('label', { class: 'field' }, 'Note', n)), 'Save', () => ({ notify: d.value, notifyNote: n.value })];
    },
    disclosure: () => {
      const d = select(Object.entries(o.disclosure), 'Open disclosure');
      const n = h('input', { type: 'text', 'aria-label': 'Disclosure note', placeholder: 'Who talked with whom, and when' });
      return ['Open disclosure', h('div', { class: 'stack' }, h('label', { class: 'field' }, 'Where it is up to', d), h('label', { class: 'field' }, 'Note', n)), 'Save', () => ({ disclosure: d.value, disclosureNote: n.value })];
    },
    investigate: () => {
      const lead = h('input', { type: 'text', 'aria-label': 'Lead', placeholder: 'e.g. Clinical Nurse Manager' });
      const ref = h('input', { type: 'text', 'aria-label': 'Reference', placeholder: 'Optional' });
      return ['Link an investigation', h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Led by', lead), h('label', { class: 'field' }, 'Reference', ref)), 'Save', () => ({ lead: lead.value, ref: ref.value })];
    },
    findings: () => { const f = h('textarea', { 'aria-label': 'Findings', placeholder: 'What was found, including the system: e.g. "Bed alarm was left off after cleaning; no check in the cleaning routine"' }); return ['Findings', h('label', { class: 'field' }, 'What was found', f), 'Save', () => ({ findings: f.value })]; },
    'action-add': () => {
      const what = h('input', { type: 'text', 'aria-label': 'Action', placeholder: 'e.g. Add a bed alarm check to the cleaning routine' });
      const owner = h('input', { type: 'text', 'aria-label': 'Owner', placeholder: 'e.g. Kate Rowe' });
      const due = h('input', { type: 'date', 'aria-label': 'Due' });
      return ['Add an action', h('div', { class: 'stack' }, h('label', { class: 'field' }, 'Action', what), h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Responsible', owner), h('label', { class: 'field' }, 'Due', due))), 'Add', () => ({ what: what.value, owner: owner.value, due: due.value })];
    },
    close: () => { const n = h('textarea', { 'aria-label': 'Closing summary', placeholder: 'What changed as a result' }); return ['Close the incident', h('label', { class: 'field' }, 'Closing summary', n), 'Close it', () => ({ note: n.value })]; },
  };
  const [title, body, label, values] = forms[action]();
  dialog(title, body, label, async () => { await post(`/api/work/incidents/${i.id}/${action}`, values()); reload(); });
}

function doneDialog(i, a, reload) {
  const n = h('input', { type: 'text', 'aria-label': 'What was done', placeholder: 'What was done' });
  dialog(`Done: ${a.what}`, h('label', { class: 'field' }, 'What was done', n), 'Mark done', async () => {
    await post(`/api/work/incidents/${i.id}/action-done`, { actionId: a.id, note: n.value });
    reload();
  });
}

const LABELS = { review: 'Review', notified: 'Record notification', 'notify-decide': 'Decide on notification', disclosure: 'Update open disclosure', investigate: 'Link investigation', findings: 'Record findings', 'action-add': 'Add action', close: 'Close' };

function incidentTile(i, o, reload, withPatient) {
  return h('div', { class: `tile stack inc inc-${i.state.toLowerCase()}` },
    h('div', { class: 'spread' },
      h('div', {}, withPatient ? h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${i.personId}/incidents`) }, h('b', {}, i.patient)) : h('b', {}, i.categoryLabel),
        h('span', { class: 'small muted' }, withPatient ? ` · ${i.categoryLabel}` : ` · ${fmtDateTime(i.occurredAt)}${i.place ? `, ${i.place}` : ''}`)),
      h('span', { class: `tag ${TONE[i.state]}` }, i.stateLabel)),
    h('div', {}, i.what),
    h('div', { class: 'chips' },
      h('span', { class: `tag ${i.harmTone}` }, i.harmConfirmed ? i.harmLabel : `${i.harmLabel} (as reported)`),
      i.notifyLabel ? h('span', { class: `tag ${i.notify === 'REQUIRED' && !i.notifiedAt ? 'danger' : 'muted'}` }, i.notify === 'REQUIRED' ? (i.notifiedAt ? 'Notified' : 'Notification not yet recorded') : i.notifyLabel) : null,
      i.disclosureLabel ? h('span', { class: `tag ${i.disclosure === 'DONE' || i.disclosure === 'NOT_NEEDED' ? 'muted' : 'warn'}` }, `Open disclosure: ${i.disclosureLabel.toLowerCase()}`) : null),
    i.actions.length ? h('div', { class: 'stack' }, h('b', { class: 'small' }, 'Actions'), i.actions.map((a) => h('div', { class: `spread small inc-action${a.overdue ? ' inc-overdue' : ''}` },
      h('span', {}, a.doneAt ? '✓ ' : '', a.what, h('span', { class: 'muted' }, ` · ${a.owner} · ${a.doneAt ? `done ${fmtDate(a.doneAt)}` : `due ${fmtDate(a.due)}${a.overdue ? ' (overdue)' : ''}`}`)),
      !a.doneAt && i.canActOnActions ? h('button', { class: 'btn small', onclick: () => doneDialog(i, a, reload) }, 'Mark done') : null))) : null,
    h('details', {}, h('summary', {}, `What has happened (${i.steps.length})`), h('ol', { class: 'det-steps' }, i.steps.map((s) => h('li', { class: 'det-step' },
      h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)), h('div', { class: 'small' }, s.body))))),
    i.can.length ? h('div', { class: 'row' }, i.can.map((a) => h('button', { class: `btn small${a === 'review' || a === 'close' ? ' primary' : ''}`, onclick: () => (a === 'review' ? reviewDialog(i, o, reload) : simpleDialog(i, a, o, reload)) }, LABELS[a]))) : null,
    i.state === 'REPORTED' && i.own ? h('p', { class: 'small muted' }, 'Waiting for someone else to review it.') : null,
  );
}

// The person's Incidents view in the Live Workstation.
export function incidentsPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.canReport ? h('div', {}, h('button', { class: 'btn primary', onclick: () => reportDialog(personId, d.options, reload) }, 'Report an incident')) : null,
    d.open.length ? d.open.map((i) => incidentTile(i, d.options, reload, false)) : h('div', { class: 'card empty' }, 'No open incidents.'),
    d.closed.length ? h('details', {}, h('summary', {}, `Closed (${d.closed.length})`), h('div', { class: 'stack' }, d.closed.map((i) => incidentTile(i, d.options, reload, false)))) : null,
  );
}

// Home → Incidents.
export async function incidentsView() {
  const root = h('div');
  const load = async () => {
    const d = await get('/api/work/incidents');
    const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
      list.length ? list.map((i) => incidentTile(i, d.options, load, true)) : h('div', { class: 'card empty' }, empty));
    mount(root,
      workHeader(),
      pageTitle('Incidents', () => go('/work/home')),
      h('div', { class: 'banner' }, 'Incidents in your service: reported and waiting for review, then open ones through to closure.'),
      d.overdueActions ? h('div', { class: 'notice' }, `${d.overdueActions} incident${d.overdueActions === 1 ? ' has' : 's have'} overdue actions.`) : null,
      section('Waiting for review', d.toReview, 'Nothing waiting for review.'),
      section('Open', d.open, 'No open incidents.'),
      section('Closed in the last 30 days', d.closed, 'None.'),
    );
  };
  await load();
  return root;
}

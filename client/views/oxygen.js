import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDateTime } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Oxygen therapy: the doctor prescribes it with a target range, device and flow → nurses record
// readings → the doctor changes, weans, resumes or stops it. SHIFT has no target ranges or flows of
// its own and only shows when a reading is outside the range the doctor set.
const LABEL = { reading: 'Add a reading', change: 'Change prescription', wean: 'Start weaning', resume: 'Back on oxygen', stop: 'Stop oxygen' };

function rangeFields(x, o) {
  const low = h('input', { type: 'number', min: '1', max: '100', 'aria-label': 'Target lowest', placeholder: 'e.g. 94', value: x?.targetLow ?? '' });
  const high = h('input', { type: 'number', min: '1', max: '100', 'aria-label': 'Target highest', placeholder: 'e.g. 98', value: x?.targetHigh ?? '' });
  const device = select(Object.entries(o.device), 'Device', 'Choose…');
  if (x?.device) device.value = x.device;
  const flow = h('input', { 'aria-label': 'Flow', placeholder: 'e.g. 2 L/min, or Room air', value: x?.flow ?? '' });
  return { low, high, device, flow, els: [h('div', { class: 'row' }, field('Target lowest %', low), field('Target highest %', high)), field('Device', device), field('Flow', flow)] };
}

function prescribeDialog(personId, o, reload) {
  const why = h('textarea', { 'aria-label': 'Why', placeholder: 'e.g. Pneumonia, saturations 88% on air' });
  const f = rangeFields(null, o);
  dialog('Prescribe oxygen', h('div', { class: 'stack' }, field('Why they need oxygen', why), ...f.els,
    h('p', { class: 'small muted' }, 'SHIFT has no target ranges or flows of its own. Write what you prescribe.')), 'Save', async () => {
    await post(`/api/work/patients/${personId}/oxygen`, { why: why.value, low: f.low.value, high: f.high.value, device: f.device.value, flow: f.flow.value });
    toast('Saved.');
    reload();
  }, { wide: true });
}

function readingDialog(x, o, reload) {
  const spo2 = h('input', { type: 'number', min: '1', max: '100', 'aria-label': 'Oxygen saturation', placeholder: 'e.g. 93' });
  const device = select(Object.entries(o.device), 'Device now', 'Choose…');
  device.value = x.device;
  const flow = h('input', { 'aria-label': 'Flow now', value: x.flow });
  const note = h('input', { 'aria-label': 'Note', placeholder: 'Optional, e.g. Flow turned up, doctor told' });
  dialog('Oxygen reading', h('div', { class: 'stack' }, h('p', { class: 'small' }, `Target ${x.targetLow} to ${x.targetHigh}% (${x.prescribedBy})`), field('Oxygen saturation %', spo2),
    field('Device now', device), field('Flow now', flow), field('Note (optional)', note)), 'Save', async () => {
    await post(`/api/work/oxygen/${x.id}/reading`, { spo2: spo2.value, device: device.value, flow: flow.value, note: note.value });
    toast('Saved.');
    reload();
  });
}

function changeDialog(x, o, reload) {
  const f = rangeFields(x, o);
  const note = h('textarea', { 'aria-label': 'Why', placeholder: 'e.g. Known COPD, so the lower range' });
  dialog('Change the prescription', h('div', { class: 'stack' }, ...f.els, field('Why', note)), 'Save', async () => {
    await post(`/api/work/oxygen/${x.id}/change`, { low: f.low.value, high: f.high.value, device: f.device.value, flow: f.flow.value, note: note.value });
    toast('Saved.');
    reload();
  }, { wide: true });
}

function noteDialog(x, action, reload) {
  const placeholder = { wean: 'e.g. Reduce by 1 L/min each review if in range', resume: 'e.g. Saturations fell when reduced', stop: 'e.g. Saturations 96% on room air for 6 hours' }[action];
  const note = h('textarea', { 'aria-label': 'Why', placeholder });
  dialog(LABEL[action], field(action === 'wean' ? 'Weaning plan' : 'Why', note), 'Save', async () => {
    await post(`/api/work/oxygen/${x.id}/${action}`, { note: note.value });
    toast('Saved.');
    reload();
  });
}

function card(x, o, reload) {
  const last = x.readings[0];
  return h('div', { class: `tile stack oxygen${last?.outside ? ' overdue' : ''}` },
    h('div', { class: 'spread' }, h('b', {}, `Oxygen · target ${x.targetLow} to ${x.targetHigh}%`), h('span', { class: `tag ${last?.outside ? 'warn' : x.state === 'STOPPED' ? 'ok' : ''}` }, last?.outside && x.state !== 'STOPPED' ? 'Last reading outside range' : x.stateLabel)),
    h('div', { class: 'small' }, `${x.deviceLabel}, ${x.flow} · ${x.why} · prescribed by ${x.prescribedBy}, ${fmtDateTime(x.prescribedAt)}`),
    x.readings.length ? h('div', { class: 'stack' }, x.readings.slice(0, 4).map((r) => h('div', { class: `small advice${r.outside ? ' overdue' : ''}` },
      h('b', {}, `${r.spo2}%`), ` on ${r.deviceLabel.toLowerCase()}, ${r.flow}`, r.outside ? h('span', { class: 'tag warn' }, 'Outside range') : null, r.note ? ` · ${r.note}` : '',
      h('div', { class: 'muted' }, `${r.by}, ${fmtDateTime(r.at)}`)))) : h('div', { class: 'small muted' }, 'No readings yet.'),
    x.stopNote ? h('div', { class: 'small' }, h('b', {}, `Stopped (${x.stoppedBy}): `), x.stopNote) : null,
    x.acts.length ? h('div', { class: 'row' }, x.acts.map((a) => h('button', { class: `btn small${a === 'reading' ? ' primary' : ''}`,
      onclick: () => (a === 'reading' ? readingDialog(x, o, reload) : a === 'change' ? changeDialog(x, o, reload) : noteDialog(x, a, reload)) }, LABEL[a]))) : null,
    h('details', {}, h('summary', { class: 'small' }, `History (${x.steps.length})`),
      h('ol', { class: 'det-steps' }, x.steps.map((s) => h('li', { class: 'det-step' }, h('div', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`), h('div', { class: 'small' }, s.body))))),
  );
}

// ED and ward doctors' assessment and review, ED and ward nurses' Monitoring.
export function oxygenPanel(personId, s, reload) {
  if (!s || (!s.current.length && !s.past.length && !s.canPrescribe)) return null;
  return h('section', { class: 'stack' },
    h('div', { class: 'spread' }, h('h3', {}, 'Oxygen therapy'),
      s.canPrescribe && !s.current.length ? h('button', { class: 'btn small', onclick: () => prescribeDialog(personId, s.options, reload) }, 'Prescribe oxygen') : null),
    s.current.map((x) => card(x, s.options, reload)),
    s.past.length ? h('details', {}, h('summary', { class: 'small' }, `Earlier (${s.past.length})`), h('div', { class: 'stack' }, s.past.map((x) => card(x, s.options, reload)))) : null,
  );
}

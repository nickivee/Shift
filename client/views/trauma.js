import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDateTime } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Major trauma: trauma call → primary survey → secondary survey → injuries → where next →
// tertiary survey on the ward. SHIFT applies no activation criteria or severity scores.
const LABEL = { primary: 'Primary survey', secondary: 'Secondary survey', injury: 'Add an injury', next: 'Where next', tertiary: 'Tertiary survey' };
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

function callDialog(personId, o, reload) {
  const teamCall = select(Object.entries(o.teamCall), 'Trauma call', null);
  const mechanism = h('textarea', { 'aria-label': 'How they were injured', placeholder: 'e.g. Motorbike v car, about 60 km/h, helmet on, thrown 5 m' });
  const injuredAt = h('input', { type: 'datetime-local', 'aria-label': 'When', value: stamp(new Date(Date.now() - 45 * 60_000)) });
  const pre = h('textarea', { 'aria-label': 'What the ambulance found', placeholder: 'Optional, e.g. GCS 14, HR 118, BP 96/60, pelvic binder on, 1 L fluid' });
  dialog('Trauma call', h('div', { class: 'stack' }, field('Trauma call', teamCall), field('How they were injured', mechanism), field('When', injuredAt), field('What the ambulance found', pre),
    h('p', { class: 'small muted' }, 'Who needs a trauma call is set nationally (RR-TRAUMA-001), not in SHIFT.')), 'Call', async () => {
    await post(`/api/work/patients/${personId}/trauma`, { teamCall: teamCall.value, mechanism: mechanism.value, injuredAt: injuredAt.value, prehospital: pre.value });
    toast('Trauma call recorded.');
    reload();
  }, { wide: true });
}

function primaryDialog(x, o, reload) {
  const boxes = Object.fromEntries(Object.entries(o.primary).map(([k, label]) => [k, h('input', { 'aria-label': label })]));
  boxes.airway.placeholder = 'e.g. Talking; collar on; no tenderness';
  boxes.breathing.placeholder = 'e.g. RR 24, sats 94%, reduced air entry left';
  boxes.circulation.placeholder = 'e.g. HR 120, BP 95/60, pelvis stable, no bleeding seen';
  boxes.disability.placeholder = 'e.g. GCS 14 (E4 V4 M6), pupils equal, glucose 6.1';
  boxes.exposure.placeholder = 'e.g. Deformed left thigh; abrasions; 36.1°C, warmed';
  const actions = h('textarea', { 'aria-label': 'What was done', placeholder: 'Optional, e.g. Oxygen, two large IVs, bloods, splint on left leg' });
  dialog(`Primary survey: ${x.mechanism}`, h('div', { class: 'stack' }, ...Object.entries(o.primary).map(([k, label]) => field(label, boxes[k])), field('What was done', actions)), 'Save', async () => {
    await post(`/api/work/trauma/${x.id}/primary`, { ...Object.fromEntries(Object.entries(boxes).map(([k, el]) => [k, el.value])), actions: actions.value });
    toast('Saved.');
    reload();
  }, { wide: true });
}

function surveyDialog(x, action, reload) {
  const findings = h('textarea', { 'aria-label': 'Findings', rows: 6, placeholder: action === 'tertiary'
    ? 'e.g. Full head-to-toe again, awake and talking; new tenderness right wrist; X-ray asked for'
    : 'e.g. Head: scalp graze. Chest: tender left ribs 6–8. Abdomen soft. Pelvis stable. Left femur deformed, foot pulses present. Back: no step.' });
  dialog(`${LABEL[action]}: ${x.mechanism}`, h('div', { class: 'stack' }, field('Findings', findings),
    action === 'tertiary' ? h('p', { class: 'small muted' }, 'Add any injury found that was missed before. Saving the tertiary survey completes the trauma record.') : null), 'Save', async () => {
    await post(`/api/work/trauma/${x.id}/${action}`, { findings: findings.value });
    toast('Saved.');
    reload();
  }, { wide: true });
}

function injuryDialog(x, o, reload) {
  const injury = h('input', { 'aria-label': 'Injury', placeholder: 'e.g. Fractured left femur, mid-shaft' });
  const foundBy = select(Object.entries(o.foundBy).filter(([k]) => (x.state === 'ADMITTED' ? ['TERTIARY', 'IMAGING'] : ['PRIMARY', 'SECONDARY', 'IMAGING']).includes(k)), 'How it was found', null);
  dialog(`Injury: ${x.mechanism}`, h('div', { class: 'stack' }, field('Injury', injury), field('How it was found', foundBy)), 'Add', async () => {
    await post(`/api/work/trauma/${x.id}/injury`, { injury: injury.value, foundBy: foundBy.value });
    toast('Added.');
    reload();
  });
}

function nextDialog(x, o, reload) {
  const next = select(Object.entries(o.next), 'Where next', 'Choose…');
  const note = h('input', { 'aria-label': 'Details', placeholder: 'e.g. General Medicine, accepted by Dr Li; orthopaedics to see' });
  dialog(`Where next: ${x.mechanism}`, h('div', { class: 'stack' }, field('Where next', next), field('Details', note)), 'Save', async () => {
    await post(`/api/work/trauma/${x.id}/next`, { next: next.value, note: note.value });
    toast('Saved.');
    reload();
  });
}

function card(x, o, reload) {
  const tone = x.state === 'COMPLETE' ? 'ok' : 'warn';
  const run = (a) => (a === 'primary' ? primaryDialog(x, o, reload) : a === 'injury' ? injuryDialog(x, o, reload) : a === 'next' ? nextDialog(x, o, reload) : surveyDialog(x, a, reload));
  return h('div', { class: 'tile stack trauma' },
    h('div', { class: 'spread' }, h('b', {}, `${x.teamCallLabel}: ${x.mechanism}`), h('span', { class: `tag ${tone}` }, x.stateLabel)),
    h('div', { class: 'small muted' }, [`Called by ${x.activatedBy} ${fmtDateTime(x.activatedAt)}`, x.injuredAt ? `injured ${fmtDateTime(x.injuredAt)}` : 'time of injury not known'].join(' · ')),
    x.prehospital ? h('div', { class: 'small' }, h('b', {}, 'Ambulance: '), x.prehospital) : null,
    x.surveys.map((s) => h('div', { class: 'small survey' }, h('b', {}, `${s.kindLabel} (${s.by}, ${fmtDateTime(s.at)})`),
      s.kind === 'PRIMARY' ? h('dl', { class: 'abcde' }, Object.entries(o.primary).flatMap(([k, label]) => [h('dt', {}, label.split(' (')[0]), h('dd', {}, s[k])]),
        s.actions ? [h('dt', {}, 'Done'), h('dd', {}, s.actions)] : []) : h('div', {}, s.findings))),
    x.injuries.length ? h('div', { class: 'small' }, h('b', {}, 'Injuries'), h('ul', { class: 'injuries' }, x.injuries.map((i) => h('li', {}, i.injury, h('span', { class: 'muted' }, ` · ${i.foundByLabel}, ${i.by}`))))) : null,
    x.nextLabel ? h('div', { class: 'small' }, h('b', {}, `${x.nextLabel} (${x.nextBy}): `), x.nextNote) : null,
    x.missing.length ? h('div', { class: 'small warn-text' }, `Not done yet: ${x.missing.join(', ')}.`) : null,
    x.acts.length ? h('div', { class: 'row' }, x.acts.map((a) => h('button', { class: `btn small${['primary', 'secondary', 'tertiary'].includes(a) ? ' primary' : ''}`, onclick: () => run(a) }, LABEL[a]))) : null,
    h('details', {}, h('summary', { class: 'small' }, `History (${x.steps.length})`),
      h('ol', { class: 'det-steps' }, x.steps.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`), h('div', { class: 'small' }, s.body))))),
  );
}

// ED doctors' Medical Assessment, ED nurses' Triage, ward doctors' Review and ward nurses' Care Plan.
export function traumaPanel(personId, s, reload) {
  if (!s) return null;
  return h('section', { class: 'stack' },
    h('div', { class: 'spread' }, h('h3', {}, 'Trauma'),
      s.canCall && !s.current.length ? h('button', { class: 'btn small', onclick: () => callDialog(personId, s.options, reload) }, 'Trauma call') : null),
    s.current.map((x) => card(x, s.options, reload)),
    s.past.length ? h('details', {}, h('summary', { class: 'small' }, `Earlier (${s.past.length})`), h('div', { class: 'stack' }, s.past.map((x) => card(x, s.options, reload)))) : null,
  );
}

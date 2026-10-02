import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { formDialog as dialog, select } from '../lib/forms.js';

// Major incident: declared on standby or active → casualties registered with an incident number
// and a priority, re-triaged as they change → stood down → debrief.
const TONE = { STANDBY: 'warn', ACTIVE: 'danger', STOOD_DOWN: 'muted' };
const prio = (p, label) => h('span', { class: `tag prio-${String(p).toLowerCase()}` }, label);

function declareDialog(o, reload) {
  const title = h('input', { type: 'text', 'aria-label': 'What has happened', placeholder: 'e.g. Bus crash on State Highway 1 at Pukerua Bay' });
  const expected = h('input', { type: 'number', min: '0', 'aria-label': 'Casualties expected', placeholder: 'If known' });
  const level = select(Object.entries(o.levels), 'Level');
  dialog('Declare a major incident', h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'What has happened', title),
    h('label', { class: 'field' }, 'Casualties expected', expected),
    h('label', { class: 'field' }, 'Level', level),
    h('p', { class: 'small muted' }, 'Who may declare a major incident and the triage method to use are still being researched for New Zealand (RR-MCI-001).'),
  ), 'Declare', async () => {
    await post('/api/work/major-incident', { title: title.value, expected: expected.value, level: level.value });
    toast('Major incident declared.');
    reload();
  });
}

const act = (m, action, body, done, reload) => post(`/api/work/major-incident/${m.id}/${action}`, body).then(() => { toast(done); reload(); });

function casualtyDialog(m, o, reload) {
  const priority = select(Object.entries(o.priority), 'Priority');
  const description = h('input', { type: 'text', 'aria-label': 'Description', placeholder: 'e.g. Woman about 30, red jacket, leg injury' });
  const gender = select([['UNKNOWN', 'Not known'], ['FEMALE', 'Female'], ['MALE', 'Male'], ['ANOTHER', 'Another gender']], 'Gender', null);
  const location = h('input', { type: 'text', 'aria-label': 'Where', placeholder: 'e.g. Resus 1' });
  dialog('New casualty', h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'Priority', priority),
    h('label', { class: 'field' }, 'Description', description),
    h('div', { class: 'row' }, h('label', { class: 'field' }, 'Gender', gender), h('label', { class: 'field grow' }, 'Where', location)),
    h('p', { class: 'small muted' }, 'They get an incident number and a temporary identity so care starts now. Identify them from Arrivals as soon as you can.'),
  ), 'Register', () => act(m, 'casualty', { priority: priority.value, description: description.value, gender: gender.value, location: location.value }, 'Casualty registered.', reload));
}

function addDialog(m, here, o, reload) {
  const who = select(here.map((p) => [p.personId, `${p.name}${p.location ? ` · ${p.location}` : ''}`]), 'Who');
  const priority = select(Object.entries(o.priority), 'Priority');
  dialog('Someone already here', h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'Who', who), h('label', { class: 'field' }, 'Priority', priority),
  ), 'Add', () => act(m, 'add', { personId: who.value, priority: priority.value }, 'Added as a casualty.', reload));
}

function retriageDialog(m, c, o, reload) {
  const priority = select(Object.entries(o.priority).filter(([k]) => k !== c.priority), 'New priority');
  const note = h('input', { type: 'text', 'aria-label': 'What changed', placeholder: 'e.g. Now drowsy, GCS 12' });
  dialog(`Re-triage ${c.number}`, h('div', { class: 'stack' },
    h('p', { class: 'muted' }, `Now ${c.priorityLabel.toLowerCase()}.`),
    h('label', { class: 'field' }, 'New priority', priority), h('label', { class: 'field' }, 'What changed', note),
  ), 'Save', () => act(m, 'retriage', { casualtyId: c.id, priority: priority.value, note: note.value }, 'Priority changed.', reload));
}

function noteDialog(m, action, title, label, placeholder, submit, done, reload) {
  const note = h('textarea', { 'aria-label': label, placeholder });
  dialog(title, h('label', { class: 'field' }, label, note), submit, () => act(m, action, { note: note.value }, done, reload));
}

export function majorPanel(d, reload) {
  if (!d) return null;
  const m = d.incident;
  const o = d.options;
  if (!m) {
    return d.canDeclare ? h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, 'Major incident'),
      h('div', { class: 'card stack' }, h('p', { class: 'muted' }, 'No major incident declared.'),
        h('div', {}, h('button', { class: 'btn danger', onclick: () => declareDialog(o, reload) }, 'Declare a major incident')))) : null;
  }
  return h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, 'Major incident'),
    h('div', { class: 'card stack major-incident' },
      h('div', { class: 'spread' }, h('h3', {}, m.title), h('span', { class: `tag ${TONE[m.state]}` }, m.stateLabel)),
      h('div', { class: 'small muted' }, `Declared by ${m.declaredBy} ${fmtDateTime(m.declaredAt)}${m.expected ? ` · about ${m.expected} expected` : ''}${m.activatedAt ? ` · active since ${fmtDateTime(m.activatedAt)}` : ''}`),
      h('div', { class: 'major-counts' }, Object.entries(o.priority).map(([k, label]) => h('span', { class: `tag prio-${k.toLowerCase()}` }, `${label}: ${m.counts[k]}`))),
      m.casualties.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, 'No.'), h('th', {}, 'Priority'), h('th', {}, 'Who'), h('th', {}, 'Where'), h('th', {}, 'Since'), h('th', {}, ''))),
        h('tbody', {}, m.casualties.map((c) => h('tr', {},
          h('td', {}, h('b', {}, c.number)),
          h('td', {}, prio(c.priority, c.priorityLabel)),
          h('td', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${c.personId}`) }, c.name)),
          h('td', {}, c.left ? 'Left the department' : c.location ?? ''),
          h('td', { class: 'small' }, `${fmtDateTime(c.arrivedAt)}`),
          h('td', {}, m.can.includes('retriage') && !c.left ? h('button', { class: 'btn small', onclick: () => retriageDialog(m, c, o, reload) }, 'Re-triage') : null),
        ))))) : h('p', { class: 'small muted' }, 'No casualties yet.'),
      m.standDownNote ? h('div', { class: 'small' }, h('b', {}, 'Stood down: '), `${m.standDownNote} (${m.stoodDownBy}, ${fmtDateTime(m.stoodDownAt)})`) : null,
      m.can.length ? h('div', { class: 'row' },
        m.can.includes('activate') ? h('button', { class: 'btn danger small', onclick: () => act(m, 'activate', {}, 'Active: casualties coming.', reload) }, 'Activate') : null,
        m.can.includes('casualty') ? h('button', { class: 'btn primary small', onclick: () => casualtyDialog(m, o, reload) }, 'New casualty') : null,
        m.can.includes('add') && d.here.length ? h('button', { class: 'btn small', onclick: () => addDialog(m, d.here, o, reload) }, 'Someone already here') : null,
        m.can.includes('standdown') ? h('button', { class: 'btn small', onclick: () => noteDialog(m, 'standdown', 'Stand down', 'Why', 'e.g. Last casualty arrived; ambulance control has cleared the scene', 'Stand down', 'Stood down. Record the debrief when it is done.', reload) }, 'Stand down') : null,
        m.can.includes('close') ? h('button', { class: 'btn primary small', onclick: () => noteDialog(m, 'close', 'Debrief', 'What worked and what to change', 'e.g. Casualty numbers worked well; resus ran out of trauma packs', 'Close', 'Closed.', reload) }, 'Record the debrief') : null) : null,
      h('details', {}, h('summary', {}, `Step by step (${m.steps.length})`),
        h('ol', { class: 'det-steps' }, m.steps.map((s) => h('li', { class: 'det-step' },
          h('div', { class: 'spread' }, h('b', {}, s.kind.charAt(0) + s.kind.slice(1).toLowerCase().replace(/_/g, ' ')), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
          h('div', {}, s.body))))),
    ));
}

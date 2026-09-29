import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, ask, pageTitle, fmtDate, fmtDateTime } from '../lib/ui.js';
import { go, state } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog } from '../lib/forms.js';

// Decision-making capacity: a specific decision → why capacity is in question → the four
// abilities → what was done to help them decide → the finding, for this decision only → when to
// assess again. Capacity is presumed. What follows in law from a finding is RR-CAP-001.
const PRESUMED = 'Capacity is presumed. This is about one decision at one time, and a finding says nothing about any other decision.';
const LAW = 'SHIFT records the assessment only. Who decides if the person lacks capacity, and any enduring power of attorney, is still being researched (RR-CAP-001).';
const TONE = { HAS: 'ok', LACKS: 'danger', NOT_YET: 'warn' };
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };

const select = (options, value) => {
  const s = h('select', {}, Object.entries(options).map(([k, v]) => h('option', { value: k }, v)));
  if (value !== undefined) s.value = value;
  return s;
};

function assessDialog(c, options, action, reload) {
  const f = {};
  const abilities = Object.entries(options.abilities).map(([k, label]) => {
    f[k] = select({ '': 'Choose…', ...options.answers }, action === 'reassess' ? '' : '');
    return h('label', { class: 'field' }, label, f[k]);
  });
  f.findings = h('textarea', { placeholder: 'What you explained, what you asked, and how they answered, in their words where you can' });
  f.supports = h('textarea', { placeholder: 'What was done to help them decide: time of day, glasses or hearing aids, interpreter, whānau present, simpler information, pictures' });
  f.present = h('input', { type: 'text', placeholder: 'Who else was there (optional)' });
  f.determination = select({ '': 'Choose…', ...options.determinations }, '');
  f.note = h('input', { type: 'text', placeholder: 'Anything to add (optional)' });
  f.reassessBy = h('input', { type: 'date', value: inDays(7) });
  const law = h('p', { class: 'small notice' }, LAW);
  const sync = () => { law.hidden = f.determination.value !== 'LACKS'; };
  f.determination.addEventListener('change', sync);
  sync();
  dialog(action === 'reassess' ? 'Assess again' : 'Assess capacity', h('div', { class: 'stack' },
    h('p', {}, h('b', {}, 'Decision: '), c.decision),
    h('p', { class: 'small muted' }, PRESUMED),
    ...abilities,
    h('label', { class: 'field' }, 'What happened', f.findings),
    h('label', { class: 'field' }, 'Support given', f.supports),
    h('label', { class: 'field' }, 'Present', f.present),
    h('label', { class: 'field' }, 'Finding', f.determination), law,
    h('label', { class: 'field' }, 'Note', f.note),
    h('label', { class: 'field' }, 'Assess again by', f.reassessBy),
  ), 'Save assessment', async () => {
    await post(`/api/work/capacity/${c.id}/${action}`, Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value])));
    toast('Assessment saved.');
    reload();
  });
}

async function doAction(c, action, options, reload) {
  if (action === 'assess' || action === 'reassess') return assessDialog(c, options, action, reload);
  const note = await ask({ title: 'Withdraw this concern', message: c.decision, label: 'Why an assessment is no longer needed', confirm: 'Withdraw', multiline: true, minLength: 3 });
  if (!note) return;
  try {
    await post(`/api/work/capacity/${c.id}/withdraw`, { note });
    toast('Concern withdrawn.');
    reload();
  } catch (err) { showError(err); }
}

const ACTION = { assess: ['Assess', true], reassess: ['Assess again', false], withdraw: ['Withdraw', false] };

export function capacityCard(c, options, reload, { showPatient = true } = {}) {
  const done = c.state === 'DETERMINED' || c.state === 'SUPERSEDED';
  return h('div', { class: `tile stack capacity${c.determination === 'LACKS' && c.state === 'DETERMINED' ? ' capacity-lacks' : ''}` },
    h('div', { class: 'spread' },
      h('div', {},
        showPatient ? h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${c.personId}/capacity`) }, h('b', {}, c.patient)) : null,
        h('div', { class: 'small muted' }, c.kindLabel),
      ),
      h('div', { class: 'row' },
        c.reassessDue ? h('span', { class: 'tag warn' }, 'Reassessment due') : null,
        done && c.determination ? h('span', { class: `tag ${TONE[c.determination] ?? ''}` }, c.determinationLabel) : h('span', { class: `tag ${c.state === 'RAISED' ? 'warn' : 'muted'}` }, c.stateLabel)),
    ),
    h('div', {}, h('b', {}, 'Decision: '), c.decision),
    h('div', { class: 'small' }, h('b', {}, 'Concern: '), c.concern),
    done ? h('ul', { class: 'small abilities' }, c.abilities.map((a) => h('li', {}, h('span', { class: `tag ${a.value === 'NO' ? 'danger' : a.value === 'UNSURE' ? 'warn' : 'ok'}` }, a.answer ?? '—'), ` ${a.label}`))) : null,
    c.findings ? h('div', { class: 'small' }, h('b', {}, 'What happened: '), c.findings) : null,
    c.supports ? h('div', { class: 'small' }, h('b', {}, 'Support given: '), c.supports) : null,
    c.present ? h('div', { class: 'small' }, h('b', {}, 'Present: '), c.present) : null,
    c.determinationNote ? h('div', { class: 'small' }, h('b', {}, 'Note: '), c.determinationNote) : null,
    c.determination === 'LACKS' && c.state === 'DETERMINED' ? h('div', { class: 'small notice' }, LAW) : null,
    c.closeReason && c.state === 'WITHDRAWN' ? h('div', { class: 'small' }, h('b', {}, `Withdrawn (${c.closedBy}): `), c.closeReason) : null,
    h('div', { class: 'small muted' }, [
      `Raised by ${c.raisedBy}, ${c.service}, ${fmtDateTime(c.raisedAt)}`,
      c.assessedBy ? `assessed by ${c.assessedBy} ${fmtDateTime(c.assessedAt)}` : null,
      c.reassessBy ? `assess again by ${fmtDate(c.reassessBy)}` : null,
    ].filter(Boolean).join(' · ')),
    c.actions.length ? h('div', { class: 'row' }, c.actions.map((x) =>
      h('button', { class: `btn small${ACTION[x][1] ? ' primary' : ''}`, onclick: () => doAction(c, x, options, reload) }, ACTION[x][0]))) : null,
  );
}

function raiseForm(personId, d, reload) {
  const decision = h('input', { type: 'text', placeholder: 'The specific decision, e.g. whether to move into residential care' });
  const kind = select({ '': 'Choose…', ...d.options.kinds }, '');
  const concern = h('textarea', { placeholder: 'Why their capacity for this decision is in question' });
  return h('form', { class: 'tile stack', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await post(`/api/work/patients/${personId}/capacity`, { decision: decision.value, kind: kind.value, concern: concern.value });
      toast(d.canAssess ? 'Concern raised.' : 'Concern raised. A doctor will assess it.');
      reload();
    } catch (err) { showError(err); }
  } },
    h('h3', {}, 'Raise a capacity concern'),
    h('p', { class: 'small muted' }, PRESUMED),
    h('label', { class: 'field' }, 'Decision', decision),
    h('label', { class: 'field' }, 'Kind of decision', kind),
    h('label', { class: 'field' }, 'Concern', concern),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Raise')),
  );
}

// The person's Capacity view inside the Live Workstation.
export function capacityPanel(personId, d, reload) {
  const subject = state.me.context.subjectLabel.toLowerCase();
  return h('div', { class: 'stack' },
    d.assessments.length ? d.assessments.map((c) => capacityCard(c, d.options, reload, { showPatient: false }))
      : h('div', { class: 'empty' }, `No capacity concerns for this ${subject}. Capacity is presumed.`),
    d.canRaise ? raiseForm(personId, d, reload) : null,
    d.past.length ? h('details', {}, h('summary', {}, `Earlier (${d.past.length})`),
      h('div', { class: 'stack' }, d.past.map((c) => capacityCard(c, d.options, reload, { showPatient: false })))) : null,
  );
}

// Home → Capacity assessments.
export async function capacityView() {
  const root = h('div');
  const load = async () => {
    const { assessments, options } = await get('/api/work/capacity');
    const waiting = assessments.filter((c) => c.state === 'RAISED' || c.reassessDue);
    const rest = assessments.filter((c) => !waiting.includes(c));
    mount(root,
      workHeader(),
      pageTitle('Capacity assessments', () => go('/work/home')),
      h('div', { class: 'banner' }, `Concerns waiting for assessment and reassessments due come first. ${PRESUMED}`),
      h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `Waiting (${waiting.length})`),
        waiting.length ? waiting.map((c) => capacityCard(c, options, load)) : h('div', { class: 'card empty' }, 'Nothing waiting.')),
      rest.length ? h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, 'Current findings'), rest.map((c) => capacityCard(c, options, load))) : null,
    );
  };
  await load();
  return root;
}

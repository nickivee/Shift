import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, ask, confirmDialog, pageTitle, fmtDate, fmtDateTime, titleCase } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';

// Discharge: considered → readiness → decision → requirements → discharged. Each requirement
// shows who met it; the discharge itself is recorded only when none is outstanding.
const TONE = { CONSIDERED: 'warn', DECIDED: '', DISCHARGED: 'ok', CANCELLED: 'muted' };
const LABEL = { CONSIDERED: 'Being planned', DECIDED: 'Decision made', DISCHARGED: 'Discharged', CANCELLED: 'Stopped' };
export const dischargeTag = (state) => h('span', { class: `tag ${TONE[state] ?? ''}` }, LABEL[state] ?? titleCase(state));

const expectedText = (d) => (d.expectedDate ? `Expected ${fmtDate(d.expectedDate)}` : 'No date set');

async function recordRequirement(d, r, reload, notApplicable) {
  const note = await ask(notApplicable
    ? { title: `${r.label}: not applicable`, message: 'Say why this does not apply to this discharge.', label: 'Reason', multiline: true, minLength: 5, confirm: 'Record' }
    : { title: r.label, message: r.hint, label: r.text ? 'Discharge summary' : 'What was done', multiline: true, minLength: r.text ? 20 : 3, confirm: 'Record' });
  if (!note) return;
  try {
    await post(`/api/work/discharges/${d.id}/requirements/${r.code}`, { status: notApplicable ? 'NOT_APPLICABLE' : 'DONE', note });
    toast(`${r.label}: recorded.`);
    reload();
  } catch (err) { showError(err); }
}

async function doAction(d, action, reload) {
  let note = null;
  if (action === 'reverse' || action === 'cancel') {
    note = await ask({
      title: action === 'reverse' ? 'Reverse the decision' : 'Stop discharge planning',
      message: action === 'reverse' ? `${d.patient} goes back to being planned. Requirements already met stay recorded.` : `Planning stops for ${d.patient}. They stay admitted.`,
      label: 'Reason', multiline: true, minLength: 5, confirm: action === 'reverse' ? 'Reverse' : 'Stop planning',
    });
    if (!note) return;
  } else {
    const text = {
      decide: ['Decide to discharge', `You are deciding ${d.patient} will be discharged to ${d.destination.toLowerCase()}. Outstanding requirements must still be met before they leave.`, 'Record decision'],
      complete: [`Discharge ${d.patient}`, `${d.patient} leaves ${d.service}. Their stay ends and ${d.location ?? 'their bed'} goes for cleaning.`, 'Record discharge'],
    }[action];
    if (!(await confirmDialog(...text))) return;
  }
  try {
    await post(`/api/work/discharges/${d.id}/${action}`, note ? { note } : {});
    toast({ decide: 'Decision recorded.', reverse: 'Decision reversed.', complete: `${d.patient} discharged.`, cancel: 'Discharge planning stopped.' }[action]);
    reload();
  } catch (err) { showError(err); }
}

const ACTION = { decide: ['Decide to discharge', true], complete: ['Record discharge', true], reverse: ['Reverse decision', false], cancel: ['Stop planning', false] };

function requirementRow(d, r, reload) {
  const state = r.status === 'DONE' ? h('span', { class: 'tag ok' }, 'Done')
    : r.status === 'NOT_APPLICABLE' ? h('span', { class: 'tag muted' }, 'Not applicable')
    : h('span', { class: 'tag warn' }, 'Outstanding');
  return h('li', { class: `req${r.status ? ' met' : ''}` },
    h('div', { class: 'spread' }, h('b', {}, r.label), state),
    r.note ? h('div', { class: r.text ? 'summary' : 'small' }, r.note) : null,
    r.by ? h('div', { class: 'small muted' }, `${r.by} · ${fmtDateTime(r.at)}`) : d.flow ? null : h('div', { class: 'small muted' }, r.hint),
    r.canRecord ? h('div', { class: 'row' },
      h('button', { class: 'btn small primary', onclick: () => recordRequirement(d, r, reload, false) }, r.text ? 'Write summary' : 'Record'),
      h('button', { class: 'btn small', onclick: () => recordRequirement(d, r, reload, true) }, 'Not applicable'),
    ) : null,
  );
}

export function dischargeCard(d, reload, { showPatient = true } = {}) {
  const open = d.state === 'CONSIDERED' || d.state === 'DECIDED';
  return h('div', { class: 'tile stack' },
    h('div', { class: 'spread' },
      h('div', {},
        !showPatient ? null
          : d.flow ? h('b', {}, d.patient)
          : h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${d.personId}/discharge`) }, h('b', {}, d.patient)),
        h('div', { class: showPatient ? 'muted' : '' }, [d.location, d.flow ? d.service : null, `To ${d.destination.toLowerCase()}`, open ? expectedText(d) : null].filter(Boolean).join(' · ')),
      ),
      h('div', { class: 'row' }, open && d.outstanding ? h('span', { class: 'tag' }, `${d.outstanding} outstanding`) : null, dischargeTag(d.state)),
    ),
    d.note ? h('div', {}, d.note) : null,
    h('ul', { class: 'reqs' }, d.requirements.map((r) => requirementRow(d, r, reload))),
    h('div', { class: 'small muted' }, [
      `Considered by ${d.consideredBy}, ${fmtDateTime(d.consideredAt)}`,
      d.decidedBy ? `decision: ${d.decidedBy}` : null,
      d.dischargedBy ? `discharged by ${d.dischargedBy}, ${fmtDateTime(d.dischargedAt)}` : null,
    ].filter(Boolean).join(' · ')),
    d.actions.length ? h('div', { class: 'row' }, d.actions.map((a) =>
      h('button', { class: `btn small${ACTION[a][1] ? ' primary' : ''}`, onclick: () => doAction(d, a, reload) }, ACTION[a][0]))) : null,
    open && d.state === 'DECIDED' && d.outstanding && !d.flow ? h('div', { class: 'small muted' }, 'The discharge can be recorded once nothing is outstanding.') : null,
  );
}

// The patient's Discharge view inside the Live Workstation.
export function dischargePanel(personId, data, reload) {
  const form = () => {
    const destination = h('select', {}, data.destinations.map((x) => h('option', { value: x }, x)));
    const expected = h('input', { type: 'date' });
    const note = h('textarea', { placeholder: 'What needs to happen before they can go' });
    return h('form', { class: 'tile stack', onsubmit: async (e) => {
      e.preventDefault();
      try {
        await post(`/api/work/patients/${personId}/discharge`, { destination: destination.value, expectedDate: expected.value, note: note.value });
        toast('Discharge planning started.');
        reload();
      } catch (err) { showError(err); }
    } },
      h('h3', {}, 'Start discharge planning'),
      h('label', { class: 'field' }, 'Expected destination', destination),
      h('label', { class: 'field' }, 'Expected date', expected),
      h('label', { class: 'field' }, 'Plan', note),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Start planning')),
    );
  };
  return h('div', { class: 'stack' },
    data.canStart ? form() : null,
    data.discharges.length ? data.discharges.map((d) => dischargeCard(d, reload, { showPatient: false }))
      : data.canStart ? null : h('div', { class: 'empty' }, 'No discharge planned.'),
  );
}

// Home → Discharges.
export async function dischargesView() {
  const root = h('div');
  const load = async () => {
    const rows = await get('/api/work/discharges');
    const open = rows.filter((d) => d.state === 'CONSIDERED' || d.state === 'DECIDED');
    const done = rows.filter((d) => d.state === 'DISCHARGED');
    mount(root,
      workHeader(),
      pageTitle('Discharges', () => go('/work/home')),
      h('div', { class: 'banner' }, 'Discharge planning. The decision, each requirement and the discharge itself are recorded by the person who does them. Nobody leaves until nothing is outstanding.'),
      h('section', { class: 'stack' },
        h('h2', { class: 'section-title paua' }, 'Being planned'),
        open.length ? open.map((d) => dischargeCard(d, load)) : h('div', { class: 'card empty' }, 'No discharges being planned.')),
      done.length ? h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, 'Discharged today'), done.map((d) => dischargeCard(d, load))) : null,
    );
  };
  await load();
  return root;
}

// Flow board summary: discharges expected, with how much is outstanding.
export function expectedDischarges(rows) {
  const open = rows.filter((d) => d.state === 'CONSIDERED' || d.state === 'DECIDED');
  if (!open.length) return null;
  return h('section', { class: 'stack' },
    h('h2', { class: 'section-title paua' }, 'Expected discharges'),
    h('div', { class: 'list' }, open.map((d) => h('div', { class: 'tile spread' },
      h('div', {}, h('b', {}, d.patient), h('div', { class: 'small muted' }, [d.location, d.service, `To ${d.destination.toLowerCase()}`].filter(Boolean).join(' · '))),
      h('div', { class: 'row' }, h('span', { class: 'tag' }, expectedText(d)), d.outstanding ? h('span', { class: 'tag warn' }, `${d.outstanding} outstanding`) : h('span', { class: 'tag ok' }, 'Ready'), dischargeTag(d.state)),
    ))),
  );
}

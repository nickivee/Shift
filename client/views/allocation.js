import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, ask, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';
import { formDialog as dialog } from '../lib/forms.js';

// Patient allocation: draft → submitted for review → confirmed → in use for the shift, with
// patients moved during the shift → ended at handover.
const STATE_WORDS = { DRAFT: 'Drafted', SUBMITTED: 'Submitted for review', CONFIRMED: 'Confirmed', ACTIVE: 'Started', ENDED: 'Ended', CANCELLED: 'Cancelled' };
const TONE = { DRAFT: 'muted', SUBMITTED: 'warn', CONFIRMED: 'ok', ACTIVE: 'ok', ENDED: 'muted', CANCELLED: 'muted' };

const firstName = (name) => String(name).split(' ')[0];

function addStaffDialog(d, reload) {
  const who = h('select', {}, h('option', { value: '' }, 'Choose…'),
    d.addable.map((p) => h('option', { value: p.id, disabled: !p.authorityOk }, `${p.name} (${p.roleLabel})${p.authorityOk ? '' : ': certificate not current'}`)));
  const reason = h('input', { type: 'text', placeholder: 'e.g. Called in for sick leave' });
  dialog('Add someone to this shift', h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'Who', who),
    h('label', { class: 'field' }, 'Why, if they are not on the roster', reason),
    h('p', { class: 'small muted' }, 'Only people whose practising certificate is current can take patients.'),
  ), 'Add', async () => {
    await post(`/api/work/allocation/${d.id}/staff-add`, { workerId: who.value, reason: reason.value });
    reload();
  });
}

function moveDialog(d, p, reload) {
  const holders = d.staff.filter((s) => p.staffIds.includes(s.id));
  const from = h('select', {}, holders.length ? holders.map((s) => h('option', { value: s.id }, s.name)) : h('option', { value: '' }, 'No one'));
  const to = h('select', {}, h('option', { value: '' }, 'Choose…'),
    d.staff.filter((s) => !p.staffIds.includes(s.id)).map((s) => h('option', { value: s.id }, `${s.name} (${s.count} now)`)));
  const reason = h('input', { type: 'text', placeholder: 'e.g. Balancing load after a new admission' });
  dialog(`Move ${p.name}`, h('div', { class: 'stack' },
    holders.length > 1 ? h('label', { class: 'field' }, 'From', from) : h('p', { class: 'small muted' }, holders.length ? `Now with ${holders[0].name}.` : 'No one has them yet.'),
    h('label', { class: 'field' }, 'To', to),
    h('label', { class: 'field' }, 'Why', reason),
  ), 'Move', async () => {
    await post(`/api/work/allocation/${d.id}/move`, { personId: p.id, workerId: from.value, toId: to.value, reason: reason.value });
    toast('Moved.');
    reload();
  });
}

const PROMPTS = {
  submit: ['Submit for review', 'Anything the reviewer should know (optional)', 'Submit', 0],
  confirm: ['Confirm this allocation', 'Anything to add (optional)', 'Confirm', 0],
  return: ['Send it back', 'What needs changing', 'Send back', 5],
  start: ['Start the shift', 'Anything to add (optional)', 'Start', 0],
  end: ['End the shift', 'Handover note, e.g. "Handed over to the afternoon shift at 15:30"', 'End', 3],
  cancel: ['Cancel this allocation', 'Why', 'Cancel it', 3],
};
const ACTION_LABELS = { submit: 'Submit for review', confirm: 'Confirm', return: 'Send back', start: 'Start the shift', end: 'End the shift', cancel: 'Cancel' };

async function runAction(d, action, reload) {
  const [title, label, confirm, min] = PROMPTS[action];
  const note = await ask({ title, label, confirm, multiline: true, minLength: min });
  if (note === null || note === undefined || (min && !note)) return;
  try {
    await post(`/api/work/allocation/${d.id}/${action}`, { note });
    reload();
  } catch (err) { showError(err); }
}

function staffTile(d, s, reload) {
  return h('div', { class: `tile alloc-staff${s.warn ? ' alloc-heavy' : ''}` },
    h('div', { class: 'spread' },
      h('div', {}, h('b', {}, s.name), h('span', { class: 'small muted' }, ` · ${s.roleLabel}`)),
      h('span', { class: `tag ${s.warn ? 'warn' : 'muted'}` }, `${s.count} patient${s.count === 1 ? '' : 's'}`)),
    s.warn ? h('div', { class: 'small alloc-warn' }, `${s.warn}. Check the load is safe.`) : null,
    !s.onRoster ? h('div', { class: 'small muted' }, `Not on the roster: ${s.reason}`) : null,
    !s.authorityOk ? h('div', { class: 'small notice' }, 'Practising certificate not current.') : null,
    d.editable ? h('button', { class: 'btn small', onclick: async () => {
      try { await post(`/api/work/allocation/${d.id}/staff-remove`, { workerId: s.id }); reload(); } catch (err) { showError(err); }
    } }, 'Remove') : null,
  );
}

function patientTile(d, p, reload) {
  const holders = d.staff.filter((s) => p.staffIds.includes(s.id));
  return h('div', { class: `tile stack alloc-patient${p.staffIds.length ? '' : ' alloc-none'}` },
    h('div', { class: 'spread' },
      h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${p.id}`) }, h('b', {}, p.name)),
        p.location ? h('span', { class: 'small muted' }, ` · ${p.location}`) : null),
      h('div', { class: 'row' }, p.status ? h('span', { class: `tag ${p.status.tone}` }, p.status.short) : null,
        d.movable ? h('button', { class: 'btn small', onclick: () => moveDialog(d, p, reload) }, 'Move') : null)),
    p.needs.length ? h('div', { class: 'chips' }, p.needs.map((n) => h('span', { class: 'chip alloc-need' }, n))) : null,
    d.editable
      ? h('div', { class: 'toggles' }, d.staff.map((s) => h('button', {
        class: 'toggle', type: 'button', 'aria-pressed': String(p.staffIds.includes(s.id)),
        onclick: async () => { try { await post(`/api/work/allocation/${d.id}/toggle`, { personId: p.id, workerId: s.id }); reload(); } catch (err) { showError(err); } },
      }, firstName(s.name))))
      : h('div', { class: 'small' }, holders.length ? h('span', {}, h('span', { class: 'muted' }, 'With '), holders.map((s) => s.name).join(' and ')) : h('b', { class: 'alloc-warn' }, 'No one allocated')),
  );
}

// One allocation in full: its staff and their load, each patient with their needs and who has them.
function planPanel(d, reload) {
  const meta = [
    `Drafted by ${d.draftedBy} ${fmtDateTime(d.draftedAt)}`,
    d.submittedAt && d.state !== 'DRAFT' ? `submitted by ${d.submittedBy}` : null,
    d.reviewedAt && ['CONFIRMED', 'ACTIVE', 'ENDED'].includes(d.state) ? `confirmed by ${d.reviewedBy}` : null,
    d.startedAt ? `started ${fmtDateTime(d.startedAt)}` : null,
    d.endedAt ? `ended by ${d.endedBy} ${fmtDateTime(d.endedAt)}` : null,
  ].filter(Boolean).join(' · ');
  return h('div', { class: 'stack' },
    h('div', { class: 'spread' }, h('span', { class: 'small muted' }, meta), h('span', { class: `tag ${TONE[d.state]}` }, d.stateLabel)),
    d.state === 'SUBMITTED' && d.submitNote ? h('div', { class: 'small' }, h('b', {}, `${d.submittedBy}: `), d.submitNote) : null,
    d.state === 'DRAFT' && d.reviewNote ? h('div', { class: 'notice' }, `Sent back by ${d.reviewedBy}: ${d.reviewNote}`) : null,
    d.state === 'CONFIRMED' && d.reviewNote ? h('div', { class: 'small' }, `${d.reviewedBy}: ${d.reviewNote}`) : null,
    d.endNote ? h('div', { class: 'small' }, `Handover: ${d.endNote}`) : null,
    h('h3', {}, `Staff (${d.staff.length})`),
    d.staff.length ? h('div', { class: 'alloc-staff-grid' }, d.staff.map((s) => staffTile(d, s, reload))) : h('div', { class: 'muted small' }, 'No one yet. Add the staff working this shift.'),
    d.editable || d.movable ? h('div', {}, h('button', { class: 'btn small', onclick: () => addStaffDialog(d, reload) }, 'Add someone')) : null,
    h('h3', {}, `Patients (${d.patients.length})`),
    d.unallocated.length ? h('div', { class: 'notice' }, `Not yet allocated: ${d.unallocated.join(', ')}.`) : null,
    d.editable && d.staff.length ? h('p', { class: 'small muted' }, 'Tap a name to give them that patient. Tap again to take it off.') : null,
    d.patients.map((p) => patientTile(d, p, reload)),
    d.moves.length ? h('details', { open: true }, h('summary', {}, `Moved during the shift (${d.moves.length})`), h('div', { class: 'stack' }, d.moves.map((m) =>
      h('div', { class: 'small' }, h('b', {}, m.patient), ` to ${m.worker}${m.fromWorker ? ` from ${m.fromWorker}` : ''}, ${fmtDateTime(m.at)}: ${m.reason}`)))) : null,
    d.actions.length ? h('div', { class: 'row' }, d.actions.map((a) =>
      h('button', { class: `btn${['submit', 'confirm', 'start'].includes(a) ? ' primary' : ''}`, onclick: () => runAction(d, a, reload) }, ACTION_LABELS[a]))) : null,
    d.state === 'SUBMITTED' && !d.actions.includes('confirm') ? h('p', { class: 'small muted' }, 'Waiting for another nurse to review it.') : null,
    d.history.length ? h('details', {}, h('summary', {}, 'History'), h('div', { class: 'stack small' }, d.history.map((x) =>
      h('div', {}, `${fmtDateTime(x.at)} · ${x.actor ?? 'SHIFT'}: ${STATE_WORDS[x.to_state] ?? x.to_state}${x.reason ? `. ${x.reason}` : ''}`)))) : null,
  );
}

function summary(d) {
  return h('div', { class: 'tile stack' },
    h('div', { class: 'spread' }, h('b', {}, d.label), h('span', { class: `tag ${TONE[d.state]}` }, d.stateLabel)),
    h('div', { class: 'small muted' }, `${d.staff.length} staff · ${d.patients.length - d.unallocated.length} of ${d.patients.length} patients allocated`),
    d.state === 'DRAFT' && d.reviewNote ? h('div', { class: 'small notice' }, `Sent back: ${d.reviewNote}`) : null,
    h('div', {}, h('button', { class: 'btn small', onclick: () => go(`/work/allocation/${d.id}`) }, 'Open')),
  );
}

// Home → Allocation.
export async function allocationView() {
  const root = h('div');
  const load = async () => {
    const d = await get('/api/work/allocation');
    const date = h('input', { type: 'date', value: d.suggest.date });
    const period = h('select', {}, d.periods.map((p) => h('option', { value: p.id, selected: p.id === d.suggest.period }, `${p.label} (${p.start} to ${p.end})`)));
    const others = d.upcoming.filter((p) => !d.toReview.some((r) => r.id === p.id));
    mount(root,
      workHeader(),
      pageTitle('Patient allocation', () => go('/work/home')),
      h('div', { class: 'banner' }, 'Which patients each nurse or caregiver has this shift. Draft it from the roster, have another nurse check it, start it at the beginning of the shift and end it at handover.'),
      h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, 'In use now'),
        d.active ? h('div', { class: 'card stack' }, h('h3', {}, d.active.label), planPanel(d.active, load)) : h('div', { class: 'card empty' }, 'No allocation is in use for this service.')),
      h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `To review (${d.toReview.length})`),
        d.toReview.length ? d.toReview.map(summary) : h('div', { class: 'card empty' }, 'Nothing waiting for your review.')),
      h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `Coming up (${others.length})`),
        others.length ? others.map(summary) : h('div', { class: 'card empty' }, 'Nothing being prepared.')),
      d.canPlan ? h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, 'Plan a shift'),
        h('form', { class: 'card stack', onsubmit: async (e) => {
          e.preventDefault();
          try {
            const p = await post('/api/work/allocation', { date: date.value, period: period.value });
            go(`/work/allocation/${p.id}`);
          } catch (err) { showError(err); }
        } },
          h('div', { class: 'row' }, h('label', { class: 'field' }, 'Date', date), h('label', { class: 'field grow' }, 'Shift', period)),
          h('p', { class: 'small muted' }, 'SHIFT starts it with the staff rostered for that shift and, where the same people are working, the patients they have now.'),
          h('div', {}, h('button', { class: 'btn primary', type: 'submit' }, 'Start a draft')))) : null,
    );
  };
  await load();
  return root;
}

// Home → Allocation → one shift.
export async function allocationPlanView(id) {
  const root = h('div');
  const load = async () => {
    const d = await get(`/api/work/allocation/${id}`);
    mount(root, workHeader(), pageTitle(d.label, () => go('/work/allocation')), h('div', { class: 'card' }, planPanel(d, load)));
  };
  await load();
  return root;
}


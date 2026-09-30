import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDate, fmtDateTime } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// MDT meetings and case conferences: planned with who is asked → held: who came, what was looked
// at, what was discussed, decisions with an action, a person and a due date → closed at follow-up.
// An action given to a colleague is a task in their own list; its tick comes from that task.
const LABEL = { hold: 'Record the meeting', cancel: 'Cancel', close: 'Close' };
const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const inDays = (n) => localDay(new Date(Date.now() + n * 86_400_000));
const checks = (items, ticked = () => false) => items.map((x) => {
  const box = h('input', { type: 'checkbox', value: x.id, checked: ticked(x) });
  return { box, el: h('label', { class: 'check' }, box, ` ${x.label}`) };
});
const ticked = (list) => list.filter((c) => c.box.checked).map((c) => c.box.value);

function planDialog(personId, s, reload) {
  const o = s.options;
  const kind = select(Object.entries(o.kinds), 'Kind of meeting');
  const reason = h('textarea', { 'aria-label': 'Why it is needed', placeholder: 'e.g. Plan for going home; family worried about stairs' });
  const when = h('input', { type: 'datetime-local', 'aria-label': 'When', value: `${inDays(1)}T10:00` });
  const invite = checks(o.colleagues.map((c) => ({ id: c.id, label: `${c.name}, ${c.role} (${c.service})` })));
  const others = h('input', { 'aria-label': 'Others asked', placeholder: 'Optional, e.g. Daughter Mere; GP Dr Patel by phone' });
  dialog('Plan a meeting', h('div', { class: 'stack' },
    field('Kind of meeting', kind), field('Why it is needed', reason), field('When', when),
    h('fieldset', { class: 'stack' }, h('legend', { class: 'small' }, 'Colleagues asked to come (you are included)'), invite.map((c) => c.el)),
    field('Others asked', others),
  ), 'Plan it', async () => {
    await post(`/api/work/patients/${personId}/conferences`, { kind: kind.value, reason: reason.value, when: when.value, invite: ticked(invite), others: others.value });
    toast('Meeting planned.');
    reload();
  }, { wide: true });
}

function actionRow(colleagues) {
  const decision = h('input', { 'aria-label': 'Decision', placeholder: 'e.g. Home with a walker once stairs are safe' });
  const action = h('input', { 'aria-label': 'Action', placeholder: 'e.g. Stairs practice and walker fitting' });
  const owner = select([...colleagues.map((c) => [c.id, `${c.name}, ${c.role}`]), ['other', 'Someone else…']], 'Who will do it');
  const ownerLabel = h('input', { 'aria-label': 'Who else', placeholder: 'e.g. Daughter Mere, or GP Dr Patel' });
  const due = h('input', { type: 'date', 'aria-label': 'Due by', value: inDays(7) });
  const other = field('Who else', ownerLabel);
  other.hidden = true;
  owner.addEventListener('change', () => { other.hidden = owner.value !== 'other'; });
  const el = h('div', { class: 'tile stack' }, field('Decision', decision), field('What will be done', action), field('Who will do it', owner), other, field('Due by', due));
  return { el, value: () => ({ decision: decision.value, action: action.value, owner: owner.value === 'other' ? '' : owner.value, ownerLabel: owner.value === 'other' ? ownerLabel.value : '', due: due.value }) };
}

function holdDialog(x, o, reload) {
  const invitedIds = new Set(x.invited.map((p) => p.id));
  const people = [...x.invited.map((p) => ({ id: p.id, label: p.name })), ...o.colleagues.filter((c) => !invitedIds.has(c.id)).map((c) => ({ id: c.id, label: `${c.name}, ${c.role} (not asked)` }))];
  const came = checks(people, (p) => invitedIds.has(p.id));
  const patientThere = select([['yes', 'Yes'], ['no', 'No']], 'Were they there');
  const othersThere = h('input', { 'aria-label': 'Others there', placeholder: 'e.g. Daughter Mere; GP by phone', value: x.othersInvited ?? '' });
  const looked = checks(o.evidence.map((e) => ({ id: e.id, label: `${fmtDateTime(e.at)}: ${e.text}` })));
  const evidenceNote = h('input', { 'aria-label': 'Anything else looked at', placeholder: 'Optional, e.g. Home visit report from the OT' });
  const discussion = h('textarea', { 'aria-label': 'What was discussed', placeholder: 'e.g. Walking 20 m with a frame. Mere can stay for the first week. Stairs are the worry.' });
  const rows = [actionRow(o.colleagues)];
  const list = h('div', { class: 'stack' }, rows[0].el);
  const more = h('button', { class: 'btn small', type: 'button', onclick: () => { const r = actionRow(o.colleagues); rows.push(r); list.append(r.el); } }, 'Add another decision');
  const followUp = h('input', { type: 'date', 'aria-label': 'Follow up on', value: inDays(14) });
  dialog(`Record the ${x.kindLabel.toLowerCase()}`, h('div', { class: 'stack' },
    h('fieldset', { class: 'stack' }, h('legend', { class: 'small' }, 'Who came'), came.map((c) => c.el)),
    field('Were they there themselves', patientThere), field('Others there', othersThere),
    looked.length ? h('fieldset', { class: 'stack' }, h('legend', { class: 'small' }, 'Record entries looked at'), looked.map((c) => c.el)) : null,
    field('Anything else looked at', evidenceNote), field('What was discussed', discussion),
    h('h3', {}, 'Decisions and actions'), list, more,
    h('p', { class: 'small muted' }, 'An action given to a colleague goes into their tasks.'),
    field('Follow up on', followUp),
  ), 'Save', async () => {
    await post(`/api/work/conferences/${x.id}/hold`, {
      attended: ticked(came), patientThere: patientThere.value, othersThere: othersThere.value, evidence: ticked(looked), evidenceNote: evidenceNote.value,
      discussion: discussion.value, actions: rows.map((r) => r.value()), followUp: followUp.value,
    });
    toast('Meeting recorded.');
    reload();
  }, { wide: true });
}

function noteDialog(x, action, reload) {
  const note = h('textarea', { 'aria-label': 'Note' });
  if (action === 'cancel') note.placeholder = 'e.g. Family could not come; moved to Friday';
  else note.placeholder = x.openActions ? 'Required: what happens to the actions not done' : 'Optional';
  dialog(action === 'cancel' ? 'Cancel the meeting' : 'Close the meeting', h('div', { class: 'stack' },
    action === 'close' && x.openActions ? h('p', { class: 'small warn-text' }, `${x.openActions} action${x.openActions === 1 ? ' is' : 's are'} not done yet.`) : null,
    field(action === 'cancel' ? 'Why' : 'Note', note)), action === 'cancel' ? 'Cancel meeting' : 'Close', async () => {
    await post(`/api/work/conferences/${x.id}/${action}`, { note: note.value });
    toast('Saved.');
    reload();
  });
}

function doneDialog(a, reload) {
  const note = h('textarea', { 'aria-label': 'What happened', placeholder: 'e.g. Daughter brought her glasses in' });
  dialog('Mark done', h('div', { class: 'stack' }, h('p', { class: 'small' }, a.action), field('What happened', note)), 'Done', async () => {
    await post(`/api/work/conference-actions/${a.id}/done`, { note: note.value });
    toast('Saved.');
    reload();
  });
}

function actionItem(a, reload) {
  const status = a.done ? h('span', { class: 'tag ok' }, 'Done') : a.cancelled ? h('span', { class: 'tag' }, 'Task cancelled')
    : a.overdue ? h('span', { class: 'tag warn' }, 'Overdue') : h('span', { class: 'tag' }, a.viaTask ? 'In their tasks' : 'Open');
  return h('li', { class: 'stack conference-action' },
    h('div', { class: 'spread' }, h('b', {}, a.decision), status),
    h('div', { class: 'small' }, `${a.action} · ${a.ownerIsMe ? 'You' : a.owner} · by ${fmtDate(a.dueOn)}`),
    a.outcome ? h('div', { class: 'small muted' }, `Outcome: ${a.outcome}`) : null,
    a.canMarkDone ? h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => doneDialog(a, reload) }, 'Mark done')) : null,
  );
}

function conferenceCard(x, o, reload) {
  const tone = x.state === 'PLANNED' ? '' : x.state === 'HELD' ? (x.openActions ? 'warn' : 'ok') : '';
  const came = x.invited.filter((p) => p.attended).map((p) => p.name);
  return h('div', { class: 'tile stack conference' },
    h('div', { class: 'spread' }, h('b', {}, `${x.kindLabel} · ${fmtDateTime(x.heldAt ?? x.plannedFor)}`), h('span', { class: `tag ${tone}` }, x.stateLabel)),
    h('div', { class: 'small' }, h('b', {}, 'Why: '), x.reason),
    x.state === 'PLANNED' || x.state === 'CANCELLED'
      ? h('div', { class: 'small muted' }, `Asked: ${[...x.invited.map((p) => p.name), x.othersInvited].filter(Boolean).join(', ')} · planned by ${x.plannedBy} (${x.service})`)
      : h('div', { class: 'small muted' }, `There: ${[...came, x.patientThere === 1 ? 'them' : null, x.othersThere].filter(Boolean).join(', ')} · led by ${x.ledBy} (${x.service})`),
    x.discussion ? h('div', { class: 'small' }, h('b', {}, 'Discussed: '), x.discussion) : null,
    x.evidence.length || x.evidenceNote ? h('details', {}, h('summary', { class: 'small' }, `Looked at (${x.evidence.length + (x.evidenceNote ? 1 : 0)})`),
      h('ul', { class: 'small' }, x.evidence.map((e) => h('li', {}, `${fmtDateTime(e.at)}: ${e.text}`)), x.evidenceNote ? h('li', {}, x.evidenceNote) : null)) : null,
    x.actions.length ? h('ol', { class: 'stack conference-actions' }, x.actions.map((a) => actionItem(a, reload))) : null,
    x.followUpOn && x.state === 'HELD' ? h('div', { class: `small${x.followUpDue ? ' warn-text' : ' muted'}` }, `Follow up on ${fmtDate(x.followUpOn)}`) : null,
    x.closeNote ? h('div', { class: 'small muted' }, `${x.state === 'CANCELLED' ? 'Cancelled' : 'Closed'}: ${x.closeNote}`) : null,
    x.acts.length ? h('div', { class: 'row' }, x.acts.map((a) => h('button', {
      class: `btn small${a === 'hold' || (a === 'close' && x.followUpDue) ? ' primary' : ''}`,
      onclick: () => (a === 'hold' ? holdDialog(x, o, reload) : noteDialog(x, a, reload)),
    }, LABEL[a]))) : null,
    h('details', {}, h('summary', { class: 'small' }, `History (${x.steps.length})`),
      h('ol', { class: 'det-steps' }, x.steps.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`), h('div', { class: 'small' }, s.body))))),
  );
}

// In the care plan, the doctor's Review and the physio's Goals.
export function conferencesPanel(personId, s, reload) {
  if (!s) return null;
  return h('section', { class: 'stack' },
    h('div', { class: 'spread' }, h('h3', {}, s.title),
      s.canPlan ? h('button', { class: 'btn small', onclick: () => planDialog(personId, s, reload) }, 'Plan a meeting') : null),
    s.current.length ? s.current.map((x) => conferenceCard(x, s.options, reload)) : h('div', { class: 'empty' }, 'No meetings planned or open.'),
    s.past.length ? h('details', {}, h('summary', { class: 'small' }, `Earlier meetings (${s.past.length})`), h('div', { class: 'stack' }, s.past.map((x) => conferenceCard(x, s.options, reload)))) : null,
  );
}

import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDateTime } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Handover of responsibility: given to a named colleague → questions → accepted (responsibility
// moves) or not accepted (it stays with the giver) → or withdrawn.
const LABEL = { accept: 'Accept', ask: 'Ask a question', decline: 'Cannot take over', answer: 'Answer', withdraw: 'Withdraw' };

function giveDialog(personId, s, reload) {
  const to = select(s.receivers.map((r) => [r.id, r.name]), 'Handing over to');
  const situation = h('textarea', { 'aria-label': 'How they are now', placeholder: 'e.g. Settled overnight, obs stable, pain 2/10' });
  const background = h('textarea', { 'aria-label': 'Background', placeholder: 'Optional: why they are here and what has happened' });
  const watch = h('textarea', { 'aria-label': 'What to watch', placeholder: 'Optional: what worries you, and when to call a doctor' });
  const todo = h('textarea', { 'aria-label': 'What needs doing', placeholder: 'e.g. Bloods at 10; family meeting at 2' });
  dialog('Hand over', h('div', { class: 'stack' },
    field('Handing over to', to), field('How they are now', situation), field('Background', background), field('What to watch', watch), field('What needs doing', todo),
    h('p', { class: 'small muted' }, 'You stay responsible until they accept.'),
  ), 'Hand over', async () => {
    await post(`/api/work/patients/${personId}/handovers`, { to: to.value, situation: situation.value, background: background.value, watch: watch.value, todo: todo.value });
    toast('Handed over. You are still responsible until they accept.');
    reload();
  });
}

function actDialog(x, action, reload) {
  const note = h('textarea', { 'aria-label': 'Note' });
  const send = async () => { await post(`/api/work/handovers/${x.id}/${action}`, { note: note.value }); toast('Saved.'); reload(); };
  if (action === 'accept' || action === 'withdraw') {
    note.placeholder = 'Optional';
    return dialog(action === 'accept' ? `Take over from ${x.from}` : 'Withdraw handover', h('div', { class: 'stack' },
      action === 'accept' ? h('p', { class: 'small' }, `You become responsible for ${x.patient} now.`) : null, field('Note', note)),
    action === 'accept' ? 'Accept' : 'Withdraw', send);
  }
  note.placeholder = { ask: 'Your question', answer: 'Your answer', decline: 'e.g. Already have six patients; ask the charge nurse' }[action];
  return dialog(LABEL[action], h('div', { class: 'stack' }, field(action === 'decline' ? 'Why' : LABEL[action], note)), 'Save', send);
}

export function handoverCard(x, reload, showPatient) {
  return h('div', { class: 'tile stack person-handover' },
    h('div', { class: 'spread' }, h('b', {}, `${showPatient ? `${x.patient}${x.location ? ` · ${x.location}` : ''}: ` : ''}${x.from} to ${x.to}`),
      h('span', { class: `tag ${x.state === 'ACCEPTED' ? 'ok' : ['GIVEN', 'QUESTION'].includes(x.state) ? 'warn' : ''}` }, x.stateLabel)),
    h('div', { class: 'small' }, h('b', {}, 'Now: '), x.situation),
    x.background ? h('div', { class: 'small' }, h('b', {}, 'Background: '), x.background) : null,
    x.watch ? h('div', { class: 'small' }, h('b', {}, 'Watch for: '), x.watch) : null,
    h('div', { class: 'small' }, h('b', {}, 'To do: '), x.todo),
    h('div', { class: 'small muted' }, `Given ${fmtDateTime(x.givenAt)}${x.acceptedAt ? ` · accepted ${fmtDateTime(x.acceptedAt)}` : ''}`),
    x.steps.length > 1 ? h('ol', { class: 'det-steps' }, x.steps.slice(1).map((s) => h('li', { class: 'det-step' },
      h('div', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`), h('div', { class: 'small' }, s.body)))) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${a === 'accept' || a === 'answer' ? ' primary' : ''}`, onclick: () => actDialog(x, a, reload) }, LABEL[a]))) : null,
  );
}

// At the top of the person's Handover view.
export function handoversPanel(personId, s, reload) {
  if (!s) return null;
  return h('section', { class: 'stack' },
    h('div', { class: 'spread' }, h('h3', {}, 'Who is responsible'),
      s.canGive && s.receivers.length ? h('button', { class: 'btn small', onclick: () => giveDialog(personId, s, reload) }, 'Hand over') : null),
    s.open ? handoverCard(s.open, reload) : null,
    !s.open && s.responsible ? h('div', { class: 'small' }, h('b', {}, `${s.responsible.name}`), ` since ${fmtDateTime(s.responsible.since)}, when they accepted the handover from ${s.responsible.from}.`) : null,
    !s.open && !s.responsible ? h('div', { class: 'small muted' }, 'No handover recorded here yet.') : null,
    s.past.length ? h('details', {}, h('summary', { class: 'small' }, `Earlier handovers (${s.past.length})`), h('div', { class: 'stack' }, s.past.map((x) => handoverCard(x, reload)))) : null,
  );
}

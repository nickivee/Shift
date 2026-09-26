import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, ask, pageTitle, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';

// Communication: what needs saying → to whom → how → each attempt → got through or not →
// what was conveyed → their response → follow-up → completed.
const STEPS = ['REQUIRED', 'ATTEMPTED', 'CONVEYED', 'FOLLOW_UP', 'COMPLETED'];
const LABEL = { REQUIRED: 'To do', ATTEMPTED: 'Tried', CONVEYED: 'Got through', FOLLOW_UP: 'Follow-up', COMPLETED: 'Done', CANCELLED: 'Cancelled' };
const TONE = { REQUIRED: 'warn', ATTEMPTED: 'warn', FOLLOW_UP: 'warn', COMPLETED: 'ok', CANCELLED: 'muted' };
const OPEN = ['REQUIRED', 'ATTEMPTED', 'FOLLOW_UP'];

function steps(c) {
  if (c.state === 'CANCELLED') return null;
  const list = STEPS.filter((s) => (s !== 'ATTEMPTED' || c.attempts.some((a) => a.outcome !== 'CONVEYED') || c.state === 'REQUIRED')
    && (s !== 'FOLLOW_UP' || c.followUp || OPEN.includes(c.state)));
  const at = list.indexOf(c.state);
  return h('ol', { class: 'steps' }, list.map((s, i) => h('li', { class: i < at || c.state === 'COMPLETED' ? 'done' : i === at ? 'now' : '' }, LABEL[s])));
}

function dialog(title, body, submitLabel, onSubmit) {
  const error = h('p', { class: 'small notice', hidden: true });
  const dlg = h('dialog', {},
    h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      try { await onSubmit(); dlg.close(); dlg.remove(); } catch (err) { error.textContent = err?.message ?? 'Something went wrong.'; error.hidden = false; }
    } },
      h('h2', {}, title), body, error,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'submit' }, submitLabel),
        h('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); dlg.remove(); } }, 'Cancel'),
      ),
    ),
  );
  dlg.addEventListener('cancel', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

const select = (options, value) => {
  const s = h('select', {}, Object.entries(options).map(([k, v]) => h('option', { value: k }, v)));
  if (value) s.value = value;
  return s;
};

function attemptDialog(c, options, reload) {
  const method = select(options.methods, c.method);
  const outcome = select(options.outcomes, 'CONVEYED');
  const note = h('input', { type: 'text', placeholder: 'Optional' });
  const conveyed = h('textarea', { placeholder: 'What you told them' });
  const response = h('textarea', { placeholder: 'What they said or asked' });
  const followUp = h('input', { type: 'text', placeholder: 'Leave empty if nothing else is needed' });
  const through = h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'What you conveyed', conveyed),
    h('label', { class: 'field' }, 'Their response', response),
    h('label', { class: 'field' }, 'Follow-up needed', followUp),
  );
  const sync = () => { through.hidden = outcome.value !== 'CONVEYED'; };
  outcome.addEventListener('change', sync);
  dialog(`Contact ${c.recipient}`, h('div', { class: 'stack' },
    c.contact ? h('p', { class: 'muted' }, `${c.methodLabel}: ${c.contact}${c.language ? ` · interpreter: ${c.language}` : ''}`) : null,
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'How', method), h('label', { class: 'field grow' }, 'What happened', outcome)),
    through,
    h('label', { class: 'field' }, 'Note', note),
  ), 'Save', async () => {
    await post(`/api/work/communications/${c.id}/attempt`, {
      method: method.value, outcome: outcome.value, note: note.value, conveyed: conveyed.value, response: response.value, followUp: followUp.value,
    });
    toast(outcome.value === 'CONVEYED' ? (followUp.value.trim() ? 'Recorded. Follow-up still open.' : 'Recorded and done.') : 'Attempt recorded.');
    reload();
  });
  sync();
}

async function doAction(c, action, options, reload) {
  if (action === 'attempt') return attemptDialog(c, options, reload);
  const note = await ask(action === 'complete'
    ? { title: 'Finish the follow-up', message: c.followUp, label: 'What was done', confirm: 'Done', multiline: true, minLength: 3 }
    : { title: 'Cancel this communication', message: 'It will show as cancelled with your reason.', label: 'Reason', confirm: 'Cancel it', multiline: true, minLength: 3 });
  if (!note) return;
  try {
    await post(`/api/work/communications/${c.id}/${action}`, { note });
    toast(action === 'complete' ? 'Done.' : 'Cancelled.');
    reload();
  } catch (err) { showError(err); }
}

const ACTION = { attempt: ['Record contact', true], complete: ['Finish follow-up', true], cancel: ['Cancel', false] };

export function communicationCard(c, options, reload, { showPatient = true } = {}) {
  return h('div', { class: 'tile stack' },
    h('div', { class: 'spread' },
      h('div', {},
        showPatient ? h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${c.personId}/communications`) }, h('b', {}, c.patient)) : null,
        h('div', { class: showPatient ? 'muted' : '' }, [showPatient ? c.location : null, `${c.kindLabel}: ${c.recipient}`].filter(Boolean).join(' · ')),
      ),
      h('div', { class: 'row' },
        c.overdue ? h('span', { class: 'tag danger' }, 'Overdue') : null,
        h('span', { class: `tag ${TONE[c.state] ?? ''}` }, LABEL[c.state]),
      ),
    ),
    h('div', {}, h('b', {}, c.purpose)),
    h('div', { class: 'small' }, [
      `${c.methodLabel}${c.contact ? ` ${c.contact}` : ''}`,
      c.language ? `interpreter: ${c.language}` : null,
      c.dueAt ? `by ${fmtDateTime(c.dueAt)}` : null,
    ].filter(Boolean).join(' · ')),
    c.disclosure ? h('div', { class: 'small muted' }, `Sharing outside the care team: ${c.sharingLabel}. The legal rules for this disclosure are still being researched (RR-DISC-001).`) : null,
    steps(c),
    c.attempts.length ? h('ul', { class: 'small stack' }, c.attempts.map((a) => h('li', {}, `${fmtDateTime(a.at)} · ${a.by} · ${a.methodLabel}: `, h('b', {}, a.outcomeLabel), a.note ? ` (${a.note})` : ''))) : null,
    c.conveyed ? h('div', { class: 'summary' }, h('b', {}, 'Conveyed: '), c.conveyed, c.response ? h('div', {}, h('b', {}, 'Response: '), c.response) : null) : null,
    c.followUp ? h('div', { class: 'small' }, h('b', {}, 'Follow-up: '), c.followUp) : null,
    c.completionNote ? h('div', { class: 'small' }, h('b', {}, `${LABEL[c.state]} (${c.completedBy}): `), c.completionNote) : null,
    h('div', { class: 'small muted' }, `Needed by ${c.createdBy}, ${fmtDateTime(c.createdAt)}`),
    c.actions.length ? h('div', { class: 'row' }, c.actions.map((x) =>
      h('button', { class: `btn small${ACTION[x][1] ? ' primary' : ''}`, onclick: () => doAction(c, x, options, reload) }, ACTION[x][0]))) : null,
  );
}

// The patient's Communications view inside the Live Workstation.
export function communicationsPanel(personId, d, reload) {
  const form = () => {
    const purpose = h('textarea', { placeholder: 'What needs to be communicated' });
    const kind = select(d.options.kinds, 'WHANAU');
    const recipient = h('input', { type: 'text', placeholder: 'Name and relationship, or service' });
    const contact = h('input', { type: 'text', placeholder: 'Phone number, email or address' });
    const method = select(d.options.methods, 'PHONE');
    const language = h('input', { type: 'text', placeholder: 'Language, if an interpreter is needed' });
    const sharing = select(d.options.sharing, 'AGREED');
    const due = h('input', { type: 'datetime-local' });
    const sharingField = h('label', { class: 'field' }, "Patient's view on sharing", sharing);
    const sync = () => { sharingField.hidden = !['WHANAU', 'EXTERNAL_PROVIDER'].includes(kind.value); };
    kind.addEventListener('change', sync);
    sync();
    return h('form', { class: 'tile stack', onsubmit: async (e) => {
      e.preventDefault();
      try {
        await post(`/api/work/patients/${personId}/communications`, {
          purpose: purpose.value, kind: kind.value, recipient: recipient.value, contact: contact.value, method: method.value,
          language: language.value, sharing: sharing.value, due: due.value,
        });
        toast('Added to your service\'s communications.');
        reload();
      } catch (err) { showError(err); }
    } },
      h('h3', {}, 'Someone needs to be told'),
      h('label', { class: 'field' }, 'What', purpose),
      h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Who', kind), h('label', { class: 'field grow' }, 'How', method)),
      h('label', { class: 'field' }, 'Name', recipient),
      h('label', { class: 'field' }, 'Contact', contact),
      sharingField,
      h('label', { class: 'field' }, 'Interpreter', language),
      h('label', { class: 'field' }, 'By when (optional)', due),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Add')),
    );
  };
  return h('div', { class: 'stack' },
    d.communications.length ? d.communications.map((c) => communicationCard(c, d.options, reload, { showPatient: false }))
      : h('div', { class: 'empty' }, 'No communications for this patient.'),
    d.canCreate ? form() : null,
  );
}

// Home → Communications.
export async function communicationsView() {
  const root = h('div');
  const load = async () => {
    const { communications: rows, options } = await get('/api/work/communications');
    const todo = rows.filter((c) => c.state === 'REQUIRED' || c.state === 'ATTEMPTED');
    const follow = rows.filter((c) => c.state === 'FOLLOW_UP');
    const done = rows.filter((c) => !OPEN.includes(c.state));
    const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, title),
      list.length ? list.map((c) => communicationCard(c, options, load)) : h('div', { class: 'card empty' }, empty));
    mount(root,
      workHeader(),
      pageTitle('Communications', () => go('/work/home')),
      section('To contact', todo, 'No one waiting to be contacted.'),
      follow.length ? section('Follow-up', follow, '') : null,
      done.length ? section('Done today', done, '') : null,
    );
  };
  await load();
  return root;
}

import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, ask, pageTitle, fmtDate, fmtDateTime } from '../lib/ui.js';
import { go, state } from '../app.js';
import { workHeader } from './entry.js';

// Information from other providers: received → matched to the right person → source and
// integrity kept → available in the record → read by a clinician → acted on or kept for
// reference → replaced when the source sends a newer version.
const RULE = 'It joins a record only when two identifiers agree. What arrived is kept exactly as received.';
const NOT_OURS = 'Held here, out of every record. Whether to return, forward or destroy it is still being researched (RR-IMPORT-001).';
const STATE_TONE = { RECEIVED: 'danger', MATCHED: 'warn', INCORPORATED: 'ok', REFERENCED: 'ok', NOT_OURS: 'muted', SUPERSEDED: 'muted' };

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
  if (value !== undefined && value !== null) s.value = value;
  return s;
};

// The fields for something received: who sent it, what it is, and who it says it is about.
function receivedFields(options) {
  const f = {
    sourceOrg: h('input', { type: 'text', placeholder: 'e.g. Te Awa Hospital, Ward 3' }),
    sourceAuthor: h('input', { type: 'text', placeholder: 'Who wrote it (optional)' }),
    kind: select(options.kinds, 'DISCHARGE_SUMMARY'),
    channel: select(options.channels, 'ELECTRONIC'),
    writtenAt: h('input', { type: 'date' }),
    title: h('input', { type: 'text', placeholder: 'e.g. Discharge summary, 12 September' }),
    content: h('textarea', { rows: 6, placeholder: 'Paste or type it exactly as it came' }),
    statedName: h('input', { type: 'text', placeholder: 'Name as written on it' }),
    statedNhi: h('input', { type: 'text', placeholder: 'NHI as written on it' }),
    statedDob: h('input', { type: 'date' }),
  };
  const body = h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'From', f.sourceOrg), h('label', { class: 'field grow' }, 'Written by', f.sourceAuthor)),
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'What it is', f.kind), h('label', { class: 'field grow' }, 'How it came', f.channel), h('label', { class: 'field grow' }, 'Written on', f.writtenAt)),
    h('label', { class: 'field' }, 'Title', f.title),
    h('label', { class: 'field' }, 'What it says', f.content),
    h('p', { class: 'small muted' }, 'Who it is about, exactly as the sender wrote it. Do not copy from our record.'),
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Name', f.statedName), h('label', { class: 'field grow' }, 'NHI', f.statedNhi), h('label', { class: 'field grow' }, 'Date of birth', f.statedDob)),
  );
  const values = () => Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
  return { body, values };
}

function reviewDialog(x, reload) {
  const summary = h('textarea', { placeholder: 'What matters in it for their care' });
  const outcome = select({ INCORPORATED: 'I acted on it', REFERENCED: 'Keep it for reference' }, 'INCORPORATED');
  const note = h('input', { type: 'text', placeholder: 'e.g. Medicines chart updated to the new doses' });
  const noteField = h('label', { class: 'field' }, 'What you changed', note);
  outcome.addEventListener('change', () => { noteField.hidden = outcome.value !== 'INCORPORATED'; });
  dialog(`Review: ${x.title}`, h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'Summary', summary),
    h('label', { class: 'field' }, 'Outcome', outcome), noteField,
  ), 'Save review', async () => {
    await post(`/api/work/external/${x.id}/review`, { summary: summary.value, outcome: outcome.value, outcomeNote: note.value });
    toast('Reviewed.');
    reload();
  });
}

function updateDialog(x, reload) {
  const title = h('input', { type: 'text', value: x.title });
  const writtenAt = h('input', { type: 'date' });
  const content = h('textarea', { rows: 6, placeholder: 'Paste or type the newer version exactly as it came' });
  dialog(`Newer version from ${x.sourceOrg}`, h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'Title', title),
    h('label', { class: 'field' }, 'Written on', writtenAt),
    h('label', { class: 'field' }, 'What it says now', content),
    h('p', { class: 'small muted' }, 'The version here now is kept as an earlier version. The newer one needs reading again.'),
  ), 'Save newer version', async () => {
    await post(`/api/work/external/${x.id}/update`, { title: title.value, writtenAt: writtenAt.value, content: content.value });
    toast('Newer version saved. It is waiting for review.');
    reload();
  });
}

async function doAction(x, action, reload, personId) {
  if (action === 'review') return reviewDialog(x, reload);
  if (action === 'update') return updateDialog(x, reload);
  if (action === 'match') {
    try {
      await post(`/api/work/external/${x.id}/match`, { personId });
      toast('Matched. It is now in their record, waiting for review.');
      reload();
    } catch (err) { showError(err); }
    return;
  }
  const note = await ask({ title: `Not ours: ${x.title}`, message: NOT_OURS, label: 'Why it is not about anyone here', confirm: 'Not ours', multiline: true, minLength: 5 });
  if (!note) return;
  try {
    await post(`/api/work/external/${x.id}/notOurs`, { note });
    toast('Set aside. It will not appear in any record.');
    reload();
  } catch (err) { showError(err); }
}

const ACTION = { review: ['Review', true], update: ['Newer version', false], notOurs: ['Not ours', false] };

function candidateRow(x, c, reload) {
  return h('div', { class: 'candidate spread' },
    h('div', { class: 'small' }, h('b', {}, c.name), ` · NHI ${c.nhi ?? 'none'} · born ${fmtDate(c.dob)}`,
      h('div', {}, h('span', { class: 'tag ok' }, `Agrees: ${c.agreeLabel}`), c.differLabel ? h('span', { class: 'tag danger' }, `Differs: ${c.differLabel}`) : null)),
    c.enough ? h('button', { class: 'btn small primary', onclick: () => doAction(x, 'match', reload, c.personId) }, 'Match')
      : h('span', { class: 'small muted' }, 'Not enough to match'),
  );
}

export function itemCard(x, reload, showPatient) {
  return h('div', { class: `tile stack external${x.state === 'RECEIVED' ? ' external-unmatched' : ''}` },
    h('div', { class: 'spread' },
      h('div', {},
        showPatient && x.patient ? h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/external`) }, h('b', {}, x.patient)) : null,
        h('div', {}, h('b', {}, x.title)),
        h('div', { class: 'small muted' }, [x.kindLabel, `from ${x.sourceOrg}`, x.sourceAuthor, x.writtenAt ? `written ${fmtDate(x.writtenAt)}` : null, x.channelLabel].filter(Boolean).join(' · '))),
      h('span', { class: `tag ${STATE_TONE[x.state] ?? ''}` }, x.stateLabel),
    ),
    h('div', { class: 'small' }, h('b', {}, 'Sent for: '), [x.statedName, x.statedNhi ? `NHI ${x.statedNhi}` : null, x.statedDob ? `born ${fmtDate(x.statedDob)}` : null].filter(Boolean).join(', ')),
    x.matchedBy ? h('div', { class: 'small' }, h('b', {}, 'Matched: '), `by ${x.matchedBy} ${fmtDateTime(x.matchedAt)} on ${x.matchLabel}`) : null,
    x.reviewSummary ? h('div', { class: 'small' }, h('b', {}, `Reviewed by ${x.reviewedBy}: `), x.reviewSummary) : null,
    x.outcomeNote ? h('div', { class: 'small' }, h('b', {}, 'Changed: '), x.outcomeNote) : null,
    x.notOursReason ? h('div', { class: 'small' }, h('b', {}, `Not ours (${x.notOursBy}): `), x.notOursReason, h('div', { class: 'muted' }, NOT_OURS)) : null,
    h('details', {}, h('summary', { class: 'small' }, 'Read it as received'), h('div', { class: 'summary small' }, x.content)),
    h('div', { class: `small ${x.intact ? 'muted' : 'notice'}` }, x.intact
      ? `Unchanged since received by ${x.receivedBy} ${fmtDateTime(x.receivedAt)} (check ${x.hashShort})`
      : 'This no longer matches what was received. Tell your manager.'),
    x.candidates?.length ? h('div', { class: 'stack' }, h('div', { class: 'small' }, h('b', {}, 'Who it might be about')), x.candidates.map((c) => candidateRow(x, c, reload)))
      : x.state === 'RECEIVED' ? h('div', { class: 'small muted' }, 'No one in this service matches it.') : null,
    x.earlier?.length ? h('details', {}, h('summary', { class: 'small' }, `Earlier versions (${x.earlier.length})`),
      h('div', { class: 'stack' }, x.earlier.map((e) => itemCard(e, reload, false)))) : null,
    x.actions.filter((a) => ACTION[a]).length ? h('div', { class: 'row' }, x.actions.filter((a) => ACTION[a]).map((a) =>
      h('button', { class: `btn small${ACTION[a][1] ? ' primary' : ''}`, onclick: () => doAction(x, a, reload) }, ACTION[a][0]))) : null,
  );
}

function receiveForm(url, options, reload, label) {
  const f = receivedFields(options);
  return h('form', { class: 'tile stack', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await post(url, f.values());
      toast('Received.');
      reload();
    } catch (err) { showError(err); }
  } }, h('h3', {}, label), f.body, h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save as received')));
}

// The person's "From other providers" view inside the Live Workstation.
export function externalPanel(personId, d, reload) {
  const subject = state.me.context.subjectLabel.toLowerCase();
  const toReview = d.items.filter((x) => x.state === 'MATCHED');
  const rest = d.items.filter((x) => x.state !== 'MATCHED');
  return h('div', { class: 'stack' },
    h('p', { class: 'small muted' }, RULE),
    toReview.length ? h('section', { class: 'stack' }, h('h3', {}, `To review (${toReview.length})`), toReview.map((x) => itemCard(x, reload, false))) : null,
    rest.length ? rest.map((x) => itemCard(x, reload, false))
      : toReview.length ? null : h('div', { class: 'empty' }, `Nothing from other providers for this ${subject} yet.`),
    d.canManage ? h('details', {}, h('summary', {}, 'Add information received for them'),
      receiveForm(`/api/work/patients/${personId}/external`, d.options, reload, 'Add information received')) : null,
  );
}

// Home → From other providers.
export async function externalView() {
  const root = h('div');
  const load = async () => {
    const d = await get('/api/work/external');
    const section = (title, items, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${items.length})`),
      items.length ? items.map((x) => itemCard(x, load, true)) : h('div', { class: 'card empty' }, empty));
    mount(root,
      workHeader(),
      pageTitle('From other providers', () => go('/work/home')),
      h('div', { class: 'banner' }, 'Letters, summaries and results sent to this service. ', RULE),
      section('Not matched', d.inbox, 'Nothing waiting to be matched.'),
      section('To review', d.toReview, 'Nothing waiting for review.'),
      h('details', {}, h('summary', {}, 'Add something received'), receiveForm('/api/work/external', d.options, load, 'Add something received')),
      d.done.length ? h('details', {}, h('summary', {}, `Reviewed this week (${d.done.length})`), h('div', { class: 'stack' }, d.done.map((x) => itemCard(x, load, true)))) : null,
      d.notOurs.length ? h('details', {}, h('summary', {}, `Not ours (${d.notOurs.length})`), h('div', { class: 'stack' }, d.notOurs.map((x) => itemCard(x, load, true)))) : null,
    );
  };
  await load();
  return root;
}

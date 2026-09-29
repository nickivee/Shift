import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { toast, pageTitle, fmtDate, fmtDateTime } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';

// Identity: an arrival's details and where they came from → possible matches with the evidence →
// matched, a new record, or a temporary identity → identified later → corrected if wrong.
const TONE = { CONFIRMED: 'ok', NEW: 'ok', RESOLVED: 'ok', UNRESOLVED: 'danger' };

export const field = (label, el) => h('label', { class: 'field' }, label, el);
export const select = (entries, label, blank = 'Choose…') => h('select', { 'aria-label': label }, blank === null ? null : h('option', { value: '' }, blank), entries.map(([k, v]) => h('option', { value: k }, v)));
const input = (label, placeholder, type = 'text') => h('input', { type, 'aria-label': label, placeholder });

// A dialog with several ways out: each action button runs its own handler.
export function dialog(title, body) {
  const error = h('p', { class: 'small notice', hidden: true });
  const close = () => { dlg.close(); dlg.remove(); };
  const run = (fn) => async () => {
    error.hidden = true;
    try { await fn(); } catch (err) { error.textContent = err?.message ?? 'Something went wrong.'; error.hidden = false; error.scrollIntoView({ block: 'nearest' }); }
  };
  const dlg = h('dialog', { class: 'idm-dialog wide' }, h('div', { class: 'stack' }, h('h2', {}, title), body(run, close), error,
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'))));
  dlg.addEventListener('cancel', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return close;
}

// The details fields shared by registering and identifying.
function detailsForm(o, sourceLabel) {
  const f = {
    source: select(Object.entries(o.sources), sourceLabel),
    given: input('Given name', 'e.g. Mere'),
    family: input('Family name', 'e.g. Parata'),
    nhi: input('NHI', 'e.g. ZZZ0059'),
    dob: input('Date of birth', '', 'date'),
    gender: select(Object.entries(o.genders), 'Gender', 'Not given'),
  };
  f.values = () => ({ source: f.source.value, given: f.given.value, family: f.family.value, nhi: f.nhi.value, dob: f.dob.value, gender: f.gender.value });
  f.el = h('div', { class: 'stack' }, field(sourceLabel, f.source),
    h('div', { class: 'idm-grid' }, field('Given name', f.given), field('Family name', f.family), field('NHI', f.nhi), field('Date of birth', f.dob), field('Gender', f.gender)));
  return f;
}

function candidateRow(c, label, onPick) {
  return h('div', { class: `tile stack idm-cand${c.enough ? ' enough' : ''}` },
    h('div', { class: 'spread' }, h('b', {}, c.name), h('span', { class: `tag ${c.enough ? 'ok' : 'warn'}` }, c.enough ? 'Enough agrees' : 'Not enough to match')),
    h('div', { class: 'small muted' }, [c.nhi ? `NHI ${c.nhi}` : 'No NHI', c.dob ? `born ${fmtDate(c.dob)}` : 'no date of birth', c.gender].filter(Boolean).join(' · ')),
    h('dl', { class: 'var-pair' }, h('dt', {}, 'Agrees'), h('dd', {}, c.agreeLabel || 'Nothing'), h('dt', {}, 'Differs'), h('dd', { class: c.differ.length ? 'idm-differ' : '' }, c.differLabel || 'Nothing')),
    c.here ? h('div', { class: 'small notice' }, 'Already here in your service. Open their record instead of registering them again.') : null,
    c.enough && !c.here ? h('div', { class: 'row' }, h('button', { class: 'btn small primary', onclick: onPick }, label)) : null,
  );
}

function registerDialog(o) {
  const f = detailsForm(o, 'Where the details came from');
  const location = input('Location', 'e.g. Waiting room, Bed 4');
  const description = h('textarea', { 'aria-label': 'Description', placeholder: 'Needed for a temporary identity, e.g. Man about 40, brought in by ambulance from Queen St, no ID' });
  const notThem = h('textarea', { 'aria-label': 'Why not them', placeholder: 'Only if a record matches but this is a different person' });
  const found = h('div', { class: 'stack' });
  const after = (r) => { toast(r.state === 'UNRESOLVED' ? 'Registered with a temporary identity.' : 'Arrival registered.'); go(`/work/patient/${r.personId}/identity`); };
  dialog('Register an arrival', (run, close) => {
    const send = (decision, extra = {}) => run(async () => {
      const r = await post('/api/work/arrivals', { ...f.values(), location: location.value, description: description.value, notThem: notThem.value, decision, ...extra });
      close();
      after(r);
    });
    const find = run(async () => {
      const d = await post('/api/work/arrivals/find', f.values());
      mount(found, h('h3', {}, d.candidates.length ? `Possible matches (${d.candidates.length})` : 'No possible matches in SHIFT'),
        d.candidates.map((c) => candidateRow(c, 'This is them', send('MATCH', { personId: c.personId }))),
        h('div', { class: 'stack' }, d.candidates.some((c) => c.enough) ? field('Why this is a different person', notThem) : null,
          h('div', { class: 'row' }, h('button', { class: 'btn', onclick: send('NEW') }, 'Not on the list: new record'))));
    });
    return h('div', { class: 'stack' }, f.el, field('Location', location),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: find }, 'Find matches')),
      found,
      h('details', {}, h('summary', {}, 'Cannot identify them yet'),
        h('div', { class: 'stack' }, h('p', { class: 'small muted' }, 'They get a temporary identity (for example "Unidentified Male A") so care starts now. Identify them as soon as you can.'),
          field('Description', description),
          h('div', { class: 'row' }, h('button', { class: 'btn', onclick: send('UNKNOWN') }, 'Give a temporary identity')))),
    );
  });
}

function identifyDialog(x, d, reload) {
  const f = detailsForm(d.options, 'Where the identifying details came from');
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'e.g. Daughter arrived and confirmed his details; needed if a record matches but this is a different person' });
  const found = h('div', { class: 'stack' });
  dialog(`Identify ${x.patient}`, (run, close) => {
    const send = (personId) => run(async () => {
      const r = await post(`/api/work/identity/${x.id}/identify`, { ...f.values(), note: note.value, personId });
      close();
      toast(personId ? 'Merged into their record.' : 'Identified.');
      reload(r.personId);
    });
    const find = run(async () => {
      const r = await post('/api/work/arrivals/find', f.values());
      const list = r.candidates.filter((c) => c.personId !== x.personId);
      mount(found, h('h3', {}, list.length ? `Existing records (${list.length})` : 'No existing record in SHIFT'),
        list.map((c) => candidateRow({ ...c, here: false }, 'Merge into this record', send(c.personId))),
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: send('') }, 'No existing record: this is them')));
    });
    return h('div', { class: 'stack' }, f.el, field('Note', note),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: find }, 'Find their record')), found);
  });
}

function correctDialog(x, reload) {
  const note = h('textarea', { 'aria-label': 'What was wrong', placeholder: 'e.g. Wrong Mary Smith: whānau confirmed a different date of birth' });
  const what = x.state === 'CONFIRMED' ? `This arrival, and what your service recorded for it since, move off ${x.patient}'s record to a temporary identity.`
    : x.linkedTo ? `Everything moved into ${x.linkedName}'s record goes back to the temporary record.` : 'The record goes back to its temporary details.';
  dialog(`Correct: ${x.patient}`, (run, close) => h('div', { class: 'stack' }, h('p', { class: 'small' }, what), field('What was wrong', note),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: run(async () => {
      const r = await post(`/api/work/identity/${x.id}/correct`, { note: note.value });
      close();
      toast('Corrected.');
      reload(r.personId);
    }) }, 'Correct it'))));
}

function stated(x) {
  const bits = [[x.statedGiven, x.statedFamily].filter(Boolean).join(' '), x.statedNhi ? `NHI ${x.statedNhi}` : null,
    x.statedDob ? `born ${fmtDate(x.statedDob)}` : null, x.statedGenderLabel].filter(Boolean);
  return bits.length ? bits.join(' · ') : 'No details given';
}

function matchCard(x, d, reload, showPatient = false) {
  const handler = (a) => () => (a === 'identify' ? identifyDialog(x, d, reload) : correctDialog(x, reload));
  const ev = x.evidence;
  return h('div', { class: `tile stack idm idm-${x.state.toLowerCase()}` },
    showPatient ? h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.personId}/identity`) }, h('b', {}, x.patient))) : null,
    h('div', { class: 'spread' }, h('h3', {}, x.stateLabel), h('span', { class: `tag ${TONE[x.state] ?? ''}` }, x.state === 'UNRESOLVED' ? 'Temporary identity' : x.stateLabel)),
    h('div', { class: 'small' }, h('b', {}, 'Stated: '), stated(x)),
    x.description ? h('div', { class: 'small' }, h('b', {}, 'Description: '), x.description) : null,
    ev ? h('dl', { class: 'var-pair' }, h('dt', {}, `Agrees with ${ev.name}`), h('dd', {}, ev.agreeLabel), h('dt', {}, 'Differs'), h('dd', { class: ev.differ.length ? 'idm-differ' : '' }, ev.differLabel || 'Nothing')) : null,
    h('div', { class: 'small muted' }, `${x.sourceLabel} · registered by ${x.registeredBy}, ${fmtDateTime(x.registeredAt)} · ${x.service}`),
    x.resolvedBy && x.state === 'RESOLVED' ? h('div', { class: 'small' }, h('b', {}, `Identified (${x.resolvedBy}, ${fmtDateTime(x.resolvedAt)})`), x.linkedName ? `: merged into ${x.linkedName}` : '') : null,
    x.correctedNote ? h('div', { class: 'small' }, h('b', {}, `Corrected (${x.correctedBy}, ${fmtDateTime(x.correctedAt)}): `), x.correctedNote) : null,
    x.candidates?.length ? h('div', { class: 'small notice' }, `Possible match from what is known so far: ${x.candidates.filter((c) => c.enough).map((c) => c.name).join(', ') || x.candidates[0].name}. Identify them to check the evidence.`) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${a === 'identify' ? ' primary' : ''}`, onclick: handler(a) }, a === 'identify' ? 'Identify' : 'Correct a wrong match'))) : null,
    h('details', {}, h('summary', {}, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// The person's Identity view in the Live Workstation.
export function identityPanel(personId, d, reload) {
  return h('div', { class: 'stack' },
    d.mergedInto ? h('div', { class: 'notice' }, `This record was merged into ${d.mergedName}'s. `, h('button', { class: 'link-btn', onclick: () => reload(d.mergedInto) }, 'Open their record')) : null,
    h('div', { class: 'small' }, h('b', {}, 'NHI: '), d.nhi ? `${d.nhi.value} (${d.nhi.verification === 'UNVERIFIED' ? 'not yet verified' : d.nhi.verification.toLowerCase()})` : 'None recorded'),
    d.matches.length ? d.matches.map((x) => matchCard(x, d, reload)) : h('div', { class: 'card empty' }, 'No arrivals registered for this record in SHIFT.'),
    d.duplicates ? h('h3', { class: 'section-title' }, 'Duplicate records') : null,
    d.duplicates?.canFlag && !d.mergedInto ? h('div', {}, h('button', { class: 'btn', onclick: () => flagDialog(personId, reload) }, 'Flag a possible duplicate')) : null,
    d.duplicates ? (d.duplicates.cases.length ? d.duplicates.cases.map((x) => dupCard(x, reload, personId)) : h('div', { class: 'card empty' }, 'No possible duplicates of this record.')) : null,
  );
}

// Duplicate records ------------------------------------------------------------------------

const DUP_TONE = { POSSIBLE: 'danger', NOT_DUPLICATE: 'ok', RECONCILED: 'ok' };

function flagDialog(personId, reload) {
  const q = input('Search', 'Name or NHI of the other record');
  const results = h('div', { class: 'stack' });
  const reason = h('textarea', { 'aria-label': 'Why', placeholder: 'e.g. Same name and date of birth; old physio record has no NHI' });
  let chosen = null;
  dialog('Flag a possible duplicate', (run, close) => {
    const search = run(async () => {
      const list = (await get(`/api/work/search?q=${encodeURIComponent(q.value)}`)).filter((r) => r.id !== personId);
      const draw = () => mount(results, list.length ? list.map((r) => h('div', { class: `spread screen-row${chosen === r.id ? ' chosen' : ''}` },
        h('span', {}, h('b', {}, r.name), h('span', { class: 'small muted' }, ` ${[r.nhi ? `NHI ${r.nhi}` : 'no NHI', r.dateOfBirth ? `born ${fmtDate(r.dateOfBirth)}` : null].filter(Boolean).join(' · ')}`)),
        h('button', { class: 'btn small', onclick: () => { chosen = r.id; draw(); } }, chosen === r.id ? 'Chosen' : 'Choose'))) : h('div', { class: 'small muted' }, 'No other records found.'));
      draw();
    });
    return h('div', { class: 'stack' },
      h('div', { class: 'row' }, q, h('button', { class: 'btn', onclick: search }, 'Search')), results, field('Why they might be the same person', reason),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: run(async () => {
        if (!chosen) throw new Error('Choose the other record.');
        await post(`/api/work/patients/${personId}/duplicates`, { otherId: chosen, reason: reason.value });
        close();
        toast('Flagged for review.');
        reload(personId);
      }) }, 'Flag for review')));
  });
}

function noteDialog(title, label, placeholder, submit, send) {
  const note = h('textarea', { 'aria-label': label, placeholder });
  dialog(title, (run, close) => h('div', { class: 'stack' }, field(label, note),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: run(async () => { await send(note.value); close(); }) }, submit))));
}

function sideCol(x, sd, other, canKeep, act) {
  const diff = (a, b) => (a && b && String(a).toLowerCase() !== String(b).toLowerCase() ? 'idm-differ' : '');
  return h('div', { class: `tile stack dup-side${x.keptId === sd.personId ? ' kept' : ''}${x.mergedId === sd.personId ? ' gone' : ''}` },
    h('b', {}, sd.name, sd.preferredName ? ` (${sd.preferredName})` : ''),
    h('dl', { class: 'var-pair' },
      h('dt', {}, 'NHI'), h('dd', { class: diff(sd.nhi?.value, other.nhi?.value) }, sd.nhi ? sd.nhi.value : 'None'),
      h('dt', {}, 'Born'), h('dd', { class: diff(sd.dob, other.dob) }, sd.dob ? fmtDate(sd.dob) : 'Not recorded'),
      h('dt', {}, 'Gender'), h('dd', { class: diff(sd.gender, other.gender) }, sd.gender ?? 'Not recorded'),
      h('dt', {}, 'Allergies'), h('dd', {}, sd.allergies.join(', ') || 'None recorded'),
      h('dt', {}, 'Stays'), h('dd', {}, sd.encounters.length ? sd.encounters.map((e) => `${e.service} (${e.state === 'ACTIVE' ? 'here now' : fmtDate(e.startedAt)})`).join(', ') : 'None'),
      h('dt', {}, 'Created'), h('dd', {}, `${fmtDate(sd.createdAt)} · ${sd.source === 'LOCAL' ? 'local record' : sd.source.toLowerCase()}`)),
    x.keptId === sd.personId ? h('span', { class: 'tag ok' }, 'Kept') : x.mergedId === sd.personId ? h('span', { class: 'tag muted' }, 'Merged in') : null,
    canKeep ? h('div', { class: 'row' }, h('button', { class: 'btn small primary', onclick: act }, 'Keep this record')) : null,
  );
}

function dupCard(x, reload, from, showLink = false) {
  const send = async (action, body) => { const r = await post(`/api/work/duplicates/${x.id}/${action}`, { ...body, from }); toast('Saved.'); reload(r.personId); };
  const merging = x.actions.includes('merge');
  const keep = (sd) => () => noteDialog(`Keep ${sd.name}'s record`, 'Note (optional)', 'e.g. Same person: old physiotherapy record made before she had an NHI', 'Merge into this record',
    (note) => send('merge', { keep: sd.personId, note }));
  return h('div', { class: `tile stack idm dup-${x.state.toLowerCase()}` },
    showLink ? h('div', {}, h('button', { class: 'link-btn', onclick: () => go(`/work/patient/${x.keptId ?? x.a.personId}/identity`) }, h('b', {}, x.a.name))) : null,
    h('div', { class: 'spread' }, h('h3', {}, x.stateLabel), h('span', { class: `tag ${DUP_TONE[x.state]}` }, x.detectedHow === 'SHIFT' ? 'Spotted by SHIFT' : `Flagged by ${x.detectedBy}`)),
    x.reason ? h('div', { class: 'small' }, h('b', {}, 'Why: '), x.reason) : null,
    h('div', { class: 'dup-pair' }, sideCol(x, x.a, x.b, merging && x.keepable.includes(x.a.personId), keep(x.a)), sideCol(x, x.b, x.a, merging && x.keepable.includes(x.b.personId), keep(x.b))),
    h('div', { class: 'small' }, h('b', {}, 'Agrees: '), x.evidence.agreeLabel || 'Nothing', x.evidence.differLabel ? h('span', { class: 'idm-differ' }, ` · Differs: ${x.evidence.differLabel}`) : null),
    merging && !x.keepable.length ? h('div', { class: 'small notice' }, 'Both records have an NHI. SHIFT cannot merge them; the NHI duplicate has to be resolved first.') : null,
    x.reviewNote && x.state !== 'POSSIBLE' ? h('div', { class: 'small' }, h('b', {}, `Decided (${x.reviewedBy}, ${fmtDateTime(x.reviewedAt)}): `), x.reviewNote) : null,
    x.undoneNote ? h('div', { class: 'small' }, h('b', {}, `Merge undone (${x.undoneBy}, ${fmtDateTime(x.undoneAt)}): `), x.undoneNote) : null,
    x.actions.filter((a) => a !== 'merge').length ? h('div', { class: 'row' }, x.actions.filter((a) => a !== 'merge').map((a) => h('button', { class: 'btn small', onclick: () => (
      a === 'not' ? noteDialog('Not the same person', 'How you know', 'e.g. Different mothers\' names and addresses; twins', 'Save', (note) => send('not', { note }))
        : a === 'undo' ? noteDialog('Undo the merge', 'Why the merge was wrong', 'e.g. Two different people: GP confirmed different addresses', 'Undo merge', (note) => send('undo', { note }))
          : noteDialog('Reopen', 'What has changed', 'e.g. GP confirmed they are the same person', 'Reopen', (note) => send('reopen', { note }))) },
    { not: 'Not the same person', undo: 'Undo the merge', reopen: 'Reopen' }[a]))) : null,
    h('details', {}, h('summary', {}, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'spread' }, h('b', {}, s.kindLabel), h('span', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`)),
        h('div', {}, s.body))))),
  );
}

// Home → Duplicate records.
export async function duplicatesView() {
  const d = await get('/api/work/duplicates');
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map((x) => dupCard(x, () => go('/work/duplicates'), x.a.personId, true)) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Duplicate records', () => go('/work/home')),
    h('div', { class: 'banner' }, 'Two records that may be the same person, spotted by SHIFT or flagged by staff. Open one to compare them side by side and decide. A merge keeps the record with the NHI, and every other service whose entries moved gets a task to check them.'),
    h('div', { class: 'stack' },
      section('To review', d.possible, 'No possible duplicates to review.'),
      section('Decided in the last 30 days', d.decided, 'Nothing decided in the last 30 days.')),
  );
}

// Home → Arrivals.
export async function arrivalsView() {
  const d = await get('/api/work/arrivals');
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, `${title} (${list.length})`),
    list.length ? list.map((x) => matchCard(x, d, () => go('/work/arrivals'), true)) : h('div', { class: 'card empty' }, empty));
  return h('div', {},
    workHeader(),
    pageTitle('Arrivals', () => go('/work/home')),
    h('div', { class: 'banner' }, 'Register someone arriving in your service. SHIFT shows possible matches and the evidence for each; you decide. Someone who cannot be identified gets a temporary identity so care starts now.'),
    h('div', { class: 'stack' },
      h('div', {}, h('button', { class: 'btn primary', onclick: () => registerDialog(d.options) }, 'Register an arrival')),
      section('Not yet identified', d.unresolved, 'Everyone here has been identified.'),
      section('Last 24 hours', d.recent, 'No other arrivals registered in the last 24 hours.')),
  );
}

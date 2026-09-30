import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDateTime } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Allergies: reported or seen at the bedside → recorded → suspected or confirmed → changed → ended
// with a reason. Caregivers and therapists report; nurses and doctors check. Who may rule an allergy
// out, and when a reaction goes to CARM, is still being researched (RR-ALLERGY-001).
const POLICY = 'Who may rule an allergy out, and when a reaction must be reported to CARM, is still being researched (RR-ALLERGY-001). SHIFT does not send any report.';
const LABEL = { confirm: 'Confirm', change: 'Change', end: 'End' };

function recordDialog(personId, d, reload) {
  const o = d.options;
  const kind = select(Object.entries(o.kinds), 'Allergy or intolerance', null);
  const category = select(Object.entries(o.categories), 'What it is');
  const substance = h('input', { 'aria-label': 'What they reacted to', placeholder: 'e.g. Amoxicillin' });
  const reaction = h('textarea', { 'aria-label': 'What happened', placeholder: 'e.g. Itchy red rash on chest and arms 20 minutes after the first dose' });
  const severity = select(Object.entries(o.severity), 'How bad');
  const source = select(Object.entries(o.sources), 'Where this came from');
  const onset = h('input', { 'aria-label': 'When it happened', placeholder: 'e.g. Today 14:10, or as a child' });
  const certainty = select(Object.entries(o.certainty), 'Suspected or confirmed', null);
  const title = d.canRecord ? 'Record an allergy' : 'Report a reaction';
  dialog(title, h('div', { class: 'stack' },
    d.canRecord ? null : h('p', { class: 'small' }, 'It goes on their allergy list straight away as suspected, and a nurse is asked to check it.'),
    field('Allergy or intolerance', kind), field('What they reacted to', substance), field('What it is', category),
    field('What happened', reaction), field('How bad', severity), field('Where this came from', source), field('When it happened', onset),
    d.canRecord ? field('Suspected or confirmed', certainty) : null,
    h('p', { class: 'small muted' }, POLICY),
  ), d.canRecord ? 'Record allergy' : 'Report reaction', async () => {
    await post(`/api/work/patients/${personId}/allergies`, {
      kind: kind.value, category: category.value, substance: substance.value, reaction: reaction.value, severity: severity.value,
      source: source.value, onset: onset.value, certainty: d.canRecord ? certainty.value : 'SUSPECTED',
    });
    toast(d.canRecord ? 'Recorded.' : 'Reported. A nurse has been asked to check it.');
    reload();
  });
}

function noneKnownDialog(personId, d, reload) {
  const asked = select(Object.entries(d.options.asked), 'How you found out');
  const note = h('textarea', { 'aria-label': 'Note', placeholder: 'e.g. Asked him and his wife; no reactions to anything' });
  dialog('No known allergies', h('div', { class: 'stack' },
    h('p', { class: 'small' }, 'Only record this after asking. It is not the same as not asked yet.'),
    field('How you found out', asked), field('Note (optional)', note),
  ), 'Record no known allergies', async () => {
    await post(`/api/work/patients/${personId}/allergies/none-known`, { asked: asked.value, note: note.value });
    toast('No known allergies recorded.');
    reload();
  });
}

function actDialog(x, action, o, reload) {
  const note = h('textarea', { 'aria-label': 'Note' });
  const send = (body) => post(`/api/work/allergies/${x.id}/${action}`, { note: note.value, ...body });
  const name = x.nka ? 'No known allergies' : x.substance;
  if (action === 'confirm') {
    note.placeholder = 'e.g. Rash seen by me; same reaction in 2019 per GP letter';
    return dialog(`Confirm ${name}`, h('div', { class: 'stack' }, field('How it was confirmed', note)), 'Confirm allergy', async () => { await send({}); toast('Confirmed.'); reload(); });
  }
  if (action === 'change') {
    note.placeholder = 'e.g. Swelling of the lips too; now severe';
    const kind = select(Object.entries(o.kinds), 'Allergy or intolerance', null); kind.value = x.kind;
    const severity = select(Object.entries(o.severity), 'How bad', null); if (x.severityCode && o.severity[x.severityCode]) severity.value = x.severityCode;
    const reaction = h('textarea', { 'aria-label': 'What happened' }); reaction.value = x.reaction ?? '';
    return dialog(`Change ${name}`, h('div', { class: 'stack' },
      field('Allergy or intolerance', kind), field('What happened', reaction), field('How bad', severity), field('Why it is changing', note),
    ), 'Save change', async () => { await send({ kind: kind.value, severity: severity.value, reaction: reaction.value }); toast('Changed.'); reload(); });
  }
  note.placeholder = x.nka ? 'e.g. Recorded on the wrong person' : 'e.g. Had amoxicillin in 2024 with no reaction, per GP';
  const reasons = Object.entries(o.end).filter(([k]) => !(x.nka && k === 'REFUTED'));
  const reason = select(reasons, 'Why it is ending');
  return dialog(`End ${name}`, h('div', { class: 'stack' },
    h('p', { class: 'small' }, 'It comes off the banner and medicine checks, but stays in their record with your name and reason.'),
    field('Why it is ending', reason), field('What the decision was based on', note), h('p', { class: 'small muted' }, POLICY),
  ), 'End entry', async () => { await send({ reason: reason.value }); toast('Ended.'); reload(); });
}

function steps(x) {
  return x.log.length ? h('details', {}, h('summary', { class: 'small' }, `Step by step (${x.log.length})`),
    h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
      h('div', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`), h('div', { class: 'small' }, s.body))))) : null;
}

function allergyCard(x, o, reload) {
  const suspected = x.certainty === 'SUSPECTED';
  return h('div', { class: `tile stack allergy-entry${suspected ? ' al-suspected' : ''}${x.severityCode === 'SEVERE' ? ' al-severe' : ''}` },
    h('div', { class: 'spread' },
      h('div', {}, h('b', {}, x.substance ?? '—'), h('span', { class: 'small muted' }, ` · ${x.kindLabel}${x.categoryLabel ? ` · ${x.categoryLabel}` : ''}`)),
      h('span', { class: `tag ${suspected ? 'warn' : x.severityCode === 'SEVERE' ? 'danger' : ''}` }, suspected ? 'Suspected, to check' : x.certaintyLabel ?? 'Recorded')),
    h('div', { class: 'small' }, x.reaction ?? '', x.severityLabel ? h('b', {}, ` (${x.severityLabel.toLowerCase()})`) : null),
    h('div', { class: 'small muted' }, `${x.source ?? ''}${x.onset ? `, ${x.onset}` : ''} · recorded by ${x.recordedBy ?? 'unknown'} ${fmtDateTime(x.recordedAt)}`),
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${a === 'confirm' ? ' primary' : ''}`, onclick: () => actDialog(x, a, o, reload) }, LABEL[a]))) : null,
    steps(x),
  );
}

function endedRow(x) {
  return h('li', { class: 'small' },
    h('b', {}, x.nka ? 'No known allergies' : x.substance), x.nka ? '' : ` (${x.reaction ?? ''})`,
    h('span', { class: 'muted' }, ` · ${x.endLabel ?? x.state.toLowerCase()}${x.endedBy ? ` by ${x.endedBy} ${fmtDateTime(x.endedAt)}` : ''}`),
    x.endNote ? h('div', { class: 'muted' }, x.endNote) : null);
}

export function allergiesPanel(personId, d, reload) {
  const o = d.options;
  const status = d.current.length
    ? h('p', { class: 'small' }, d.toCheck ? `${d.current.length} on their list, ${d.toCheck} still to check.` : `${d.current.length} on their list.`)
    : d.noKnown
      ? h('div', { class: 'tile stack' }, h('div', { class: 'spread' }, h('b', {}, 'No known allergies'), h('span', { class: 'tag ok' }, 'Asked')),
        h('div', { class: 'small muted' }, `${d.noKnown.source} · ${d.noKnown.recordedBy ?? ''} ${fmtDateTime(d.noKnown.recordedAt)}`),
        d.noKnown.actions.length ? h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => actDialog(d.noKnown, 'end', o, reload) }, 'End')) : null)
      : h('div', { class: 'empty' }, 'Allergies not recorded yet. This is not the same as no known allergies.');
  return h('section', { class: 'stack' },
    h('div', { class: 'row' },
      d.canReport ? h('button', { class: 'btn primary', onclick: () => recordDialog(personId, d, reload) }, d.canRecord ? 'Record an allergy' : 'Report a reaction') : null,
      d.canRecord && !d.current.length && !d.noKnown ? h('button', { class: 'btn', onclick: () => noneKnownDialog(personId, d, reload) }, 'No known allergies') : null),
    status,
    d.current.map((x) => allergyCard(x, o, reload)),
    d.ended.length ? h('details', {}, h('summary', { class: 'small' }, `Ended or ruled out (${d.ended.length})`), h('ul', { class: 'stack' }, d.ended.map(endedRow))) : null,
  );
}

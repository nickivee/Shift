import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDateTime } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Consent: one decision → what was explained → how understanding was checked → the person's own yes
// or no → checked again before it happens → done, or withdrawn at any time. Who may take consent,
// and when it must be written, is still being researched (RR-CONSENT-001).
const RESEARCH = 'Who may take consent for what, and when it must be written, is still being researched (RR-CONSENT-001). Only record the person\'s own decision.';
const TONE = { CONSENTED: 'ok', REFUSED: 'danger', WITHDRAWN: 'danger', DONE: 'muted', RECONSIDERED: 'muted' };
const LABEL = { check: 'Check again', done: 'Done', withdraw: 'Withdrawn', reconsider: 'Changed their mind' };
const FINDING = { HAS: 'can decide', LACKS: 'cannot decide', NOT_YET: 'not able to decide yet' };

function recordDialog(personId, c, reload) {
  const o = c.options;
  const what = h('input', { 'aria-label': 'What the decision is about', placeholder: 'e.g. Colonoscopy under sedation' });
  const kind = select(Object.entries(o.kinds), 'What kind');
  const decision = select(Object.entries(o.decisions), 'Their decision');
  const information = h('textarea', { 'aria-label': 'What you explained', placeholder: 'What it is, why, the risks and benefits, and the other options including doing nothing' });
  const understood = h('textarea', { 'aria-label': 'How you checked they understood', placeholder: 'e.g. Said it back in her own words; asked about sedation' });
  const support = h('input', { 'aria-label': 'Support used', placeholder: 'e.g. Interpreter, whānau present, large print' });
  const form = select(Object.entries(o.forms), 'How they gave it');
  const formRef = h('input', { 'aria-label': 'Which form', placeholder: 'e.g. Procedure consent form, filed in the paper notes' });
  const words = h('input', { 'aria-label': 'In their words', placeholder: 'Optional' });
  const capacity = select(c.assessments.map((a) => [a.id, `${a.decision} (${a.state === 'RAISED' ? 'waiting for assessment' : FINDING[a.determination] ?? a.determination})`]), 'Capacity assessment for this decision', 'None: capacity is presumed');
  dialog('Record consent or refusal', h('div', { class: 'stack' },
    field('What the decision is about', what), field('What kind', kind), field('What you explained', information),
    field('How you checked they understood', understood), field('Support used', support), field('Their decision', decision),
    field('How they gave it', form), field('Which form (if signed)', formRef), field('In their words', words),
    c.assessments.length ? field('Capacity assessment for this decision', capacity) : null,
    h('p', { class: 'small muted' }, RESEARCH),
  ), 'Record decision', async () => {
    await post(`/api/work/patients/${personId}/consents`, {
      what: what.value, kind: kind.value, decision: decision.value, information: information.value, understood: understood.value, support: support.value,
      form: form.value, formRef: formRef.value, theirWords: words.value, capacityId: capacity.value,
    });
    toast('Recorded.');
    reload();
  });
}

function actDialog(x, action, reload) {
  const note = h('textarea', { 'aria-label': 'Note' });
  const holders = {
    check: ['Check they still agree', 'What they said', 'e.g. Still happy to go ahead; no new questions', 'Save'],
    done: ['Mark done', 'What was done and when', 'e.g. Colonoscopy done 10:30, no problems', 'Mark done'],
    withdraw: ['They withdrew their agreement', 'What they said, in their words if you can', 'e.g. "I have changed my mind, I do not want it"', 'Record withdrawal'],
    reconsider: ['They changed their mind', 'What they said', 'e.g. Now wants the vaccine after talking with her GP', 'Save'],
  };
  const [title, label, placeholder, submit] = holders[action];
  note.placeholder = placeholder;
  dialog(`${title}: ${x.what}`, h('div', { class: 'stack' },
    action === 'reconsider' ? h('p', { class: 'small' }, 'If they now agree, record their consent as a new decision after this.') : null,
    field(label, note)), submit, async () => {
    await post(`/api/work/consents/${x.id}/${action}`, { note: note.value });
    toast('Saved.');
    reload();
  });
}

function consentCard(x, reload) {
  return h('div', { class: `tile stack consent cs-${x.state.toLowerCase()}` },
    h('div', { class: 'spread' },
      h('div', {}, h('b', {}, x.what), h('span', { class: 'small muted' }, ` · ${x.kindLabel}`)),
      h('span', { class: `tag ${TONE[x.state] ?? ''}` }, x.stateLabel)),
    x.theirWords ? h('div', { class: 'small' }, h('b', {}, 'In their words: '), `"${x.theirWords}"`) : null,
    h('div', { class: 'small' }, h('b', {}, 'Explained: '), x.information),
    h('div', { class: 'small' }, h('b', {}, 'Understanding: '), x.understood),
    x.support ? h('div', { class: 'small' }, h('b', {}, 'Support: '), x.support) : null,
    x.capacityDecision ? h('div', { class: 'small muted' }, `Capacity assessed for "${x.capacityDecision}": ${FINDING[x.capacityFinding] ?? 'waiting'}`) : null,
    h('div', { class: 'small muted' }, `${x.formLabel}${x.formRef ? ` (${x.formRef})` : ''} · recorded by ${x.recordedBy} ${fmtDateTime(x.recordedAt)}`),
    x.endNote ? h('div', { class: 'small' }, h('b', {}, `${x.stateLabel} (${x.endedBy} ${fmtDateTime(x.endedAt)}): `), x.endNote) : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: 'btn small', onclick: () => actDialog(x, a, reload) }, LABEL[a]))) : null,
    x.log.length ? h('details', {}, h('summary', { class: 'small' }, `Step by step (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`), h('div', { class: 'small' }, s.body))))) : null,
  );
}

// Inside the person's Consent and capacity view, above their capacity assessments.
export function consentPanel(personId, c, reload) {
  return h('section', { class: 'stack' },
    h('div', { class: 'spread' }, h('h3', {}, 'Consent'),
      c.canRecord ? h('button', { class: 'btn small', onclick: () => recordDialog(personId, c, reload) }, 'Record consent or refusal') : null),
    c.current.length ? c.current.map((x) => consentCard(x, reload)) : h('div', { class: 'empty' }, 'No decisions recorded.'),
    c.past.length ? h('details', {}, h('summary', { class: 'small' }, `Done or changed (${c.past.length})`), h('div', { class: 'stack' }, c.past.map((x) => consentCard(x, reload)))) : null,
  );
}

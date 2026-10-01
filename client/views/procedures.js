import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDate, fmtDateTime } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Procedures: proposed → planned with consent and the site check → started → done → recovery →
// recovered with any follow-up. Doctors do the procedure; nurses look after recovery.
const LABEL = { plan: 'Plan it', start: 'Start', done: 'Finished', recovered: 'Recovered', complication: 'Add a complication', cancel: 'Cancel' };
const pad = (n) => String(n).padStart(2, '0');
const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const SITE_STATE = { VERIFIED: 'checked', DISCREPANCY: 'does not match', DONE: 'checked; done there' };
const SIDE = { LEFT: 'Left', RIGHT: 'Right', BILATERAL: 'Both sides', MIDLINE: 'Midline', NOT_APPLICABLE: '' };

function proposeDialog(personId, reload) {
  const what = h('input', { 'aria-label': 'Procedure', placeholder: 'e.g. Diagnostic pleural tap' });
  const why = h('textarea', { 'aria-label': 'Why', placeholder: 'e.g. New right pleural effusion; need to know if it is infected' });
  dialog('Propose a procedure', h('div', { class: 'stack' }, field('Procedure', what), field('Why', why)), 'Propose', async () => {
    await post(`/api/work/patients/${personId}/procedures`, { what: what.value, why: why.value });
    toast('Proposed.');
    reload();
  });
}

function planDialog(x, o, reload) {
  const in2h = new Date(Date.now() + 2 * 3600_000);
  const when = h('input', { type: 'datetime-local', 'aria-label': 'When', value: `${local(in2h)}T${pad(in2h.getHours())}:00` });
  const place = h('input', { 'aria-label': 'Where', placeholder: 'e.g. Bedside, or ED procedure room' });
  const operator = select(o.operators.map((p) => [p.id, p.name]), 'Who will do it');
  const consent = select([...o.consents.map((c) => [c.id, `${c.what} (agreed ${fmtDate(c.at)})`]), ...Object.entries(o.noConsent)], 'Consent', 'Choose…');
  const note = h('input', { 'aria-label': 'Why it cannot wait', placeholder: 'e.g. Airway at risk; unconscious, no family here' });
  const noteField = field('Why it cannot wait', note);
  const show = () => { noteField.hidden = !o.noConsent[consent.value]; };
  consent.addEventListener('change', show);
  show();
  const site = select(o.sites.map((s) => [s.id, `${s.procedure}: ${[SIDE[s.side], String(s.site).toLowerCase()].filter(Boolean).join(' ')} (${s.state === 'VERIFIED' ? 'checked' : s.state === 'DISCREPANCY' ? 'does not match' : 'not checked yet'})`]), 'Site check', 'No site check');
  dialog(`Plan: ${x.what}`, h('div', { class: 'stack' },
    field('When', when), field('Where', place), field('Who will do it', operator), field('Consent', consent), noteField,
    o.consents.length ? null : h('p', { class: 'small muted' }, 'No consent recorded yet. Record it under Consent and capacity first.'),
    o.sites.length ? field('Site check', site) : null,
  ), 'Plan it', async () => {
    const no = o.noConsent[consent.value];
    await post(`/api/work/procedures/${x.id}/plan`, { when: when.value, place: place.value, operator: operator.value, consent: no ? '' : consent.value, noConsent: no ? consent.value : '', noConsentNote: note.value, site: site.value });
    toast('Planned.');
    reload();
  }, { wide: true });
}

function doneDialog(x, o, reload) {
  const how = select(Object.entries(o.how), 'How it went', null);
  how.value = 'COMPLETED';
  const findings = h('textarea', { 'aria-label': 'What was done and found', placeholder: 'e.g. 60 mL straw-coloured fluid; sent for culture and cytology' });
  const complications = h('input', { 'aria-label': 'Complications', placeholder: 'Leave empty if none' });
  const plan = h('input', { 'aria-label': 'Recovery plan', placeholder: 'e.g. Obs every 15 min for 1 hour; chest X-ray if short of breath' });
  const askSite = x.siteName && x.siteState === 'VERIFIED';
  const siteMatched = select([['YES', 'Yes'], ['NO', 'No, somewhere else']], 'Done on the checked site', 'Choose…');
  const siteField = askSite ? field(`Done on the checked site (${[SIDE[x.siteSide], String(x.siteName).toLowerCase()].filter(Boolean).join(' ')})?`, siteMatched) : null;
  const showSite = () => { if (siteField) siteField.hidden = how.value === 'ABANDONED'; };
  how.addEventListener('change', showSite);
  dialog(`Finished: ${x.what}`, h('div', { class: 'stack' }, field('How it went', how), siteField, field('What was done and found', findings), field('Complications', complications), field('Recovery plan', plan)), 'Save', async () => {
    await post(`/api/work/procedures/${x.id}/done`, { how: how.value, findings: findings.value, complications: complications.value, recoveryPlan: plan.value, siteMatched: askSite ? siteMatched.value : '' });
    toast('Saved. They are now in recovery.');
    reload();
  });
}

function recoveredDialog(x, reload) {
  const outcome = h('textarea', { 'aria-label': 'How they are now', placeholder: 'e.g. Obs normal for an hour; up and walking; site dry' });
  const on = h('input', { type: 'date', 'aria-label': 'Follow-up on' });
  const what = h('input', { 'aria-label': 'Follow-up', placeholder: 'e.g. Sutures out at the GP' });
  dialog(`Recovered: ${x.what}`, h('div', { class: 'stack' }, field('How they are now', outcome), field('Follow-up on', on), field('Follow-up', what),
    h('p', { class: 'small muted' }, 'Leave the follow-up empty if none is needed.')), 'Save', async () => {
    await post(`/api/work/procedures/${x.id}/recovered`, { outcome: outcome.value, followUpOn: on.value, followUpWhat: what.value });
    toast('Saved.');
    reload();
  });
}

function noteDialog(x, action, reload) {
  const note = h('textarea', { 'aria-label': 'Note', placeholder: action === 'cancel' ? 'e.g. Effusion smaller on today\'s scan; not needed' : 'e.g. Bleeding from the site at 3pm; pressure for 10 min' });
  dialog(action === 'cancel' ? `Cancel: ${x.what}` : `Complication: ${x.what}`, h('div', { class: 'stack' }, field(action === 'cancel' ? 'Why' : 'What happened', note)),
    action === 'cancel' ? 'Cancel procedure' : 'Save', async () => {
      await post(`/api/work/procedures/${x.id}/${action}`, { note: note.value });
      toast('Saved.');
      reload();
    });
}

function card(x, o, reload) {
  const tone = x.state === 'RECOVERY' || x.blockers.length ? 'warn' : x.state === 'FINISHED' ? 'ok' : '';
  const site = x.siteName ? `${[SIDE[x.siteSide], String(x.siteName).toLowerCase()].filter(Boolean).join(' ')}` : null;
  const run = (a) => (a === 'plan' ? planDialog(x, o, reload) : a === 'done' ? doneDialog(x, o, reload) : a === 'recovered' ? recoveredDialog(x, reload)
    : a === 'start' ? post(`/api/work/procedures/${x.id}/start`, {}).then(() => { toast('Started.'); reload(); }).catch((e) => toast(e.message)) : noteDialog(x, a, reload));
  return h('div', { class: 'tile stack procedure' },
    h('div', { class: 'spread' }, h('b', {}, x.what), h('span', { class: `tag ${tone}` }, x.stateLabel)),
    h('div', { class: 'small' }, h('b', {}, 'Why: '), x.why),
    x.plannedFor ? h('div', { class: 'small' }, `${fmtDateTime(x.plannedFor)} · ${x.place} · ${x.operator}`) : null,
    x.consentWhat ? h('div', { class: 'small' }, h('b', {}, 'Consent: '), `${x.consentWhat} (${String(x.consentState).toLowerCase()})`) : null,
    x.noConsent ? h('div', { class: 'small warn-text' }, h('b', {}, 'No consent, emergency: '), x.noConsentNote) : null,
    site ? h('div', { class: 'small' }, h('b', {}, 'Site: '), `${site} (${SITE_STATE[x.siteState] ?? 'not checked yet'})`) : null,
    x.blockers.length ? h('div', { class: 'small warn-text' }, `Cannot start yet: ${x.blockers.join('; ')}.`) : null,
    x.howLabel ? h('div', { class: 'small' }, h('b', {}, `${x.howLabel}: `), x.findings) : null,
    x.endedAt ? h('div', { class: `small${x.complications ? ' warn-text' : ' muted'}` }, x.complications ? `Complications: ${x.complications}` : 'No complications recorded.') : null,
    x.state === 'RECOVERY' ? h('div', { class: 'small' }, h('b', {}, 'Recovery: '), x.recoveryPlan) : null,
    x.outcome ? h('div', { class: 'small' }, h('b', {}, `Recovered (${x.recoveredBy}): `), x.outcome) : null,
    x.followUpOn ? h('div', { class: 'small' }, h('b', {}, `Follow-up ${fmtDate(x.followUpOn)}: `), x.followUpWhat) : null,
    x.cancelNote ? h('div', { class: 'small muted' }, `Cancelled: ${x.cancelNote}`) : null,
    x.acts.length ? h('div', { class: 'row' }, x.acts.map((a) => h('button', {
      class: `btn small${['plan', 'start', 'done', 'recovered'].includes(a) ? ' primary' : ''}`, disabled: a === 'start' && x.blockers.length > 0, onclick: () => run(a),
    }, LABEL[a]))) : null,
    h('details', {}, h('summary', { class: 'small' }, `History (${x.steps.length})`),
      h('ol', { class: 'det-steps' }, x.steps.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`), h('div', { class: 'small' }, s.body))))),
  );
}

// At the top of the Procedures view.
export function proceduresPanel(personId, s, reload) {
  if (!s) return null;
  return h('section', { class: 'stack' },
    h('div', { class: 'spread' }, h('h3', {}, 'Planned and recent procedures'),
      s.canPropose ? h('button', { class: 'btn small', onclick: () => proposeDialog(personId, reload) }, 'Propose a procedure') : null),
    s.current.length ? s.current.map((x) => card(x, s.options, reload)) : h('div', { class: 'empty' }, 'None planned.'),
    s.past.length ? h('details', {}, h('summary', { class: 'small' }, `Earlier (${s.past.length})`), h('div', { class: 'stack' }, s.past.map((x) => card(x, s.options, reload)))) : null,
  );
}

import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDate, fmtDateTime } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Tube feeding: feed plan as prescribed → each feed, flush or hold and how it went → review →
// changed or stopped. The tube and its position check live in Lines and tubes.
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };

// The fields that define a feed plan, shared by starting one and changing one.
function planFields(s, x = {}) {
  const f = {
    deviceId: select(s.tubes.map((t) => [t.id, `${t.label}${t.state === 'IN_PLACE' ? '' : ` (${t.stateLabel.toLowerCase()})`}`]), 'Tube', null),
    feed: h('input', { 'aria-label': 'Feed', value: x.feed ?? '', placeholder: 'e.g. Standard 1.5 kcal/mL feed' }),
    method: select(Object.entries(s.options.method), 'How it is given'),
    regimen: h('textarea', { 'aria-label': 'Rate or volumes', placeholder: 'Exactly as prescribed, e.g. 60 mL/hour for 20 hours, 10am to 6am' }),
    flushes: h('input', { 'aria-label': 'Flushes', value: x.flushes ?? '', placeholder: 'Optional, e.g. 30 mL water before and after each feed and medicine' }),
    targetMl: h('input', { 'aria-label': 'Feed per day (mL)', type: 'number', min: 1, max: 5000, value: x.targetMl ?? '', placeholder: 'Optional, as prescribed' }),
    oral: select(Object.entries(s.options.oral), 'By mouth'),
    prescribedBy: h('input', { 'aria-label': 'Prescribed by', value: x.prescribedBy ?? '', placeholder: 'e.g. Dietitian A. Smith, 30 Sep' }),
    reviewDate: h('input', { 'aria-label': 'Review by', type: 'date', value: inDays(7) }),
  };
  f.regimen.value = x.regimen ?? '';
  if (x.deviceId && s.tubes.some((t) => t.id === x.deviceId)) f.deviceId.value = x.deviceId;
  if (x.method) f.method.value = x.method;
  if (x.oral) f.oral.value = x.oral;
  return {
    body: () => [field('Tube', f.deviceId), field('Feed', f.feed), field('How it is given', f.method), field('Rate or volumes', f.regimen), field('Flushes', f.flushes),
      field('Feed per day (mL)', f.targetMl), field('By mouth', f.oral), field('Prescribed by', f.prescribedBy), field('Review by', f.reviewDate)],
    values: () => Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value])),
  };
}

function startDialog(personId, s, reload) {
  const f = planFields(s);
  const reason = h('input', { 'aria-label': 'Why', placeholder: 'e.g. Unsafe swallow after stroke' });
  dialog('Start tube feeding', h('div', { class: 'stack' }, ...f.body(), field('Why', reason),
    h('p', { class: 'small muted' }, 'Write the feed exactly as the dietitian or doctor prescribed it. SHIFT does not work out rates or amounts (RR-FEED-001).')), 'Start', async () => {
    await post(`/api/work/patients/${personId}/feeding`, { ...f.values(), reason: reason.value });
    toast('Tube feeding started.');
    reload();
  }, { wide: true });
}

function giveDialog(x, s, reload) {
  const kind = select(Object.entries(s.options.given), 'What', null);
  const ml = h('input', { 'aria-label': 'mL', type: 'number', min: 1, max: 2000, placeholder: 'e.g. 250' });
  const tolerance = select(Object.entries(s.options.tolerance), 'How it went', null);
  const note = h('input', { 'aria-label': 'Note', placeholder: 'Needed if held or there was a problem: what happened and who you told' });
  const mlField = field('mL', ml);
  const tolField = field('How it went', tolerance);
  const sync = () => { const held = kind.value === 'HELD'; mlField.hidden = held; tolField.hidden = held; };
  kind.addEventListener('change', sync);
  sync();
  dialog(`Feed: ${x.feed}`, h('div', { class: 'stack' }, field('What', kind), mlField, tolField, field('Note', note)), 'Save', async () => {
    await post(`/api/work/feeding/${x.id}/give`, { kind: kind.value, ml: ml.value, tolerance: tolerance.value, note: note.value });
    toast('Saved.');
    reload();
  });
}

function reviewDialog(x, s, reload) {
  const outcome = select(Object.entries(s.options.review), 'Outcome');
  const finding = h('textarea', { 'aria-label': 'What the review found', placeholder: 'e.g. Weight steady at 61 kg, bowels open, no vomiting, swallow still unsafe' });
  const f = planFields(s, x);
  const plan = h('div', { class: 'stack' }, ...f.body());
  const next = h('input', { 'aria-label': 'Next review', type: 'date', value: inDays(7) });
  const nextField = field('Next review', next);
  const sync = () => { plan.hidden = outcome.value !== 'CHANGED'; nextField.hidden = outcome.value !== 'CONTINUE'; };
  outcome.addEventListener('change', sync);
  sync();
  dialog(`Review tube feeding: ${x.feed}`, h('div', { class: 'stack' }, field('Outcome', outcome), field('What the review found', finding), nextField, plan), 'Save', async () => {
    const changed = outcome.value === 'CHANGED';
    await post(`/api/work/feeding/${x.id}/review`, { outcome: outcome.value, finding: finding.value, ...(changed ? f.values() : { reviewDate: next.value }) });
    toast('Saved.');
    reload();
  }, { wide: true });
}

function card(x, s, reload) {
  const active = x.state === 'ACTIVE';
  return h('div', { class: `tile stack feed${x.blocked ? ' blocked' : ''}` },
    h('div', { class: 'spread' }, h('b', {}, `${x.feed} · ${x.tube}`), h('span', { class: `tag ${active ? (x.blocked ? 'warn' : 'ok') : ''}` }, x.stateLabel)),
    h('dl', { class: 'feed-plan small' },
      h('dt', {}, 'How'), h('dd', {}, `${x.methodLabel}: ${x.regimen}`),
      x.flushes ? [h('dt', {}, 'Flushes'), h('dd', {}, x.flushes)] : null,
      h('dt', {}, 'By mouth'), h('dd', {}, x.oralLabel),
      h('dt', {}, 'Prescribed'), h('dd', {}, x.prescribedBy),
      h('dt', {}, 'For'), h('dd', {}, x.reason)),
    active ? h('div', { class: 'small' }, h('b', {}, 'Today: '), `feed ${x.today.feed} mL${x.targetMl ? ` of ${x.targetMl} mL prescribed` : ''} · water ${x.today.water} mL${x.today.held ? ' · held at least once' : ''}`) : null,
    x.blocked ? h('div', { class: 'small warn-text' }, x.blocked) : null,
    x.nbm ? h('div', { class: 'small warn-text' }, `Nil by mouth is in force: ${x.nbm.detail}. Check with the doctor whether feeds should continue.`) : null,
    x.concern ? h('div', { class: 'small warn-text' }, `${x.concern.toleranceLabel} ${fmtDateTime(x.concern.at)}: ${x.concern.note ?? ''}`) : null,
    x.reviewDue ? h('div', { class: 'small warn-text' }, `Review due ${fmtDate(x.reviewDate)}.`) : active && x.reviewDate ? h('div', { class: 'small muted' }, `Review by ${fmtDate(x.reviewDate)}.`) : null,
    !active ? h('div', { class: 'small' }, h('b', {}, `Stopped by ${x.stoppedBy} ${fmtDateTime(x.stoppedAt)}: `), x.stopReason) : null,
    x.recent.length ? h('details', {}, h('summary', { class: 'small' }, `Feeds given (${x.recent.length})`),
      h('ul', { class: 'feed-given small' }, x.recent.map((g) => h('li', { class: g.concern || g.kind === 'HELD' ? 'warn-text' : '' },
        `${fmtDateTime(g.at)} · ${g.kindLabel}${g.ml ? ` ${g.ml} mL` : ''}${g.toleranceLabel && g.tolerance !== 'FINE' ? ` · ${g.toleranceLabel}` : ''}${g.note ? ` · ${g.note}` : ''}`, h('span', { class: 'muted' }, ` · ${g.by}`))))) : null,
    x.canGive || x.canReview ? h('div', { class: 'row' },
      x.canGive ? h('button', { class: 'btn small primary', onclick: () => giveDialog(x, s, reload) }, 'Record a feed') : null,
      x.canReview ? h('button', { class: 'btn small', onclick: () => reviewDialog(x, s, reload) }, 'Review') : null) : null,
    h('details', {}, h('summary', { class: 'small' }, `History (${x.steps.length})`),
      h('ol', { class: 'det-steps' }, x.steps.map((st) => h('li', { class: 'det-step' },
        h('div', { class: 'small muted' }, `${st.by} · ${fmtDateTime(st.at)}`), h('div', { class: 'small' }, st.body))))),
  );
}

// Ward and ARC nurses' Diet screen, ARC caregivers' Diet screen, ward doctors' Review.
export function feedingPanel(personId, s, reload) {
  if (!s) return null;
  return h('section', { class: 'stack' },
    h('div', { class: 'spread' }, h('h3', {}, 'Tube feeding'),
      s.canStart ? h('button', { class: 'btn small', onclick: () => startDialog(personId, s, reload) }, 'Start tube feeding') : null),
    s.current.map((x) => card(x, s, reload)),
    s.past.length ? h('details', {}, h('summary', { class: 'small' }, `Earlier (${s.past.length})`), h('div', { class: 'stack' }, s.past.map((x) => card(x, s, reload)))) : null,
  );
}

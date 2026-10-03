import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDateTime } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Short stay for observation in the Emergency Department. SHIFT sets no time limit and decides no outcome.
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const inHours = (n) => stamp(new Date(Date.now() + n * 3600_000));

function placeDialog(personId, reload) {
  const why = h('textarea', { 'aria-label': 'Why they are staying', placeholder: 'e.g. Head injury, GCS 15; to be watched for 4 hours' });
  const watch = h('textarea', { 'aria-label': 'What to watch for', placeholder: 'e.g. Neuro obs hourly; tell me if drowsy, vomiting or worse headache' });
  const review = h('input', { type: 'datetime-local', 'aria-label': 'Review due', value: inHours(4) });
  dialog('Place in observation', h('div', { class: 'stack' }, field('Why they are staying', why), field('What to watch for and do', watch), field('Review due', review)), 'Save', async () => {
    await post(`/api/work/patients/${personId}/observation`, { why: why.value, watch: watch.value, reviewAt: review.value });
    toast('Saved.');
    reload();
  }, { wide: true });
}

function extendDialog(x, reload) {
  const note = h('textarea', { 'aria-label': 'What you found', placeholder: 'e.g. Still a headache but no vomiting; stay another 2 hours' });
  const review = h('input', { type: 'datetime-local', 'aria-label': 'Next review', value: inHours(2) });
  dialog('Reviewed, staying longer', h('div', { class: 'stack' }, field('What you found and why they are staying', note), field('Next review', review)), 'Save', async () => {
    await post(`/api/work/observation/${x.id}/extend`, { note: note.value, reviewAt: review.value });
    toast('Saved.');
    reload();
  });
}

function endDialog(x, o, reload) {
  const outcome = select(Object.entries(o.outcome), 'How it ends', 'Choose…');
  const note = h('textarea', { 'aria-label': 'What you found', placeholder: 'e.g. Well at 4 hours, safe to go home with head injury advice' });
  dialog('End the observation', h('div', { class: 'stack' }, field('How it ends', outcome), field('What you found and what happens next', note)), 'Save', async () => {
    await post(`/api/work/observation/${x.id}/end`, { outcome: outcome.value, note: note.value });
    toast('Saved.');
    reload();
  });
}

function card(x, o, reload) {
  return h('div', { class: `tile stack observation${x.overdue ? ' overdue' : ''}` },
    h('div', { class: 'spread' }, h('b', {}, x.why), h('span', { class: `tag ${x.overdue ? 'warn' : x.state === 'ENDED' ? 'ok' : ''}` }, x.overdue ? 'Review overdue' : x.stateLabel)),
    h('div', { class: 'small' }, h('b', {}, 'Watch: '), x.watch),
    x.state === 'OBSERVING' ? h('div', { class: 'small' }, `Review due ${fmtDateTime(x.reviewAt)}`) : null,
    h('div', { class: 'small muted' }, `Placed by ${x.placedBy}, ${fmtDateTime(x.placedAt)}`),
    x.outcome ? h('div', { class: 'small' }, h('b', {}, `${x.outcomeLabel} (${x.outcomeBy}): `), x.outcomeNote) : null,
    x.canAct ? h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => extendDialog(x, reload) }, 'Staying longer'),
      h('button', { class: 'btn small primary', onclick: () => endDialog(x, o, reload) }, 'End observation')) : null,
    h('details', {}, h('summary', { class: 'small' }, `History (${x.steps.length})`),
      h('ol', { class: 'det-steps' }, x.steps.map((s) => h('li', { class: 'det-step' }, h('div', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`), h('div', { class: 'small' }, s.body))))),
  );
}

// ED doctors' Medical Assessment and ED nurses' Monitoring.
export function observationPanel(personId, s, reload) {
  if (!s || (!s.current.length && !s.past.length && !s.canPlace)) return null;
  return h('section', { class: 'stack' },
    h('div', { class: 'spread' }, h('h3', {}, 'Short stay for observation'),
      s.canPlace && !s.current.length ? h('button', { class: 'btn small', onclick: () => placeDialog(personId, reload) }, 'Place in observation') : null),
    s.current.map((x) => card(x, s.options, reload)),
    s.past.length ? h('details', {}, h('summary', { class: 'small' }, `Earlier (${s.past.length})`), h('div', { class: 'stack' }, s.past.map((x) => card(x, s.options, reload)))) : null,
  );
}

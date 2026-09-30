import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDateTime } from '../lib/ui.js';
import { formDialog as dialog, field, select } from '../lib/forms.js';

// Lines, tubes and catheters: inserted → position confirmed before use where needed → site
// checked by a set time → still needed → removed, whole or not. Caregivers report problems.
// Check intervals are the organisation's own; national requirements are RR-DEVICE-001.
const LABEL = { confirm: 'Confirm position', check: 'Check site', needed: 'Still needed', remove: 'Remove', report: 'Report a problem' };
const EARLIER = { 0: 'Just now', 1: 'About an hour ago', 4: 'About 4 hours ago', 12: 'About 12 hours ago', 24: 'Yesterday', 48: 'Two days ago', 72: 'Three days ago' };
const RESEARCH = 'How often to check, how long it may stay in, and how its position must be confirmed follow your organisation\'s settings for now. National requirements are still being researched (RR-DEVICE-001).';

function insertDialog(personId, s, reload) {
  const o = s.options;
  const kind = select(Object.entries(o.kinds).map(([k, v]) => [k, v.label]), 'What it is');
  const site = h('input', { 'aria-label': 'Where', placeholder: 'e.g. Left forearm' });
  const size = h('input', { 'aria-label': 'Size', placeholder: 'Optional, e.g. 20G or 14Fr' });
  const reason = h('input', { 'aria-label': 'Why it is needed', placeholder: 'e.g. IV antibiotics' });
  const when = select(o.earlier.map((n) => [String(n), EARLIER[n]]), 'When it went in', null);
  const where = h('input', { 'aria-label': 'Where it went in', placeholder: 'e.g. Emergency department' });
  const hint = h('p', { class: 'small warn-text' });
  const show = () => {
    where.parentElement && (where.parentElement.hidden = when.value === '0');
    hint.textContent = o.kinds[kind.value]?.position ? 'Its position must be confirmed before it is used.' : '';
  };
  when.addEventListener('change', show);
  kind.addEventListener('change', show);
  queueMicrotask(show);
  dialog('Line or tube put in', h('div', { class: 'stack' },
    field('What it is', kind), hint, field('Where', site), field('Size', size), field('Why it is needed', reason),
    field('When it went in', when), field('Where it went in', where), h('p', { class: 'small muted' }, RESEARCH),
  ), 'Save', async () => {
    await post(`/api/work/patients/${personId}/devices`, { kind: kind.value, site: site.value, size: size.value, reason: reason.value, hoursAgo: Number(when.value), where: when.value === '0' ? '' : where.value });
    toast('Saved.');
    reload();
  });
}

function actDialog(x, action, o, reload) {
  const note = h('textarea', { 'aria-label': 'Note' });
  const send = (body) => post(`/api/work/devices/${x.id}/${action}`, { note: note.value, ...body });
  const saved = () => { toast('Saved.'); reload(); };
  if (action === 'confirm') {
    note.placeholder = 'What was seen, e.g. "Tip in the lower SVC on the chest X-ray"';
    const how = select(Object.entries(o.confirm), 'How it was confirmed');
    return dialog('Confirm position', h('div', { class: 'stack' }, field('How it was confirmed', how), field('What was seen', note)), 'Confirm', async () => { await send({ how: how.value }); saved(); });
  }
  if (action === 'check') {
    note.placeholder = 'Needed if it does not look fine, e.g. "Red 2 cm around the site; told Dr Li"';
    const look = select(Object.entries(o.site), 'How the site looks');
    return dialog('Check site', h('div', { class: 'stack' }, field('How the site looks', look), field('Note', note)), 'Save', async () => { await send({ siteLook: look.value }); saved(); });
  }
  if (action === 'needed') {
    note.placeholder = 'e.g. IV antibiotics until Friday';
    return dialog('Still needed', h('div', { class: 'stack' }, field('Why it is still needed', note), h('p', { class: 'small muted' }, 'If it is no longer needed, remove it instead.')),
      'Save', async () => { await send({ needed: 'yes' }); saved(); });
  }
  if (action === 'report') {
    note.placeholder = 'e.g. Catheter bag empty all morning and her tummy is sore';
    return dialog('Report a problem', h('div', { class: 'stack' }, field('What you saw', note), h('p', { class: 'small muted' }, 'The nurse gets a task to check it.')),
      'Report', async () => { await send({}); toast('Reported. The nurse has been asked to check it.'); reload(); });
  }
  note.placeholder = 'Needed if there was a problem, e.g. "Red and sore; tip sent to the lab"';
  const reason = select(Object.entries(o.removed), 'Why it came out');
  const intact = x.line ? select([['yes', 'Yes'], ['no', 'No']], 'Came out whole') : null;
  return dialog('Remove', h('div', { class: 'stack' }, field('Why it came out', reason), intact ? field('Came out whole', intact) : null, field('Note', note)),
    'Remove', async () => { await send({ reasonRemoved: reason.value, intact: intact?.value ?? '' }); saved(); });
}

function deviceCard(x, o, reload) {
  const tone = x.state === 'NEEDS_CHECK' || x.overdue || x.problem ? 'warn' : x.state === 'REMOVED' ? '' : 'ok';
  const tag = x.state === 'NEEDS_CHECK' ? x.stateLabel : x.overdue ? 'Check overdue' : x.problem ? `Last check: ${x.siteLabel.toLowerCase()}` : x.stateLabel;
  return h('div', { class: 'tile stack device' },
    h('div', { class: 'spread' }, h('b', {}, `${x.kindLabel}${x.site ? ` · ${x.site}` : ''}${x.size ? ` · ${x.size}` : ''}`), h('span', { class: `tag ${tone}` }, tag)),
    h('div', { class: 'small' }, h('b', {}, 'For: '), x.reason, x.day ? h('span', { class: 'muted' }, ` · day ${x.day}`) : null),
    h('div', { class: 'small muted' }, `Put in ${fmtDateTime(x.insertedAt)}${x.insertedWhere ? ` (${x.insertedWhere})` : ` by ${x.insertedBy}`}`),
    x.confirmLabel ? h('div', { class: 'small muted' }, `Position confirmed by ${x.confirmedBy}: ${x.confirmLabel}`) : null,
    x.state === 'IN_PLACE' && x.checkDue ? h('div', { class: `small${x.overdue ? ' warn-text' : ' muted'}` }, `Next check by ${fmtDateTime(x.checkDue)}`) : null,
    x.neededWhy ? h('div', { class: 'small muted' }, `Still needed (${fmtDateTime(x.neededAt)}): ${x.neededWhy}`) : null,
    x.removeLabel ? h('div', { class: 'small' }, h('b', {}, `Removed by ${x.removedBy} ${fmtDateTime(x.removedAt)}: `), x.removeLabel, x.intact === 0 ? ' · did not come out whole' : '') : null,
    x.actions.length ? h('div', { class: 'row' }, x.actions.map((a) => h('button', { class: `btn small${a === 'confirm' || (a === 'check' && x.overdue) ? ' primary' : ''}`, onclick: () => actDialog(x, a, o, reload) }, LABEL[a]))) : null,
    h('details', {}, h('summary', { class: 'small' }, `History (${x.log.length})`),
      h('ol', { class: 'det-steps' }, x.log.map((s) => h('li', { class: 'det-step' },
        h('div', { class: 'small muted' }, `${s.by} · ${fmtDateTime(s.at)}`), h('div', { class: 'small' }, s.body))))),
  );
}

// At the top of the person's Lines, tubes and equipment view.
export function devicesPanel(personId, s, reload) {
  if (!s) return null;
  return h('section', { class: 'stack' },
    h('div', { class: 'spread' }, h('h3', {}, 'Lines, tubes and catheters'),
      s.canInsert ? h('button', { class: 'btn small', onclick: () => insertDialog(personId, s, reload) }, 'Record one put in') : null),
    s.devices.length ? s.devices.map((x) => deviceCard(x, s.options, reload)) : h('div', { class: 'empty' }, 'None in place.'),
    s.removed.length ? h('details', {}, h('summary', { class: 'small' }, `Removed (${s.removed.length})`), h('div', { class: 'stack' }, s.removed.map((x) => deviceCard(x, s.options, reload)))) : null,
  );
}

import { h } from '../lib/dom.js';
import { post } from '../lib/api.js';
import { toast, fmtDay, fmtDateTime, titleCase } from '../lib/ui.js';
import { formDialog as dialog } from '../lib/forms.js';

// Safe staffing: each shift set against the service's staffing plan. The nurse in charge records
// when a rostered colleague can't come in; the rosterer fills the gap or decides it runs short.
const TONE = { OK: 'ok', ADVERTISED: 'warn', SHORT: 'warn', GAP: 'danger' };
const WORDS = { OK: 'Staffed to plan', ADVERTISED: 'Advertised as a vacancy', SHORT: 'Running short', GAP: 'Short of staff' };

export const shiftName = (s) => `${fmtDay(s.date)} · ${s.label}`;
export const shiftTag = (s) => h('span', { class: `tag ${TONE[s.status]}` }, WORDS[s.status]);

function personLine(p, canReport, reload) {
  return h('div', { class: 'row staff-person' },
    h('span', {}, p.name, h('span', { class: 'small muted' }, ` ${p.start}–${p.end}`)),
    p.absent ? h('span', { class: 'tag danger' }, `${p.absent.label} · told ${p.absent.reportedBy}, ${fmtDateTime(p.absent.at)}`) : null,
    !p.absent && canReport ? h('button', { class: 'btn small', onclick: () => absentDialog(p, reload) }, 'Can\'t come in') : null,
  );
}

function absentDialog(p, reload) {
  const kind = h('select', { 'aria-label': 'Why' }, h('option', { value: '' }, 'Choose…'), h('option', { value: 'SICK' }, 'Sick'), h('option', { value: 'OTHER' }, 'Other unplanned absence'));
  const note = h('input', { type: 'text', 'aria-label': 'Note for rostering', placeholder: 'e.g. Rang at 05:40, expects to be back tomorrow' });
  dialog(`${p.name} can't come in`, h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'Why', kind),
    h('label', { class: 'field' }, 'Note for rostering (optional)', note),
    h('p', { class: 'small muted' }, 'Rostering sees the gap straight away. Keep personal or health details out of the note.'),
  ), 'Record', async () => {
    const r = await post(`/api/work/roster-shifts/${p.rosterShiftId}/absent`, { kind: kind.value, note: note.value });
    toast(r.gap ? `Recorded. The shift is now short; rostering can see it.` : 'Recorded.');
    reload();
  });
}

export function roleLines(s, canReport, reload) {
  return s.roles.map((r) => h('div', { class: 'stack staff-role' },
    h('div', { class: 'spread' },
      h('b', {}, `${titleCase(r.many)}: ${r.working} of ${r.planned} working`),
      r.gap ? h('span', { class: `tag ${TONE[r.status]}` }, WORDS[r.status]) : null),
    r.people.length ? r.people.map((p) => personLine(p, canReport, reload)) : h('p', { class: 'small muted' }, `No ${r.many} rostered.`),
    r.short ? h('p', { class: 'small notice' }, `Running ${r.short.missing} short: ${r.short.plan} Told ${r.short.told}. Decided by ${r.short.decidedBy}, ${fmtDateTime(r.short.at)}.`) : null,
  ));
}

// Home → Allocation: this shift and the next.
export function staffingPanel(d, reload) {
  if (!d) return null;
  return h('section', { class: 'stack' }, h('h2', { class: 'section-title paua' }, 'Staff on shift'),
    d.shifts.map((s) => h('div', { class: 'card stack staffing-shift' },
      h('div', { class: 'spread' }, h('h3', {}, shiftName(s)), shiftTag(s)),
      s.noNurse ? h('div', { class: 'warn-text' }, 'No registered nurse is working this shift.') : null,
      roleLines(s, d.canReport, reload),
    )));
}

// Rostering: deciding about a gap.
function shortDialog(s, r, reload) {
  const plan = h('textarea', { 'aria-label': 'How the shift will be covered', placeholder: 'e.g. Nurse in charge helps with morning cares; showers moved to the afternoon; activities coordinator covers lunches' });
  const told = h('input', { type: 'text', 'aria-label': 'Who you told', placeholder: 'e.g. Facility manager, by phone at 06:15' });
  dialog(`Run short: ${shiftName(s)}`, h('div', { class: 'stack' },
    h('p', { class: 'muted' }, `${titleCase(r.many)}: ${r.working} of ${r.planned}. The shift runs ${r.gap} short of the staffing plan.`),
    h('label', { class: 'field' }, 'How the shift will be covered', plan),
    h('label', { class: 'field' }, 'Who you told', told),
    h('p', { class: 'small muted' }, 'The plan comes from this facility. National staffing requirements for aged residential care are still to be researched (RR-STAFF-001).'),
  ), 'Record', async () => {
    await post('/api/work/rostering/staffing/short', { date: s.date, period: s.period, roleKey: r.roleKey, plan: plan.value, told: told.value });
    toast('Recorded. The nurse in charge sees the plan for the shift.');
    reload();
  }, { wide: true });
}

export function gapCard(s, decide, reload) {
  const body = (key) => ({ date: s.date, period: s.period, roleKey: key });
  return h('div', { class: `card stack staffing-shift${s.status === 'GAP' ? ' alert-raised' : ''}` },
    h('div', { class: 'spread' }, h('b', {}, shiftName(s)), shiftTag(s)),
    s.noNurse ? h('div', { class: 'warn-text' }, 'No registered nurse is working this shift.') : null,
    roleLines(s, false, reload),
    s.roles.filter((r) => r.status === 'GAP' || r.status === 'ADVERTISED').map((r) => h('div', { class: 'stack' },
      h('div', { class: 'small muted' }, `Who could come in as a ${r.one}`),
      r.candidates.length ? r.candidates.map((c) => h('div', { class: 'candidate' },
        h('div', { class: 'row' }, h('b', {}, c.name), c.availability
          ? h('span', { class: 'tag ok' }, `${titleCase(c.availability.preference)} (${titleCase(c.availability.period)})`)
          : h('span', { class: 'tag muted' }, 'No availability recorded')),
        h('button', { class: 'btn primary small', onclick: () => decide('Call in',
          `${c.name} will be rostered as a ${r.one} on ${shiftName(s)}. Only do this once they have said yes.`,
          '/api/work/rostering/staffing/call-in', { ...body(r.roleKey), workerId: c.workerId }, `Rostered ${c.name}.`, reload) }, `Call in ${c.name.split(' ')[0]}`),
      )) : h('p', { class: 'small muted' }, `No ${r.one} is free that day.`),
      h('div', { class: 'row' },
        r.status === 'GAP' ? h('button', { class: 'btn small', onclick: () => decide('Advertise as a vacancy',
          `An open ${r.one} shift goes out to staff. It stays in the gap list until someone is given it.`,
          '/api/work/rostering/staffing/advertise', body(r.roleKey), 'Advertised.', reload) }, 'Advertise as a vacancy') : null,
        h('button', { class: 'btn small', onclick: () => shortDialog(s, r, reload) }, 'Run short'),
      ),
    )),
  );
}

export function weekTable(shifts) {
  const roles = shifts[0]?.roles.map((r) => r.roleKey) ?? [];
  const words = Object.fromEntries((shifts[0]?.roles ?? []).map((r) => [r.roleKey, titleCase(r.many)]));
  return h('div', { class: 'table-wrap' }, h('table', { class: 'data staffing-week' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Shift'), roles.map((k) => h('th', {}, words[k])), h('th', {}, ''))),
    h('tbody', {}, shifts.map((s) => h('tr', {},
      h('td', {}, shiftName(s)),
      s.roles.map((r) => h('td', { class: r.gap ? 'short' : '' }, `${r.working} of ${r.planned}`)),
      h('td', {}, shiftTag(s)),
    )))));
}

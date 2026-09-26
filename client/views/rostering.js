import { h, mount } from '../lib/dom.js';
import { get, post } from '../lib/api.js';
import { showError, toast, pageTitle, fmtDay, fmtDate, titleCase, confirmDialog } from '../lib/ui.js';
import { go } from '../app.js';
import { workHeader } from './entry.js';

// Rostering decisions. Requests, offers and availability arrive here as inputs; the roster
// changes only when a decision is recorded on this screen.
const SECTIONS = {
  vacancies: ['Vacancies', 'Open shifts and the staff who asked for them. Giving a shift puts it on that person’s roster.'],
  swaps: ['Swaps', 'Shifts staff have offered to colleagues. Approving moves the shift to the colleague you choose.'],
  leave: ['Leave', 'Leave requests waiting for a decision. Private reasons stay with the person who wrote them.'],
};

export async function rosteringView(section) {
  const info = SECTIONS[section];
  if (!info) { go('/work/home'); return h('div'); }
  const root = h('div');
  const load = async () => mount(root,
    workHeader(),
    pageTitle(info[0], () => go('/work/home')),
    h('div', { class: 'banner' }, info[1]),
    await DRAW[section](load),
  );
  await load();
  return root;
}

const shiftLine = (s) => h('div', {}, h('b', {}, `${fmtDay(s.date)} · ${s.start}–${s.end}`), s.position ? h('div', { class: 'muted' }, s.position) : null);

function candidateRow(c, onChoose) {
  const avail = c.availability
    ? h('span', { class: `tag ${c.availability.preference === 'UNAVAILABLE' ? 'warn' : 'ok'}` }, `${titleCase(c.availability.preference)} (${titleCase(c.availability.period)})`)
    : h('span', { class: 'tag muted' }, 'No availability recorded');
  return h('div', { class: 'candidate' },
    h('div', { class: 'row' }, h('b', {}, c.name), avail, c.rosteredThatDay ? h('span', { class: 'tag danger' }, 'Already rostered that day') : null),
    h('button', { class: 'btn primary small', disabled: c.rosteredThatDay, onclick: onChoose }, `Give to ${c.name.split(' ')[0]}`),
  );
}

async function decide(title, message, url, body, done, reload) {
  if (!(await confirmDialog(title, message, 'Record decision'))) return;
  try { await post(url, body); toast(done); reload(); } catch (err) { showError(err); }
}

const DRAW = {
  async vacancies(reload) {
    const rows = await get('/api/work/rostering/vacancies');
    if (!rows.length) return h('div', { class: 'card empty' }, 'No open shifts.');
    return h('div', { class: 'list' }, rows.map((v) => h('div', { class: 'card stack' },
      h('div', { class: 'spread' }, shiftLine(v), h('span', { class: 'tag' }, titleCase(v.roleKey.replace(/^arc-/, '')))),
      v.candidates.length
        ? v.candidates.map((c) => candidateRow(c, () => decide(
          'Give this shift',
          `${c.name} will be rostered on ${fmtDay(v.date)}, ${v.start}–${v.end}. Anyone else who asked will see it was filled.`,
          `/api/work/rostering/vacancies/${v.id}/decide`, { workerId: c.workerId }, `Rostered ${c.name}.`, reload,
        )))
        : h('p', { class: 'muted' }, 'Nobody has asked for this shift yet.'),
    )));
  },

  async swaps(reload) {
    const rows = await get('/api/work/rostering/swaps');
    if (!rows.length) return h('div', { class: 'card empty' }, 'No shifts offered for swapping.');
    return h('div', { class: 'list' }, rows.map((o) => h('div', { class: 'card stack' },
      h('div', { class: 'spread' }, shiftLine(o), h('span', { class: 'small muted' }, `Offered by ${o.offeredBy}`)),
      o.candidates.length
        ? o.candidates.map((c) => candidateRow(c, () => decide(
          'Approve swap',
          `The shift moves from ${o.offeredBy} to ${c.name}. Both rosters change when you record this.`,
          `/api/work/rostering/swaps/${o.id}/decide`, { workerId: c.workerId }, `Shift moved to ${c.name}.`, reload,
        )))
        : h('p', { class: 'muted' }, 'No colleague has offered to take it yet.'),
      h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => decide(
        'Decline swap', `${o.offeredBy} stays rostered for this shift.`,
        `/api/work/rostering/swaps/${o.id}/decide`, { decline: true }, 'Swap declined. The roster is unchanged.', reload,
      ) }, 'Decline swap')),
    )));
  },

  async leave(reload) {
    const rows = await get('/api/work/rostering/leave');
    if (!rows.length) return h('div', { class: 'card empty' }, 'No leave requests waiting.');
    return h('div', { class: 'list' }, rows.map((l) => h('div', { class: 'card stack' },
      h('div', { class: 'spread' },
        h('div', {}, h('b', {}, l.name), h('div', { class: 'muted' }, `${l.type} · ${fmtDate(l.startDate)} to ${fmtDate(l.endDate)}`)),
        l.rosteredShifts ? h('span', { class: 'tag warn' }, `${l.rosteredShifts} rostered shift${l.rosteredShifts === 1 ? '' : 's'} in this time`) : h('span', { class: 'tag ok' }, 'No rostered shifts'),
      ),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary small', onclick: () => decide('Approve leave',
          `${l.name}'s ${l.type.toLowerCase()} will be approved.${l.rosteredShifts ? ' Their rostered shifts stay on the roster until you change them.' : ''}`,
          `/api/work/rostering/leave/${l.id}/decide`, { approve: true }, 'Leave approved.', reload) }, 'Approve'),
        h('button', { class: 'btn small', onclick: () => decide('Decline leave', `${l.name}'s request will be declined.`,
          `/api/work/rostering/leave/${l.id}/decide`, { approve: false }, 'Leave declined.', reload) }, 'Decline'),
      ),
    )));
  },
};

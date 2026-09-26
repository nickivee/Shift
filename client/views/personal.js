import { h, icon, mount } from '../lib/dom.js';
import { get, post, del } from '../lib/api.js';
import { showError, toast, pageTitle, fmtDate, fmtDay, money, titleCase } from '../lib/ui.js';
import { state, go } from '../app.js';

// PERSONAL: private employee workspace. Only the signed-in worker's own information. It
// never opens a patient record and never creates WORK authority.
const FUNCTIONS = [
  ['roster', 'Roster', 'Own roster and attendance.'],
  ['availability', 'Availability', 'Record availability.'],
  ['exchange', 'Shift exchange', 'Anonymous open shift exchange.'],
  ['payslips', 'Payslips', 'Your payslips.'],
  ['leave', 'Leave', 'Request and track leave.'],
  ['credentials', 'Credentials', 'APC and credential information.'],
  ['training', 'Training', 'Your training and what is due.'],
];

const header = () => h('div', { class: 'header-card card' },
  h('div', { class: 'logo small' }, 'S'),
  h('div', { class: 'grow' }, h('h1', {}, 'PERSONAL'), h('div', { class: 'sub' }, `${state.me.worker.name} · private employee workspace`)),
);

export function personalView() {
  return h('div', {},
    header(),
    h('div', { class: 'banner' }, h('strong', {}, 'PERSONAL'), 'Private employee workspace. PERSONAL does not open patient records or create WORK authority.'),
    h('div', { class: 'list' }, FUNCTIONS.map(([id, label, desc]) =>
      h('button', { class: 'list-item', onclick: () => go(`/personal/${id}`) },
        h('div', { class: 'icon-tile' }, icon(id)),
        h('div', { class: 'grow' }, h('h3', {}, label), h('p', {}, desc)),
        h('span', { class: 'chev' }, '›'),
      ),
    )),
  );
}

export async function personalFunctionView(id) {
  const fn = FUNCTIONS.find((f) => f[0] === id);
  if (!fn) { go('/personal'); return h('div'); }
  const root = h('div');
  const load = async () => mount(root, header(), pageTitle(fn[1], () => go('/personal')), await VIEWS[id](load));
  await load();
  return root;
}

const table = (heads, rows) => h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
  h('thead', {}, h('tr', {}, heads.map((x) => h('th', {}, x)))),
  h('tbody', {}, rows),
));
const synthetic = (on) => (on ? h('p', { class: 'synthetic' }, 'Synthetic data') : null);

const VIEWS = {
  async roster() {
    const r = await get('/api/personal/roster');
    const today = new Date().toISOString().slice(0, 10);
    const past = r.shifts.filter((s) => s.date < today);
    const upcoming = r.shifts.filter((s) => s.date >= today);
    return h('div', { class: 'stack' },
      h('div', { class: 'banner' }, 'Your roster is the plan. Attendance is what was recorded as worked. They are kept separate.'),
      h('h3', {}, 'Upcoming'),
      upcoming.length ? table(['Day', 'Time', 'Where', 'Position'], upcoming.map((s) => h('tr', {}, h('td', {}, fmtDay(s.date)), h('td', {}, `${s.start}–${s.end}`), h('td', {}, s.service), h('td', {}, s.position)))) : h('div', { class: 'card empty' }, 'No rostered shifts.'),
      h('h3', {}, 'Recent attendance'),
      past.length ? table(['Day', 'Rostered', 'Attended', 'Variance'], past.reverse().map((s) => h('tr', {},
        h('td', {}, fmtDay(s.date)), h('td', {}, `${s.start}–${s.end}`),
        h('td', {}, s.actualStart ? `${s.actualStart.slice(11, 16)}–${(s.actualEnd ?? '').slice(11, 16)}` : h('span', { class: 'tag warn' }, 'Not recorded')),
        h('td', {}, s.variance ?? ''),
      ))) : h('div', { class: 'card empty' }, 'No recent shifts.'),
      synthetic(true),
    );
  },

  async availability(reload) {
    const rows = await get('/api/personal/availability');
    const date = h('input', { type: 'date', min: new Date().toISOString().slice(0, 10) });
    const period = h('select', {}, [['AM', 'AM'], ['PM', 'PM'], ['NIGHT', 'Night'], ['ALL_DAY', 'All day']].map(([v, l]) => h('option', { value: v }, l)));
    const pref = h('select', {}, [['AVAILABLE', 'Available'], ['PREFERRED', 'Preferred'], ['UNAVAILABLE', 'Unavailable']].map(([v, l]) => h('option', { value: v }, l)));
    const note = h('input', { type: 'text', placeholder: 'Private note (optional)' });
    return h('div', { class: 'stack' },
      h('div', { class: 'banner' }, 'Availability tells your rosterer what suits you. It is not a rostered shift until the roster says so.'),
      h('form', { class: 'card stack', onsubmit: async (e) => {
        e.preventDefault();
        try { await post('/api/personal/availability', { date: date.value, period: period.value, preference: pref.value, note: note.value }); toast('Availability recorded.'); reload(); } catch (err) { showError(err); }
      } },
        h('div', { class: 'row' }, h('label', { class: 'field' }, 'Date', date), h('label', { class: 'field' }, 'Period', period), h('label', { class: 'field' }, 'Preference', pref)),
        note, h('button', { class: 'btn primary', type: 'submit' }, 'Record availability'),
      ),
      rows.length ? table(['Date', 'Period', 'Preference', 'Note', ''], rows.map((a) => h('tr', {},
        h('td', {}, fmtDay(a.date)), h('td', {}, titleCase(a.period)), h('td', {}, titleCase(a.preference)), h('td', {}, a.note ?? ''),
        h('td', {}, h('button', { class: 'btn small', onclick: async () => { try { await del(`/api/personal/availability/${a.id}`); reload(); } catch (err) { showError(err); } } }, 'Withdraw')),
      ))) : h('div', { class: 'card empty' }, 'No availability recorded.'),
    );
  },

  async exchange(reload) {
    const shifts = await get('/api/personal/open-shifts');
    return h('div', { class: 'stack' },
      h('div', { class: 'banner' }, 'Open shifts are shared anonymously. Showing interest does not change your roster; only a rostering decision does.'),
      shifts.length ? h('div', { class: 'list' }, shifts.map((s) => h('div', { class: 'card spread' },
        h('div', {}, h('b', {}, `${fmtDay(s.date)} · ${s.start}–${s.end}`), h('div', { class: 'muted' }, s.service)),
        s.myInterest === 'INTERESTED'
          ? h('span', { class: 'row' }, h('span', { class: 'tag ok' }, 'Interest sent'), h('button', { class: 'btn small', onclick: () => interest(s, false) }, 'Withdraw'))
          : h('button', { class: 'btn primary small', onclick: () => interest(s, true) }, "I'm interested"),
      ))) : h('div', { class: 'card empty' }, 'No open shifts for your positions.'),
    );
    async function interest(s, on) {
      try { await post(`/api/personal/open-shifts/${s.id}/interest`, { interested: on }); toast(on ? 'Interest sent. Your roster is unchanged.' : 'Interest withdrawn.'); reload(); } catch (err) { showError(err); }
    }
  },

  async payslips() {
    const slips = await get('/api/personal/payslips');
    const detail = h('div');
    const open = async (id) => {
      try {
        const p = await get(`/api/personal/payslips/${id}`);
        mount(detail, h('div', { class: 'card stack' },
          h('h3', {}, `${p.employer} · paid ${fmtDate(p.payDate)}`),
          h('div', { class: 'muted' }, `Period ${fmtDate(p.periodStart)} to ${fmtDate(p.periodEnd)}`),
          table(['Item', 'Amount'], p.lines.map((l) => h('tr', {}, h('td', {}, l.label), h('td', {}, money(l.cents))))),
          h('div', { class: 'spread' }, h('b', {}, 'Net pay'), h('b', {}, money(p.net))),
          synthetic(p.dataSource === 'SYNTHETIC'),
        ));
      } catch (err) { showError(err); }
    };
    return h('div', { class: 'stack' },
      slips.length ? h('div', { class: 'list' }, slips.map((p) => h('button', { class: 'list-item', onclick: () => open(p.id) },
        h('div', { class: 'grow' }, h('h3', {}, `${fmtDate(p.payDate)} · ${money(p.net)} net`), h('p', {}, `${p.employer} · ${fmtDate(p.periodStart)} to ${fmtDate(p.periodEnd)}`)),
        h('span', { class: 'chev' }, '›'),
      ))) : h('div', { class: 'card empty' }, 'No payslips.'),
      detail,
    );
  },

  async leave(reload) {
    const l = await get('/api/personal/leave');
    const type = h('select', {}, l.balances.map((b) => h('option', { value: b.type }, b.type)));
    const start = h('input', { type: 'date' });
    const end = h('input', { type: 'date' });
    const reason = h('input', { type: 'text', placeholder: 'Private note (optional)' });
    return h('div', { class: 'stack' },
      h('div', { class: 'tiles' }, l.balances.map((b) => h('div', { class: 'tile' }, h('h3', {}, b.type), h('div', { class: 'big' }, `${b.hours} h`), h('div', { class: 'small muted' }, `as at ${fmtDate(b.asAt)}`)))),
      l.balances.length ? h('form', { class: 'card stack', onsubmit: async (e) => {
        e.preventDefault();
        try { await post('/api/personal/leave', { type: type.value, startDate: start.value, endDate: end.value, reason: reason.value }); toast('Leave requested. It is not approved until your manager decides.'); reload(); } catch (err) { showError(err); }
      } },
        h('h3', {}, 'Request leave'),
        h('div', { class: 'row' }, h('label', { class: 'field' }, 'Type', type), h('label', { class: 'field' }, 'From', start), h('label', { class: 'field' }, 'To', end)),
        reason, h('button', { class: 'btn primary', type: 'submit' }, 'Request'),
      ) : null,
      l.requests.length ? table(['Type', 'Dates', 'State', ''], l.requests.map((r) => h('tr', {},
        h('td', {}, r.type), h('td', {}, `${fmtDate(r.startDate)} – ${fmtDate(r.endDate)}`), h('td', {}, titleCase(r.state)),
        h('td', {}, r.state === 'REQUESTED' ? h('button', { class: 'btn small', onclick: async () => { try { await post(`/api/personal/leave/${r.id}/cancel`); reload(); } catch (err) { showError(err); } } }, 'Cancel') : null),
      ))) : h('div', { class: 'card empty' }, 'No leave requests.'),
    );
  },

  async credentials() {
    const c = await get('/api/personal/credentials');
    return h('div', { class: 'stack' },
      h('h3', {}, 'Practising authority'),
      c.authority.length ? c.authority.map((a) => h('div', { class: 'card stack' },
        h('div', { class: 'spread' }, h('b', {}, a.profession), a.effective ? h('span', { class: 'tag ok' }, 'Current') : h('span', { class: 'tag danger' }, 'Not current')),
        h('div', { class: 'muted' }, [a.regulator, a.registration ? `Reg. ${a.registration}` : null, a.scope].filter(Boolean).join(' · ')),
        h('div', { class: 'small' }, `Valid ${fmtDate(a.validFrom)} to ${a.validTo ? fmtDate(a.validTo) : 'no end date'}`),
        a.conditions ? h('div', { class: 'small' }, `Conditions: ${a.conditions}`) : null,
      )) : h('div', { class: 'card empty' }, 'No regulated practising authority recorded.'),
      h('h3', {}, 'Other credentials'),
      c.other.length ? table(['Credential', 'Issuer', 'Reference', 'Valid to'], c.other.map((x) => h('tr', {}, h('td', {}, x.title), h('td', {}, x.issuer ?? ''), h('td', {}, x.reference ?? ''), h('td', {}, x.validTo ? fmtDate(x.validTo) : '—')))) : h('div', { class: 'card empty' }, 'None recorded.'),
      synthetic(true),
    );
  },

  async training() {
    const rows = await get('/api/personal/training');
    return h('div', { class: 'stack' },
      rows.length ? table(['Course', 'Provider', 'Completed', 'Expires', 'State'], rows.map((t) => h('tr', {},
        h('td', {}, h('b', {}, t.course)), h('td', {}, t.provider ?? ''), h('td', {}, t.completedAt ? fmtDate(t.completedAt) : '—'), h('td', {}, t.expiresAt ? fmtDate(t.expiresAt) : '—'),
        h('td', {}, h('span', { class: `tag ${t.state === 'DUE' ? 'warn' : t.state === 'COMPLETED' ? 'ok' : ''}` }, titleCase(t.state))),
      ))) : h('div', { class: 'card empty' }, 'No training records.'),
      synthetic(true),
    );
  },
};

import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { audit } from './audit.ts';
import { ROLE_BY_KEY } from '../config/workstations.ts';
import { CD_REFS } from '../config/medicines.ts';
import { requireRule } from './rulevalue.ts';
import { newId, now, todayLocal, HttpError } from '../lib/util.ts';

// A ward's controlled drug book (Misuse of Drugs Regulations 1977 reg 44): one page for each form of
// each drug → each receipt is signed by the person who issued it and the person who received it → each
// dose given is entered straight after it is given (done where the dose is recorded) → the book is
// checked against the stock jointly once in every week → the stock is counted as at 30 June and
// 31 December. A count that differs from the book is shown and needs an explanation. SHIFT does not
// say what may be stocked or in what amounts.

type Row = Record<string, string | number | null>;
const text = (v: unknown, max = 400) => String(v ?? '').trim().slice(0, max);
const DAY = 86_400_000;
const round = (n: number) => Math.round(n * 1e6) / 1e6;

function logged(store: Store, ctx: WorkContext, operation: string, id: string, reason: string) {
  audit(store, {
    actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', subjectPersonId: null,
    operation, objectType: 'cd_book_page', objectId: id, decision: 'ALLOW', outcome: 'COMMITTED', reason: reason.slice(0, 300), ruleRefs: CD_REFS, engines: [11],
  });
}

const balanceOf = (store: Store, pageId: string) =>
  store.get<{ balance: number }>('SELECT balance FROM cd_book_entry WHERE page_id = ? ORDER BY at DESC, rowid DESC LIMIT 1', pageId)?.balance ?? 0;

type Stocktake = { month: number; day: number };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const iso = (yr: number, s: Stocktake) => `${yr}-${String(s.month).padStart(2, '0')}-${String(s.day).padStart(2, '0')}`;

// The most recent stocktake date that has passed, and the one before it. The dates are a rule the
// organisation's jurisdiction sets (cd.stocktake_dates), so they can change and differ by place.
export function stocktakeDates(store: Store, organisationId: string, today = todayLocal()): string[] {
  const y = Number(today.slice(0, 4));
  const dates = requireRule<Stocktake[]>(store, organisationId, 'cd.stocktake_dates', today);
  const all = [y - 1, y].flatMap((yr) => dates.map((s) => iso(yr, s))).filter((d) => d <= today).sort();
  return all.slice(-2).reverse();
}
const labelOf = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

// Pages for this ward, with the balance the book shows, for choosing where a dose is entered.
export function pagesFor(store: Store, serviceId: string) {
  return store.all<Row>('SELECT id, drug, unit FROM cd_book_page WHERE service_id = ? ORDER BY drug', serviceId)
    .map((p): Record<string, any> => ({ ...p, balance: balanceOf(store, String(p.id)) }));
}

function colleagues(store: Store, ctx: WorkContext) {
  const today = todayLocal();
  const profession = ROLE_BY_KEY.get(ctx.role.roleKey)?.profession;
  return store.all<{ id: string; name: string }>(
    `SELECT DISTINCT w.id, w.display_name AS name FROM position pos JOIN employment em ON em.id = pos.employment_id JOIN workforce_person w ON w.id = em.workforce_person_id
      WHERE pos.service_id = ? AND pos.start_date <= ? AND (pos.end_date IS NULL OR pos.end_date >= ?) AND w.status = 'ACTIVE' AND w.id != ? ORDER BY w.display_name`,
    ctx.serviceId, today, today, ctx.workerId)
    .filter((r) => {
      const role = store.get<{ role_key: string }>(
        `SELECT pos.role_key FROM position pos JOIN employment em ON em.id = pos.employment_id WHERE em.workforce_person_id = ? AND pos.service_id = ? ORDER BY pos.start_date DESC LIMIT 1`, r.id, ctx.serviceId);
      const caps = ROLE_BY_KEY.get(String(role?.role_key))?.capabilities as string[] | undefined;
      if (!caps?.includes('cd.register')) return false;
      if (!profession) return true;
      const a = store.get<{ status: string; valid_from: string; valid_to: string | null }>(
        'SELECT status, valid_from, valid_to FROM professional_authority WHERE workforce_person_id = ? AND profession = ? ORDER BY valid_from DESC LIMIT 1', r.id, profession);
      return !!a && a.status === 'CURRENT' && a.valid_from <= today && (a.valid_to === null || a.valid_to >= today);
    });
}

function gate(store: Store, ctx: WorkContext) {
  const d = (ctx.role.capabilities as string[]).includes('cd.register');
  if (!d) throw new HttpError(403, 'BLOCK', 'Your workstation does not include the controlled drug book.');
}

export function list(store: Store, ctx: WorkContext) {
  gate(store, ctx);
  const dates = stocktakeDates(store, ctx.organisationId);
  const checkDays = requireRule<number>(store, ctx.organisationId, 'cd.check_interval_days');
  const due = dates[0] ?? null;
  const pages = store.all<Row>('SELECT id, drug, unit, created_at AS createdAt FROM cd_book_page WHERE service_id = ? ORDER BY drug', ctx.serviceId).map((p): Record<string, any> => {
    const id = String(p.id);
    const entries = store.all<Row>(
      `SELECT e.id, e.kind, e.qty, e.balance, e.counted, e.variance, e.as_at AS asAt, e.issued_by AS issuedBy, e.note, e.at,
              w.display_name AS "by", s.display_name AS second, pe.given_name || ' ' || pe.family_name AS patient
         FROM cd_book_entry e JOIN workforce_person w ON w.id = e.by_id LEFT JOIN workforce_person s ON s.id = e.second_id LEFT JOIN person pe ON pe.id = e.person_id
        WHERE e.page_id = ? ORDER BY e.at DESC, e.rowid DESC LIMIT 12`, id).map((e): Record<string, any> => ({ ...e, variance: !!e.variance }));
    const lastCheck = store.get<{ at: string }>("SELECT at FROM cd_book_entry WHERE page_id = ? AND kind IN ('CHECK') ORDER BY at DESC LIMIT 1", id)?.at ?? null;
    const sinceCheck = lastCheck ? Date.now() - Date.parse(lastCheck) : Infinity;
    const stocktakeDone = due ? !!store.get("SELECT 1 FROM cd_book_entry WHERE page_id = ? AND kind = 'STOCKTAKE' AND as_at = ?", id, due) : true;
    return {
      ...p, balance: balanceOf(store, id), entries, lastCheck, checkDue: sinceCheck >= checkDays * DAY, checkOverdue: sinceCheck > checkDays * DAY,
      stocktakeDue: !stocktakeDone && !!due, stocktakeFor: due && !stocktakeDone ? labelOf(due) : null,
    };
  });
  return {
    pages, colleagues: colleagues(store, ctx), stocktakes: dates.map((d) => ({ value: d, label: labelOf(d) })), checkDays, stocktakeNames: requireRule<Stocktake[]>(store, ctx.organisationId, 'cd.stocktake_dates').map((s) => `${s.day} ${MONTHS[s.month - 1]}`),
    toDo: pages.filter((p) => p.checkDue || p.stocktakeDue).length,
  };
}

// Home count.
export const toDo = (store: Store, ctx: WorkContext) => ((ctx.role.capabilities as string[]).includes('cd.register') ? list(store, ctx).toDo : 0);

interface Body { drug?: string; unit?: string; pageId?: string; qty?: string; issuedBy?: string; counted?: string; second?: string; note?: string; asAt?: string }

const num = (v: unknown, label: string, allowZero = false) => {
  const n = Number(text(v, 14));
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) throw new HttpError(400, 'NUMBER', `Write ${label} as a number${allowZero ? '' : ' above 0'}.`);
  return round(n);
};
const pageOf = (store: Store, ctx: WorkContext, id: unknown) => {
  const p = store.get<Row>('SELECT id, drug, unit FROM cd_book_page WHERE id = ? AND service_id = ?', text(id, 64), ctx.serviceId);
  if (!p) throw new HttpError(404, 'PAGE', 'That page is not in this ward\'s book.');
  return p;
};
const secondOf = (store: Store, ctx: WorkContext, id: unknown, required: boolean) => {
  if (!id) {
    if (required) throw new HttpError(400, 'SECOND_REQUIRED', 'Choose the colleague who checked it with you.');
    return null;
  }
  const c = colleagues(store, ctx).find((x) => x.id === String(id));
  if (!c) throw new HttpError(400, 'SECOND', 'Choose a different colleague in this service with current practising authority.');
  return c;
};

export function act(store: Store, ctx: WorkContext, action: string, b: Body) {
  gate(store, ctx);
  enforce(store, ctx, { op: 'CD_BOOK' }, null);
  store.tx(() => {
    switch (action) {
      case 'page': {
        const drug = text(b.drug, 120);
        const unit = text(b.unit, 20);
        if (drug.length < 3) throw new HttpError(400, 'DRUG_REQUIRED', 'Write the drug and its form, e.g. "MORPHINE injection 10 mg/mL".');
        if (!unit) throw new HttpError(400, 'UNIT_REQUIRED', 'Write the unit the book counts in, e.g. "mL" or "tablets".');
        if (store.get('SELECT 1 FROM cd_book_page WHERE service_id = ? AND lower(drug) = lower(?)', ctx.serviceId, drug)) throw new HttpError(409, 'ALREADY', 'This ward\'s book already has a page for that.');
        const id = newId();
        store.insert('cd_book_page', { id, service_id: ctx.serviceId, drug, unit, created_by: ctx.workerId, created_at: now() });
        logged(store, ctx, 'CD_PAGE', id, drug);
        break;
      }
      case 'receipt': {
        const p = pageOf(store, ctx, b.pageId);
        const qty = num(b.qty, 'how much was received');
        const issuedBy = text(b.issuedBy, 120);
        if (issuedBy.length < 2) throw new HttpError(400, 'ISSUER_REQUIRED', 'Write who issued it, e.g. "Pharmacy, J Singh".');
        const bal = balanceOf(store, String(p.id));
        store.insert('cd_book_entry', { id: newId(), page_id: p.id, kind: 'RECEIPT', qty, balance: round(bal + qty), variance: 0, issued_by: issuedBy, note: text(b.note) || null, by_id: ctx.workerId, at: now() });
        logged(store, ctx, 'CD_RECEIPT', String(p.id), `${qty} ${p.unit} ${p.drug}`);
        break;
      }
      case 'check':
      case 'stocktake': {
        const p = pageOf(store, ctx, b.pageId);
        const counted = num(b.counted, 'what was counted', true);
        const second = secondOf(store, ctx, b.second, action === 'check');
        const bal = balanceOf(store, String(p.id));
        const variance = Math.abs(counted - bal) > 1e-9 ? 1 : 0;
        const note = text(b.note);
        if (variance && note.length < 5) throw new HttpError(400, 'VARIANCE', `The book shows ${bal} ${p.unit} and you counted ${counted}. Explain the difference.`);
        let asAt: string | null = null;
        if (action === 'stocktake') {
          asAt = stocktakeDates(store, ctx.organisationId).find((d) => d === text(b.asAt, 10)) ?? null;
          if (!asAt) throw new HttpError(400, 'AS_AT', 'Choose which stocktake this is from the list.');
          if (store.get("SELECT 1 FROM cd_book_entry WHERE page_id = ? AND kind = 'STOCKTAKE' AND as_at = ?", String(p.id), asAt)) throw new HttpError(409, 'ALREADY', 'That stocktake is already recorded for this page.');
        }
        store.insert('cd_book_entry', {
          id: newId(), page_id: p.id, kind: action === 'check' ? 'CHECK' : 'STOCKTAKE', balance: bal, counted, variance, as_at: asAt, second_id: second?.id ?? null, note: note || null, by_id: ctx.workerId, at: now(),
        });
        logged(store, ctx, action === 'check' ? 'CD_CHECK' : 'CD_STOCKTAKE', String(p.id), `${p.drug}: book ${bal}, counted ${counted}${variance ? ' (differs)' : ''}`);
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_ACTION', 'That is not something you can do here.');
    }
  });
  return list(store, ctx);
}

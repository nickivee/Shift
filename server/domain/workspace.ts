import type { Store } from '../db/database.ts';
import type { WorkContext, Session } from './identity.ts';
import { audit } from './audit.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Configurable Home. The authorised set comes from the role configuration; the worker's
// saved layout only orders, hides and adds items inside that set. Each department shows its
// own cards and record screens by default (ownCards, ownViews); the rest of the authorised set
// is there to add. Organisation-required cards can move but never hide. Changing the layout
// never changes authority.

interface LayoutItem { id: string; hidden: boolean }
interface Layout { v?: number; cards: LayoutItem[]; tabs: LayoutItem[]; views?: LayoutItem[] }
const VERSION = 2;

function merge(authorised: { id: string; required?: boolean }[], saved: LayoutItem[] | undefined, own?: string[]): LayoutItem[] {
  const allowed = new Map(authorised.map((a) => [a.id, a]));
  const out: LayoutItem[] = [];
  for (const s of saved ?? []) {
    const a = allowed.get(s.id);
    if (!a || out.some((o) => o.id === s.id)) continue;
    out.push({ id: s.id, hidden: a.required ? false : Boolean(s.hidden) });
  }
  for (const a of authorised) if (!out.some((o) => o.id === a.id)) out.push({ id: a.id, hidden: own ? !own.includes(a.id) : false });
  return out;
}

// A card is required only on the departments whose own work it is.
const cardsOf = (ctx: WorkContext) => ctx.role.homeCards.map((c) => ({ ...c, required: c.required && (!ctx.role.ownCards || ctx.role.ownCards.includes(c.id)) }));
const viewsOf = (ctx: WorkContext) => ctx.role.views.map((id) => ({ id }));

function saved(store: Store, ctx: WorkContext): Layout | undefined {
  const row = store.get<{ layout_json: string }>(
    'SELECT layout_json FROM home_layout WHERE workforce_person_id = ? AND service_id = ? AND role_key = ?', ctx.workerId, ctx.serviceId, ctx.role.roleKey,
  );
  const l = row ? (JSON.parse(row.layout_json) as Layout) : undefined;
  // Layouts saved before departments had their own screens start again from the department default.
  return l?.v === VERSION ? l : undefined;
}

function write(store: Store, ctx: WorkContext, layout: Layout) {
  store.run(
    `INSERT INTO home_layout (workforce_person_id, service_id, role_key, layout_json, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (workforce_person_id, service_id, role_key) DO UPDATE SET layout_json = excluded.layout_json, updated_at = excluded.updated_at`,
    ctx.workerId, ctx.serviceId, ctx.role.roleKey, JSON.stringify({ ...layout, v: VERSION }), now(),
  );
}

export function homeFor(store: Store, ctx: WorkContext) {
  const l = saved(store, ctx);
  const authorisedCards = cardsOf(ctx);
  const cards = merge(authorisedCards, l?.cards, ctx.role.ownCards);
  const tabs = merge(ctx.role.tabs, l?.tabs);
  const cardInfo = new Map(authorisedCards.map((c) => [c.id, c]));
  const tabInfo = new Map(ctx.role.tabs.map((t) => [t.id, t]));
  return {
    cards: cards.map((c) => ({ ...cardInfo.get(c.id)!, hidden: c.hidden })),
    tabs: tabs.map((t) => ({ ...tabInfo.get(t.id)!, hidden: t.hidden })),
    customised: Boolean(l),
  };
}

// The record screens this worker shows down the side, in order. Hidden ones stay authorised:
// ?view still opens them and they can be added back at any time.
export function shownViews(store: Store, ctx: WorkContext) {
  return merge(viewsOf(ctx), saved(store, ctx)?.views, ctx.role.ownViews);
}

const clean = (items: unknown): LayoutItem[] =>
  Array.isArray(items) ? items.filter((i) => i && typeof i.id === 'string').map((i) => ({ id: String(i.id), hidden: Boolean(i.hidden) })) : [];

export function saveHome(store: Store, ctx: WorkContext, input: Partial<Layout> | null) {
  const l = saved(store, ctx);
  if (input === null) {
    // Reset puts Home back to the department default; added record screens stay.
    if (l?.views) write(store, ctx, { cards: merge(cardsOf(ctx), undefined, ctx.role.ownCards), tabs: merge(ctx.role.tabs, undefined), views: l.views });
    else store.run('DELETE FROM home_layout WHERE workforce_person_id = ? AND service_id = ? AND role_key = ?', ctx.workerId, ctx.serviceId, ctx.role.roleKey);
  } else {
    write(store, ctx, {
      cards: merge(cardsOf(ctx), clean(input.cards), ctx.role.ownCards), tabs: merge(ctx.role.tabs, clean(input.tabs)),
      views: merge(viewsOf(ctx), l?.views, ctx.role.ownViews),
    });
  }
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: input === null ? 'HOME_LAYOUT_RESET' : 'HOME_LAYOUT_SAVE', outcome: 'COMMITTED' });
  return homeFor(store, ctx);
}

// Add a record screen to the side, remove one, or put them back to the department default.
export function saveViews(store: Store, ctx: WorkContext, input: { code?: unknown; shown?: unknown; reset?: unknown }) {
  const l = saved(store, ctx);
  const base = { cards: merge(cardsOf(ctx), l?.cards, ctx.role.ownCards), tabs: merge(ctx.role.tabs, l?.tabs) };
  let views = merge(viewsOf(ctx), l?.views, ctx.role.ownViews);
  let operation = 'SCREENS_RESET';
  if (input.reset) views = merge(viewsOf(ctx), undefined, ctx.role.ownViews);
  else {
    const code = String(input.code ?? '');
    const at = views.findIndex((v) => v.id === code);
    if (at < 0) throw new HttpError(403, 'BLOCK', 'That screen is not part of your workstation.');
    const [item] = views.splice(at, 1);
    item.hidden = !input.shown;
    // An added screen goes to the end of the list, after the department's own screens.
    views.push(item);
    operation = input.shown ? 'SCREEN_ADD' : 'SCREEN_REMOVE';
  }
  write(store, ctx, { ...base, views });
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation, reason: input.reset ? undefined : String(input.code), outcome: 'COMMITTED' });
  return { views: merge(viewsOf(ctx), views, ctx.role.ownViews) };
}

// Personal Notes: the worker's own working memory. Not clinical documentation, never
// routed, never shown to anyone else. Dismiss hides; retention basis is RR-RET-001.

export function notes(store: Store, s: Session, includeDismissed = false) {
  return store.all(
    `SELECT id, body, created_at AS createdAt, updated_at AS updatedAt, dismissed_at AS dismissedAt FROM personal_note
      WHERE workforce_person_id = ? ${includeDismissed ? '' : 'AND dismissed_at IS NULL'} ORDER BY updated_at DESC LIMIT 200`,
    s.workerId,
  );
}

export function saveNote(store: Store, s: Session, id: string | null, body: string) {
  const text = body.trim().slice(0, 4000);
  if (!text) throw new HttpError(400, 'EMPTY', 'The note is empty.');
  if (id) {
    const r = store.run('UPDATE personal_note SET body = ?, updated_at = ? WHERE id = ? AND workforce_person_id = ? AND dismissed_at IS NULL', text, now(), id, s.workerId);
    if (!r.changes) throw new HttpError(404, 'NOT_FOUND', 'Note not found.');
    return { id };
  }
  const nid = newId();
  store.insert('personal_note', { id: nid, workforce_person_id: s.workerId, body: text, created_at: now(), updated_at: now() });
  return { id: nid };
}

export function dismissNote(store: Store, s: Session, id: string, restore = false) {
  const r = store.run(
    `UPDATE personal_note SET dismissed_at = ? WHERE id = ? AND workforce_person_id = ?`, restore ? null : now(), id, s.workerId,
  );
  if (!r.changes) throw new HttpError(404, 'NOT_FOUND', 'Note not found.');
  return { id };
}

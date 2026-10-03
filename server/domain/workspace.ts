import type { Store } from '../db/database.ts';
import type { WorkContext, Session } from './identity.ts';
import { audit } from './audit.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Configurable Home. The authorised set comes from the role configuration. Home is always four
// squares: the worker chooses which four authorised functions are most useful, and the rest are one
// tap away under More functions. A role's record screens default to the tabs its workstation lists
// in the matrix, and the rest are added through Add. Changing the layout never changes authority.

interface LayoutItem { id: string; hidden: boolean }
interface Layout { v?: number; pinned?: string[]; views?: LayoutItem[] }
const VERSION = 3;
export const SQUARES = 4;

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

const cardsOf = (ctx: WorkContext) => ctx.role.homeCards.map((c) => ({ ...c }));
const viewsOf = (ctx: WorkContext) => ctx.role.views.map((id) => ({ id }));

function saved(store: Store, ctx: WorkContext): Layout | undefined {
  const row = store.get<{ layout_json: string }>(
    'SELECT layout_json FROM home_layout WHERE workforce_person_id = ? AND service_id = ? AND role_key = ?', ctx.workerId, ctx.serviceId, ctx.role.roleKey,
  );
  const l = row ? (JSON.parse(row.layout_json) as Layout) : undefined;
  // Layouts saved before departments had their own screens start again from the department default;
  // earlier ones keep their added screens and take the department's four squares.
  return l && l.v !== undefined && l.v >= 2 ? l : undefined;
}

function write(store: Store, ctx: WorkContext, layout: Layout) {
  store.run(
    `INSERT INTO home_layout (workforce_person_id, service_id, role_key, layout_json, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (workforce_person_id, service_id, role_key) DO UPDATE SET layout_json = excluded.layout_json, updated_at = excluded.updated_at`,
    ctx.workerId, ctx.serviceId, ctx.role.roleKey, JSON.stringify({ ...layout, v: VERSION }), now(),
  );
}

const firstFour = (ctx: WorkContext): string[] => {
  const authorised = ctx.role.homeCards.map((c) => c.id);
  return (ctx.role.homeFour ?? ctx.role.ownCards ?? authorised).filter((id) => authorised.includes(id)).slice(0, SQUARES);
};

function pinnedOf(ctx: WorkContext, l: Layout | undefined): string[] {
  const authorised = new Set(ctx.role.homeCards.map((c) => c.id));
  const own = (l?.pinned ?? []).filter((id, i, all) => authorised.has(id) && all.indexOf(id) === i).slice(0, SQUARES);
  return own.length ? own : firstFour(ctx);
}

export function homeFor(store: Store, ctx: WorkContext) {
  const l = saved(store, ctx);
  const info = new Map(cardsOf(ctx).map((c) => [c.id, c]));
  const pinned = pinnedOf(ctx, l);
  return {
    cards: pinned.map((id) => ({ ...info.get(id)!, hidden: false })),
    // The department's own functions beyond the four, then the rest of what the role is authorised for.
    more: [...info.values()].filter((c) => !pinned.includes(c.id) && (!ctx.role.ownCards || ctx.role.ownCards.includes(c.id))),
    add: [...info.values()].filter((c) => !pinned.includes(c.id) && ctx.role.ownCards && !ctx.role.ownCards.includes(c.id)),
    tabs: [],
    customised: Boolean(l?.pinned?.length),
  };
}

// The record screens a role shows by default are the tabs its workstation lists in the matrix and nothing
// more; every other authorised screen is one tap away through Add.
const defaultViews = (ctx: WorkContext): string[] | undefined =>
  ctx.role.tabs.length ? ctx.role.tabs.map((t) => t.id).filter((id) => ctx.role.views.includes(id)) : ctx.role.ownViews;

// The record screens this worker shows down the side, in order. Hidden ones stay authorised:
// ?view still opens them and they can be added back at any time.
export function shownViews(store: Store, ctx: WorkContext) {
  return merge(viewsOf(ctx), saved(store, ctx)?.views, defaultViews(ctx));
}

const clean = (items: unknown): LayoutItem[] =>
  Array.isArray(items) ? items.filter((i) => i && typeof i.id === 'string').map((i) => ({ id: String(i.id), hidden: Boolean(i.hidden) })) : [];

export function saveHome(store: Store, ctx: WorkContext, input: { cards?: unknown } | null) {
  const l = saved(store, ctx);
  if (input === null) {
    // Reset puts Home back to the department's four; added record screens stay.
    if (l?.views) write(store, ctx, { views: l.views });
    else store.run('DELETE FROM home_layout WHERE workforce_person_id = ? AND service_id = ? AND role_key = ?', ctx.workerId, ctx.serviceId, ctx.role.roleKey);
  } else {
    const authorised = new Set(ctx.role.homeCards.map((c) => c.id));
    const ids = (Array.isArray(input.cards) ? input.cards : []).map((c) => String(typeof c === 'object' && c ? (c as { id?: unknown }).id : c));
    if (ids.some((id) => !authorised.has(id))) throw new HttpError(403, 'BLOCK', 'That function is not part of your workstation.');
    const pinned = ids.filter((id, i) => ids.indexOf(id) === i);
    if (!pinned.length) throw new HttpError(400, 'CHOOSE', 'Choose at least one function for your Home.');
    if (pinned.length > SQUARES) throw new HttpError(400, 'FOUR', `Home holds ${SQUARES} functions. Choose ${SQUARES} or fewer.`);
    write(store, ctx, { pinned, views: l?.views });
  }
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: input === null ? 'HOME_LAYOUT_RESET' : 'HOME_LAYOUT_SAVE', outcome: 'COMMITTED' });
  return homeFor(store, ctx);
}

// Add a record screen to the side, remove one, or put them back to the department default.
export function saveViews(store: Store, ctx: WorkContext, input: { code?: unknown; shown?: unknown; reset?: unknown }) {
  const l = saved(store, ctx);
  const base = { pinned: l?.pinned };
  let views = merge(viewsOf(ctx), l?.views, defaultViews(ctx));
  let operation = 'SCREENS_RESET';
  if (input.reset) views = merge(viewsOf(ctx), undefined, defaultViews(ctx));
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
  return { views: merge(viewsOf(ctx), views, defaultViews(ctx)) };
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

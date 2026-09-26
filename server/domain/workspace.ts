import type { Store } from '../db/database.ts';
import type { WorkContext, Session } from './identity.ts';
import { audit } from './audit.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Configurable Home. The authorised set comes from the role configuration; the worker's
// saved layout only orders and hides items inside that set. Organisation-required cards can
// move but never hide. Changing the layout never changes authority.

interface LayoutItem { id: string; hidden: boolean }
interface Layout { cards: LayoutItem[]; tabs: LayoutItem[] }

function merge(authorised: { id: string; required?: boolean }[], saved: LayoutItem[] | undefined): LayoutItem[] {
  const allowed = new Map(authorised.map((a) => [a.id, a]));
  const out: LayoutItem[] = [];
  for (const s of saved ?? []) {
    const a = allowed.get(s.id);
    if (!a || out.some((o) => o.id === s.id)) continue;
    out.push({ id: s.id, hidden: a.required ? false : Boolean(s.hidden) });
  }
  for (const a of authorised) if (!out.some((o) => o.id === a.id)) out.push({ id: a.id, hidden: false });
  return out;
}

export function homeFor(store: Store, ctx: WorkContext) {
  const row = store.get<{ layout_json: string }>(
    'SELECT layout_json FROM home_layout WHERE workforce_person_id = ? AND service_id = ? AND role_key = ?', ctx.workerId, ctx.serviceId, ctx.role.roleKey,
  );
  const saved = row ? (JSON.parse(row.layout_json) as Layout) : undefined;
  const cards = merge(ctx.role.homeCards, saved?.cards);
  const tabs = merge(ctx.role.tabs, saved?.tabs);
  const cardInfo = new Map(ctx.role.homeCards.map((c) => [c.id, c]));
  const tabInfo = new Map(ctx.role.tabs.map((t) => [t.id, t]));
  return {
    cards: cards.map((c) => ({ ...cardInfo.get(c.id)!, hidden: c.hidden })),
    tabs: tabs.map((t) => ({ ...tabInfo.get(t.id)!, hidden: t.hidden })),
    customised: Boolean(row),
  };
}

export function saveHome(store: Store, ctx: WorkContext, input: Partial<Layout> | null) {
  if (input === null) {
    store.run('DELETE FROM home_layout WHERE workforce_person_id = ? AND service_id = ? AND role_key = ?', ctx.workerId, ctx.serviceId, ctx.role.roleKey);
  } else {
    const clean = (items: unknown): LayoutItem[] =>
      Array.isArray(items) ? items.filter((i) => i && typeof i.id === 'string').map((i) => ({ id: String(i.id), hidden: Boolean(i.hidden) })) : [];
    const layout: Layout = { cards: merge(ctx.role.homeCards, clean(input.cards)), tabs: merge(ctx.role.tabs, clean(input.tabs)) };
    store.run(
      `INSERT INTO home_layout (workforce_person_id, service_id, role_key, layout_json, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workforce_person_id, service_id, role_key) DO UPDATE SET layout_json = excluded.layout_json, updated_at = excluded.updated_at`,
      ctx.workerId, ctx.serviceId, ctx.role.roleKey, JSON.stringify(layout), now(),
    );
  }
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation: input === null ? 'HOME_LAYOUT_RESET' : 'HOME_LAYOUT_SAVE', outcome: 'COMMITTED' });
  return homeFor(store, ctx);
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

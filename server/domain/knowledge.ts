import type { Store } from '../db/database.ts';
import type { WorkContext } from './identity.ts';
import { enforce } from './record.ts';
import { audit } from './audit.ts';
import { transition } from './lifecycle.ts';
import { newId, now, HttpError } from '../lib/util.ts';

// Doctors' anonymous shared professional knowledge. Participants see no names; the system
// keeps authorship for audit. SHIFT supplies no answers of its own. Nothing here is a
// referral, transfers responsibility, or enters any patient record.

const NHI = /\b[A-HJ-NP-Z]{3}\d{2}[0-9A-HJ-NP-Z]{2}\b/i;

function checkDeidentified(store: Store, text: string): void {
  if (NHI.test(text)) throw new HttpError(400, 'IDENTIFIER', 'Remove the NHI. Shared knowledge must not identify a patient.');
  const lower = text.toLowerCase();
  const names = store.all<{ n: string }>("SELECT lower(given_name || ' ' || family_name) AS n FROM person WHERE id NOT IN (SELECT person_id FROM workforce_person)");
  if (names.some((r) => lower.includes(r.n))) throw new HttpError(400, 'IDENTIFIER', 'Remove the patient name. Shared knowledge must not identify a patient.');
}

function logged(store: Store, ctx: WorkContext, operation: string, objectId?: string, outcome: 'VIEWED' | 'COMMITTED' = 'COMMITTED') {
  audit(store, { actorId: ctx.workerId, sessionId: ctx.sessionId, workContextId: ctx.id, space: 'WORK', operation, objectType: 'knowledge', objectId: objectId ?? null, decision: 'ALLOW', outcome, ruleRefs: ['ORG-SYN-001 v1'] });
}

export function listQuestions(store: Store, ctx: WorkContext) {
  enforce(store, ctx, { op: 'KNOWLEDGE' });
  logged(store, ctx, 'KNOWLEDGE_LIST', undefined, 'VIEWED');
  return store.all<Record<string, string | number>>(
    `SELECT q.id, q.topic, q.body, q.created_at AS createdAt, q.state,
            (SELECT count(*) FROM knowledge_reply r WHERE r.question_id = q.id AND r.state = 'VISIBLE') AS replies,
            q.author_id = ? AS mine
       FROM knowledge_question q WHERE q.state <> 'WITHDRAWN' ORDER BY q.created_at DESC LIMIT 100`,
    ctx.workerId,
  ).map((q) => ({ ...q, mine: Boolean(q.mine) }));
}

export function question(store: Store, ctx: WorkContext, id: string) {
  enforce(store, ctx, { op: 'KNOWLEDGE' });
  const q = store.get<Record<string, string>>("SELECT * FROM knowledge_question WHERE id = ? AND state <> 'WITHDRAWN'", id);
  if (!q) throw new HttpError(404, 'NOT_FOUND', 'Question not found.');
  const replies = store.all<Record<string, string>>("SELECT * FROM knowledge_reply WHERE question_id = ? AND state = 'VISIBLE' ORDER BY created_at", id);
  // Stable per-question pseudonyms; the asker is always "Asker".
  const alias = new Map<string, string>([[q.author_id, 'Asker']]);
  for (const r of replies) if (!alias.has(r.author_id)) alias.set(r.author_id, `Colleague ${alias.size}`);
  logged(store, ctx, 'KNOWLEDGE_VIEW', id, 'VIEWED');
  return {
    id: q.id, topic: q.topic, body: q.body, createdAt: q.created_at, state: q.state, mine: q.author_id === ctx.workerId,
    replies: replies.map((r) => ({ id: r.id, body: r.body, createdAt: r.created_at, by: r.author_id === ctx.workerId ? 'You' : alias.get(r.author_id), mine: r.author_id === ctx.workerId })),
  };
}

export function ask(store: Store, ctx: WorkContext, topic: string, body: string) {
  enforce(store, ctx, { op: 'KNOWLEDGE' });
  const t = topic.trim().slice(0, 120);
  const b = body.trim().slice(0, 4000);
  if (!t || b.length < 10) throw new HttpError(400, 'INCOMPLETE', 'Give a topic and the question.');
  checkDeidentified(store, `${t} ${b}`);
  const id = newId();
  store.insert('knowledge_question', { id, author_id: ctx.workerId, topic: t, body: b, created_at: now(), state: 'OPEN' });
  logged(store, ctx, 'KNOWLEDGE_ASK', id);
  return { id };
}

export function reply(store: Store, ctx: WorkContext, questionId: string, body: string) {
  enforce(store, ctx, { op: 'KNOWLEDGE' });
  const q = store.get<{ state: string }>('SELECT state FROM knowledge_question WHERE id = ?', questionId);
  if (!q || q.state !== 'OPEN') throw new HttpError(409, 'CLOSED', 'This question is not open for replies.');
  const b = body.trim().slice(0, 4000);
  if (b.length < 2) throw new HttpError(400, 'EMPTY', 'The reply is empty.');
  checkDeidentified(store, b);
  const id = newId();
  store.insert('knowledge_reply', { id, question_id: questionId, author_id: ctx.workerId, body: b, created_at: now(), state: 'VISIBLE' });
  logged(store, ctx, 'KNOWLEDGE_REPLY', id);
  return { id };
}

export function closeQuestion(store: Store, ctx: WorkContext, id: string, withdraw: boolean) {
  enforce(store, ctx, { op: 'KNOWLEDGE' });
  if (!store.get("SELECT 1 FROM knowledge_question WHERE id = ? AND author_id = ? AND state = 'OPEN'", id, ctx.workerId)) throw new HttpError(409, 'NOT_ALLOWED', 'Only the asker can close an open question.');
  store.tx(() => {
    transition(store, 'knowledge_question', id, withdraw ? 'WITHDRAWN' : 'CLOSED', { actorId: ctx.workerId, workContextId: ctx.id });
    store.run('UPDATE knowledge_question SET closed_at = ? WHERE id = ?', now(), id);
  });
  logged(store, ctx, withdraw ? 'KNOWLEDGE_WITHDRAW' : 'KNOWLEDGE_CLOSE', id);
  return { id };
}

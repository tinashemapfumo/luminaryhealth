import { ORDER_STATUS, orderStatusFlow } from '../data/orders.js';

/**
 * The billing engine's decision layer.
 *
 * One question, asked in one place: has this order reached the point at which
 * its service becomes chargeable? Everything else about billing — pricing,
 * tariffs, invoices — happens downstream and knows nothing about orders.
 */

/** The next state on the ordinary path, or null at the end of it. */
export function nextOrderStatus(status) {
  const index = orderStatusFlow.indexOf(status);
  if (index < 0 || index >= orderStatusFlow.length - 1) return null;
  return orderStatusFlow[index + 1];
}

export const isTerminal = (status) =>
  status === ORDER_STATUS.COMPLETED
  || status === ORDER_STATUS.CANCELLED
  || status === ORDER_STATUS.DECLINED;

/** An order that never happened must never be chargeable, at any trigger. */
export const wasPerformed = (order) =>
  order.status !== ORDER_STATUS.CANCELLED && order.status !== ORDER_STATUS.DECLINED;

/**
 * The idempotency key for a billing event.
 *
 * A completion event can arrive more than once — a double click, a retry, a
 * replay when the workspace reloads — and each arrival must not add another
 * charge. The key names the order and the trigger that fired, is written onto
 * the invoice line, and is checked before anything is created. Keying on the
 * order alone would be wrong: one order can legitimately bill twice under
 * different triggers (a deposit on order, the balance on completion).
 */
export const billingKey = (order, trigger) => `${order.id}:${trigger}`;

/**
 * Has this order reached its service's billing trigger?
 *
 * Returns a reason rather than a bare false, because "not billed" has several
 * causes a person may need to distinguish — the service is not billable at
 * all, the work was cancelled, or it simply has not happened yet.
 */
export function billingDecision(order, service, { alreadyBilled = new Set() } = {}) {
  if (!service) return { bill: false, reason: 'No catalogue service for this order' };
  if (!service.billable) return { bill: false, reason: `${service.displayName} is not billable` };
  if (!wasPerformed(order)) {
    return { bill: false, reason: `${order.status} — never charge for work not done` };
  }

  const trigger = service.billingTrigger;
  if (trigger === 'MANUAL') return { bill: false, reason: 'Billed manually by arrangement' };

  const reached = trigger === 'ON_ORDER'
    ? true
    : trigger === 'ON_COMPLETION'
      ? order.status === ORDER_STATUS.COMPLETED
      : false;

  if (!reached) return { bill: false, reason: `Waiting for ${trigger === 'ON_COMPLETION' ? 'completion' : trigger}` };

  const key = billingKey(order, trigger);
  if (alreadyBilled.has(key) || order.billedKey === key) {
    return { bill: false, reason: 'Already billed', key };
  }

  return { bill: true, key, trigger };
}

/**
 * Every order currently owed a charge.
 *
 * Recomputed from state rather than driven by an event queue, deliberately.
 * A queue can be missed, replayed or reordered; a derivation cannot drift from
 * the thing it derives from, and the idempotency key still guarantees one
 * charge per event however many times this runs.
 */
export function ordersAwaitingBilling(orders = [], resolveService, alreadyBilled = new Set()) {
  return orders
    .map((order) => ({ order, decision: billingDecision(order, resolveService(order), { alreadyBilled }) }))
    .filter((entry) => entry.decision.bill);
}

/** Keys already present on invoices, so a reload cannot double charge. */
export function billedKeysFrom(invoices = []) {
  const keys = new Set();
  invoices.forEach((invoice) => {
    (invoice.services ?? []).forEach((line) => {
      if (line.billingKey) keys.add(line.billingKey);
    });
  });
  return keys;
}

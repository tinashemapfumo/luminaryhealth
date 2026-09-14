import React from 'react';
import { Plus, Ban } from 'lucide-react';
import { StatusPill } from '../shared/StatusPill';
import { EmptyState } from '../shared/EmptyState';
import { useWorkspace } from '../../lib/workspace';
import { billingDecision } from '../../lib/orders';

/**
 * The order queue.
 *
 * Where clinical intent becomes work, and where work becomes money — in that
 * order and not before. A clinician orders an ECG and never sees a tariff; the
 * department that performs it marks it done; the charge follows on its own.
 *
 * The billing consequence of each order is shown here rather than hidden,
 * because the person marking a test complete is the last one who can still
 * stop a patient being charged for something that did not happen.
 */
export default function OrdersPage() {
  const {
    access, practiceOrders, billableOrders, advanceOrder, serviceForOrder,
    orderStatusTone, ORDER_STATUS, openDialog, currency, priceOn, triggerLabel,
  } = useWorkspace();

  const open = practiceOrders.filter(
    (order) => order.status !== ORDER_STATUS.CANCELLED && order.status !== ORDER_STATUS.DECLINED
  );
  const closed = practiceOrders.filter(
    (order) => order.status === ORDER_STATUS.CANCELLED || order.status === ORDER_STATUS.DECLINED
  );

  const nextLabel = {
    [ORDER_STATUS.ORDERED]: 'Accept',
    [ORDER_STATUS.ACCEPTED]: 'Start',
    [ORDER_STATUS.IN_PROGRESS]: 'Mark complete',
  };

  return (
    <div className="space-y-6">
      <div className="lh-page-hero flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="lh-page-kicker">Clinical</p>
          <h1 className="lh-page-title">Orders</h1>
          <p className="lh-page-subtitle">
            Requests for services. Billing follows completion. Nothing is charged for work that was not done.
          </p>
        </div>
        {access.can.orderServices && (
          <button
            type="button"
            onClick={() => openDialog('order', { quantity: '1', priority: 'Routine' })}
            className="lh-primary-button"
          >
            <Plus size={14} />
            Order a service
          </button>
        )}
      </div>

      {/* Work already done that has not produced a charge. This is the leak a
          practice notices last, because nothing on the screen looks missing. */}
      {billableOrders.length > 0 && (
        <div className="lh-card-pad border-warning-line bg-warning-wash/40">
          <p className="text-md font-medium text-warning-deep">
            {billableOrders.length} completed order{billableOrders.length === 1 ? '' : 's'} not yet billed
          </p>
          <p className="mt-1 text-sm text-body">
            {billableOrders.map((entry) => `${entry.order.patientName} · ${entry.order.serviceName}`).join(', ')}
          </p>
        </div>
      )}

      {practiceOrders.length === 0 ? (
        <EmptyState
          title="Nothing ordered"
          detail="Services ordered during an encounter appear here for the department that performs them."
        />
      ) : (
        <div className="lh-card-pad">
          <p className="mb-4 lh-section-label">Open orders</p>
          <div className="space-y-2">
            {open.map((order) => {
              const service = serviceForOrder(order);
              const price = service ? priceOn(service) : null;
              const decision = billingDecision(order, service);
              return (
                <div key={order.id} className="lh-card-soft p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-ink">{order.patientName}</p>
                      <p className="mt-1 text-sm text-body">
                        {order.serviceName}
                        {order.quantity > 1 ? ` ×${order.quantity}` : ''} · {order.department} · {order.id}
                      </p>
                      {order.clinicalNotes && (
                        <p className="mt-1 text-xs italic text-body">{order.clinicalNotes}</p>
                      )}
                      <p className="mt-1 text-xs text-muted">
                        Ordered by {order.orderedBy}
                        {order.priority !== 'Routine' ? ` · ${order.priority}` : ''}
                        {service ? ` · bills ${triggerLabel(service.billingTrigger).toLowerCase()}` : ''}
                      </p>
                    </div>

                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <StatusPill label={order.status} tone={orderStatusTone[order.status]} />
                      {price && <span className="text-xs text-body tabular-nums">{currency(price.amount)}</span>}
                    </div>
                  </div>

                  <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2.5">
                    {/* Says plainly whether this has produced a charge, and if
                        not, what it is waiting for. */}
                    <span className={`text-xs ${order.billedKey ? 'text-success' : 'text-muted'}`}>
                      {order.billedKey
                        ? `Billed · ${order.invoiceId}`
                        : decision.bill ? 'Ready to bill' : decision.reason}
                    </span>

                    {access.can.checkIn && nextLabel[order.status] && (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => openDialog('cancelOrder', {
                            orderId: order.id,
                            serviceName: order.serviceName,
                            patientName: order.patientName,
                            decline: order.status === ORDER_STATUS.ORDERED,
                          })}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-danger-strong bg-white px-3 py-1.5 text-xs font-medium text-danger transition hover:border-danger-line"
                        >
                          <Ban size={12} />
                          {order.status === ORDER_STATUS.ORDERED ? 'Decline' : 'Cancel'}
                        </button>
                        <button
                          type="button"
                          onClick={() => advanceOrder(order)}
                          className="lh-primary-button px-3 py-1.5 text-xs"
                        >
                          {nextLabel[order.status]}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {open.length === 0 && (
              <p className="rounded-lg border border-dashed border-edge bg-surface p-4 text-sm text-muted">
                No open orders.
              </p>
            )}
          </div>

          {/* Kept visible rather than hidden. A cancelled order is a record of
              a decision, and the reason is the part worth keeping. */}
          {closed.length > 0 && (
            <>
              <p className="mb-3 mt-6 lh-section-label">Cancelled and declined</p>
              <div className="space-y-2">
                {closed.map((order) => (
                  <div key={order.id} className="flex items-start justify-between gap-3 rounded-lg border border-line bg-surface p-3">
                    <div className="min-w-0">
                      <p className="text-base font-medium text-ink">{order.patientName} · {order.serviceName}</p>
                      <p className="mt-1 text-xs italic text-body">{order.cancellationReason}</p>
                    </div>
                    <StatusPill label={order.status} tone={orderStatusTone[order.status]} />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

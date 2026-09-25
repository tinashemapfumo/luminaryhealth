import React, { useEffect, useMemo, useState } from 'react';
import { HelpCircle, Plus, Trash2, Undo2 } from 'lucide-react';
import { Button, EmptyState, Field, Input, Modal, Select, Textarea } from '../ui';
import { StatusPill } from '../shared/StatusPill';
import { useWorkspace } from '../../lib/workspace';
import { api } from '../../services/api';

const WORK_ITEM_STATUSES = [
  'Expected', 'In consultation', 'Awaiting clinician', 'Ready to bill',
  'Needs clarification', 'Draft invoice', 'Finalized', 'Cancelled',
];

const STATUS_TONE = {
  'Expected': 'neutral',
  'In consultation': 'neutral',
  'Awaiting clinician': 'warm',
  'Ready to bill': 'success',
  'Needs clarification': 'alert',
  'Draft invoice': 'warm',
  'Finalized': 'success',
  'Cancelled': 'neutral',
};

const CLARIFICATION_CATEGORIES = [
  { value: 'missing_service', label: 'Missing service' },
  { value: 'service_not_completed', label: 'Service not completed' },
  { value: 'diagnosis_code', label: 'Diagnosis / code clarification' },
  { value: 'quantity', label: 'Quantity clarification' },
  { value: 'pricing_agreement', label: 'Pricing agreement not found' },
  { value: 'other', label: 'Other' },
];

export default function BillingHandoffPage() {
  const { access, currency, formatMoney, notify } = useWorkspace();
  const [statusFilter, setStatusFilter] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState(null);

  const reload = () => {
    setLoading(true);
    api.billing.workItems.list(statusFilter ? { status: statusFilter } : undefined)
      .then(setItems)
      .catch((error) => notify(error.message))
      .finally(() => setLoading(false));
  };

  useEffect(reload, [statusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-6">
      <div className="lh-page-hero flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="lh-page-kicker">Billing</p>
          <h1 className="lh-page-title">Billing handoff queue</h1>
          <p className="lh-page-subtitle">What clinical work is ready to bill, and what still needs a decision.</p>
        </div>
        <Select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          options={['', ...WORK_ITEM_STATUSES]}
          render={(v) => v || 'All statuses'}
        />
      </div>

      <div className="lh-table-shell">
        <table className="min-w-full text-left text-md">
          <thead className="lh-table-head">
            <tr>
              <th className="px-4 py-3 font-medium">Patient</th>
              <th className="px-4 py-3 font-medium">Services</th>
              <th className="px-4 py-3 font-medium">Encounter</th>
              <th className="px-4 py-3 font-medium text-right">Draft total</th>
              <th className="px-4 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={item.id}
                onClick={() => setOpenId(item.id)}
                className="cursor-pointer border-t border-line bg-white transition hover:bg-surface"
              >
                <td className="px-4 py-3 font-medium text-ink">{item.patient_name}</td>
                <td className="px-4 py-3 text-body">{item.service_summary || '—'}</td>
                <td className="px-4 py-3 text-body">
                  {item.encounter_status ? `${item.note_type || 'Note'} · ${item.encounter_status}` : 'Not started'}
                  {item.open_clarifications > 0 && (
                    <span className="ml-2 inline-flex items-center gap-1 text-xs text-danger">
                      <HelpCircle size={12} /> {item.open_clarifications} open
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right text-ink">
                  {item.draft_total != null ? formatMoney(Number(item.draft_total), item.draft_currency || currency) : '—'}
                </td>
                <td className="px-4 py-3"><StatusPill label={item.status} tone={STATUS_TONE[item.status] || 'neutral'} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && items.length === 0 && (
          <EmptyState title="Nothing in the billing queue" detail="Signed encounters and started visits will appear here." />
        )}
      </div>

      {openId && (
        <WorkItemModal
          id={openId}
          onClose={() => setOpenId(null)}
          onChanged={reload}
          access={access}
          currency={currency}
          formatMoney={formatMoney}
        />
      )}
    </div>
  );
}

function WorkItemModal({ id, onClose, onChanged, access, currency, formatMoney }) {
  const [item, setItem] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [serviceQuery, setServiceQuery] = useState('');
  const [catalogueOptions, setCatalogueOptions] = useState([]);
  const [newService, setNewService] = useState(null);
  const [newQuantity, setNewQuantity] = useState('1');
  const [customDescription, setCustomDescription] = useState('');
  const [customQuantity, setCustomQuantity] = useState('1');
  const [customPrice, setCustomPrice] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [clarifyCategory, setClarifyCategory] = useState('missing_service');
  const [clarifyQuestion, setClarifyQuestion] = useState('');
  const [responseDrafts, setResponseDrafts] = useState({});
  const [bespoke, setBespoke] = useState({ serviceId: '', amount: '', reason: '' });

  const load = () => {
    api.billing.workItems.get(id).then((row) => {
      setItem(row);
      setNoteDraft(row.invoice?.patient_note || '');
    }).catch((e) => setError(e.message));
  };

  useEffect(load, [id]);
  useEffect(() => {
    api.catalogue.services().then(setCatalogueOptions).catch(() => {});
  }, []);

  const serviceMatches = useMemo(() => {
    const q = serviceQuery.trim().toLowerCase();
    if (!q) return [];
    return catalogueOptions
      .filter((s) => s.display_name?.toLowerCase().includes(q) || s.internal_code?.toLowerCase().includes(q))
      .slice(0, 8);
  }, [catalogueOptions, serviceQuery]);

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      load();
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!item) {
    return (
      <Modal open onClose={onClose} title="Billing handoff">
        {error ? <p className="text-sm text-danger">{error}</p> : <p className="text-sm text-muted">Loading…</p>}
      </Modal>
    );
  }

  const invoice = item.invoice;
  const lines = (invoice?.lines || []).slice().sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
  const isFinalized = Boolean(invoice?.finalized_at);
  const lineCurrency = invoice?.currency || currency;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Billing handoff — ${item.patient_name}`}
      subtitle={item.encounter_status ? `${item.note_type || 'Note'} · ${item.encounter_status}${item.signed_at ? ` · signed ${new Date(item.signed_at).toLocaleDateString()}` : ''}` : 'No encounter linked yet'}
      width="max-w-4xl"
      footer={<>
        <Button variant="secondary" type="button" onClick={onClose}>Close</Button>
        {access.can.finalizeInvoice && item.status !== 'Finalized' && (
          <Button
            type="button"
            disabled={busy}
            onClick={() => run(() => api.billing.workItems.finalize(id))}
          >
            Finalize invoice
          </Button>
        )}
      </>}
    >
      <div className="space-y-5">
        <div className="flex items-center justify-between rounded-lg border border-line bg-surface p-3 text-sm">
          <div>
            <p className="text-muted">Prior account activity</p>
            <p className="text-ink">
              Billed {formatMoney(item.priorActivity?.billed ?? 0, item.priorActivity?.currency || currency)}
              {' · '}Outstanding {formatMoney(item.priorActivity?.outstanding ?? 0, item.priorActivity?.currency || currency)}
            </p>
          </div>
          <StatusPill label={item.status} tone={STATUS_TONE[item.status] || 'neutral'} />
        </div>

        <div>
          <p className="mb-1.5 text-caption font-semibold text-muted">Draft invoice lines</p>
          {lines.length === 0 ? (
            <p className="text-sm text-muted">No lines yet.</p>
          ) : (
            <div className="space-y-1.5">
              {lines.map((line) => (
                <LineRow
                  key={line.id}
                  line={line}
                  currency={lineCurrency}
                  formatMoney={formatMoney}
                  access={access}
                  isFinalized={isFinalized}
                  busy={busy}
                  bespokeAgreements={(item.bespokeAgreements || []).filter((a) => a.service_id === line.service_id && a.status === 'approved')}
                  onUpdate={(body) => run(() => api.billing.draftInvoices.updateLine(line.id, body))}
                  onExclude={(reason) => run(() => api.billing.draftInvoices.excludeLine(line.id, reason))}
                  onRestore={() => run(() => api.billing.draftInvoices.restoreLine(line.id))}
                  onApplyBespoke={(agreementId) => run(() => api.billing.draftInvoices.applyBespokePrice(line.id, agreementId))}
                />
              ))}
            </div>
          )}
        </div>

        {!isFinalized && (access.can.addCatalogueInvoiceLine || access.can.addCustomInvoiceLine) && (
          <div className="grid gap-3 rounded-lg border border-line bg-surface p-3 sm:grid-cols-2">
            {access.can.addCatalogueInvoiceLine && (
              <div className="space-y-1.5">
                <p className="text-caption font-semibold text-muted">Add catalogue line</p>
                <div className="relative">
                  <Input
                    value={newService ? `${newService.display_name} (${newService.internal_code})` : serviceQuery}
                    onChange={(e) => { setNewService(null); setServiceQuery(e.target.value); }}
                    placeholder="Search services…"
                  />
                  {!newService && serviceMatches.length > 0 && (
                    <ul className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-edge bg-white shadow-[0_12px_28px_-8px_rgba(11,21,36,0.25)]">
                      {serviceMatches.map((s) => (
                        <li key={s.id}>
                          <button type="button" onClick={() => { setNewService(s); setServiceQuery(''); }} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-surface">
                            <span className="text-sm text-ink">{s.display_name}</span>
                            <span className="text-2xs text-muted">{s.internal_code}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="flex gap-2">
                  <Input type="number" min="1" value={newQuantity} onChange={(e) => setNewQuantity(e.target.value)} />
                  <Button
                    type="button"
                    disabled={busy || !newService}
                    onClick={() => run(async () => {
                      await api.billing.draftInvoices.addCatalogueLine(invoice.id, { serviceId: newService.id, quantity: Number(newQuantity) || 1 });
                      setNewService(null); setServiceQuery(''); setNewQuantity('1');
                    })}
                  >
                    <Plus size={13} /> Add
                  </Button>
                </div>
              </div>
            )}
            {access.can.addCustomInvoiceLine && (
              <div className="space-y-1.5">
                <p className="text-caption font-semibold text-muted">Add custom line</p>
                <Input value={customDescription} onChange={(e) => setCustomDescription(e.target.value)} placeholder="Description" />
                <div className="flex gap-2">
                  <Input type="number" min="1" value={customQuantity} onChange={(e) => setCustomQuantity(e.target.value)} placeholder="Qty" />
                  <Input type="number" min="0" step="0.01" value={customPrice} onChange={(e) => setCustomPrice(e.target.value)} placeholder="Unit price" />
                  <Button
                    type="button"
                    disabled={busy || !customDescription.trim() || !customPrice}
                    onClick={() => run(async () => {
                      await api.billing.draftInvoices.addCustomLine(invoice.id, {
                        description: customDescription.trim(), quantity: Number(customQuantity) || 1, unitPrice: Number(customPrice),
                      });
                      setCustomDescription(''); setCustomQuantity('1'); setCustomPrice('');
                    })}
                  >
                    <Plus size={13} /> Add
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {access.can.editDraftInvoice && (
          <Field label="Patient-facing invoice note">
            <div className="flex gap-2">
              <Textarea value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="Shown on the printed invoice, not on this handoff." />
              <Button
                variant="secondary" type="button" disabled={busy}
                onClick={() => run(() => api.billing.draftInvoices.setPatientNote(invoice.id, noteDraft))}
              >
                Save
              </Button>
            </div>
          </Field>
        )}

        <div>
          <p className="mb-1.5 text-caption font-semibold text-muted">Clarifications</p>
          <div className="space-y-2">
            {(item.clarifications || []).length === 0 && <p className="text-sm text-muted">None requested.</p>}
            {(item.clarifications || []).map((c) => (
              <div key={c.id} className="rounded border border-line bg-white p-2.5 text-sm">
                <p className="font-medium text-ink">{CLARIFICATION_CATEGORIES.find((x) => x.value === c.category)?.label || c.category}</p>
                <p className="text-body">{c.question}</p>
                {c.response ? (
                  <p className="mt-1 text-xs text-muted">Answered by {c.responded_by_name}: {c.response}</p>
                ) : access.can.requestBillingClarification && (
                  <div className="mt-1.5 flex gap-2">
                    <Input
                      value={responseDrafts[c.id] || ''}
                      onChange={(e) => setResponseDrafts((prev) => ({ ...prev, [c.id]: e.target.value }))}
                      placeholder="Respond…"
                    />
                    <Button
                      variant="secondary" type="button" disabled={busy || !(responseDrafts[c.id] || '').trim()}
                      onClick={() => run(() => api.billing.clarifications.respond(c.id, responseDrafts[c.id]))}
                    >
                      Send
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {access.can.requestBillingClarification && (
            <div className="mt-2 grid gap-2 sm:grid-cols-[auto_1fr_auto]">
              <Select value={clarifyCategory} onChange={(e) => setClarifyCategory(e.target.value)} options={CLARIFICATION_CATEGORIES.map((c) => c.value)} render={(v) => CLARIFICATION_CATEGORIES.find((c) => c.value === v)?.label} />
              <Input value={clarifyQuestion} onChange={(e) => setClarifyQuestion(e.target.value)} placeholder="What needs clarifying?" />
              <Button
                type="button" disabled={busy || clarifyQuestion.trim().length < 5}
                onClick={() => run(async () => {
                  await api.billing.clarifications.request(id, { category: clarifyCategory, question: clarifyQuestion.trim() });
                  setClarifyQuestion('');
                })}
              >
                <HelpCircle size={13} /> Ask
              </Button>
            </div>
          )}
        </div>

        {access.can.editDraftInvoice && (
          <div>
            <p className="mb-1.5 text-caption font-semibold text-muted">Bespoke price agreements</p>
            {(item.bespokeAgreements || []).length === 0 && <p className="text-sm text-muted">None on file for this patient.</p>}
            {(item.bespokeAgreements || []).map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded border border-line bg-white p-2 text-sm">
                <span>{a.service_name} — {formatMoney(Number(a.amount), a.currency)} · {a.reason}</span>
                <div className="flex items-center gap-2">
                  <StatusPill label={a.status} tone={a.status === 'approved' ? 'success' : 'warm'} />
                  {a.status === 'pending' && access.can.approveBespokePrice && (
                    <Button variant="secondary" type="button" disabled={busy} onClick={() => run(() => api.billing.bespokePrices.approve(a.id))}>Approve</Button>
                  )}
                </div>
              </div>
            ))}
            <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto_1fr_auto]">
              <Select value={bespoke.serviceId} onChange={(e) => setBespoke((p) => ({ ...p, serviceId: e.target.value }))} options={['', ...catalogueOptions.map((s) => s.id)]} render={(v) => catalogueOptions.find((s) => s.id === v)?.display_name || 'Service…'} />
              <Input type="number" min="0" step="0.01" value={bespoke.amount} onChange={(e) => setBespoke((p) => ({ ...p, amount: e.target.value }))} placeholder="Amount" />
              <Input value={bespoke.reason} onChange={(e) => setBespoke((p) => ({ ...p, reason: e.target.value }))} placeholder="Reason" />
              <Button
                type="button" disabled={busy || !bespoke.serviceId || !bespoke.amount || bespoke.reason.trim().length < 5}
                onClick={() => run(async () => {
                  await api.billing.bespokePrices.create(item.patient_id, {
                    serviceId: bespoke.serviceId, amount: Number(bespoke.amount), currency: lineCurrency, reason: bespoke.reason.trim(),
                  });
                  setBespoke({ serviceId: '', amount: '', reason: '' });
                })}
              >
                Propose
              </Button>
            </div>
          </div>
        )}

        {error && <div className="rounded border border-danger-strong bg-danger-soft p-3 text-sm text-danger">{error}</div>}
      </div>
    </Modal>
  );
}

function LineRow({ line, currency, formatMoney, access, isFinalized, busy, bespokeAgreements, onUpdate, onExclude, onRestore, onApplyBespoke }) {
  const [quantity, setQuantity] = useState(String(line.quantity));
  const [price, setPrice] = useState(String(line.unit_price));
  const [priceReason, setPriceReason] = useState('');
  const excluded = line.exclusion_status === 'excluded';

  return (
    <div className={`rounded border p-2.5 text-sm ${excluded ? 'border-line bg-surface opacity-70' : 'border-line bg-white'}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium text-ink">{line.service_display_name_snapshot || line.service_name || line.description}</p>
          <p className="text-xs text-muted">
            {line.line_source || line.origin} · qty {line.quantity} · {formatMoney(Number(line.unit_price ?? 0), currency)} each
            {excluded && ` · excluded: ${line.exclusion_reason}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-medium text-ink">{formatMoney(Number(line.unit_price ?? 0) * Number(line.quantity ?? 1), currency)}</span>
          {!isFinalized && !excluded && access.can.excludeAutomatedInvoiceLine && (
            <button type="button" title="Exclude" disabled={busy} onClick={() => { const reason = window.prompt('Reason for excluding this line?'); if (reason) onExclude(reason); }} className="text-muted hover:text-danger">
              <Trash2 size={14} />
            </button>
          )}
          {!isFinalized && excluded && access.can.excludeAutomatedInvoiceLine && (
            <button type="button" title="Restore" disabled={busy} onClick={onRestore} className="text-muted hover:text-brand">
              <Undo2 size={14} />
            </button>
          )}
        </div>
      </div>

      {!isFinalized && !excluded && (access.can.editDraftInvoice || access.can.overrideInvoicePrice) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {access.can.editDraftInvoice && (
            <>
              <Input type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
              <Button variant="secondary" type="button" disabled={busy || Number(quantity) === line.quantity} onClick={() => onUpdate({ quantity: Number(quantity) })}>Update qty</Button>
            </>
          )}
          {access.can.overrideInvoicePrice && (
            <>
              <Input type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
              <Input value={priceReason} onChange={(e) => setPriceReason(e.target.value)} placeholder="Reason for price change" />
              <Button
                variant="secondary" type="button" disabled={busy || Number(price) === Number(line.unit_price) || priceReason.trim().length < 5}
                onClick={() => onUpdate({ unitPrice: Number(price), reason: priceReason })}
              >
                Override price
              </Button>
            </>
          )}
          {access.can.overrideInvoicePrice && bespokeAgreements.length > 0 && (
            <Select
              value=""
              onChange={(e) => { if (e.target.value) onApplyBespoke(e.target.value); }}
              options={['', ...bespokeAgreements.map((a) => a.id)]}
              render={(v) => (v ? `Apply ${formatMoney(Number(bespokeAgreements.find((a) => a.id === v)?.amount ?? 0), currency)}` : 'Apply bespoke price…')}
            />
          )}
        </div>
      )}
    </div>
  );
}

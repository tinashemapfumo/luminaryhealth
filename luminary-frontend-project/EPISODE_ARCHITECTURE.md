# Episode Architecture

Luminary now treats an episode of care as the clinical spine between a patient and the operational records created around one problem.

## Structure

```text
Patient
  -> Episode
    -> Visits
    -> Notes
    -> Orders
    -> Invoices
    -> Claims
```

An episode answers: what clinical problem is being managed, what activity belongs to it, and what the outcome is.

## Episode Fields

- Episode title / reason
- Start date
- Primary diagnosis
- Status: Active, Resolved, Chronic, Referred, Closed
- Linked visits
- Linked encounter notes
- Linked clinical orders
- Linked invoices
- Linked claims
- Outcome / closure note

## Linking Rules

- Staff can manually link visits, notes, orders, invoices, and claims when starting or editing an episode.
- New encounter notes attach automatically to the patient's open episode when one exists.
- New orders attach automatically to the patient's open episode when one exists.
- Invoices raised from a visit or completed order attach automatically to the patient's open episode when one exists.
- Claims raised from an invoice attach to the same episode through the invoice creation path.

Open episode means status is `Active`, `Chronic`, or `Referred`.

## Design Principle

Visits are attendances. Notes are documentation. Orders are clinical work requested. Invoices and claims are financial consequences. The episode groups them without replacing them as the source of truth.

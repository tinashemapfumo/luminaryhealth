# Scenario 003 Remediation

## Scope

This iteration fixes the diagnostic-ordering defects from Scenario 003 only.
It does not start a new product workflow.

## Decisions

- Services are offline-first catalogue data.
- Services are created or updated from reviewed Excel/CSV imports, not from an open-ended service creation API.
- The backend still exposes a local publish endpoint so the browser can persist reviewed rows into the local practice database.
- Service catalogue rows and payer tariff rows remain separate:
  - Service: what the practice can order or bill.
  - Tariff: what a medical aid or payer is expected to cover.
- A service may be imported without a fixed practice price. That keeps variable-price work orderable while leaving billing to manual or invoice-time pricing.

## Implemented

- Added service catalogue import publishing at `POST /import-batches/services`.
- Added optional service fields for `orderable`, `billable`, `billingTrigger`, aliases, and optional effective-dated prices.
- Added `service.orderable` so billing-only items can stay out of clinical ordering.
- Added `lab_result.order_id` and `lab_result.encounter_id`.
- Lab results can now be linked to a clinical order and encounter.
- Capturing a result against an active order advances that order to `Completed`, using the existing billing engine.
- Creating an order with an encounter now verifies that the encounter belongs to the same patient.
- Prescribing now refuses to proceed when `allergies_reviewed=false` unless the clinician explicitly acknowledges allergy review in the request.
- PostgreSQL `DATE` fields are now returned as date strings centrally, avoiding timezone-shifted date serialization.

## Import Shape

Recommended service spreadsheet columns:

```csv
service_name,billing_description,category,department,practice_price,currency,billing_trigger,tariff_code,orderable,active
ECG,12 lead resting ECG,Diagnostics,Diagnostics,35,USD,ON_COMPLETION,93000,true,true
Full blood count,Full blood count,Diagnostics,Laboratory,,USD,ON_COMPLETION,FBC,true,true
Variable procedure,Procedure priced at invoice time,Procedures,General Practice,,USD,MANUAL,,true,true
```

Blank `practice_price` is allowed. Those services can be ordered, but they will not auto-bill until a price exists or the invoice is raised manually.

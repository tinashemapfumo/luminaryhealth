# Zimbabwe Customer Risk And Upside

Point of view: a skeptical Zimbabwe-based clinic owner, practice manager, or administrator evaluating Luminary Health before committing money, staff time, and patient data.

## Skeptical Customer Flaws

### 1. The product is not yet production-ready

The strongest objection is simple: the go-live checklist says the app is not ready to run as a real clinical system until hard blockers are closed and `verify:live` passes against an actual tenant.

Likely customer reaction:

- "Can I safely run my clinic on this today?"
- "Which modules are real and which are still demo?"
- "Who carries the risk if a clinical, billing, or access-control workflow fails?"

Relevant local evidence:

- `GO_LIVE_REQUIREMENTS.md` lists hard blockers for environment setup, database role, RLS verification, TLS, backups, file storage, and live tenant verification.
- `luminary-frontend-project/README.md` says only sign-in, session restore, idle lock, patient registry, chart access, registration, chart edits, and practice administration are wired to the API so far.

### 2. NH263 is presented more confidently than the implementation supports

The UI can show "NH263 switch · Connected", and staff can click through capture, submission, approval, and rejection flows. But the implementation notes say biometric capture, claim submission, and adjudication are still internal/manual placeholders until the real switch proxy and responses are wired.

Likely customer reaction:

- "Does this actually submit to NH263 today?"
- "Can I reconcile real switch responses?"
- "Will my rejected claims and remittances match the funder's official records?"

This is a major trust issue because claims are a buying trigger. If the product looks connected before it is connected, customers may feel misled.

### 3. Currency support is not current enough for Zimbabwe

The app models `USD` and `ZWL`, with a `1 USD = n ZWL` setting. Zimbabwe customers now expect current local-currency language around ZiG/ZWG, plus practical handling of USD collections, local currency collections, exchange-rate history, fiscal receipts, and tax reporting.

Likely customer reaction:

- "Why is this still using ZWL?"
- "Can I receipt in ZiG/ZWG and USD?"
- "Which exchange rate is used, and will it satisfy my accountant?"

This matters because a practice-management system touches daily cash, EcoCash, bank transfers, invoices, receipts, tax records, and scheme reimbursements.

### 4. ZIMRA fiscalisation is not visible

The product has internal receipts and good ledger concepts, but there is no obvious story for fiscal tax invoices, fiscal device integration, ZIMRA FDMS, fiscal receipt references, VAT/BP fields, or compliant daily reporting.

Likely customer reaction:

- "Will this integrate with my fiscal device?"
- "Can it produce a fiscal tax invoice?"
- "Will this make my ZIMRA position easier or harder?"

For a paying Zimbabwean practice, fiscalisation can be a blocker even if the clinical workflow is attractive.

### 5. Zimbabwe healthcare privacy posture needs to be explicit

The app has promising controls: tenant scoping, role-based access, break-glass, immutable signed notes, audit logs, and session locking. But a skeptical buyer will need explicit answers for Zimbabwe's health-record confidentiality and sensitive-data obligations.

Likely customer reaction:

- "Where is patient data hosted?"
- "Who can access backups?"
- "How do consent, withdrawal, disclosure, retention, breach handling, and audit review work?"
- "How is biometric data protected?"

This should become a formal compliance pack before sales conversations move beyond demo.

### 6. Demo data weakens local credibility

The product is framed around Zimbabwe, but the seeded data includes names, emails, and pharmacy references that feel imported from a generic US-style clinic demo, such as `clinic.io`, CVS, and non-local patient/provider names.

Likely customer reaction:

- "Was this really built for Zimbabwe?"
- "Will my staff recognise our workflows, language, payers, and common exceptions?"

The fix is not cosmetic. A local demo should immediately signal Harare/Bulawayo realities: local names, suburbs, medical aid behaviour, pharmacy/lab/radiology patterns, payment methods, and realistic claim failures.

### 7. AI surfaces overpromise before operational proof exists

The AI page shows agents booking appointments, preventing claim rejections, recovering debt, forecasting, and answering cross-module questions. Today that can read as impressive, but also risky if customers realise the answers are seeded/canned or not fully backed by live audited workflows.

Likely customer reaction:

- "Is the AI allowed to message patients?"
- "Does it make clinical recommendations?"
- "Can I review and audit what it did?"
- "What happens when it is wrong?"

AI should be positioned as controlled assistance with human review until the audit, permission, consent, and integration model is proven end to end.

### 8. Visible encoding glitches make the product feel less safe

Broken text such as `Â·`, `â€¦`, or `â€”` appears in some source/UI strings. In a consumer app this looks unpolished; in healthcare software it can suggest that record fidelity is not being treated seriously.

Likely customer reaction:

- "If punctuation is corrupted, what else can be corrupted?"
- "Will patient names, notes, or receipts survive export/import correctly?"

This is a small technical issue with outsized trust impact.

### 9. Demo authentication can leave the wrong impression

The demo is honest about browser-side credentials and includes a skip-sign-in shortcut. That is useful for presentations, but a security-conscious customer may remember the shortcut more than the disclaimer.

Likely customer reaction:

- "Could staff bypass login?"
- "Are credentials ever stored in the browser?"

Demo mode should remain obvious, but production security should be visually and operationally separated from demo convenience.

### 10. Live mode can mix real and seeded operational data

The README calls this out: live mode can show real patients beside seeded appointments, encounters, billing, claims, messaging, and audit rows until those modules move fully onto the API.

Likely customer reaction:

- "Am I seeing real clinic data or sample data?"
- "Could staff act on seeded operational data by mistake?"

This is probably the single most dangerous perception flaw. A production-like environment must not mix real and fake operational records.

## Biggest Upside Once Product-Ready

Luminary's biggest upside against competitors is that it can become a Zimbabwe-native operating system for private practices, not just a generic PMS with local labels added later.

The strongest competitive wedge is the combination of:

- Clinical workflow: registration, consent, chart access, notes, signing, addenda, vitals, documents, orders, and care relationships.
- Front desk operations: scheduling, check-in, messaging, reminders, payments, statements, receipts, reversals, and patient responsibility.
- Medical aid and claims: NH263-style eligibility, biometric verification, tariff-aware billing, rejection handling, remittance tracking, and patient-balance movement.
- Zimbabwe money realities: USD plus local-currency receipting, exchange-rate history, EcoCash/cash/card/transfer support, and accountant-friendly ledgers.
- Governance: tenant isolation, role permissions, break-glass, audit trails, session revocation, provider registration expiry, and manager/admin separation.
- AI as an operations layer: agents that do not replace staff, but help them catch missed follow-ups, claim risks, no-show patterns, overdue balances, and workflow bottlenecks.

Most competitors are likely to be strong in one lane: accounting, bookings, basic EMR, messaging, or claims. Luminary's upside is owning the whole clinic day from the patient's first message to the signed note, invoice, claim, receipt, and follow-up, while keeping every action auditable.

When ready, the message should be:

"Luminary is built for Zimbabwean practices that need clinical records, NH263-aware billing, real-world multi-currency collections, and accountable staff workflows in one system."

## Product-Ready Sales Positioning

Do not lead with AI. Lead with control, money, and reduced operational leakage.

Recommended positioning:

- "Stop losing revenue between reception, the consultation room, claims, and collections."
- "Know exactly what the patient owes, what medical aid is expected to pay, what it approved, and what has actually been received."
- "Give clinicians fast access without giving everyone access to everything."
- "Run USD and local-currency payments without rewriting history when rates change."
- "Use AI to surface risks and draft work, while humans approve patient-facing or financial actions."

## Readiness Bar Before Making The Strong Claim

The upside claim should only be used once these are true:

- All operational modules are live-backed, not seeded.
- NH263 integration is live or clearly documented as a manual production workflow.
- Currency model supports current Zimbabwe usage, including ZiG/ZWG naming where required.
- Fiscalisation approach is defined.
- Security, privacy, backup, retention, and breach procedures are documented.
- Demo data is fully localised.
- AI actions are permissioned, logged, reviewable, and clearly bounded.


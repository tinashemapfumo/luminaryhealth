\set ON_ERROR_STOP off
\pset pager off
SET search_path = luminary, public;

\echo '=== 1 · TENANT ISOLATION ==='
SET SESSION AUTHORIZATION luminary_app;
SELECT set_config('luminary.practice_id','11111111-1111-1111-1111-111111111111',false),
       set_config('luminary.user_id','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',false),
       set_config('luminary.node','test',false);
\echo '-- as Harare (expect only Harare patients):'
SELECT reference, full_name FROM patient ORDER BY reference;

SELECT set_config('luminary.practice_id','22222222-2222-2222-2222-222222222222',false);
\echo '-- as Bulawayo (expect only Sipho):'
SELECT reference, full_name FROM patient ORDER BY reference;

\echo '-- direct attempt to read another tenant by id (expect 0 rows):'
SELECT count(*) AS leaked FROM patient WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

\echo ''
\echo '=== 2 · AUDIT IS APPEND-ONLY ==='
SELECT set_config('luminary.practice_id','11111111-1111-1111-1111-111111111111',false);
SELECT luminary.write_audit('Test event','patient',NULL,'Ruvimbo','seeded','info') IS NOT NULL AS wrote;
\echo '-- UPDATE (expect failure):'
UPDATE audit_event SET action = 'tampered' WHERE action = 'Test event';
\echo '-- DELETE (expect failure):'
DELETE FROM audit_event WHERE action = 'Test event';
\echo '-- row survives:'
SELECT action, severity FROM audit_event WHERE action = 'Test event';

\echo ''
\echo '=== 3 · APPOINTMENT OVERLAP REFUSED ==='
INSERT INTO appointment (practice_id, patient_id, provider_id, room_id, starts_at, duration_min)
VALUES ('11111111-1111-1111-1111-111111111111','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','dddddddd-dddd-dddd-dddd-dddddddddddd',
        '2026-09-01 09:00+02', 45);
\echo '-- overlapping same provider (expect failure):'
INSERT INTO appointment (practice_id, patient_id, provider_id, starts_at, duration_min)
VALUES ('11111111-1111-1111-1111-111111111111','99999999-9999-9999-9999-999999999999',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','2026-09-01 09:30+02', 30);
\echo '-- non-overlapping same provider (expect success):'
INSERT INTO appointment (practice_id, patient_id, provider_id, starts_at, duration_min)
VALUES ('11111111-1111-1111-1111-111111111111','99999999-9999-9999-9999-999999999999',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','2026-09-01 10:00+02', 30);
SELECT to_char(starts_at,'HH24:MI') AS starts, duration_min, to_char(ends_at,'HH24:MI') AS ends FROM appointment ORDER BY starts_at;

\echo ''
\echo '=== 4 · SIGNED NOTE IS IMMUTABLE ==='
INSERT INTO encounter (id, practice_id, patient_id, author_id, subjective, objective, assessment, plan)
VALUES ('12121212-1212-1212-1212-121212121212','11111111-1111-1111-1111-111111111111',
        'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'S','O','A','P');
\echo '-- edit while draft (expect success):'
UPDATE encounter SET assessment = 'A revised while draft' WHERE id = '12121212-1212-1212-1212-121212121212';
\echo '-- sign it:'
UPDATE encounter SET status='signed', signed_by='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', signed_at=now()
 WHERE id = '12121212-1212-1212-1212-121212121212';
\echo '-- edit after signing (expect failure):'
UPDATE encounter SET assessment = 'tampered' WHERE id = '12121212-1212-1212-1212-121212121212';
SELECT status, assessment FROM encounter WHERE id = '12121212-1212-1212-1212-121212121212';

\echo ''
\echo '=== 5 · HARD DELETE REFUSED ==='
DELETE FROM patient WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
\echo '-- tombstone instead (expect success):'
UPDATE patient SET deleted_at = now() WHERE id = '99999999-9999-9999-9999-999999999999';
SELECT count(*) AS visible FROM patient;

\echo ''
\echo '=== 6 · SYNC CHANGE LOG POPULATED BY TRIGGER ==='
SELECT table_name, operation, count(*) FROM sync_change
 GROUP BY table_name, operation ORDER BY table_name, operation;

\echo ''
\echo '=== 7 · WRITE-OFFS DISCHARGE A BALANCE WITHOUT COLLECTING IT ==='
--
-- Migration 015 added `invoice_adjustment` and `invoice.amount_adjusted`. The
-- point of keeping adjustments out of `amount_paid` is that a written-off debt
-- must never read as money the practice collected, so that is what is asserted
-- here — not merely that the row inserts.
SET SESSION AUTHORIZATION luminary_app;
SELECT set_config('luminary.practice_id','11111111-1111-1111-1111-111111111111',false),
       set_config('luminary.user_id','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',false),
       set_config('luminary.node','test',false);

\echo '-- an adjustment with no real reason (expect failure):'
INSERT INTO invoice_adjustment (practice_id, invoice_id, kind, amount, currency, reason, decided_by)
VALUES ('11111111-1111-1111-1111-111111111111','a1a1a1a1-0000-0000-0000-000000000002',
        'write_off', 150, 'USD', 'n/a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

\echo '-- a negative adjustment (expect failure):'
INSERT INTO invoice_adjustment (practice_id, invoice_id, kind, amount, currency, reason, decided_by)
VALUES ('11111111-1111-1111-1111-111111111111','a1a1a1a1-0000-0000-0000-000000000002',
        'write_off', -20, 'USD', 'trying to invent money', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

\echo '-- an unknown kind (expect failure):'
INSERT INTO invoice_adjustment (practice_id, invoice_id, kind, amount, currency, reason, decided_by)
VALUES ('11111111-1111-1111-1111-111111111111','a1a1a1a1-0000-0000-0000-000000000002',
        'discount', 20, 'USD', 'not a permitted kind', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

\echo '-- a proper write-off (expect success):'
INSERT INTO invoice_adjustment (practice_id, invoice_id, kind, amount, currency, reason, decided_by)
VALUES ('11111111-1111-1111-1111-111111111111','a1a1a1a1-0000-0000-0000-000000000002',
        'write_off', 150, 'USD', 'membership lapsed, patient untraceable',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

\echo '-- settle it, then: paid must stay 0 and status must not read as paid:'
WITH settled AS (
  SELECT COALESCE(sum(amount * COALESCE(fx_rate, 1)), 0) AS paid
    FROM payment WHERE invoice_id = 'a1a1a1a1-0000-0000-0000-000000000002' AND deleted_at IS NULL
), written AS (
  SELECT COALESCE(sum(amount), 0) AS adjusted
    FROM invoice_adjustment WHERE invoice_id = 'a1a1a1a1-0000-0000-0000-000000000002' AND deleted_at IS NULL
)
UPDATE invoice i
   SET amount_paid = settled.paid,
       amount_adjusted = written.adjusted,
       status = CASE
         WHEN settled.paid + written.adjusted >= i.patient_portion THEN
           CASE WHEN written.adjusted > 0 AND settled.paid < i.patient_portion
                THEN 'written_off' ELSE 'paid' END
         WHEN i.due_on < current_date THEN 'overdue'
         WHEN settled.paid > 0         THEN 'part_paid'
         ELSE 'pending'
       END
  FROM settled, written
 WHERE i.id = 'a1a1a1a1-0000-0000-0000-000000000002';

SELECT reference, patient_portion, amount_paid, amount_adjusted, status
  FROM invoice WHERE reference = 'INV-T-002';

\echo '-- a written-off debt leaves the receivable (expect only INV-T-001):'
SELECT reference, (patient_portion - amount_paid - amount_adjusted) AS outstanding
  FROM invoice
 WHERE deleted_at IS NULL AND patient_portion > amount_paid + amount_adjusted
 ORDER BY reference;

\echo '-- aging buckets (expect INV-T-001 current, nothing at 90+):'
SELECT CASE
         WHEN current_date - i.due_on <= 0  THEN 'current'
         WHEN current_date - i.due_on <= 30 THEN '1-30'
         WHEN current_date - i.due_on <= 60 THEN '31-60'
         WHEN current_date - i.due_on <= 90 THEN '61-90'
         ELSE '90+'
       END AS bucket,
       count(*)::int AS invoices,
       sum(i.patient_portion - i.amount_paid - i.amount_adjusted) AS outstanding
  FROM invoice i
 WHERE i.deleted_at IS NULL AND i.patient_portion > i.amount_paid + i.amount_adjusted
 GROUP BY bucket ORDER BY min(current_date - i.due_on);

\echo '-- adjustments are tenant scoped (expect 0 rows as Bulawayo):'
SELECT set_config('luminary.practice_id','22222222-2222-2222-2222-222222222222',false);
SELECT count(*) AS leaked FROM invoice_adjustment;

\echo ''
\echo '=== 8 · CATALOGUE, TARIFFS AND ORDERS ==='
--
-- The three rules migration 016 exists to hold:
--   a price is a dated period, not a number;
--   a tariff supersedes rather than overwrites;
--   work that did not happen is never billed, however often the event repeats.
SET SESSION AUTHORIZATION luminary_app;
SELECT set_config('luminary.practice_id','11111111-1111-1111-1111-111111111111',false),
       set_config('luminary.user_id','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',false),
       set_config('luminary.node','test',false);

INSERT INTO service (id, practice_id, internal_code, display_name, clinical_name, billing_description, department, billing_trigger, default_tariff_code)
VALUES ('5e111111-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
        'DIAG-ECG','ECG','Electrocardiogram','12 lead resting ECG','Diagnostics','ON_COMPLETION','93000');

\echo '-- an unknown billing trigger (expect failure):'
INSERT INTO service (practice_id, internal_code, display_name, clinical_name, billing_description, billing_trigger)
VALUES ('11111111-1111-1111-1111-111111111111','X','X','X','X','PER_DAY');

INSERT INTO service_price (practice_id, service_id, amount, currency, effective_from, effective_to)
VALUES ('11111111-1111-1111-1111-111111111111','5e111111-0000-0000-0000-000000000001', 20,'USD','2020-01-01','2026-08-31'),
       ('11111111-1111-1111-1111-111111111111','5e111111-0000-0000-0000-000000000001', 35,'USD','2026-09-01',NULL);

\echo '-- a period that ends before it starts (expect failure):'
INSERT INTO service_price (practice_id, service_id, amount, currency, effective_from, effective_to)
VALUES ('11111111-1111-1111-1111-111111111111','5e111111-0000-0000-0000-000000000001', 9,'USD','2026-10-01','2026-09-01');

\echo '-- the price in force on two dates (expect 20 then 35):'
SELECT d::date AS on_date,
       (SELECT amount FROM service_price sp
         WHERE sp.service_id = '5e111111-0000-0000-0000-000000000001'
           AND sp.deleted_at IS NULL
           AND sp.effective_from <= d::date
           AND (sp.effective_to IS NULL OR sp.effective_to >= d::date)
         ORDER BY sp.effective_from DESC LIMIT 1) AS price
  FROM (VALUES ('2026-08-15'),('2026-09-15')) AS t(d);

INSERT INTO payer (id, practice_id, name)
VALUES ('9a111111-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','NH263');
UPDATE scheme SET payer_id = '9a111111-0000-0000-0000-000000000001'
 WHERE practice_id = '11111111-1111-1111-1111-111111111111';

INSERT INTO tariff (id, practice_id, payer_id, plan_id, service_id, code, rate, currency, effective_from)
SELECT '7a111111-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
       '9a111111-0000-0000-0000-000000000001', s.id, '5e111111-0000-0000-0000-000000000001',
       '93000', 24, 'USD', '2026-01-01'
  FROM scheme s WHERE s.practice_id = '11111111-1111-1111-1111-111111111111' LIMIT 1;

\echo '-- a negative rate (expect failure):'
INSERT INTO tariff (practice_id, payer_id, service_id, code, rate, currency, effective_from)
VALUES ('11111111-1111-1111-1111-111111111111','9a111111-0000-0000-0000-000000000001',
        '5e111111-0000-0000-0000-000000000001','93000',-5,'USD','2026-10-01');

\echo '-- publish a replacement, superseding the old period:'
INSERT INTO tariff (id, practice_id, payer_id, plan_id, service_id, code, rate, currency, effective_from, import_batch_id)
SELECT '7a111111-0000-0000-0000-000000000002', practice_id, payer_id, plan_id, service_id,
       code, 27, currency, '2026-10-01', '7a111111-0000-0000-0000-0000000000ff'
  FROM tariff WHERE id = '7a111111-0000-0000-0000-000000000001';

UPDATE tariff SET effective_to = ('2026-10-01'::date - 1),
                  superseded_by = '7a111111-0000-0000-0000-000000000002'
 WHERE id = '7a111111-0000-0000-0000-000000000001';

\echo '-- both rows survive; September resolves 24 and October 27:'
SELECT d::date AS on_date,
       (SELECT rate FROM tariff t
         WHERE t.service_id = '5e111111-0000-0000-0000-000000000001'
           AND t.deleted_at IS NULL AND t.active
           AND t.effective_from <= d::date
           AND (t.effective_to IS NULL OR t.effective_to >= d::date)
         ORDER BY (t.plan_id IS NOT NULL) DESC, t.effective_from DESC LIMIT 1) AS rate
  FROM (VALUES ('2026-09-15'),('2026-10-15')) AS t(d);

\echo '-- roll the batch back: the prior period reopens, nothing is deleted:'
UPDATE tariff SET effective_to = NULL, superseded_by = NULL
 WHERE superseded_by IN (SELECT id FROM tariff WHERE import_batch_id = '7a111111-0000-0000-0000-0000000000ff');
UPDATE tariff SET active = false, rolled_back_at = now()
 WHERE import_batch_id = '7a111111-0000-0000-0000-0000000000ff';

SELECT count(*) AS rows_kept, count(*) FILTER (WHERE active) AS still_active FROM tariff;
SELECT rate AS october_rate_after_rollback FROM tariff
 WHERE deleted_at IS NULL AND active
   AND effective_from <= '2026-10-15' AND (effective_to IS NULL OR effective_to >= '2026-10-15');

\echo ''
\echo '-- an order stopped without a reason (expect failure):'
INSERT INTO clinical_order (practice_id, patient_id, service_id, status, ordered_by)
VALUES ('11111111-1111-1111-1111-111111111111','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        '5e111111-0000-0000-0000-000000000001','Cancelled','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

INSERT INTO clinical_order (id, practice_id, patient_id, service_id, status, ordered_by)
VALUES ('0d111111-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
        'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','5e111111-0000-0000-0000-000000000001',
        'Completed','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

\echo '-- bill it once:'
INSERT INTO invoice_line (practice_id, invoice_id, service_id, tariff_code, description, quantity, unit_price, scheme_pays, estimated_funder, order_id, billing_key)
VALUES ('11111111-1111-1111-1111-111111111111','a1a1a1a1-0000-0000-0000-000000000001',
        '5e111111-0000-0000-0000-000000000001','93000','12 lead resting ECG',1,35,24,24,
        '0d111111-0000-0000-0000-000000000001','0d111111-0000-0000-0000-000000000001:ON_COMPLETION');

\echo '-- the same completion event again (expect failure: one charge per event):'
INSERT INTO invoice_line (practice_id, invoice_id, service_id, tariff_code, description, quantity, unit_price, scheme_pays, estimated_funder, order_id, billing_key)
VALUES ('11111111-1111-1111-1111-111111111111','a1a1a1a1-0000-0000-0000-000000000001',
        '5e111111-0000-0000-0000-000000000001','93000','12 lead resting ECG',1,35,24,24,
        '0d111111-0000-0000-0000-000000000001','0d111111-0000-0000-0000-000000000001:ON_COMPLETION');

\echo '-- exactly one line exists for that event:'
SELECT count(*) AS lines_for_event FROM invoice_line
 WHERE billing_key = '0d111111-0000-0000-0000-000000000001:ON_COMPLETION' AND deleted_at IS NULL;

\echo '-- the estimate survives adjudication (expect estimated 24, approved 18, patient 17):'
UPDATE invoice_line SET actual_funder_approved = 18, actual_funder_paid = 18
 WHERE billing_key = '0d111111-0000-0000-0000-000000000001:ON_COMPLETION';
SELECT estimated_funder, actual_funder_approved,
       (unit_price * quantity) - COALESCE(actual_funder_approved, estimated_funder) AS patient
  FROM invoice_line WHERE billing_key = '0d111111-0000-0000-0000-000000000001:ON_COMPLETION';

\echo '-- the catalogue is tenant scoped (expect 0 rows as Bulawayo):'
SELECT set_config('luminary.practice_id','22222222-2222-2222-2222-222222222222',false);
SELECT count(*) AS leaked_services FROM service;
SELECT count(*) AS leaked_tariffs FROM tariff;
SELECT count(*) AS leaked_orders FROM clinical_order;

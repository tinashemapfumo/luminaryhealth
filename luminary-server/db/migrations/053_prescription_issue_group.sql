-- =============================================================================
-- 053 - One prescription per issue: group the medicines issued together
-- =============================================================================
--
-- A prescription the doctor issues can carry several medicines. Each medicine
-- stays its own row -- the allergy clash check, status, cancellation and
-- supersession are all per medicine, and pharmacies dispense line by line --
-- but the rows issued in one command now share an issue_group_id, so the
-- chart lists them as one prescription and prints them on one document.
--
-- Additive only. A BEFORE INSERT trigger fills issue_group_id with the row's
-- own id when the caller does not supply one, so the single-drug endpoint and
-- dictation approval keep working unchanged: each is a prescription of one.
--
-- Backfill: the multi-drug endpoint wrote every medicine inside one
-- transaction, so its rows share issued_at (now() is the transaction start)
-- as well as patient, prescriber and encounter. Rows matching on all four are
-- regrouped as the single prescription they were issued as; every other row
-- becomes a group of one. Nothing else about existing rows changes.

SET search_path = luminary, public;

ALTER TABLE luminary.prescription
  ADD COLUMN IF NOT EXISTS issue_group_id uuid;

UPDATE luminary.prescription p
   SET issue_group_id = g.group_id
  FROM (
    SELECT id,
           first_value(id) OVER (
             PARTITION BY practice_id, patient_id, prescriber_id,
                          COALESCE(encounter_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          issued_at
             ORDER BY created_at, id
           ) AS group_id
      FROM luminary.prescription
  ) g
 WHERE g.id = p.id
   AND p.issue_group_id IS NULL;

CREATE OR REPLACE FUNCTION luminary.default_prescription_issue_group()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.issue_group_id IS NULL THEN
    NEW.issue_group_id := NEW.id;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER default_prescription_issue_group
BEFORE INSERT ON luminary.prescription
FOR EACH ROW EXECUTE FUNCTION luminary.default_prescription_issue_group();

ALTER TABLE luminary.prescription
  ALTER COLUMN issue_group_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS prescription_issue_group_idx
  ON luminary.prescription (practice_id, issue_group_id)
  WHERE deleted_at IS NULL;

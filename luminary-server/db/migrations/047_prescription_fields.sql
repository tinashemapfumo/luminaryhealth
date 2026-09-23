-- =============================================================================
-- 047 - Extend prescription with form, dose, quantity, indication, and
--        substitution fields; snapshot the prescriber at issue time
-- =============================================================================
--
-- The prescribing form and printout need fields the table never had: form,
-- dose (as distinct from frequency/directions), quantity to dispense,
-- indication, free-text instructions, and an explicit substitution choice.
-- Additive only — every new column is nullable or defaulted, so existing rows
-- and the existing insert/select statements keep working unchanged until the
-- application is updated to use them.
--
-- Prescriber name/registration are snapshotted at issue time rather than
-- always joined live, because a printed prescription must keep showing who
-- prescribed it even if that clinician's name or registration is later
-- corrected or their account is deactivated.

SET search_path = luminary, public;

ALTER TABLE luminary.prescription
  ADD COLUMN IF NOT EXISTS form                    text,
  ADD COLUMN IF NOT EXISTS dose                     text,
  ADD COLUMN IF NOT EXISTS quantity                 integer,
  ADD COLUMN IF NOT EXISTS indication               text,
  ADD COLUMN IF NOT EXISTS instructions             text,
  ADD COLUMN IF NOT EXISTS substitution_allowed     boolean,
  ADD COLUMN IF NOT EXISTS issued_at                timestamptz,
  ADD COLUMN IF NOT EXISTS prescriber_name          text,
  ADD COLUMN IF NOT EXISTS prescriber_registration  text;

UPDATE luminary.prescription p
   SET issued_at = p.created_at
 WHERE p.issued_at IS NULL;

UPDATE luminary.prescription p
   SET prescriber_name = u.display_name,
       prescriber_registration = u.registration_number
  FROM luminary.app_user u
 WHERE u.id = p.prescriber_id
   AND p.prescriber_name IS NULL;

ALTER TABLE luminary.prescription
  ALTER COLUMN issued_at SET NOT NULL,
  ALTER COLUMN issued_at SET DEFAULT now();

ALTER TABLE luminary.prescription
  ADD CONSTRAINT prescription_quantity_positive CHECK (quantity IS NULL OR quantity > 0),
  ADD CONSTRAINT prescription_duration_positive CHECK (duration_days IS NULL OR duration_days > 0),
  ADD CONSTRAINT prescription_refills_range CHECK (refills BETWEEN 0 AND 12);

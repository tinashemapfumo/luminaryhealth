-- Practice-controlled directory of medical-aid claim inboxes. Destinations are
-- scoped separately from delivery credentials because one payer may expose
-- several addresses while the practice still sends through one mail provider.
CREATE TABLE luminary.claim_email_destination (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id uuid        NOT NULL REFERENCES luminary.practice(id),
  payer_id    uuid REFERENCES luminary.payer(id),
  scheme_id   uuid REFERENCES luminary.scheme(id),
  label       text        NOT NULL,
  email       citext      NOT NULL,
  cc_email    citext,
  purpose     text        NOT NULL DEFAULT 'CLAIMS'
                          CHECK (purpose IN ('CLAIMS','PREAUTHORISATION','QUERIES','REMITTANCE')),
  is_default  boolean     NOT NULL DEFAULT false,
  active      boolean     NOT NULL DEFAULT true,
  notes       text,
  verified_at timestamptz,
  created_by  uuid REFERENCES luminary.app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  origin_node text,
  CHECK (scheme_id IS NULL OR payer_id IS NOT NULL)
);

CREATE UNIQUE INDEX claim_email_destination_unique_idx
  ON luminary.claim_email_destination
    (practice_id, COALESCE(payer_id, '00000000-0000-0000-0000-000000000000'::uuid),
     COALESCE(scheme_id, '00000000-0000-0000-0000-000000000000'::uuid), purpose, email)
  WHERE deleted_at IS NULL;

CREATE INDEX claim_email_destination_route_idx
  ON luminary.claim_email_destination (practice_id, payer_id, scheme_id, purpose, is_default DESC)
  WHERE deleted_at IS NULL AND active;

SELECT luminary.make_tenant_table('luminary.claim_email_destination');


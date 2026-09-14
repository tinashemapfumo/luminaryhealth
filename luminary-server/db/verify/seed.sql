-- Minimal fixture: two practices, one doctor each, one patient each.
SET search_path = luminary, public;

ALTER ROLE luminary_app LOGIN PASSWORD 'apptest';

INSERT INTO practice (id, name, short_name, primary_currency) VALUES
  ('11111111-1111-1111-1111-111111111111','Harare Central Clinic','Harare Central','USD'),
  ('22222222-2222-2222-2222-222222222222','Bulawayo Family Practice','Bulawayo Family','USD');

INSERT INTO app_user (id, practice_id, email, full_name, display_name, role, is_provider) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','chen@h.co.zw','Dr Mei Chen','Dr. Chen','doctor',true),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','22222222-2222-2222-2222-222222222222','ncube@b.co.zw','Dr T Ncube','Dr. Ncube','doctor',true),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc','11111111-1111-1111-1111-111111111111','park@h.co.zw','Dr S Park','Dr. Park','doctor',true),
  ('10000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','admin.test@h.co.zw','Test Administrator','Test Admin','admin',false),
  ('10000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','manager.test@h.co.zw','Test Practice Manager','Test Manager','manager',false),
  ('10000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','doctor.test@h.co.zw','Test Doctor','Test Doctor','doctor',true),
  ('10000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','nurse.test@h.co.zw','Test Nurse','Test Nurse','nurse',false),
  ('10000000-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','reception.test@h.co.zw','Test Receptionist','Test Reception','receptionist',false);

INSERT INTO room (id, practice_id, name) VALUES
  ('dddddddd-dddd-dddd-dddd-dddddddddddd','11111111-1111-1111-1111-111111111111','Room 1');

INSERT INTO patient (id, practice_id, reference, full_name, primary_provider_id, consent_treatment) VALUES
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','11111111-1111-1111-1111-111111111111','PT-2048','Ruvimbo Moyo','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',true),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff','22222222-2222-2222-2222-222222222222','PT-8801','Sipho Nkomo','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',true),
  ('99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111','PT-2210','Chiedza Mutasa','cccccccc-cccc-cccc-cccc-cccccccccccc',true);

-- Billing fixture, so the adjustment and aging paths have something to run
-- against. Two invoices for Ruvimbo: one settled by cash, one long overdue with
-- no cover behind it — the write-off case that migration 015 exists for.
INSERT INTO invoice (id, practice_id, patient_id, reference, issued_on, due_on, currency,
                     total, scheme_portion, patient_portion) VALUES
  ('a1a1a1a1-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
   'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','INV-T-001',
   current_date - 10, current_date + 20, 'USD', 60, 54, 6),
  ('a1a1a1a1-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111',
   'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','INV-T-002',
   current_date - 150, current_date - 120, 'USD', 150, 0, 150);

INSERT INTO invoice_line (practice_id, invoice_id, tariff_code, description, unit_price, scheme_pays) VALUES
  ('11111111-1111-1111-1111-111111111111','a1a1a1a1-0000-0000-0000-000000000001',
   '99213','Office visit, established patient', 60, 54),
  ('11111111-1111-1111-1111-111111111111','a1a1a1a1-0000-0000-0000-000000000002',
   '11402','Minor procedure, lesion removal', 150, 0);

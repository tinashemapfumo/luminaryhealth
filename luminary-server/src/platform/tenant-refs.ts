import type { PoolClient } from 'pg';
import { BadRequest, NotFound } from './errors.js';

export async function requirePatientInTenant(client: PoolClient, patientId: string) {
  const { rows } = await client.query(
    `SELECT id, full_name, merged_into_id
       FROM luminary.patient
      WHERE id = $1
        AND practice_id = luminary.current_practice_id()
        AND deleted_at IS NULL`,
    [patientId],
  );
  if (!rows[0]) throw new NotFound('Patient not found');
  return rows[0];
}

export async function requireAppointmentInTenant(client: PoolClient, appointmentId: string) {
  const { rows } = await client.query(
    `SELECT id, patient_id, provider_id, starts_at, status, visit_type
       FROM luminary.appointment
      WHERE id = $1
        AND practice_id = luminary.current_practice_id()
        AND deleted_at IS NULL`,
    [appointmentId],
  );
  if (!rows[0]) throw new NotFound('Appointment not found');
  return rows[0];
}

export async function requireEncounterInTenant(client: PoolClient, encounterId: string) {
  const { rows } = await client.query(
    `SELECT id, patient_id, appointment_id, status, note_type
       FROM luminary.encounter
      WHERE id = $1
        AND practice_id = luminary.current_practice_id()
        AND deleted_at IS NULL`,
    [encounterId],
  );
  if (!rows[0]) throw new NotFound('Encounter not found');
  return rows[0];
}

export async function requireProviderInTenant(client: PoolClient, providerId: string) {
  const { rows } = await client.query(
    `SELECT id, display_name, active, is_provider
       FROM luminary.app_user
      WHERE id = $1
        AND practice_id = luminary.current_practice_id()
        AND deleted_at IS NULL`,
    [providerId],
  );
  if (!rows[0]) throw new NotFound('Provider not found');
  if (!rows[0].active || !rows[0].is_provider) throw new BadRequest('Provider is not active');
  return rows[0];
}

export async function requireUserInTenant(client: PoolClient, userId: string) {
  const { rows } = await client.query(
    `SELECT id, display_name, active
       FROM luminary.app_user
      WHERE id = $1
        AND practice_id = luminary.current_practice_id()
        AND deleted_at IS NULL`,
    [userId],
  );
  if (!rows[0]) throw new NotFound('User not found');
  return rows[0];
}

export async function requireRoomInTenant(client: PoolClient, roomId: string) {
  const { rows } = await client.query(
    `SELECT id, name
       FROM luminary.room
      WHERE id = $1
        AND practice_id = luminary.current_practice_id()
        AND deleted_at IS NULL`,
    [roomId],
  );
  if (!rows[0]) throw new NotFound('Room not found');
  return rows[0];
}

export async function requireServiceInTenant(client: PoolClient, serviceId: string) {
  const { rows } = await client.query(
    `SELECT id, display_name, active, orderable, billable
       FROM luminary.service
      WHERE id = $1
        AND practice_id = luminary.current_practice_id()
        AND deleted_at IS NULL`,
    [serviceId],
  );
  if (!rows[0]) throw new NotFound('Service not found');
  return rows[0];
}

export function assertSamePatient(actual: string | null | undefined, expected: string, message: string): void {
  if (actual !== expected) throw new BadRequest(message);
}

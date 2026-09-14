import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../../platform/db.js';
import { can, requirePermission, type Role } from '../../platform/permissions.js';
import { schedulingRepository } from './scheduling.repository.js';
import { BadRequest, Conflict, Forbidden, NotFound, Unauthorized } from '../../platform/errors.js';
import { messagingService } from '../messaging/messaging.service.js';
import { requirePatientInTenant, requireProviderInTenant, requireRoomInTenant } from '../../platform/tenant-refs.js';

/**
 * Scheduling.
 *
 * Small enough that routes call the repository directly — there is no rule here
 * that a database constraint does not already express, and inventing a service
 * layer to pass values through would be ceremony rather than structure.
 * Check-in progression is the exception, so it lives in `advance()` below.
 */

interface Actor { userId: string; role: Role; practiceId: string }

/**
 * Visit status is a progression, not a free-form field: reception cannot mark
 * someone completed who never arrived. `no_show` and `cancelled` are reachable
 * from any pre-consultation state because reality is untidy.
 */
const NEXT: Record<string, string[]> = {
  booked: ['checked_in', 'no_show', 'cancelled'],
  checked_in: ['in_triage', 'waiting_for_provider', 'in_consultation', 'no_show', 'cancelled'],
  in_triage: ['waiting_for_provider', 'in_consultation', 'no_show', 'cancelled'],
  waiting_for_provider: ['in_consultation', 'no_show', 'cancelled'],
  in_consultation: ['completed'],
  completed: [],
  no_show: ['booked'],
  cancelled: ['booked'],
};

function mayChangeStatus(actor: Actor, current: { status: string; provider_id?: string | null }, status: string): boolean {
  if (actor.role === 'doctor'
      && status === 'in_consultation'
      && current.status === 'waiting_for_provider'
      && (!current.provider_id || current.provider_id === actor.userId)) {
    return true;
  }

  if (actor.role === 'doctor'
      && status === 'completed'
      && current.status === 'in_consultation'
      && current.provider_id === actor.userId) {
    return true;
  }

  if (['in_triage', 'waiting_for_provider'].includes(status)) {
    return can(actor.role, 'recordVitals') || can(actor.role, 'writeNote');
  }

  if (['in_consultation', 'completed'].includes(status)) {
    return false;
  }

  return can(actor.role, 'checkIn');
}

export async function schedulingRoutes(app: FastifyInstance): Promise<void> {
  const actorOf = (request: FastifyRequest): Actor => {
    if (!request.session) throw new Unauthorized();
    const { userId, role, practiceId } = request.session;
    return { userId, role, practiceId };
  };
  const run = <T>(a: Actor, work: Parameters<typeof withTenant<T>>[1]) =>
    withTenant<T>({ practiceId: a.practiceId, userId: a.userId }, work);

  app.get('/appointments', async (request) => {
    const query = z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      providerId: z.string().uuid().optional(),
      roomId: z.string().uuid().optional(),
      patientId: z.string().uuid().optional(),
    }).parse(request.query);

    const actor = actorOf(request);
    if (!can(actor.role, 'viewPatientDirectory')) {
      throw new Forbidden('Your role does not include the schedule');
    }
    // A doctor's calendar is their own list unless they ask otherwise, matching
    // how the workspace presents it.
    const scoped = actor.role === 'doctor' && !query.providerId
      ? { ...query, providerId: actor.userId, includeReadyUnassigned: true }
      : query;
    return run(actor, (client) => schedulingRepository.list(client, scoped));
  });

  app.get('/appointments/availability', async (request) => {
    const { providerId, day, durationMin, roomId } = z.object({
      providerId: z.string().uuid(),
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
      durationMin: z.coerce.number().int().positive().max(480).optional(),
      roomId: z.string().uuid().nullable().optional(),
    }).parse(request.query);
    const actor = actorOf(request);
    return run(actor, async (client) => {
      if (!(await schedulingRepository.providerExists(client, providerId))) {
        throw new BadRequest('Provider not found');
      }
      return schedulingRepository.availability(client, providerId, day, { durationMin, roomId });
    });
  });

  app.get('/appointments/:id/status-history', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const actor = actorOf(request);
    if (!can(actor.role, 'viewPatientDirectory')) {
      throw new Forbidden('Your role does not include the schedule');
    }
    return run(actor, async (client) => {
      const current = await schedulingRepository.findById(client, id);
      if (!current) throw new NotFound('Appointment not found');
      return schedulingRepository.statusHistory(client, id);
    });
  });

  app.post('/appointments', {
    preHandler: requirePermission('scheduleVisit'),
    handler: async (request, reply) => {
      const body = z.object({
        patientId: z.string().uuid(),
        providerId: z.string().uuid().nullable().optional(),
        roomId: z.string().uuid().nullable().optional(),
        startsAt: z.string().datetime({ offset: true }).nullable().optional(),
        durationMin: z.number().int().positive().max(480).default(30),
        visitType: z.string().optional(),
        reason: z.string().optional(),
        mode: z.enum(['in_person', 'telehealth']).default('in_person'),
        origin: z.enum(['scheduled', 'walk_in']).default('scheduled'),
      }).parse(request.body);

      const actor = actorOf(request);
      const appointment = await run(actor, async (client) => {
        if (body.origin === 'scheduled' && (!body.providerId || !body.startsAt)) {
          throw new BadRequest('Scheduled appointments require a provider and start time');
        }
        await requirePatientInTenant(client, body.patientId);
        if (body.providerId) await requireProviderInTenant(client, body.providerId);
        if (body.roomId) await requireRoomInTenant(client, body.roomId);
        if (body.origin === 'scheduled'
            && body.startsAt
            && !(await schedulingRepository.practiceOpenForScheduledSlot(client, body.startsAt, body.durationMin))) {
          throw new Conflict('The practice is closed at that appointment time');
        }
        const created = await schedulingRepository.create(client, { ...body, actorId: actor.userId });
        await client.query(
          `SELECT luminary.write_audit($1, 'appointment', $2, $3, $4, 'info')`,
          [
            created.origin === 'walk_in' ? 'Admitted walk-in' : 'Booked appointment',
            created.id,
            created.visit_type ?? 'Visit',
            created.origin === 'walk_in' ? created.arrived_at : created.starts_at,
          ],
        );
        return created;
      });
      return reply.code(201).send(appointment);
    },
  });

  app.patch('/appointments/:id', {
    preHandler: requirePermission('scheduleVisit'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z.object({
        startsAt: z.string().datetime({ offset: true }).optional(),
        durationMin: z.number().int().positive().max(480).optional(),
        providerId: z.string().uuid().optional(),
        roomId: z.string().uuid().nullable().optional(),
      }).parse(request.body);

      const actor = actorOf(request);
      return run(actor, async (client) => {
        // A clash raises 23P01 here and is translated to a 409 naming the
        // conflict, rather than being pre-checked in a race with other nodes.
        if (body.providerId) await requireProviderInTenant(client, body.providerId);
        if (body.roomId) await requireRoomInTenant(client, body.roomId);
        const current = await schedulingRepository.findById(client, id);
        if (!current) throw new NotFound('Appointment not found');
        const nextStartsAt = body.startsAt ?? current.starts_at;
        const nextDurationMin = body.durationMin ?? current.duration_min;
        if (current.origin === 'scheduled'
            && (body.startsAt || body.durationMin)
            && !(await schedulingRepository.practiceOpenForScheduledSlot(client, nextStartsAt, nextDurationMin))) {
          throw new Conflict('The practice is closed at that appointment time');
        }
        const moved = await schedulingRepository.reschedule(client, id, { ...body, actorId: actor.userId });
        if (!moved) throw new NotFound('Appointment not found');
        if (body.providerId && body.providerId !== current.provider_id) {
          await client.query(
            `SELECT luminary.write_audit('Assigned provider', 'appointment', $1, $2, $3, 'notice')`,
            [id, moved.visit_type ?? 'Visit', moved.provider_name ?? body.providerId],
          );
        }
        await client.query(
          `SELECT luminary.write_audit('Rescheduled appointment', 'appointment', $1, $2, $3, 'notice')`,
          [id, moved.visit_type ?? 'Visit', moved.starts_at],
        );
        const cancelled = await messagingService.cancelQueuedForAppointment(
          client,
          id,
          'Appointment was rescheduled before dispatch; create a fresh reminder for the new time',
        );
        if (cancelled.length > 0) {
          await client.query(
            `SELECT luminary.write_audit('Cancelled stale appointment reminders', 'appointment', $1, $2, $3, 'notice')`,
            [id, moved.visit_type ?? 'Visit', `${cancelled.length} queued message(s) cancelled`],
          );
        }
        return moved;
      });
    },
  });

  app.post('/appointments/:id/status', async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { status, reason } = z.object({
        status: z.enum([
          'checked_in',
          'in_triage',
          'waiting_for_provider',
          'in_consultation',
          'completed',
          'no_show',
          'cancelled',
          'booked',
        ]),
        reason: z.string().trim().max(500).optional(),
      }).parse(request.body);

      const actor = actorOf(request);
      return run(actor, async (client) => {
        const current = await schedulingRepository.findById(client, id);
        if (!current) throw new NotFound('Appointment not found');

        if (!mayChangeStatus(actor, current, status)) {
          throw new Forbidden('Your role does not include this visit transition');
        }

        if (['cancelled', 'no_show'].includes(status) && (!reason || reason.length < 5)) {
          throw new BadRequest('Record a reason for this visit status');
        }

        const allowed = NEXT[current.status] ?? [];
        if (!allowed.includes(status)) {
          throw new BadRequest(
            `A visit that is "${current.status}" cannot become "${status}"` +
            (allowed.length ? ` — only ${allowed.join(', ')}` : ' — it is already finished'),
          );
        }

        if (actor.role === 'doctor'
            && status === 'in_consultation'
            && current.status === 'waiting_for_provider'
            && !current.provider_id) {
          await schedulingRepository.reschedule(client, id, { providerId: actor.userId, actorId: actor.userId });
          await client.query(
            `SELECT luminary.write_audit('Assigned provider', 'appointment', $1, $2, $3, 'notice')`,
            [id, current.visit_type ?? 'Visit', actor.userId],
          );
        }

        const updated = await schedulingRepository.setStatus(client, id, status, reason);
        if (status === 'cancelled') {
          const cancelled = await messagingService.cancelQueuedForAppointment(
            client,
            id,
            'Appointment was cancelled before dispatch',
          );
          if (cancelled.length > 0) {
            await client.query(
              `SELECT luminary.write_audit('Cancelled appointment reminders', 'appointment', $1, $2, $3, 'notice')`,
              [id, current.patient_name, `${cancelled.length} queued message(s) cancelled`],
            );
          }
        }
        await client.query(
          `SELECT luminary.write_audit($1, 'appointment', $2, $3, $4, 'info')`,
          [
            `Visit ${status.replace('_', ' ')}`,
            id,
            current.patient_name,
            reason ? `${current.status} -> ${status}: ${reason}` : current.status + ' -> ' + status,
          ],
        );
        return updated;
      });
  });
}

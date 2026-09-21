import type { PoolClient } from 'pg';
import { billingService } from '../billing/billing.service.js';
import { buildComparisonMetric, rate } from './metrics.js';
import { executiveInsightRepository as repository, type AppointmentStats, type ClaimRow, type MoneyRow } from './executive-insight.repository.js';
import { resolveReportingPeriod, type ComparisonMode, type DateRange, type ReportingPeriod, type ResolvedReportingPeriod } from './reporting-period.js';

export interface ReportingRequest { period: ReportingPeriod; compare: ComparisonMode }

const publicPeriod = (period: ResolvedReportingPeriod) => ({
  requested: period.requested, from: period.from, to: period.to, compare: period.compare,
  comparisonFrom: period.comparisonFrom, comparisonTo: period.comparisonTo,
});
const currentRange = (period: ResolvedReportingPeriod): DateRange => period;
const previousRange = (period: ResolvedReportingPeriod): DateRange | null => period.comparisonFrom && period.comparisonTo && period.comparisonToExclusive
  ? { from: period.comparisonFrom, to: period.comparisonTo, toExclusive: period.comparisonToExclusive }
  : null;
const compare = (current: number | null, previous: number | null, enabled: boolean) =>
  buildComparisonMetric(current, enabled ? previous : null);
const sum = <T>(rows: T[], pick: (row: T) => number) => rows.reduce((total, row) => total + pick(row), 0);

function appointmentMetrics(current: AppointmentStats, previous: AppointmentStats | null) {
  const enabled = previous !== null;
  return {
    scheduled: compare(current.scheduled, previous?.scheduled ?? null, enabled),
    completed: compare(current.completed, previous?.completed ?? null, enabled),
    cancelled: compare(current.cancelled, previous?.cancelled ?? null, enabled),
    noShows: compare(current.noShows, previous?.noShows ?? null, enabled),
    completionRate: compare(rate(current.completed, current.scheduled), previous ? rate(previous.completed, previous.scheduled) : null, enabled),
  };
}

function moneyMetrics(current: MoneyRow[], previous: MoneyRow[] | null, field: keyof Pick<MoneyRow, 'billed' | 'collected' | 'outstanding'>) {
  const currencies = [...new Set([...current.map((r) => r.currency), ...(previous ?? []).map((r) => r.currency)])].sort();
  return currencies.map((currency) => ({
    currency,
    ...compare(current.find((r) => r.currency === currency)?.[field] ?? 0,
      previous?.find((r) => r.currency === currency)?.[field] ?? null, previous !== null),
  }));
}

type CollectionsSummary = Awaited<ReturnType<typeof billingService.executiveCollections>>;

function withCanonicalCollections(rows: MoneyRow[], collections: CollectionsSummary): MoneyRow[] {
  const currencies = new Set([...rows.map((row) => row.currency), ...collections.currencies.map((row) => row.currency)]);
  return [...currencies].sort().map((currency) => {
    const revenue = rows.find((row) => row.currency === currency);
    const collection = collections.currencies.find((row) => row.currency === currency);
    return {
      currency,
      billed: revenue?.billed ?? 0,
      collected: collection?.netCollections ?? 0,
      outstanding: revenue?.outstanding ?? 0,
    };
  });
}

function claimCount(rows: ClaimRow[], field: keyof Pick<ClaimRow, 'submitted' | 'approved' | 'rejected' | 'pending'>) {
  return sum(rows, (row) => row[field]);
}
function claimValueMetrics(current: ClaimRow[], previous: ClaimRow[] | null, field: keyof Pick<ClaimRow, 'submittedValue' | 'approvedValue' | 'rejectedValue' | 'pendingValue'>) {
  const currencies = [...new Set([...current.map((r) => r.currency), ...(previous ?? []).map((r) => r.currency)])].sort();
  return currencies.map((currency) => ({
    currency,
    ...compare(current.find((r) => r.currency === currency)?.[field] ?? 0,
      previous?.find((r) => r.currency === currency)?.[field] ?? null, previous !== null),
  }));
}

async function context(client: PoolClient, input: ReportingRequest) {
  const clock = await repository.practiceClock(client);
  const period = resolveReportingPeriod(input.period, input.compare, clock.today);
  return { clock, period, current: currentRange(period), previous: previousRange(period) };
}

export const executiveInsightService = {
  async appointments(client: PoolClient, input: ReportingRequest) {
    const ctx = await context(client, input);
    const [current, previous] = await Promise.all([
      repository.appointments(client, ctx.current, ctx.clock.timezone),
      ctx.previous ? repository.appointments(client, ctx.previous, ctx.clock.timezone) : Promise.resolve(null),
    ]);
    const metrics = appointmentMetrics(current, previous);
    return {
      reportingPeriod: publicPeriod(ctx.period), appointments: {
        scheduled: metrics.scheduled, completed: metrics.completed,
        cancelled: metrics.cancelled, noShows: metrics.noShows,
      },
      rates: {
        completionRate: metrics.completionRate,
        cancellationRate: compare(rate(current.cancelled, current.scheduled), previous ? rate(previous.cancelled, previous.scheduled) : null, previous !== null),
        noShowRate: compare(rate(current.noShows, current.scheduled), previous ? rate(previous.noShows, previous.scheduled) : null, previous !== null),
      },
      utilisation: { bookedCapacityPercent: null },
      timing: { averageLeadTimeDays: compare(current.averageLeadTimeDays, previous?.averageLeadTimeDays ?? null, previous !== null) },
    };
  },

  async patients(client: PoolClient, input: ReportingRequest) {
    const ctx = await context(client, input);
    const [current, previous, days] = await Promise.all([
      repository.appointments(client, ctx.current, ctx.clock.timezone),
      ctx.previous ? repository.appointments(client, ctx.previous, ctx.clock.timezone) : Promise.resolve(null),
      repository.activityExtremes(client, ctx.current, ctx.clock.timezone),
    ]);
    const avg = current.activeDays ? current.completed / current.activeDays : null;
    const previousAvg = previous?.activeDays ? previous.completed / previous.activeDays : null;
    return {
      reportingPeriod: publicPeriod(ctx.period),
      patients: {
        totalSeen: compare(current.completed, previous?.completed ?? null, previous !== null),
        uniquePatients: compare(current.uniquePatients, previous?.uniquePatients ?? null, previous !== null),
        newPatients: compare(current.newPatients, previous?.newPatients ?? null, previous !== null),
        returningPatients: compare(current.uniquePatients - current.newPatients,
          previous ? previous.uniquePatients - previous.newPatients : null, previous !== null),
      },
      activity: {
        averagePatientsPerDay: compare(avg, previousAvg, previous !== null),
        busiestDay: days[0] ?? { date: null, count: 0 },
        quietestDay: days.length ? days.reduce((a, b) => b.count < a.count ? b : a) : { date: null, count: 0 },
      },
    };
  },

  async revenue(client: PoolClient, input: ReportingRequest) {
    const ctx = await context(client, input);
    const [currentRevenue, previousRevenue, currentCollections, previousCollections, receivables] = await Promise.all([
      repository.revenue(client, ctx.current, ctx.clock.timezone),
      ctx.previous ? repository.revenue(client, ctx.previous, ctx.clock.timezone) : Promise.resolve(null),
      billingService.executiveCollections(client, { from: ctx.current.from, to: ctx.current.to }),
      ctx.previous
        ? billingService.executiveCollections(client, { from: ctx.previous.from, to: ctx.previous.to })
        : Promise.resolve(null),
      billingService.executiveAging(client, ctx.period.to, ctx.clock.timezone),
    ]);
    const current = withCanonicalCollections(currentRevenue, currentCollections);
    const previous = previousRevenue && previousCollections
      ? withCanonicalCollections(previousRevenue, previousCollections)
      : null;
    const currencies = [...new Set(current.map((row) => row.currency))];
    const paymentBreakdown = currentCollections.currencies.flatMap((currency) =>
      currency.byMethod.map((method) => ({
        currency: currency.currency,
        method: String(method.method),
        amount: Number(method.net),
      })),
    );
    return {
      reportingPeriod: publicPeriod(ctx.period),
      revenue: {
        billed: moneyMetrics(current, previous, 'billed'),
        collected: moneyMetrics(current, previous, 'collected'),
        outstanding: moneyMetrics(current, previous, 'outstanding'),
      },
      collections: {
        collectionRate: currencies.map((currency) => {
          const c = current.find((row) => row.currency === currency)!;
          const p = previous?.find((row) => row.currency === currency);
          return { currency, ...compare(rate(c.collected, c.billed), p ? rate(p.collected, p.billed) : null, previous !== null) };
        }),
      },
      paymentBreakdown,
      receivables: receivables.summary,
    };
  },

  async claims(client: PoolClient, input: ReportingRequest) {
    const ctx = await context(client, input);
    const [current, previous, rejectionCategories] = await Promise.all([
      repository.claims(client, ctx.current, ctx.clock.timezone),
      ctx.previous ? repository.claims(client, ctx.previous, ctx.clock.timezone) : Promise.resolve(null),
      repository.rejectionCategories(client, ctx.current, ctx.clock.timezone),
    ]);
    const countMetric = (field: keyof Pick<ClaimRow, 'submitted' | 'approved' | 'rejected' | 'pending'>) =>
      compare(claimCount(current, field), previous ? claimCount(previous, field) : null, previous !== null);
    const submitted = claimCount(current, 'submitted');
    const previousSubmitted = previous ? claimCount(previous, 'submitted') : 0;
    const processing = current.filter((row) => row.averageProcessingDays !== null);
    const previousProcessing = previous?.filter((row) => row.averageProcessingDays !== null) ?? [];
    return {
      reportingPeriod: publicPeriod(ctx.period),
      claims: {
        submitted: countMetric('submitted'), approved: countMetric('approved'), rejected: countMetric('rejected'), pending: countMetric('pending'),
        approvalRate: compare(rate(claimCount(current, 'approved'), submitted), previous ? rate(claimCount(previous, 'approved'), previousSubmitted) : null, previous !== null),
        rejectionRate: compare(rate(claimCount(current, 'rejected'), submitted), previous ? rate(claimCount(previous, 'rejected'), previousSubmitted) : null, previous !== null),
        pendingRate: compare(rate(claimCount(current, 'pending'), submitted), previous ? rate(claimCount(previous, 'pending'), previousSubmitted) : null, previous !== null),
      },
      values: {
        submitted: claimValueMetrics(current, previous, 'submittedValue'), approved: claimValueMetrics(current, previous, 'approvedValue'),
        rejected: claimValueMetrics(current, previous, 'rejectedValue'), pending: claimValueMetrics(current, previous, 'pendingValue'),
      },
      processing: {
        averageProcessingDays: compare(processing.length ? sum(processing, (r) => r.averageProcessingDays!) / processing.length : null,
          previousProcessing.length ? sum(previousProcessing, (r) => r.averageProcessingDays!) / previousProcessing.length : null, previous !== null),
      },
      rejectionCategories,
    };
  },

  async operations(client: PoolClient, input: ReportingRequest) {
    const ctx = await context(client, input);
    const [current, previous, visits, previousVisits] = await Promise.all([
      repository.operations(client, ctx.current, ctx.clock.timezone),
      ctx.previous ? repository.operations(client, ctx.previous, ctx.clock.timezone) : Promise.resolve(null),
      repository.appointments(client, ctx.current, ctx.clock.timezone),
      ctx.previous ? repository.appointments(client, ctx.previous, ctx.clock.timezone) : Promise.resolve(null),
    ]);
    return {
      reportingPeriod: publicPeriod(ctx.period),
      throughput: {
        patientsProcessed: compare(current.patientsProcessed, previous?.patientsProcessed ?? null, previous !== null),
        averagePatientsPerDay: compare(visits.activeDays ? visits.completed / visits.activeDays : null,
          previousVisits?.activeDays ? previousVisits.completed / previousVisits.activeDays : null, previous !== null),
      },
      waitTimes: { averageWaitMinutes: compare(current.averageWaitMinutes, previous?.averageWaitMinutes ?? null, previous !== null) },
      consultationFlow: {
        averageConsultationMinutes: compare(current.averageConsultationMinutes, previous?.averageConsultationMinutes ?? null, previous !== null),
        averageTotalVisitMinutes: compare(current.averageTotalVisitMinutes, previous?.averageTotalVisitMinutes ?? null, previous !== null),
      },
      operationalIndicators: { delayedVisits: compare(current.delayedVisits, previous?.delayedVisits ?? null, previous !== null) },
      bottlenecks: [],
    };
  },

  async executiveSummary(client: PoolClient, input: ReportingRequest) {
    const ctx = await context(client, input);
    const [appointments, previousAppointments, revenueRows, previousRevenueRows, collections, previousCollections, claims, previousClaims, operations, previousOperations] = await Promise.all([
      repository.appointments(client, ctx.current, ctx.clock.timezone),
      ctx.previous ? repository.appointments(client, ctx.previous, ctx.clock.timezone) : Promise.resolve(null),
      repository.revenue(client, ctx.current, ctx.clock.timezone),
      ctx.previous ? repository.revenue(client, ctx.previous, ctx.clock.timezone) : Promise.resolve(null),
      billingService.executiveCollections(client, { from: ctx.current.from, to: ctx.current.to }),
      ctx.previous ? billingService.executiveCollections(client, { from: ctx.previous.from, to: ctx.previous.to }) : Promise.resolve(null),
      repository.claims(client, ctx.current, ctx.clock.timezone),
      ctx.previous ? repository.claims(client, ctx.previous, ctx.clock.timezone) : Promise.resolve(null),
      repository.operations(client, ctx.current, ctx.clock.timezone),
      ctx.previous ? repository.operations(client, ctx.previous, ctx.clock.timezone) : Promise.resolve(null),
    ]);
    const appointment = appointmentMetrics(appointments, previousAppointments);
    const revenue = withCanonicalCollections(revenueRows, collections);
    const previousRevenue = previousRevenueRows && previousCollections
      ? withCanonicalCollections(previousRevenueRows, previousCollections)
      : null;
    const claimMetric = (field: keyof Pick<ClaimRow, 'submitted' | 'approved' | 'rejected' | 'pending'>) =>
      compare(claimCount(claims, field), previousClaims ? claimCount(previousClaims, field) : null, previousClaims !== null);
    const submitted = claimCount(claims, 'submitted');
    const previousSubmitted = previousClaims ? claimCount(previousClaims, 'submitted') : 0;
    return {
      reportingPeriod: publicPeriod(ctx.period),
      patients: {
        seen: compare(appointments.completed, previousAppointments?.completed ?? null, previousAppointments !== null),
        newPatients: compare(appointments.newPatients, previousAppointments?.newPatients ?? null, previousAppointments !== null),
      },
      appointments: {
        scheduled: appointment.scheduled, completed: appointment.completed,
        cancelled: appointment.cancelled, noShows: appointment.noShows,
        completionRate: appointment.completionRate,
      },
      revenue: {
        billed: moneyMetrics(revenue, previousRevenue, 'billed'),
        collected: moneyMetrics(revenue, previousRevenue, 'collected'),
        outstanding: moneyMetrics(revenue, previousRevenue, 'outstanding'),
      },
      claims: {
        submitted: claimMetric('submitted'), approved: claimMetric('approved'),
        rejected: claimMetric('rejected'), pending: claimMetric('pending'),
        approvalRate: compare(rate(claimCount(claims, 'approved'), submitted), previousClaims ? rate(claimCount(previousClaims, 'approved'), previousSubmitted) : null, previousClaims !== null),
        rejectionRate: compare(rate(claimCount(claims, 'rejected'), submitted), previousClaims ? rate(claimCount(previousClaims, 'rejected'), previousSubmitted) : null, previousClaims !== null),
        pendingRate: compare(rate(claimCount(claims, 'pending'), submitted), previousClaims ? rate(claimCount(previousClaims, 'pending'), previousSubmitted) : null, previousClaims !== null),
      },
      operations: {
        averageWaitMinutes: compare(operations.averageWaitMinutes, previousOperations?.averageWaitMinutes ?? null, previousOperations !== null),
        averageVisitMinutes: compare(operations.averageTotalVisitMinutes, previousOperations?.averageTotalVisitMinutes ?? null, previousOperations !== null),
      },
    };
  },
};

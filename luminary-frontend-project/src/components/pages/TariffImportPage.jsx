import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Upload, Download, RotateCcw, Check, SkipForward } from 'lucide-react';
import { StatusPill } from '../shared/StatusPill';
import { EmptyState } from '../shared/EmptyState';
import { useWorkspace } from '../../lib/workspace';
import { parseFile } from '../../lib/import/parse';
import {
  guessMapping, applyMapping, missingRequired, makeProfile, profileMatchesHeaders,
  TARIFF_FIELDS, SERVICE_FIELDS, IMPORT_KINDS,
} from '../../lib/import/profiles';
import {
  stageTariffRow, stageServiceRow, flagDuplicates, summariseBatch,
  buildTariffRecords, buildServiceRecords, ROW_STATUS,
} from '../../lib/import/stage';

/**
 * Importing payer schedules and price lists.
 *
 * The stages are separate on purpose — parse, map, review, publish — because
 * each is a decision a person has to be able to stop at. A single "import"
 * button that read a file and wrote prices would re-price an entire practice on
 * one mis-mapped column, and the first person to notice would be a patient at
 * the desk.
 *
 * Nothing here touches live pricing until Publish, and Publish supersedes
 * rather than overwrites, which is what makes the rollback beside it safe.
 */

const TARIFF_TEMPLATE = [
  'medical_aid,plan,tariff_code,service_name,description,rate,currency,effective_from,effective_to',
  'NH263,NH263 Plan A,93000,ECG,12 lead resting ECG,27,USD,2026-10-01,',
  'NH263,NH263 Plan B,93000,ECG,12 lead resting ECG,18,USD,2026-10-01,',
  'NH263,NH263 Plan A,99213,Consultation established patient,Office visit,36,USD,2026-10-01,',
].join('\r\n');

const SERVICE_TEMPLATE = [
  'service_name,billing_description,category,department,practice_price,currency,billing_trigger,tariff_code,orderable,active',
  'ECG,12 lead resting ECG,Diagnostics,Diagnostics,35,USD,ON_COMPLETION,93000,true,true',
  'Full blood count,Full blood count,Diagnostics,Laboratory,,USD,ON_COMPLETION,FBC,true,true',
  'Variable procedure,Procedure priced at invoice time,Procedures,General Practice,,USD,MANUAL,,true,true',
].join('\r\n');

// Excel needs a byte order mark to open a UTF-8 CSV without mangling accents.
// Built from its code point rather than typed as a character: an invisible byte
// in source is indistinguishable from one pasted in by accident.
const BOM = String.fromCharCode(0xFEFF);

const download = (name, text, notify) => {
  const blob = new Blob([BOM + text], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  notify(`${name} downloaded`);
};

export default function TariffImportPage() {
  const {
    access, catalogue, configuredServices, payers, tariffProvider,
    publishTariffBatch, publishServiceBatch, importBatches, mappingProfiles,
    saveMappingProfile, addServiceAlias, rollbackTariffBatch,
    billingCurrency, currentUser, notify,
  } = useWorkspace();

  const fileInput = useRef(null);
  const [kind, setKind] = useState(IMPORT_KINDS.TARIFF.id);
  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [mapping, setMapping] = useState({});
  const [payerId, setPayerId] = useState(payers[0]?.id ?? '');
  const [resolutions, setResolutions] = useState({});
  const [error, setError] = useState(null);
  const [appliedProfile, setAppliedProfile] = useState(null);

  const isTariff = kind === IMPORT_KINDS.TARIFF.id;
  const fields = isTariff ? TARIFF_FIELDS : SERVICE_FIELDS;
  const payer = payers.find((p) => p.id === payerId) ?? payers[0];
  const existing = useMemo(() => tariffProvider.current(), [tariffProvider]);

  // Reset the mapping when the kind changes: the two imports do not share a
  // single field, so carrying one over would silently mis-map the other.
  useEffect(() => { setMapping({}); setParsed(null); setFile(null); setResolutions({}); }, [kind]);

  const staged = useMemo(() => {
    if (!parsed || missingRequired(mapping, fields).length > 0) return null;
    const rows = parsed.rows.map((row) => {
      const mapped = applyMapping(row, mapping);
      return isTariff
        ? stageTariffRow(mapped, {
          catalogue, payer, plans: payer?.plans ?? [], existing,
          defaultCurrency: billingCurrency, resolution: resolutions[row.__line],
        })
        : stageServiceRow(mapped, { catalogue, defaultCurrency: billingCurrency });
    });
    return isTariff ? flagDuplicates(rows) : rows;
  }, [parsed, mapping, fields, isTariff, catalogue, payer, existing, billingCurrency, resolutions]);

  const summary = staged ? summariseBatch(staged) : null;

  const onFile = async (chosen) => {
    if (!chosen) return;
    setError(null);
    setResolutions({});
    const result = await parseFile(chosen);
    if (result.error) { setError(result.error); return; }
    if (result.headers.length === 0) { setError('That file has no header row.'); return; }

    setFile(chosen);
    setParsed(result);

    /*
     * A saved profile for this payer and layout is applied automatically; a
     * guess from the headers is used otherwise. Either way the mapping screen
     * shows what was chosen, because a column silently interpreted as a price
     * is the failure this whole flow exists to prevent.
     */
    const saved = mappingProfiles.find(
      (profile) => profile.kind === kind
        && (!isTariff || profile.payerId === payerId)
        && profileMatchesHeaders(profile, result.headers)
    );
    if (saved) {
      setMapping(saved.mapping);
      setAppliedProfile(saved);
    } else {
      setMapping(guessMapping(result.headers, fields));
      setAppliedProfile(null);
    }
  };

  const reset = () => {
    setFile(null); setParsed(null); setMapping({});
    setResolutions({}); setError(null); setAppliedProfile(null);
  };

  const resolve = (line, resolution) =>
    setResolutions((prev) => ({ ...prev, [line]: resolution }));

  const publish = async () => {
    const batchId = `B${Date.now().toString(36).toUpperCase()}`;
    const meta = {
      id: batchId,
      kind,
      filename: file.name,
      payerId: isTariff ? payer.id : null,
      payerName: isTariff ? payer.name : 'Service catalogue',
      importedBy: currentUser.name,
      importedAt: new Date().toISOString(),
      rowCount: summary.total,
      validCount: summary.valid,
      warningCount: summary.warnings,
      errorCount: summary.errors,
      status: 'PUBLISHED',
    };

    if (isTariff) {
      const records = buildTariffRecords(staged, {
        batchId, practiceId: currentUser.practiceId, source: file.name,
      });
      const ok = await publishTariffBatch({ batch: { ...meta, publishedCount: records.length }, records, mapping, counts: summary, filename: file.name });
      if (ok === false) return;
    } else {
      const records = buildServiceRecords(staged, { batchId, currency: billingCurrency });
      const ok = await publishServiceBatch({ batch: { ...meta, publishedCount: records.length }, records, mapping, counts: summary, filename: file.name });
      if (ok === false) return;
    }
    reset();
  };

  const saveProfile = () => {
    const name = `${isTariff ? payer.name : 'Service catalogue'} · ${file.name.replace(/\.[^.]+$/, '')}`;
    saveMappingProfile(makeProfile({
      name, kind, payerId: isTariff ? payer.id : null,
      mapping, headers: parsed.headers, createdBy: currentUser.name,
    }));
  };

  if (!access.can.manageTariffs) {
    return (
      <div className="space-y-6">
        <div className="lh-page-hero">
          <h1 className="lh-page-title">Tariffs and price lists</h1>
        </div>
        <EmptyState
          title="Restricted"
          detail="Publishing a schedule changes what every patient on that scheme is charged, so it is limited to the practice manager."
        />
      </div>
    );
  }

  const missing = parsed ? missingRequired(mapping, fields) : [];

  return (
    <div className="space-y-6">
      <div className="lh-page-hero flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="lh-page-kicker">Billing configuration</p>
          <h1 className="lh-page-title">Tariffs and price lists</h1>
          <p className="lh-page-subtitle">
            Upload a payer schedule or your own price list, as CSV or Excel.
            Nothing changes until you have seen exactly what it would do.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => download(
              isTariff ? 'luminary-tariff-template.csv' : 'luminary-service-template.csv',
              isTariff ? TARIFF_TEMPLATE : SERVICE_TEMPLATE,
              notify,
            )}
            className="lh-secondary-button"
          >
            <Download size={14} />
            Template
          </button>
          <button type="button" onClick={() => fileInput.current?.click()} className="lh-primary-button">
            <Upload size={14} />
            Upload file
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,.tsv,.txt,.xlsx,.xlsm,.xls"
            className="hidden"
            onChange={(event) => { onFile(event.target.files?.[0]); event.target.value = ''; }}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {Object.values(IMPORT_KINDS).map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setKind(option.id)}
            className={`rounded-lg px-3.5 py-2 text-sm font-medium transition ${
              kind === option.id ? 'bg-brand text-white' : 'border border-line bg-white text-body hover:border-brand-edge'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="lh-card-pad border-danger-line bg-danger-soft">
          <p className="text-md font-medium text-danger-deep">{error}</p>
        </div>
      )}

      {parsed && (
        <div className="lh-card-pad">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-heading text-ink">{file.name}</h2>
              <p className="mt-1 text-sm text-body">
                {parsed.rows.length} rows · {parsed.headers.length} columns
                {appliedProfile && <span className="text-brand"> · mapped by “{appliedProfile.name}”</span>}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {missing.length === 0 && (
                <button type="button" onClick={saveProfile} className="lh-secondary-button">
                  Save this mapping
                </button>
              )}
              <button type="button" onClick={reset} className="text-md font-medium text-brand hover:underline">
                Discard
              </button>
            </div>
          </div>

          {isTariff && (
            <label className="mb-4 block max-w-sm">
              <span className="mb-1.5 block text-caption font-semibold text-muted">Medical aid</span>
              <select
                value={payerId}
                onChange={(event) => setPayerId(event.target.value)}
                className="w-full rounded-lg border border-line bg-white/75 px-3 py-2.5 text-xs text-ink outline-none focus:border-brand-bright"
              >
                {payers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          )}

          <p className="mb-3 lh-section-label">Which column means what</p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {fields.map((field) => (
              <label key={field.key} className="block">
                <span className="mb-1.5 flex items-center gap-1.5 text-caption font-semibold text-muted">
                  {field.label}
                  {field.required && <span className="text-danger">*</span>}
                </span>
                <select
                  value={mapping[field.key] ?? ''}
                  onChange={(event) => setMapping((prev) => ({ ...prev, [field.key]: event.target.value }))}
                  className="w-full rounded-lg border border-line bg-white/75 px-3 py-2.5 text-xs text-ink outline-none focus:border-brand-bright"
                >
                  <option value="">Not in this file</option>
                  {parsed.headers.map((header) => <option key={header} value={header}>{header}</option>)}
                </select>
              </label>
            ))}
          </div>

          {missing.length > 0 && (
            <p className="mt-4 text-sm text-danger-deep">
              Map {missing.join(', ')} before this file can be checked.
            </p>
          )}
        </div>
      )}

      {staged && summary && (
        <div className="lh-card-pad">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold tracking-heading text-ink">What this would do</h2>
            <div className="flex items-center gap-2">
              <button type="button" onClick={reset} className="lh-secondary-button">Cancel</button>
              <button
                type="button"
                onClick={publish}
                disabled={summary.total - summary.errors - summary.ignored === 0}
                className="lh-primary-button disabled:cursor-not-allowed disabled:opacity-50"
              >
                Publish {summary.total - summary.errors - summary.ignored} row
                {summary.total - summary.errors - summary.ignored === 1 ? '' : 's'}
              </button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {[
              { label: 'Rows', value: summary.total },
              { label: 'Valid', value: summary.valid },
              { label: 'Warnings', value: summary.warnings },
              { label: 'Errors', value: summary.errors },
              { label: 'New', value: summary.created },
              { label: 'Changed', value: summary.changed },
            ].map((tile) => (
              <div key={tile.label} className="lh-card-soft p-3">
                <p className="text-caption font-medium text-muted">{tile.label}</p>
                <p className="mt-1.5 text-md font-semibold text-ink tabular-nums">{tile.value}</p>
              </div>
            ))}
          </div>

          {summary.errors > 0 && (
            <p className="mt-3 text-sm text-danger-deep">
              {summary.errors} row{summary.errors === 1 ? '' : 's'} cannot be published. Resolve them
              below, or publish the rest and fix these in the file.
            </p>
          )}

          <div className="mt-4 max-h-[30rem] space-y-2 overflow-y-auto">
            {staged.map((row) => {
              const needsDecision = isTariff && row.status === ROW_STATUS.ERROR && !row.resolved.serviceId;
              const chosen = resolutions[row.line];
              return (
                <div
                  key={row.line}
                  className={`rounded-lg border p-3 ${
                    row.ignored ? 'border-line bg-surface opacity-70'
                      : row.status === ROW_STATUS.ERROR ? 'border-danger-line bg-danger-soft'
                        : row.status === ROW_STATUS.WARNING ? 'border-warning-line bg-warning-wash/50'
                          : 'border-line bg-white'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-base font-medium text-ink">
                        {row.resolved.serviceName || '(no service named)'}
                        {row.matchedVia && (
                          <span className="ml-2 text-xs font-normal text-body">matched by {row.matchedVia}</span>
                        )}
                      </p>
                      <p className="mt-1 text-xs text-body">
                        line {row.line}
                        {row.resolved.code ? ` · ${row.resolved.code}` : ''}
                        {row.resolved.effectiveFrom ? ` · from ${row.resolved.effectiveFrom}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-base font-medium text-ink tabular-nums">
                        {row.resolved.rate === null || row.resolved.rate === undefined
                          ? 'Not priced'
                          : `${row.resolved.currency} ${Number(row.resolved.rate).toFixed(2)}`}
                      </span>
                      <StatusPill
                        label={row.ignored ? 'SKIPPED' : row.status}
                        tone={row.ignored ? 'neutral' : row.status === ROW_STATUS.ERROR ? 'alert' : row.status === ROW_STATUS.WARNING ? 'warm' : 'success'}
                      />
                    </div>
                  </div>

                  {row.issues.length > 0 && (
                    <ul className="mt-2 space-y-0.5">
                      {row.issues.map((issue, index) => (
                        <li
                          key={index}
                          className={`text-xs ${issue.level === ROW_STATUS.ERROR ? 'text-danger-deep' : 'text-warning-deep'}`}
                        >
                          {issue.message}
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* The decision a person has to make on a row the matcher
                      would not guess at. Confirming it optionally teaches the
                      catalogue, so next month's file maps itself. */}
                  {(needsDecision || chosen) && (
                    <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-line pt-2.5">
                      <select
                        value={chosen?.serviceId ?? ''}
                        onChange={(event) => resolve(row.line, event.target.value ? { serviceId: event.target.value } : undefined)}
                        className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs text-ink outline-none focus:border-brand-bright"
                      >
                        <option value="">Choose a service…</option>
                        {configuredServices.map((svc) => (
                          <option key={svc.id} value={svc.id}>{svc.displayName}</option>
                        ))}
                      </select>

                      {chosen?.serviceId && (
                        <button
                          type="button"
                          onClick={() => addServiceAlias(chosen.serviceId, row.resolved.serviceName, payer?.id)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs font-medium text-brand transition hover:border-brand-edge"
                        >
                          <Check size={12} />
                          Remember “{row.resolved.serviceName}”
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => resolve(row.line, chosen?.ignore ? undefined : { ignore: true })}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs font-medium text-body transition hover:border-edge"
                      >
                        <SkipForward size={12} />
                        {chosen?.ignore ? 'Include again' : 'Skip this row'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Every published batch stays listed with what it did, and can be rolled
          back — by superseding, never by deleting. */}
      <div className="lh-card-pad">
        <p className="mb-4 lh-section-label">Import history</p>
        {importBatches.length === 0 ? (
          <p className="rounded-lg border border-dashed border-edge bg-surface p-4 text-sm text-muted">
            Nothing has been imported yet.
          </p>
        ) : (
          <div className="space-y-2">
            {importBatches.map((batch) => (
              <div key={batch.id} className="lh-card-soft flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p className="font-medium text-ink">{batch.filename}</p>
                  <p className="mt-1 text-xs text-body">
                    {batch.payerName} · {batch.publishedCount} of {batch.rowCount} rows ·{' '}
                    {new Date(batch.importedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} ·{' '}
                    {batch.importedBy}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusPill label={batch.status} tone={batch.status === 'PUBLISHED' ? 'success' : 'neutral'} />
                  {batch.status === 'PUBLISHED' && batch.kind === IMPORT_KINDS.TARIFF.id && (
                    <button
                      type="button"
                      onClick={() => rollbackTariffBatch(batch)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 text-xs font-medium text-body transition hover:border-danger-line hover:text-danger"
                    >
                      <RotateCcw size={12} />
                      Roll back
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {mappingProfiles.length > 0 && (
        <div className="lh-card-pad">
          <p className="mb-4 lh-section-label">Saved column mappings</p>
          <div className="space-y-2">
            {mappingProfiles.map((profile) => (
              <div key={profile.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface p-3">
                <div className="min-w-0">
                  <p className="text-base font-medium text-ink">{profile.name}</p>
                  <p className="mt-1 text-xs text-body">
                    {Object.entries(profile.mapping)
                      .filter(([, header]) => header)
                      .map(([field, header]) => `${header} → ${field}`)
                      .join(' · ')}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted">by {profile.createdBy}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

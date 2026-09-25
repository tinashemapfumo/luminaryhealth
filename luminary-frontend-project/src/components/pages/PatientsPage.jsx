import React from 'react';
import { ArrowUpDown, FolderOpen, GitMerge, Plus, Search, AlertTriangle } from 'lucide-react';
import PatientFile from '../PatientFile';
import EncounterNote from '../EncounterNote';
import { patientStatusTone } from '../../data/registry';
import { carePlansByPatient, labResultsByPatient, prescriptionsByPatient } from '../../data/clinical';
import { Button, EmptyState, Field, Modal, SegmentedControl, Select, Textarea } from '../ui';
import { StatusPill } from '../shared/StatusPill';
import { useWorkspace } from '../../lib/workspace';

export default function PatientsPage() {
  const { access, practice, practicePatients, myPatientList, practiceSchedule, practiceInvoices, practiceClaims, practiceEpisodes, practiceOrders, showWholePractice, setShowWholePractice, patientSearch, setPatientSearch, sortKey, setSortKey, selectedPatient, setSelectedPatient, requestPatientFile, fileOpen, setFileOpen, patientRecords, patientFileTab, setPatientFileTab, savePatientRecord, uploadPatientDocument, downloadPatientDocument, exportPatientFile, notesForPatient, openNote, openNoteForVisit, setOpenNoteId, saveNote, signNote, addAddendum, completeTriage, applyDictationEncounter, roleInfo, patientTab, setPatientTab, currency, openDialog, recordCompleteness, formatMoney, outstandingOn, updateEpisode, mergePatients, configuredProviders, coverPlanOptions, defaultCoverPlan } = useWorkspace();
  const defaultProvider = configuredProviders[0] || 'Unassigned';
  const [mergeOpen, setMergeOpen] = React.useState(false);
  const [mergeSourceId, setMergeSourceId] = React.useState('');
  const [mergeReason, setMergeReason] = React.useState('');
  const [mergeError, setMergeError] = React.useState('');
  const canMergePatients = Boolean(access.can.manageCover || access.can.reviewAudit);
  const selectedCanonicalId = selectedPatient?.patientId || selectedPatient?.id;
  const mergeCandidates = practicePatients.filter((patient) =>
    (patient.patientId || patient.id) !== selectedCanonicalId
  );

  const submitMerge = async () => {
    setMergeError('');
    if (!mergeSourceId) {
      setMergeError('Choose the duplicate source patient');
      return;
    }
    if (mergeReason.trim().length < 5) {
      setMergeError('Enter a short merge reason');
      return;
    }
    try {
      await mergePatients({
        sourcePatientId: mergeSourceId,
        survivorPatientId: selectedCanonicalId,
        reason: mergeReason.trim(),
      });
      setMergeOpen(false);
      setMergeSourceId('');
      setMergeReason('');
    } catch (error) {
      setMergeError(error.details?.canonicalPatientId
        ? `${error.message}: ${error.details.canonicalPatientId}`
        : error.message);
    }
  };

    // A note opened from inside a chart stays inside the chart — closing it
    // returns to the patient file, not out to the Clinical queue.
    if (fileOpen && openNote) {
      return (
        <EncounterNote
          note={openNote}
          patientRecord={patientRecords[openNote.patientId]}
          onBack={() => setOpenNoteId(null)}
          onSave={saveNote}
          onSign={signNote}
          onAddendum={addAddendum}
          onCompleteTriage={completeTriage}
          onDictationApproved={applyDictationEncounter}
          can={access.can}
          currentUser={roleInfo.person}
        />
      );
    }

    // The full chart takes over the workspace — a clinical record needs room,
    // not a narrow sidebar squeezed beside the registry table.
    if (fileOpen && patientRecords[selectedPatient.id]) {
      return (
        <PatientFile
          record={patientRecords[selectedPatient.id]}
          registry={selectedPatient}
          onBack={() => { setFileOpen(false); setPatientFileTab('Summary'); }}
          onSave={savePatientRecord}
          onUploadDocument={(payload) => uploadPatientDocument({ patient: selectedPatient, ...payload })}
          onDownloadDocument={downloadPatientDocument}
          onExportPatient={(options) => exportPatientFile(selectedPatient, options)}
          canEdit={access.can.editDemographics || access.can.editClinicalHistory}
          canPrescribe={access.can.prescribe}
          can={access.can}
          practice={practice}
          coverPlanOptions={coverPlanOptions}
          notes={access.can.viewClinicalNotes ? notesForPatient(selectedPatient.id) : []}
          onOpenNote={(id) => setOpenNoteId(id)}
          onStartNote={() => openNoteForVisit(selectedPatient, practiceSchedule.find((v) => v.patient === selectedPatient.name))}
          onNewPrescription={() => openDialog('prescription', { patient: selectedPatient })}
          onDictatePrescription={() => openDialog('prescriptionDictation', { patient: selectedPatient })}
          episodes={practiceEpisodes}
          onStartEpisode={(initial) => openDialog('episode', initial)}
          onEditEpisode={(episode) => openDialog('episode', episode)}
          onUpdateEpisode={updateEpisode}
          orders={practiceOrders}
          prescriptions={patientRecords[selectedPatient.id]?.prescriptions ?? prescriptionsByPatient[selectedPatient.name] ?? []}
          labs={labResultsByPatient[selectedPatient.name] || []}
          carePlans={carePlansByPatient[selectedPatient.name] || []}
          invoices={practiceInvoices}
          claims={practiceClaims}
          appointments={practiceSchedule}
          currency={currency}
          formatMoney={formatMoney}
          outstandingOn={outstandingOn}
          StatusPill={StatusPill}
          statusTone={patientStatusTone}
          tab={patientFileTab}
          onTabChange={setPatientFileTab}
        />
      );
    }

    const patientTabs = ['Overview', 'Clinical', 'Appointments', 'Billing'];

    const patientDetails = {
      'Ruvimbo Moyo': {
        age: '39',
        gender: 'Female',
        phone: '+263 78 123 4567',
        email: 'ruvimbo.moyo@clinic.io',
        insurance: 'NH263 Plan A',
        risk: 'Low risk',
        lastVisit: 'Jun 19',
        nextVisit: 'Today, 09:45',
        conditions: ['Hypertension', 'Seasonal allergies'],
        medications: ['Amlodipine 5mg', 'Cetirizine 10mg'],
        allergies: ['Penicillin'],
        notes: 'Patient is stable and responds well to current plan. Follow up discussion focused on blood pressure monitoring and lifestyle habits.',
        timeline: [
          { label: 'Blood pressure review', date: 'Jun 19', detail: 'Vitals within target range', tone: 'success' },
          { label: 'Medication review', date: 'Jun 07', detail: 'Amlodipine dosage maintained', tone: 'neutral' },
          { label: 'New patient intake', date: 'May 13', detail: 'Comprehensive intake completed', tone: 'warm' },
        ],
      },
      'Tariro Gumbo': {
        age: '42',
        gender: 'Female',
        phone: '+263 71 894 2201',
        email: 'tariro.gumbo@clinic.io',
        insurance: 'NH263 Plan B',
        risk: 'Moderate risk',
        lastVisit: 'Jun 16',
        nextVisit: 'Today, 12:15',
        conditions: ['Cardiology review', 'Migraines'],
        medications: ['Topiramate 25mg', 'Aspirin 81mg'],
        allergies: ['None noted'],
        notes: 'Reviewing cardiac symptoms and medication adherence. Recent follow up indicates improved control.',
        timeline: [
          { label: 'Cardiology consult', date: 'Jun 16', detail: 'Reviewed reports and symptoms', tone: 'warm' },
          { label: 'Medication check', date: 'Jun 09', detail: 'Refilled all medications', tone: 'success' },
          { label: 'Baseline review', date: 'May 30', detail: 'Initial care pathway created', tone: 'neutral' },
        ],
      },
      'Tawanda Mutsvangwa': {
        age: '31',
        gender: 'Male',
        phone: '+263 71 355 1980',
        email: 'tawanda.mutsvangwa@clinic.io',
        insurance: 'NH263 Plan C',
        risk: 'Low risk',
        lastVisit: 'Jun 14',
        nextVisit: 'Today, 10:30',
        conditions: ['Recurrent migraine'],
        medications: ['Sumatriptan', 'Vitamin D'],
        allergies: ['Latex'],
        notes: 'Follows up on symptom reduction after treatment change. Need confirm medication routine before next visit.',
        timeline: [
          { label: 'Follow up', date: 'Jun 14', detail: 'Symptoms improving', tone: 'success' },
          { label: 'Treatment review', date: 'Jun 04', detail: 'Changed migraine protocol', tone: 'warm' },
          { label: 'Initial consult', date: 'May 22', detail: 'Comprehensive clinical intake', tone: 'neutral' },
        ],
      },
      'Kudzai Machingura': {
        age: '46',
        gender: 'Male',
        phone: '+263 78 750 4532',
        email: 'kudzai.machingura@clinic.io',
        insurance: 'NH263 Plan A',
        risk: 'Moderate risk',
        lastVisit: 'Jun 09',
        nextVisit: 'Today, 15:00',
        conditions: ['Weight management', 'Lab review'],
        medications: ['Metformin 500mg', 'Omega-3'],
        allergies: ['None noted'],
        notes: 'Lab review indicates improvement. Continue lifestyle plan and monitor metabolic markers at next check in.',
        timeline: [
          { label: 'Lab review', date: 'Aug 09', detail: 'Metabolic markers trending positively', tone: 'success' },
          { label: 'Care plan', date: 'Jun 01', detail: 'Lifestyle intervention started', tone: 'neutral' },
          { label: 'Intake', date: 'May 11', detail: 'Weight and bloodwork baseline captured', tone: 'warm' },
        ],
      },
      'Chiedza Mutasa': {
        age: '58',
        gender: 'Female',
        phone: '+263 77 412 8830',
        email: 'chiedza.mutasa@clinic.io',
        insurance: 'NH263 Plan B',
        risk: 'High risk',
        lastVisit: 'Aug 20',
        nextVisit: 'Today, 11:15',
        conditions: ['Atrial fibrillation', 'Anticoagulation'],
        medications: ['Apixaban 5mg', 'Bisoprolol 2.5mg'],
        allergies: ['Sulfa drugs'],
        notes: 'INR above range at last check and rate remains elevated. Membership is currently suspended for contribution arrears, so the last claim was rejected and moved to patient responsibility. Confirm coverage before today’s visit.',
        timeline: [
          { label: 'Claim rejected', date: 'Aug 20', detail: 'R204 membership suspended, moved to self pay', tone: 'alert' },
          { label: 'Cardiology review', date: 'Aug 20', detail: 'INR 3.4, rate 104 bpm', tone: 'alert' },
          { label: 'Anticoagulation start', date: 'Jul 02', detail: 'Apixaban commenced', tone: 'warm' },
        ],
      },
      'Farai Nyamande': {
        age: '35',
        gender: 'Male',
        phone: '+263 71 620 7745',
        email: 'farai.nyamande@clinic.io',
        insurance: 'NH263 Plan A',
        risk: 'Low risk',
        lastVisit: 'Aug 18',
        nextVisit: 'Today, 14:15',
        conditions: ['Postoperative recovery'],
        medications: ['Amoxicillin 500mg', 'Paracetamol 500mg'],
        allergies: ['None noted'],
        notes: 'Day 14 post appendicectomy. Inflammatory markers mildly raised but trending down; wound review scheduled today to confirm healing before discharging from surgical follow up.',
        timeline: [
          { label: 'Wound review', date: 'Aug 18', detail: 'WCC 11.8, CRP 18, improving', tone: 'warm' },
          { label: 'Surgery', date: 'Aug 11', detail: 'Laparoscopic appendicectomy', tone: 'neutral' },
        ],
      },
      'Nyasha Chari': {
        age: '27',
        gender: 'Female',
        phone: '+263 78 905 3312',
        email: 'nyasha.chari@clinic.io',
        insurance: 'NH263 Plan A',
        risk: 'Not assessed',
        lastVisit: 'Not recorded',
        nextVisit: 'Today, 09:00',
        conditions: ['Awaiting intake'],
        medications: ['None recorded'],
        allergies: ['Not yet documented'],
        notes: 'New patient. Registration complete but clinical intake has not been performed. History, allergies, and baseline observations are all outstanding.',
        timeline: [
          { label: 'Registered', date: 'Aug 22', detail: 'Demographics and cover captured', tone: 'neutral' },
        ],
      },
      'Tendai Moyo': {
        age: '51',
        gender: 'Male',
        phone: '+263 77 338 9004',
        email: 'tendai.moyo@clinic.io',
        insurance: 'NH263 Plan C',
        risk: 'Moderate risk',
        lastVisit: 'Aug 21',
        nextVisit: 'Today, 16:00',
        conditions: ['Hypertension'],
        medications: ['Losartan 50mg'],
        allergies: ['None noted'],
        notes: 'Newly diagnosed hypertension. Started on Losartan four days ago; today’s review is to check tolerance and reinforce home monitoring.',
        timeline: [
          { label: 'Diagnosis', date: 'Aug 21', detail: 'BP 142/91, Losartan started', tone: 'warm' },
        ],
      },
    };

    const patientData = patientDetails[selectedPatient.name] || {
      age: patientRecords[selectedPatient.id]?.age || 'Not recorded',
      gender: patientRecords[selectedPatient.id]?.sex || 'Not recorded',
      phone: patientRecords[selectedPatient.id]?.phone || 'Not recorded',
      email: patientRecords[selectedPatient.id]?.email || 'Not recorded',
      insurance: selectedPatient.coverPlan || selectedPatient.insurance || 'Not recorded',
      risk: 'Not assessed',
      lastVisit: selectedPatient.lastVisit || 'Not recorded',
      nextVisit: selectedPatient.next || 'Not scheduled',
      conditions: ['Not recorded'],
      medications: ['Not recorded'],
      allergies: ['Not recorded'],
      notes: 'No clinical summary has been recorded for this patient yet.',
      timeline: [],
    };

    // Registry search spans the practice, never other tenants. A clinician's
    // own list is the default; searching wider is allowed but opening a chart
    // outside it triggers break-glass.
    const registrySource = showWholePractice ? practicePatients : myPatientList;

    const filteredPatients = registrySource
      .filter((patient) => {
        const query = patientSearch.trim().toLowerCase();
        if (!query) return true;
        return patient.name.toLowerCase().includes(query) || patient.id.toLowerCase().includes(query) || patient.status.toLowerCase().includes(query);
      })
      .sort((a, b) => {
        const { column, direction } = sortKey;
        const factor = direction === 'asc' ? 1 : -1;
        const left = a[column];
        const right = b[column];
        if (typeof left === 'number' && typeof right === 'number') return (left - right) * factor;
        return String(left).localeCompare(String(right)) * factor;
      });

    const toggleSort = (column) =>
      setSortKey((prev) => ({
        column,
        direction: prev.column === column && prev.direction === 'asc' ? 'desc' : 'asc',
      }));

    const columns = [
      { key: 'name', label: 'Patient' },
      { key: 'id', label: 'ID' },
      { key: 'lastVisit', label: 'Last visit', wide: true },
      { key: 'next', label: 'Next appointment' },
      { key: 'balance', label: 'Balance' },
      { key: 'status', label: 'Status' },
    ];

    return (
      <div className="space-y-6">
        <div className="lh-page-hero flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="lh-page-title">Patients</h1>
            <p className="lh-page-subtitle">Search and manage patient records.</p>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex h-control w-full items-center gap-2 rounded-md border border-line bg-white/80 px-3 text-muted shadow-hairline transition duration-fast focus-within:border-brand-vivid/60 focus-within:bg-white focus-within:shadow-focus md:w-64">
              <Search size={16} strokeWidth={1.8} className="shrink-0" />
              <input
                type="text"
                value={patientSearch}
                onChange={(event) => setPatientSearch(event.target.value)}
                placeholder="Search patients"
                aria-label="Search patients"
                className="w-full bg-transparent text-copy text-ink placeholder:text-muted outline-none"
              />
            </label>
            {access.can.addPatient && (
              <button type="button" onClick={() => openDialog('patient', { coverPlan: defaultCoverPlan, preferredContact: 'SMS', emergencyRelationship: 'Spouse', provider: defaultProvider, consentComms: true })} className="lh-btn-primary shrink-0">
                <Plus size={16} strokeWidth={2} />
                New patient
              </button>
            )}
          </div>
        </div>

        {/* The registry scrolls; the preview beside it stays put, so the
            selected patient never scrolls away from the list. */}
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0">
            {/* A clinician's list is the default view. Widening to the whole
                practice is allowed and explicit. Opening a chart from the
                wider set is what triggers break-glass, not seeing the name. */}
            {access.ownPatientsOnly && (
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <div className="lh-segmented">
                {[
                  { key: false, label: 'My patients', count: myPatientList.length },
                  { key: true, label: `All of ${practice.short}`, count: practicePatients.length },
                ].map((option) => (
                  <button
                    key={String(option.key)}
                    type="button"
                    onClick={() => setShowWholePractice(option.key)}
                    aria-pressed={showWholePractice === option.key}
                    className={`lh-segmented-item ${showWholePractice === option.key ? 'bg-white text-ink shadow-control' : ''}`}
                  >
                    {option.label} <span className="tnum text-muted">{option.count}</span>
                  </button>
                ))}
                </div>
                {showWholePractice && (
                  <span className="flex items-center gap-1.5 text-caption font-medium text-warning-deep">
                    <AlertTriangle size={14} strokeWidth={1.8} />
                    Opening a chart outside your list is logged
                  </span>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-2.5">
              <p className="text-small text-muted">
                {filteredPatients.length} of {registrySource.length} patients
                {patientSearch && <> matching “{patientSearch}”</>}
              </p>
              <p className="text-caption text-muted">Sorted by {columns.find((c) => c.key === sortKey.column)?.label || 'Recently added'} · {sortKey.direction === 'asc' ? 'ascending' : 'descending'}</p>
            </div>

            <div className="lh-table-shell">
              <table className="min-w-full text-left text-small">
                <caption className="sr-only">Patient registry. Activate a row to open that patient’s record.</caption>
                <thead className="lh-table-head">
                  <tr>
                    {columns.map((column) => (
                      <th
                        key={column.key}
                        scope="col"
                        aria-sort={sortKey.column === column.key ? (sortKey.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                        className={`px-3 py-2.5 font-medium first:pl-4 ${column.wide ? 'hidden 2xl:table-cell' : ''}`}
                      >
                        <button
                          type="button"
                          onClick={() => toggleSort(column.key)}
                          className="inline-flex items-center gap-1 whitespace-nowrap text-caption font-medium text-muted transition hover:text-brand-deep"
                        >
                          {column.label}
                          <ArrowUpDown size={12} strokeWidth={1.8} className={sortKey.column === column.key ? 'text-brand' : 'text-muted/60'} />
                        </button>
                      </th>
                    ))}
                    <th scope="col" className="px-3 py-2.5 text-caption font-medium text-muted">File</th>
                    <th scope="col" className="py-2.5 pl-1 pr-3"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPatients.map((patient) => (
                    <tr
                      key={patient.id}
                      tabIndex={0}
                      aria-selected={selectedPatient.id === patient.id}
                      onClick={() => setSelectedPatient(patient)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedPatient(patient);
                        }
                      }}
                      className={`cursor-pointer border-t border-line/60 outline-none transition-colors duration-instant focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand ${selectedPatient.id === patient.id ? 'bg-brand-soft/70 shadow-[inset_3px_0_0_rgba(7,94,184,0.7)]' : 'hover:bg-brand-soft/40'}`}
                    >
                      <td className="py-2.5 pl-4 pr-3">
                        <div className="flex min-w-[168px] items-center gap-2.5">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-caption font-semibold text-brand-deep">
                            {patient.name.split(' ').map((part) => part[0]).join('')}
                          </div>
                          <div className="min-w-0">
                            <p className="truncate font-medium text-ink">{patient.name}</p>
                            <p className="truncate text-caption text-muted">{patient.provider}</p>
                          </div>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-body tnum">{patient.id}</td>
                      <td className="hidden whitespace-nowrap px-3 py-2.5 text-body 2xl:table-cell">{patient.lastVisit}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-body">{patient.next}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right text-ink tnum">{currency(patient.balance)}</td>
                      <td className="px-3 py-2.5"><StatusPill label={patient.status} tone={patientStatusTone[patient.status]} /></td>
                      <td className="px-3 py-2.5">
                        {(() => {
                          const { percent } = recordCompleteness(patientRecords[patient.id]);
                          return (
                            <span className="flex items-center gap-2">
                              <span className="h-1.5 w-10 overflow-hidden rounded-full bg-ink/[0.06]">
                                <span className={`block h-full rounded-full ${percent === 100 ? 'bg-success-bright' : 'bg-warning-bright'}`} style={{ width: `${percent}%` }} />
                              </span>
                              <span className={`text-caption font-medium tnum ${percent === 100 ? 'text-success' : 'text-warning'}`}>{percent}%</span>
                            </span>
                          );
                        })()}
                      </td>
                      <td className="py-2.5 pl-1 pr-3 text-right">
                        <button
                          type="button"
                          onClick={(event) => { event.stopPropagation(); requestPatientFile(patient); }}
                          aria-label={`Open file for ${patient.name}`}
                          title="Open file"
                          className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-brand-deep transition duration-fast hover:bg-brand/[0.08]"
                        >
                          <FolderOpen size={17} strokeWidth={1.8} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {filteredPatients.length === 0 && (
                <div className="border-t border-line/60 p-3">
                  <EmptyState
                    icon={Search}
                    title={`No patients match “${patientSearch}”`}
                    detail="Check the spelling, or search by patient ID or status instead."
                    action={<Button variant="secondary" type="button" onClick={() => setPatientSearch('')}>Clear search</Button>}
                  />
                </div>
              )}
            </div>
          </div>

          <aside className="lh-card-pad xl:lh-sticky-panel">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="lh-section-label">Selected patient</p>
                <h2 className="mt-1 text-heading font-semibold tracking-heading text-ink">{selectedPatient.name}</h2>
              </div>
              <StatusPill label={selectedPatient.status} tone={patientStatusTone[selectedPatient.status]} />
            </div>

            <p className="mt-1 text-small text-muted tnum">{selectedPatient.id} · {patientData.age} years</p>

            {canMergePatients && (
              <div className="mt-4">
                <button
                  type="button"
                  onClick={() => {
                    setMergeSourceId('');
                    setMergeReason('');
                    setMergeError('');
                    setMergeOpen(true);
                  }}
                  className="lh-btn-secondary h-control-sm px-3 text-caption"
                >
                  <GitMerge size={15} strokeWidth={1.8} />
                  Merge duplicate
                </button>
              </div>
            )}

            <SegmentedControl
              label="Preview section"
              size="sm"
              options={patientTabs}
              value={patientTab}
              onChange={setPatientTab}
              className="mt-5 flex w-full [&>button]:flex-1"
            />

            <div className="mt-5 space-y-4">
              {patientTab === 'Overview' && (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-lg bg-surface/70 p-3.5">
                      <p className="lh-section-label">Contact</p>
                      <p className="mt-2 text-md font-medium text-ink">{patientData.phone}</p>
                    </div>
                    <div className="rounded-lg bg-surface/70 p-3.5">
                      <p className="lh-section-label">Insurance</p>
                      <p className="mt-2 text-md font-medium text-ink">{patientData.insurance}</p>
                    </div>
                  </div>

                  <div className="rounded-lg bg-surface/70 p-3.5">
                    <p className="lh-section-label">Clinical note</p>
                    <p className="mt-2 text-base leading-6 text-ink-soft">{patientData.notes}</p>
                  </div>

                  <div className="space-y-3">
                    {patientData.timeline.map((item) => (
                      <div key={item.label} className="flex gap-3 px-0.5">
                        <div className={`mt-1 h-2.5 w-2.5 rounded-full ${item.tone === 'success' ? 'bg-success-bright' : item.tone === 'warm' ? 'bg-warning-bright' : 'bg-edge-strong'}`} />
                        <div>
                          <p className="text-base font-medium text-ink">{item.label}</p>
                          <p className="mt-1 text-sm text-body">{item.date} · {item.detail}</p>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div>
                    <p className="lh-section-label mb-3">Active care plans</p>
                    <div className="space-y-2">
                      {(carePlansByPatient[selectedPatient.name] || []).map((plan) => (
                        <div key={plan.id} className="rounded-lg bg-surface/70 p-3.5">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <p className="text-base font-medium text-ink">{plan.name}</p>
                              <p className="mt-1 text-xs text-body">Since {plan.startDate} · Next review {plan.nextReview}</p>
                            </div>
                            <StatusPill label={plan.status} tone={plan.tone} />
                          </div>
                          <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-ink/[0.06]">
                            <div className={`h-full rounded-full ${plan.tone === 'success' ? 'w-[85%] bg-success-bright' : 'w-[72%] bg-warning-bright'}`} />
                          </div>
                          <p className="mt-2 text-2xs text-muted">{plan.progress} complete</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {patientTab === 'Clinical' && (
                <div className="space-y-3">
                  <div className="rounded-lg bg-surface/70 p-3.5">
                    <p className="lh-section-label">Conditions</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {patientData.conditions.map((item) => (
                        <span key={item} className="rounded-full bg-white px-2.5 py-1 text-small text-body shadow-hairline">{item}</span>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-lg bg-surface/70 p-3.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="lh-section-label">Prescriptions</p>
                      {access.can.prescribe ? (
                        <button type="button" className="inline-flex h-7 items-center gap-1 rounded-sm bg-brand px-2.5 text-caption font-semibold text-white transition duration-fast hover:bg-brand-deep">
                          <Plus size={13} strokeWidth={2} />
                          Prescribe
                        </button>
                      ) : (
                        <span className="text-caption font-medium text-faint">Read only</span>
                      )}
                    </div>
                    <div className="mt-3 space-y-2">
                      {(prescriptionsByPatient[selectedPatient.name] || []).map((rx) => (
                        <div key={rx.id} className="rounded-md bg-white p-2.5 shadow-hairline">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <p className="text-sm font-medium text-ink">{rx.drug} {rx.strength}</p>
                              <p className="mt-0.5 text-xs text-body">{rx.frequency} · Refills: {rx.refills}</p>
                            </div>
                            <StatusPill label={rx.status} tone={rx.tone} />
                          </div>
                          <p className="mt-1.5 text-2xs text-muted">{rx.pharmacy}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-lg bg-surface/70 p-3.5">
                    <p className="lh-section-label">Lab results</p>
                    <div className="mt-3 space-y-2">
                      {(labResultsByPatient[selectedPatient.name] || []).map((lab) => (
                        <div key={lab.test} className="rounded-md bg-white p-2.5 shadow-hairline">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <p className="text-sm font-medium text-ink">{lab.test}</p>
                              <p className="mt-0.5 text-xs text-body">{lab.value} {lab.unit}</p>
                            </div>
                            <StatusPill label={lab.status} tone={lab.tone} />
                          </div>
                          <p className="mt-1.5 text-2xs text-muted">Normal: {lab.normal} · {lab.date}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-lg bg-surface/70 p-3.5">
                    <p className="lh-section-label">Medications</p>
                    <ul className="mt-2 space-y-2 text-base text-ink-soft">
                      {patientData.medications.map((item) => <li key={item}>• {item}</li>)}
                    </ul>
                  </div>

                  <div className="rounded-lg bg-surface/70 p-3.5">
                    <p className="lh-section-label">Allergies</p>
                    <p className="mt-2 text-base text-ink-soft">{patientData.allergies.join(', ')}</p>
                  </div>
                </div>
              )}

              {patientTab === 'Appointments' && (
                <div className="space-y-3">
                  <div className="rounded-lg bg-surface/70 p-3.5">
                    <p className="lh-section-label">Upcoming</p>
                    <p className="mt-2 text-md font-medium text-ink">{patientData.nextVisit}</p>
                  </div>
                  {[
                    { label: 'Annual review', date: 'Not scheduled', provider: selectedPatient.provider || 'Unassigned' },
                    { label: 'Medication review', date: 'Not scheduled', provider: selectedPatient.provider || 'Unassigned' },
                  ].map((appointment) => (
                    <div key={appointment.label} className="rounded-lg border border-line/70 p-3.5">
                      <p className="text-base font-medium text-ink">{appointment.label}</p>
                      <p className="mt-1 text-sm text-body">{appointment.date} · {appointment.provider}</p>
                    </div>
                  ))}
                </div>
              )}

              {patientTab === 'Billing' && (
                <div className="space-y-3">
                  <div className="rounded-lg bg-surface/70 p-3.5">
                    <p className="lh-section-label">Outstanding balance</p>
                    <p className="mt-2 text-lg font-semibold tracking-heading text-ink">{currency(selectedPatient.balance)}</p>
                  </div>
                  <div className="rounded-lg border border-line/70 p-3.5">
                    <p className="lh-section-label">Coverage</p>
                    <p className="mt-2 text-base text-ink-soft">{patientData.insurance} · Active</p>
                  </div>
                  <div className="rounded-lg border border-line/70 p-3.5">
                    <p className="lh-section-label">Last invoice</p>
                    <p className="mt-2 text-base text-ink-soft">INV-2024-09 · USD 60.00 · Paid</p>
                  </div>
                </div>
              )}
            </div>
          </aside>
        </div>

        <Modal
          open={mergeOpen}
          onClose={() => setMergeOpen(false)}
          title="Merge Duplicate Patient"
          subtitle={`${selectedPatient.name} remains the survivor record`}
          footer={(
            <>
              <Button variant="secondary" type="button" onClick={() => setMergeOpen(false)}>Cancel</Button>
              <Button type="button" onClick={submitMerge} disabled={!mergeSourceId || mergeReason.trim().length < 5}>
                <GitMerge size={14} />
                Merge
              </Button>
            </>
          )}
        >
          <div className="space-y-4">
            <div className="rounded-lg bg-surface/70 p-3.5">
              <p className="lh-section-label">Survivor</p>
              <p className="mt-2 text-sm font-semibold text-ink">{selectedPatient.name}</p>
              <p className="mt-0.5 text-xs text-muted">{selectedPatient.id}</p>
            </div>
            <Field label="Duplicate source" required error={!mergeSourceId && mergeError ? mergeError : ''}>
              <Select
                value={mergeSourceId}
                onChange={(event) => setMergeSourceId(event.target.value)}
                options={['', ...mergeCandidates.map((patient) => patient.patientId || patient.id)]}
                render={(value) => {
                  if (!value) return 'Choose duplicate patient';
                  const candidate = mergeCandidates.find((patient) => (patient.patientId || patient.id) === value);
                  return candidate ? `${candidate.name} - ${candidate.id}` : value;
                }}
              />
            </Field>
            <Field label="Reason" required error={mergeSourceId && mergeError ? mergeError : ''}>
              <Textarea
                value={mergeReason}
                onChange={(event) => setMergeReason(event.target.value)}
                placeholder="Duplicate registration after identity review"
              />
            </Field>
          </div>
        </Modal>
      </div>
    );
}
